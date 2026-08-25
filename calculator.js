// OldLite native plugin — Calculator
//
// Basic four-function calculator, native (always on, no toggle, always
// shown in the Installed tab's "Native tools" section). Its gear icon
// opens a single view — there's no list/detail split like Notepad, since
// there's only ever one calculator.
//
// State: kept in memory only (the running display/accumulator/operator).
// Nothing about a calculation is worth persisting across a reload — the
// only thing that *is* persisted is whether the pop-out is open and where
// it's sized/positioned, same as Notepad.
//
// Pop-out: a single floating, draggable, resizable window layered over
// the game canvas, same mechanics as Notepad's pop-outs (see that file
// for the fuller writeup) — just with only one instance instead of one
// per note. The settings view and the pop-out both read/write the same
// shared `engine` object, so punching buttons in either place is
// reflected live in the other.

const POPOUT_STATE_KEY = 'calcPopoutState';

const POPOUT_DEFAULT_WIDTH = 220;
const POPOUT_DEFAULT_HEIGHT = 300;
const POPOUT_MIN_WIDTH = 140;
const POPOUT_MIN_HEIGHT = 190;

// Font/button sizes scale linearly with the popout's width, anchored to
// these base px-per-base-width values (same technique as Notepad/Tileman).
const POPOUT_BASE_WIDTH = POPOUT_DEFAULT_WIDTH;
const POPOUT_BASE_HEADER_FONT = 12;
const POPOUT_BASE_DISPLAY_FONT = 26;
const POPOUT_BASE_HISTORY_FONT = 12;
const POPOUT_BASE_BUTTON_FONT = 14;

// ---- Calculator engine (pure functions over a plain state object) ----

function createEngine() {
  return {
    display: '0',
    accumulator: null,
    operator: null,
    waitingForOperand: false,
    // Set by equals() to the full "240÷16" expression that produced the
    // current `display` value, and cleared (well — ignored, see
    // justEvaluated) the moment any other button starts a new entry.
    historyText: '',
    // True only in the instant after "=" — tells the renderer to show the
    // two-line "small expression above, big result below" layout instead
    // of the single-line "building expression" layout.
    justEvaluated: false,
  };
}

function formatResult(n) {
  if (!isFinite(n)) return 'Error';
  const rounded = Math.round(n * 1e10) / 1e10;
  let s = String(rounded);
  if (s.length > 14) s = n.toExponential(6);
  return s;
}

// The single-line "what am I doing right now" string shown while an
// expression is being built, e.g. typing 240, then ÷, then 16 renders
// "240", "240÷", "240÷16" in turn. Once accumulator is null again (fresh
// entry, or right after clearAll) it's just the current typed number.
function buildExpressionString(engine) {
  if (engine.accumulator === null) return engine.display;
  const accStr = formatResult(engine.accumulator);
  if (engine.waitingForOperand) return accStr + engine.operator;
  return accStr + engine.operator + engine.display;
}

function inputDigit(engine, digit) {
  engine.justEvaluated = false;
  if (engine.display === 'Error') {
    engine.display = digit;
    engine.waitingForOperand = false;
    return;
  }
  if (engine.waitingForOperand) {
    engine.display = digit;
    engine.waitingForOperand = false;
  } else {
    engine.display = engine.display === '0' ? digit : engine.display + digit;
  }
}

function inputDecimal(engine) {
  engine.justEvaluated = false;
  if (engine.waitingForOperand || engine.display === 'Error') {
    engine.display = '0.';
    engine.waitingForOperand = false;
    return;
  }
  if (!engine.display.includes('.')) engine.display += '.';
}

function backspace(engine) {
  if (engine.waitingForOperand || engine.display === 'Error') return;
  engine.justEvaluated = false;
  engine.display = engine.display.length > 1 ? engine.display.slice(0, -1) : '0';
}

function clearAll(engine) {
  engine.display = '0';
  engine.accumulator = null;
  engine.operator = null;
  engine.waitingForOperand = false;
  engine.historyText = '';
  engine.justEvaluated = false;
}

function toggleSign(engine) {
  engine.justEvaluated = false;
  if (engine.display === '0' || engine.display === 'Error') return;
  engine.display = engine.display.startsWith('-') ? engine.display.slice(1) : '-' + engine.display;
}

function percent(engine) {
  engine.justEvaluated = false;
  if (engine.display === 'Error') return;
  engine.display = formatResult(parseFloat(engine.display) / 100);
}

function applyOp(a, b, op) {
  switch (op) {
    case '+': return a + b;
    case '−': return a - b;
    case '×': return a * b;
    case '÷': return b === 0 ? NaN : a / b;
    default: return b;
  }
}

function performOperation(engine, nextOperator) {
  engine.justEvaluated = false;
  if (engine.display === 'Error') return;
  const inputValue = parseFloat(engine.display);
  if (engine.accumulator === null) {
    engine.accumulator = inputValue;
  } else if (engine.operator && !engine.waitingForOperand) {
    engine.accumulator = applyOp(engine.accumulator, inputValue, engine.operator);
    engine.display = formatResult(engine.accumulator);
  }
  engine.waitingForOperand = true;
  engine.operator = nextOperator;
}

function equals(engine) {
  if (engine.display === 'Error' || engine.operator === null || engine.accumulator === null) return;
  const inputValue = parseFloat(engine.display);
  // Captured before we reset accumulator/operator below — this is the
  // "240÷16" that goes into the small history line.
  const exprBefore = buildExpressionString(engine);
  const result = applyOp(engine.accumulator, inputValue, engine.operator);
  engine.historyText = exprBefore;
  engine.justEvaluated = true;
  engine.display = formatResult(result);
  engine.accumulator = null;
  engine.operator = null;
  engine.waitingForOperand = true;
}

// What the two display lines should currently read.
function renderDisplayState(engine) {
  if (engine.justEvaluated) {
    return { history: engine.historyText, main: engine.display };
  }
  return { history: '', main: buildExpressionString(engine) };
}

// Shared markup for the two-line display — a small, dim "history" line
// (only occupied right after "=") sitting above the big main line (either
// the expression being built, or the result). Same markup in the
// settings view and the pop-out, just scaled differently by CSS.
function displayHtml(engine) {
  const { history, main } = renderDisplayState(engine);
  return `
    <div class="calc-display-wrap">
      <div class="calc-display-history">${history}</div>
      <div class="calc-display">${main}</div>
    </div>
  `;
}

function buttonGridHtml() {
  return `
    <div class="calc-row">
      <span class="calc-btn calc-btn-fn" data-action="clear">C</span>
      <span class="calc-btn calc-btn-fn" data-action="sign">+/&minus;</span>
      <span class="calc-btn calc-btn-fn" data-action="percent">%</span>
      <span class="calc-btn calc-btn-op" data-action="op" data-op="&divide;">&divide;</span>
    </div>
    <div class="calc-row">
      <span class="calc-btn" data-action="digit" data-digit="7">7</span>
      <span class="calc-btn" data-action="digit" data-digit="8">8</span>
      <span class="calc-btn" data-action="digit" data-digit="9">9</span>
      <span class="calc-btn calc-btn-op" data-action="op" data-op="&times;">&times;</span>
    </div>
    <div class="calc-row">
      <span class="calc-btn" data-action="digit" data-digit="4">4</span>
      <span class="calc-btn" data-action="digit" data-digit="5">5</span>
      <span class="calc-btn" data-action="digit" data-digit="6">6</span>
      <span class="calc-btn calc-btn-op" data-action="op" data-op="&minus;">&minus;</span>
    </div>
    <div class="calc-row">
      <span class="calc-btn" data-action="digit" data-digit="1">1</span>
      <span class="calc-btn" data-action="digit" data-digit="2">2</span>
      <span class="calc-btn" data-action="digit" data-digit="3">3</span>
      <span class="calc-btn calc-btn-op" data-action="op" data-op="+">+</span>
    </div>
    <div class="calc-row">
      <span class="calc-btn calc-btn-wide" data-action="digit" data-digit="0">0</span>
      <span class="calc-btn" data-action="decimal">.</span>
      <span class="calc-btn calc-btn-op calc-btn-equals" data-action="equals">=</span>
    </div>
  `;
}

function init(api) {
  const engine = createEngine();

  // Set whenever the settings view is currently mounted, cleared when it
  // isn't — mirrors Notepad's activeNoteView. Lets refreshDisplays() (and
  // the popout button's active state) know whether it needs to touch it.
  let settingsView = null; // { displayEl, popoutBtnEl }

  // ---- POP-OUT STATE (only ever zero or one instance) ----
  let popoutEntry = null; // { el, headerEl, displayEl, resizeEl, cleanup: [fns] }
  let topZ = 10001;

  function loadPopoutState() {
    return api.storage.get(POPOUT_STATE_KEY, { open: false, geom: null });
  }

  function savePopoutState(state) {
    api.storage.set(POPOUT_STATE_KEY, state);
  }

  function persistOpen(open) {
    const state = loadPopoutState();
    state.open = open;
    savePopoutState(state);
  }

  function persistGeom(geom) {
    const state = loadPopoutState();
    state.geom = geom;
    savePopoutState(state);
  }

  function currentGeom(el) {
    return {
      left: parseInt(el.style.left, 10) || 0,
      top: parseInt(el.style.top, 10) || 0,
      width: parseInt(el.style.width, 10) || POPOUT_DEFAULT_WIDTH,
      height: parseInt(el.style.height, 10) || POPOUT_DEFAULT_HEIGHT,
    };
  }

  function defaultGeom() {
    return { left: 80, top: 80, width: POPOUT_DEFAULT_WIDTH, height: POPOUT_DEFAULT_HEIGHT };
  }

  function bringToFront(el) {
    topZ += 1;
    el.style.zIndex = String(topZ);
  }

  function applyPopoutScale(entry) {
    const rect = entry.el.getBoundingClientRect();
    const scale = Math.max(0.6, rect.width / POPOUT_BASE_WIDTH);
    entry.headerEl.style.fontSize = (POPOUT_BASE_HEADER_FONT * scale) + 'px';
    entry.displayEl.style.fontSize = (POPOUT_BASE_DISPLAY_FONT * scale) + 'px';
    entry.historyEl.style.fontSize = (POPOUT_BASE_HISTORY_FONT * scale) + 'px';
    entry.el.querySelectorAll('.calc-btn').forEach((btn) => {
      btn.style.fontSize = (POPOUT_BASE_BUTTON_FONT * scale) + 'px';
    });
  }

  // Drag via the header bar — same approach as Notepad's popouts.
  function wireDrag(entry) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onDown = (e) => {
      if (e.target.closest('.calc-popout-close')) return;
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
      persistGeom(currentGeom(entry.el));
    };

    entry.headerEl.addEventListener('mousedown', onDown);
    entry.cleanup.push(() => entry.headerEl.removeEventListener('mousedown', onDown));
  }

  // Resize via the bottom-right grip — same approach as Notepad's popouts.
  function wireResize(entry) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;

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
      const newW = Math.max(POPOUT_MIN_WIDTH, startW + (e.clientX - startX));
      const newH = Math.max(POPOUT_MIN_HEIGHT, startH + (e.clientY - startY));
      entry.el.style.width = newW + 'px';
      entry.el.style.height = newH + 'px';
      applyPopoutScale(entry);
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persistGeom(currentGeom(entry.el));
    };

    entry.resizeEl.addEventListener('mousedown', onDown);
    entry.cleanup.push(() => entry.resizeEl.removeEventListener('mousedown', onDown));
  }

  // Pushes engine.display into whichever UI(s) are currently mounted.
  function refreshDisplays() {
    const { history, main } = renderDisplayState(engine);
    if (settingsView) {
      settingsView.historyEl.textContent = history;
      settingsView.displayEl.textContent = main;
    }
    if (popoutEntry) {
      popoutEntry.historyEl.textContent = history;
      popoutEntry.displayEl.textContent = main;
    }
  }

  function refreshPopoutBtnState() {
    if (settingsView && settingsView.popoutBtnEl) {
      settingsView.popoutBtnEl.classList.toggle('active', !!popoutEntry);
    }
  }

  // Wires the shared button-grid markup (identical in the settings view
  // and the popout) to the shared engine, whatever DOM it's currently
  // sitting in.
  function wireButtonGrid(root) {
    root.querySelectorAll('.calc-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'digit') inputDigit(engine, btn.dataset.digit);
        else if (action === 'decimal') inputDecimal(engine);
        else if (action === 'clear') clearAll(engine);
        else if (action === 'sign') toggleSign(engine);
        else if (action === 'percent') percent(engine);
        else if (action === 'op') performOperation(engine, btn.dataset.op);
        else if (action === 'equals') equals(engine);
        refreshDisplays();
      });
    });
  }

  function closePopout() {
    if (!popoutEntry) return;
    for (const fn of popoutEntry.cleanup) fn();
    popoutEntry.el.remove();
    popoutEntry = null;
    persistOpen(false);
    refreshPopoutBtnState();
  }

  function openPopout() {
    if (popoutEntry) {
      bringToFront(popoutEntry.el);
      return;
    }

    const state = loadPopoutState();
    const geom = state.geom || defaultGeom();

    const el = document.createElement('div');
    el.className = 'calc-popout';
    el.style.left = geom.left + 'px';
    el.style.top = geom.top + 'px';
    el.style.width = geom.width + 'px';
    el.style.height = geom.height + 'px';

    el.innerHTML = `
      <div class="calc-popout-header">
        <span class="calc-popout-header-label">Calculator</span>
        <span class="calc-popout-close" title="Close">&times;</span>
      </div>
      <div class="calc-popout-body">
        ${displayHtml(engine)}
        <div class="calc-grid">${buttonGridHtml()}</div>
      </div>
      <div class="calc-popout-resize" title="Resize"></div>
    `;

    api.container.appendChild(el);

    const entry = {
      el,
      headerEl: el.querySelector('.calc-popout-header'),
      historyEl: el.querySelector('.calc-display-history'),
      displayEl: el.querySelector('.calc-display'),
      resizeEl: el.querySelector('.calc-popout-resize'),
      cleanup: [],
    };

    entry.el.addEventListener('mousedown', () => bringToFront(entry.el));

    const closeBtn = el.querySelector('.calc-popout-close');
    const onClose = () => closePopout();
    closeBtn.addEventListener('click', onClose);
    entry.cleanup.push(() => closeBtn.removeEventListener('click', onClose));

    wireButtonGrid(el);
    wireDrag(entry);
    wireResize(entry);
    applyPopoutScale(entry);
    bringToFront(el);

    popoutEntry = entry;
    persistOpen(true);
    refreshPopoutBtnState();
  }

  // Restore the pop-out if it was open last time.
  (function restorePopout() {
    const state = loadPopoutState();
    if (state.open) openPopout();
  })();

  const style = document.createElement('style');
  style.textContent = `
    .calc-header-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .calc-header-left { display: flex; align-items: center; gap: 8px; }
    .calc-popout-btn {
      cursor: pointer; color: var(--ol-text-tertiary); font-size: 1.3vw;
      line-height: 1; padding: 2px 4px;
    }
    .calc-popout-btn:hover { color: var(--ol-accent); }
    .calc-popout-btn.active { color: var(--ol-accent); }

    .calc-display-wrap {
      background: var(--ol-bg);
      border: 1px solid #2e2818;
      border-radius: 6px;
      padding: 10px 12px 12px;
      margin-bottom: 10px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      overflow: hidden;
    }
    .calc-display-history {
      color: var(--ol-text-tertiary);
      font-family: inherit;
      font-size: 1.1vw;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    /* Collapses to nothing while building an expression (screenshot #1) —
       only occupied right after "=" (screenshot #2). */
    .calc-display-history:empty { display: none; }
    .calc-display {
      color: var(--ol-text);
      text-align: right;
      font-family: inherit;
      font-size: 2.2vw;
      font-weight: bold;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .calc-grid { display: flex; flex-direction: column; gap: 8px; }
    .calc-row { display: flex; gap: 8px; }
    .calc-btn {
      flex: 1 1 0;
      display: flex; align-items: center; justify-content: center;
      background: var(--ol-panel-bg);
      border: 1px solid #2e2818;
      border-radius: 6px;
      color: var(--ol-text);
      font-family: inherit;
      font-size: 1.4vw;
      padding: 10px 0;
      cursor: pointer;
      user-select: none;
    }
    .calc-btn:hover { border-color: var(--ol-accent); color: var(--ol-accent); }
    .calc-btn:active { background: rgba(216,90,48,0.18); }
    .calc-btn-wide { flex: 2.15 1 0; justify-content: flex-start; padding-left: 18px; }
    .calc-btn-fn { color: var(--ol-text-secondary); }
    .calc-btn-op { color: var(--ol-accent); font-weight: bold; }
    .calc-btn-equals { background: var(--ol-accent); color: var(--ol-bg); border-color: var(--ol-accent); }
    .calc-btn-equals:hover { color: var(--ol-bg); opacity: 0.9; }

    /* ---- Pop-out calculator window (fully opaque, layered over the game) ---- */
    .calc-popout {
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
    .calc-popout-header {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--ol-bg);
      border-bottom: 1px solid #2e2818;
      padding: 6px 8px;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    .calc-popout-header-label {
      color: var(--ol-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .calc-popout-close {
      cursor: pointer; color: var(--ol-text-tertiary); line-height: 1;
      padding: 0 2px;
    }
    .calc-popout-close:hover { color: var(--ol-accent); }
    .calc-popout-body {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      padding: 8px;
      box-sizing: border-box;
      overflow: hidden;
      min-height: 0;
    }
    .calc-popout-body .calc-display-wrap { padding: 8px 8px 10px; }
    .calc-popout-body .calc-display-history { font-size: 10px; }
    .calc-popout-body .calc-display { font-size: 22px; }
    .calc-popout-body .calc-grid { flex: 1 1 auto; }
    .calc-popout-body .calc-btn { font-size: 13px; padding: 0; flex-basis: 0; }
    .calc-popout-resize {
      position: absolute; right: 0; bottom: 0; width: 14px; height: 14px;
      cursor: nwse-resize;
    }
    .calc-popout-resize::after {
      content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
      border-right: 2px solid var(--ol-text-quaternary); border-bottom: 2px solid var(--ol-text-quaternary);
    }
  `;
  api.container.appendChild(style);

  api.registerSettings({
    title: 'Calculator',
    render(container, exit) {
      container.innerHTML = `
        <div class="ol-list-header calc-header-row">
          <div class="calc-header-left">
            <span class="ol-back-btn" id="calc-back" title="Back">&#x2190;</span>
            <span class="ol-list-title">Calculator</span>
          </div>
          <span class="calc-popout-btn${popoutEntry ? ' active' : ''}" id="calc-popout-toggle" title="Pop out">&#x2197;</span>
        </div>
        ${displayHtml(engine)}
        <div class="calc-grid">${buttonGridHtml()}</div>
      `;

      document.getElementById('calc-back').addEventListener('click', exit);

      settingsView = {
        historyEl: container.querySelector('.calc-display-history'),
        displayEl: container.querySelector('.calc-display'),
        popoutBtnEl: document.getElementById('calc-popout-toggle'),
      };

      settingsView.popoutBtnEl.addEventListener('click', () => {
        if (popoutEntry) closePopout();
        else openPopout();
      });

      wireButtonGrid(container);
    },
  });
}

function destroy() {
  // api.__cleanup() removes `container` wholesale, which takes the popout
  // element down with it since it's appended to api.container too. The
  // only thing that wouldn't be caught by that is a mousemove/mouseup
  // pair left on `window` mid-drag/resize — wireDrag and wireResize both
  // add those listeners only for the duration of an active drag/resize
  // and remove them on mouseup, so there's nothing left dangling here
  // either way.
}

export default {
  id: 'calculator',
  name: 'Calculator',
  description: 'A simple calculator, right inside the client.',
  version: '1.1.3',
  author: 'goku',
  native: true,
  icon: 'Calculator.png',
  init,
  destroy,
};
