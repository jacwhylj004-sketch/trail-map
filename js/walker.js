"use strict";
/* Walking directions from the internet, from BRouter (brouter.de, a free service) with our own walking rules
   (vendor/walking.brf.txt), which go well out of the way to avoid main roads and never use roads that are only
   planned. It says what each way is, which the warnings need. It gives the turns but no street names; those are read
   from the map. */

const Walker = (() => {
  const tagsOf = text => Object.fromEntries(String(text || "").split(" ").filter(Boolean).map(p => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  /* BRouter's turn numbers; others are worked out from the angle. */
  const TURNS = { 1: "straight", 2: "left", 3: "slight-left", 4: "sharp-left", 5: "right", 6: "slight-right", 7: "sharp-right", 8: "keep-left", 9: "keep-right", 13: "round", 14: "round", 15: "uturn" };
  const byAngle = a => Math.abs(a) > 160 ? "uturn" : Math.abs(a) < 20 ? "straight" : (Math.abs(a) < 55 ? "slight-" : Math.abs(a) > 120 ? "sharp-" : "") + (a < 0 ? "left" : "right");
  function words(turn, name, exit) {
    const onto = name ? " onto " + name : "", side = turn.endsWith("left") ? "left" : "right";
    if (turn === "round") return `At the roundabout take exit ${Math.abs(exit) || 1}${onto}`;
    if (turn === "uturn") return "Turn back" + onto;
    if (turn === "straight") return name ? "Continue onto " + name : "Continue straight on";
    if (turn.startsWith("keep")) return `Keep ${side}${onto}`;
    if (turn.startsWith("slight")) return `Bear ${side}${onto}`;
    return `Turn ${turn.startsWith("sharp") ? "sharp " : ""}${side}${onto}`;
  }

  /* The server keeps an uploaded set of rules for a while: use the one sent before, or send them again. */
  async function rules(fresh) {
    const text = new TextDecoder().decode((await fetchTimeout("vendor/walking.brf.txt", {}, 10000)).buf);
    const had = loadJSON("tm-walkrules", null);
    if (!fresh && had && had.size === text.length) return { id: had.id, old: true };
    const r = await fetchTimeout("https://brouter.de/brouter/profile", { method: "POST", headers: { "Content-Type": "text/plain" }, body: text }, 20000);
    const reply = r.json();
    if (!r.ok || !reply.profileid || reply.error) throw new Error("The walking rules weren't accepted");
    saveJSON("tm-walkrules", { id: reply.profileid, size: text.length });
    return { id: reply.profileid, old: false };
  }
  async function ask(stops) {
    const url = id => "https://brouter.de/brouter?lonlats=" + stops.map(p => p[0].toFixed(6) + "," + p[1].toFixed(6)).join("%7C") + `&profile=${id}&alternativeidx=0&format=geojson&timode=2`;
    const used = await rules(false);
    const r = await fetchTimeout(url(used.id), {}, 25000);
    if (r.ok || !used.old) return r;
    return fetchTimeout(url((await rules(true)).id), {}, 25000); // the server had forgotten them
  }

  async function route(stops) {
    const r = await ask(stops);
    const feature = r.json().features[0], p = feature.properties; // an error comes as plain words, which fail here
    const points = feature.geometry.coordinates, coords = points.map(c => [c[0], c[1]]);
    if (coords.length < 2) throw new Error("No route");
    const cum = [0]; for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    const distance = cum[cum.length - 1];

    const column = name => p.messages[0].indexOf(name), len = column("Distance"), way = column("WayTags"), node = column("NodeTags");
    const segments = p.messages.slice(1).map(m => { const tags = tagsOf(m[way]); return { len: +m[len], cls: tags.highway, tags, node: tagsOf(m[node]), mapped: true }; });
    const stated = segments.reduce((n, s) => n + s.len, 0), scale = stated ? distance / stated : 1; // fit them to the line
    segments.forEach(s => { s.len *= scale; });
    if (segments.some(s => /^(proposed|construction|abandoned)$/.test(s.cls))) throw new Error("The route used a road that isn't there");
    const hazards = Safety.find(segments);

    const hints = (p.voicehints || []).filter(h => cum[h[0]] > 12 && cum[h[0]] < distance - 5)
      .map(h => ({ along: cum[h[0]], turn: TURNS[h[1]] || byAngle(h[4]), exit: h[2] }));
    /* the names: just after the start, just after each turn, and half way along each warning */
    const spots = [Math.min(12, distance / 2), ...hints.map(h => h.along + 12), ...hazards.map(h => (h.from + h.to) / 2)];
    const names = await Router.names(coords, spots).catch(() => spots.map(() => ""));
    hazards.forEach((h, i) => { h.name = Safety.of(h).point ? "" : names[1 + hints.length + i]; });

    const turns = [];
    let on = names[0];
    hints.forEach((h, i) => {
      const name = names[i + 1], same = !!name && name === on; on = name;
      if (h.turn === "straight" && (!name || same)) return; // nothing to do
      const dir = h.turn.startsWith("keep") ? h.turn.replace("keep", "slight") : h.turn;
      turns.push({ along: h.along, dir, text: words(h.turn, same ? "" : name, h.exit) });
    });
    const heading = Math.atan2((Safety.pointAt(coords, 25)[0] - coords[0][0]) * Math.cos(coords[0][1] * RAD), Safety.pointAt(coords, 25)[1] - coords[0][1]) / RAD;
    const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][(Math.round(heading / 45) + 8) % 8];
    turns.unshift({ along: 0, dir: "depart", text: `Head ${compass}${names[0] ? " on " + names[0] : ""}` });
    /* stops in between: the place on the line nearest to each, in order */
    let from = 0;
    for (const stop of stops.slice(1, -1)) {
      let best = from;
      for (let i = from; i < coords.length; i++) if (haversine(coords[i], stop) < haversine(coords[best], stop)) best = i;
      from = best; turns.push({ along: cum[best], dir: "stop", text: "You reach a stop on your route" });
    }
    turns.sort((a, b) => a.along - b.along);
    turns.push({ along: distance, dir: "arrive", text: "Arrive at your destination" });

    const heights = points.map(c => c[2]), ends = [haversine(stops[0], coords[0]), haversine(stops[stops.length - 1], coords[coords.length - 1])];
    return { coords, distance, duration: +p["total-time"] || distance / (5 / 3.6), turns, hazards, from: "net", gaps: ends,
      heights: heights.every(h => typeof h === "number") ? heights : null };
  }

  return { route };
})();
