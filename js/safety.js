"use strict";
/* What a walker should know about a route before and during it: stretches along main roads and other hazards, and
   a graph of its hills. The warnings come from what OpenStreetMap says about each way, so a missing warning is not
   a promise that a road is safe. */

const Safety = (() => {
  /* level: "danger" or "care"; say: how it is spoken after "In 150 metres, you will…"; min: shorter than this is
     only a crossing, not walking along it */
  const KINDS = {
    "main": { level: "danger", title: "Main road, no pavement mapped", say: "walk along a main road with no pavement mapped", min: 25 },
    "main-check": { level: "danger", title: "Main road: check for a pavement", say: "walk along a main road. Check for a pavement", min: 25 },
    "main-paved": { level: "care", title: "Main road with a pavement", say: "walk beside a main road", min: 60 },
    "road": { level: "care", title: "B road, no pavement mapped", say: "walk along a B road with no pavement mapped", min: 30 },
    "road-check": { level: "care", title: "B road: check for a pavement", say: "walk along a B road", min: 30 },
    "through": { level: "care", title: "Through road, no pavement mapped", say: "walk along a road with no pavement mapped", min: 50 },
    "through-check": { level: "care", title: "Through road: watch for traffic", say: "walk along a through road", min: 50 },
    "hard": { level: "danger", title: "Difficult mountain path", say: "reach a difficult mountain path", min: 0 },
    "ford": { level: "care", title: "Ford: water to cross", say: "reach a ford", min: 0, point: true },
    "rail": { level: "care", title: "Railway crossing", say: "cross a railway", min: 0, point: true }
  };
  const SIGN = level => `<svg class="sign ${level}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.500 23 21.500H1z" fill="currentColor"/><path d="M12 9v6M12 18v.5" stroke="${level === "danger" ? "#fff" : "#1b1b21"}" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>`;

  /* ---- finding the warnings ---- */
  /* The kinds of warning for one stretch of way. tags: from OpenStreetMap; mapped: the source says where pavements are. */
  function kindsOf(cls, tags, mapped) {
    const out = [], pavement = Object.keys(tags).some(k => /^sidewalk(:(left|right|both))?$/.test(k) && /^(yes|both|left|right|separate)$/.test(tags[k]));
    const road = String(cls || "").replace(/_link$/, "");
    if (road === "trunk" || road === "primary") out.push(!mapped ? "main-check" : pavement ? "main-paved" : "main");
    else if (road === "secondary" && !pavement) out.push(mapped ? "road" : "road-check");
    else if (road === "tertiary" && !pavement) out.push(mapped ? "through" : "through-check");
    if (/^(demanding_mountain_hiking|alpine_hiking|demanding_alpine_hiking|difficult_alpine_hiking)$/.test(tags.sac_scale)) out.push("hard");
    if (/^(yes|stepping_stones)$/.test(tags.ford) || tags.highway === "ford") out.push("ford");
    return out;
  }
  /* segments: the route in order, [{ len, cls, tags, node, mapped }]; node: tags of the point the stretch ends at.
     Returns [{ kind, from, to }] in metres along the route. */
  function find(segments) {
    const runs = new Map(), found = [];
    let along = 0;
    const add = (kind, from, to) => {
      const last = runs.get(kind);
      if (last && from - last.to < 60) { last.to = to; return; }
      const run = { kind, from, to }; runs.set(kind, run); found.push(run);
    };
    for (const s of segments) {
      for (const kind of kindsOf(s.cls, s.tags || {}, s.mapped)) add(kind, along, along + s.len);
      along += s.len;
      const n = s.node || {};
      if (/^(level_crossing|crossing)$/.test(n.railway)) add("rail", along, along);
      if (n.highway === "ford" || n.ford === "yes") add("ford", along, along);
    }
    return found.filter(h => h.to - h.from >= KINDS[h.kind].min).sort((a, b) => a.from - b.from);
  }

  const of = h => KINDS[h.kind];
  const where = h => [of(h).point ? "" : fmtDist(h.to - h.from) + (h.name ? " on " + h.name : ""), h.from < 30 ? "at the start" : fmtDist(h.from) + " from the start"].filter(Boolean).join(" · ");
  const countText = list => `${list.length} warning${list.length > 1 ? "s" : ""} on this route`;

  /* The list in the Directions panel. */
  function listHTML(r, walking) {
    if (!walking || r.hazards === undefined) return "";
    if (r.hazards === null) return `<p class="warn small">${SIGN("care")} Road warnings couldn’t be checked for this route. Look along it on the map before you go.</p>`;
    if (!r.hazards.length) return '<p class="muted small">No main-road walking, fords or railway crossings are mapped on this route. Still take care at every road.</p>';
    return drop("warn", `${SIGN(r.hazards.some(h => of(h).level === "danger") ? "danger" : "care")} ${countText(r.hazards)}`,
      r.hazards.map((h, i) => `<button class="item hazard" data-act="hazard-show" data-i="${i}">${SIGN(of(h).level)}<span class="grow">${of(h).title}<small>${esc(where(h))}</small></span></button>`).join("") +
      '<p class="muted small">From what OpenStreetMap says about each road. Pavements and hazards may be missing from it, so look before you walk.</p>', true);
  }

  /* ---- drop-downs that stay as you left them when the panel is redrawn ---- */
  const opened = {};
  const drop = (key, title, body, first = false) => `<details class="drop" data-drop="${key}" ${(key in opened ? opened[key] : first) ? "open" : ""}><summary>${title}</summary><div class="stack">${body}</div></details>`;
  document.addEventListener("toggle", e => { const k = e.target.dataset && e.target.dataset.drop; if (k) opened[k] = e.target.open; }, true);

  /* ---- the warnings on the map ---- */
  const pointAt = (coords, along) => {
    let before = 0;
    for (let i = 1; i < coords.length; i++) {
      const len = haversine(coords[i - 1], coords[i]);
      if (before + len >= along && len > 0) { const f = clamp((along - before) / len, 0, 1); return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f]; }
      before += len;
    }
    return coords[coords.length - 1];
  };
  function stretch(coords, from, to) {
    const out = [pointAt(coords, from)];
    let along = 0;
    for (let i = 1; i < coords.length; i++) { along += haversine(coords[i - 1], coords[i]); if (along > from && along < to) out.push(coords[i]); }
    out.push(pointAt(coords, to));
    return out;
  }
  function draw(r) {
    const list = (r && r.hazards) || [];
    setData("hazard", { type: "FeatureCollection", features: list.map(h => ({ type: "Feature", properties: { level: of(h).level },
      geometry: of(h).point ? { type: "Point", coordinates: pointAt(r.coords, h.from) } : { type: "LineString", coordinates: stretch(r.coords, h.from, h.to) } })) });
  }

  /* ---- the hill graph ---- */
  let shown = null, marker = null; // the route whose graph can be touched
  const x = (p, along) => (clamp(along / p.total, 0, 1) * 300).toFixed(1);
  const heightAt = (p, along) => { const f = clamp(along / p.total, 0, 1) * (p.heights.length - 1), i = Math.min(p.heights.length - 2, Math.floor(f)); return p.heights[i] + (p.heights[i + 1] - p.heights[i]) * (f - i); };
  /* Climb and drop still to come, ignoring tiny bumps in the height data. */
  function ahead(p, along) {
    let up = 0, down = 0, ref = heightAt(p, along);
    for (let i = Math.ceil(clamp(along / p.total, 0, 1) * (p.heights.length - 1)); i < p.heights.length; i++) { const d = p.heights[i] - ref; if (Math.abs(d) >= 4) { if (d > 0) up += d; else down -= d; ref = p.heights[i]; } }
    return { up, down };
  }
  /* r: a route with a profile. The hazards are shaded on it. */
  function graph(r) {
    const p = r.profile; if (!p) return "";
    shown = r;
    const mi = imperial(), conv = h => h * (mi ? 3.28084 : 1);
    /* at least 30 m from bottom to top, so flat ground doesn't look like mountains */
    const span = Math.max(30, p.max - p.min), low = p.min - (span - (p.max - p.min)) / 2, y = h => (96 - (h - low) / span * 90).toFixed(1);
    const line = p.heights.map((h, i) => (i ? "L" : "M") + (i / (p.heights.length - 1) * 300).toFixed(1) + " " + y(h)).join("");
    const scale = r.distance ? p.total / r.distance : 1;
    const bands = (r.hazards || []).map(h => { const a = +x(p, h.from * scale), b = +x(p, h.to * scale); return `<rect class="band ${of(h).level}" x="${Math.min(a, 298)}" y="0" width="${Math.max(2, b - a).toFixed(1)}" height="100"/>`; }).join("");
    const num = h => Math.round(conv(h));
    return `<figure class="hills"><figcaption>Height <span>${mi ? "feet" : "metres"}, along the route</span></figcaption>
      <p class="hill-read small" aria-live="polite">Touch the graph to read any point.</p>
      <div class="plot"><div class="ylab"><span>${num(low + span)}</span><span>${num(low + span / 2)}</span><span>${num(low)}</span></div>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Height along the route, from ${esc(fmtHeight(p.min))} to ${esc(fmtHeight(p.max))}">
          <path class="grid" d="M0 6H300M0 51H300M0 96H300"/>${bands}<path class="fill" d="${line}L300 100L0 100Z"/><path class="line" d="${line}"/>
          <line class="here" y1="0" y2="100" visibility="hidden"/><line class="cursor" y1="0" y2="100" visibility="hidden"/></svg></div>
      <div class="xlab"><span>Start</span><span>${fmtDist(p.total / 2)}</span><span>${fmtDist(p.total)}</span></div>
      <p class="muted small">Lowest ${fmtHeight(p.min)} · highest ${fmtHeight(p.max)} · climb ${fmtHeight(p.up)} · drop ${fmtHeight(p.down)}${bands ? " · shaded: road and path warnings" : ""}</p></figure>`;
  }
  function read(e) {
    const svg = e.target.closest && e.target.closest(".hills svg");
    if (!svg || !shown || !shown.profile) return;
    const box = svg.getBoundingClientRect(), p = shown.profile, along = clamp((e.clientX - box.left) / box.width, 0, 1) * p.total;
    const step = Math.max(50, p.total / (p.heights.length - 1)), a = Math.max(0, along - step / 2), b = Math.min(p.total, along + step / 2);
    const slope = b > a ? Math.round((heightAt(p, b) - heightAt(p, a)) / (b - a) * 100) : 0;
    const cursor = svg.querySelector(".cursor"); cursor.setAttribute("x1", x(p, along)); cursor.setAttribute("x2", x(p, along)); cursor.removeAttribute("visibility");
    svg.closest(".hills").querySelector(".hill-read").textContent = `${fmtDist(along)} · ${fmtHeight(heightAt(p, along))} · ${slope ? Math.abs(slope) + "% " + (slope > 0 ? "uphill" : "downhill") : "level"}`;
    const ll = pointAt(shown.coords, along);
    if (!marker) { const el = document.createElement("div"); el.className = "graph-mark"; marker = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map); }
    else marker.setLngLat(ll);
  }
  document.addEventListener("pointerdown", read);
  document.addEventListener("pointermove", read);
  function clear() { if (marker) marker.remove(); marker = null; }

  /* Marks how far along you are on a graph that is on screen. */
  function here(element, r, along) {
    const line = element.querySelector(".here"); if (!line || !r.profile) return;
    const at = x(r.profile, along * (r.distance ? r.profile.total / r.distance : 1));
    line.setAttribute("x1", at); line.setAttribute("x2", at); line.removeAttribute("visibility");
  }

  return { find, of, where, countText, listHTML, drop, draw, graph, ahead, here, clear, pointAt, stretch, sign: SIGN };
})();
