"use strict";
/* The map itself (style and layers) and your GPS position. */

const OVERPASS_CREDIT = "© OpenStreetMap contributors";
let map = null;
const EMPTY = { type: "FeatureCollection", features: [] };
const setData = (id, data) => { const s = map && map.getSource(id); if (s) s.setData(data); };
const lineFeature = (coords, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });

/* Layer ids that belong to each switch in the Layers panel. */
const GROUPS = { satellite: [], height: [], shade: [], slope: [], contours: [], paths: [], routes: [], os: [], osRoutes: [], standard: [], barriers: [] };
const SHADING = { light: 0.2, medium: 0.35, strong: 0.7 };
const RELIEF = { gentle: 1, normal: 1.5, steep: 2.5 };
/* Colours for the height map: metres above sea level, colour. */
const HEIGHTS = [[0, "#8fcf9a"], [100, "#bfdc8c"], [200, "#e6e48e"], [350, "#f3cf79"], [500, "#e0a763"], [700, "#bd7f55"], [900, "#9c6b5c"], [1100, "#a89a98"], [1500, "#e4e0df"], [3000, "#ffffff"]];

async function buildStyle() {
  const style = (await fetchTimeout("vendor/style.json", {}, 10000)).json();
  delete style.sources.ne2_shaded;
  style.sources.openmaptiles = { type: "vector", tiles: ["tm://vt/{z}/{x}/{y}"], maxzoom: VT_MAX, attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://openmaptiles.org">© OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>' };
  style.sprite = new URL("vendor/sprites/ofm", location.href).href;
  style.glyphs = "tm://glyph/{fontstack}/{range}";
  Object.assign(style.sources, {
    hills: { type: "raster-dem", tiles: [demSource.sharedDemProtocolUrl], encoding: "terrarium", tileSize: 256, maxzoom: DEM_MAX, attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a>' },
    hills3d: { type: "raster-dem", tiles: [demSource.sharedDemProtocolUrl], encoding: "terrarium", tileSize: 256, maxzoom: DEM_MAX },
    contours: contourSource(),
    satellite: { type: "raster", tiles: ["tm://sat/{z}/{x}/{y}"], tileSize: 256, maxzoom: SAT_MAX, attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2020</a> by EOX (contains modified Copernicus data)' },
    overview: { type: "raster", tiles: ["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 17, attribution: '<a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>' },
    slope: { type: "raster", tiles: ["tm://slope/{z}/{x}/{y}"], tileSize: 256, maxzoom: DEM_MAX },
    walk: { type: "vector", tiles: ["tm://walk/{z}/{x}/{y}"], minzoom: 12, maxzoom: VT_MAX },
    barriers: { type: "geojson", data: EMPTY, attribution: OVERPASS_CREDIT },
    osgrid: { type: "geojson", data: EMPTY },
    routes: { type: "geojson", data: EMPTY, attribution: OVERPASS_CREDIT },
    plan: { type: "geojson", data: EMPTY }, hazard: { type: "geojson", data: EMPTY }, track: { type: "geojson", data: EMPTY }, back: { type: "geojson", data: EMPTY }, accuracy: { type: "geojson", data: EMPTY }, saved: { type: "geojson", data: EMPTY }
  });

  const layers = style.layers.filter(l => l.id !== "natural_earth" && l.id !== "building-3d");
  const before = (test, add) => { const i = layers.findIndex(test); layers.splice(i < 0 ? layers.length : i, 0, ...add); };
  const group = (name, add) => { GROUPS[name] = add.map(l => l.id); return add; };
  const font = ["Noto Sans Regular"], bold = ["Noto Sans Bold"];

  before(l => l.id === "waterway_tunnel", [
    ...group("height", [{ id: "height-tint", type: "color-relief", source: "hills", layout: { visibility: "none" }, paint: { "color-relief-opacity": 0.8, "color-relief-color": ["interpolate", ["linear"], ["elevation"], ...HEIGHTS.flat()] } }]),
    ...group("shade", [{ id: "hillshade", type: "hillshade", source: "hills", paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#473b24" } }]),
    ...group("slope", [{ id: "slope-tint", type: "raster", source: "slope", minzoom: 9.5, layout: { visibility: "none" }, paint: { "raster-opacity": 0.85 } }])
  ]);
  before(l => l["source-layer"] === "transportation" || l["source-layer"] === "aeroway", [
    ...group("satellite", [{ id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } }]),
    ...group("contours", [
      { id: "contour-lines", type: "line", source: "contours", "source-layer": "contours", minzoom: 11, paint: { "line-color": "#a0703c", "line-opacity": 0.55, "line-width": ["match", ["get", "level"], 1, 1.3, 0.6] } },
      { id: "contour-labels", type: "symbol", source: "contours", "source-layer": "contours", minzoom: 12, filter: [">", ["get", "level"], 0], layout: { "symbol-placement": "line", "text-field": ["concat", ["number-format", ["get", "ele"], {}], ""], "text-font": font, "text-size": 10 }, paint: { "text-color": "#7a5228", "text-halo-color": "#fff", "text-halo-width": 1.2 } }
    ])
  ]);

  /* Footpaths, bridleways and tracks drawn boldly so walkers can see them. */
  const walk = ["match", ["get", "subclass"], ["path", "footway", "bridleway", "steps", "pedestrian", "cycleway"], true, false];
  const path = ["all", ["==", ["get", "class"], "path"], walk, ["!=", ["geometry-type"], "Polygon"]];
  const dash = (id, filter, color, pattern, minzoom = 12) => [
    { id: id + "-casing", type: "line", source: "walk", "source-layer": "transportation", minzoom, filter, layout: { "line-join": "round" }, paint: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.4, 18, 7] } },
    { id, type: "line", source: "walk", "source-layer": "transportation", minzoom, filter, layout: { "line-join": "round" }, paint: { "line-color": color, "line-dasharray": pattern, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.3, 18, 4] } }
  ];
  before(l => l.type === "symbol" && !l.id.startsWith("road_one_way") && !l.id.startsWith("contour"), [
    ...group("barriers", Barriers.layers()),
    ...group("paths", [
      ...dash("walk-track", ["==", ["get", "class"], "track"], "#8a5a24", [4, 1.5]),
      ...dash("walk-path", ["all", path, ["!=", ["get", "subclass"], "bridleway"]], "#b3261e", [2, 1.4]),
      ...dash("walk-bridleway", ["all", path, ["==", ["get", "subclass"], "bridleway"]], "#1e7a36", [3, 1.4])
    ]),
    { id: "routes-overview", type: "raster", source: "overview", layout: { visibility: "none" }, paint: { "raster-opacity": 0.85 } },
    ...group("routes", [
      { id: "routes-casing", type: "line", source: "routes", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-opacity": 0.32, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 14] } },
      { id: "routes-line", type: "line", source: "routes", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 2.4] } }
    ])
  ]);

  const text = (color) => ({ "text-color": color, "text-halo-color": "#ffffff", "text-halo-width": 1.6 });
  layers.push(
    { id: "routes-hit", type: "line", source: "routes", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 18 } },
    { id: "routes-highlight", type: "line", source: "routes", filter: ["==", ["get", "id"], -1], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 7 } },
    { id: "routes-label", type: "symbol", source: "routes", minzoom: 11.5, layout: { "symbol-placement": "line", "symbol-spacing": 350, "text-field": ["get", "label"], "text-font": bold, "text-size": 12, "text-offset": [0, -0.9] }, paint: text(["get", "color"]) },
    { id: "peaks", type: "symbol", source: "openmaptiles", "source-layer": "mountain_peak", minzoom: 9, filter: ["has", "name"], layout: { "icon-image": "mountain", "text-field": peakLabel(), "text-font": bold, "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.7], "text-optional": true }, paint: text("#5b3a1a") },
    { id: "hiker-poi", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 12, filter: ["match", ["get", "subclass"], ["drinking_water", "toilets", "shelter", "camp_site", "alpine_hut", "wilderness_hut", "parking", "viewpoint", "picnic_site", "information", "pub", "mountain_rescue"], true, false],
      layout: { "icon-image": ["match", ["get", "subclass"], "drinking_water", "drinking_water", "toilets", "toilets", ["shelter", "alpine_hut", "wilderness_hut"], "shelter", "camp_site", "campsite", "parking", "parking", "picnic_site", "picnic_site", "information", "information", "pub", "beer", "circle"], "text-field": ["step", ["zoom"], "", 14, ["coalesce", ["get", "name:latin"], ["get", "name"], ""]], "text-font": font, "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.8], "text-optional": true }, paint: text("#3a4a5a") },
    { id: "accuracy", type: "fill", source: "accuracy", paint: { "fill-color": "#1a73e8", "fill-opacity": 0.12 } },
    { id: "plan-casing", type: "line", source: "plan", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 8 } },
    { id: "plan-line", type: "line", source: "plan", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#0b57d0", "line-width": 5 } },
    { id: "hazard-line", type: "line", source: "hazard", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["match", ["get", "level"], "danger", "#d03b3b", "#f29d00"], "line-width": 5 } },
    { id: "hazard-point", type: "circle", source: "hazard", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 7, "circle-color": ["match", ["get", "level"], "danger", "#d03b3b", "#f29d00"], "circle-stroke-color": "#1b1b21", "circle-stroke-width": 2 } },
    { id: "track-casing", type: "line", source: "track", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 8 } },
    { id: "track-line", type: "line", source: "track", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ff5a00", "line-width": 4.5 } },
    { id: "back-casing", type: "line", source: "back", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 9 } },
    { id: "back-line", type: "line", source: "back", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-join": "round" }, paint: { "line-color": "#8e24aa", "line-width": 5, "line-dasharray": [2, 0.8] } },
    { id: "back-end", type: "circle", source: "back", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 9, "circle-color": "#8e24aa", "circle-stroke-color": "#ffffff", "circle-stroke-width": 4 } },
    { id: "saved-dot", type: "circle", source: "saved", paint: { "circle-radius": 7, "circle-color": "#f9ab00", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } },
    { id: "saved-label", type: "symbol", source: "saved", minzoom: 10, layout: { "text-field": ["get", "name"], "text-font": bold, "text-size": 12, "text-anchor": "top", "text-offset": [0, 0.8], "text-optional": true }, paint: text("#6b4a00") }
  );
  /* The OS style swaps the ordinary map drawing for its own layers (see osmap.js). */
  GROUPS.standard = [...style.layers.filter(l => l.source === "openmaptiles").map(l => l.id).filter(id => layers.some(l => l.id === id)), "peaks", "hiker-poi"];
  const insert = (anchor, add, after = false) => { const i = layers.findIndex(l => l.id === anchor); layers.splice(i + (after ? 1 : 0), 0, ...add); return add.map(l => l.id); };
  GROUPS.os = [...insert("height-tint", OsMap.areas()), ...insert("contour-labels", OsMap.lines(), true), ...insert("routes-hit", OsMap.labels())];
  GROUPS.osRoutes = insert("routes-hit", [OsMap.routeMarks()]);
  style.layers = layers;
  return style;
}
function contourSource() {
  const ft = imperial();
  /* [thin line, bold line] spacing from zoom 11, 12 and 14 */
  const spacing = ft ? { wide: [[500, 2500], [200, 1000], [100, 500]], normal: [[200, 1000], [100, 500], [50, 250]], close: [[100, 500], [50, 250], [20, 100]] }
    : { wide: [[100, 500], [50, 250], [25, 100]], normal: [[50, 250], [20, 100], [10, 50]], close: [[20, 100], [10, 50], [5, 25]] };
  const [a, b, c] = spacing[SETTINGS.contour] || spacing.normal;
  return { type: "vector", maxzoom: 15, tiles: [demSource.contourProtocolUrl({ multiplier: ft ? 3.28084 : 1, overzoom: 1, elevationKey: "ele", levelKey: "level", contourLayer: "contours", thresholds: { 11: a, 12: b, 14: c } })] };
}
function peakLabel() {
  const name = ["coalesce", ["get", "name:latin"], ["get", "name"], ""];
  return ["case", ["has", "ele"], ["concat", name, "\n", ["to-string", imperial() ? ["get", "ele_ft"] : ["get", "ele"]], imperial() ? " ft" : " m"], name];
}
function applyUnits() {
  map.getSource("contours").setTiles(contourSource().tiles);
  map.setLayoutProperty("peaks", "text-field", peakLabel());
  map.setLayoutProperty("os-peaks", "text-field", OsMap.spotLabel());
  scale.setUnit(imperial() ? "imperial" : "metric");
}
function applyLayers() {
  if (SETTINGS.base === "tt" && !Packs.any()) SETTINGS.base = "map"; // the imported map was deleted
  const tt = SETTINGS.base === "tt", os = SETTINGS.base === "os";
  const show = { os, osRoutes: os && SETTINGS.routes, standard: !os, satellite: SETTINGS.base === "satellite", height: SETTINGS.base === "height", slope: SETTINGS.base === "slope",
    shade: SETTINGS.shading !== "off" && SETTINGS.base !== "satellite", contours: SETTINGS.contour !== "off", paths: SETTINGS.paths && !os && !tt, routes: SETTINGS.routes && !os,
    barriers: SETTINGS.barriers && !tt }; // an imported map draws its own paths, gates and boundaries
  map.setPaintProperty("hillshade", "hillshade-exaggeration", (SHADING[SETTINGS.shading] || 0.35) * (os ? 0.4 : 1)); // a paper map is only lightly shaded
  map.setPaintProperty("background", "background-color", os ? "#fffefb" : "#f8f4f0");
  map.setPaintProperty("contour-lines", "line-color", os ? "#e8833a" : "#a0703c");
  map.setPaintProperty("contour-lines", "line-opacity", os ? 0.85 : 0.55);
  map.setPaintProperty("contour-labels", "text-color", os ? "#c25e12" : "#7a5228");
  OsMap.updateGrid(map);
  for (const [name, ids] of Object.entries(GROUPS)) ids.forEach(id => map.setLayoutProperty(id, "visibility", show[name] ? "visible" : "none"));
  ["routes-hit", "routes-highlight", "routes-label"].forEach(id => map.setLayoutProperty(id, "visibility", SETTINGS.routes ? "visible" : "none"));
  map.setLayoutProperty("building", "visibility", show.satellite || os ? "none" : "visible"); // after the groups: satellite hides buildings too
  if (tt) ["peaks", "hiker-poi"].forEach(id => map.setLayoutProperty(id, "visibility", "none"));
  Packs.apply(map);
  const relief = RELIEF[SETTINGS.relief3d];
  map.setTerrain(relief ? { source: "hills3d", exaggeration: relief } : null);
  if (!relief && map.getPitch() > 0) map.easeTo({ pitch: 0 });
  if (relief && map.getPitch() < 20) map.easeTo({ pitch: 55 });
}

let scale = null;
async function createMap() {
  const view = loadJSON("tm-view", { center: [-3.2116, 54.4542], zoom: 11 });
  map = new maplibregl.Map({ container: "map", style: await buildStyle(), center: view.center, zoom: view.zoom, maxZoom: 19, maxPitch: 70, attributionControl: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  scale = new maplibregl.ScaleControl({ maxWidth: 110, unit: imperial() ? "imperial" : "metric" });
  map.addControl(scale, "bottom-left");
  map.on("moveend", () => saveJSON("tm-view", { center: map.getCenter().toArray(), zoom: map.getZoom() }));
  map.on("error", e => console.debug("map:", e && e.error && e.error.message)); // missing tiles when offline are expected
  await new Promise(res => map.once("style.load", res));
  OsMap.addImages(map);
  Barriers.addImages(map);
  map.on("moveend", () => OsMap.updateGrid(map));
  const fold = () => { const a = $(".maplibregl-ctrl-attrib"); if (a) a.classList.remove("maplibregl-compact-show"); }; fold(); map.once("idle", fold); setTimeout(fold, 4000);
  applyLayers();
  return map;
}

/* ---- GPS ---- */
const GPS = (() => {
  let watch = null, marker = null, el = null, follow = "off", heading = null, wanted = true, first = true, staleTimer = null;
  const state = { pos: null, error: "" };
  const listeners = [];
  const changed = () => listeners.forEach(f => f());

  function circle(lon, lat, r) {
    const pts = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * 2 * Math.PI; pts.push([lon + r * Math.cos(a) / (111320 * Math.cos(lat * RAD)), lat + r * Math.sin(a) / 110540]); }
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } };
  }
  function draw() {
    if (!map || !state.pos) return;
    const p = state.pos;
    if (!marker) { el = document.createElement("div"); el.className = "me"; el.innerHTML = "<b></b><i></i>"; marker = new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat(p.ll).addTo(map); }
    marker.setLngLat(p.ll);
    const h = heading != null ? heading : p.course;
    el.classList.toggle("has-heading", h != null); marker.setRotation(h || 0);
    el.classList.remove("stale");
    setData("accuracy", p.accuracy > 8 ? circle(p.ll[0], p.ll[1], p.accuracy) : EMPTY);
  }
  function recentre(animate = true) {
    if (!state.pos || follow === "off") return;
    const o = { center: state.pos.ll, duration: animate ? 500 : 0 };
    const h = heading != null ? heading : state.pos.course;
    if (follow === "heading" && h != null) o.bearing = h;
    if (first) { o.zoom = Math.max(map.getZoom(), 15); first = false; }
    map.easeTo(o, { gps: true });
  }
  function onPos(g) {
    const c = g.coords;
    state.pos = { ll: [c.longitude, c.latitude], accuracy: c.accuracy, altitude: c.altitude, speed: c.speed, course: c.speed > 0.7 && c.heading != null && !isNaN(c.heading) ? c.heading : null, time: g.timestamp };
    state.error = "";
    clearTimeout(staleTimer); staleTimer = setTimeout(() => el && el.classList.add("stale"), 30000);
    draw(); recentre(); changed();
  }
  function onError(e) {
    state.error = e.code === 1 ? "Location permission is off. Allow it in the phone's app settings." : e.code === 2 ? "Can't get a position. Check that Location is switched on." : "Still looking for GPS satellites…";
    if (e.code === 1) { stop(); follow = "off"; }
    changed();
  }
  function start() {
    wanted = true;
    if (watch != null) return;
    if (!navigator.geolocation) { state.error = "This device has no location service."; changed(); return; }
    watch = navigator.geolocation.watchPosition(onPos, onError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }
  function stop() { if (watch != null) navigator.geolocation.clearWatch(watch); watch = null; }

  /* Compass: which way the top of the phone points. */
  let lastDraw = 0;
  window.addEventListener("deviceorientationabsolute", e => {
    if (e.alpha == null) return;
    const h = (360 - e.alpha + ((screen.orientation && screen.orientation.angle) || 0)) % 360;
    const now = Date.now(); if (now - lastDraw < 150) return;
    if (heading != null && Math.abs(((h - heading + 540) % 360) - 180) < 3) return;
    lastDraw = now; heading = h; draw(); if (follow === "heading") recentre();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else if (wanted) start(); }); // save battery when not on screen

  return {
    state, start, onChange: f => listeners.push(f), draw,
    heading: () => heading,
    follow: () => follow,
    setFollow(f) { follow = f; if (f !== "off") { start(); recentre(); } changed(); },
    cycle() {
      if (state.error && !state.pos) { stop(); start(); }
      if (!state.pos) first = true;
      this.setFollow(follow === "off" ? "follow" : follow === "follow" ? "heading" : "follow");
      if (follow === "follow") map.easeTo({ bearing: 0, duration: 400 });
    }
  };
})();
