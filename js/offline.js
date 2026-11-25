"use strict";
/* Map data: every map and elevation tile is looked up on the phone first, then on the internet.
   "Offline maps" are areas whose tiles and walking routes are saved on the phone until you delete them. */

const VT_MAX = 14, DEM_MAX = 12, MAX_TILES = 40000;
const TILEJSON = "https://tiles.openfreemap.org/planet";
const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/* ---- tile maths ---- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lon2x = (lon, z) => clamp(Math.floor((lon + 180) / 360 * 2 ** z), 0, 2 ** z - 1);
const lat2y = (lat, z) => { const r = clamp(lat, -85.0511, 85.0511) * RAD; return clamp(Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z), 0, 2 ** z - 1); };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / RAD;
function tileRange(bbox, z, margin = 0) {
  const n = 2 ** z - 1;
  return [clamp(lon2x(bbox[0], z) - margin, 0, n), clamp(lat2y(bbox[3], z) - margin, 0, n), clamp(lon2x(bbox[2], z) + margin, 0, n), clamp(lat2y(bbox[1], z) + margin, 0, n)];
}
/* Does a downloaded area include this tile? Keys look like "vt/14/8000/5200". */
function areaHas(bbox, key) {
  const [type, z, x, y] = key.split("/"); const r = tileRange(bbox, +z, type === "dem" ? 1 : 0);
  return +x >= r[0] && +x <= r[2] && +y >= r[1] && +y <= r[3];
}
function areaKeys(bbox) {
  const keys = [];
  for (const [type, max, margin] of [["vt", VT_MAX, 0], ["dem", DEM_MAX, 1]])
    for (let z = 0; z <= max; z++) { const r = tileRange(bbox, z, margin); for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) keys.push(`${type}/${z}/${x}/${y}`); }
  return keys;
}
function areaEstimate(bbox) {
  let tiles = 0, bytes = 0;
  for (const [max, margin, size] of [[VT_MAX, 0, z => z < 12 ? 90000 : 45000], [DEM_MAX, 1, () => 90000]])
    for (let z = 0; z <= max; z++) { const r = tileRange(bbox, z, margin), n = (r[2] - r[0] + 1) * (r[3] - r[1] + 1); tiles += n; bytes += n * size(z); }
  return { tiles, bytes };
}

/* ---- fetching ---- */
let vtTemplate = loadJSON("tm-vt-template", null), vtRefreshing = null;
function refreshTemplate() {
  return vtRefreshing || (vtRefreshing = fetchTimeout(TILEJSON, { cache: "no-cache" }, 12000)
    .then(r => { if (!r.ok) throw new Error("Map server " + r.status); vtTemplate = r.json().tiles[0]; saveJSON("tm-vt-template", vtTemplate); return vtTemplate; })
    .finally(() => { vtRefreshing = null; }));
}
async function netTile(type, z, x, y, signal) {
  if (type === "dem") {
    const r = await fetchTimeout(DEM_URL(z, x, y), { signal });
    if (!r.ok) throw new Error("Elevation server " + r.status);
    return r.buf;
  }
  const url = t => t.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const used = vtTemplate || await refreshTemplate();
  let r = await fetchTimeout(url(used), { signal });
  if (!r.ok) { // the server publishes a new map version every week or so
    const fresh = await refreshTemplate();
    if (fresh !== used) r = await fetchTimeout(url(fresh), { signal });
  }
  if (r.status === 404 || r.status === 204) return new ArrayBuffer(0); // nothing there (open sea)
  if (!r.ok) throw new Error("Map server " + r.status);
  return r.buf;
}
async function getTile(type, z, x, y, signal) {
  let saved; try { saved = await DB.get("tiles", `${type}/${z}/${x}/${y}`); } catch (e) { /* storage unavailable: use the network */ }
  return saved ? saved.slice(0) : netTile(type, z, x, y, signal);
}

/* ---- MapLibre protocols ---- */
const demSource = new mlcontour.DemSource({ url: "https://dem.invalid/{z}/{x}/{y}", encoding: "terrarium", maxzoom: DEM_MAX, worker: false, cacheSize: 120, timeoutMs: 30000 });
demSource.manager.getTile = async (url, ac) => {
  const [z, x, y] = url.split("/").slice(-3).map(Number);
  return { data: new Blob([await getTile("dem", z, x, y, ac && ac.signal)], { type: "image/png" }) };
};
demSource.setupMaplibre(maplibregl);
maplibregl.addProtocol("tm", async (req, ac) => {
  const parts = req.url.slice(5).split("/");
  if (parts[0] === "vt") return { data: await getTile("vt", +parts[1], +parts[2], +parts[3], ac.signal) };
  if (parts[0] === "walk") return { data: await walkTile(+parts[1], +parts[2], +parts[3], ac.signal) };
  if (parts[0] === "pack") return { data: await Packs.tile(+parts[1], +parts[2], +parts[3], ac.signal) };
  if (parts[0] === "slope") return { data: await slopeTile(+parts[1], +parts[2], +parts[3]) };
  const font = decodeURIComponent(parts[1]).split(",")[0], range = parts[2]; // label fonts: bundled first, then online
  for (const url of [`vendor/fonts/${encodeURIComponent(font)}/${range}.pbf`, `https://tiles.openfreemap.org/fonts/${encodeURIComponent(font)}/${range}.pbf`]) {
    try { const r = await fetchTimeout(url, { signal: ac.signal }, 10000); if (r.ok) return { data: r.buf }; } catch (e) { /* try the next one */ }
  }
  return { data: new ArrayBuffer(0) };
});

/* ---- ground height at a point (works offline inside downloaded areas) ---- */
const demImages = new Map();
function demPixels(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!demImages.has(k)) {
    demImages.set(k, getTile("dem", z, x, y).then(buf => createImageBitmap(new Blob([buf], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" })).then(img => {
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    }).catch(e => { demImages.delete(k); throw e; }));
    if (demImages.size > 40) demImages.delete(demImages.keys().next().value);
  }
  return demImages.get(k);
}
async function elevationAt(ll) {
  try {
    const z = DEM_MAX, x = lon2x(ll[0], z), y = lat2y(ll[1], z), img = await demPixels(z, x, y);
    const fx = (ll[0] + 180) / 360 * 2 ** z - x, r = ll[1] * RAD, fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z - y;
    const px = clamp(Math.floor(fx * img.width), 0, img.width - 1), py = clamp(Math.floor(fy * img.height), 0, img.height - 1), i = (py * img.width + px) * 4;
    return img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768;
  } catch (e) { return null; }
}

/* ---- steepness colouring, worked out on the phone from the height data (so it works offline) ---- */
const SLOPES = [[15, "15–25°", [247, 214, 59]], [25, "25–35°", [242, 140, 40]], [35, "35–45°", [217, 48, 37]], [45, "Over 45°", [123, 31, 162]]];
async function slopeTile(z, x, y) {
  const img = await demPixels(z, x, y), w = img.width, h = img.height, d = img.data;
  const height = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) height[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  const canvas = new OffscreenCanvas(w, h), g = canvas.getContext("2d"), out = g.createImageData(w, h);
  for (let py = 0; py < h; py++) {
    const metres = 40075016.686 * Math.cos(y2lat(y + (py + 0.5) / h, z) * RAD) / (w * 2 ** z); // ground size of a pixel
    const up = Math.max(0, py - 1), down = Math.min(h - 1, py + 1);
    for (let px = 0; px < w; px++) {
      const left = Math.max(0, px - 1), right = Math.min(w - 1, px + 1);
      const dx = (height[py * w + right] - height[py * w + left]) / ((right - left) * metres);
      const dy = (height[down * w + px] - height[up * w + px]) / ((down - up) * metres);
      const degrees = Math.atan(Math.hypot(dx, dy)) / RAD;
      let band = null; for (const s of SLOPES) if (degrees >= s[0]) band = s[2];
      if (band) out.data.set([band[0], band[1], band[2], 175], (py * w + px) * 4);
    }
  }
  g.putImageData(out, 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
}

/* ---- downloaded areas ---- */
const Offline = (() => {
  let job = null; // { id, abort, done, total, stage }
  const listeners = [];
  const changed = () => listeners.forEach(f => f());
  const list = () => DB.all("regions").then(a => a.sort((p, q) => q.created - p.created));

  async function download(region, refresh) {
    if (job) throw new Error("Another download is running");
    const abort = new AbortController(), keys = areaKeys(region.bbox);
    job = { id: region.id, abort, done: 0, total: keys.length, stage: "Map and hills" };
    region.complete = false; region.error = "";
    let bytes = 0, failed = 0, next = 0, fatal = null;
    try {
      await DB.put("regions", region); changed();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      keepAwake(true);
      await refreshTemplate();
      const worker = async () => {
        while (next < keys.length && !abort.signal.aborted && !fatal) {
          const key = keys[next++], [type, z, x, y] = key.split("/");
          try {
            let buf = refresh ? null : await DB.get("tiles", key);
            if (!buf) {
              for (let attempt = 1; ; attempt++) {
                try { buf = await netTile(type, +z, +x, +y, abort.signal); break; }
                catch (e) { if (attempt >= 3 || abort.signal.aborted) throw e; await new Promise(r => setTimeout(r, 1500 * attempt)); }
              }
              try { await DB.put("tiles", buf, key); } catch (e) { fatal = new Error("The phone is out of storage space"); throw e; }
            }
            bytes += buf.byteLength;
          } catch (e) { if (!abort.signal.aborted) failed++; }
          job.done++;
          if (job.done % 20 === 0) changed();
          if (failed > 40 && failed > job.done / 2) fatal = fatal || new Error("Lost the internet connection");
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (fatal) throw fatal;
      if (abort.signal.aborted) throw new Error("Stopped");
      if (failed) throw new Error(failed + " map pieces failed");
      job.stage = "Walking routes"; changed();
      await Routes.saveArea(region.bbox, refresh, abort.signal);
      job.stage = "Gates and boundaries"; changed();
      await Barriers.saveArea(region.bbox, refresh, abort.signal);
      region.complete = true; region.updated = Date.now();
    } catch (e) {
      region.error = abort.signal.aborted ? "Stopped" : e.name === "AbortError" ? "The server took too long" : e.message || "Download failed";
    } finally {
      region.bytes = Math.max(bytes, region.complete ? 0 : region.bytes || 0);
      const removed = job.removed; job = null; keepAwake(SETTINGS.awake);
      if (!removed) await DB.put("regions", region).catch(() => {});
      changed();
      if (removed) await remove(removed);
    }
    return region;
  }

  async function remove(id) {
    if (job && job.id === id) { job.removed = id; job.abort.abort(); return; }
    const all = await list(), others = all.filter(r => r.id !== id);
    const tiles = (await DB.keys("tiles")).filter(k => !others.some(r => areaHas(r.bbox, k)));
    const mine = all.find(r => r.id === id);
    for (let i = 0; i < tiles.length; i += 1000) await DB.delMany("tiles", tiles.slice(i, i + 1000));
    if (mine) await Routes.dropArea(mine.bbox, others.map(r => r.bbox));
    if (mine) await Barriers.dropArea(mine.bbox, others.map(r => r.bbox));
    await DB.del("regions", id); demImages.clear(); changed();
  }

  return { list, download, remove, stop: () => job && job.abort.abort(), job: () => job, onChange: f => listeners.push(f) };
})();

function keepAwake(on) { if (NATIVE) NATIVE.keepAwake(!!on); else if (on && navigator.wakeLock) navigator.wakeLock.request("screen").catch(() => {}); }
