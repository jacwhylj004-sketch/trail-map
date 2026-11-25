"use strict";
/* Screens: the bottom bar, the slide-up panel, Settings (with Offline maps) and the download box. */

const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  layers: svg('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  locate: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  heading: svg('<path d="M12 3 5 21l7-4 7 4z" fill="currentColor"/>'),
  north: svg('<path d="M12 2 8 12h8z" fill="#d93025" stroke="none"/><path d="M12 22l4-10H8z" fill="currentColor" stroke="none"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'), minus: svg('<path d="M5 12h14"/>'),
  map: svg('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  walk: svg('<circle cx="13" cy="4" r="1.8"/><path d="m9 21 3-6-1-5 3-2 2 4 3 1M11 10l-3 2-1 3M12 15l3 3 1 3"/>'),
  directions: svg('<path d="M12 2 22 12 12 22 2 12z"/><path d="M9 15v-3a1 1 0 0 1 1-1h5M13 8l3 3-3 3"/>'),
  star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>')
};
ICON.back = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>');
ICON.record = svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5" fill="#e5342b" stroke="none"/>');
const PIN = '<svg viewBox="0 0 30 38" aria-hidden="true"><path d="M15 1C7 1 1.5 7 1.5 14.2 1.5 24 15 37 15 37s13.500-13 13.500-22.8C28.500 7 23 1 15 1z" fill="currentColor" stroke="#fff" stroke-width="2"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg>';

/* ---- little pop-ups ---- */
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }
let dialogDone = null;
function dialog({ title, text = "", input = null, yes = "OK" }) {
  if (dialogDone) dialogDone(null);
  $("#dialog-title").textContent = title; $("#dialog-text").textContent = text; $("#dialog-text").hidden = !text;
  const field = $("#dialog-input"); field.hidden = input == null; field.value = input || "";
  $("#dialog-yes").textContent = yes; $("#dialog").hidden = false;
  if (input != null) { field.focus(); field.select(); }
  return new Promise(res => { dialogDone = v => { dialogDone = null; $("#dialog").hidden = true; res(v); }; });
}
$("#dialog-yes").addEventListener("click", () => dialogDone && dialogDone($("#dialog-input").hidden ? true : $("#dialog-input").value.trim() || null));
$("#dialog-no").addEventListener("click", () => dialogDone && dialogDone(null));
$("#dialog-input").addEventListener("keydown", e => { if (e.key === "Enter") $("#dialog-yes").click(); });

/* ---- screens ---- */
const UI = { tab: "map", sheet: null, data: null };
let pin = null;
const dropPin = ll => { removePin(); const el = document.createElement("div"); el.className = "pin"; el.innerHTML = PIN; pin = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(ll).addTo(map); };
function removePin() { if (pin) pin.remove(); pin = null; }

function nav() {
  $("#nav").innerHTML = [["map", "Map", ICON.map], ["routes", "Routes", ICON.walk], ["directions", "Directions", ICON.directions], ["saved", "Saved", ICON.star], ["settings", "Settings", ICON.gear]]
    .map(([id, name, icon]) => `<button class="tab" data-act="tab" data-v="${id}" ${UI.tab === id ? 'aria-current="page"' : ""}><span class="ind">${icon}${id === "settings" && Update.available() ? '<i class="dot" title="Update ready"></i>' : ""}</span>${name}</button>`).join("");
}
function openSheet(name, data) {
  if (UI.sheet === "card" && name !== "card") { removePin(); }
  if (UI.sheet === "route" && name !== "route") Routes.select(null);
  closeArea();
  UI.sheet = name; UI.data = data === undefined ? null : data;
  $("#page").hidden = true; $("#sheet").hidden = false; $("#sheet-body").scrollTop = 0;
  renderSheet(); floating();
}
function closeSheet() {
  if (UI.sheet === "card") removePin();
  if (UI.sheet === "route") Routes.select(null);
  Graphs.clear();
  UI.sheet = null; UI.data = null; $("#sheet").hidden = true; $("#search-x").hidden = !$("#q").value; floating();
}
function goTab(tab) {
  UI.tab = tab; nav(); closeArea();
  if (tab === "settings") { closeSheet(); $("#page").hidden = false; renderSettings(); return; }
  $("#page").hidden = true;
  if (tab === "map") closeSheet(); else openSheet(tab);
}
/* Hide the round buttons and GPS box when a panel covers them. */
function floating() {
  const covered = !!UI.sheet || !$("#area").hidden;
  $("#fabs").hidden = !$("#area").hidden || (!!UI.sheet && $("#sheet").offsetHeight > innerHeight * 0.6);
  $("#fabs").style.bottom = UI.sheet && innerHeight > 500 ? `calc(var(--nav-h) + var(--safe-b) + ${$("#sheet").offsetHeight + 10}px)` : "";
  const room = !UI.sheet || $("#sheet").offsetHeight < innerHeight * 0.4;
  ["#fab-in", "#fab-out", "#fab-rec"].forEach(s => { $(s).hidden = covered; });
  $("#fab-layers").hidden = !room;
  renderGPS();
}

const stat = (label, value) => `<div class="stat"><b>${esc(value)}</b><span>${label}</span></div>`;

function renderSheet() {
  if (!UI.sheet) return;
  const body = $("#sheet-body"), title = t => { $("#sheet-title").textContent = t; };
  $("#sheet").classList.toggle("tall", ["search", "saved", "route"].includes(UI.sheet));
  Graphs.clear(); // the marker belongs to the graphs being redrawn
  const view = SHEETS[UI.sheet];
  const [t, html] = view(UI.data);
  title(t); body.innerHTML = html;
}

/* Map style and terrain choices, shown both in the Layers panel and in Settings. */
function terrainControls() {
  const seg = (key, label, options) => `<h3>${label}</h3><div class="seg" role="group" aria-label="${label}">${options.map(([v, l]) => `<button data-act="terrain" data-k="${key}" data-v="${v}" aria-pressed="${SETTINGS[key] === v}">${l}</button>`).join("")}</div>`;
  const key = items => `<div class="legend">${items.map(([c, l]) => `<span style="--c:${c}">${l}</span>`).join("")}</div>`;
  const about = {
    map: "",
    os: '<p class="muted small">A paper-map look like an Ordnance Survey map, with blue grid squares. It is drawn from OpenStreetMap, not official OS mapping: green dashes are paths people have mapped, not confirmed rights of way. Works offline in downloaded areas.</p>',
    height: key(HEIGHTS.slice(0, 8).map(([m, c]) => [c, fmtHeight(m) + "+"])),
    slope: key(SLOPES.map(s => [`rgb(${s[2]})`, s[1]])) + '<p class="muted small">Zoom in to see steepness. It is estimated from height data about 25 m apart, so crags and short steep drops can be missed.</p>',
    satellite: '<p class="muted small">Satellite pictures need internet and are not saved in offline maps.</p>'
  };
  const styles = [["map", "Outdoor"], ["os", "OS style"], ...(Packs.any() ? [["tt", "Imported"]] : []), ["height", "Height"], ["slope", "Steepness"], ["satellite", "Satellite"]];
  if (SETTINGS.base === "tt") about.tt = `<p class="muted small">Your imported map: ${esc(Packs.names())}. It works with no internet. Outside its area you see the ordinary map.</p>`;
  return seg("base", "Map style", styles).replace('class="seg"', 'class="seg wrap"') + about[SETTINGS.base] +
    seg("contour", "Contour lines", [["off", "Off"], ["wide", "Wide"], ["normal", "Normal"], ["close", "Close"]]) +
    (SETTINGS.base === "satellite" ? "" : seg("shading", "Hill shading", [["off", "Off"], ["light", "Light"], ["medium", "Medium"], ["strong", "Strong"]])) +
    seg("relief3d", "3D hills", [["off", "Off"], ["gentle", "Gentle"], ["normal", "Normal"], ["steep", "Steep"]]);
}

/* How often a recording asks for your position: shown when recording and in Settings. */
const GPS_MODES = [["accurate", "Accurate", "A position every 2 seconds. The best line, and the most battery."],
  ["balanced", "Balanced", "A position every 5 seconds. Cuts corners slightly to save some battery."],
  ["long", "Long walk", "A position every 15 seconds. A rougher line and distance, to save more battery."]];
function gpsControls() {
  if (!Rec.hasModes()) return '<p class="muted small">GPS modes need the newest Trail Map app file. Ask Claude for it.</p>';
  const chosen = GPS_MODES.find(m => m[0] === SETTINGS.gps) || GPS_MODES[0];
  return `<h3>GPS while recording</h3><div class="seg" role="group" aria-label="GPS while recording">${GPS_MODES.map(([v, l]) => `<button data-act="gps-mode" data-v="${v}" aria-pressed="${chosen[0] === v}">${l}</button>`).join("")}</div><p class="muted small">${chosen[2]}</p>`;
}

const SHEETS = {
  layers() {
    const sw = (k, label) => `<label class="switch"><input type="checkbox" data-set="${k}" ${SETTINGS[k] ? "checked" : ""}> <span>${label}</span></label>`;
    return ["Map layers", `${terrainControls()}
      <div>${sw("routes", "Named walking and hiking routes")}${SETTINGS.base === "tt" ? "" : sw("paths", "Highlight footpaths and tracks")}${sw("barriers", "Gates, stiles, walls, fences and hedges")}</div>
      <p class="muted small">Footpaths show from further out than gates and boundaries. Zoom in for those.</p>
      <div class="legend">${Object.values(Routes.NETWORKS).map(n => `<span style="--c:${n[1]}">${n[0]} route</span>`).join("")}<span style="--c:#b3261e">Footpath</span><span style="--c:#1e7a36">Bridleway</span><span style="--c:#8a5a24">Track</span><span style="--c:#555555">Wall</span><span style="--c:#8a8436">Fence</span><span style="--c:#1f8a3a">Hedge</span></div>`];
  },
  routes() {
    const list = SETTINGS.routes ? Routes.inView() : [];
    const msg = !SETTINGS.routes ? '<p>Walking routes are switched off.</p><button class="btn primary" data-act="routes-on">Show walking routes</button>'
      : Routes.status() ? `<p class="muted small">${esc(Routes.status())}</p>` : list.length ? "" : '<p class="muted">No named routes in this view. Footpaths are still shown on the map as dashed lines.</p>';
    return [list.length ? `${list.length} routes in view` : "Walking routes", msg + list.map(r => `<button class="item" data-act="route" data-id="${r.id}"><span class="swatch" style="background:${Routes.NETWORKS[r.network][1]}"></span><span class="grow">${esc(r.name)}<small>${esc([r.ref, Routes.NETWORKS[r.network][0], r.distance ? tagDistance(r.distance) : ""].filter(Boolean).join(" · "))}</small></span></button>`).join("")];
  },
  route(r) {
    const web = /^https?:\/\//i.test(r.web) ? `<a href="${esc(r.web)}" target="_blank" rel="noopener">Route website</a>` : "";
    return [r.name, `<div class="stats">${stat("Type", Routes.NETWORKS[r.network][0])}${stat("Number", r.ref || "–")}${stat("Full length", r.distance ? tagDistance(r.distance) : "–")}</div>
      ${r.from || r.to ? `<p>${esc(r.from || "?")} to ${esc(r.to || "?")}</p>` : ""}${r.desc ? `<p class="small">${esc(r.desc)}</p>` : ""}${r.operator ? `<p class="muted small">Looked after by ${esc(r.operator)}</p>` : ""}${web}
      <div class="row"><button class="btn primary" data-act="route-go">Get me to this route</button><button class="btn" data-act="route-fit">Show on map</button></div>
      <p class="muted small">The part of the route loaded on your phone is highlighted. Move along it to load more.</p>`];
  },
  card(c) {
    const grid = OSGB.ref(c.ll[1], c.ll[0]), pos = GPS.state.pos;
    return [c.name, `${c.detail ? `<p class="muted">${esc(c.detail)}</p>` : ""}
      <div class="stats">${stat("Height", c.ele === undefined ? "…" : fmtHeight(c.ele))}${stat("From you (straight)", pos ? fmtDist(haversine(pos.ll, c.ll)) : "–")}${stat("Lat, lon", c.ll[1].toFixed(5) + ", " + c.ll[0].toFixed(5))}</div>
      ${grid ? `<p>OS grid ref <strong>${grid}</strong></p>` : ""}
      <div class="row"><button class="btn primary" data-act="card-go">Directions</button>${c.savedId ? '<button class="btn" data-act="place-rename">Rename</button><button class="btn danger" data-act="place-delete">Delete</button>' : '<button class="btn" data-act="card-save">Save place</button>'}<button class="btn" data-act="card-share">Share</button></div>`];
  },
  where() {
    const p = GPS.state.pos;
    if (!p) return ["Where am I?", `<p>${esc(GPS.state.error || "Looking for GPS satellites. This is quickest outdoors with a clear view of the sky.")}</p><button class="btn primary" data-act="gps-retry">Try again</button>`];
    const grid = OSGB.ref(p.ll[1], p.ll[0]), h = GPS.heading();
    return ["Where am I?", `${grid ? `<div class="stat"><b style="font-size:1.5rem">${grid}</b><span>OS grid reference</span></div>` : ""}
      <div class="stats">${stat("Latitude", p.ll[1].toFixed(5))}${stat("Longitude", p.ll[0].toFixed(5))}${stat("Accuracy", "± " + fmtHeight(p.accuracy))}${stat("GPS altitude", fmtHeight(p.altitude))}${stat("Speed", fmtSpeed(p.speed))}${stat("Facing", h == null ? "–" : Math.round(h) + "° " + ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(h / 45) % 8])}</div>
      <div class="row"><button class="btn primary" data-act="me-share">Share my location</button><button class="btn" data-act="me-save">Save this spot</button></div>
      <p class="muted small">In an emergency in the UK call 999, ask for Police then Mountain Rescue, and read out your grid reference.</p>`];
  },
  directions() {
    const s = Plan.state, r = s.result;
    const stops = s.stops.map((p, i) => `<div class="item"><span class="stop-mark">${String.fromCharCode(65 + (i % 26))}</span><span class="grow">${esc(p.name)}</span><button class="icon-btn" data-act="stop-remove" data-i="${i}" aria-label="Remove stop">${ICON.close}</button></div>`).join("");
    let out = s.measure ? "" : `<div class="seg" role="group" aria-label="Travel by">${[["foot", "Walk"], ["bike", "Cycle"], ["car", "Drive"]].map(([v, l]) => `<button data-act="mode" data-v="${v}" aria-pressed="${s.mode === v}">${l}</button>`).join("")}</div>`;
    if (!(r && r.saved)) out += stops + `<p class="muted small">${s.measure ? "Tap the map to add points. Distances are in straight lines between them." : s.stops.length < 2 ? "Tap the map to add your start, stops and finish, or search for a place." : "Tap the map to add another stop."}</p>
      <div class="row">${GPS.state.pos && !s.stops.some(p => p.me) ? '<button class="btn" data-act="stop-me">Add my location</button>' : ""}${s.stops.length > 1 ? '<button class="btn" data-act="stop-reverse">Reverse</button>' : ""}${s.stops.length ? '<button class="btn" data-act="plan-clear">Clear</button>' : ""}<button class="btn" data-act="measure">${s.measure ? "Follow paths instead" : "Measure distance"}</button></div>`;
    if (s.busy) out += '<p class="muted">Finding the way…</p>';
    if (s.error) out += `<p class="warn">${esc(s.error)}</p>`;
    if (r) {
      const p = r.profile, time = s.mode === "foot" && !s.measure ? walkSeconds(r.distance, p ? p.up : 0) : r.duration;
      out += `<div class="stats">${stat("Distance", fmtDist(r.distance))}${s.measure ? stat("Walking time", fmtTime(walkSeconds(r.distance, p ? p.up : 0))) : stat("Time", fmtTime(time))}${stat("Climb / drop", p ? fmtHeight(p.up) + " / " + fmtHeight(p.down) : p === undefined ? "…" : "–")}</div>
        ${p ? profileSVG(p) : p === null ? '<p class="muted small">Height data isn’t available here while offline.</p>' : ""}
        <div class="row">${r.saved ? '<button class="btn danger" data-act="walk-delete">Delete this walk</button>' : '<button class="btn primary" data-act="walk-save">Save this walk</button>'}<button class="btn" data-act="plan-fit">Show whole route</button>${r.saved ? '<button class="btn" data-act="plan-clear">Remove from map</button>' : ""}</div>
        ${r.steps.length ? `<details><summary>Step by step (${r.steps.length})</summary><ol class="steps">${r.steps.map(t => `<li>${esc(t)}</li>`).join("")}</ol></details>` : ""}`;
    }
    return [r && r.saved ? r.saved.name : s.measure ? "Measure distance" : "Directions", out];
  },
  record() {
    const s = Rec.status();
    if (!Rec.supported()) return ["Record a walk", '<p>Recording needs the newest Trail Map app file. Ask Claude for it.</p>'];
    const tip = '<p class="muted small">Recording carries on with the screen off. On a Samsung phone, also set Settings &gt; Apps &gt; Trail Map &gt; Battery to Unrestricted so the phone doesn’t stop it.</p>';
    if (s === "idle") return ["Record a walk", `<p>Your path is drawn on the map as you go, with distance, time and climb.</p><button class="btn primary" data-act="rec-start">${ICON.record}Start recording</button>${gpsControls()}${tip}`];
    const note = { paused: "Paused. Nothing is being recorded.", interrupted: "Recording stopped unexpectedly. What was recorded is safe: continue, or finish and save it.", stopped: "Finished. Save this walk, or carry on." }[s] || (Rec.figures().points ? "" : "Waiting for a good GPS signal…");
    const buttons = Rec.saving() ? '<p class="muted">Saving…</p>'
      : s === "recording" ? '<button class="btn" data-act="rec-pause">Pause</button><button class="btn primary" data-act="rec-finish">Finish</button>'
      : s === "stopped" ? '<button class="btn primary" data-act="rec-save">Save walk</button><button class="btn" data-act="rec-resume">Carry on</button><button class="btn danger" data-act="rec-discard">Discard</button>'
      : '<button class="btn primary" data-act="rec-resume">Continue</button><button class="btn" data-act="rec-finish">Finish</button>';
    const title = { recording: "Recording", paused: "Recording paused", interrupted: "Recording interrupted", stopped: "Your walk" }[s];
    const back = Rec.figures().points > 1 && !Rec.saving() ? `<button class="btn" data-act="back-start">${ICON.back}TracBack to start</button>` : "";
    return [title, `${note ? `<p class="${s === "interrupted" ? "warn" : "muted"} small">${note}</p>` : ""}<div id="rec-stats" class="stats">${recStats()}</div><div class="row">${buttons}${back}</div>${s === "stopped" ? Graphs.html(Rec.series()) : ""}${s === "stopped" ? "" : gpsControls()}${s === "recording" ? tip : ""}`];
  },
  trackview(t) {
    return [t.name, `<p class="muted small">Recorded ${esc(new Date(t.date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}</p>
      <div class="stats">${stat("Distance", fmtDist(t.distance))}${stat("Time", fmtTime(t.elapsed))}${stat("Moving", fmtTime(t.moving))}${stat("Climb", fmtHeight(t.up))}${stat("Moving speed", t.moving ? fmtSpeed(t.distance / t.moving) : "–")}</div>
      <div class="row"><button class="btn primary" data-act="track-back">${ICON.back}TracBack to start</button><button class="btn" data-act="track-fit">Show on map</button></div>
      ${t.series ? Graphs.html(t.series) : `${t.profile ? profileSVG(t.profile) : ""}<p class="muted small">Graphs and splits are kept for walks saved from now on.</p>`}
      <div class="row"><button class="btn" data-act="track-rename">Rename</button><button class="btn" data-act="track-hide">Remove from map</button><button class="btn danger" data-act="track-delete">Delete</button></div>`];
  },
  saved() {
    const pos = GPS.state.pos;
    const tracks = SAVED.tracks.map(t => `<button class="item" data-act="track" data-id="${t.id}"><span class="swatch" style="background:#ff5a00"></span><span class="grow">${esc(t.name)}<small>${esc(fmtDist(t.distance) + " · " + fmtTime(t.elapsed) + " · " + new Date(t.date).toLocaleDateString("en-GB"))}</small></span></button>`).join("");
    const places = SAVED.places.map(p => `<button class="item" data-act="place" data-id="${p.id}"><span class="grow">${esc(p.name)}<small>${esc([OSGB.ref(p.ll[1], p.ll[0]) || p.ll[1].toFixed(4) + ", " + p.ll[0].toFixed(4), pos ? fmtDist(haversine(pos.ll, p.ll)) + " away" : ""].filter(Boolean).join(" · "))}</small></span></button>`).join("");
    const walks = SAVED.routes.map(r => `<button class="item" data-act="walk" data-id="${r.id}"><span class="grow">${esc(r.name)}<small>${esc(fmtDist(r.distance) + (r.profile ? " · " + fmtHeight(r.profile.up) + " climb" : ""))}</small></span></button>`).join("");
    return ["Saved", `<h3>Recorded walks</h3>${tracks || '<p class="muted small">Tap the record button on the map to record a walk.</p>'}<h3>Planned walks</h3>${walks || '<p class="muted small">Plan a walk in Directions, then tap Save this walk. Saved walks work offline.</p>'}<h3>Places</h3>${places || '<p class="muted small">Press and hold the map, then tap Save place.</p>'}`];
  },
  search(s) {
    const item = (r, i) => `<button class="item" data-act="result" data-i="${i}"><span class="grow">${esc(r.name)}<small>${esc(r.detail || "")}</small></span></button>`;
    return ["Search results", s.items.map(item).join("") + (s.loading ? '<p class="muted">Searching…</p>' : "") + (s.error ? `<p class="warn">${esc(s.error)}</p>` : "") + (!s.loading && !s.error && !s.items.length ? '<p class="muted">Nothing found.</p>' : "")];
  }
};
function recStats() {
  const f = Rec.figures();
  const clock = s => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(Math.floor(s) % 60).padStart(2, "0")}`;
  return stat("Distance", fmtDist(f.distance)) + stat("Time", clock(f.elapsed)) + stat("Moving", clock(f.moving)) + stat("Climb (GPS, rough)", fmtHeight(f.climb)) + stat("Moving speed", f.moving > 30 ? fmtSpeed(f.distance / f.moving) : "–");
}
const showTrack = t => { Plan.clear(); setData("plan", { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: t.lines } }); openSheet("trackview", t); fit(t.lines.flat()); };
const tagDistance = d => /^\s*[\d.]+\s*$/.test(d) ? fmtDist(parseFloat(d) * 1000) : d;

function showCard(c) {
  dropPin(c.ll); openSheet("card", c);
  if (c.ele === undefined) elevationAt(c.ll).then(h => { c.ele = h; if (UI.data === c) renderSheet(); });
}

/* ---- GPS box, button and status chip ---- */
function renderGPS() {
  const p = GPS.state.pos, f = GPS.follow(), box = $("#gps"), btn = $("#fab-locate");
  btn.className = "fab" + (f === "heading" ? " heading" : f === "follow" ? " on" : "");
  btn.innerHTML = f === "heading" ? ICON.heading : ICON.locate;
  const rec = Rec.status(), recButton = $("#fab-rec");
  recButton.classList.toggle("recording", rec === "recording");
  box.dataset.act = Rec.active() ? "record" : "where";
  box.hidden = !!UI.sheet || !$("#area").hidden || (!Rec.active() && !p && !GPS.state.error);
  if (Rec.active()) { const f = Rec.figures(); box.innerHTML = `<div><b>${fmtDist(f.distance)}</b><span>${{ recording: "● Recording", paused: "Paused", interrupted: "Interrupted", stopped: "Not saved yet" }[rec]}</span></div><div><b>${fmtTime(f.elapsed)}</b><span>Time</span></div><div><b>${p ? fmtHeight(p.altitude) : "–"}</b><span>Altitude</span></div>`; return; }
  box.innerHTML = p ? `<div><b>${fmtHeight(p.altitude)}</b><span>Altitude</span></div><div><b>${fmtSpeed(p.speed)}</b><span>Speed</span></div><div><b>±${fmtHeight(p.accuracy)}</b><span>Accuracy</span></div>` : `<div class="small">${esc(GPS.state.error)}</div>`;
}
function renderChip() {
  const text = [map ? Packs.hint(map) : "", navigator.onLine ? "" : "Offline: showing downloaded maps", SETTINGS.routes && /Loading|Couldn't|busy/.test(Routes.status()) ? Routes.status() : "",
    Offline.job() ? `Downloading ${Math.round(Offline.job().done / Offline.job().total * 100)}%` : ""].filter(Boolean).join(" · ");
  $("#chip").textContent = text; $("#chip").hidden = !text;
}

/* ---- Settings page ---- */
let settingsSeq = 0;
async function renderSettings() {
  const seq = ++settingsSeq;
  const regions = await Offline.list().catch(() => []);
  let usage = ""; try { const e = await navigator.storage.estimate(); usage = `The app is using ${fmtBytes(e.usage || 0)} on this phone.`; } catch (e) { /* not supported */ }
  if (seq !== settingsSeq || $("#page").hidden) return;
  const job = Offline.job();
  const area = r => {
    const running = job && job.id === r.id;
    const info = running ? `${job.stage}: ${job.done} of ${job.total}` : r.complete ? `${fmtBytes(r.bytes)} · downloaded ${new Date(r.updated).toLocaleDateString("en-GB")}` : `Not finished${r.error ? ": " + r.error : ""}`;
    return `<div class="item" style="flex-direction:column;align-items:stretch"><div><strong>${esc(r.name)}</strong><small class="${!running && !r.complete ? "warn" : ""}">${esc(info)}</small></div>
      ${running ? `<progress max="${job.total}" value="${job.done}"></progress><div class="row end"><button class="btn" data-act="dl-stop">Pause</button><button class="btn danger" data-act="dl-delete" data-id="${r.id}">Delete</button></div>`
        : `<div class="row end"><button class="btn" data-act="dl-show" data-id="${r.id}">View</button><button class="btn" data-act="dl-update" data-id="${r.id}" ${job ? "disabled" : ""}>${r.complete ? "Update" : "Resume"}</button><button class="btn danger" data-act="dl-delete" data-id="${r.id}">Delete</button></div>`}</div>`;
  };
  const seg = (key, options) => `<div class="seg" role="group">${options.map(([v, l]) => `<button data-act="pref" data-k="${key}" data-v="${v}" aria-pressed="${SETTINGS[key] === v}">${l}</button>`).join("")}</div>`;
  $("#page-body").innerHTML = `
    <section class="panel"><h2>Offline maps</h2><p class="small">Download places before you go, especially ones with poor signal. The map, footpaths, contours, hills and walking routes then work with no internet. Delete areas you rarely visit to free up space.</p>
      ${regions.map(area).join("") || '<p class="muted small">No maps downloaded yet.</p>'}
      <button class="btn primary" data-act="area-new" ${job ? "disabled" : ""}>Download a new area</button>
      ${job ? '<p class="muted small">Keep Trail Map open until the download finishes.</p>' : ""}<p class="muted small">${usage}</p></section>
    <section class="panel"><h2>Imported maps</h2>${Packs.panel()}</section>
    <section class="panel"><h2>App updates</h2>${Update.panel()}</section>
    <section class="panel"><h2>Terrain</h2>${terrainControls()}</section>
    <section class="panel"><h2>Walk recording and battery</h2>${gpsControls()}
      <p class="small">To save the most battery, keep the screen off between map checks. On a Samsung phone, set Settings &gt; Apps &gt; Trail Map &gt; Battery to Unrestricted so recording isn’t stopped.</p></section>
    <section class="panel"><h2>Units</h2>${seg("units", [["km", "Kilometres, metres"], ["mi", "Miles, feet"]])}</section>
    <section class="panel"><h2>Appearance</h2>${seg("theme", [["auto", "Automatic"], ["light", "Light"], ["dark", "Dark"]])}
      <label class="switch"><input type="checkbox" data-set="awake" ${SETTINGS.awake ? "checked" : ""}> <span>Keep the screen on while the app is open (uses more battery)</span></label></section>
    <section class="panel"><h2>About</h2><p class="small">Map data © OpenStreetMap contributors. Map tiles by OpenFreeMap (© OpenMapTiles). Heights from AWS Terrain Tiles. Route overview by Waymarked Trails (CC BY-SA). Satellite pictures: Sentinel-2 cloudless 2020 by EOX (CC BY-NC-SA 4.0, contains modified Copernicus Sentinel data). Search by Nominatim, directions by FOSSGIS OSRM, routes by Overpass.</p>
      <p class="small">Paths on a map aren't always rights of way or safe to walk. Carry a paper map and compass in the hills, and keep your phone charged.</p></section>`;
}

/* ---- download box ---- */
function areaBox() {
  const f = $("#area-frame").getBoundingClientRect(), m = $("#map").getBoundingClientRect();
  const pts = [[f.left, f.top], [f.right, f.top], [f.right, f.bottom], [f.left, f.bottom]].map(([x, y]) => map.unproject([x - m.left, y - m.top]).toArray());
  const b = boundsOf(pts);
  return [clamp(b[0], -180, 180), clamp(b[1], -85, 85), clamp(b[2], -180, 180), clamp(b[3], -85, 85)];
}
function areaSize() {
  if ($("#area").hidden) return;
  const b = areaBox(), e = areaEstimate(b), tooBig = e.tiles > MAX_TILES;
  const w = haversine([b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]), h = haversine([b[0], b[1]], [b[0], b[3]]);
  $("#area-size").textContent = tooBig ? "This area is too big. Zoom in." : `About ${fmtDist(w)} × ${fmtDist(h)}, roughly ${fmtBytes(e.bytes)}.${e.bytes > 4e8 ? " Use Wi-Fi." : ""}`;
  $("#area-size").className = "small" + (tooBig ? " warn" : "");
  $("#area-go").disabled = tooBig;
}
function openArea() {
  closeSheet(); $("#page").hidden = true; UI.tab = "map"; nav();
  map.easeTo({ bearing: 0, pitch: 0, duration: 0 }); GPS.setFollow("off");
  $("#area-name").value = ""; $("#search").hidden = true; $("#area").hidden = false; floating(); areaSize();
}
function closeArea() { if ($("#area").hidden) return; $("#area").hidden = true; $("#search").hidden = false; floating(); }
async function startDownload(region, refresh) {
  if (!navigator.onLine) { toast("Connect to the internet to download"); return; }
  const done = await Offline.download(region, refresh);
  if (await Offline.list().then(l => l.some(r => r.id === done.id))) toast(done.complete ? `${done.name} is ready to use offline` : `${done.name}: ${done.error}`);
}

/* ---- search ---- */
let searchSeq = 0;
async function runSearch(text) {
  const seq = ++searchSeq;
  const here = parseCoords(text);
  if (here) { GPS.setFollow("off"); map.flyTo({ center: here, zoom: 15 }); showCard({ name: OSGB.parse(text) ? "Grid reference " + text.trim().toUpperCase() : "Coordinates", ll: here }); return; }
  const t = text.toLowerCase();
  const local = SAVED.places.filter(p => p.name.toLowerCase().includes(t)).map(p => ({ name: p.name, detail: "Saved place", ll: p.ll, savedId: p.id }));
  const data = { items: local, loading: true, error: "" };
  openSheet("search", data);
  const show = () => { if (seq === searchSeq && UI.data === data) renderSheet(); };
  data.items = local.concat((await Routes.search(text)).map(r => ({ name: r.name, detail: "Walking route saved on this phone", route: r }))); show();
  try { data.items = data.items.concat(await searchPlaces(text)); }
  catch (e) { data.error = navigator.onLine ? "Place search didn't answer. Try again." : "Offline: only saved places and routes can be searched."; }
  data.loading = false; show();
}

/* ---- sharing ---- */
async function share(name, ll) {
  const grid = OSGB.ref(ll[1], ll[0]);
  const text = `${name}: ${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}${grid ? " (OS " + grid + ")" : ""}\nhttps://www.openstreetmap.org/?mlat=${ll[1].toFixed(5)}&mlon=${ll[0].toFixed(5)}#map=16/${ll[1].toFixed(5)}/${ll[0].toFixed(5)}`;
  if (NATIVE) return NATIVE.share(text);
  try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast("Location copied"); } } catch (e) { /* cancelled */ }
}
async function savePlace(ll, suggested) {
  const name = await dialog({ title: "Save place", input: suggested, yes: "Save" }); if (!name) return null;
  const p = { id: uid(), name, ll }; SAVED.places.unshift(p); persistSaved(); toast("Saved"); return p;
}
const fit = coords => { const b = boundsOf(coords); GPS.setFollow("off"); map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 90, left: 40, right: 70, bottom: $("#sheet").hidden ? 60 : Math.min($("#sheet").offsetHeight + 30, $("#map").offsetHeight - 200) }, maxZoom: 15 }); };

function openRoute(r) { Routes.show(r); openSheet("route", r); Routes.select(r.id); }

/* Close the panels and follow your position while retracing a walk. */
function followBack() { setData("plan", EMPTY); goTab("map"); GPS.setFollow("follow"); Back.update(); if (!GPS.state.pos) toast(GPS.state.error || "Finding your position…"); }

/* ---- buttons ---- */
const ACTIONS = {
  tab: d => goTab(d.v),
  close: () => { closeSheet(); UI.tab = "map"; nav(); },
  layers: () => UI.sheet === "layers" ? closeSheet() : openSheet("layers"),
  north: () => { if (GPS.follow() === "heading") GPS.setFollow("follow"); map.easeTo({ bearing: 0, pitch: SETTINGS.relief3d !== "off" ? map.getPitch() : 0 }); },
  "zoom-in": () => map.zoomIn(), "zoom-out": () => map.zoomOut(),
  locate: () => { GPS.cycle(); if (!GPS.state.pos) toast(GPS.state.error || "Finding your position…"); },
  where: () => openSheet("where"),
  "gps-retry": () => { GPS.setFollow("follow"); },
  "me-share": () => share("I am here", GPS.state.pos.ll),
  "me-save": () => savePlace(GPS.state.pos.ll, "My spot " + new Date().toLocaleDateString("en-GB")),
  terrain: d => {
    SETTINGS[d.k] = d.v; saveSettings(); Barriers.schedule();
    if (d.k === "contour" && d.v !== "off") map.getSource("contours").setTiles(contourSource().tiles);
    applyLayers();
    if ($("#page").hidden) { renderSheet(); floating(); } else renderSettings();
  },
  "update-check": () => Update.check(true),
  record: () => { UI.tab = "map"; nav(); openSheet("record"); },
  "rec-start": () => { Rec.start(); GPS.setFollow("follow"); },
  "gps-mode": d => { SETTINGS.gps = d.v; saveSettings(); Rec.setMode(d.v); if ($("#page").hidden) { renderSheet(); floating(); } else renderSettings(); },
  "back-start": () => { if (Back.start(Rec.lines(), "Your recorded walk")) followBack(); },
  "track-back": () => { const t = UI.data; if (Back.start(t.lines, t.name)) followBack(); },
  "back-stop": async () => { if (await dialog({ title: "Stop TracBack?", text: "The guide back to your start will be removed.", yes: "Stop" })) Back.stop(); },
  "rec-pause": () => Rec.pause(),
  "rec-resume": () => Rec.resume(),
  "rec-finish": () => Rec.finish(),
  "rec-save": async () => {
    const name = await dialog({ title: "Save walk", input: "Walk " + new Date().toLocaleDateString("en-GB"), yes: "Save" }); if (!name) return;
    const t = await Rec.save(name); if (t) { toast("Walk saved"); showTrack(t); }
  },
  "rec-discard": async () => { if (await dialog({ title: "Discard this recording?", text: "The walk you just recorded will be deleted. This can't be undone.", yes: "Discard" })) { Rec.discard(); goTab("map"); } },
  track: d => { const t = SAVED.tracks.find(x => x.id === d.id); if (t) showTrack(t); },
  "track-fit": () => fit(UI.data.lines.flat()),
  "track-hide": () => { setData("plan", EMPTY); goTab("map"); },
  "track-rename": async () => { const t = UI.data; const name = await dialog({ title: "Rename walk", input: t.name, yes: "Save" }); if (name) { t.name = name; persistSaved(); renderSheet(); } },
  "track-delete": async () => { const t = UI.data; if (await dialog({ title: "Delete recorded walk?", text: t.name, yes: "Delete" })) { SAVED.tracks = SAVED.tracks.filter(x => x.id !== t.id); persistSaved(); setData("plan", EMPTY); goTab("saved"); } },
  "update-install": () => Update.install(),
  "routes-on": () => { SETTINGS.routes = true; saveSettings(); applyLayers(); Routes.refresh(); renderSheet(); },
  route: d => { const r = Routes.get(+d.id); if (r) openRoute(r); },
  "route-fit": () => fit(UI.data.lines.flat()),
  "route-go": () => {
    const r = UI.data, from = GPS.state.pos ? GPS.state.pos.ll : map.getCenter().toArray();
    let best = null, bestD = Infinity; r.lines.forEach(l => l.forEach(p => { const dist = haversine(from, p); if (dist < bestD) { bestD = dist; best = p; } }));
    UI.tab = "directions"; nav(); openSheet("directions"); Plan.to({ name: "Nearest point of " + r.name, ll: best });
  },
  "card-go": () => { const c = UI.data; UI.tab = "directions"; nav(); openSheet("directions"); Plan.to({ name: c.name, ll: c.ll }); },
  "card-save": async () => { const c = UI.data; const p = await savePlace(c.ll, c.name === "Dropped pin" ? "" : c.name); if (p && UI.data === c) { c.savedId = p.id; c.name = p.name; renderSheet(); } },
  "card-share": () => share(UI.data.name, UI.data.ll),
  "place-rename": async () => { const c = UI.data, p = SAVED.places.find(x => x.id === c.savedId); if (!p) return; const name = await dialog({ title: "Rename place", input: p.name, yes: "Save" }); if (name) { p.name = c.name = name; persistSaved(); renderSheet(); } },
  "place-delete": async () => { const c = UI.data; if (await dialog({ title: "Delete saved place?", text: c.name, yes: "Delete" })) { SAVED.places = SAVED.places.filter(x => x.id !== c.savedId); persistSaved(); goTab("saved"); } },
  place: d => { const p = SAVED.places.find(x => x.id === d.id); if (!p) return; UI.tab = "map"; nav(); GPS.setFollow("off"); map.flyTo({ center: p.ll, zoom: Math.max(14, map.getZoom()) }); showCard({ name: p.name, ll: p.ll, savedId: p.id }); },
  walk: d => { const r = SAVED.routes.find(x => x.id === d.id); if (!r) return; UI.tab = "directions"; nav(); openSheet("directions"); Plan.showSaved(r); fit(r.coords); },
  "walk-save": async () => {
    const r = Plan.state.result, s = Plan.state; if (!r) return;
    const last = s.stops[s.stops.length - 1];
    const name = await dialog({ title: "Save walk", input: s.measure ? "Measured walk" : "Walk to " + (last ? last.name : "…"), yes: "Save" });
    if (!name || s.result !== r) return;
    const saved = { id: uid(), name: name.slice(0, 80), mode: s.measure ? "measure" : s.mode, coords: r.coords, distance: r.distance, duration: r.duration, steps: r.steps, profile: r.profile || null };
    SAVED.routes.unshift(saved); persistSaved(); r.saved = saved; renderSheet(); toast("Walk saved. Download its area to see the map offline.");
  },
  "walk-delete": async () => { const r = Plan.state.result && Plan.state.result.saved; if (r && await dialog({ title: "Delete saved walk?", text: r.name, yes: "Delete" })) { SAVED.routes = SAVED.routes.filter(x => x.id !== r.id); persistSaved(); Plan.clear(); goTab("saved"); } },
  mode: d => Plan.setMode(d.v),
  "stop-me": () => { Plan.state.stops.unshift({ me: true, name: "My location" }); Plan.calculate(); },
  "stop-remove": d => Plan.removeAt(+d.i),
  "stop-reverse": () => Plan.reverse(),
  "plan-clear": () => Plan.clear(),
  "plan-fit": () => fit(Plan.state.result.coords),
  measure: () => { Plan.state.measure = !Plan.state.measure; Plan.calculate(); },
  result: d => {
    const r = UI.data.items[+d.i]; $("#q").blur();
    if (r.route) { openRoute(r.route); fit(r.route.lines.flat()); return; }
    GPS.setFollow("off");
    if (UI.tab === "directions") { openSheet("directions"); Plan.add({ name: r.name, ll: r.ll }); map.flyTo({ center: r.ll, zoom: 13 }); return; }
    if (r.box && haversine([r.box[0], r.box[1]], [r.box[2], r.box[3]]) > 3000) map.fitBounds([[r.box[0], r.box[1]], [r.box[2], r.box[3]]], { padding: 60, maxZoom: 15 }); else map.flyTo({ center: r.ll, zoom: 15 });
    showCard({ name: r.name, detail: r.savedId ? "" : r.detail, ll: r.ll, savedId: r.savedId });
  },
  "search-clear": () => { $("#q").value = ""; $("#search-x").hidden = true; if (UI.sheet === "search") closeSheet(); },
  pref: d => {
    SETTINGS[d.k] = d.v; saveSettings();
    if (d.k === "theme") applyTheme();
    if (d.k === "units") { applyUnits(); renderGPS(); }
    renderSettings();
  },
  "area-new": () => openArea(),
  "area-cancel": () => { closeArea(); goTab("settings"); },
  "area-download": async () => {
    const bbox = areaBox(); if (areaEstimate(bbox).tiles > MAX_TILES) return;
    if (!navigator.onLine) { toast("Connect to the internet to download"); return; }
    if (Offline.job()) { toast("Another download is running"); return; }
    const name = $("#area-name").value.trim() || "Map " + new Date().toLocaleDateString("en-GB");
    const region = { id: uid(), name, bbox, created: Date.now(), bytes: 0, complete: false };
    closeArea(); goTab("settings"); startDownload(region, false);
  },
  "pack-import": () => Packs.pick(),
  "pack-show": d => {
    const p = Packs.get(d.id); if (!p) return;
    SETTINGS.base = "tt"; saveSettings(); applyLayers(); goTab("map"); GPS.setFollow("off");
    // go to where you are, or stay put, if the map covers it; otherwise to its middle
    const inside = ll => !!ll && ll[0] > p.bbox[0] && ll[0] < p.bbox[2] && ll[1] > p.bbox[1] && ll[1] < p.bbox[3];
    const here = GPS.state.pos && GPS.state.pos.ll, view = map.getCenter().toArray();
    const center = inside(here) ? here : inside(view) ? view : [(p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2];
    map.jumpTo({ center, zoom: inside(here) || inside(view) ? Math.max(12, map.getZoom()) : 12 });
  },
  "pack-delete": async d => { const p = Packs.get(d.id); if (p && await dialog({ title: "Delete imported map?", text: `${p.name} will be removed from this phone. You can import its file again later.`, yes: "Delete" })) { await Packs.remove(p.id); toast("Deleted " + p.name); } },
  "dl-stop": () => Offline.stop(),
  "dl-update": async d => { const r = (await Offline.list()).find(x => x.id === d.id); if (r) startDownload(r, r.complete); },
  "dl-show": async d => { const r = (await Offline.list()).find(x => x.id === d.id); if (!r) return; goTab("map"); GPS.setFollow("off"); map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 30 }); },
  "dl-delete": async d => {
    const r = (await Offline.list()).find(x => x.id === d.id); if (!r) return;
    if (!await dialog({ title: "Delete offline map?", text: `${r.name} will be removed from this phone. You can download it again later.`, yes: "Delete" })) return;
    toast("Deleting…"); await Offline.remove(r.id); toast("Deleted " + r.name);
  }
};
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled || !map) return;
  const fn = ACTIONS[b.dataset.act]; if (fn) fn(b.dataset);
});
document.addEventListener("change", e => {
  const k = e.target.dataset && e.target.dataset.set; if (!k || !map) return;
  SETTINGS[k] = e.target.checked; saveSettings();
  if (k === "awake") keepAwake(SETTINGS.awake || !!Offline.job()); else { applyLayers(); Routes.refresh(); Barriers.schedule(); }
});
$("#search").addEventListener("submit", e => { e.preventDefault(); const t = $("#q").value.trim(); if (t && map) { $("#q").blur(); runSearch(t); } });
$("#q").addEventListener("input", () => { $("#search-x").hidden = !$("#q").value; });

/* ---- theme and Android back button ---- */
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const systemDark = NATIVE ? NATIVE.isDark() : darkQuery.matches; // the Android app asks the phone
  const dark = SETTINGS.theme === "dark" || (SETTINGS.theme === "auto" && systemDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (NATIVE) NATIVE.setBars(dark);
}
darkQuery.addEventListener("change", applyTheme);
window.applyTheme = applyTheme;
window.appBack = () => {
  if (!$("#dialog").hidden) { dialogDone && dialogDone(null); return true; }
  if (!$("#area").hidden) { closeArea(); goTab("settings"); return true; }
  if (UI.sheet === "trackview") { openSheet("saved"); UI.tab = "saved"; nav(); return true; }
  if (UI.sheet === "route" || (UI.sheet === "card" && UI.tab === "saved")) { openSheet(UI.tab === "saved" ? "saved" : "routes"); return true; }
  if (UI.sheet || !$("#page").hidden) { goTab("map"); return true; }
  return false;
};

/* ---- map taps ---- */
function wireMap() {
  const at = (point, layers, r = 8) => map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: layers.filter(l => map.getLayer(l)) });
  let held = 0;
  const hold = ll => { held = Date.now(); if (!$("#area").hidden) return; if (UI.tab !== "map") { UI.tab = "map"; nav(); } showCard({ name: "Dropped pin", ll }); };
  map.on("contextmenu", e => hold(e.lngLat.toArray()));
  // press and hold, for touch screens that don't send "contextmenu"
  let timer = null, start = null;
  map.on("touchstart", e => { clearTimeout(timer); if (e.originalEvent.touches.length !== 1) return; start = e.point; const ll = e.lngLat.toArray(); timer = setTimeout(() => { if (Date.now() - held > 1000) hold(ll); }, 600); });
  map.on("touchmove", e => { if (start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10) clearTimeout(timer); });
  ["touchend", "touchcancel", "movestart"].forEach(n => map.on(n, e => { if (!e.gps) clearTimeout(timer); }));

  map.on("click", e => {
    if (Date.now() - held < 800 || !$("#area").hidden) return;
    $("#q").blur();
    const ll = e.lngLat.toArray();
    if (UI.sheet === "directions") {
      if (Plan.state.result && Plan.state.result.saved) return;
      Plan.add({ name: "Point on map", ll }); return;
    }
    const saved = at(e.point, ["saved-dot"], 12)[0];
    if (saved) { const p = SAVED.places.find(x => x.id === saved.properties.id); if (p) return showCard({ name: p.name, ll: p.ll, savedId: p.id }); }
    const poi = at(e.point, [...Packs.tapLayers(), "barrier-gates", "os-symbols", "os-poi", "os-peaks", "hiker-poi", "peaks", "poi_r1", "poi_r7", "poi_r20", "poi_transit"])[0];
    if (poi) { const pr = poi.properties, kind = String(Packs.kind(pr.t) || pr.subclass || pr.class || pr.kind || "").replace(/_/g, " "), named = pr["name:latin"] || pr.name || pr.n; return showCard({ name: named || (kind ? kind[0].toUpperCase() + kind.slice(1) : "Place"), detail: /peaks$/.test(poi.layer.id) ? "Summit" : kind, ll: poi.geometry.type === "Point" ? poi.geometry.coordinates : ll }); }
    const route = SETTINGS.routes && at(e.point, ["routes-hit"], 4)[0];
    if (route) { const r = Routes.get(route.properties.id); if (r) return openRoute(r); }
    if (UI.sheet && UI.sheet !== "search") goTab("map");
  });
  map.on("dragstart", () => { if (GPS.follow() !== "off") GPS.setFollow("off"); });
  map.on("rotate", () => { const b = map.getBearing(); $("#fab-north").hidden = Math.abs(b) < 1; const i = $("#fab-north svg"); if (i) i.style.transform = `rotate(${-b}deg)`; });
  map.on("move", areaSize);
  map.on("zoomend", renderChip);
  map.on("moveend", e => { if (!e.gps || GPS.follow() === "off") { Routes.schedule(); Barriers.schedule(); } else followRoutes(); });
}
/* While following you, only look for new routes now and then. */
let lastFollow = 0;
function followRoutes() { if (Date.now() - lastFollow > 20000) { lastFollow = Date.now(); Routes.schedule(); Barriers.schedule(); } }

/* ---- start ---- */
(async function start() {
  applyTheme(); nav();
  $("#search-go").innerHTML = ICON.search; $("#search-x").innerHTML = ICON.close; $("#sheet-x").innerHTML = ICON.close;
  $("#fab-layers").innerHTML = ICON.layers; $("#fab-north").innerHTML = ICON.north; $("#fab-rec").innerHTML = ICON.record; $("#fab-in").innerHTML = ICON.plus; $("#fab-out").innerHTML = ICON.minus;
  try { await Packs.load(); await createMap(); }
  catch (e) { map = null; toast("The map couldn't start: " + e.message); return; }
  wireMap(); drawSaved(); renderGPS();
  let sheetStamp = 0;
  Back.resume();
  GPS.onChange(() => {
    renderGPS(); if (Back.active()) Back.update();
    if (UI.sheet === "where" && Date.now() - sheetStamp > 900) { sheetStamp = Date.now(); renderSheet(); }
    if (UI.sheet === "directions" && GPS.state.pos && /Waiting for GPS/.test(Plan.state.error)) Plan.calculate();
  });
  Routes.onChange(() => { renderChip(); if (UI.sheet === "routes") { renderSheet(); floating(); } });
  Plan.onChange(() => { if (UI.sheet === "directions") { const open = $("#sheet-body details") && $("#sheet-body details").open; renderSheet(); if (open && $("#sheet-body details")) $("#sheet-body details").open = true; floating(); } });
  Offline.onChange(() => { renderChip(); if (!$("#page").hidden) renderSettings(); });
  addEventListener("online", () => { renderChip(); Routes.refresh(); map.triggerRepaint(); });
  addEventListener("offline", () => { renderChip(); });
  addEventListener("resize", () => { floating(); areaSize(); });
  Packs.onChange(() => { applyLayers(); if (!$("#page").hidden) renderSettings(); });
  renderChip(); Routes.refresh(); Barriers.schedule();
  if (NATIVE && NATIVE.appReady) NATIVE.appReady(); // this version works: keep it
  Update.onChange(() => { nav(); if (!$("#page").hidden) renderSettings(); });
  Update.check(false);
  let shown = Rec.status();
  Rec.onChange(() => {
    const now = Rec.status() + Rec.saving() + !!Rec.figures().points; // redraw the panel when the first position arrives
    renderGPS();
    if (UI.sheet === "record") { const stats = $("#rec-stats"); if (now === shown && stats && Rec.figures().points) stats.innerHTML = recStats(); else { renderSheet(); floating(); } }
    shown = now;
  });
  Rec.poll();
  keepAwake(SETTINGS.awake);
  GPS.setFollow("follow");
})();
