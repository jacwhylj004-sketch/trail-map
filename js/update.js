"use strict";
/* The Update button: looks for a newer version online and asks the Android app to install it. */

const Update = (() => {
  const SITE = "https://jacwhylj004-sketch.github.io/trail-map/";
  const state = { current: null, latest: null, checking: false, progress: null, message: "" };
  let listener = () => {};
  const changed = () => listener();

  const available = () => !!(state.current && state.latest && state.latest.build > state.current.build);
  const needsApp = () => available() && (!NATIVE || !NATIVE.installUpdate || state.latest.shell > NATIVE.shellVersion());

  async function loadCurrent() {
    if (!state.current) state.current = (await fetchTimeout("version.json", {}, 8000)).json();
  }
  async function check(asked) {
    if (state.checking || state.progress) return;
    state.checking = true; state.message = ""; changed();
    try {
      await loadCurrent();
      if (online()) {
        const r = await fetchTimeout(SITE + "update.json?t=" + Date.now(), { cache: "no-store" }, 12000);
        if (!r.ok) throw new Error("server " + r.status);
        state.latest = r.json();
        if (asked && !available()) state.message = "You have the newest version.";
        if (!asked && available()) toast("An update is ready. Open Settings.");
      } else if (asked) state.message = needsNet("Connect to the internet to check for updates.");
    } catch (e) { if (asked) state.message = "Couldn't check for updates. Try again later."; }
    state.checking = false; changed();
  }
  function install() {
    if (!available() || needsApp() || state.progress) return;
    if (dataBlocked) { state.message = NO_DATA; changed(); return; }
    if (Offline.job()) { state.message = "Wait for the map download to finish, then update."; changed(); return; }
    state.progress = { done: 0, total: state.latest.files.length }; state.message = ""; changed();
    NATIVE.installUpdate(); // the app restarts itself on the new version when this finishes
  }
  window.onUpdate = u => {
    if (u.error) { state.progress = null; state.message = u.error; changed(); }
    else if (u.done === u.total || u.done % 5 === 0) { state.progress = u; changed(); }
  };

  function panel() {
    const c = state.current, l = state.latest, p = state.progress;
    const version = c ? `<p class="small">You have version ${esc(c.name)}.</p>` : "";
    if (p) return `${version}<p>Updating… keep the app open.</p><progress max="${p.total}" value="${p.done}"></progress>`;
    let body = "";
    if (available()) {
      body = `<p><strong>Version ${esc(l.name)} is ready.</strong></p>${l.notes ? `<p class="small">${esc(l.notes)}</p>` : ""}` +
        (needsApp() ? '<p class="warn small">This one needs a new app file. Ask Claude for it.</p>'
          : '<button class="btn primary" data-act="update-install">Update</button><p class="muted small">Your offline maps, saved places and walks are kept.</p>');
    }
    return `${version}${body}${state.message ? `<p class="small" role="status">${esc(state.message)}</p>` : ""}<button class="btn" data-act="update-check" ${state.checking ? "disabled" : ""}>${state.checking ? "Checking…" : "Check for updates"}</button>`;
  }

  return { check, install, panel, available, onChange: f => { listener = f; } };
})();
