"use strict";
/* Turn-by-turn navigation along a route: the next turn and how far to it, spoken directions, the time left and when
   you will arrive, and a new route if you leave this one. It follows you while the app is on screen, which it keeps
   switched on. With no internet, new routes are worked out on the phone. */

const Nav = (() => {
  let nav = null; // the journey being followed

  /* ---- arrows ---- */
  const ANGLE = { straight: 0, "slight-right": 40, right: 90, "slight-left": -40, left: -90, depart: 0 };
  function arrow(dir) {
    const draw = d => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    if (dir === "arrive" || dir === "stop") return draw('<path d="M12 22s7-6.500 7-12a7 7 0 0 0-14 0c0 5.500 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>');
    if (dir === "uturn") return draw('<path d="M8 21V9a5 5 0 0 1 10 0v6"/><path d="m14 12 4 4 4-4"/>');
    if (dir === "round") return draw('<circle cx="12" cy="10" r="5"/><path d="M12 22v-7M16 6l4-4M15.500 2H20v4.500"/>');
    if (dir === "sharp-right") return draw('<path d="M7 21V5l10 11"/><path d="M17 9v7h-7"/>');
    if (dir === "sharp-left") return draw('<path d="M17 21V5L7 16"/><path d="M7 9v7h7"/>');
    const a = ANGLE[dir] || 0;
    if (!a) return draw('<path d="M12 21V4M6 10l6-6 6 6"/>');
    const r = a * RAD, tipX = 12 + 9 * Math.sin(r), tipY = 13 - 9 * Math.cos(r), head = (turn) => `${(tipX - 6.5 * Math.sin(r + turn)).toFixed(1)} ${(tipY + 6.5 * Math.cos(r + turn)).toFixed(1)}`;
    return draw(`<path d="M12 22v-9L${tipX.toFixed(1)} ${tipY.toFixed(1)}"/><path d="M${head(0.75)} L${tipX.toFixed(1)} ${tipY.toFixed(1)} L${head(-0.75)}"/>`);
  }
  const SPEAKER = on => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/>${on ? '<path d="M16.500 8.500a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/>' : '<path d="m16 9 6 6M22 9l-6 6"/>'}</svg>`;

  /* ---- voice: the Android app speaks; a web browser may be able to ---- */
  const canSpeak = () => !!(NATIVE && NATIVE.speak) || (!NATIVE && "speechSynthesis" in window);
  function say(text) {
    if (!nav || SETTINGS.mute || !canSpeak()) return;
    if (nav.opening) { text = nav.opening + ". " + text; nav.opening = ""; } // the first words aren't cut off by the next
    if (NATIVE) NATIVE.speak(text);
    else { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = "en-GB"; speechSynthesis.speak(u); }
  }
  const hush = () => { if (NATIVE && NATIVE.speak) NATIVE.speak(""); else if ("speechSynthesis" in window) speechSynthesis.cancel(); };
  /* A distance as you would say it. */
  function spoken(m) {
    if (imperial()) { const yd = m * 1.09361; return yd < 350 ? `${Math.max(10, Math.round(yd / 10) * 10)} yards` : `${(m / 1609.344).toFixed(1)} miles`; }
    return m < 950 ? `${Math.max(10, Math.round(m / (m < 100 ? 10 : 50)) * (m < 100 ? 10 : 50))} metres` : `${(m / 1000).toFixed(1)} kilometres`;
  }
  const lower = s => s.charAt(0).toLowerCase() + s.slice(1);

  /* ---- following the route ---- */
  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]) / RAD + 360) % 360;
  function measure() { const c = nav.route.coords; nav.cum = [0]; for (let i = 1; i < c.length; i++) nav.cum.push(nav.cum[i - 1] + haversine(c[i - 1], c[i])); }
  const total = () => nav.cum[nav.cum.length - 1];
  function pointAt(along) {
    const c = nav.route.coords; let i = 1; while (i < nav.cum.length - 1 && nav.cum[i] < along) i++;
    const a = c[i - 1], b = c[i], len = nav.cum[i] - nav.cum[i - 1], f = len ? clamp((along - nav.cum[i - 1]) / len, 0, 1) : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  /* Where you are on the route: near where you last were first, so a route that doubles back isn't confused. */
  function locate(ll) {
    const c = nav.route.coords, kx = Math.cos(ll[1] * RAD) * 111320, ky = 110540, all = [];
    for (let i = 1; i < c.length; i++) {
      const ax = (c[i - 1][0] - ll[0]) * kx, ay = (c[i - 1][1] - ll[1]) * ky, dx = (c[i][0] - c[i - 1][0]) * kx, dy = (c[i][1] - c[i - 1][1]) * ky, len = dx * dx + dy * dy;
      const f = len ? clamp(-(ax * dx + ay * dy) / len, 0, 1) : 0;
      all.push({ off: Math.hypot(ax + f * dx, ay + f * dy), along: nav.cum[i - 1] + f * (nav.cum[i] - nav.cum[i - 1]) });
    }
    const nearest = list => list.reduce((p, q) => q.off < p.off ? q : p);
    if (nav.along != null) {
      const close = all.filter(p => p.along > nav.along - 60 && p.along < nav.along + 300);
      if (close.length) { const best = nearest(close); if (best.off <= 40) return best; }
    }
    const least = nearest(all).off;
    return all.filter(p => p.off <= least + 12).reduce((p, q) => Math.abs(q.along - (nav.along || 0)) < Math.abs(p.along - (nav.along || 0)) ? q : p);
  }

  function camera(animate = true) {
    const pos = GPS.state.pos; if (!nav || !nav.follow || !pos) return;
    const car = nav.mode === "car", ahead = bearing(pointAt(nav.along || 0), pointAt(Math.min(total(), (nav.along || 0) + (car ? 80 : 30))));
    const facing = pos.course != null && pos.speed > 1.5 ? pos.course : !car && GPS.heading() != null ? GPS.heading() : ahead;
    map.easeTo({ center: pos.ll, zoom: car ? 16 : 17, bearing: facing, pitch: 45, padding: { top: Math.round(innerHeight * 0.35), bottom: 90, left: 0, right: 0 }, duration: animate ? 700 : 0 }, { gps: true });
  }

  function show(dir, big, text, then, off) {
    if (nav.dir !== dir) { nav.dir = dir; $("#nav-arrow").innerHTML = arrow(dir); }
    $("#nav-dist").textContent = big; $("#nav-text").textContent = text;
    $("#nav-then").textContent = then || ""; $("#nav-then").hidden = !then;
    $("#nav-top").classList.toggle("off", !!off);
  }
  function remaining(left) {
    const seconds = nav.route.distance ? nav.pace * left : 0;
    $("#nav-time").textContent = fmtTime(seconds);
    $("#nav-left").textContent = `${fmtDist(left)} · arrive ${clockAt(seconds)}`;
  }

  /* ---- warnings: the one you are on, or else the next one coming ---- */
  const WARN_AHEAD = 250, SAY_AHEAD = 160;
  function warning(along) {
    const on = nav.hazards.filter(h => !Safety.of(h).point && along >= h.from - 5 && along < h.to).sort((a, b) => (Safety.of(b).level === "danger") - (Safety.of(a).level === "danger"))[0];
    const next = nav.hazards.find(h => h.from > along - (Safety.of(h).point ? 10 : -5) && h.from - along <= WARN_AHEAD);
    /* a worse one just ahead is more important than a lesser one underfoot */
    const h = on && next && Safety.of(next).level === "danger" && Safety.of(on).level !== "danger" ? next : on || next;
    return h ? { h, on: h === on } : null;
  }
  function showWarning(w, along) {
    const box = $("#nav-warn");
    if (!w) { box.hidden = true; return; }
    const k = Safety.of(w.h), away = fmtDist(Math.max(0, Math.round((w.h.from - along) / 10) * 10)), more = fmtDist(Math.max(0, w.h.to - along));
    const html = `${Safety.sign(k.level)}<span><b>${w.on ? k.title : `In ${away}: ${k.title}`}</b><small>${w.on ? more + " more" : k.point ? "" : "for " + fmtDist(w.h.to - w.h.from)}${w.h.name ? " · " + esc(w.h.name) : ""}</small></span>`;
    box.className = k.level; box.hidden = false; if (box.innerHTML !== html) box.innerHTML = html;
  }
  /* Spoken once for each, as you come near it (or find yourself on it). */
  function warningWords(along) {
    const h = nav.hazards.find(h => !nav.said.has(h) && h.from - along <= SAY_AHEAD && (Safety.of(h).point ? h.from > along - 10 : h.to > along + 20));
    if (!h) return "";
    nav.said.add(h);
    const k = Safety.of(h), away = h.from - along;
    return `Caution. ${away > 30 ? "In " + spoken(away) : "Now"}, you ${away > 30 ? "will " : ""}${k.say}${!k.point && h.to - h.from > 80 ? " for " + spoken(h.to - Math.max(along, h.from)) : ""}`;
  }

  /* ---- the drop-down with the hill graph and the warnings still to come ---- */
  const HILLS = open => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 19 6-10 4 6 3-4 5 8z"/></svg><span>${open ? "Close" : "Elevation and warnings"}</span>`;
  function moreLive() {
    const box = $("#nav-more"); if (box.hidden || !nav) return;
    const along = nav.along || 0, r = nav.route, p = r.profile;
    if (p) { Safety.here(box, r, along); const a = Safety.ahead(p, along * (r.distance ? p.total / r.distance : 1)), t = box.querySelector("#nav-climb"); if (t) t.textContent = `Still to climb ${fmtHeight(a.up)}, drop ${fmtHeight(a.down)}`; }
    const left = nav.hazards.filter(h => h.to >= along - 10), list = box.querySelector("#nav-hazards");
    if (!list) return;
    const html = nav.mode !== "foot" ? "" : nav.route.hazards === null ? '<p class="warn small">Road warnings couldn’t be checked for this route.</p>' : !left.length ? '<p class="muted small">No more warnings mapped on this route.</p>'
      : left.map(h => `<div class="item">${Safety.sign(Safety.of(h).level)}<span class="grow">${Safety.of(h).title}<small>${h.from > along ? "In " + fmtDist(h.from - along) : "You are on it"}${Safety.of(h).point ? "" : " · " + fmtDist(h.to - Math.max(h.from, along))}${h.name ? " · " + esc(h.name) : ""}</small></span></div>`).join("");
    if (list.dataset.html !== html) { list.dataset.html = html; list.innerHTML = html; }
  }
  function moreDraw() {
    const box = $("#nav-more"); if (box.hidden || !nav) return;
    const p = nav.route.profile;
    const graph = p ? Safety.graph(Object.assign({}, nav.route, { hazards: nav.mode === "foot" ? nav.route.hazards : [] })) : `<p class="muted small">${p === undefined ? "Getting the heights…" : "Height data isn’t available here while offline."}</p>`;
    box.innerHTML = `${p ? '<p id="nav-climb"></p>' : ""}${graph}<div id="nav-hazards" class="stack"></div>`;
    moreLive();
  }
  function more(open = $("#nav-more").hidden) {
    $("#nav-more").hidden = !open; $("#nav-more-btn").innerHTML = HILLS(open); $("#nav-more-btn").setAttribute("aria-expanded", String(open));
    if (open) moreDraw(); else Safety.clear();
  }

  async function reroute(pos) {
    if (nav.busy) return;
    const mine = nav; nav.busy = true; nav.rerouted = Date.now();
    show("uturn", "New route…", "You've left the route. Finding another way.", "", true); say("Finding a new route");
    try {
      const ahead = mine.stops.filter(s => s.along > (mine.along || 0) + 30).map(s => s.ll);
      const found = await Plan.find([pos.ll, ...ahead, mine.end], mine.mode, () => {}, () => nav !== mine);
      if (nav !== mine || !found) return;
      use(found); mine.changed = true; mine.off = 0; mine.failed = ""; mine.busy = false; update(true);
    } catch (e) { if (nav === mine) { mine.failed = e.message; mine.busy = false; update(true); } }
  }

  /* Starts following a route (the first, or a new one). */
  function use(route) {
    const passed = nav.stops ? nav.stops.filter(s => s.along > (nav.along || 0) + 30) : null;
    nav.route = route; nav.along = null; nav.said = new Set(); nav.dir = null; measure();
    nav.turns = route.turns && route.turns.length ? route.turns.filter(t => t.dir !== "depart") : [{ along: total(), dir: "arrive", text: "Arrive at your destination" }];
    nav.start = route.turns && route.turns.find(t => t.dir === "depart");
    /* the route's own distances can differ a little from those measured along the line */
    const scale = route.distance ? total() / route.distance : 1;
    nav.turns = nav.turns.map(t => Object.assign({}, t, { along: t.dir === "arrive" ? total() : Math.min(total(), t.along * scale) }));
    nav.hazards = nav.mode === "foot" && route.hazards ? route.hazards.map(h => Object.assign({}, h, { from: Math.min(total(), h.from * scale), to: Math.min(total(), h.to * scale) })) : [];
    nav.pace = route.distance ? (route.duration || walkSeconds(route.distance, route.profile ? route.profile.up : 0)) / route.distance : 0.72;
    if (nav.mode === "foot" && route.profile && route.distance) nav.pace = walkSeconds(route.distance, route.profile.up) / route.distance;
    /* stops in between, so a new route still goes through them */
    const between = nav.turns.filter(t => t.dir === "stop");
    nav.stops = passed ? passed.map((s, i) => ({ ll: s.ll, along: between[i] ? between[i].along : total() })) : between.map((t, i) => ({ ll: nav.via[i] || pointAt(t.along), along: t.along }));
    setData("plan", lineFeature(route.coords)); Safety.draw(nav.mode === "foot" ? route : null);
    showWarning(null); moreDraw();
    if (route.profile === undefined) { const mine = nav; profileOf(route.coords).then(p => { route.profile = p; if (nav === mine && nav.route === route) moreDraw(); }).catch(() => {}); }
  }

  function update(force) {
    if (!nav || !nav.route) return;
    const pos = GPS.state.pos;
    if (!pos) { show("depart", "Waiting for GPS…", GPS.state.error || "Looking for your position.", "", false); remaining(total()); return; }
    if (!force && pos.time === nav.time) return;
    nav.time = pos.time;
    if (nav.busy) { camera(); return; }
    const here = locate(pos.ll), allowed = Math.max(nav.mode === "car" ? 50 : 35, pos.accuracy * 1.3), off = here.off > allowed;
    if (!off) { nav.along = here.along; nav.off = 0; nav.joined = true; nav.failed = ""; }
    else if (pos.accuracy < 60) nav.off++;
    const along = nav.along || 0, left = Math.max(0, total() - along);
    camera(); moreLive();
    showWarning(off ? null : warning(along), along);

    if (off) {
      /* Starting somewhere else (a route from another place): show the way to its start rather than replacing it. */
      if (!nav.joined && !nav.fromMe) { show("depart", fmtDist(haversine(pos.ll, nav.route.coords[0])), "Go to the start of the route", "", true); remaining(total()); return; }
      if (nav.off >= 3 && Date.now() - nav.rerouted > (nav.failed ? 45000 : 12000)) { reroute(pos); return; }
      if (nav.off >= 3 || !nav.joined) { show("depart", `${fmtDist(here.off)} away`, nav.failed ? "Off the route. " + nav.failed : "Head to the highlighted route", "", true); remaining(left); return; }
    }

    const end = nav.route.coords[nav.route.coords.length - 1];
    if (nav.joined && left < (nav.mode === "car" ? 35 : 20) && haversine(pos.ll, end) < allowed) {
      show("arrive", "You have arrived", nav.name, "", false); remaining(0);
      if (!nav.said.has("arrived")) { nav.said.add("arrived"); say("You have arrived"); }
      return;
    }
    const i = nav.turns.findIndex(t => t.along > along + 6), turn = nav.turns[i] || nav.turns[nav.turns.length - 1], after = nav.turns[i + 1];
    const to = Math.max(0, turn.along - along), now = nav.mode === "car" ? 40 : nav.mode === "bike" ? 30 : 18;
    const soon = after && after.along - turn.along < now * 3 ? "Then " + lower(after.text) : "";
    show(turn.dir, to < now / 2 ? "Now" : fmtDist(to < 100 ? Math.round(to / 5) * 5 : to), turn.text, soon, false);
    remaining(left);

    /* what to say, and when: once well before the turn, and again as you reach it */
    const early = nav.mode === "car" ? 450 : nav.mode === "bike" ? 180 : 90, key = Math.round(turn.along);
    if (!nav.joined) return;
    let words = "";
    if (to <= now) {
      if (!nav.said.has("now" + key)) { nav.said.add("now" + key); nav.said.add("soon" + key); words = turn.text + (soon ? ". " + soon : ""); }
    } else if (to <= early && !nav.said.has("soon" + key)) {
      nav.said.add("soon" + key); words = `In ${spoken(to)}, ${lower(turn.text)}`;
    } else if (!nav.said.has("long" + key) && to > early * 2.5) {
      nav.said.add("long" + key); words = `Continue for ${spoken(to)}`;
    }
    /* said in one breath, as new words cut off old ones */
    words = [words, warningWords(along)].filter(Boolean).join(". ");
    if (words) say(words);
  }

  function buttons() {
    const on = !SETTINGS.mute && canSpeak();
    $("#nav-voice").innerHTML = SPEAKER(on); $("#nav-voice").setAttribute("aria-pressed", String(on));
    $("#nav-view").textContent = nav.follow ? "Overview" : "Re-centre";
    $("#nav-view").classList.toggle("needed", !nav.follow); // shown even when the bars are small
  }

  function start() {
    const s = Plan.state, r = s.result;
    if (!r || s.measure || r.coords.length < 2) return;
    const stops = r.saved ? [] : s.stops, last = stops[stops.length - 1];
    nav = { mode: (r.saved ? r.mode : s.mode) || "foot", end: r.coords[r.coords.length - 1], name: r.saved ? r.saved.name : last ? last.name : "Your destination",
      fromMe: !!(stops[0] && stops[0].me), via: stops.slice(1, -1).map(p => p.ll).filter(Boolean), follow: true, off: 0, joined: false, busy: false, rerouted: 0, time: 0, failed: "" };
    closeSheet(); if (Back.active()) $("#back").hidden = true;
    document.body.classList.add("navigating"); $("#nav-top").hidden = false; $("#nav-bottom").hidden = false;
    GPS.setFollow("off"); GPS.start(); keepAwake(true); map.resize();
    use(r); buttons(); more(false);
    nav.opening = (nav.start ? nav.start.text : "Starting navigation") + (nav.hazards.length ? `. This route has ${nav.hazards.length === 1 ? "one warning" : nav.hazards.length + " warnings"}` : "");
    update(true); camera(false);
    if (nav.opening) { const words = nav.opening; nav.opening = ""; say(words); }
    if (!canSpeak() && NATIVE) toast("Spoken directions need the newest Trail Map app file.");
  }

  function stop() {
    if (!nav) return;
    const route = nav.route, recalculate = nav.changed && !(Plan.state.result && Plan.state.result.saved);
    hush(); more(false); nav = null;
    document.body.classList.remove("navigating"); $("#nav-top").hidden = true; $("#nav-bottom").hidden = true;
    keepAwake(SETTINGS.awake || !!Offline.job()); map.resize();
    map.easeTo({ pitch: SETTINGS.relief3d !== "off" ? 55 : 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 400 });
    Back.update();
    UI.tab = "directions"; window.nav(); openSheet("directions");
    if (recalculate) Plan.calculate(); // you went another way: show the route from where you are now
    else { setData("plan", lineFeature(route.coords)); Safety.draw(Plan.state.result && Plan.state.result.mode === "foot" ? Plan.state.result : null); fit(route.coords); }
  }

  /* Overview of the whole route, or back to following. */
  function view() {
    if (!nav) return;
    nav.follow = !nav.follow; buttons();
    if (nav.follow) { camera(); return; }
    const b = boundsOf(nav.route.coords);
    map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 0 });
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 150, bottom: 130, left: 40, right: 40 }, maxZoom: 16 });
  }
  function voice() {
    if (!canSpeak()) { toast("Spoken directions need the newest Trail Map app file."); return; }
    SETTINGS.mute = !SETTINGS.mute; saveSettings(); buttons();
    if (SETTINGS.mute) hush(); else say("Voice on");
  }
  async function ask() { if (await dialog({ title: "Stop navigating?", yes: "Stop" })) stop(); }

  /* Moving the map yourself pauses following. Called once the map exists. */
  function attach() { map.on("dragstart", () => { if (nav && nav.follow) { nav.follow = false; buttons(); } }); }
  document.addEventListener("visibilitychange", () => { if (nav && !document.hidden) keepAwake(true); });

  return { start, stop, update: () => update(false), view, voice, more: () => more(), ask, attach, active: () => !!nav };
})();
