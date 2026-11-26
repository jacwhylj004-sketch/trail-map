"use strict";
/* Reads vector map tiles (the Mapbox Vector Tile format), for searching and for directions worked out on the phone. */

function readTile(buf, wanted) { // wanted: the layer names to read. Returns { name: { extent, features: [{ type, props, parts }] } }
  const b = new Uint8Array(buf), view = new DataView(b.buffer, b.byteOffset, b.byteLength), utf8 = new TextDecoder();
  let p = 0;
  const num = () => { let n = 0, scale = 1, c; do { c = b[p++]; n += (c & 127) * scale; scale *= 128; } while (c & 128); return n; };
  const skip = wire => { if (wire === 0) num(); else if (wire === 2) { const n = num(); p += n; } else p += wire === 5 ? 4 : 8; };
  /* calls f(field, wire) for each field before `end`; f reads the value or returns false to have it skipped */
  const fields = (end, f) => { while (p < end) { const key = num(); if (f(key >>> 3, key & 7) === false) skip(key & 7); } };
  const text = () => { const n = num(), s = utf8.decode(b.subarray(p, p + n)); p += n; return s; };

  function value() {
    const end = num() + p; let v = null;
    fields(end, (f, wire) => {
      if (f === 1) v = text();
      else if (f === 2) { v = view.getFloat32(p, true); p += 4; }
      else if (f === 3) { v = view.getFloat64(p, true); p += 8; }
      else if (f === 4 || f === 5) v = num();
      else if (f === 6) { const n = num(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
      else if (f === 7) v = !!num();
      else return false;
    });
    return v;
  }
  function geometry(type) {
    const end = num() + p, parts = []; let x = 0, y = 0, part = null;
    while (p < end) {
      const command = num(), id = command & 7;
      if (id === 7) continue; // close an area
      for (let i = command >>> 3; i > 0; i--) {
        const dx = num(), dy = num();
        x += dx % 2 ? -(dx + 1) / 2 : dx / 2; y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
        if (id === 1) { part = [[x, y]]; parts.push(part); } else if (part) part.push([x, y]);
      }
    }
    return parts;
  }

  const out = {};
  fields(b.length, (f, wire) => {
    if (f !== 3 || wire !== 2) return false;
    const end = num() + p, start = p;
    let name = ""; // the name comes first in practice, but don't rely on it
    fields(end, (g) => { if (g === 1) name = text(); else return false; });
    if (wanted && !wanted.includes(name)) { p = end; return; }
    p = start;
    const keys = [], values = [], raw = []; let extent = 4096;
    fields(end, (g) => {
      if (g === 2) { const n = num(); raw.push([p, p + n]); p += n; }
      else if (g === 3) keys.push(text());
      else if (g === 4) values.push(value());
      else if (g === 5) extent = num();
      else return false;
    });
    const features = raw.map(([from, to]) => {
      p = from; const feature = { type: 0, props: {}, parts: [] }; let tags = [], at = 0;
      fields(to, (g) => {
        if (g === 2) { const stop = num() + p; while (p < stop) tags.push(num()); }
        else if (g === 3) feature.type = num();
        else if (g === 4) { at = p; const n = num(); p += n; }
        else return false;
      });
      for (let i = 0; i + 1 < tags.length; i += 2) feature.props[keys[tags[i]]] = values[tags[i + 1]];
      if (at) { p = at; feature.parts = geometry(feature.type); }
      return feature;
    });
    out[name] = { extent, features };
    p = end;
  });
  return out;
}
