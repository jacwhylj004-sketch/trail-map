"use strict";
/* Gates, stiles, walls, fences and hedges from OpenStreetMap, for the map styles drawn from online data. Like walking
   routes, they are fetched in squares ("cells", about 6 km across), kept on the phone and included in downloaded areas.
   Only what people have mapped appears. */

const Barriers = (() => {
  const Z = 12, MAX_AGE = 60 * 864e5, FROM_ZOOM = 13.5;
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass-api.de/api/interpreter"];
  const GATE_KINDS = { gate: "gate", lift_gate: "gate", swing_gate: "gate", kissing_gate: "kissing_gate", stile: "stile" };
  const memory = new Map(); // "x/y" -> { t, lines: [[kind, coords]], gates: [[kind, lon, lat]] }
  let busy = false, again = false, timer = null, retryAt = 0, drawn = "";

  const cellsFor = bbox => { const r = tileRange(bbox, Z), out = []; for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) out.push([x, y]); return out; };
  const key = c => c[0] + "/" + c[1];
  async function read(k) {
    if (!memory.has(k)) { const v = await DB.get("cells", "b/" + k).catch(() => null); if (v) memory.set(k, v); }
    return memory.get(k);
  }

  async function query(cells, signal, limit = 45000) {
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const box = [y2lat(y1 + 1, Z), x2lon(x0, Z), y2lat(y0, Z), x2lon(x1 + 1, Z)].map(v => v.toFixed(5)).join(",");
    const q = `[out:json][timeout:60];(way["barrier"~"^(wall|fence|hedge)$"](${box});node["barrier"~"^(${Object.keys(GATE_KINDS).join("|")})$"](${box}););out geom;`;
    let last;
    for (const server of SERVERS) {
      try {
        const r = await fetchTimeout(server, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal }, limit);
        if (!r.ok) throw new Error("Server busy (" + r.status + ")");
        const data = r.json();
        if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error("Server busy");
        await store(cells, data.elements || []);
        return;
      } catch (e) { last = e; if (signal && signal.aborted) break; }
    }
    throw last;
  }

  async function store(cells, elements) {
    const out = new Map(cells.map(c => [key(c), { t: Date.now(), lines: [], gates: [] }]));
    const at = (lon, lat) => out.get(lon2x(lon, Z) + "/" + lat2y(lat, Z));
    const point = p => [+p.lon.toFixed(5), +p.lat.toFixed(5)];
    for (const e of elements) {
      const kind = e.tags && e.tags.barrier; if (!kind) continue;
      if (e.type === "node") { const cell = at(e.lon, e.lat); if (cell && GATE_KINDS[kind]) cell.gates.push([GATE_KINDS[kind], ...point(e)]); continue; }
      /* cut each line into the cells it crosses, so cells can be saved and removed on their own */
      let run = [], cell = null;
      const flush = () => { if (cell && run.length > 1) cell.lines.push([kind, run]); run = []; };
      const g = (e.geometry || []).filter(Boolean);
      for (let i = 1; i < g.length; i++) {
        const here = at((g[i - 1].lon + g[i].lon) / 2, (g[i - 1].lat + g[i].lat) / 2);
        if (here !== cell || !run.length) { flush(); cell = here; run = [point(g[i - 1])]; }
        run.push(point(g[i]));
      }
      flush();
    }
    for (const [k, v] of out) { memory.set(k, v); await DB.put("cells", v, "b/" + k).catch(() => {}); }
    drawn = "";
  }

  function render(cells) {
    const keys = cells.map(key).filter(k => memory.has(k)), stamp = keys.sort().join(" ");
    if (stamp === drawn) return;
    drawn = stamp;
    const features = [];
    for (const k of keys) {
      const v = memory.get(k);
      for (const [kind, coords] of v.lines) features.push(lineFeature(coords, { kind }));
      for (const [kind, lon, lat] of v.gates) features.push({ type: "Feature", properties: { kind }, geometry: { type: "Point", coordinates: [lon, lat] } });
    }
    setData("barriers", { type: "FeatureCollection", features });
  }

  async function refresh() {
    if (!map || !SETTINGS.barriers || SETTINGS.base === "tt" || map.getZoom() < FROM_ZOOM) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const b = map.getBounds(), c = map.getCenter(), cx = lon2x(c.lng, Z), cy = lat2y(c.lat, Z);
      const cells = cellsFor([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
        .sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy)).slice(0, 9);
      const have = await Promise.all(cells.map(x => read(key(x))));
      render(cells);
      const missing = cells.filter((x, i) => !have[i] || (online() && Date.now() - have[i].t > MAX_AGE));
      if (!missing.length || !online()) return;
      if (Date.now() < retryAt) { clearTimeout(timer); timer = setTimeout(refresh, retryAt - Date.now() + 500); return; }
      try { await query(missing); render(cells); }
      catch (e) { retryAt = Date.now() + 25000; clearTimeout(timer); timer = setTimeout(refresh, 26000); }
    } finally {
      busy = false;
      if (again) { again = false; schedule(); }
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 1200); };

  async function saveArea(bbox, force, signal) {
    const cells = [];
    for (const c of cellsFor(bbox)) if (force || !await read(key(c))) cells.push(c);
    const blocks = new Map(); cells.forEach(c => { const b = (c[0] >> 1) + "/" + (c[1] >> 1); if (!blocks.has(b)) blocks.set(b, []); blocks.get(b).push(c); });
    for (const block of blocks.values()) {
      for (let attempt = 1; ; attempt++) {
        try { await query(block, signal, 90000); break; }
        catch (e) {
          if (signal.aborted) throw e;
          if (dataBlocked) throw new Error("Mobile data is off");
          if (attempt >= 3) throw new Error("Map and routes saved, but the server for gates and boundaries is busy. Tap Resume later.");
          await new Promise(r => setTimeout(r, 10000 * attempt));
        }
      }
    }
    schedule();
  }
  async function dropArea(bbox, keep) {
    const kept = new Set(keep.flatMap(b => cellsFor(b).map(key)));
    const gone = cellsFor(bbox).map(key).filter(k => !kept.has(k));
    gone.forEach(k => memory.delete(k)); await DB.delMany("cells", gone.map(k => "b/" + k)); drawn = ""; schedule();
  }

  /* ---- drawing ---- */
  function layers() {
    const of = kind => ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "kind"], kind]];
    const width = w => ["interpolate", ["linear"], ["zoom"], 13.5, w * 0.6, 16, w, 19, w * 2.2];
    const line = (kind, paint) => ({ id: "barrier-" + kind, type: "line", source: "barriers", minzoom: FROM_ZOOM, filter: of(kind), paint });
    return [
      line("hedge", { "line-color": "#1f8a3a", "line-width": width(2.6), "line-opacity": 0.9 }),
      line("wall", { "line-color": "#555555", "line-width": width(2) }),
      line("fence", { "line-color": "#8a8436", "line-width": width(1.2) }),
      { id: "barrier-fence-posts", type: "line", source: "barriers", minzoom: 15, filter: of("fence"), paint: { "line-color": "#8a8436", "line-width": width(4), "line-dasharray": [0.25, 2] } },
      { id: "barrier-gates", type: "symbol", source: "barriers", minzoom: 14, filter: ["==", ["geometry-type"], "Point"],
        layout: { "icon-image": ["concat", "bar-", ["get", "kind"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.95, 17, 1.4], "icon-allow-overlap": true } }
    ];
  }
  /* Small brown symbols: a barred gate, a stile (a step between two posts) and a kissing gate. */
  function addImages(m) {
    const make = (name, draw) => {
      const c = document.createElement("canvas"); c.width = c.height = 54;
      const g = c.getContext("2d"); g.scale(3, 3); g.lineCap = "round";
      for (const [colour, width] of [["#ffffff", 4.6], ["#7a3f0c", 2]]) { g.strokeStyle = colour; g.lineWidth = width; g.beginPath(); draw(g); g.stroke(); }
      m.addImage("bar-" + name, g.getImageData(0, 0, 54, 54), { pixelRatio: 3 });
    };
    const path = (g, ...pts) => pts.forEach((p, i) => i % 2 ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
    make("gate", g => path(g, [3, 3], [3, 15], [15, 3], [15, 15], [3, 6], [15, 6], [3, 12], [15, 12], [3, 12], [15, 6]));
    make("stile", g => path(g, [3, 7], [15, 7], [6, 7], [6, 15], [12, 7], [12, 15]));
    make("kissing_gate", g => path(g, [3, 3], [3, 13], [3, 4], [10, 4], [3, 8], [10, 8], [8, 7], [8, 16], [15, 7], [15, 16], [8, 8], [15, 8], [8, 13], [15, 13]));
  }

  return { schedule, saveArea, dropArea, layers, addImages };
})();
