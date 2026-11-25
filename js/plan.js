"use strict";
/* Place search, directions, measuring, height profiles, and saved places and routes. */

const SAVED = Object.assign({ places: [], routes: [] }, loadJSON("tm-saved", {}));
function persistSaved() {
  if (!saveJSON("tm-saved", SAVED)) toast("Couldn't save: storage is full");
  drawSaved();
}
const drawSaved = () => setData("saved", { type: "FeatureCollection", features: SAVED.places.map(p => ({ type: "Feature", properties: { id: p.id, name: p.name }, geometry: { type: "Point", coordinates: p.ll } })) });

/* ---- search ---- */
function parseCoords(text) {
  const grid = OSGB.parse(text); if (grid) return grid;
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) return [+m[2], +m[1]];
  return null;
}
async function searchPlaces(text) {
  const b = map.getBounds();
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&accept-language=en&q=" + encodeURIComponent(text) +
    "&viewbox=" + [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map(v => v.toFixed(4)).join(",");
  const r = await fetchTimeout(url, {}, 12000);
  if (!r.ok) throw new Error("Search server " + r.status);
  return r.json().map(p => {
    const parts = p.display_name.split(", ");
    return { name: p.name || parts[0], detail: parts.slice(1, 4).join(", "), ll: [+p.lon, +p.lat], box: p.boundingbox ? [+p.boundingbox[2], +p.boundingbox[0], +p.boundingbox[3], +p.boundingbox[1]] : null };
  });
}

/* ---- height profile ---- */
async function profileOf(coords) {
  const total = lineLength(coords); if (!total) return null;
  const n = Math.min(200, Math.max(12, Math.round(total / 50))), pts = [];
  let seg = 1, before = 0;
  for (let i = 0; i <= n; i++) {
    const want = total * i / n;
    while (seg < coords.length - 1 && before + haversine(coords[seg - 1], coords[seg]) < want) { before += haversine(coords[seg - 1], coords[seg]); seg++; }
    const a = coords[seg - 1], b = coords[seg], len = haversine(a, b), f = len ? clamp((want - before) / len, 0, 1) : 0;
    pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  const heights = [];
  for (const p of pts) heights.push(await elevationAt(p));
  if (heights.some(h => h == null)) return null;
  let up = 0, down = 0, ref = heights[0];
  for (const h of heights) { const d = h - ref; if (Math.abs(d) >= 4) { if (d > 0) up += d; else down -= d; ref = h; } } // ignore tiny bumps in the height data
  return { heights, up, down, min: Math.min(...heights), max: Math.max(...heights), total };
}
function profileSVG(p) {
  const span = Math.max(30, p.max - p.min), n = p.heights.length - 1;
  const d = p.heights.map((h, i) => (i ? "L" : "M") + (i / n * 300).toFixed(1) + " " + (86 - (h - p.min) / span * 80).toFixed(1)).join("");
  return `<svg class="profile" viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="Height along the route, from ${esc(fmtHeight(p.min))} to ${esc(fmtHeight(p.max))}"><path class="fill" d="${d}L300 90L0 90Z"/><path class="line" d="${d}"/></svg>
    <div class="row small muted"><span class="grow">Lowest ${fmtHeight(p.min)}</span><span>Highest ${fmtHeight(p.max)}</span></div>`;
}
/* Naismith's rule: 5 km an hour, plus an hour for every 600 m climbed. */
const walkSeconds = (dist, up) => dist / 5000 * 3600 + (up || 0) / 600 * 3600;

/* ---- directions and measuring ---- */
const Plan = (() => {
  const state = { stops: [], mode: "foot", result: null, busy: false, error: "", measure: false };
  let markers = [], token = 0;
  const listeners = [];
  const changed = () => listeners.forEach(f => f());
  const pointOf = s => s.me ? (GPS.state.pos ? GPS.state.pos.ll : null) : s.ll;

  function drawMarkers() {
    markers.forEach(m => m.remove()); markers = [];
    state.stops.forEach((s, i) => {
      if (s.me) return;
      const el = document.createElement("div"); el.className = "stop-mark"; el.textContent = String.fromCharCode(65 + (i % 26));
      markers.push(new maplibregl.Marker({ element: el }).setLngLat(s.ll).addTo(map));
    });
  }

  async function calculate() {
    const mine = ++token;
    state.result = null; state.error = ""; drawMarkers(); setData("plan", EMPTY);
    const pts = state.stops.map(pointOf);
    if (pts.length < 2) { state.busy = false; changed(); return; }
    if (pts.some(p => !p)) { state.busy = false; state.error = "Waiting for GPS to find where you are…"; changed(); return; }
    state.busy = true; changed();
    try {
      let coords, distance, duration, steps = [];
      if (state.measure) { coords = pts; distance = lineLength(pts); }
      else {
        const url = `https://routing.openstreetmap.de/routed-${state.mode}/route/v1/driving/${pts.map(p => p[0].toFixed(6) + "," + p[1].toFixed(6)).join(";")}?overview=full&geometries=geojson&steps=true`;
        const r = await fetchTimeout(url, {}, 25000);
        let data = null; try { data = r.json(); } catch (e) { /* not JSON */ }
        if (!data || data.code !== "Ok") throw new Error(data && data.code === "NoRoute" ? "No route found between those points." : "The directions server didn't answer. Try again.");
        const best = data.routes[0]; coords = best.geometry.coordinates; distance = best.distance; duration = best.duration;
        steps = best.legs.flatMap(l => l.steps).map(stepText).filter(Boolean);
      }
      if (mine !== token) return;
      setData("plan", lineFeature(coords));
      state.result = { coords, distance, duration, steps, profile: undefined };
      state.busy = false; changed();
      const profile = await profileOf(coords);
      if (mine !== token) return;
      state.result.profile = profile; changed();
    } catch (e) {
      if (mine !== token) return;
      state.busy = false;
      state.error = !navigator.onLine ? "Directions need internet. Measure distance works offline." : e.name === "AbortError" || e.name === "TypeError" ? "The directions server didn't answer. Try again." : e.message;
      changed();
    }
  }
  function stepText(s) {
    const m = s.maneuver, name = s.name ? " onto " + s.name : "";
    let t;
    if (m.type === "depart") t = "Set off" + (s.name ? " along " + s.name : "");
    else if (m.type === "arrive") return "Arrive at your destination";
    else if (m.type === "roundabout" || m.type === "rotary") t = "At the roundabout take exit " + (m.exit || 1) + name;
    else if (!m.modifier || m.modifier === "straight") t = "Continue" + (s.name ? " on " + s.name : " straight on");
    else if (m.modifier === "uturn") t = "Turn back" + name;
    else t = (m.type === "fork" ? "Keep " : m.type === "merge" ? "Merge " : "Turn ") + m.modifier + name;
    return `${t} (${fmtDist(s.distance)})`;
  }
  function clear() { token++; state.stops = []; state.result = null; state.error = ""; state.busy = false; state.measure = false; drawMarkers(); setData("plan", EMPTY); changed(); }

  return {
    state, calculate, clear, onChange: f => listeners.push(f),
    add(stop) { state.stops.push(stop); calculate(); },
    removeAt(i) { state.stops.splice(i, 1); calculate(); },
    reverse() { state.stops.reverse(); calculate(); },
    setMode(m) { state.mode = m; calculate(); },
    to(stop) { clear(); state.stops = [{ me: true, name: "My location" }, stop]; calculate(); },
    /* Show a saved walk without asking the internet for it again. */
    showSaved(r) {
      clear(); state.mode = r.mode === "measure" ? state.mode : r.mode;
      setData("plan", lineFeature(r.coords));
      state.result = { coords: r.coords, distance: r.distance, duration: r.duration, steps: r.steps || [], profile: r.profile, saved: r };
      state.measure = r.mode === "measure"; changed();
    }
  };
})();
