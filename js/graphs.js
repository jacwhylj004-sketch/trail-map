"use strict";
/* The graphs and splits for a recorded walk: distance, speed and height against time. Touch a graph to read
   a moment from it; the same moment is marked on every graph and on the map. */

const Graphs = (() => {
  const SAMPLES = 240;
  let shown = null, marker = null;

  const at = (xs, ys, x) => { // value of ys at x, joining the known points with straight lines
    if (x <= xs[0]) return ys[0];
    let lo = 0, hi = xs.length - 1;
    if (x >= xs[hi]) return ys[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const f = xs[hi] > xs[lo] ? (x - xs[lo]) / (xs[hi] - xs[lo]) : 0;
    return ys[lo] + (ys[hi] - ys[lo]) * f;
  };

  /* segments: [{ points: [[lon, lat, altitude, time in ms], ...] }], one for each stretch between pauses.
     Returns evenly spaced samples: time (s), distance (m), speed (m/s), height (m) and position. */
  function series(segments, started, heights) {
    const t = [], d = [], lon = [], lat = [], alt = [], spans = [];
    let total = 0;
    for (const s of segments) {
      if (s.points.length < 2) continue;
      let first = null;
      s.points.forEach((p, i) => {
        const time = (p[3] - started) / 1000;
        if (i) {
          const q = s.points[i - 1], step = haversine(q, p), seconds = time - (q[3] - started) / 1000;
          if (seconds > step / 0.3) { // you stopped: hold the distance until shortly before the next point
            t.push(time - step / 1.2); d.push(total); lon.push(q[0]); lat.push(q[1]); alt.push(q[2] == null ? NaN : q[2]);
          }
          total += step;
        }
        if (first == null) first = time;
        t.push(time); d.push(total); lon.push(p[0]); lat.push(p[1]); alt.push(p[2] == null ? NaN : p[2]);
      });
      spans.push([first, t[t.length - 1]]);
    }
    if (!spans.length || total < 20) return null;
    const from = spans[0][0], to = spans[spans.length - 1][1], n = Math.min(SAMPLES, Math.max(20, Math.round((to - from) / 5)));
    const known = alt.map((a, i) => i).filter(i => isFinite(alt[i])), kt = known.map(i => t[i]), ka = known.map(i => alt[i]);
    const half = Math.max(20, (to - from) / n); // speed is averaged over this long either side, to calm GPS jitter
    const out = { t: [], d: [], v: [], h: [], p: [] };
    for (let i = 0; i <= n; i++) {
      const x = from + (to - from) * i / n, span = spans.find(s => x >= s[0] - 0.01 && x <= s[1] + 0.01), dist = at(t, d, x);
      out.t.push(Math.round(x)); out.d.push(Math.round(dist));
      out.p.push([+at(t, lon, x).toFixed(5), +at(t, lat, x).toFixed(5)]);
      if (!span) { out.v.push(null); out.h.push(null); continue; } // paused
      const a = Math.max(span[0], x - half), b = Math.min(span[1], x + half);
      out.v.push(b > a ? +((at(t, d, b) - at(t, d, a)) / (b - a)).toFixed(2) : 0);
      let h = null;
      if (heights && heights.length > 1) { const f = dist / total * (heights.length - 1), k = Math.min(heights.length - 2, Math.floor(f)); h = heights[k] + (heights[k + 1] - heights[k]) * (f - k); }
      else if (known.length > 1) { let sum = 0, count = 0; for (let j = -3; j <= 3; j++) { sum += at(kt, ka, x + j * 8); count++; } h = sum / count; }
      out.h.push(h == null ? null : Math.round(h));
    }
    /* time for each kilometre or mile, not counting pauses */
    const active = x => spans.reduce((s, [a, b]) => s + Math.max(0, Math.min(x, b) - a), 0);
    const marks = metres => { const list = []; let last = 0, before = 0; for (let want = metres; before < total - 1; want += metres) { const here = Math.min(want, total), when = active(at(d, t, here)); list.push([Math.round(here - before), Math.round(when - last)]); last = when; before = here; } return list; };
    out.km = marks(1000); out.mi = marks(1609.344);
    return out;
  }

  const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };
  const pace = ms => ms > 0.2 ? clock((imperial() ? 1609.344 : 1000) / ms) + (imperial() ? " /mi" : " /km") : "–";

  /* A round number to end the y axis on. */
  function ceiling(v) { const p = 10 ** Math.floor(Math.log10(v || 1)); return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(k => k * p).find(k => k >= v); }

  function chart(title, s, values, convert, unit, fromZero) {
    const ys = values.map(v => v == null ? null : convert(v)), known = ys.filter(v => v != null);
    if (known.length < 2) return "";
    let low = 0, high = ceiling(Math.max(...known) || 1);
    if (!fromZero) { const min = Math.min(...known), max = Math.max(...known), step = ceiling(Math.max(10, max - min) / 4); low = Math.floor(min / step) * step; high = low + Math.max(1, Math.ceil((max - low) / (2 * step))) * 2 * step; }
    const t0 = s.t[0], span = s.t[s.t.length - 1] - t0 || 1, x = i => ((s.t[i] - t0) / span * 300).toFixed(1), y = v => (100 - (v - low) / (high - low) * 96).toFixed(1);
    let line = "", area = "", run = [];
    const flush = () => { if (run.length > 1) { const path = run.map(i => `${x(i)} ${y(ys[i])}`).join("L"); line += "M" + path; area += `M${x(run[0])} 100L${path}L${x(run[run.length - 1])} 100Z`; } run = []; };
    ys.forEach((v, i) => { if (v == null) flush(); else run.push(i); });
    flush();
    const num = v => +v.toFixed(v < 10 && v % 1 ? 1 : 0);
    return `<figure class="graph"><figcaption>${title} <span>${unit}</span></figcaption>
      <div class="plot"><div class="ylab"><span>${num(high)}</span><span>${num((high + low) / 2)}</span><span>${num(low)}</span></div>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="${title} against time, from ${num(Math.min(...known))} to ${num(Math.max(...known))} ${unit}">
          <path class="grid" d="M0 4H300M0 52H300M0 100H300"/><path class="fill" d="${area}"/><path class="line" d="${line}"/><line class="cursor" y1="0" y2="100" visibility="hidden"/></svg></div>
      <div class="xlab"><span>0:00</span><span>${clock(span / 2)}</span><span>${clock(span)}</span></div></figure>`;
  }

  /* s: from series(). Returns the HTML for the graphs and the splits table. */
  function html(s) {
    shown = s;
    if (!s) return '<p class="muted small">Not enough of a walk to draw graphs.</p>';
    const mi = imperial(), splits = mi ? s.mi : s.km, unit = mi ? 1609.344 : 1000;
    const fastest = Math.max(...s.v.filter(v => v != null));
    const rows = splits.map(([metres, secs], i) => `<tr><th>${metres < unit * 0.98 ? (metres / unit).toFixed(2) : i + 1}</th><td>${clock(secs)}</td><td>${pace(metres / secs)}</td><td>${fmtSpeed(secs ? metres / secs : null)}</td></tr>`).join("");
    return `<p class="small muted">Fastest speed ${fmtSpeed(fastest)}. Touch a graph to see any moment, also marked on the map.</p>
      <div id="graphs"><p id="graph-read" class="small" aria-live="polite">&nbsp;</p>
        ${chart("Distance", s, s.d, m => m / unit, mi ? "miles" : "km", true)}
        ${chart("Speed", s, s.v, v => v * (mi ? 2.23694 : 3.6), mi ? "mph" : "km/h", true)}
        ${chart("Height", s, s.h, h => h * (mi ? 3.28084 : 1), mi ? "feet" : "metres", false)}</div>
      <h3>Splits</h3><table class="splits"><thead><tr><th>${mi ? "Mile" : "Km"}</th><th>Time</th><th>Pace</th><th>Speed</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function clear() { if (marker) marker.remove(); marker = null; }
  function read(e) {
    const svg = e.target.closest && e.target.closest(".graph svg");
    if (!svg || !shown) return;
    const box = svg.getBoundingClientRect(), s = shown, t0 = s.t[0], want = t0 + clamp((e.clientX - box.left) / box.width, 0, 1) * (s.t[s.t.length - 1] - t0);
    let i = 0; s.t.forEach((t, k) => { if (Math.abs(t - want) < Math.abs(s.t[i] - want)) i = k; });
    const x = ((s.t[i] - t0) / (s.t[s.t.length - 1] - t0 || 1) * 300).toFixed(1);
    document.querySelectorAll("#graphs .cursor").forEach(l => { l.setAttribute("x1", x); l.setAttribute("x2", x); l.removeAttribute("visibility"); });
    $("#graph-read").textContent = [clock(s.t[i] - t0), fmtDist(s.d[i]), s.v[i] == null ? "paused" : fmtSpeed(s.v[i]) + " (" + pace(s.v[i]) + ")", s.h[i] == null ? "" : fmtHeight(s.h[i])].filter(Boolean).join(" · ");
    if (!marker) { const el = document.createElement("div"); el.className = "graph-mark"; marker = new maplibregl.Marker({ element: el }).setLngLat(s.p[i]).addTo(map); }
    else marker.setLngLat(s.p[i]);
  }
  document.addEventListener("pointerdown", read);
  document.addEventListener("pointermove", read);

  return { series, html, clear };
})();
