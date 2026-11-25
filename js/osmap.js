"use strict";
/* "OS style": a paper-map look in the manner of an Ordnance Survey leisure map, drawn on the phone from OpenStreetMap
   and the height data. It uses no Ordnance Survey data, and works inside downloaded areas with no internet.
   Orange contours, green woods with tree symbols, coloured roads, green dashed paths, blue 1 km grid squares. */

const OsMap = (() => {
  const font = ["Noto Sans Regular"], bold = ["Noto Sans Bold"], italic = ["Noto Sans Italic"];
  const BLUE = "#0090d4";
  const name = ["coalesce", ["get", "name:latin"], ["get", "name"], ""];
  const zoomed = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];
  const classIs = (...c) => ["match", ["get", "class"], c, true, false];
  const subIs = (...c) => ["match", ["get", "subclass"], c, true, false];
  const area = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
  const line = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
  const layer = (id, type, sourceLayer, rest) => Object.assign({ id, type, source: "openmaptiles", "source-layer": sourceLayer }, rest);
  const halo = (color, extra) => Object.assign({ "text-color": color, "text-halo-color": "#ffffff", "text-halo-width": 1.4 }, extra);

  /* Land and water: these sit underneath the hill shading and contour lines. */
  function areas() {
    const land = (id, cls, color, pattern) => [
      layer("os-" + id, "fill", "landcover", { filter: classIs(cls), paint: { "fill-color": color, "fill-antialias": false } }),
      ...(pattern ? [layer(`os-${id}-symbols`, "fill", "landcover", { minzoom: 12, filter: classIs(cls), paint: { "fill-pattern": pattern } })] : [])
    ];
    return [
      ...land("wood", "wood", "#d3ebc5", "os-trees"),
      ...land("sand", "sand", "#fbdfc0", "os-dots"),
      ...land("rock", "rock", "#f1efec", "os-crags"),
      ...land("wetland", "wetland", "#eef7f6", "os-marsh"),
      ...land("ice", "ice", "#e8f7fd"),
      layer("os-water", "fill", "water", { paint: { "fill-color": "#c6ebfb" } }),
      layer("os-water-edge", "line", "water", { paint: { "line-color": BLUE, "line-width": 0.8 } }),
      layer("os-stream", "line", "waterway", { paint: { "line-color": BLUE, "line-width": zoomed(10, 0.6, 14, 1.3, 18, 4) } }),
      layer("os-park", "line", "park", { filter: area, layout: { "line-join": "round" }, paint: { "line-color": "#9b6fb5", "line-opacity": 0.3, "line-width": zoomed(8, 3, 14, 9) } })
    ];
  }

  /* Buildings, railways, roads and paths. */
  function lines() {
    const road = (id, filter, color, width, casing = "#2b2b2b", minzoom = 5) => {
      const w = k => zoomed(8, width[0] + k, 12, width[1] + k, 16, width[2] + k * 1.5);
      const base = { minzoom, filter: ["all", line, filter], layout: { "line-join": "round", "line-cap": "round" } };
      return [layer(`os-${id}-casing`, "line", "transportation", Object.assign({ paint: { "line-color": casing, "line-width": w(1.4) } }, base)),
        layer("os-" + id, "line", "transportation", Object.assign({ paint: { "line-color": color, "line-width": w(0) } }, base))];
    };
    const roads = [
      road("service", classIs("service"), "#ffffff", [0.3, 0.8, 5], "#555555", 13),
      road("minor", classIs("minor"), "#ffffff", [0.4, 1.6, 8], "#333333", 11),
      road("tertiary", classIs("tertiary"), "#ffe45c", [0.8, 2.6, 10], "#333333", 9),
      road("secondary", classIs("secondary"), "#f7a823", [1.2, 3, 11]),
      road("primary", classIs("primary"), "#e5157d", [1.6, 3.4, 12], "#5a0f35"),
      road("trunk", classIs("trunk"), "#e5157d", [1.8, 3.6, 13], "#5a0f35"),
      road("motorway", classIs("motorway"), "#1f9ad6", [2, 4, 14], "#0b3f63")
    ];
    /* every outline first, so that roads join cleanly */
    const ordered = [...roads.map(r => r[0]), ...roads.map(r => r[1])];
    const path = (id, filter, color, dash, width, minzoom = 12) => Object.assign(layer("os-" + id, "line", "transportation",
      { minzoom, filter: ["all", line, filter], paint: { "line-color": color, "line-dasharray": dash, "line-width": zoomed(12, width, 18, width * 2.6) } }), { source: "walk" }); // "walk" has every path from zoom 12 (see paths.js)
    return [
      layer("os-building", "fill", "building", { minzoom: 13, paint: { "fill-color": "#f6c79b", "fill-outline-color": "#222222" } }),
      path("track", classIs("track"), "#222222", [5, 2], 1.2),
      path("path", ["all", classIs("path"), ["!", subIs("bridleway")]], "#148a3c", [2.5, 1.6], 1.5),
      path("bridleway", ["all", classIs("path"), subIs("bridleway")], "#148a3c", [6, 2], 1.7),
      ...ordered,
      layer("os-rail", "line", "transportation", { filter: ["all", line, classIs("rail", "transit")], paint: { "line-color": "#111111", "line-width": zoomed(9, 1.2, 16, 5) } }),
      layer("os-rail-dash", "line", "transportation", { minzoom: 12, filter: ["all", line, classIs("rail", "transit")], paint: { "line-color": "#ffffff", "line-dasharray": [3, 3], "line-width": zoomed(12, 0.5, 16, 2.4) } }),
      { id: "os-grid", type: "line", source: "osgrid", paint: { "line-color": BLUE, "line-opacity": 0.75, "line-width": 1 } }
    ];
  }

  /* Names, road numbers and the blue visitor symbols. */
  function labels() {
    const text = (id, sourceLayer, rest, layout, paint) => layer("os-" + id, "symbol", sourceLayer,
      Object.assign({}, rest, { layout: Object.assign({ "text-field": name, "text-font": font }, layout), paint }));
    const abbreviation = ["match", ["get", "subclass"], "school", "Sch", "hospital", "Hospl", "post_office", "PO", "toilets", "PC", "pub", "PH", "drinking_water", "W", "museum", "M", "place_of_worship", "+", "college", "Coll", ""];
    const blue = ["match", ["get", "subclass"], ["toilets", "pub", "museum", "drinking_water"], true, false];
    return [
      { id: "os-grid-numbers", type: "symbol", source: "osgrid", layout: { "symbol-placement": "line", "symbol-spacing": 260, "text-field": ["get", "label"], "text-font": bold, "text-size": 15, "text-rotation-alignment": "viewport", "text-padding": 1 }, paint: halo(BLUE) },
      text("stream-name", "waterway", { minzoom: 13 }, { "symbol-placement": "line", "text-font": italic, "text-size": 11 }, halo("#0074ad")),
      text("water-name", "water_name", {}, { "text-font": italic, "text-size": 12 }, halo("#0074ad")),
      text("road-name", "transportation_name", { minzoom: 14, filter: ["!", ["has", "ref"]] }, { "symbol-placement": "line", "text-size": 10 }, halo("#222222")),
      text("road-number", "transportation_name", { minzoom: 10, filter: ["all", ["has", "ref"], classIs("motorway", "trunk", "primary", "secondary")] },
        { "symbol-placement": "line", "text-field": ["get", "ref"], "text-font": bold, "text-size": 12, "text-rotation-alignment": "viewport" }, halo(["match", ["get", "class"], "motorway", "#0b5f94", "secondary", "#9a5b00", "#b00d5f"], { "text-halo-width": 2 })),
      text("poi", "poi", { minzoom: 13, filter: subIs("school", "hospital", "post_office", "toilets", "pub", "drinking_water", "museum", "place_of_worship", "college") },
        { "text-field": abbreviation, "text-font": bold, "text-size": 11 }, halo(["case", blue, "#0074ad", "#111111"])),
      layer("os-symbols", "symbol", "poi", { minzoom: 12, filter: subIs("parking", "information", "camp_site", "viewpoint", "picnic_site", "shelter", "alpine_hut"),
        layout: { "icon-padding": 12, "icon-image": ["match", ["get", "subclass"], "parking", "os-parking", "information", "os-info", "camp_site", "os-camp", "viewpoint", "os-view", "picnic_site", "os-picnic", "os-shelter"] } }),
      text("peaks", "mountain_peak", { minzoom: 9 }, { "icon-image": "os-spot", "text-field": spotLabel(), "text-font": bold, "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.5], "text-optional": true }, halo("#111111")),
      text("village", "place", { minzoom: 10, filter: classIs("village", "hamlet", "suburb", "neighbourhood", "isolated_dwelling") }, { "text-font": bold, "text-size": ["match", ["get", "class"], "village", 14, 12] }, halo("#111111")),
      text("town", "place", { filter: classIs("city", "town") }, { "text-font": bold, "text-transform": "uppercase", "text-size": zoomed(6, 11, 14, 19) }, halo("#111111", { "text-halo-width": 2 }))
    ];
  }

  const spotLabel = () => ["concat", name, ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", imperial() ? "ele_ft" : "ele"]]], ""]];

  /* Green diamonds along named walking routes, like long-distance paths on a paper map. */
  const routeMarks = () => ({ id: "os-route-marks", type: "symbol", source: "routes", minzoom: 10,
    layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "os-diamond", "icon-allow-overlap": true, "icon-ignore-placement": true } });

  /* Symbols are drawn here rather than downloaded. */
  function addImages(m) {
    const add = (id, w, h, draw) => {
      const c = document.createElement("canvas"); c.width = w * 2; c.height = h * 2;
      const g = c.getContext("2d", { willReadFrequently: true }); g.scale(2, 2); draw(g);
      if (!m.hasImage(id)) m.addImage(id, g.getImageData(0, 0, c.width, c.height), { pixelRatio: 2 });
    };
    const stroke = (g, color, width, points) => { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); };
    const tree = (g, x, y, pointed) => {
      g.strokeStyle = "#3d8b4a"; g.lineWidth = 0.9;
      if (pointed) { stroke(g, "#3d8b4a", 0.9, [[x - 3, y + 1], [x, y - 5], [x + 3, y + 1], [x - 3, y + 1]]); }
      else { g.beginPath(); g.arc(x, y - 2, 2.8, 0, 7); g.stroke(); }
      stroke(g, "#3d8b4a", 0.9, [[x, y + 1], [x, y + 4]]);
    };
    add("os-trees", 32, 32, g => { tree(g, 8, 9, true); tree(g, 24, 24, false); });
    add("os-dots", 16, 16, g => { g.fillStyle = "#9a8466"; [[2, 3], [10, 1], [6, 9], [13, 11], [3, 14]].forEach(([x, y]) => g.fillRect(x, y, 1.2, 1.2)); });
    add("os-crags", 24, 24, g => { stroke(g, "#6e6a66", 0.9, [[2, 8], [5, 3], [7, 8], [10, 5]]); stroke(g, "#6e6a66", 0.9, [[13, 20], [16, 14], [19, 20], [22, 16]]); });
    add("os-marsh", 28, 28, g => { [[4, 9], [18, 23]].forEach(([x, y]) => { stroke(g, "#2b8fa8", 0.8, [[x, y], [x + 8, y]]); [2, 4, 6].forEach(d => stroke(g, "#2b8fa8", 0.8, [[x + d, y], [x + d + (d - 4) / 2, y - 4]])); }); });
    add("os-diamond", 14, 10, g => { g.fillStyle = "#118a3a"; g.beginPath(); g.moveTo(1, 5); g.lineTo(7, 1); g.lineTo(13, 5); g.lineTo(7, 9); g.fill(); });
    add("os-spot", 8, 8, g => { g.fillStyle = "#111"; g.beginPath(); g.moveTo(4, 1); g.lineTo(7, 7); g.lineTo(1, 7); g.fill(); });
    const badge = (id, draw) => add(id, 18, 18, g => { g.fillStyle = BLUE; g.fillRect(0, 0, 18, 18); g.strokeStyle = g.fillStyle = "#fff"; g.lineWidth = 1.6; g.textAlign = "center"; g.textBaseline = "middle"; g.font = "bold 13px sans-serif"; draw(g); });
    badge("os-parking", g => g.fillText("P", 9, 10));
    badge("os-info", g => g.fillText("i", 9, 10));
    badge("os-camp", g => stroke(g, "#fff", 1.6, [[2, 14], [9, 4], [16, 14], [2, 14]]));
    badge("os-view", g => { [[9, 3], [3, 7], [15, 7], [5, 14], [13, 14]].forEach(([x, y]) => stroke(g, "#fff", 1.4, [[9, 14], [x, y]])); });
    badge("os-picnic", g => { stroke(g, "#fff", 1.6, [[3, 7], [15, 7]]); stroke(g, "#fff", 1.4, [[7, 7], [4, 14]]); stroke(g, "#fff", 1.4, [[11, 7], [14, 14]]); });
    badge("os-shelter", g => stroke(g, "#fff", 1.6, [[3, 15], [3, 8], [9, 3], [15, 8], [15, 15]]));
  }

  /* The blue grid: 1 km squares close up, 10 km squares further out. Numbers match the grid reference. */
  function grid(m) {
    const empty = { type: "FeatureCollection", features: [] };
    const zoom = m.getZoom();
    if (SETTINGS.base !== "os" || zoom < 8) return empty;
    const b = m.getBounds(), c = m.getCenter();
    if (!OSGB.ref(c.lat, c.lng)) return empty; // the grid covers Great Britain only
    const west = Math.max(b.getWest(), -8.7), east = Math.min(b.getEast(), 1.8), south = Math.max(b.getSouth(), 49.8), north = Math.min(b.getNorth(), 60.9);
    const corners = [[south, west], [south, east], [north, west], [north, east], [c.lat, c.lng]].map(([la, lo]) => OSGB.toEN(la, lo));
    const step = zoom >= 11.5 ? 1000 : 10000;
    const range = i => { const v = corners.map(p => p[i]); return [Math.floor(Math.min(...v) / step) * step, Math.ceil(Math.max(...v) / step) * step]; };
    const [e0, e1] = range(0), [n0, n1] = range(1);
    if ((e1 - e0) / step > 80 || (n1 - n0) / step > 80) return empty;
    const features = [];
    const add = (value, points) => features.push(lineFeature(points.map(([e, n]) => OSGB.fromEN(e, n)), { label: String(Math.floor(value / 1000) % 100).padStart(2, "0") }));
    const along = (from, to) => [0, 0.25, 0.5, 0.75, 1].map(f => from + (to - from) * f);
    for (let e = e0; e <= e1; e += step) add(e, along(n0, n1).map(n => [e, n]));
    for (let n = n0; n <= n1; n += step) add(n, along(e0, e1).map(e => [e, n]));
    return { type: "FeatureCollection", features };
  }

  return { areas, lines, labels, routeMarks, addImages, spotLabel, updateGrid: m => setData("osgrid", grid(m)) };
})();
