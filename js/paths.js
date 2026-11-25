"use strict";
/* Every footpath and track from further out. The online map only holds them all in its most detailed tiles (zoom 14), so
   for zoom 12 and 13 the app takes the paths out of those and joins them into one larger tile. Works offline too. */

const walkCache = new Map();

/* ---- the few parts of the vector tile format needed here ---- */
function pbf(buf) {
  let p = 0;
  const num = () => { let n = 0, m = 1, c; do { c = buf[p++]; n += (c & 127) * m; m *= 128; } while (c & 128); return n; };
  return {
    more: () => p < buf.length, num,
    next() {
      const key = num(), field = key >>> 3, wire = key & 7;
      if (wire === 0) return [field, num()];
      if (wire === 2) { const n = num(); p += n; return [field, buf.subarray(p - n, p)]; }
      p += wire === 5 ? 4 : 8; return [field, null];
    }
  };
}
const pbfNumbers = b => { const r = pbf(b), out = []; while (r.more()) out.push(r.num()); return out; };
const utf8In = new TextDecoder(), utf8Out = new TextEncoder();

/* The paths and tracks in a tile: [{ cls, sub, lines: [[[x, y], ...]] }], in the tile's own 0..extent units. */
function pathsIn(data) {
  const out = [], tile = pbf(new Uint8Array(data));
  while (tile.more()) {
    const [tf, layer] = tile.next(); if (tf !== 3) continue;
    const r = pbf(layer), keys = [], values = [], features = []; let name = "", extent = 4096;
    while (r.more()) {
      const [f, v] = r.next();
      if (f === 1) name = utf8In.decode(v);
      else if (f === 2) features.push(v);
      else if (f === 3) keys.push(utf8In.decode(v));
      else if (f === 4) { const x = pbf(v).next(); values.push(x[0] === 1 ? utf8In.decode(x[1]) : x[1]); }
      else if (f === 5) extent = v;
    }
    if (name !== "transportation") continue;
    for (const raw of features) {
      const fr = pbf(raw); let tags = [], type = 0, geom = null;
      while (fr.more()) { const [f, v] = fr.next(); if (f === 2) tags = pbfNumbers(v); else if (f === 3) type = v; else if (f === 4) geom = v; }
      if (type !== 2 || !geom) continue;
      const props = {}; for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      if (props.class !== "path" && props.class !== "track") continue;
      const g = pbfNumbers(geom), lines = []; let x = 0, y = 0, line = null;
      for (let i = 0; i < g.length;) {
        const cmd = g[i] & 7; let n = g[i++] >>> 3;
        if (cmd === 7) continue;
        while (n--) {
          x += (g[i] >>> 1) ^ -(g[i] & 1); y += (g[i + 1] >>> 1) ^ -(g[i + 1] & 1); i += 2;
          if (cmd === 1) { line = []; lines.push(line); }
          line.push([x * 4096 / extent, y * 4096 / extent]);
        }
      }
      out.push({ cls: props.class, sub: props.subclass || "", lines });
    }
  }
  return out;
}

function pbfWriter() {
  const bytes = [];
  const num = (n, to = bytes) => { while (n > 127) { to.push((n % 128) | 128); n = Math.floor(n / 128); } to.push(n); };
  return {
    bytes, num,
    int(field, v) { num(field * 8); num(v); },
    data(field, d) { num(field * 8 + 2); num(d.length); for (let i = 0; i < d.length; i++) bytes.push(d[i]); }
  };
}
function pathTile(features) {
  const keys = ["class", "subclass"], values = new Map(), layer = pbfWriter();
  const value = v => { if (!values.has(v)) values.set(v, values.size); return values.get(v); };
  const zig = v => v < 0 ? -v * 2 - 1 : v * 2;
  layer.int(15, 2); layer.data(1, utf8Out.encode("transportation"));
  for (const f of features) {
    const geom = pbfWriter(); let cx = 0, cy = 0;
    for (const line of f.lines) {
      if (line.length < 2) continue;
      geom.num(9);
      line.forEach(([x, y], i) => { if (i === 1) geom.num(2 + (line.length - 1) * 8); geom.num(zig(x - cx)); geom.num(zig(y - cy)); cx = x; cy = y; });
    }
    if (!geom.bytes.length) continue;
    const tags = pbfWriter(); tags.num(0); tags.num(value(f.cls)); if (f.sub) { tags.num(1); tags.num(value(f.sub)); }
    const feature = pbfWriter(); feature.data(2, tags.bytes); feature.int(3, 2); feature.data(4, geom.bytes);
    layer.data(2, feature.bytes);
  }
  keys.forEach(k => layer.data(3, utf8Out.encode(k)));
  for (const v of values.keys()) { const w = pbfWriter(); w.data(1, utf8Out.encode(v)); layer.data(4, w.bytes); }
  layer.int(5, 4096);
  const tile = pbfWriter(); tile.data(3, layer.bytes);
  return new Uint8Array(tile.bytes).buffer;
}

async function composeWalk(z, x, y, signal) {
  const n = 2 ** (VT_MAX - z), jobs = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) jobs.push([i, j]);
  const found = []; let failed = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [i, j] = jobs[next++];
      try {
        for (const f of pathsIn(await getTile("vt", VT_MAX, x * n + i, y * n + j, signal))) {
          // move into the larger tile, dropping points that land on top of each other
          f.lines = f.lines.map(line => line.map(([px, py]) => [Math.round((px + i * 4096) / n), Math.round((py + j * 4096) / n)]).filter((p, k, a) => !k || p[0] !== a[k - 1][0] || p[1] !== a[k - 1][1]));
          found.push(f);
        }
      } catch (e) { if (signal && signal.aborted) throw e; failed++; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed === jobs.length) throw new Error("No map data here");
  return { data: pathTile(found), whole: !failed };
}

async function walkTile(z, x, y, signal) {
  if (z >= VT_MAX) return getTile("vt", z, x, y, signal);
  const k = `${z}/${x}/${y}`;
  if (walkCache.has(k)) return walkCache.get(k).slice(0);
  const made = await composeWalk(z, x, y, signal);
  if (made.whole) { walkCache.set(k, made.data); if (walkCache.size > 60) walkCache.delete(walkCache.keys().next().value); }
  return made.data.slice(0);
}
