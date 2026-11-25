"use strict";
/* Track recording. The Android app records the GPS points (so it carries on with the screen off);
   this reads them, draws your walk on the map, works out the figures and saves it. */

const Rec = (() => {
  const bridge = () => window.TrailNative && window.TrailNative.trackState ? window.TrailNative : null;
  let status = "idle", started = 0, offset = 0, timer = null, saving = false;
  let segments = [], distance = 0, moving = 0, climb = 0, level = null, lastTime = 0;
  let listener = () => {};

  function reset() { offset = 0; segments = []; distance = 0; moving = 0; climb = 0; level = null; lastTime = 0; }

  /* One recorded line. Small jitters while standing still and wild jumps are left out. */
  function add(text) {
    const [seg, time, lat, lon, alt, accuracy] = text.split(",").map((v, i) => i === 4 && v === "" ? null : Number(v));
    if (!isFinite(lat) || !isFinite(lon) || accuracy > 40) return;
    const point = [lon, lat, alt, time];
    lastTime = time;
    let current = segments[segments.length - 1];
    if (!current || current.seg !== seg) { segments.push({ seg, points: [point] }); level = alt; return; }
    const previous = current.points[current.points.length - 1];
    const step = haversine(previous, point), seconds = (time - previous[3]) / 1000;
    if (step < Math.max(6, accuracy * 0.6) || (seconds > 0 && step / seconds > 15)) return;
    current.points.push(point);
    distance += step;
    moving += Math.min(seconds, step / 0.3); // time spent standing still doesn't count
    if (alt != null) { // GPS heights wobble, so only count changes of 10 m or more
      if (level == null) level = alt;
      else if (alt - level >= 10) { climb += alt - level; level = alt; }
      else if (level - alt >= 10) level = alt;
    }
  }

  const lines = () => segments.filter(s => s.points.length > 1).map(s => s.points.map(p => [p[0], p[1]]));
  const draw = () => setData("track", { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines() } });

  function poll() {
    const b = bridge(); if (!b) return;
    const s = JSON.parse(b.trackState());
    if (s.started !== started) { started = s.started || 0; reset(); }
    status = s.status === "recording" && !s.running ? "interrupted" : s.status;
    let changed = false;
    if (status !== "idle") for (let i = 0; i < 50; i++) { // a long walk arrives in several pieces
      const r = JSON.parse(b.trackRead(offset)); if (!r.data) break;
      offset = r.offset; r.data.split("\n").filter(Boolean).forEach(add); changed = true;
    }
    if (changed || status === "idle") draw();
    const live = status === "recording" && !document.hidden;
    if (live && !timer) timer = setInterval(poll, 2000);
    if (!live && timer) { clearInterval(timer); timer = null; }
    listener();
  }

  function command(name) {
    const b = bridge(); if (!b) return;
    if (b.trackMode) b.trackMode(SETTINGS.gps);
    const answer = b[name]();
    if (answer === "permission") toast("Allow precise location first, then try again.");
    else if (answer === "off") toast("Switch on Location first, then try again.");
    else if (answer && answer !== "ok") toast("Recording couldn't start. Try again.");
    poll(); setTimeout(poll, 800);
  }

  function figures() {
    const end = status === "recording" ? Date.now() : lastTime || started;
    return { distance, moving, elapsed: started ? Math.max(0, (end - started) / 1000) : 0, climb, points: segments.reduce((n, s) => n + s.points.length, 0) };
  }

  /* Drops points that add nothing (within 3 m of a straight line) so saved walks stay small. */
  function simplify(points, tolerance = 3) {
    if (points.length < 3) return points;
    const keep = new Set([0, points.length - 1]), todo = [[0, points.length - 1]];
    while (todo.length) {
      const [a, b] = todo.pop(), k = Math.cos(points[a][1] * RAD) * 111320;
      const ax = points[a][0] * k, ay = points[a][1] * 110540, dx = points[b][0] * k - ax, dy = points[b][1] * 110540 - ay, len = dx * dx + dy * dy;
      let far = -1, worst = tolerance;
      for (let i = a + 1; i < b; i++) {
        const px = points[i][0] * k - ax, py = points[i][1] * 110540 - ay, t = len ? clamp((px * dx + py * dy) / len, 0, 1) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d > worst) { worst = d; far = i; }
      }
      if (far > 0) { keep.add(far); todo.push([a, far], [far, b]); }
    }
    return [...keep].sort((p, q) => p - q).map(i => points[i]);
  }

  async function save(name) {
    if (saving || !bridge()) return null;
    const walked = lines(); if (!walked.length) { toast("There isn't enough of a walk to save yet."); return null; }
    saving = true; listener();
    try {
      const f = figures();
      const parts = walked.map(l => simplify(l).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]));
      // heights from the map's height data are steadier than GPS; don't wait long for them with a weak signal
      const profile = await Promise.race([profileOf(parts.flat()).catch(() => null), new Promise(r => setTimeout(() => r(null), 12000))]);
      if (profile) profile.heights = profile.heights.map(h => Math.round(h));
      const series = Graphs.series(segments, started, profile && profile.heights);
      const track = { series, id: uid(), name: name.slice(0, 80), date: started, lines: parts, distance: f.distance, elapsed: f.elapsed, moving: f.moving, up: profile ? profile.up : f.climb, profile };
      SAVED.tracks.unshift(track);
      if (!persistSaved()) { SAVED.tracks.shift(); return null; } // keep the recording until it is safely saved
      bridge().trackClear();
      return track;
    } finally { saving = false; poll(); }
  }

  document.addEventListener("visibilitychange", poll);
  return {
    poll, save, figures, lines,
    series: () => Graphs.series(segments, started),
    supported: () => !!bridge(),
    status: () => status,
    saving: () => saving,
    active: () => status !== "idle",
    hasModes: () => !!(bridge() && bridge().trackMode),
    setMode(mode) { const b = bridge(); if (b && b.trackMode) b.trackMode(mode); },
    start: () => command("trackStart"),
    pause: () => command("trackPause"),
    resume: () => command("trackResume"),
    finish: () => command("trackStop"),
    discard() { if (bridge()) { bridge().trackClear(); poll(); } },
    onChange: f => { listener = f; }
  };
})();
