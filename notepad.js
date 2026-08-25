// OldLite native plugin — Notepad
//
// Simple autosaving notes, native (always on, no toggle, always shown in
// the Installed tab's "Native tools" section). Its gear icon opens a
// two-level view (notes list -> individual note) built via the loader's
// custom-render escape hatch (api.registerSettings({ render(container,
// exit) {...} })) instead of the fixed field/section schema every other
// plugin uses, since a dynamic user-created list + a detail view can't be
// expressed as a flat set of settings fields.
//
// Storage: a single key (via api.storage) holding an array of
// { id, title, body, updatedAt }. Whole-array read/write is plenty at
// notepad scale — no need for per-note keys.
//
// Pop-outs: each note card has a small pop-out arrow. Clicking it opens
// that note as its own floating, draggable, resizable window layered on
// top of the game canvas — independent of whether the Settings panel is
// open, same as Tileman's HUD (a persistent element living in
// api.container, not something the settings render() owns). Multiple
// notes can be popped out at once; only one popout per note. Position and
// size persist per note; which notes are currently popped out also
// persists, so they come back on reload.

const STORAGE_KEY = 'notes';
const POPOUT_STATE_KEY = 'popoutState';

const POPOUT_DEFAULT_WIDTH = 260;
const POPOUT_DEFAULT_HEIGHT = 220;
const POPOUT_MIN_WIDTH = 180;
const POPOUT_MIN_HEIGHT = 140;
// Cascade offset applied to each newly-opened popout that has no saved
// position yet, so stacking several at once doesn't pile them exactly on
// top of each other.
const POPOUT_CASCADE_STEP = 28;

// Font sizes scale linearly with the popout's width, anchored to these
// base px-per-base-width values (same technique as Tileman's HUD font
// scaling).
const POPOUT_BASE_WIDTH = POPOUT_DEFAULT_WIDTH;
const POPOUT_BASE_HEADER_FONT = 12;
const POPOUT_BASE_TITLE_FONT = 14;
const POPOUT_BASE_BODY_FONT = 12.5;

function loadNotes(api) {
  return api.storage.get(STORAGE_KEY, []);
}

function saveNotes(api, notes) {
  api.storage.set(STORAGE_KEY, notes);
}

function firstLine(body) {
  const trimmed = (body || '').trim();
  if (!trimmed) return '';
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

function makeId() {
  return `n${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function init(api) {
  // 'list' = main notes page, 'note' = editing a single note. Local to
  // this plugin instance — resets to the list whenever Notepad's gear is
  // opened fresh, same as every other plugin's settings view does.
  let view = 'list';
  let openNoteId = null;

  // ---- POP-OUT STATE (lives independently of the settings view above) ----
  // noteId -> { el, titleEl, bodyEl, cleanup: [fns] }
  const popouts = new Map();
  let topZ = 10001;
  let cascadeCount = 0;

  function loadPopoutState() {
    return api.storage.get(POPOUT_STATE_KEY, { openIds: [], geom: {} });
  }

  function savePopoutState(state) {
    api.storage.set(POPOUT_STATE_KEY, state);
  }

  function persistOpenIds() {
    const state = loadPopoutState();
    state.openIds = [...popouts.keys()];
    savePopoutState(state);
  }

  function persistGeom(noteId, geom) {
    const state = loadPopoutState();
    state.geom = state.geom || {};
    state.geom[noteId] = geom;
    savePopoutState(state);
  }

  function bringToFront(el) {
    topZ += 1;
    el.style.zIndex = String(topZ);
  }

  function applyPopoutScale(entry) {
    const rect = entry.el.getBoundingClientRect();
    const scale = Math.max(0.6, rect.width / POPOUT_BASE_WIDTH);
    entry.headerEl.style.fontSize = (POPOUT_BASE_HEADER_FONT * scale) + 'px';
    entry.titleEl.style.fontSize = (POPOUT_BASE_TITLE_FONT * scale) + 'px';
    entry.bodyEl.style.fontSize = (POPOUT_BASE_BODY_FONT * scale) + 'px';
  }

  // Drag via the header bar — same left/top-tracking approach as Tileman's
  // HUD, just without requiring shift to be held.
  function wireDrag(entry) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onDown = (e) => {
      // Don't start a drag from the close button.
      if (e.target.closest('.np-popout-close')) return;
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
      persistGeom(entry.id, currentGeom(entry.el));
    };

    entry.headerEl.addEventListener('mousedown', onDown);
    entry.cleanup.push(() => entry.headerEl.removeEventListener('mousedown', onDown));
  }

  // Resize via the bottom-right grip — width/height tracked directly off
  // the mouse position, clamped to a sane minimum, with fonts rescaled live.
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
      persistGeom(entry.id, currentGeom(entry.el));
    };

    entry.resizeEl.addEventListener('mousedown', onDown);
    entry.cleanup.push(() => entry.resizeEl.removeEventListener('mousedown', onDown));
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
    const cascade = (cascadeCount % 8) * POPOUT_CASCADE_STEP;
    cascadeCount += 1;
    return {
      left: 60 + cascade,
      top: 60 + cascade,
      width: POPOUT_DEFAULT_WIDTH,
      height: POPOUT_DEFAULT_HEIGHT,
    };
  }

  function closePopout(noteId) {
    const entry = popouts.get(noteId);
    if (!entry) return;
    for (const fn of entry.cleanup) fn();
    entry.el.remove();
    popouts.delete(noteId);
    persistOpenIds();
    refreshListPopoutIndicators();
  }

  function openPopout(noteId) {
    const existing = popouts.get(noteId);
    if (existing) {
      bringToFront(existing.el);
      return;
    }

    const note = loadNotes(api).find((n) => n.id === noteId);
    if (!note) return;

    const state = loadPopoutState();
    const geom = state.geom && state.geom[noteId] ? state.geom[noteId] : defaultGeom();

    const el = document.createElement('div');
    el.className = 'np-popout';
    el.style.left = geom.left + 'px';
    el.style.top = geom.top + 'px';
    el.style.width = geom.width + 'px';
    el.style.height = geom.height + 'px';

    el.innerHTML = `
      <div class="np-popout-header">
        <span class="np-popout-header-label">Note</span>
        <span class="np-popout-close" title="Close">&times;</span>
      </div>
      <div class="np-popout-body">
        <input type="text" class="np-popout-title" placeholder="Title" value="${escapeAttr(note.title)}" />
        <textarea class="np-popout-textarea" placeholder="Write anything…">${escapeHtml(note.body)}</textarea>
      </div>
      <div class="np-popout-resize" title="Resize"></div>
    `;

    api.container.appendChild(el);

    const entry = {
      id: noteId,
      el,
      headerEl: el.querySelector('.np-popout-header'),
      titleEl: el.querySelector('.np-popout-title'),
      bodyEl: el.querySelector('.np-popout-textarea'),
      resizeEl: el.querySelector('.np-popout-resize'),
      cleanup: [],
    };

    entry.el.addEventListener('mousedown', () => bringToFront(entry.el));

    const closeBtn = el.querySelector('.np-popout-close');
    const onClose = () => closePopout(noteId);
    closeBtn.addEventListener('click', onClose);
    entry.cleanup.push(() => closeBtn.removeEventListener('click', onClose));

    function persistContent() {
      const allNotes = loadNotes(api);
      const idx = allNotes.findIndex((n) => n.id === noteId);
      if (idx === -1) return;
      allNotes[idx] = {
        ...allNotes[idx],
        title: entry.titleEl.value,
        body: entry.bodyEl.value,
        updatedAt: Date.now(),
      };
      saveNotes(api, allNotes);
    }
    entry.titleEl.addEventListener('input', persistContent);
    entry.bodyEl.addEventListener('input', persistContent);
    entry.cleanup.push(() => entry.titleEl.removeEventListener('input', persistContent));
    entry.cleanup.push(() => entry.bodyEl.removeEventListener('input', persistContent));

    wireDrag(entry);
    wireResize(entry);
    applyPopoutScale(entry);
    bringToFront(el);

    popouts.set(noteId, entry);
    persistOpenIds();
    refreshListPopoutIndicators();
  }

  // If the list view happens to be showing right now, keep its pop-out
  // arrows in sync with which notes are actually popped out.
  function refreshListPopoutIndicators() {
    document.querySelectorAll('.np-popout-btn').forEach((btn) => {
      btn.classList.toggle('active', popouts.has(btn.dataset.id));
    });
  }

  // Restore any popouts that were open last time.
  (function restorePopouts() {
    const state = loadPopoutState();
    const notes = loadNotes(api);
    for (const id of state.openIds || []) {
      if (notes.some((n) => n.id === id)) openPopout(id);
    }
  })();

  const style = document.createElement('style');
  style.textContent = `
    .np-list-header-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .np-header-left { display: flex; align-items: center; gap: 8px; }
    .np-add-btn {
      cursor: pointer; color: var(--ol-text-secondary); font-size: 1.6vw;
      line-height: 1; flex-shrink: 0;
    }
    .np-add-btn:hover { color: var(--ol-accent); }
    .np-note-card { cursor: pointer; }
    .np-note-card:hover { border-color: var(--ol-accent); }
    .np-title-input {
      width: 100%; box-sizing: border-box; background: transparent; color: var(--ol-text);
      border: none; border-bottom: 1px solid #2e2818; padding: 6px 0; margin-bottom: 10px;
      font-family: inherit; font-size: 1.53vw; font-weight: bold;
    }
    .np-title-input:focus { outline: none; border-color: var(--ol-accent); }
    .np-title-input::placeholder { color: var(--ol-text-tertiary); font-weight: normal; }
    .np-body-textarea {
      width: 100%; box-sizing: border-box; background: transparent; color: var(--ol-text);
      border: none; resize: none; font-family: inherit; font-size: 1.3vw; line-height: 1.5;
      min-height: 55vh;
    }
    .np-body-textarea:focus { outline: none; }
    .np-body-textarea::placeholder { color: var(--ol-text-tertiary); }

    .np-card-bottom { justify-content: flex-end; }
    .np-popout-btn {
      cursor: pointer; color: var(--ol-text-tertiary); font-size: 1.3vw;
      line-height: 1; padding: 2px 4px;
    }
    .np-popout-btn:hover { color: var(--ol-accent); }
    .np-popout-btn.active { color: var(--ol-accent); }

    /* ---- Pop-out note windows (fully opaque, layered over the game) ---- */
    .np-popout {
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
    .np-popout-header {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--ol-bg);
      border-bottom: 1px solid #2e2818;
      padding: 6px 8px;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    .np-popout-header-label {
      color: var(--ol-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .np-popout-close {
      cursor: pointer; color: var(--ol-text-tertiary); line-height: 1;
      padding: 0 2px;
    }
    .np-popout-close:hover { color: var(--ol-accent); }
    .np-popout-body {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      padding: 8px;
      box-sizing: border-box;
      overflow: hidden;
      min-height: 0;
    }
    .np-popout-title {
      width: 100%; box-sizing: border-box; background: transparent; color: var(--ol-text);
      border: none; border-bottom: 1px solid #2e2818; padding: 4px 0; margin-bottom: 6px;
      font-family: inherit; font-weight: bold; flex-shrink: 0;
    }
    .np-popout-title:focus { outline: none; border-color: var(--ol-accent); }
    .np-popout-title::placeholder { color: var(--ol-text-tertiary); font-weight: normal; }
    .np-popout-textarea {
      width: 100%; flex: 1 1 auto; box-sizing: border-box; background: transparent;
      color: var(--ol-text); border: none; resize: none; font-family: inherit;
      line-height: 1.5; min-height: 0;
    }
    .np-popout-textarea:focus { outline: none; }
    .np-popout-textarea::placeholder { color: var(--ol-text-tertiary); }
    .np-popout-resize {
      position: absolute; right: 0; bottom: 0; width: 14px; height: 14px;
      cursor: nwse-resize;
    }
    .np-popout-resize::after {
      content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
      border-right: 2px solid var(--ol-text-quaternary); border-bottom: 2px solid var(--ol-text-quaternary);
    }
  `;
  api.container.appendChild(style);

  function renderActive(container, exit) {
    if (view === 'note') renderNoteView(container, exit);
    else renderListView(container, exit);
  }

  function renderListView(container, exit) {
    const notes = loadNotes(api).slice().sort((a, b) => b.updatedAt - a.updatedAt);

    container.innerHTML = `
      <div class="ol-list-header np-list-header-row">
        <div class="np-header-left">
          <span class="ol-back-btn" id="np-back" title="Back">&#x2190;</span>
          <span class="ol-list-title">Notepad</span>
        </div>
        <span class="np-add-btn" id="np-add" title="New note">&#x2795;</span>
      </div>
      <div id="np-note-list">
        ${
          notes.length
            ? notes
                .map(
                  (n) => `
                    <div class="ol-plugin-card np-note-card" data-id="${n.id}">
                      <div class="ol-card-top"><span class="ol-card-name">${escapeHtml(n.title || 'Untitled')}</span></div>
                      <div class="ol-card-desc">${escapeHtml(firstLine(n.body)) || '&nbsp;'}</div>
                      <div class="ol-card-bottom np-card-bottom">
                        <span class="np-popout-btn${popouts.has(n.id) ? ' active' : ''}" data-id="${n.id}" title="Pop out">&#x2197;</span>
                      </div>
                    </div>
                  `
                )
                .join('')
            : `<div id="oldlite-empty-state">No notes yet — tap + to create one.</div>`
        }
      </div>
    `;

    document.getElementById('np-back').addEventListener('click', exit);

    document.getElementById('np-add').addEventListener('click', () => {
      const notesNow = loadNotes(api);
      const note = { id: makeId(), title: '', body: '', updatedAt: Date.now() };
      notesNow.push(note);
      saveNotes(api, notesNow);
      openNoteId = note.id;
      view = 'note';
      renderActive(container, exit);
    });

    container.querySelectorAll('.np-note-card').forEach((el) => {
      el.addEventListener('click', () => {
        openNoteId = el.dataset.id;
        view = 'note';
        renderActive(container, exit);
      });
    });

    container.querySelectorAll('.np-popout-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPopout(btn.dataset.id);
      });
    });
  }

  function renderNoteView(container, exit) {
    const notes = loadNotes(api);
    const note = notes.find((n) => n.id === openNoteId);
    if (!note) {
      view = 'list';
      renderActive(container, exit);
      return;
    }

    container.innerHTML = `
      <div class="ol-list-header">
        <span class="ol-back-btn" id="np-note-back" title="Back">&#x2190;</span>
        <span class="ol-list-title">Edit Note</span>
      </div>
      <input type="text" class="np-title-input" id="np-title" placeholder="Title" value="${escapeAttr(note.title)}" />
      <textarea class="np-body-textarea" id="np-body" placeholder="Write anything…">${escapeHtml(note.body)}</textarea>
    `;

    // Back from a note always returns to Notepad's own list, not out to
    // the Installed tab — that's the loader's outer back button's job,
    // and this view doesn't show that one.
    document.getElementById('np-note-back').addEventListener('click', () => {
      view = 'list';
      renderActive(container, exit);
    });

    const titleEl = document.getElementById('np-title');
    const bodyEl = document.getElementById('np-body');

    function persist() {
      const allNotes = loadNotes(api);
      const idx = allNotes.findIndex((n) => n.id === openNoteId);
      if (idx === -1) return;
      allNotes[idx] = {
        ...allNotes[idx],
        title: titleEl.value,
        body: bodyEl.value,
        updatedAt: Date.now(),
      };
      saveNotes(api, allNotes);
    }

    // No save button anywhere — every keystroke commits immediately.
    titleEl.addEventListener('input', persist);
    bodyEl.addEventListener('input', persist);
  }

  api.registerSettings({
    title: 'Notepad',
    render(container, exit) {
      view = 'list';
      openNoteId = null;
      renderActive(container, exit);
    },
  });
}

function destroy() {
  // api.__cleanup() removes `container` wholesale, which takes every
  // popout element down with it since they're all appended to
  // api.container. The only thing that wouldn't be caught by that is a
  // mousemove/mouseup pair left on `window` mid-drag/resize — wireDrag and
  // wireResize both add those listeners only for the duration of an
  // active drag/resize and remove them on mouseup, so there's nothing left
  // dangling here either way.
}

export default {
  id: 'notepad',
  name: 'Notepad',
  description: 'Quick notes that autosave, right inside the client.',
  version: '1.1.0',
  author: 'goku',
  native: true,
  icon: 'Notepad.png',
  init,
  destroy,
};
