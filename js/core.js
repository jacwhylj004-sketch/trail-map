"use strict";
/* Shared helpers: settings, storage, units, distances and British National Grid references. */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const NATIVE = window.TrailNative || null;

const loadJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

const SETTINGS = Object.assign({ units: "km", theme: "auto", awake: false, base: "map", routes: true, paths: true, shading: "medium", contour: "normal", relief3d: "off" }, loadJSON("tm-settings", {}));
/* Carry over the on/off terrain switches from the first version. */
if (SETTINGS.shade === false) SETTINGS.shading = "off";
if (SETTINGS.contours === false) SETTINGS.contour = "off";
if (SETTINGS.terrain === true) SETTINGS.relief3d = "normal";
delete SETTINGS.shade; delete SETTINGS.contours; delete SETTINGS.terrain;
const saveSettings = () => saveJSON("tm-settings", SETTINGS);

/* ---- IndexedDB: offline tiles, walking routes and downloaded areas ---- */
const DB = (() => {
  let ready;
  const open = () => ready || (ready = new Promise((res, rej) => {
    const r = indexedDB.open("trailmap", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("tiles"); d.createObjectStore("cells"); d.createObjectStore("regions", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { ready = null; rej(r.error); };
  }));
  const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode); const q = fn(t.objectStore(store));
    t.oncomplete = () => res(q && q.result);
    t.onerror = t.onabort = () => rej(t.error || (q && q.error) || new Error("Storage error"));
  }));
  return {
    get: (s, k) => run(s, "readonly", o => o.get(k)),
    put: (s, v, k) => run(s, "readwrite", o => o.put(v, k)),
    del: (s, k) => run(s, "readwrite", o => o.delete(k)),
    delMany: (s, keys) => run(s, "readwrite", o => { keys.forEach(k => o.delete(k)); }),
    all: s => run(s, "readonly", o => o.getAll()),
    keys: s => run(s, "readonly", o => o.getAllKeys()),
    clear: s => run(s, "readwrite", o => o.clear())
  };
})();

async function fetchTimeout(url, opts = {}, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  const outer = opts.signal; const stop = () => c.abort();
  if (outer) { if (outer.aborted) c.abort(); else outer.addEventListener("abort", stop); }
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: c.signal }));
    const body = await res.arrayBuffer(); // read inside the time limit
    return { ok: res.ok, status: res.status, buf: body, json: () => JSON.parse(new TextDecoder().decode(body)) };
  } finally { clearTimeout(t); if (outer) outer.removeEventListener("abort", stop); }
}

/* ---- Units ---- */
const imperial = () => SETTINGS.units === "mi";
function fmtDist(m) {
  if (m == null || !isFinite(m)) return "–";
  if (imperial()) { const mi = m / 1609.344; return mi < 0.2 ? Math.round(m * 1.09361) + " yd" : mi.toFixed(mi < 10 ? 2 : 1) + " mi"; }
  return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(m < 10000 ? 2 : 1) + " km";
}
const fmtHeight = m => m == null || !isFinite(m) ? "–" : imperial() ? Math.round(m * 3.28084) + " ft" : Math.round(m) + " m";
const fmtSpeed = ms => ms == null || !isFinite(ms) || ms < 0 ? "–" : imperial() ? (ms * 2.23694).toFixed(1) + " mph" : (ms * 3.6).toFixed(1) + " km/h";
function fmtTime(s) { const m = Math.round(s / 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min"; }
const fmtBytes = b => b < 1048576 ? Math.max(0, Math.round(b / 1024)) + " KB" : b < 1073741824 ? Math.round(b / 1048576) + " MB" : (b / 1073741824).toFixed(1) + " GB";

/* ---- Geometry. Points are [lon, lat]. ---- */
const RAD = Math.PI / 180;
function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const lineLength = pts => pts.reduce((s, p, i) => i ? s + haversine(pts[i - 1], p) : 0, 0);
function boundsOf(pts) {
  const b = [180, 90, -180, -90];
  pts.forEach(p => { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); });
  return b;
}

/* ---- British National Grid (OS grid references) ---- */
const OSGB = (() => {
  const WGS = { a: 6378137, b: 6356752.314245 }, AIRY = { a: 6377563.396, b: 6356256.909 };
  const F0 = 0.9996012717, LAT0 = 49 * RAD, LON0 = -2 * RAD, E0 = 400000, N0 = -100000;
  const HELM = [-446.448, 125.157, -542.060, 20.4894e-6, -0.1502, -0.2470, -0.8421];
  function shift(lat, lon, from, to, sign) { // lat/lon in radians
    let e2 = 1 - (from.b * from.b) / (from.a * from.a);
    const nu = from.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const x = nu * Math.cos(lat) * Math.cos(lon), y = nu * Math.cos(lat) * Math.sin(lon), z = nu * (1 - e2) * Math.sin(lat);
    const [tx, ty, tz, s, rx, ry, rz] = HELM.map((v, i) => sign * (i > 3 ? v / 3600 * RAD : v));
    const x2 = tx + x * (1 + s) - y * rz + z * ry, y2 = ty + x * rz + y * (1 + s) - z * rx, z2 = tz - x * ry + y * rx + z * (1 + s);
    e2 = 1 - (to.b * to.b) / (to.a * to.a);
    const p = Math.hypot(x2, y2); let phi = Math.atan2(z2, p * (1 - e2));
    for (let i = 0; i < 8; i++) { const v = to.a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2); phi = Math.atan2(z2 + e2 * v * Math.sin(phi), p); }
    return [phi, Math.atan2(y2, x2)];
  }
  const e2 = 1 - (AIRY.b * AIRY.b) / (AIRY.a * AIRY.a), n = (AIRY.a - AIRY.b) / (AIRY.a + AIRY.b);
  const meridian = phi => {
    const d = phi - LAT0, s = phi + LAT0;
    return AIRY.b * F0 * ((1 + n + 1.25 * n * n + 1.25 * n ** 3) * d - (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(d) * Math.cos(s)
      + (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * d) * Math.cos(2 * s) - (35 / 24) * n ** 3 * Math.sin(3 * d) * Math.cos(3 * s));
  };
  const radii = phi => { const k = 1 - e2 * Math.sin(phi) ** 2; const nu = AIRY.a * F0 / Math.sqrt(k), rho = AIRY.a * F0 * (1 - e2) / k ** 1.5; return [nu, rho, nu / rho - 1]; };
  function toEN(latDeg, lonDeg) {
    const [phi, lam] = shift(latDeg * RAD, lonDeg * RAD, WGS, AIRY, 1);
    const [nu, rho, eta] = radii(phi), c = Math.cos(phi), s = Math.sin(phi), t = Math.tan(phi), d = lam - LON0;
    const I = meridian(phi) + N0, II = nu / 2 * s * c, III = nu / 24 * s * c ** 3 * (5 - t * t + 9 * eta), IIIA = nu / 720 * s * c ** 5 * (61 - 58 * t * t + t ** 4);
    const IV = nu * c, V = nu / 6 * c ** 3 * (nu / rho - t * t), VI = nu / 120 * c ** 5 * (5 - 18 * t * t + t ** 4 + 14 * eta - 58 * t * t * eta);
    return [E0 + IV * d + V * d ** 3 + VI * d ** 5, I + II * d * d + III * d ** 4 + IIIA * d ** 6];
  }
  function fromEN(E, N) {
    let phi = LAT0, M = 0;
    for (let i = 0; i < 20 && Math.abs(N - N0 - M) >= 0.00001; i++) { phi += (N - N0 - M) / (AIRY.a * F0); M = meridian(phi); }
    const [nu, rho, eta] = radii(phi), t = Math.tan(phi), sec = 1 / Math.cos(phi), d = E - E0;
    const VII = t / (2 * rho * nu), VIII = t / (24 * rho * nu ** 3) * (5 + 3 * t * t + eta - 9 * t * t * eta), IX = t / (720 * rho * nu ** 5) * (61 + 90 * t * t + 45 * t ** 4);
    const X = sec / nu, XI = sec / (6 * nu ** 3) * (nu / rho + 2 * t * t), XII = sec / (120 * nu ** 5) * (5 + 28 * t * t + 24 * t ** 4);
    const lat = phi - VII * d * d + VIII * d ** 4 - IX * d ** 6, lon = LON0 + X * d - XI * d ** 3 + XII * d ** 5;
    const [la, lo] = shift(lat, lon, AIRY, WGS, -1);
    return [lo / RAD, la / RAD];
  }
  /* "NY 21542 07210" for places in Great Britain, otherwise null. */
  function ref(lat, lon) {
    if (lat < 49.8 || lat > 60.95 || lon < -8.7 || lon > 1.8 || (lat > 54 && lat < 55.35 && lon < -5.35)) return null;
    const [E, N] = toEN(lat, lon), e = Math.floor(E / 100000), nn = Math.floor(N / 100000);
    if (e < 0 || e > 6 || nn < 0 || nn > 12) return null;
    let a = (19 - nn) - (19 - nn) % 5 + Math.floor((e + 10) / 5), b = ((19 - nn) * 5) % 25 + e % 5;
    if (a > 7) a++; if (b > 7) b++;
    const five = v => String(Math.floor(v % 100000)).padStart(5, "0");
    return String.fromCharCode(65 + a, 65 + b) + " " + five(E) + " " + five(N);
  }
  /* Reads "NY 215 072" or "NY2154207210" and returns [lon, lat], otherwise null. */
  function parse(text) {
    const m = /^\s*([HNOST])\s*([A-HJ-Z])\s*(\d[\d\s]*)$/i.exec(text); if (!m) return null;
    const digits = m[3].replace(/\s/g, ""); if (digits.length % 2 || digits.length > 10 || digits.length < 2) return null;
    let a = m[1].toUpperCase().charCodeAt(0) - 65, b = m[2].toUpperCase().charCodeAt(0) - 65;
    if (a > 7) a--; if (b > 7) b--;
    const e = ((a - 2 + 25) % 5) * 5 + b % 5, nn = (19 - Math.floor(a / 5) * 5) - Math.floor(b / 5);
    if (e < 0 || e > 6 || nn < 0 || nn > 12) return null;
    const half = digits.length / 2, sq = 10 ** (5 - half);
    return fromEN(e * 100000 + Number(digits.slice(0, half)) * sq + sq / 2, nn * 100000 + Number(digits.slice(half)) * sq + sq / 2);
  }
  return { ref, parse, toEN, fromEN };
})();
