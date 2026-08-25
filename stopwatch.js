// OldLite native plugin — Stopwatch
//
// Two independent clocks stacked in one tab: a count-up stopwatch (with
// laps) on top, a count-down timer (with a settable minute/second target)
// below it, and a shared Controls section at the bottom for rebinding
// every button to a hotkey. Same "always on, own rail icon" shape as
// Calculator — see that file for the fuller writeup on native plugins.
//
// TIMEKEEPING: neither clock accumulates by counting ticks. Each engine
// stores a wall-clock `startedAt` timestamp for its current running
// segment plus whatever was already banked before that segment
// (`accumulatedMs` for the stopwatch, `remainingMs` for the countdown).
// Elapsed/remaining time is always *derived* from Date.now() vs that
// timestamp, never incremented tick-by-tick. That makes both clocks
// immune to tick throttling (backgrounded tabs, GC pauses, etc.) and
// means engine state only needs to be persisted on start/stop/reset/lap
// — not on every tick — since a reload can always reconstruct "where the
// clock should be right now" from the last timestamp.
//
// POP-OUTS: two independent floating windows (one per clock), same
// drag/resize/z-order mechanics as Calculator's single pop-out — factored
// here into generic wireDrag()/wireResize()/bringToFront() so both
// instances share the code.
//
// HOTKEYS: the loader has no hotkey system of its own, so this plugin
// owns a single `window` keydown listener for its whole lifetime,
// matching bindings against a small action table. Rebinding is done
// in-place: clicking a hotkey field arms a "waiting for a key" capture
// mode that the same listener also feeds. That listener lives on
// `window`, not inside api.container, so unlike everything else in this
// plugin it is NOT cleaned up by api.__cleanup() — destroy() has to tear
// it down by hand.

const SW_ENGINE_KEY = 'swEngine';
const CD_ENGINE_KEY = 'cdEngine';
const HOTKEYS_KEY = 'hotkeys';
const SW_POPOUT_KEY = 'swPopoutState';
const CD_POPOUT_KEY = 'cdPopoutState';

const SW_POPOUT_DEFAULT = { width: 240, height: 330 };
const SW_POPOUT_MIN = { width: 170, height: 210 };
const CD_POPOUT_DEFAULT = { width: 240, height: 250 };
const CD_POPOUT_MIN = { width: 170, height: 190 };

// Font/button sizes scale linearly with a popout's width, same technique
// as Calculator's popout.
const POPOUT_BASE_HEADER_FONT = 12;
const POPOUT_BASE_DISPLAY_FONT = 24;
const POPOUT_BASE_BUTTON_FONT = 12;

const DEFAULT_HOTKEYS = {
  swToggle: { key: 'T', shift: true, ctrl: false, alt: false },
  swReset: null,
  swLap: null,
  cdToggle: { key: 'Y', shift: true, ctrl: false, alt: false },
  cdReset: null,
};

const HOTKEY_LABELS = {
  swToggle: 'Count Up: Start / Stop',
  swReset: 'Count Up: Reset',
  swLap: 'Count Up: Lap',
  cdToggle: 'Countdown: Start / Stop',
  cdReset: 'Countdown: Reset',
};

// ---- time formatting ----

function fmt(totalSeconds) {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function clampMinutes(v) {
  v = Math.floor(Number(v));
  if (!isFinite(v) || v < 0) v = 0;
  return Math.min(999, v);
}

function clampSeconds(v) {
  v = Math.floor(Number(v));
  if (!isFinite(v) || v < 0) v = 0;
  return Math.min(59, v);
}

// ---- hotkey helpers ----

function formatHotkey(hk) {
  if (!hk) return '—';
  const parts = [];
  if (hk.ctrl) parts.push('Ctrl');
  if (hk.alt) parts.push('Alt');
  if (hk.shift) parts.push('Shift');
  parts.push(hk.key.length === 1 ? hk.key.toUpperCase() : hk.key);
  return parts.join('+');
}

function matchesHotkey(e, hk) {
  if (!hk) return false;
  const eKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const hkKey = hk.key.length === 1 ? hk.key.toUpperCase() : hk.key;
  return (
    eKey === hkKey &&
    !!e.shiftKey === !!hk.shift &&
    !!e.ctrlKey === !!hk.ctrl &&
    !!e.altKey === !!hk.alt
  );
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function init(api) {
  // ---- STOPWATCH (count up) ENGINE ----

  function createStopwatchEngine() {
    return { running: false, accumulatedMs: 0, startedAt: null, laps: [] };
  }

  let sw = Object.assign(createStopwatchEngine(), api.storage.get(SW_ENGINE_KEY, {}));

  function persistSw() {
    api.storage.set(SW_ENGINE_KEY, sw);
  }

  function swElapsedMs() {
    return sw.accumulatedMs + (sw.running ? Date.now() - sw.startedAt : 0);
  }

  function swToggle() {
    if (sw.running) {
      sw.accumulatedMs = swElapsedMs();
      sw.running = false;
      sw.startedAt = null;
    } else {
      sw.running = true;
      sw.startedAt = Date.now();
    }
    persistSw();
    refreshAll();
  }

  function swReset() {
    sw.running = false;
    sw.accumulatedMs = 0;
    sw.startedAt = null;
    sw.laps = [];
    persistSw();
    refreshAll();
  }

  function swLap() {
    if (!sw.running) return;
    const totalMs = swElapsedMs();
    const prevTotal = sw.laps.length ? sw.laps[0].totalMs : 0;
    sw.laps.unshift({ n: sw.laps.length + 1, lapMs: totalMs - prevTotal, totalMs });
    persistSw();
    refreshAll();
  }

  // ---- COUNTDOWN ENGINE ----

  function createCountdownEngine() {
    const totalMs = 5 * 60 * 1000; // default 5:00
    return {
      running: false,
      setMinutes: 5,
      setSeconds: 0,
      totalMs,
      remainingMs: totalMs,
      startedAt: null,
      finished: false,
    };
  }

  let cd = Object.assign(createCountdownEngine(), api.storage.get(CD_ENGINE_KEY, {}));

  function persistCd() {
    api.storage.set(CD_ENGINE_KEY, cd);
  }

  function cdRemainingMs() {
    if (!cd.running) return cd.remainingMs;
    return Math.max(0, cd.remainingMs - (Date.now() - cd.startedAt));
  }

  function cdToggle() {
    if (cd.running) {
      cd.remainingMs = cdRemainingMs();
      cd.running = false;
      cd.startedAt = null;
    } else {
      if (cd.remainingMs <= 0) return; // nothing left — must reset first
      cd.running = true;
      cd.startedAt = Date.now();
      cd.finished = false;
    }
    persistCd();
    refreshAll();
  }

  function cdReset() {
    cd.running = false;
    cd.startedAt = null;
    cd.remainingMs = cd.totalMs;
    cd.finished = false;
    persistCd();
    refreshAll();
  }

  function cdApplyInputs(minutes, seconds) {
    if (cd.running) return;
    const m = clampMinutes(minutes);
    const s = clampSeconds(seconds);
    cd.setMinutes = m;
    cd.setSeconds = s;
    cd.totalMs = (m * 60 + s) * 1000;
    cd.remainingMs = cd.totalMs;
    cd.finished = false;
    persistCd();
    refreshAll();
  }

  function playFinishBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.55);
      osc.onended = () => ctx.close();
    } catch (err) {
      // Audio is a nice-to-have; never let it break the timer.
    }
  }

  // Called on every tick, and once at load in case the countdown ran out
  // while the client was away.
  function reconcileCountdown() {
    if (!cd.running) return;
    if (cdRemainingMs() <= 0) {
      cd.running = false;
      cd.startedAt = null;
      cd.remainingMs = 0;
      cd.finished = true;
      persistCd();
      playFinishBeep();
    }
  }
  reconcileCountdown();

  // ---- HOTKEYS ----

  let hotkeys = Object.assign({}, DEFAULT_HOTKEYS, api.storage.get(HOTKEYS_KEY, {}));

  function persistHotkeys() {
    api.storage.set(HOTKEYS_KEY, hotkeys);
  }

  const hotkeyActions = { swToggle, swReset, swLap, cdToggle, cdReset };

  let capturingId = null; // hotkey id currently waiting for a keypress

  function beginCapture(id) {
    capturingId = id;
    refreshControls();
  }

  function cancelCapture() {
    capturingId = null;
    refreshControls();
  }

  function onGlobalKeyDown(e) {
    if (capturingId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelCapture();
        return;
      }
      // Wait for a real key, not a bare modifier press.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      hotkeys[capturingId] = {
        key: e.key,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      };
      persistHotkeys();
      capturingId = null;
      refreshControls();
      return;
    }

    if (isTypingTarget(e.target)) return;

    for (const [id, hk] of Object.entries(hotkeys)) {
      if (matchesHotkey(e, hk)) {
        e.preventDefault();
        hotkeyActions[id]();
        return;
      }
    }
  }

  window.addEventListener('keydown', onGlobalKeyDown);
  // Stashed on `api` (not just this closure) so destroy(api) below — which
  // has no access to init()'s local variables — can find it and remove it.
  api.__stopwatchKeydown = onGlobalKeyDown;

  // ---- shared popout mechanics (drag / resize / z-order) ----

  let topZ = 10001;
  function bringToFront(el) {
    topZ += 1;
    el.style.zIndex = String(topZ);
  }

  function wireDrag(entry, onSettle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const onDown = (e) => {
      if (e.target.closest('.sw-popout-close')) return;
      e.preventDefault();
      dragging = true;
      bringToFront(entry.el);
      const rect = entry.el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    const onMove = (e) => {
      if (!dragging) return;
      entry.el.style.left = (e.clientX - offsetX) + 'px';
      entry.el.style.top = (e.clientY - offsetY) + 'px';
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onSettle(currentGeom(entry.el));
    };
    entry.headerEl.addEventListener('mousedown', onDown);
    entry.cleanup.push(() => entry.headerEl.removeEventListener('mousedown', onDown));
  }

  function wireResize(entry, minSize, onSettle, onResize) {
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    const onDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      bringToFront(entry.el);
      const rect = entry.el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    const onMove = (e) => {
      if (!resizing) return;
      const newW = Math.max(minSize.width, startW + (e.clientX - startX));
      const newH = Math.max(minSize.height, startH + (e.clientY - startY));
      entry.el.style.width = newW + 'px';
      entry.el.style.height = newH + 'px';
      onResize(entry);
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onSettle(currentGeom(entry.el));
    };
    entry.resizeEl.addEventListener('mousedown', onDown);
    entry.cleanup.push(() => entry.resizeEl.removeEventListener('mousedown', onDown));
  }

  function currentGeom(el) {
    return {
      left: parseInt(el.style.left, 10) || 0,
      top: parseInt(el.style.top, 10) || 0,
      width: parseInt(el.style.width, 10) || 0,
      height: parseInt(el.style.height, 10) || 0,
    };
  }

  function applyPopoutScale(entry, baseWidth) {
    const rect = entry.el.getBoundingClientRect();
    const scale = Math.max(0.6, rect.width / baseWidth);
    entry.headerEl.style.fontSize = (POPOUT_BASE_HEADER_FONT * scale) + 'px';
    entry.el.querySelectorAll('.sw-display').forEach((d) => {
      d.style.fontSize = (POPOUT_BASE_DISPLAY_FONT * scale) + 'px';
    });
    entry.el.querySelectorAll('.sw-btn').forEach((b) => {
      b.style.fontSize = (POPOUT_BASE_BUTTON_FONT * scale) + 'px';
    });
  }

  // ---- STOPWATCH pop-out ----

  let swPopout = null; // { el, headerEl, resizeEl, displayEl, lapsEl, toggleEl, lapEl, cleanup }

  function swPersistPopoutOpen(open) {
    const s = api.storage.get(SW_POPOUT_KEY, { open: false, geom: null });
    s.open = open;
    api.storage.set(SW_POPOUT_KEY, s);
  }
  function swPersistPopoutGeom(geom) {
    const s = api.storage.get(SW_POPOUT_KEY, { open: false, geom: null });
    s.geom = geom;
    api.storage.set(SW_POPOUT_KEY, s);
  }

  function closeSwPopout() {
    if (!swPopout) return;
    for (const fn of swPopout.cleanup) fn();
    swPopout.el.remove();
    swPopout = null;
    swPersistPopoutOpen(false);
    refreshControlsPopoutState();
  }

  function openSwPopout() {
    if (swPopout) {
      bringToFront(swPopout.el);
      return;
    }
    const state = api.storage.get(SW_POPOUT_KEY, { open: false, geom: null });
    const geom = state.geom || { left: 80, top: 80, ...SW_POPOUT_DEFAULT };

    const el = document.createElement('div');
    el.className = 'sw-popout';
    el.style.left = geom.left + 'px';
    el.style.top = geom.top + 'px';
    el.style.width = geom.width + 'px';
    el.style.height = geom.height + 'px';
    el.innerHTML = `
      <div class="sw-popout-header">
        <span class="sw-popout-header-label">Count Up</span>
        <span class="sw-popout-close" title="Close">&times;</span>
      </div>
      <div class="sw-popout-body">
        <div class="sw-display" id="sw-po-display">${fmt(swElapsedMs() / 1000)}</div>
        <div class="sw-btn-row">
          <span class="sw-btn sw-btn-primary" id="sw-po-toggle">${sw.running ? 'Stop' : 'Start'}</span>
          <span class="sw-btn" id="sw-po-lap">Lap</span>
          <span class="sw-btn" id="sw-po-reset">Reset</span>
        </div>
        <div class="sw-lap-list" id="sw-po-laps"></div>
      </div>
      <div class="sw-popout-resize" title="Resize"></div>
    `;
    api.container.appendChild(el);

    const entry = {
      el,
      headerEl: el.querySelector('.sw-popout-header'),
      resizeEl: el.querySelector('.sw-popout-resize'),
      displayEl: el.querySelector('#sw-po-display'),
      lapsEl: el.querySelector('#sw-po-laps'),
      toggleEl: el.querySelector('#sw-po-toggle'),
      lapEl: el.querySelector('#sw-po-lap'),
      cleanup: [],
    };

    entry.el.addEventListener('mousedown', () => bringToFront(entry.el));
    const closeBtn = el.querySelector('.sw-popout-close');
    closeBtn.addEventListener('click', closeSwPopout);
    entry.cleanup.push(() => closeBtn.removeEventListener('click', closeSwPopout));

    entry.toggleEl.addEventListener('click', swToggle);
    entry.lapEl.addEventListener('click', swLap);
    el.querySelector('#sw-po-reset').addEventListener('click', swReset);

    wireDrag(entry, swPersistPopoutGeom);
    wireResize(entry, SW_POPOUT_MIN, swPersistPopoutGeom, (e) => applyPopoutScale(e, SW_POPOUT_DEFAULT.width));
    applyPopoutScale(entry, SW_POPOUT_DEFAULT.width);
    bringToFront(el);

    swPopout = entry;
    swPersistPopoutOpen(true);
    refreshControlsPopoutState();
    refreshSwUi();
  }

  // ---- COUNTDOWN pop-out ----

  let cdPopout = null; // { el, headerEl, resizeEl, displayEl, minEl, secEl, toggleEl, cleanup }

  function cdPersistPopoutOpen(open) {
    const s = api.storage.get(CD_POPOUT_KEY, { open: false, geom: null });
    s.open = open;
    api.storage.set(CD_POPOUT_KEY, s);
  }
  function cdPersistPopoutGeom(geom) {
    const s = api.storage.get(CD_POPOUT_KEY, { open: false, geom: null });
    s.geom = geom;
    api.storage.set(CD_POPOUT_KEY, s);
  }

  function closeCdPopout() {
    if (!cdPopout) return;
    for (const fn of cdPopout.cleanup) fn();
    cdPopout.el.remove();
    cdPopout = null;
    cdPersistPopoutOpen(false);
    refreshControlsPopoutState();
  }

  function openCdPopout() {
    if (cdPopout) {
      bringToFront(cdPopout.el);
      return;
    }
    const state = api.storage.get(CD_POPOUT_KEY, { open: false, geom: null });
    const geom = state.geom || { left: 340, top: 80, ...CD_POPOUT_DEFAULT };

    const el = document.createElement('div');
    el.className = 'sw-popout';
    el.style.left = geom.left + 'px';
    el.style.top = geom.top + 'px';
    el.style.width = geom.width + 'px';
    el.style.height = geom.height + 'px';
    el.innerHTML = `
      <div class="sw-popout-header">
        <span class="sw-popout-header-label">Countdown</span>
        <span class="sw-popout-close" title="Close">&times;</span>
      </div>
      <div class="sw-popout-body">
        <div class="sw-display" id="cd-po-display">${fmt(cdRemainingMs() / 1000)}</div>
        <div class="sw-cd-inputs">
          <input type="number" id="cd-po-min" min="0" max="999" value="${cd.setMinutes}" ${cd.running ? 'disabled' : ''} />
          <span class="sw-cd-unit">m</span>
          <input type="number" id="cd-po-sec" min="0" max="59" value="${cd.setSeconds}" ${cd.running ? 'disabled' : ''} />
          <span class="sw-cd-unit">s</span>
        </div>
        <div class="sw-btn-row">
          <span class="sw-btn sw-btn-primary" id="cd-po-toggle">${cd.running ? 'Stop' : 'Start'}</span>
          <span class="sw-btn" id="cd-po-reset">Reset</span>
        </div>
      </div>
      <div class="sw-popout-resize" title="Resize"></div>
    `;
    api.container.appendChild(el);

    const entry = {
      el,
      headerEl: el.querySelector('.sw-popout-header'),
      resizeEl: el.querySelector('.sw-popout-resize'),
      displayEl: el.querySelector('#cd-po-display'),
      minEl: el.querySelector('#cd-po-min'),
      secEl: el.querySelector('#cd-po-sec'),
      toggleEl: el.querySelector('#cd-po-toggle'),
      cleanup: [],
    };

    entry.el.addEventListener('mousedown', () => bringToFront(entry.el));
    const closeBtn = el.querySelector('.sw-popout-close');
    closeBtn.addEventListener('click', closeCdPopout);
    entry.cleanup.push(() => closeBtn.removeEventListener('click', closeCdPopout));

    entry.toggleEl.addEventListener('click', cdToggle);
    el.querySelector('#cd-po-reset').addEventListener('click', cdReset);
    entry.minEl.addEventListener('input', () => cdApplyInputs(entry.minEl.value, cd.setSeconds));
    entry.secEl.addEventListener('input', () => cdApplyInputs(cd.setMinutes, entry.secEl.value));

    wireDrag(entry, cdPersistPopoutGeom);
    wireResize(entry, CD_POPOUT_MIN, cdPersistPopoutGeom, (e) => applyPopoutScale(e, CD_POPOUT_DEFAULT.width));
    applyPopoutScale(entry, CD_POPOUT_DEFAULT.width);
    bringToFront(el);

    cdPopout = entry;
    cdPersistPopoutOpen(true);
    refreshControlsPopoutState();
    refreshCdUi();
  }

  // Restore pop-outs that were open last session.
  (function restorePopouts() {
    if (api.storage.get(SW_POPOUT_KEY, { open: false }).open) openSwPopout();
    if (api.storage.get(CD_POPOUT_KEY, { open: false }).open) openCdPopout();
  })();

  // ---- main-panel view state ----
  // Set whenever the tab's own view is mounted, mirrors Calculator's
  // settingsView. Cleared on exit isn't necessary — see calculator.js for
  // why (stale refs into a detached subtree are harmless no-ops).

  let mainView = null; // { root, exit }

  function lapsHtml(laps) {
    if (!laps.length) return '<div class="sw-lap-empty">No laps yet</div>';
    return laps
      .map(
        (l) => `
        <div class="sw-lap-row">
          <span class="sw-lap-num">#${l.n}</span>
          <span class="sw-lap-time">${fmt(l.lapMs / 1000)}</span>
          <span class="sw-lap-total">${fmt(l.totalMs / 1000)}</span>
        </div>`
      )
      .join('');
  }

  // ---- refresh: pushes engine state into whichever UI(s) are mounted ----

  function refreshSwUi() {
    const display = fmt(swElapsedMs() / 1000);
    const toggleLabel = sw.running ? 'Stop' : 'Start';

    if (mainView) {
      const root = mainView.root;
      const d = root.querySelector('#sw-display');
      if (d) d.textContent = display;
      const t = root.querySelector('#sw-up-toggle');
      if (t) t.textContent = toggleLabel;
      const lapBtn = root.querySelector('#sw-up-lap');
      if (lapBtn) lapBtn.classList.toggle('sw-btn-disabled', !sw.running);
      const laps = root.querySelector('#sw-up-laps');
      if (laps) laps.innerHTML = lapsHtml(sw.laps);
      const po = root.querySelector('#sw-up-popout');
      if (po) po.classList.toggle('active', !!swPopout);
    }

    if (swPopout) {
      swPopout.displayEl.textContent = display;
      swPopout.toggleEl.textContent = toggleLabel;
      swPopout.lapEl.classList.toggle('sw-btn-disabled', !sw.running);
      swPopout.lapsEl.innerHTML = lapsHtml(sw.laps);
    }
  }

  function refreshCdUi() {
    const remaining = cdRemainingMs();
    const display = fmt(remaining / 1000);
    const toggleLabel = cd.running ? 'Stop' : 'Start';
    const nothingToStart = !cd.running && remaining <= 0;

    if (mainView) {
      const root = mainView.root;
      const d = root.querySelector('#cd-display');
      if (d) {
        d.textContent = display;
        d.classList.toggle('sw-finished', cd.finished);
      }
      const t = root.querySelector('#cd-down-toggle');
      if (t) {
        t.textContent = toggleLabel;
        t.classList.toggle('sw-btn-disabled', nothingToStart);
      }
      const minEl = root.querySelector('#cd-down-min');
      const secEl = root.querySelector('#cd-down-sec');
      if (minEl && document.activeElement !== minEl) minEl.value = cd.setMinutes;
      if (secEl && document.activeElement !== secEl) secEl.value = cd.setSeconds;
      if (minEl) minEl.disabled = cd.running;
      if (secEl) secEl.disabled = cd.running;
      const po = root.querySelector('#cd-down-popout');
      if (po) po.classList.toggle('active', !!cdPopout);
    }

    if (cdPopout) {
      cdPopout.displayEl.textContent = display;
      cdPopout.displayEl.classList.toggle('sw-finished', cd.finished);
      cdPopout.toggleEl.textContent = toggleLabel;
      cdPopout.toggleEl.classList.toggle('sw-btn-disabled', nothingToStart);
      if (document.activeElement !== cdPopout.minEl) cdPopout.minEl.value = cd.setMinutes;
      if (document.activeElement !== cdPopout.secEl) cdPopout.secEl.value = cd.setSeconds;
      cdPopout.minEl.disabled = cd.running;
      cdPopout.secEl.disabled = cd.running;
    }
  }

  function refreshControlsPopoutState() {
    refreshSwUi();
    refreshCdUi();
  }

  function refreshControls() {
    if (!mainView) return;
    const root = mainView.root;
    root.querySelectorAll('.sw-hotkey-row').forEach((row) => {
      const id = row.dataset.hk;
      const field = row.querySelector('.sw-hotkey-field');
      if (!field) return;
      if (capturingId === id) {
        field.textContent = 'Press a key…';
        field.classList.add('capturing');
      } else {
        field.textContent = formatHotkey(hotkeys[id]);
        field.classList.remove('capturing');
      }
    });
  }

  function refreshAll() {
    refreshSwUi();
    refreshCdUi();
    refreshControls();
  }

  // Tick: recompute countdown-finished state, then repaint. 200ms is
  // plenty for a display that only shows whole seconds.
  api.onTick(() => {
    reconcileCountdown();
    refreshAll();
  }, 200);

  // ---- main tab markup ----

  function controlsHtml() {
    return Object.keys(HOTKEY_LABELS)
      .map(
        (id) => `
        <div class="sw-hotkey-row" data-hk="${id}">
          <label>${HOTKEY_LABELS[id]}</label>
          <span class="sw-hotkey-field" data-hk="${id}">${formatHotkey(hotkeys[id])}</span>
          <span class="sw-hotkey-clear" data-hk="${id}" title="Clear">&times;</span>
        </div>`
      )
      .join('');
  }

  function render(container, exit) {
    container.innerHTML = `
      <div class="ol-list-header sw-top-header">
        <span class="ol-back-btn" id="sw-back" title="Back">&#x2190;</span>
        <span class="ol-list-title">Stopwatch</span>
      </div>

      <div class="sw-section">
        <div class="sw-section-header">
          <span class="sw-section-title">Count Up</span>
          <span class="sw-popout-btn${swPopout ? ' active' : ''}" id="sw-up-popout" title="Pop out">&#x2197;</span>
        </div>
        <div class="sw-display" id="sw-display">${fmt(swElapsedMs() / 1000)}</div>
        <div class="sw-btn-row">
          <span class="sw-btn sw-btn-primary" id="sw-up-toggle">${sw.running ? 'Stop' : 'Start'}</span>
          <span class="sw-btn${sw.running ? '' : ' sw-btn-disabled'}" id="sw-up-lap">Lap</span>
          <span class="sw-btn" id="sw-up-reset">Reset</span>
        </div>
        <div class="sw-lap-list" id="sw-up-laps">${lapsHtml(sw.laps)}</div>
      </div>

      <div class="sw-section">
        <div class="sw-section-header">
          <span class="sw-section-title">Countdown</span>
          <span class="sw-popout-btn${cdPopout ? ' active' : ''}" id="cd-down-popout" title="Pop out">&#x2197;</span>
        </div>
        <div class="sw-display" id="cd-display">${fmt(cdRemainingMs() / 1000)}</div>
        <div class="sw-cd-inputs">
          <input type="number" id="cd-down-min" min="0" max="999" value="${cd.setMinutes}" ${cd.running ? 'disabled' : ''} />
          <span class="sw-cd-unit">m</span>
          <input type="number" id="cd-down-sec" min="0" max="59" value="${cd.setSeconds}" ${cd.running ? 'disabled' : ''} />
          <span class="sw-cd-unit">s</span>
        </div>
        <div class="sw-btn-row">
          <span class="sw-btn sw-btn-primary" id="cd-down-toggle">${cd.running ? 'Stop' : 'Start'}</span>
          <span class="sw-btn" id="cd-down-reset">Reset</span>
        </div>
      </div>

      <div class="sw-controls-section">
        <div class="ol-settings-section-label">Controls</div>
        ${controlsHtml()}
      </div>
    `;

    mainView = { root: container };

    container.querySelector('#sw-back').addEventListener('click', exit);

    container.querySelector('#sw-up-toggle').addEventListener('click', swToggle);
    container.querySelector('#sw-up-lap').addEventListener('click', swLap);
    container.querySelector('#sw-up-reset').addEventListener('click', swReset);
    container.querySelector('#sw-up-popout').addEventListener('click', () => {
      if (swPopout) closeSwPopout();
      else openSwPopout();
    });

    container.querySelector('#cd-down-toggle').addEventListener('click', cdToggle);
    container.querySelector('#cd-down-reset').addEventListener('click', cdReset);
    container.querySelector('#cd-down-popout').addEventListener('click', () => {
      if (cdPopout) closeCdPopout();
      else openCdPopout();
    });
    const minEl = container.querySelector('#cd-down-min');
    const secEl = container.querySelector('#cd-down-sec');
    minEl.addEventListener('input', () => cdApplyInputs(minEl.value, cd.setSeconds));
    secEl.addEventListener('input', () => cdApplyInputs(cd.setMinutes, secEl.value));

    container.querySelectorAll('.sw-hotkey-field').forEach((field) => {
      field.addEventListener('click', () => {
        if (capturingId === field.dataset.hk) cancelCapture();
        else beginCapture(field.dataset.hk);
      });
    });
    container.querySelectorAll('.sw-hotkey-clear').forEach((clearBtn) => {
      clearBtn.addEventListener('click', () => {
        hotkeys[clearBtn.dataset.hk] = null;
        persistHotkeys();
        refreshControls();
      });
    });
  }

  const style = document.createElement('style');
  style.textContent = `
    .sw-top-header { justify-content: flex-start; gap: 8px; }

    .sw-section {
      background: var(--ol-panel-bg);
      border: 1px solid #2e2818;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    .sw-section-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .sw-section-title {
      color: var(--ol-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: 1.15vw;
    }
    .sw-popout-btn {
      cursor: pointer; color: var(--ol-text-tertiary); font-size: 1.3vw;
      line-height: 1; padding: 2px 4px;
    }
    .sw-popout-btn:hover { color: var(--ol-accent); }
    .sw-popout-btn.active { color: var(--ol-accent); }

    .sw-display {
      background: var(--ol-bg);
      border: 1px solid #2e2818;
      border-radius: 6px;
      color: var(--ol-text);
      text-align: center;
      padding: 12px 8px;
      margin-bottom: 10px;
      font-family: inherit;
      font-weight: bold;
      font-size: 2.4vw;
      letter-spacing: 1px;
    }
    .sw-display.sw-finished {
      color: var(--ol-accent);
      animation: sw-pulse 1s ease-in-out infinite;
    }
    @keyframes sw-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }

    .sw-btn-row { display: flex; gap: 8px; }
    .sw-btn {
      flex: 1 1 0;
      display: flex; align-items: center; justify-content: center;
      background: #33301f;
      border: 1px solid #2e2818;
      border-radius: 6px;
      color: var(--ol-text);
      font-family: inherit;
      font-size: 1.2vw;
      font-weight: bold;
      padding: 8px 0;
      cursor: pointer;
      user-select: none;
    }
    .sw-btn:hover { border-color: var(--ol-accent); color: var(--ol-accent); }
    .sw-btn:active { filter: brightness(1.15); }
    .sw-btn-primary { background: var(--ol-accent); color: #fff; border-color: #b8471f; }
    .sw-btn-primary:hover { color: #fff; opacity: 0.9; }
    .sw-btn-disabled { opacity: 0.4; cursor: default; pointer-events: none; }

    .sw-cd-inputs {
      display: flex; align-items: center; gap: 6px; justify-content: center;
      margin-bottom: 10px;
    }
    .sw-cd-inputs input[type="number"] {
      width: 60px; box-sizing: border-box; background: var(--ol-bg); color: var(--ol-text);
      border: 1px solid #2e2818; border-radius: 5px; padding: 6px 8px;
      font-family: inherit; font-size: 1.2vw; text-align: center;
    }
    .sw-cd-inputs input[disabled] { opacity: 0.5; }
    .sw-cd-unit { color: var(--ol-text-tertiary); font-size: 1.1vw; }

    .sw-lap-list {
      max-height: 130px;
      overflow-y: auto;
      margin-top: 10px;
    }
    .sw-lap-empty {
      color: var(--ol-text-tertiary); font-size: 1.05vw; text-align: center; padding: 6px 0;
    }
    .sw-lap-row {
      display: grid; grid-template-columns: auto 1fr 1fr;
      gap: 8px; padding: 4px 2px;
      font-size: 1.1vw; color: var(--ol-text-secondary);
      border-bottom: 1px solid #2a2419;
    }
    .sw-lap-row:last-child { border-bottom: none; }
    .sw-lap-num { color: var(--ol-text-tertiary); }
    .sw-lap-total { text-align: right; color: var(--ol-text); }

    .sw-controls-section {
      margin-top: 6px;
      padding-top: 4px;
    }
    .sw-hotkey-row {
      display: grid; grid-template-columns: 1fr auto auto;
      align-items: center; gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid #2a2419;
    }
    .sw-hotkey-row:last-child { border-bottom: none; }
    .sw-hotkey-row label { color: var(--ol-text); font-size: 1.15vw; }
    .sw-hotkey-field {
      min-width: 90px;
      text-align: center;
      background: var(--ol-bg);
      border: 1px solid #2e2818;
      border-radius: 5px;
      color: var(--ol-accent);
      font-weight: bold;
      font-size: 1.1vw;
      padding: 5px 10px;
      cursor: pointer;
      user-select: none;
    }
    .sw-hotkey-field:hover { border-color: var(--ol-accent); }
    .sw-hotkey-field.capturing {
      color: var(--ol-text);
      animation: sw-pulse 1s ease-in-out infinite;
      border-color: var(--ol-accent);
    }
    .sw-hotkey-clear {
      cursor: pointer; color: var(--ol-text-tertiary); font-size: 1.3vw; line-height: 1;
      padding: 0 4px;
    }
    .sw-hotkey-clear:hover { color: var(--ol-accent); }

    /* ---- Pop-out windows (fully opaque, layered over the game) ---- */
    .sw-popout {
      position: fixed;
      z-index: 10001;
      background: var(--ol-panel-bg);
      border: 1px solid #3a3220;
      border-radius: 6px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-sizing: border-box;
    }
    .sw-popout-header {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--ol-bg);
      border-bottom: 1px solid #2e2818;
      padding: 6px 8px;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    .sw-popout-header-label {
      color: var(--ol-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .sw-popout-close {
      cursor: pointer; color: var(--ol-text-tertiary); line-height: 1;
      padding: 0 2px;
    }
    .sw-popout-close:hover { color: var(--ol-accent); }
    .sw-popout-body {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      padding: 8px;
      box-sizing: border-box;
      overflow: hidden;
      min-height: 0;
    }
    .sw-popout-body .sw-display { font-size: 22px; padding: 10px 8px; }
    .sw-popout-body .sw-btn { font-size: 12px; padding: 6px 0; }
    .sw-popout-body .sw-lap-list { flex: 1 1 auto; }
    .sw-popout-resize {
      position: absolute; right: 0; bottom: 0; width: 14px; height: 14px;
      cursor: nwse-resize;
    }
    .sw-popout-resize::after {
      content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
      border-right: 2px solid var(--ol-text-quaternary); border-bottom: 2px solid var(--ol-text-quaternary);
    }
  `;
  api.container.appendChild(style);

  api.registerSettings({
    title: 'Stopwatch',
    render,
  });
}

function destroy(api) {
  // api.__cleanup() removes `container` wholesale, which takes both
  // pop-outs down with it (they're appended to api.container) and drops
  // any in-flight drag/resize mousemove/mouseup pair on `window` the same
  // way Calculator's does. The one thing that's NOT reached from
  // container.remove() is the standalone `window` keydown listener this
  // plugin registers for hotkeys — that's tracked on `api` itself so it
  // can be torn down here explicitly.
  if (api && api.__stopwatchKeydown) {
    window.removeEventListener('keydown', api.__stopwatchKeydown);
  }
}

export default {
  id: 'stopwatch',
  name: 'Stopwatch',
  description: 'A stopwatch and countdown timer, right inside the client.',
  version: '1.0.0',
  author: 'goku',
  native: true,
  icon: 'Clock.png',
  init,
  destroy,
};
