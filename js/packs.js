"use strict";
/* Imported maps: .tmap files made on the PC (a description plus vector tiles), kept on the phone and drawn with the
   colours, patterns and symbols they carry. The app itself holds no map data from them. */

const Packs = (() => {
  const KINDS = { 24582: "gate", 24583: "kissing gate", 24584: "stile", 24585: "bench", 19712: "parking", 11522: "pub", 19968: "toilets", 24576: "information", 24577: "picnic site" };
  let list = [];            // descriptions of the imported maps
  let state = { busy: false, bytes: 0, error: "" };
  let ids = { all: [], barriers: [], points: [] }, images = {}, anchors = null, installed = null;
  const listeners = [];
  const changed = () => listeners.forEach(f => f());
  const native = () => NATIVE && NATIVE.packList ? NATIVE : null;
  const base = id => `pack/${id}/`;

  async function load() {
    const found = [];
    if (native()) {
      for (const p of JSON.parse(native().packList())) {
        try { const r = await fetchTimeout(base(p.id) + "meta.json", {}, 10000); if (r.ok) found.push(Object.assign(r.json(), { id: p.id, bytes: p.bytes })); }
        catch (e) { /* a damaged file: leave it out */ }
      }
    }
    list = found.sort((a, b) => b.created - a.created);
  }

  /* The tile from whichever imported map covers it. Where two overlap, the one containing the tile's middle wins. */
  async function tile(z, x, y, signal) {
    const w = x2lon(x, z), e = x2lon(x + 1, z), n = y2lat(y, z), s = y2lat(y + 1, z), cx = (w + e) / 2, cy = (n + s) / 2;
    const middle = p => cx >= p.bbox[0] && cx <= p.bbox[2] && cy >= p.bbox[1] && cy <= p.bbox[3];
    const touching = list.filter(p => p.bbox[0] < e && p.bbox[2] > w && p.bbox[1] < n && p.bbox[3] > s).sort((a, b) => middle(b) - middle(a));
    for (const p of touching) {
      const r = await fetchTimeout(`${base(p.id)}${z}/${x}/${y}.pbf`, { signal }, 10000);
      if (r.ok) return r.buf;
    }
    return new ArrayBuffer(0);
  }

  /* ---- drawing ---- */
  const rgb = c => `rgb(${c.join(",")})`;
  /* Pictures are enlarged without smoothing, so they stay sharp on the phone's fine screen. */
  function picture(b64, w, h, k = 3) {
    const src = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), out = new Uint8Array(w * k * h * k * 4);
    for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) { const i = (Math.floor(y / k) * w + Math.floor(x / k)) * 4; out.set(src.subarray(i, i + 4), (y * w * k + x) * 4); }
    return [{ width: w * k, height: h * k, data: out }, { pixelRatio: k }];
  }
  /* The main colour of a pattern, for drawing paths plainly when zoomed out. */
  function mainColour(b64) {
    const d = atob(b64), count = new Map();
    for (let i = 0; i < d.length; i += 4) if (d.charCodeAt(i + 3)) { const c = [0, 1, 2].map(k => d.charCodeAt(i + k)).join(","); count.set(c, (count.get(c) || 0) + 1); }
    const best = [...count].sort((a, b) => b[1] - a[1])[0];
    return best ? `rgb(${best[0]})` : "#777";
  }

  function build() {
    const styles = { area: {}, line: {}, point: {} }, sets = { paths: new Set(), boundaries: new Set(), gates: new Set(), contours: new Set() };
    for (const p of [...list].reverse()) { for (const k in styles) Object.assign(styles[k], p.styles[k]); for (const k in sets) (p[k] || []).forEach(v => sets[k].add(v)); }
    const layers = [], barriers = [], points = [];
    images = {};
    const add = (l, kind) => { const layer = Object.assign({ source: "pack" }, kind ? { "source-layer": kind } : {}, l); layers.push(layer); return layer.id; };
    const is = code => ["==", ["get", "t"], code];
    const among = codes => ["in", ["get", "t"], ["literal", codes]];
    const zoomed = w => ["interpolate", ["linear"], ["zoom"], 10, w * 0.28, 12, w * 0.5, 15, w, 18, w * 1.8];
    layers.push({ id: "tt-cover", type: "fill", source: "packcover", minzoom: 10, paint: { "fill-color": "#f6f3e9" } });

    const areas = Object.entries(styles.area).map(([c, s]) => [+c, s]).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    for (const [code, s] of areas) {
      const id = "tt-a" + code;
      if (s.pattern) { images[id] = () => picture(s.pattern, 32, s.rows); add({ id, type: "fill", filter: is(code), paint: { "fill-pattern": id } }, "area"); }
      else {
        add({ id, type: "fill", filter: is(code), paint: { "fill-color": rgb(s.fill) } }, "area");
        if (s.border && s.border.join() !== s.fill.join()) add({ id: id + "-edge", type: "line", filter: is(code), minzoom: 13, paint: { "line-color": rgb(s.border), "line-width": 0.7 } }, "area");
      }
    }

    /* contours underneath, then boundaries and water, then paths, then roads from minor to major */
    const rank = c => sets.contours.has(c) ? 0 : c >= 1 && c <= 7 ? 100 - c : sets.paths.has(c) ? 20 : 10;
    const lines = Object.entries(styles.line).map(([c, s]) => [+c, s]).sort((a, b) => rank(a[0]) - rank(b[0]));
    const join = { "line-join": "round" };
    for (const casing of [true, false]) {
      for (const [code, s] of lines) {
        const id = "tt-l" + code, road = rank(code) > 50, boundary = sets.boundaries.has(code);
        const line = (suffix, paint, extra) => { const lid = add(Object.assign({ id: id + suffix, type: "line", filter: is(code), layout: join, paint }, extra), "line"); if (boundary) barriers.push(lid); };
        const edged = !s.pattern && s.border && s.total > s.width;
        /* all road edges go below all road fills, so junctions join up */
        if (casing) { if (road && edged) line("-edge", { "line-color": rgb(s.border), "line-width": zoomed(s.total) }); continue; }
        if (s.pattern) {
          images[id] = () => picture(s.pattern, 32, s.rows);
          if (sets.paths.has(code)) { // plain, wider dashes further out, so every path stays visible
            line("-far", { "line-color": mainColour(s.pattern), "line-dasharray": [2.5, 1], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.9, 13.5, 2] }, { maxzoom: 13.5 });
            line("", { "line-pattern": id, "line-width": zoomed(s.rows) }, { minzoom: 13.5 });
          } else line("", { "line-pattern": id, "line-width": zoomed(s.rows) });
        } else {
          if (!road && edged) line("-edge", { "line-color": rgb(s.border), "line-width": zoomed(s.total) });
          if (s.width) line("", { "line-color": rgb(s.colour), "line-width": zoomed(s.width) });
        }
      }
    }

    const text = (id, kind, filter, layout, paint, minzoom) => add({ id, type: "symbol", filter, minzoom,
      layout: Object.assign({ "text-field": ["get", "n"], "text-font": ["Noto Sans Regular"], "text-size": 11 }, layout),
      paint: Object.assign({ "text-color": "#222222", "text-halo-color": "#ffffff", "text-halo-width": 1.3 }, paint) }, kind);
    const named = ["has", "n"], contour = among([...sets.contours]);
    const metres = imperial() ? ["to-string", ["round", ["*", ["to-number", ["get", "n"]], 3.28084]]] : ["get", "n"];
    text("tt-contour-names", "line", ["all", named, contour], { "symbol-placement": "line", "text-size": 9.5, "text-field": metres }, { "text-color": "#9a5b1e" }, 14);
    text("tt-line-names", "line", ["all", named, ["!", contour]], { "symbol-placement": "line", "symbol-spacing": 300 }, {}, 12.5);
    text("tt-area-names", "area", named, { "text-font": ["Noto Sans Italic"], "text-size": 10.5 }, { "text-color": "#33503a" }, 15);

    const towns = [0x400, 0xA00, 0xB00], gates = [...sets.gates];
    const pictured = [];
    for (const [c, s] of Object.entries(styles.point)) if (s.w > 4) { pictured.push(+c); images["tt-p" + c] = () => picture(s.icon, s.w, s.h); }
    const icon = ["concat", "tt-p", ["to-string", ["get", "t"]]];
    const size = ["interpolate", ["linear"], ["zoom"], 13, 0.9, 15, 1.2, 18, 1.7];
    const symbols = (id, filter, minzoom, extra) => add({ id, type: "symbol", filter, minzoom, layout: Object.assign({ "icon-image": icon, "icon-size": size }, extra), paint: {} }, "point");
    points.push(symbols("tt-symbols", ["all", among(pictured), ["!", among([...gates, ...towns])]], 13.5, {}));
    const gateLayer = symbols("tt-gates", among(gates), 14, { "icon-allow-overlap": true });
    points.push(gateLayer); barriers.push(gateLayer);
    text("tt-point-names", "point", ["all", named, ["!", among(towns)]], { "text-offset": [0, 1], "text-anchor": "top" }, {}, 15);
    text("tt-towns", "point", ["all", named, among(towns)], { "text-font": ["Noto Sans Bold"], "text-size": ["match", ["get", "t"], 0x400, 15, 12.5] }, {}, 10);
    ids = { all: layers.map(l => l.id), barriers, points };
    return layers;
  }

  /* Adds, shows or removes the imported map's layers to match the settings. Called from applyLayers. */
  function apply(m) {
    const want = SETTINGS.base === "tt" && list.length ? list.map(p => p.id + p.created).join() + SETTINGS.units : "";
    if (installed !== (want || null)) {
      if (installed) {
        ids.all.forEach(id => m.removeLayer(id)); m.removeSource("pack"); m.removeSource("packcover");
        Object.keys(images).forEach(id => { if (m.hasImage(id)) m.removeImage(id); });
        move(m, false);
        ids = { all: [], barriers: [], points: [] };
      }
      installed = want || null;
      if (want) {
        m.addSource("pack", { type: "vector", tiles: ["tm://pack/{z}/{x}/{y}"], minzoom: Math.min(...list.map(p => p.minzoom)), maxzoom: Math.max(...list.map(p => p.maxzoom)), attribution: esc([...new Set(list.map(p => p.source || "Imported map"))].join(", ")) });
        m.addSource("packcover", { type: "geojson", data: { type: "FeatureCollection", features: list.map(p => { const [w, s, e, n] = p.bbox; return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }; }) } });
        const layers = build();
        Object.entries(images).forEach(([id, make]) => { if (!m.hasImage(id)) m.addImage(id, ...make()); });
        layers.forEach(l => m.addLayer(l, "routes-hit"));
        move(m, true);
      }
    }
    if (!installed) return;
    const hidden = new Set(SETTINGS.barriers ? [] : ids.barriers);
    if (SETTINGS.contour === "off") ids.all.filter(id => /^tt-(l3[234](-edge)?|contour-names)$/.test(id)).forEach(id => hidden.add(id));
    ids.all.forEach(id => m.setLayoutProperty(id, "visibility", hidden.has(id) ? "none" : "visible"));
  }
  /* The imported map covers the ordinary one, so hill shading and walking routes are lifted above it (and put back after). */
  function move(m, up) {
    const order = m.getLayersOrder();
    if (up) {
      anchors = ["hillshade", "routes-overview", "routes-casing", "routes-line"].map(id => [id, order.filter(x => !ids.all.includes(x))[order.filter(x => !ids.all.includes(x)).indexOf(id) + 1]]);
      const firstLine = ids.all.find(id => id.startsWith("tt-l"));
      if (firstLine) m.moveLayer("hillshade", firstLine);
      ["routes-overview", "routes-casing", "routes-line"].forEach(id => m.moveLayer(id, "routes-hit"));
    } else if (anchors) {
      [...anchors].reverse().forEach(([id, before]) => m.moveLayer(id, before));
      anchors = null;
    }
  }

  /* ---- importing and deleting ---- */
  window.onPack = async msg => {
    if (msg.bytes !== undefined) state = { busy: true, bytes: msg.bytes, error: "" };
    else if (msg.cancelled) state = { busy: false, bytes: 0, error: "" };
    else if (msg.error) { state = { busy: false, bytes: 0, error: msg.error }; toast(msg.error); }
    else if (msg.done) { state = { busy: false, bytes: 0, error: "" }; await load(); toast(`${msg.done} imported. Tap View to see it.`); }
    changed();
  };

  function panel() {
    if (!native()) return '<p class="muted small">Importing map files needs the newest Trail Map app file. Ask Claude for it.</p>';
    const items = list.map(p => `<div class="item" style="flex-direction:column;align-items:stretch"><div><strong>${esc(p.name)}</strong><small>${esc(fmtBytes(p.bytes) + " · made " + new Date(p.created).toLocaleDateString("en-GB"))}</small></div>
      <div class="row end"><button class="btn" data-act="pack-show" data-id="${esc(p.id)}">View</button><button class="btn danger" data-act="pack-delete" data-id="${esc(p.id)}">Delete</button></div></div>`).join("");
    return `<p class="small">Add a map file (.tmap) made on your PC. Copy it to the phone first. It works with no internet.</p>${items || '<p class="muted small">No maps imported yet.</p>'}
      ${state.busy ? `<p class="muted small">Importing… ${esc(fmtBytes(state.bytes))} copied.</p>` : ""}${state.error ? `<p class="warn small">${esc(state.error)}</p>` : ""}
      <button class="btn primary" data-act="pack-import" ${state.busy ? "disabled" : ""}>Import a map file</button>`;
  }

  return {
    load, tile, apply, panel,
    any: () => list.length > 0, names: () => list.map(p => p.name).join(", "), get: id => list.find(p => p.id === id),
    pick: () => native() && native().packImport(),
    async remove(id) { native().packDelete(id); await load(); changed(); },
    tapLayers: () => ids.points,
    kind: t => KINDS[t] || "",
    onChange: f => listeners.push(f)
  };
})();
