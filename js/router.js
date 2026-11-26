"use strict";
/* Directions worked out on the phone, with no internet: the roads and paths are read from a downloaded area or an
   imported map, joined into a network, and searched for the best way (A*). */

const Router = (() => {
  const Z = 14, EXTENT = 4096, MAX_ROAD_TILES = 1100, SNAP = 600; // metres from a point to the nearest usable way

  /* How willingly each kind of way is used: length is multiplied by this (1 is ideal); missing means never. */
  const FOOT = { path: 1, footway: 1, pedestrian: 1, bridleway: 1, track: 1, cycleway: 1.05, steps: 1.1, service: 1.05, minor: 1.1, tertiary: 1.25, secondary: 1.45, primary: 1.8, trunk: 3, ferry: 1.5 };
  const BIKE = { cycleway: 0.85, minor: 1, tertiary: 1.05, service: 1.1, secondary: 1.2, primary: 1.5, trunk: 3, track: 1.5, bridleway: 1.4, path: 2.5, footway: 4, pedestrian: 2.5, ferry: 1.5 };
  const CAR = { motorway: 110, trunk: 85, primary: 65, secondary: 55, tertiary: 45, minor: 30, service: 15, ferry: 15 }; // km/h
  const PACK_CLASS = { 1: "motorway", 2: "trunk", 3: "primary", 4: "secondary", 5: "tertiary", 6: "minor", 7: "service",
    0x8: "path", 0x9: "cycleway", 0xa: "track", 0xc: "path", 0xd: "pedestrian", 0xf: "bridleway", 0x11: "bridleway", 0x13: "steps", 0x15: "path", 0x16: "path", 0x10102: "path", 0x11501: "cycleway" }; // (0x15 and 0x11501 mark long routes, and fill gaps)

  const clean = s => String(s || "").replace(/\s*(\[[^\]]*\]|\([^)]*\))\s*/g, " ").trim().replace(/^\d+$/, ""); // a bare cycle route number is no help

  /* ---- reading the ways out of tiles ---- */
  /* A line cut off at the tile's edges, so the pieces from neighbouring tiles meet exactly there. */
  function clip(pts, size) {
    const parts = []; let run = null;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
      let t0 = 0, t1 = 1;
      for (const [p, q] of [[-dx, ax], [dx, size - ax], [-dy, ay], [dy, size - ay]]) {
        if (p === 0) { if (q < 0) { t0 = 1; t1 = 0; } } else if (p < 0) t0 = Math.max(t0, q / p); else t1 = Math.min(t1, q / p);
      }
      if (t0 > t1) { run = null; continue; }
      const from = [ax + dx * t0, ay + dy * t0], to = [ax + dx * t1, ay + dy * t1];
      if (!run || t0 > 0) { run = [from]; parts.push(run); }
      run.push(to);
      if (t1 < 1) run = null;
    }
    return parts;
  }

  function waysFrom(buf, tx, ty, source, out) {
    const pack = source.type === "pack";
    const tile = readTile(buf, pack ? ["line"] : ["transportation", "transportation_name"]);
    const place = (part, extent) => clip(part.map(p => [p[0] * EXTENT / extent, p[1] * EXTENT / extent]), EXTENT)
      .map(run => run.map(p => [Math.round(tx * EXTENT + p[0]) - source.x0, Math.round(ty * EXTENT + p[1]) - source.y0]));
    for (const [layer, { extent, features }] of Object.entries(tile)) {
      for (const f of features) {
        if (f.type !== 2) continue;
        const p = f.props;
        if (layer === "transportation_name") {
          const name = p["name:latin"] || p.name || p.ref;
          if (name) for (const part of f.parts) for (const run of place(part, extent)) out.names.push({ name: String(name), pts: run });
          continue;
        }
        let cls, name = "", oneway = 0, level = 0;
        if (pack) { cls = PACK_CLASS[p.t]; name = clean(p.n); }
        else {
          cls = p.class === "path" ? (["footway", "pedestrian", "cycleway", "bridleway", "steps"].includes(p.subclass) ? p.subclass : "path") : p.class;
          if (p.access === "no") continue;
          oneway = +p.oneway || 0;
          level = p.brunnel === "bridge" ? 1 : p.brunnel === "tunnel" ? -1 : 0;
        }
        if (!cls || !(cls in FOOT || cls in CAR)) continue;
        for (const part of f.parts) for (const run of place(part, extent)) out.ways.push({ pts: run, cls, name, oneway, level });
      }
    }
  }

  /* ---- the network ---- */
  /* Joins the ways into points ("nodes") and the stretches between them ("edges"). A way that ends on, or very
     nearly on, another is joined to it: tiles don't always keep a shared point at junctions. */
  function build(ways, perUnit) {
    const ids = new Map(), X = [], Y = [], ends = [], levels = [], segments = [];
    const node = ([x, y]) => { const k = x * 16777216 + y; let n = ids.get(k); if (n === undefined) { n = X.length; ids.set(k, n); X.push(x); Y.push(y); ends.push(false); levels.push(0); } return n; };
    for (const w of ways) {
      let last = -1;
      w.pts.forEach((pt, i) => {
        const n = node(pt);
        if (i === 0 || i === w.pts.length - 1) ends[n] = true;
        levels[n] = w.level;
        if (last >= 0 && last !== n) segments.push({ a: last, b: n, way: w, cuts: null });
        last = n;
      });
    }
    const CELL = 128, grid = new Map(), cell = (cx, cy) => cx * 262144 + cy;
    segments.forEach((s, i) => {
      for (let cx = Math.floor(Math.min(X[s.a], X[s.b]) / CELL); cx <= Math.floor(Math.max(X[s.a], X[s.b]) / CELL); cx++)
        for (let cy = Math.floor(Math.min(Y[s.a], Y[s.b]) / CELL); cy <= Math.floor(Math.max(Y[s.a], Y[s.b]) / CELL); cy++) {
          const k = cell(cx, cy); let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(i);
        }
    });
    const parent = Array.from(X, (v, i) => i), find = n => { while (parent[n] !== n) n = parent[n] = parent[parent[n]]; return n; };
    const END = 2.5 / perUnit, MIDDLE = 0.8 / perUnit; // how near counts as touching, in tile units
    for (let n = 0; n < X.length; n++) {
      const tol = ends[n] ? END : MIDDLE, x = X[n], y = Y[n], seen = new Set();
      for (let cx = Math.floor((x - tol) / CELL); cx <= Math.floor((x + tol) / CELL); cx++)
        for (let cy = Math.floor((y - tol) / CELL); cy <= Math.floor((y + tol) / CELL); cy++)
          for (const i of grid.get(cell(cx, cy)) || []) {
            const s = segments[i];
            if (seen.has(i) || s.a === n || s.b === n) continue;
            seen.add(i);
            if (!ends[n] && s.way.level !== levels[n]) continue; // passing over or under, not meeting
            const ax = X[s.a], ay = Y[s.a], dx = X[s.b] - ax, dy = Y[s.b] - ay, len = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
            if (Math.hypot(ax + t * dx - x, ay + t * dy - y) > tol) continue;
            if (Math.hypot(x - ax, y - ay) <= tol) parent[find(n)] = find(s.a);
            else if (Math.hypot(x - X[s.b], y - Y[s.b]) <= tol) parent[find(n)] = find(s.b);
            else (s.cuts || (s.cuts = [])).push([t, n]);
          }
    }
    const edges = [], links = new Map();
    const link = (n, e) => { let list = links.get(n); if (!list) links.set(n, list = []); list.push(e); };
    for (const s of segments) {
      const chain = [s.a, ...(s.cuts ? s.cuts.sort((p, q) => p[0] - q[0]).map(c => c[1]) : []), s.b].map(find);
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1], b = chain[i]; if (a === b) continue;
        const e = edges.length;
        edges.push({ a, b, len: Math.hypot(X[b] - X[a], Y[b] - Y[a]) * perUnit, way: s.way });
        link(a, e); link(b, e);
      }
    }
    return { X, Y, edges, links, perUnit };
  }

  const speedFor = (cls, mode) => mode === "car" ? CAR[cls] / 3.6 : mode === "bike" ? (cls === "cycleway" || cls === "minor" || cls === "tertiary" || cls === "secondary" || cls === "primary" ? 4.4 : 3) : 5 / 3.6;
  /* Cost of going along an edge one way (forward: from a to b), or Infinity if that isn't allowed. */
  function cost(e, mode, forward) {
    if (mode === "car") {
      if (!CAR[e.way.cls] || (e.way.oneway && (e.way.oneway > 0) !== forward)) return Infinity;
      return e.len / (CAR[e.way.cls] / 3.6);
    }
    const factor = (mode === "bike" ? BIKE : FOOT)[e.way.cls];
    if (!factor || (mode === "bike" && e.way.oneway && (e.way.oneway > 0) !== forward && e.way.cls !== "cycleway")) return Infinity;
    return e.len * factor;
  }
  const usable = (e, mode) => cost(e, mode, true) < Infinity || cost(e, mode, false) < Infinity;

  /* Which separate piece of the network each edge belongs to. */
  function pieces(net, mode) {
    const piece = new Int32Array(net.edges.length).fill(-1); let count = 0;
    for (let first = 0; first < net.edges.length; first++) {
      if (piece[first] >= 0 || !usable(net.edges[first], mode)) continue;
      const stack = [first]; piece[first] = count;
      while (stack.length) {
        const e = net.edges[stack.pop()];
        for (const n of [e.a, e.b]) for (const next of net.links.get(n)) if (piece[next] < 0 && usable(net.edges[next], mode)) { piece[next] = count; stack.push(next); }
      }
      count++;
    }
    return piece;
  }

  /* For each stop, the nearest point of the network, all on one connected piece so there is a way between them. */
  function snap(net, mode, points) {
    const piece = pieces(net, mode), best = points.map(() => new Map()), limit = SNAP / net.perUnit;
    net.edges.forEach((e, i) => {
      if (piece[i] < 0) return;
      const ax = net.X[e.a], ay = net.Y[e.a], dx = net.X[e.b] - ax, dy = net.Y[e.b] - ay, len = dx * dx + dy * dy;
      for (let s = 0; s < points.length; s++) {
        const [px, py] = points[s];
        if (Math.min(ax, ax + dx) - px > limit || px - Math.max(ax, ax + dx) > limit || Math.min(ay, ay + dy) - py > limit || py - Math.max(ay, ay + dy) > limit) continue;
        const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0, d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
        const had = best[s].get(piece[i]);
        if (d <= limit && (!had || d < had.d)) best[s].set(piece[i], { edge: i, t, d, x: ax + t * dx, y: ay + t * dy });
      }
    });
    let chosen = null, total = Infinity;
    for (const id of best[0].keys()) {
      if (!best.every(m => m.has(id))) continue;
      const sum = best.reduce((n, m) => n + m.get(id).d, 0);
      if (sum < total) { total = sum; chosen = best.map(m => m.get(id)); }
    }
    return chosen;
  }

  /* A small priority queue: the cheapest comes out first. */
  function queue() {
    const items = [];
    return {
      push(key, value) { let i = items.push([key, value]) - 1; while (i > 0) { const up = (i - 1) >> 1; if (items[up][0] <= key) break; items[i] = items[up]; i = up; } items[i] = [key, value]; },
      pop() {
        const top = items[0], last = items.pop();
        if (items.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= items.length) break; if (c + 1 < items.length && items[c + 1][0] < items[c][0]) c++; if (items[c][0] >= last[0]) break; items[i] = items[c]; i = c; } items[i] = last; }
        return top;
      },
      get size() { return items.length; }
    };
  }

  /* The best way from one snapped point to another: { points: [[x, y]], edges: [edge] } with one edge per step. */
  function search(net, mode, from, to) {
    const E = net.edges, first = E[from.edge], last = E[to.edge];
    const cheapest = mode === "car" ? 1 / (CAR.motorway / 3.6) : 0.85;
    const guess = n => Math.hypot(net.X[n] - to.x, net.Y[n] - to.y) * net.perUnit * cheapest;
    let best = Infinity, bestEnd = -1;
    if (from.edge === to.edge) { const c = cost(first, mode, to.t >= from.t) * Math.abs(to.t - from.t); if (c < Infinity) best = c; }
    const reached = new Map(), came = new Map(), open = queue();
    const offer = (n, g, via) => { if (g < (reached.has(n) ? reached.get(n) : Infinity)) { reached.set(n, g); came.set(n, via); open.push(g + guess(n), [n, g]); } };
    offer(first.b, cost(first, mode, true) * (1 - from.t) || 0, null);
    offer(first.a, cost(first, mode, false) * from.t || 0, null);
    const finish = new Map(); // the end edge's two ends, and what the last bit costs from each
    const fa = cost(last, mode, true) * to.t, fb = cost(last, mode, false) * (1 - to.t);
    if (fa < Infinity) finish.set(last.a, fa); else if (to.t === 0) finish.set(last.a, 0);
    if (fb < Infinity) finish.set(last.b, fb); else if (to.t === 1) finish.set(last.b, 0);
    while (open.size) {
      const [f, [n, g]] = open.pop();
      if (f >= best) break;
      if (g > reached.get(n)) continue;
      if (finish.has(n) && g + finish.get(n) < best) { best = g + finish.get(n); bestEnd = n; }
      for (const i of net.links.get(n)) {
        const e = E[i], forward = e.a === n, c = cost(e, mode, forward);
        if (c < Infinity) offer(forward ? e.b : e.a, g + c, [n, i]);
      }
    }
    if (best === Infinity) return null;
    const nodes = [], edges = [];
    for (let n = bestEnd; n >= 0;) { nodes.unshift(n); const via = came.get(n); if (!via) break; edges.unshift(via[1]); n = via[0]; }
    const points = [[from.x, from.y]], steps = [];
    const add = (pt, edge, node) => { points.push(pt); steps.push({ edge, node }); };
    if (nodes.length) {
      add([net.X[nodes[0]], net.Y[nodes[0]]], from.edge, nodes[0]);
      edges.forEach((e, i) => add([net.X[nodes[i + 1]], net.Y[nodes[i + 1]]], e, nodes[i + 1]));
    }
    add([to.x, to.y], to.edge, -1);
    return { points, steps };
  }

  /* ---- where the roads come from ---- */
  function corridor(stops, margin) {
    const tiles = new Map();
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i], km = haversine(a, b) / 1000, pad = Math.max(1.5, km * margin), dLat = pad / 111, dLon = dLat / Math.cos(a[1] * RAD);
      const r = tileRange([Math.min(a[0], b[0]) - dLon, Math.min(a[1], b[1]) - dLat, Math.max(a[0], b[0]) + dLon, Math.max(a[1], b[1]) + dLat], Z);
      if ((r[2] - r[0] + 1) * (r[3] - r[1] + 1) > MAX_ROAD_TILES) return null;
      for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) tiles.set(x + "/" + y, [x, y]);
    }
    return tiles.size > MAX_ROAD_TILES ? null : [...tiles.values()];
  }

  async function sources(stops) {
    const out = [];
    const saved = await Promise.all(stops.map(s => DB.get("tiles", `vt/${Z}/${lon2x(s[0], Z)}/${lat2y(s[1], Z)}`).catch(() => null)));
    if (saved.every(Boolean)) out.push({ type: "area", read: (x, y) => DB.get("tiles", `vt/${Z}/${x}/${y}`).catch(() => null) });
    for (const p of Packs.list()) {
      if (p.maxzoom !== Z || !stops.every(s => s[0] >= p.bbox[0] && s[0] <= p.bbox[2] && s[1] >= p.bbox[1] && s[1] <= p.bbox[3])) continue;
      out.push({ type: "pack", read: (x, y) => Packs.raw(p.id, Z, x, y) });
    }
    return out;
  }

  /* ---- turn-by-turn instructions ---- */
  const bearing = (a, b) => Math.atan2((b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]) / RAD;
  const swing = (from, to) => ((to - from + 540) % 360) - 180; // positive: to the right
  /* The point a given distance along a line from point i, looking forwards (1) or backwards (-1). */
  function reach(coords, i, direction, metres) {
    let at = i, left = metres;
    while (coords[at + direction]) {
      const a = coords[at], b = coords[at + direction], len = haversine(a, b);
      if (len >= left && len > 0) return [a[0] + (b[0] - a[0]) * left / len, a[1] + (b[1] - a[1]) * left / len];
      left -= len; at += direction;
    }
    return coords[at];
  }

  /* How important a way looks, for telling a fork from a side turning. */
  const rank = cls => ({ motorway: 8, trunk: 7, primary: 6, secondary: 5, tertiary: 4, minor: 3, service: 2, track: 2 })[cls] || 1;

  function turnsFor(net, mode, path, coords, names, ll) {
    const cum = [0]; for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    const found = [];
    for (let i = 1; i < coords.length - 1; i++) {
      const step = path.steps[i - 1], next = path.steps[i];
      if (step.node < 0) continue;
      const others = net.links.get(step.node).filter(e => e !== step.edge && e !== next.edge && usable(net.edges[e], mode === "car" ? "car" : "foot"));
      if (!others.length) continue; // not a junction: just a bend
      const here = coords[i], inward = bearing(reach(coords, i, -1, 18), here), turn = swing(inward, bearing(here, reach(coords, i, 1, 18)));
      /* how straight on the other ways out are, and whether any could be mistaken for the way ahead */
      const choices = others.map(e => { const edge = net.edges[e], far = edge.a === step.node ? edge.b : edge.a; return { angle: Math.abs(swing(inward, bearing(here, ll(net.X[far], net.Y[far])))), rank: rank(edge.way.cls) }; });
      const ahead = rank(net.edges[next.edge].way.cls), fork = choices.some(c => c.angle < 35 && c.rank >= ahead);
      const before = names[i - 1], after = names[i], renamed = after && after !== before;
      const size = Math.abs(turn);
      let kind = null;
      if (size >= 45) kind = size >= 150 ? "uturn" : size >= 115 ? "sharp" : "turn";
      else if (size >= 20 && (renamed || choices.some(c => c.angle < size && c.rank >= ahead - 1))) kind = "bear";
      else if (size >= 10 && fork && (renamed || !after)) kind = "keep";
      else if (renamed && before) kind = "continue";
      if (kind) found.push({ along: cum[i], at: i, turn, kind, name: after, same: !!after && after === before });
    }
    /* two junctions a few paces apart are one turn to the walker */
    const turns = [];
    for (const t of found) {
      const last = turns[turns.length - 1];
      if (last && t.along - last.along < 14) {
        const total = swing(bearing(reach(coords, last.at, -1, 18), coords[last.at]), bearing(coords[t.at], reach(coords, t.at, 1, 18)));
        const size = Math.abs(total);
        Object.assign(last, { turn: total, name: t.name, same: last.same && t.same, kind: size >= 150 ? "uturn" : size >= 115 ? "sharp" : size >= 45 ? "turn" : size >= 18 ? "bear" : "continue" });
      } else turns.push(t);
    }
    const kept = turns.filter(t => t.along > 12 && (t.kind !== "continue" || t.name)); // turns right at the start are just setting off
    const side = t => t.turn < 0 ? "left" : "right";
    const out = kept.map(t => {
      const onto = !t.name ? "" : !t.same ? " onto " + t.name : t.kind === "bear" || t.kind === "keep" ? "" : " to stay on " + t.name;
      const text = t.kind === "uturn" ? "Turn back" + onto : t.kind === "sharp" ? `Turn sharp ${side(t)}${onto}` : t.kind === "turn" ? `Turn ${side(t)}${onto}`
        : t.kind === "bear" ? `Bear ${side(t)}${onto}` : t.kind === "keep" ? `Keep ${side(t)}${onto}` : "Continue onto " + t.name;
      const dir = t.kind === "uturn" ? "uturn" : t.kind === "continue" ? "straight" : t.kind === "bear" || t.kind === "keep" ? "slight-" + side(t) : t.kind === "sharp" ? "sharp-" + side(t) : side(t);
      return { along: t.along, dir, text };
    });
    const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][(Math.round(bearing(coords[0], reach(coords, 0, 1, 25)) / 45) + 8) % 8];
    const start = names.find(Boolean);
    out.unshift({ along: 0, dir: "depart", text: `Head ${compass}${start ? " on " + start : ""}` });
    return out;
  }

  /* Names for the stretches of a downloaded map's route: its names are drawn as separate lines. */
  function namer(list, perUnit) {
    const CELL = 128, grid = new Map(), tol = 3 / perUnit;
    for (const { name, pts } of list) for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], s = [ax, ay, bx, by, name];
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++)
        for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) {
          const k = cx * 262144 + cy; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(s);
        }
    }
    return (a, b) => {
      const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
      let found = "", near = tol;
      for (let cx = Math.floor((x - tol) / CELL); cx <= Math.floor((x + tol) / CELL); cx++)
        for (let cy = Math.floor((y - tol) / CELL); cy <= Math.floor((y + tol) / CELL); cy++)
          for (const [ax, ay, bx, by, name] of grid.get(cx * 262144 + cy) || []) {
            const ex = bx - ax, ey = by - ay, len = ex * ex + ey * ey; if (!len) continue;
            if (Math.abs(dx * ex + dy * ey) < 0.9 * Math.hypot(dx, dy) * Math.sqrt(len)) continue; // a crossing road
            const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len)), d = Math.hypot(ax + t * ex - x, ay + t * ey - y);
            if (d <= near) { near = d; found = name; }
          }
      return found;
    };
  }

  async function attempt(source, stops, mode, tiles, progress, stale) {
    source.x0 = Math.min(...tiles.map(t => t[0])) * EXTENT; source.y0 = Math.min(...tiles.map(t => t[1])) * EXTENT;
    const found = { ways: [], names: [] };
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < tiles.length && !stale()) {
        const [x, y] = tiles[next++];
        const buf = await source.read(x, y);
        if (buf && buf.byteLength) try { waysFrom(buf, x, y, source, found); } catch (e) { /* a damaged tile */ }
        if (++done % 20 === 0) progress(`Reading the map… ${Math.round(done / tiles.length * 100)}%`);
      }
    }));
    if (stale() || !found.ways.length) return null;
    progress("Finding the way…"); await new Promise(r => setTimeout(r, 30)); // let the words appear
    const world = EXTENT * 2 ** Z;
    const unit = ll => { const r = ll[1] * RAD; return [(ll[0] + 180) / 360 * world - source.x0, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * world - source.y0]; };
    const ll = (x, y) => [x2lon((x + source.x0) / EXTENT, Z), y2lat((y + source.y0) / EXTENT, Z)];
    const net = build(found.ways, 40075016.686 * Math.cos(stops[0][1] * RAD) / world);
    const snapped = snap(net, mode, stops.map(unit));
    if (!snapped) return null;
    const path = { points: [], steps: [] }, legs = [];
    for (let i = 1; i < snapped.length; i++) {
      const leg = search(net, mode, snapped[i - 1], snapped[i]);
      if (!leg) return null;
      legs.push(path.points.length ? path.points.length - 1 : 0);
      if (path.points.length) leg.points.shift();
      path.points.push(...leg.points); path.steps.push(...leg.steps);
    }
    const coords = path.points.map(p => ll(p[0], p[1]));
    const nameOf = source.type === "area" ? namer(found.names, net.perUnit) : null;
    const names = path.steps.map((s, i) => nameOf ? nameOf(path.points[i], path.points[i + 1]) : net.edges[s.edge].way.name);
    for (let i = 1; i < names.length - 1; i++) if (!names[i] && names[i - 1] === names[i + 1]) names[i] = names[i - 1]; // short unnamed gaps
    const turns = turnsFor(net, mode, path, coords, names, ll);
    let distance = 0, duration = 0;
    path.steps.forEach((s, i) => { const d = haversine(coords[i], coords[i + 1]); distance += d; duration += d / speedFor(net.edges[s.edge].way.cls, mode); });
    legs.slice(1).forEach(i => turns.push({ along: lineLength(coords.slice(0, i + 1)), dir: "stop", text: "You reach a stop on your route" }));
    turns.sort((a, b) => a.along - b.along);
    turns.push({ along: distance, dir: "arrive", text: "Arrive at your destination" });
    return { coords, distance, duration, turns, from: source.type, gaps: snapped.map(s => s.d * net.perUnit) };
  }

  /* stops: [[lon, lat]]; mode: "foot", "bike" or "car". Resolves to a route, or throws a message fit to show. */
  async function route(stops, mode, progress = () => {}, stale = () => false) {
    let list = await sources(stops);
    if (!list.length) throw new Error("There's no map on the phone covering both ends. Download the area, or import a map, while you have internet.");
    if (mode === "car") {
      list = list.filter(s => s.type === "area"); // an imported map doesn't say which streets are one-way
      if (!list.length) throw new Error("Driving directions without internet need a downloaded area. Walking and cycling work with your imported map.");
    }
    let tooFar = false;
    for (const margin of [0.2, 0.55]) {
      const tiles = corridor(stops, margin);
      if (!tiles) { tooFar = true; break; }
      for (const source of list) {
        const result = await attempt(source, stops, mode, tiles, progress, stale);
        if (stale()) return null;
        if (result) return result;
      }
    }
    throw new Error(tooFar ? "That's too far to work out on the phone (about 30 km at most). Add a nearer stop, or connect to the internet."
      : "No way found on the maps on this phone. Part of the route may be outside your downloaded area.");
  }

  return { route };
})();
