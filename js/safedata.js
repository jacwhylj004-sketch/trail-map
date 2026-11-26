"use strict";
/* Safety details kept on the phone for walking routes worked out without internet: which main roads have pavements,
   fords, railway crossings and difficult mountain paths. The map tiles leave most of this out, so it comes from
   OpenStreetMap (Overpass) in squares ("cells", about 12 km across) as part of a downloaded area. */

const SafeData = (() => {
  const Z = 11, MAX_CELLS = 400;
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass-api.de/api/interpreter"];
  const MAIN = /^(trunk|primary|secondary|tertiary)(_link)?$/, ROUGH = /^(demanding_mountain_hiking|alpine_hiking|demanding_alpine_hiking|difficult_alpine_hiking)$/;
  const cellsFor = bbox => { const r = tileRange(bbox, Z), out = []; for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) out.push([x, y]); return out; };
  const key = c => "s/" + c[0] + "/" + c[1];

  /* ---- downloading ---- */
  async function query(cells, signal) {
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const box = [y2lat(Math.max(...ys) + 1, Z), x2lon(Math.min(...xs), Z), y2lat(Math.min(...ys), Z), x2lon(Math.max(...xs) + 1, Z)].map(v => v.toFixed(5)).join(",");
    const q = `[out:json][timeout:90];(way["highway"~"^(trunk|primary|secondary|tertiary)(_link)?$"](${box});way["highway"]["ford"](${box});way["highway"]["sac_scale"~"demanding|alpine"](${box});` +
      `node["ford"~"^(yes|stepping_stones)$"](${box});node["highway"="ford"](${box});node["railway"~"^(level_crossing|crossing)$"](${box}););out geom;`;
    let last;
    for (const server of SERVERS) {
      try {
        const r = await fetchTimeout(server, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal }, 100000);
        if (!r.ok) throw new Error("Server busy (" + r.status + ")");
        const data = r.json();
        if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error("Server busy");
        await store(cells, data.elements || []);
        return;
      } catch (e) { last = e; if (signal && signal.aborted) break; }
    }
    throw last;
  }
  /* Only what the warnings need is kept; a way is put in every cell it passes through. */
  async function store(cells, elements) {
    const out = new Map(cells.map(c => [key(c), { t: Date.now(), ways: [], points: [] }]));
    const at = (lon, lat) => key([lon2x(lon, Z), lat2y(lat, Z)]);
    const round = v => +v.toFixed(5);
    for (const e of elements) {
      const t = e.tags || {};
      if (e.type === "node") {
        const cell = out.get(at(e.lon, e.lat)); if (!cell) continue;
        cell.points.push([t.railway ? "rail" : "ford", round(e.lon), round(e.lat)]); continue;
      }
      const keep = {};
      for (const [k, v] of Object.entries(t)) if (/^(sidewalk(:(left|right|both))?|ford|sac_scale)$/.test(k)) keep[k] = v;
      let run = [], cell = null;
      const flush = () => { if (cell && run.length > 1) cell.ways.push([t.highway, keep, run]); run = []; };
      const g = (e.geometry || []).filter(Boolean);
      for (let i = 1; i < g.length; i++) {
        const here = out.get(at((g[i - 1].lon + g[i].lon) / 2, (g[i - 1].lat + g[i].lat) / 2));
        if (here !== cell || !run.length) { flush(); cell = here; run = [[round(g[i - 1].lon), round(g[i - 1].lat)]]; }
        run.push([round(g[i].lon), round(g[i].lat)]);
      }
      flush();
    }
    for (const [k, v] of out) await DB.put("cells", v, k);
  }

  async function saveArea(bbox, force, signal, progress = () => {}) {
    const cells = [];
    for (const c of cellsFor(bbox)) if (force || !await DB.get("cells", key(c)).catch(() => null)) cells.push(c);
    const blocks = new Map(); cells.forEach(c => { const b = (c[0] >> 1) + "/" + (c[1] >> 1); if (!blocks.has(b)) blocks.set(b, []); blocks.get(b).push(c); });
    let done = 0;
    for (const block of blocks.values()) {
      progress(done++, blocks.size);
      for (let attempt = 1; ; attempt++) {
        try { await query(block, signal); break; }
        catch (e) {
          if (signal.aborted) throw e;
          if (dataBlocked) throw new Error("Mobile data is off");
          if (attempt >= 3) throw new Error("Map saved, but the server for road warnings is busy. Tap Resume later.");
          await new Promise(r => setTimeout(r, 10000 * attempt));
        }
      }
    }
  }
  async function dropArea(bbox, keep) {
    const kept = new Set(keep.flatMap(b => cellsFor(b).map(key)));
    await DB.delMany("cells", cellsFor(bbox).map(key).filter(k => !kept.has(k)));
  }

  /* ---- looking things up along a route ---- */
  const SIZE = 0.0015; // degrees: the squares of the quick index
  /* What is saved for a box [west, south, east, north], ready to be asked about stretches [a, b] of a route. */
  async function load(bbox) {
    const have = new Set(), roads = new Map(), rough = new Map(), points = new Map();
    const squares = (lon0, lat0, lon1, lat1, each) => { for (let x = Math.floor(lon0 / SIZE); x <= Math.floor(lon1 / SIZE); x++) for (let y = Math.floor(lat0 / SIZE); y <= Math.floor(lat1 / SIZE); y++) each(x + "/" + y); };
    const put = (map, k, v) => { let l = map.get(k); if (!l) map.set(k, l = []); l.push(v); };
    for (const c of cellsFor(bbox)) {
      const v = await DB.get("cells", key(c)).catch(() => null); if (!v) continue;
      have.add(key(c));
      for (const [cls, tags, line] of v.ways) {
        const isRough = !!tags.ford || ROUGH.test(tags.sac_scale);
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1], b = line[i], s = { cls, tags, a, b };
          squares(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), k => { if (MAIN.test(cls)) put(roads, k, s); if (isRough) put(rough, k, s); });
        }
      }
      for (const [kind, lon, lat] of v.points) squares(lon, lat, lon, lat, k => put(points, k, [kind, lon, lat]));
    }
    /* distance in metres from a point to the stretch a-b */
    const away = (p, a, b) => {
      const kx = Math.cos(p[1] * RAD) * 111320, ky = 110540, ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, len = dx * dx + dy * dy;
      const t = len ? clamp(-(ax * dx + ay * dy) / len, 0, 1) : 0;
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    /* the way running along a stretch: near its middle and going the same direction */
    function along(map, a, b, near) {
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], k = Math.cos(m[1] * RAD);
      const dx = (b[0] - a[0]) * k, dy = b[1] - a[1], len = Math.hypot(dx, dy);
      let found = null, best = near;
      squares(m[0] - SIZE / 8, m[1] - SIZE / 8, m[0] + SIZE / 8, m[1] + SIZE / 8, sq => {
        for (const s of map.get(sq) || []) {
          const ex = (s.b[0] - s.a[0]) * k, ey = s.b[1] - s.a[1], el = Math.hypot(ex, ey);
          if (!el || (len > 4e-5 && Math.abs(dx * ex + dy * ey) < 0.85 * len * el)) continue; // a crossing way
          const d = away(m, s.a, s.b); if (d <= best) { best = d; found = s; }
        }
      });
      return found;
    }
    return {
      covered: ll => have.has(key([lon2x(ll[0], Z), lat2y(ll[1], Z)])),
      road: (a, b) => along(roads, a, b, 9),
      rough: (a, b) => along(rough, a, b, 4),
      /* the fords and railway crossings on a stretch */
      points(a, b) {
        const found = new Set();
        squares(Math.min(a[0], b[0]) - 1e-4, Math.min(a[1], b[1]) - 1e-4, Math.max(a[0], b[0]) + 1e-4, Math.max(a[1], b[1]) + 1e-4, sq => {
          for (const [kind, lon, lat] of points.get(sq) || []) if (away([lon, lat], a, b) <= 6) found.add(kind);
        });
        return found;
      }
    };
  }

  return { saveArea, dropArea, load, tooBig: bbox => cellsFor(bbox).length > MAX_CELLS };
})();
