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

const STORAGE_KEY = 'notes';

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
  // Nothing beyond what api.__cleanup() already handles (container
  // removal, settings-def unregistration) — notes themselves live in
  // localStorage via api.storage and persist across activate/deactivate.
}

export default {
  id: 'notepad',
  name: 'Notepad',
  description: 'Quick notes that autosave, right inside the client.',
  version: '1.0.0',
  author: 'SoapFreakz',
  native: true,
  icon: 'Notepad.png',
  init,
  destroy,
};
