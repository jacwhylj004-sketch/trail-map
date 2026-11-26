"use strict";
/* Room for the map. Panels shrink to a bar, the search box, position box and banners fold away, "Full map" hides
   every control, and a route or walk drawn on the map has a bar with a button that removes it. */

const CHEVRON = up => svg(up ? '<path d="m6 15 6-6 6 6"/>' : '<path d="m6 9 6 6 6-6"/>');
ICON.full = svg('<path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/>');
ICON.unfull = svg('<path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4"/>');

const Space = (() => {
  let track = null; // a recorded walk drawn on the map

  /* ---- the route or walk on the map ---- */
  const MODES = { foot: "Walk", bike: "Cycle", car: "Drive" };
  function line() {
    if (track) return { title: track.name, detail: "Recorded walk · " + fmtDist(track.distance) };
    const s = Plan.state, r = s.result;
    if (r) {
      const time = s.measure ? 0 : routeTime(r);
      return { title: r.saved ? r.saved.name : s.measure ? "Measured line" : MODES[s.mode] + " route", detail: (time ? fmtTime(time) + " · " : "") + fmtDist(r.distance) };
    }
    if (s.busy || s.stops.some(p => !p.me)) return { title: s.measure ? "Measuring" : "Route", detail: s.busy ? "Finding the way…" : s.error || "Not finished yet" };
    return null;
  }
  function bar() {
    const shown = line(), own = UI.sheet === "directions" || UI.sheet === "trackview"; // those panels have their own buttons
    $("#routebar").hidden = !shown || own || !$("#area").hidden;
    if (shown) { $("#routebar-title").textContent = shown.title; $("#routebar-detail").textContent = shown.detail; }
  }
  function remove() { track = null; Plan.clear(); bar(); }
  function open() {
    if (track) { openSheet("trackview", track); return; }
    UI.tab = "directions"; nav(); openSheet("directions");
  }

  /* ---- the bottom panel as a bar ---- */
  function summary() {
    if (UI.sheet === "card") return GPS.state.pos ? fmtDist(haversine(GPS.state.pos.ll, UI.data.ll)) + " away" : UI.data.detail || "";
    if (UI.sheet === "directions") { const l = line(); return l ? l.detail : "Tap the map to add points"; }
    if (UI.sheet === "record" && Rec.status() !== "idle") { const f = Rec.figures(); return fmtDist(f.distance) + " · " + fmtTime(f.elapsed); }
    if (UI.sheet === "trackview") return fmtDist(UI.data.distance) + " · " + fmtTime(UI.data.elapsed);
    return "";
  }
  function head() {
    if (!UI.sheet) return;
    const small = !!UI.mini, text = small ? summary() : "";
    $("#sheet").classList.toggle("mini", small);
    $("#sheet-sub").textContent = text; $("#sheet-sub").hidden = !text;
    const size = $("#sheet-min");
    if (size.dataset.small !== String(small)) { size.dataset.small = String(small); size.innerHTML = CHEVRON(small); size.setAttribute("aria-label", small ? "Show the whole panel" : "Make the panel smaller"); }
    /* the main button stays to hand when the panel is small */
    const r = Plan.state.result, main = !small ? null : UI.sheet === "card" ? ["card-go", "Directions"] : UI.sheet === "directions" && r && !Plan.state.measure && routeTime(r) ? ["nav-start", "Start"] : null;
    const act = $("#sheet-act"); act.hidden = !main;
    if (main) { act.dataset.act = main[0]; act.textContent = main[1]; }
  }
  function size(small) {
    if (!UI.sheet || !!UI.mini === small) return;
    UI.mini = small;
    if (UI.sheet === "card") { SETTINGS.cardMini = small; saveSettings(); } // places you tap next open the same way
    head(); floating();
  }

  /* ---- things that fold away, remembered for next time ---- */
  const FOLDS = { hideSearch: "search-mini", backMini: "back-mini", navMini: "nav-mini" };
  function folds() {
    for (const [key, name] of Object.entries(FOLDS)) document.body.classList.toggle(name, !!SETTINGS[key]);
    /* the arrow on a banner: tap the banner to shrink it or bring it back */
    $("#back .folder").innerHTML = CHEVRON(!SETTINGS.backMini); $("#nav-top .folder").innerHTML = CHEVRON(!SETTINGS.navMini);
  }
  function fold(key, value) { SETTINGS[key] = value; saveSettings(); folds(); floating(); }

  function full(on) {
    if (on) { closeSheet(); UI.tab = "map"; nav(); }
    document.body.classList.toggle("full", on);
    const b = $("#fab-full"); b.innerHTML = on ? ICON.unfull : ICON.full; b.setAttribute("aria-label", on ? "Show the controls" : "Full map");
    map.resize(); floating();
    if (on) toast("Full map. Tap the corners button to bring the controls back.");
  }

  /* ---- the message under the search box: closed messages stay closed until they come up afresh ---- */
  const closed = new Set(), keyOf = text => text.replace(/\d+%?/g, "");
  let showing = [];
  function chip(parts) {
    const keys = parts.map(keyOf);
    closed.forEach(k => { if (!keys.includes(k)) closed.delete(k); });
    showing = parts.filter(p => !closed.has(keyOf(p)));
    $("#chip-text").textContent = showing.join(" · "); $("#chip").hidden = !showing.length;
  }

  Object.assign(ACTIONS, {
    "route-open": open,
    "route-remove": () => { remove(); toast("Removed from the map"); },
    "sheet-min": () => size(!UI.mini),
    "search-hide": () => { $("#q").blur(); fold("hideSearch", true); },
    "gps-hide": () => fold("hideGps", true),
    "gps-show": () => fold("hideGps", false),
    "back-size": () => fold("backMini", !SETTINGS.backMini),
    "nav-size": () => fold("navMini", !SETTINGS.navMini),
    "chip-close": () => { showing.forEach(p => closed.add(keyOf(p))); $("#chip").hidden = true; },
    full: () => full(!document.body.classList.contains("full"))
  });

  /* Swipe the top of a panel down to shrink it, up to bring it back. */
  let from = null;
  $("#sheet-head").addEventListener("touchstart", e => { from = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
  $("#sheet-head").addEventListener("touchend", e => {
    if (from == null) return;
    const moved = e.changedTouches[0].clientY - from; from = null;
    if (Math.abs(moved) > 30) { e.preventDefault(); size(moved > 0); }
  });

  $("#fab-full").innerHTML = ICON.full; $("#search-hide").innerHTML = CHEVRON(true); $("#gps-hide").innerHTML = CHEVRON(false);
  $("#chip-x").innerHTML = ICON.close; $("#routebar-x").innerHTML = ICON.close;
  folds();
  Plan.onChange(() => { if (Plan.state.result || Plan.state.busy || Plan.state.stops.length) track = null; bar(); });

  return {
    bar, head, chip, remove, full, size,
    showTrack: t => { track = t; bar(); },
    isFull: () => document.body.classList.contains("full")
  };
})();
