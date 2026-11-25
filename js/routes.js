"use strict";
/* Named hiking and walking routes (National Trails, long-distance paths, local walks) from OpenStreetMap.
   They are fetched in squares ("cells") about 20 km across, kept on the phone, and included in downloaded areas. */

const Routes = (() => {
  const Z = 10, MAX_AGE = 30 * 864e5;
  /* The main server is tried twice because it is often busy for a moment; the second server is a backup. */
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass-api.de/api/interpreter"];
  const NETWORKS = { iwn: ["International", "#c0182b", 0], nwn: ["National", "#7b2cbf", 1], rwn: ["Regional", "#d9620a", 2], lwn: ["Local and other", "#0b6e8a", 3] };
  const memory = new Map();       // cell key -> { t, routes }
  let index = new Map();          // route id -> merged route currently on the map
  let status = "", busy = false, again = false, timer = null, retryAt = 0, selected = null;
  const listeners = [];
  const changed = () => listeners.forEach(f => f());

  const cellsFor = bbox => { const r = tileRange(bbox, Z), out = []; for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) out.push([x, y]); return out; };
  const key = c => c[0] + "/" + c[1];
  async function read(k) {
    if (!memory.has(k)) { const v = await DB.get("cells", k).catch(() => null); if (v) memory.set(k, v); }
    return memory.get(k);
  }

  async function query(cells, signal, limit = 45000) {
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const box = [y2lat(y1 + 1, Z), x2lon(x0, Z), y2lat(y0, Z), x2lon(x1 + 1, Z)].map(v => v.toFixed(5)).join(",");
    const q = `[out:json][timeout:60];relation["type"="route"]["route"~"^(hiking|foot|walking)$"](${box});out geom(${box});`;
    let last;
    for (const server of SERVERS) {
      try {
        const r = await fetchTimeout(server, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal }, limit);
        if (!r.ok) throw new Error("Route server busy (" + r.status + ")");
        const data = r.json();
        if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error("Route server busy");
        await store(cells, data.elements || []);
        return;
      } catch (e) { last = e; if (signal && signal.aborted) break; }
    }
    throw last;
  }

  /* Cut each route into the cells it crosses, so each cell can be saved and removed on its own. */
  async function store(cells, elements) {
    const out = new Map(cells.map(c => [key(c), new Map()]));
    for (const rel of elements) {
      const t = rel.tags || {};
      const info = { id: rel.id, name: t.name || t.ref || "Unnamed walking route", ref: t.ref || "", network: NETWORKS[t.network] ? t.network : "lwn", from: t.from || "", to: t.to || "", distance: t.distance || "", desc: t.description || "", web: t.website || t.url || "", operator: t.operator || "" };
      for (const m of rel.members || []) {
        if (m.type !== "way" || !m.geometry) continue;
        let run = [], runKey = null;
        const flush = () => {
          if (run.length > 1 && out.has(runKey)) { const cell = out.get(runKey); if (!cell.has(rel.id)) cell.set(rel.id, Object.assign({ lines: [] }, info)); cell.get(rel.id).lines.push(run); }
          run = [];
        };
        for (let i = 1; i < m.geometry.length; i++) {
          const a = m.geometry[i - 1], b = m.geometry[i];
          if (!a || !b) { flush(); continue; }
          const k = lon2x((a.lon + b.lon) / 2, Z) + "/" + lat2y((a.lat + b.lat) / 2, Z);
          const pa = [+a.lon.toFixed(5), +a.lat.toFixed(5)], pb = [+b.lon.toFixed(5), +b.lat.toFixed(5)];
          const joined = run.length && k === runKey && run[run.length - 1][0] === pa[0] && run[run.length - 1][1] === pa[1];
          if (!joined) { flush(); run = [pa]; runKey = k; }
          run.push(pb);
        }
        flush();
      }
    }
    for (const [k, routes] of out) { const v = { t: Date.now(), routes: [...routes.values()] }; memory.set(k, v); await DB.put("cells", v, k).catch(() => {}); }
  }

  function visibleCells() {
    const b = map.getBounds(), c = map.getCenter();
    const cells = cellsFor([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    const cx = lon2x(c.lng, Z), cy = lat2y(c.lat, Z);
    return cells.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy)).slice(0, 12);
  }

  function render(cells) {
    index = new Map();
    for (const c of cells) {
      const v = memory.get(key(c)); if (!v) continue;
      for (const r of v.routes) { if (!index.has(r.id)) index.set(r.id, Object.assign({}, r, { lines: [] })); index.get(r.id).lines.push(...r.lines); }
    }
    if (selected && !index.has(selected.id)) index.set(selected.id, selected);
    const features = [...index.values()].sort((a, b) => NETWORKS[b.network][2] - NETWORKS[a.network][2]).map(r => ({
      type: "Feature", properties: { id: r.id, label: r.name, color: NETWORKS[r.network][1] }, geometry: { type: "MultiLineString", coordinates: r.lines } }));
    setData("routes", { type: "FeatureCollection", features });
  }

  async function refresh() {
    if (!map) return;
    if (!SETTINGS.routes) { overview(false); return; }
    if (map.getZoom() < 9.5) { overview(true); status = navigator.onLine ? "Showing an overview. Zoom in to tap a route and see details." : "Zoom in to see saved walking routes."; setData("routes", EMPTY); index = new Map(); changed(); return; }
    if (busy) { again = true; return; }
    busy = true;
    try {
      const cells = visibleCells(), have = await Promise.all(cells.map(c => read(key(c))));
      render(cells);
      overview(have.some(v => !v)); // show the quick picture of routes until the details arrive
      const missing = cells.filter((c, i) => !have[i] || (navigator.onLine && Date.now() - have[i].t > MAX_AGE));
      if (!missing.length) status = "";
      else if (!navigator.onLine) status = "Offline: showing saved routes only.";
      else if (Date.now() < retryAt) status = "Route server busy. Trying again shortly.";
      else {
        status = "Loading walking routes…"; changed();
        try { await query(missing); status = ""; render(visibleCells()); overview(false); }
        catch (e) { retryAt = Date.now() + 20000; status = "Couldn't load routes. Trying again shortly."; clearTimeout(timer); timer = setTimeout(refresh, 21000); }
      }
    } finally {
      busy = false; changed();
      if (again) { again = false; schedule(); }
    }
  }
  function overview(on) { if (map.getLayer("routes-overview")) map.setLayoutProperty("routes-overview", "visibility", on && SETTINGS.routes && navigator.onLine ? "visible" : "none"); }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 700); };

  async function saveArea(bbox, force, signal) {
    const cells = [];
    for (const c of cellsFor(bbox)) if (force || !await read(key(c))) cells.push(c);
    // ask for 4 x 4 blocks at a time so each request stays small
    const blocks = new Map(); cells.forEach(c => { const b = (c[0] >> 2) + "/" + (c[1] >> 2); if (!blocks.has(b)) blocks.set(b, []); blocks.get(b).push(c); });
    for (const block of blocks.values()) {
      for (let attempt = 1; ; attempt++) {
        try { await query(block, signal, 90000); break; }
        catch (e) {
          if (signal.aborted) throw e;
          if (attempt >= 3) throw new Error("Map saved, but the walking route server is busy. Tap Resume later.");
          await new Promise(r => setTimeout(r, 10000 * attempt));
        }
      }
    }
    schedule();
  }
  async function dropArea(bbox, keep) {
    const kept = new Set(keep.flatMap(b => cellsFor(b).map(key)));
    const gone = cellsFor(bbox).map(key).filter(k => !kept.has(k));
    gone.forEach(k => memory.delete(k)); await DB.delMany("cells", gone); schedule();
  }

  function select(id) {
    selected = id == null ? null : index.get(id) || selected;
    if (map) map.setFilter("routes-highlight", ["==", ["get", "id"], selected ? selected.id : -1]);
    return selected;
  }

  return {
    NETWORKS, refresh, schedule, saveArea, dropArea, select,
    get: id => index.get(id),
    status: () => status,
    inView() {
      const b = map.getBounds();
      return [...index.values()].filter(r => r.lines.some(l => l.some(p => b.contains(p))))
        .sort((a, c) => NETWORKS[a.network][2] - NETWORKS[c.network][2] || a.name.localeCompare(c.name));
    },
    /* Search the names of every route saved on the phone. */
    async search(text) {
      const t = text.toLowerCase(), found = new Map();
      for (const v of await DB.all("cells").catch(() => [])) for (const r of v.routes)
        if (r.name.toLowerCase().includes(t) || r.ref.toLowerCase() === t) { if (!found.has(r.id)) found.set(r.id, Object.assign({}, r, { lines: [] })); found.get(r.id).lines.push(...r.lines); }
      return [...found.values()].slice(0, 12);
    },
    show(route) { index.set(route.id, route); selected = route; render(visibleCells()); select(route.id); },
    onChange: f => listeners.push(f)
  };
})();
