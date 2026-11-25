"use strict";
/* TracBack: retrace your steps. Takes the path you recorded, turns it round and guides you along it to where you
   started: an arrow, the distance left, and a warning if you stray off it. It needs no internet. It uses the same
   GPS as the map, so it updates while the app is on screen. */

const Back = (() => {
  let state = loadJSON("tm-back", null); // { path: [[lon, lat]], name, along }
  let cum = [], last = null, compass = null;

  function measure() { cum = [0]; for (let i = 1; i < state.path.length; i++) cum.push(cum[i - 1] + haversine(state.path[i - 1], state.path[i])); }

  /* The point a given distance along the path. */
  function pointAt(along) {
    let i = 1; while (i < cum.length - 1 && cum[i] < along) i++;
    const a = state.path[i - 1], b = state.path[i], len = cum[i] - cum[i - 1], f = len ? clamp((along - cum[i - 1]) / len, 0, 1) : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  /* Where you are on the path: how far off it, and how far along. Looks near where you last were first, so a path
     that crosses itself or goes out and back along the same line isn't confused. */
  function locate(ll) {
    const kx = Math.cos(ll[1] * RAD) * 111320, ky = 110540, all = [];
    for (let i = 1; i < state.path.length; i++) {
      const a = state.path[i - 1], b = state.path[i];
      const ax = (a[0] - ll[0]) * kx, ay = (a[1] - ll[1]) * ky, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, len = dx * dx + dy * dy;
      const f = len ? clamp(-(ax * dx + ay * dy) / len, 0, 1) : 0;
      all.push({ off: Math.hypot(ax + f * dx, ay + f * dy), along: cum[i - 1] + f * (cum[i] - cum[i - 1]) });
    }
    const nearest = list => list.reduce((p, q) => q.off < p.off ? q : p);
    if (state.along != null) {
      const near = all.filter(c => c.along > state.along - 60 && c.along < state.along + 250);
      if (near.length) { const best = nearest(near); if (best.off <= 40) return best; }
    }
    const closest = nearest(all).off;
    return all.filter(c => c.off <= closest + 15).reduce((p, q) => q.along < p.along ? q : p); // the one with most still to walk
  }

  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]) / RAD + 360) % 360;
  const rest = along => [pointAt(along), ...state.path.filter((p, i) => cum[i] > along)];

  function draw() {
    if (!map) return;
    if (!state) { setData("back", EMPTY); return; }
    const end = state.path[state.path.length - 1];
    setData("back", { type: "FeatureCollection", features: [
      lineFeature(rest(state.along || 0)),
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: end } }] });
  }

  function show(title, detail, turn, off) {
    $("#back-title").textContent = title; $("#back-detail").textContent = detail;
    const arrow = $("#back-arrow"); arrow.style.visibility = turn == null ? "hidden" : "visible";
    if (turn != null) arrow.style.transform = `rotate(${turn}deg)`;
    $("#back").classList.toggle("off", !!off);
  }

  function update() {
    $("#back").hidden = !state; document.body.classList.toggle("backing", !!state);
    if (!state) return;
    const pos = GPS.state.pos, total = cum[cum.length - 1];
    if (!pos) { show("Waiting for GPS…", fmtDist(total - (state.along || 0)) + " back to your start", null); return; }
    const here = locate(pos.ll);
    const strayed = here.off > Math.max(30, pos.accuracy * 1.5);
    if (!strayed) state.along = here.along; // progress only counts while you are on the path
    saveJSON("tm-back", state);
    const left = Math.max(0, total - (strayed ? state.along || here.along : here.along)), end = state.path[state.path.length - 1];
    if (!strayed && left < 25 && haversine(pos.ll, end) < 30) { show("You're back at the start", state.name, null); draw(); return; }
    const target = pointAt(strayed ? here.along : Math.min(total, here.along + 30));
    const facing = compass != null ? compass : pos.course, turn = bearing(pos.ll, target) - (facing != null ? facing : map ? map.getBearing() : 0);
    show(strayed ? `Off your path by ${fmtDist(here.off)}` : `${fmtDist(left)} back to start`,
      strayed ? `Follow the arrow to rejoin it. ${fmtDist(left)} to go.` : facing == null ? "Arrow shows the direction on the map" : "Follow the arrow along your path", turn, strayed);
    last = pos.ll; draw();
  }

  /* lines: the recorded walk as [[[lon, lat], ...], ...] from its start. */
  function start(lines, name) {
    const path = lines.flat().map(p => [p[0], p[1]]).reverse().filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    if (path.length < 2 || lineLength(path) < 30) { toast("Walk a little further first: there isn't enough of a path to follow yet."); return false; }
    state = { path, name, along: null }; measure(); saveJSON("tm-back", state); update(); draw();
    return true;
  }
  function stop() { state = null; localStorage.removeItem("tm-back"); update(); draw(); }

  let drawnAt = 0;
  addEventListener("deviceorientationabsolute", e => {
    if (e.alpha == null) return;
    compass = (360 - e.alpha + ((screen.orientation && screen.orientation.angle) || 0)) % 360;
    if (state && Date.now() - drawnAt > 400) { drawnAt = Date.now(); update(); }
  });

  /* Called once the map exists: carries on a TracBack that was running when the app closed. */
  function resume() {
    if (state && Array.isArray(state.path) && state.path.length > 1) measure(); else state = null;
    update(); draw();
  }

  return { start, stop, update, resume, active: () => !!state };
})();
