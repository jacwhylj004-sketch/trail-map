"use strict";
/* Searching the maps on the phone, with or without internet.
   - Downloaded areas: every name in them is listed once, and the list is kept on the phone.
   - Imported maps: these can cover a whole country, so towns and villages are listed once for the whole map, and
     everything else (pubs, car parks, paths, streets…) is read from the part around where you are looking. */

const Finder = (() => {
  const NEAR_KM = 9;               // how far round to read an imported map in detail
  const regions = new Map();       // region id -> { stamp, entries }
  const packPlaces = new Map();    // pack key -> entries
  const near = new Map();          // pack key + tile -> entries
  let working = null, status = "", wanted = null;
  const listeners = [];
  const changed = () => listeners.forEach(f => f());

  /* An entry: [name, kind, lon, lat, rank, searchable words]. Lower ranks come first. */
  const plain = s => s.normalize("NFD").replace(/[̀-ͯ'’]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const entry = (name, kind, ll, rank) => [name, kind, +ll[0].toFixed(5), +ll[1].toFixed(5), rank, " " + plain(name + " " + kind)];
  const at = (x, y, z, extent, p) => [x2lon(x + p[0] / extent, z), y2lat(y + p[1] / extent, z)];
  const inside = (p, extent) => p[0] >= 0 && p[0] < extent && p[1] >= 0 && p[1] < extent;
  const words = s => String(s || "").replace(/_/g, " ");

  /* ---- reading one tile of a downloaded map (OpenStreetMap) ---- */
  const PLACE_RANK = { city: 0, town: 1, village: 2, suburb: 3, hamlet: 3, neighbourhood: 4, isolated_dwelling: 4 };
  const UNNAMED = ["toilets", "drinking_water", "parking", "shelter", "camp_site", "picnic_site", "viewpoint"];
  const NAMES = { camp_site: "campsite", drinking_water: "drinking water", fuel: "petrol station", parking: "car park", picnic_site: "picnic site" };
  function fromOsm(buf, x, y) {
    const out = [], tile = readTile(buf, ["place", "poi", "mountain_peak", "water_name", "transportation_name", "park"]);
    for (const [layer, { extent, features }] of Object.entries(tile)) {
      for (const f of features) {
        const p = f.props, part = f.parts[0]; if (!part) continue;
        const point = part[Math.floor(part.length / 2)];
        if (!inside(point, extent)) continue; // the next tile has it
        let name = p["name:latin"] || p.name || p.name_en, kind, rank;
        if (layer === "place") { kind = words(p.class); rank = PLACE_RANK[p.class] ?? 4; }
        else if (layer === "poi") {
          const what = p.subclass || p.class;
          if (!what || (!name && !UNNAMED.includes(what))) continue;
          kind = NAMES[what] || words(what); rank = 6;
          if (!name) { name = kind[0].toUpperCase() + kind.slice(1); rank = 7; }
        } else if (layer === "mountain_peak") { kind = words(p.class || "peak"); rank = 4; }
        else if (layer === "water_name") { kind = "water"; rank = 5; }
        else if (layer === "park") { kind = "park or protected area"; rank = 5; }
        else { name = name || p.ref; kind = p.class === "path" ? "path" : "road"; rank = kind === "road" ? 5.5 : 8; }
        if (name) out.push(entry(String(name), kind, at(x, y, VT_MAX, extent, point), rank));
      }
    }
    return out;
  }

  /* ---- reading one tile of an imported (Garmin) map ---- */
  const CODES = { 0x2a07: "fast food", 0x2a0e: "cafe", 0x2b00: "hotel", 0x2b01: "hostel", 0x2b02: "bed and breakfast", 0x2b05: "campsite", 0x2b08: "historic site", 0x2b09: "historic site", 0x2b0a: "historic site", 0x2f17: "place", 0x2c0b: "church", 0x2d02: "pub",
    0x2f08: "station", 0x4613: "bar", 0x4800: "campsite", 0x4d00: "car park", 0x4e00: "toilets", 0x5000: "drinking water", 0x6006: "gate", 0x6007: "kissing gate", 0x6008: "stile" };
  const FAMILIES = { 0x2a: "restaurant", 0x2b: "place to stay", 0x2c: "attraction", 0x2d: "leisure", 0x2e: "shop", 0x2f: "service" };
  const TOWNS = { 0x400: ["town or village", 1], 0xa00: ["town or village", 2], 0xb00: ["town or village", 2] };
  const clean = s => String(s || "").replace(/^\s*(\[[^\]]*\]|\([^)]*\))\s*/, "").trim();
  function fromPack(buf, z, x, y, townsOnly) {
    const out = [], tile = readTile(buf, townsOnly ? ["point"] : ["point", "line", "area"]);
    for (const [layer, { extent, features }] of Object.entries(tile)) {
      for (const f of features) {
        const code = f.props.t, name = clean(f.props.n);
        const town = layer === "point" && TOWNS[code];
        if (townsOnly && !town) continue;
        for (const part of f.parts) {
          const point = part[Math.floor(part.length / 2)];
          if (!inside(point, extent)) continue;
          let kind, rank, label = name;
          if (town) { [kind, rank] = town; }
          else if (layer === "point") {
            if (code >= 0x6000 && code <= 0x6008) continue; // gates: thousands of them, all the same
            kind = CODES[code] || FAMILIES[code >> 8] || "place"; rank = 6;
            if (!label && [0x4d00, 0x4e00, 0x5000].includes(code)) { label = kind[0].toUpperCase() + kind.slice(1); rank = 7; }
          } else if (layer === "line") {
            if (code >= 0x20 && code <= 0x22) continue; // contour heights
            kind = code <= 7 ? "road" : code === 0x18 || code === 0x1f ? "river" : "path or track"; rank = code <= 7 ? 5.5 : 8;
          } else { kind = "area"; rank = 7; }
          if (label && !/^\d+$/.test(label)) out.push(entry(label, kind, at(x, y, z, extent, point), rank));
        }
      }
    }
    return out;
  }

  /* Run the work for every item, a few at a time. */
  async function pool(items, each, size = 6) {
    let next = 0;
    await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await each(items[next++]); }));
  }
  const tilesOf = (bbox, z) => { const r = tileRange(bbox, z), out = []; for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) out.push([x, y]); return out; };
  /* The same name listed twice close together (a long street crosses many tiles) is kept once. */
  function once(list) {
    const seen = new Set();
    return list.filter(e => { const k = `${e[5]}|${Math.round(e[2] * 150)}|${Math.round(e[3] * 250)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  async function loadRegions() {
    const list = await Offline.list().catch(() => []);
    for (const id of regions.keys()) if (!list.some(r => r.id === id)) regions.delete(id);
    for (const r of list) {
      const stamp = (r.updated || 0) + ":" + r.bytes;
      if (regions.has(r.id) && regions.get(r.id).stamp === stamp) continue;
      let saved = await DB.get("cells", "idx:" + r.id).catch(() => null);
      if (!saved || saved.stamp !== stamp) {
        const tiles = tilesOf(r.bbox, VT_MAX), entries = []; let done = 0;
        await pool(tiles, async ([x, y]) => {
          const buf = await DB.get("tiles", `vt/${VT_MAX}/${x}/${y}`).catch(() => null);
          if (buf && buf.byteLength) try { entries.push(...fromOsm(buf, x, y)); } catch (e) { /* a damaged tile */ }
          if (++done % 50 === 0) { status = `Listing the places in ${r.name}… ${Math.round(done / tiles.length * 100)}%`; changed(); }
        });
        saved = { stamp, entries: once(entries) };
        if (r.complete) await DB.put("cells", saved, "idx:" + r.id).catch(() => {});
      }
      regions.set(r.id, saved); changed();
    }
  }

  const packKey = p => p.id + ":" + p.created;
  async function readPack(p, z, x, y, townsOnly) {
    const buf = await Packs.raw(p.id, z, x, y);
    try { return buf ? fromPack(buf, z, x, y, townsOnly) : []; } catch (e) { return []; }
  }

  /* The part of the imported maps around the places being looked at. */
  async function loadNear(centres) {
    for (const p of Packs.list()) {
      const todo = new Map();
      for (const c of centres) {
        const dLat = NEAR_KM / 111, dLon = dLat / Math.cos(c[1] * RAD);
        const box = [Math.max(p.bbox[0], c[0] - dLon), Math.max(p.bbox[1], c[1] - dLat), Math.min(p.bbox[2], c[0] + dLon), Math.min(p.bbox[3], c[1] + dLat)];
        if (box[0] >= box[2] || box[1] >= box[3]) continue;
        const cx = lon2x(c[0], p.maxzoom), cy = lat2y(c[1], p.maxzoom);
        tilesOf(box, p.maxzoom).sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))
          .forEach(([x, y]) => { const k = `${packKey(p)}:${x}/${y}`; if (!near.has(k)) todo.set(k, [x, y]); });
      }
      const keys = [...todo]; let done = 0;
      await pool(keys, async ([k, [x, y]]) => {
        near.set(k, await readPack(p, p.maxzoom, x, y, false));
        if (++done % 25 === 0) { status = `Looking around in ${p.name}… ${Math.round(done / keys.length * 100)}%`; changed(); }
      });
      while (near.size > 1500) near.delete(near.keys().next().value);
      if (keys.length) changed();
    }
  }

  /* Every town and village in the imported maps: slow the first time (a minute or so for the British Isles), then kept. */
  async function loadTowns(keptOnly) {
    for (const p of Packs.list()) {
      const key = packKey(p);
      if (packPlaces.has(key)) continue;
      let saved = await DB.get("cells", "idx:pack:" + key).catch(() => null);
      if (!saved) {
        if (keptOnly) continue;
        const z = Math.min(11, p.maxzoom), all = new Map();
        for (const box of p.cover || [p.bbox]) for (const t of tilesOf(box, z)) all.set(t.join("/"), t);
        /* nearest first, and searchable as they come in */
        const here = wanted[0], cx = lon2x(here[0], z), cy = lat2y(here[1], z);
        const tiles = [...all.values()].sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy)), entries = []; let done = 0;
        packPlaces.set(key, entries);
        await pool(tiles, async ([x, y]) => {
          entries.push(...await readPack(p, z, x, y, true));
          if (++done % 40 === 0) { status = `Listing towns and villages in ${p.name}, once only… ${Math.round(done / tiles.length * 100)}%`; changed(); }
        });
        saved = { entries: once(entries) };
        await DB.put("cells", saved, "idx:pack:" + key).catch(() => {});
      }
      packPlaces.set(key, saved.entries); changed();
    }
  }

  /* Reads whatever isn't ready yet, in the background. onChange is called as more becomes searchable. */
  function prepare(centres) {
    wanted = centres;
    if (working) return working;
    working = (async () => {
      try {
        let done = null;
        while (wanted !== done) { // you may have moved the map while it was reading
          done = wanted;
          await loadRegions();
          await loadTowns(true); // lists already made are ready at once
          await loadNear(done);
          if (wanted === done) await loadTowns();
        }
      } catch (e) { console.debug("search:", e && e.message); }
      finally { working = null; status = ""; changed(); }
    })();
    return working;
  }

  /* The matches among what has been read, best first. Every word typed must begin a word of the name or kind. */
  function match(text, here, limit = 25) {
    const asked = plain(text).split(" ").filter(Boolean); if (!asked.length) return [];
    const needles = asked.map(w => " " + (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)), whole = " " + asked.join(" ");
    const found = [];
    const look = list => { for (const e of list) if (needles.every(n => e[5].includes(n))) found.push(e); };
    regions.forEach(r => look(r.entries)); near.forEach(look); packPlaces.forEach(look);
    const scored = found.map(e => {
      const km = haversine(here, [e[2], e[3]]) / 1000, name = " " + plain(e[0]);
      /* an exact name, then names starting with what was typed; then bigger places; nearer is better throughout */
      const score = (name === whole ? 0 : name.startsWith(whole) ? 4 : 7) + e[4] * 0.6 + Math.log2(1 + km) * (e[4] <= 2 ? 0.7 : 1.5);
      return { e, km, score };
    }).sort((a, b) => a.score - b.score);
    const out = [];
    for (const s of scored) {
      const ll = [s.e[2], s.e[3]];
      /* long things (streets, paths, towns) are listed once; other places once for each spot */
      const long = s.e[4] <= 2 || ["road", "path", "path or track", "river"].includes(s.e[1]), name = s.e[0].toLowerCase();
      if (out.some(o => o.name.toLowerCase() === name && o.kind === s.e[1] && haversine(o.ll, ll) < (long ? 3000 : 250))) continue;
      out.push({ name: s.e[0], kind: s.e[1], ll, away: s.km * 1000 });
      if (out.length >= limit) break;
    }
    return out;
  }

  return {
    prepare, match, status: () => status, onChange: f => listeners.push(f),
    covered: () => Packs.any() || regions.size > 0,
    forget(id) { regions.delete(id); }
  };
})();
