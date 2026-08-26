// OldLite native plugin — Wiki
//
// A single searchable OSRS-wiki-style reference for items and NPCs,
// merged into one list (not split into separate "items" / "npcs" sections
// like losthq's own db pages) with hyperlink-style navigation between
// pages.
//
// BASELINE SCOPE (see scripts/build-wiki-data.js for the full rationale):
//   - Data comes from ONE prebuilt file, wiki-data/wiki.json, fetched at
//     runtime from raw.githubusercontent.com the same way loader.js loads
//     icons/*.png (see fetchWikiData below) — never fetched from losthq
//     directly by the client.
//   - Herb identify-level lookup and clue-tier merging are NOT wired in
//     yet — that's a follow-up pass once this baseline is confirmed
//     working end to end. Herbs/clues currently just show up as whatever
//     separate entries the source data has for them.
//   - No shop-location / drop-table tables yet (needs shop_data.json /
//     shared_drops.json wiring, also a follow-up).
//
// UI: uses api.registerSettings({ render }) — the same custom-render
// escape hatch Community Hub's Notepad-style plugins use — because this
// needs real list -> detail navigation, not the fixed field/section
// settings schema.
//
// State: none persisted. Search text and the currently-open page are
// just in-memory render state, reset each time the panel opens.
//
// STYLE INJECTION: the stylesheet is appended to document.head (once,
// guarded by id) rather than into `container`. paint() replaces
// `container.innerHTML` on every render (list <-> detail <-> back), and
// anything appended as a child of `container` gets wiped out the next
// time that happens. Keeping the <style> tag in the document head means
// it survives every repaint regardless of what container's innerHTML does.
//
// SCALING: everything under .wiki-root is sized in `em`, and .wiki-root
// itself sets the single font-size that drives all of them (clamped so it
// never goes unreadably small/huge on extreme window sizes). Previously
// only text used vw and every box/icon/padding was fixed px, which is why
// the panel "scaled the words but not the boxes". If another OldLite
// plugin drives its scale off a client-provided CSS var (e.g. something
// set on the panel host element) instead of raw vw, swap the one
// `font-size` line below to read that var — everything else here already
// cascades off it via em and needs no other changes.
//
// SEARCH: matchesSearch is now defensive (bad/missing `name` on an entry
// no longer throws mid-filter and silently freezes the list), and the
// search input stops game-hotkey key events from swallowing keystrokes.
// If typing still does nothing after this, open devtools and check for a
// "[wiki] search error:" console line — that confirms it's a data-shape
// issue in wiki.json rather than an input issue.

const WIKI_DATA_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/wiki-data/wiki.json';

const STYLE_ID = 'ol-wiki-plugin-style';

const WIKI_STYLE = `
  .wiki-root {
    display: flex; flex-direction: column; height: 100%; min-height: 0;
    /* single scale knob — everything below is em off this */
    font-size: clamp(02px, 1.05vw, 32px);
  }

  /* ---------- home / front page ---------- */
  .wiki-home { padding: 1.3em 1.1em; overflow-y: auto; }
  .wiki-home-title {
    color: var(--ol-text); font-size: 1.5em; font-weight: bold; margin-bottom: 0.3em;
  }
  .wiki-home-desc {
    color: var(--ol-text-secondary); font-size: 1em; line-height: 1.5; margin-bottom: 1em;
  }
  .wiki-home-stats { display: flex; gap: 1.2em; margin-bottom: 1.2em; }
  .wiki-home-stat { color: var(--ol-text-tertiary); font-size: 0.95em; }
  .wiki-home-stat b { color: var(--ol-accent); font-size: 1.15em; }
  .wiki-home-browse-btn {
    display: inline-block; background: var(--ol-accent); color: var(--ol-bg); font-weight: bold;
    font-size: 1em; border: none; border-radius: 0.45em; padding: 0.55em 1.1em; cursor: pointer;
  }
  .wiki-home-browse-btn:hover { filter: brightness(1.08); }

  /* ---------- list view ---------- */
  .wiki-search-wrap { padding: 0.6em 0.7em; border-bottom: 1px solid #2e2818; }
  .wiki-search-input {
    box-sizing: border-box; width: 100%; background: var(--ol-bg); color: var(--ol-text);
    border: 1px solid #2e2818; border-radius: 0.45em; padding: 0.5em 0.65em; font-size: 1em;
    font-family: inherit;
  }
  .wiki-search-input:focus { outline: none; border-color: var(--ol-accent); }
  .wiki-list-header {
    display: flex; align-items: center; justify-content: space-between; padding: 0.5em 0.9em 0.2em;
  }
  .wiki-list-header-label { color: var(--ol-text-tertiary); font-size: 0.9em; }
  .wiki-list-back-link { color: var(--ol-accent); font-size: 0.9em; cursor: pointer; }
  .wiki-list-back-link:hover { text-decoration: underline; }
  .wiki-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0.3em 0.5em; }
  .wiki-row {
    display: flex; align-items: center; gap: 0.75em; padding: 0.5em 0.6em; border-radius: 0.45em;
    cursor: pointer;
  }
  .wiki-row:hover { background: var(--ol-panel-bg); }
  .wiki-row-icon {
    flex-shrink: 0; width: 1.9em; height: 1.9em; border-radius: 0.4em; display: flex;
    align-items: center; justify-content: center; font-size: 0.9em; font-weight: bold;
    color: var(--ol-bg);
  }
  .wiki-row-icon-item { background: var(--ol-accent); }
  .wiki-row-icon-npc { background: #c96a4a; }
  .wiki-row-text { min-width: 0; }
  .wiki-row-name {
    color: var(--ol-text); font-size: 1.05em; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis;
  }
  .wiki-row-sub { color: var(--ol-text-tertiary); font-size: 0.9em; }
  .wiki-empty, .wiki-loading, .wiki-error {
    color: var(--ol-text-tertiary); font-size: 1em; text-align: center; padding: 1.6em 0.7em;
  }
  .wiki-error { color: #d4695f; }

  /* ---------- detail / "wiki page" view ---------- */
  .wiki-detail { padding: 0.9em 1em; overflow-y: auto; }
  .wiki-page-title {
    color: var(--ol-text); font-size: 1.4em; font-weight: bold; border-bottom: 2px solid #2e2818;
    padding-bottom: 0.4em; margin-bottom: 0.3em; display: flex; align-items: center; gap: 0.6em;
  }
  .wiki-page-title .wiki-page-kind {
    font-size: 0.62em; font-weight: normal; color: var(--ol-text-tertiary); text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .wiki-page-body { display: flex; gap: 1em; align-items: flex-start; flex-wrap: wrap; }
  .wiki-page-main { flex: 1 1 260px; min-width: 0; }

  .wiki-infobox {
    flex: 0 0 16em; width: 16em; background: var(--ol-panel-bg); border: 1px solid #2e2818;
    border-radius: 0.55em; overflow: hidden;
  }
  .wiki-infobox-header {
    background: var(--ol-accent); color: var(--ol-bg); font-weight: bold; font-size: 0.95em;
    padding: 0.5em 0.7em; text-align: center;
  }
  .wiki-infobox-icon {
    display: flex; align-items: center; justify-content: center; height: 4.6em;
    font-size: 1.4em; font-weight: bold; color: var(--ol-text-tertiary);
    border-bottom: 1px solid #2e2818; background: var(--ol-bg);
  }
  .wiki-infobox-table { width: 100%; border-collapse: collapse; }
  .wiki-infobox-table tr:nth-child(even) { background: var(--ol-bg); }
  .wiki-infobox-table td {
    font-size: 0.85em; padding: 0.35em 0.65em; vertical-align: top; border-top: 1px solid #241f14;
  }
  .wiki-infobox-table tr:first-child td { border-top: none; }
  .wiki-infobox-table td.wiki-infobox-label { color: var(--ol-text-tertiary); white-space: nowrap; }
  .wiki-infobox-table td.wiki-infobox-value { color: var(--ol-text); font-weight: 600; text-align: right; }

  .wiki-examine {
    color: var(--ol-text-secondary); font-size: 0.98em; font-style: italic; line-height: 1.45;
    margin: 0.7em 0 1em; border-left: 3px solid #2e2818; padding-left: 0.7em;
  }

  .wiki-section-title {
    color: var(--ol-text); font-size: 1.05em; font-weight: bold; margin: 1.1em 0 0.55em;
    border-bottom: 1px solid #2e2818; padding-bottom: 0.3em;
  }

  /* combat bonuses table, OSRS-wiki style */
  .wiki-bonus-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  .wiki-bonus-table th, .wiki-bonus-table td {
    border: 1px solid #2e2818; padding: 0.4em 0.45em; text-align: center;
  }
  .wiki-bonus-table th { background: var(--ol-panel-bg); color: var(--ol-text-tertiary); font-weight: 600; }
  .wiki-bonus-table td.wiki-bonus-row-label {
    background: var(--ol-panel-bg); color: var(--ol-text-tertiary); font-weight: 600; text-align: left;
  }
  .wiki-bonus-table td { color: var(--ol-text); }
  .wiki-bonus-table td.wiki-bonus-pos { color: #7cc47f; }
  .wiki-bonus-table td.wiki-bonus-neg { color: #d4695f; }

  .wiki-other-bonuses { display: flex; flex-wrap: wrap; gap: 0.5em 1.3em; margin-top: 0.5em; }
  .wiki-other-bonus { font-size: 0.85em; color: var(--ol-text-secondary); }
  .wiki-other-bonus b { color: var(--ol-accent); }

  .wiki-actions { display: flex; flex-wrap: wrap; gap: 0.4em; }
  .wiki-action-pill {
    background: var(--ol-panel-bg); border: 1px solid #2e2818; color: var(--ol-text-secondary);
    border-radius: 0.85em; padding: 0.2em 0.65em; font-size: 0.9em;
  }
`;

function ensureStyleInjected() {
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    // Keep it live-updated across dev reloads instead of only on first
    // injection, so style fixes here actually show up without a full
    // client restart.
    existing.textContent = WIKI_STYLE;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = WIKI_STYLE;
  document.head.appendChild(style);
}

function init(api) {
  let wikiData = null; // { entries: [...] } once loaded
  let loadError = null;
  let loadPromise = null;

  let searchText = '';
  let browseAll = false; // true once user hits "Browse all" from the home page
  let openEntryId = null; // null = list/home view, else showing that entry's page

  function fetchWikiData() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch(`${WIKI_DATA_URL}?t=${Date.now()}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`wiki.json fetch failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        wikiData = data;
      })
      .catch((err) => {
        api.warn('failed to load wiki-data/wiki.json:', err);
        loadError = err;
      });
    return loadPromise;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // Defensive: entries with a missing/non-string `name` used to throw here,
  // which killed the whole filter mid-keystroke and made search look
  // completely dead (nothing updates, no error visible on screen).
  function safeName(entry) {
    return typeof entry?.name === 'string' ? entry.name : '';
  }

  function matchesSearch(entry, q) {
    if (!q) return true;
    return safeName(entry).toLowerCase().includes(q);
  }

  function iconLetter(entry) {
    return entry.kind === 'npc' ? 'N' : 'I';
  }

  function listRowHtml(entry) {
    return `
      <div class="wiki-row" data-open="${entry.id}">
        <span class="wiki-row-icon wiki-row-icon-${entry.kind}">${iconLetter(entry)}</span>
        <div class="wiki-row-text">
          <div class="wiki-row-name">${escapeHtml(safeName(entry) || '(unnamed)')}</div>
          <div class="wiki-row-sub">${entry.kind === 'npc' ? 'NPC' : 'Item'}${
      entry.kind === 'npc' && entry.combatLevel != null ? ` &middot; Level ${entry.combatLevel}` : ''
    }</div>
        </div>
      </div>
    `;
  }

  function infoboxRowsForItem(entry) {
    const rows = [];
    if (entry.value != null) rows.push(['Value', `${entry.value.toLocaleString()} gp`]);
    if (entry.weight != null) rows.push(['Weight', `${(entry.weight / 1000).toFixed(2)} kg`]);
    rows.push(['Tradeable', entry.tradeable ? 'Yes' : 'No']);
    rows.push(['Stackable', entry.stackable ? 'Yes' : 'No']);
    if (entry.equip) {
      rows.push(['Slot', entry.equip.slot || 'Unknown']);
    }
    return rows;
  }

  function infoboxRowsForNpc(entry) {
    const rows = [];
    if (entry.combatLevel != null) rows.push(['Combat level', String(entry.combatLevel)]);
    if (entry.hitpoints != null) rows.push(['Hitpoints', String(entry.hitpoints)]);
    if (entry.attackable != null) rows.push(['Attackable', entry.attackable ? 'Yes' : 'No']);
    return rows;
  }

  function infoboxHtml(entry) {
    const rows = entry.kind === 'npc' ? infoboxRowsForNpc(entry) : infoboxRowsForItem(entry);
    return `
      <div class="wiki-infobox">
        <div class="wiki-infobox-header">${escapeHtml(safeName(entry))}</div>
        <div class="wiki-infobox-icon">${iconLetter(entry)}</div>
        <table class="wiki-infobox-table">
          ${rows
            .map(
              ([label, val]) =>
                `<tr><td class="wiki-infobox-label">${escapeHtml(label)}</td><td class="wiki-infobox-value">${escapeHtml(
                  val
                )}</td></tr>`
            )
            .join('')}
        </table>
      </div>
    `;
  }

  function bonusCell(v) {
    if (v == null) v = 0;
    const cls = v > 0 ? 'wiki-bonus-pos' : v < 0 ? 'wiki-bonus-neg' : '';
    return `<td class="${cls}">${v > 0 ? '+' : ''}${v}</td>`;
  }

  function combatStatsHtml(entry) {
    if (entry.kind !== 'item' || !entry.equip) return '';
    const e = entry.equip;
    const atk = [e.stabAttack, e.slashAttack, e.crushAttack, e.magicAttack, e.rangeAttack];
    const def = [e.stabDefence, e.slashDefence, e.crushDefence, e.magicDefence, e.rangeDefence];
    const other = [
      ['Strength', e.strengthBonus],
      ['Ranged Str', e.rangeBonus],
      ['Attack speed', e.attackRate],
    ].filter(([, v]) => v != null && v !== 0);

    const hasAtk = atk.some((v) => v != null && v !== 0);
    const hasDef = def.some((v) => v != null && v !== 0);
    if (!hasAtk && !hasDef && !other.length) return '';

    return `
      <div class="wiki-section-title">Combat Stats</div>
      <table class="wiki-bonus-table">
        <thead>
          <tr><th></th><th>Stab</th><th>Slash</th><th>Crush</th><th>Magic</th><th>Range</th></tr>
        </thead>
        <tbody>
          <tr><td class="wiki-bonus-row-label">Attack</td>${atk.map(bonusCell).join('')}</tr>
          <tr><td class="wiki-bonus-row-label">Defence</td>${def.map(bonusCell).join('')}</tr>
        </tbody>
      </table>
      ${
        other.length
          ? `<div class="wiki-other-bonuses">${other
              .map(([label, v]) => `<span class="wiki-other-bonus">${label}: <b>${v > 0 ? '+' : ''}${v}</b></span>`)
              .join('')}</div>`
          : ''
      }
    `;
  }

  function detailHtml(entry) {
    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(safeName(entry))}
          <span class="wiki-page-kind">${entry.kind === 'npc' ? 'NPC' : 'Item'}</span>
        </div>
        <div class="wiki-page-body">
          <div class="wiki-page-main">
            <div class="wiki-examine">${escapeHtml(entry.examine || 'No description available.')}</div>
            ${combatStatsHtml(entry)}
            ${
              entry.kind === 'item' && entry.actions && entry.actions.length
                ? `<div class="wiki-section-title">Actions</div><div class="wiki-actions">${entry.actions
                    .map((a) => `<span class="wiki-action-pill">${escapeHtml(a)}</span>`)
                    .join('')}</div>`
                : ''
            }
          </div>
          ${infoboxHtml(entry)}
        </div>
      </div>
    `;
  }

  function homeHtml() {
    const items = wikiData.entries.filter((e) => e.kind !== 'npc').length;
    const npcs = wikiData.entries.filter((e) => e.kind === 'npc').length;
    return `
      <div class="wiki-home">
        <div class="wiki-home-title">Oldrune Wiki</div>
        <div class="wiki-home-desc">
          Search for an item or NPC above, or browse everything the wiki currently knows about.
        </div>
        <div class="wiki-home-stats">
          <div class="wiki-home-stat"><b>${items}</b> items</div>
          <div class="wiki-home-stat"><b>${npcs}</b> NPCs</div>
        </div>
        <button class="wiki-home-browse-btn" id="wiki-browse-all">Browse all</button>
      </div>
    `;
  }

  function renderWiki(container, exit) {
    ensureStyleInjected();

    function paint() {
      container.innerHTML = `
        <div class="ol-list-header">
          <span class="ol-back-btn" id="wiki-back" title="Back">&#x2190;</span>
          <span class="ol-list-title">Wiki</span>
        </div>
        <div class="wiki-root"></div>
      `;
      container.querySelector('#wiki-back').addEventListener('click', () => {
        if (openEntryId) {
          openEntryId = null;
          paint();
        } else if (browseAll || searchText) {
          browseAll = false;
          searchText = '';
          paint();
        } else {
          exit();
        }
      });

      const root = container.querySelector('.wiki-root');

      if (loadError) {
        root.innerHTML = `<div class="wiki-error">Couldn't load wiki data.<br>${escapeHtml(loadError.message)}</div>`;
        return;
      }
      if (!wikiData) {
        root.innerHTML = `<div class="wiki-loading">Loading wiki data&hellip;</div>`;
        return;
      }

      if (openEntryId) {
        const entry = wikiData.entries.find((e) => e.id === openEntryId);
        if (!entry) {
          openEntryId = null;
          paint();
          return;
        }
        root.innerHTML = detailHtml(entry);
        return;
      }

      const showingList = browseAll || searchText.trim().length > 0;

      root.innerHTML = `
        <div class="wiki-search-wrap">
          <input type="text" class="wiki-search-input" id="wiki-search" placeholder="Search items and NPCs..." value="${escapeHtml(
            searchText
          )}" />
        </div>
        ${
          showingList
            ? `<div class="wiki-list-header">
                 <span class="wiki-list-header-label" id="wiki-list-label"></span>
                 <span class="wiki-list-back-link" id="wiki-to-home">&larr; Home</span>
               </div>
               <div class="wiki-list" id="wiki-list"></div>`
            : homeHtml()
        }
      `;

      if (!showingList) {
        const browseAllBtn = root.querySelector('#wiki-browse-all');
        if (browseAllBtn) {
          browseAllBtn.addEventListener('click', () => {
            browseAll = true;
            paint();
          });
        }
      }

      const searchInput = root.querySelector('#wiki-search');

      // Game clients that bind global hotkeys/movement to keydown often
      // grab the event before it reaches a focused text input, which looks
      // exactly like "typing does nothing". Stop it from propagating past
      // this input so the browser's own text-input handling always wins.
      ['keydown', 'keyup', 'keypress'].forEach((evt) => {
        searchInput.addEventListener(evt, (e) => {
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        });
      });

      searchInput.addEventListener('input', () => {
        searchText = searchInput.value;
        if (searchText.trim()) browseAll = false;
        // A fresh keystroke changes whether we're in list view or home view,
        // so this needs a full repaint, not just a list refresh.
        paint();
      });

      // Keep focus + caret position stable across the repaint above.
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);

      if (!showingList) return;

      const browseLink = root.querySelector('#wiki-to-home');
      if (browseLink) {
        browseLink.addEventListener('click', () => {
          browseAll = false;
          searchText = '';
          paint();
        });
      }

      const q = searchText.trim().toLowerCase();
      const label = root.querySelector('#wiki-list-label');
      const listEl = root.querySelector('#wiki-list');

      let matches;
      try {
        matches = wikiData.entries.filter((e) => matchesSearch(e, q)).slice(0, 200);
      } catch (err) {
        api.warn('[wiki] search error:', err);
        listEl.innerHTML = `<div class="wiki-error">Search hit a data error: ${escapeHtml(
          err.message
        )}</div>`;
        if (label) label.textContent = '';
        return;
      }

      if (label) {
        label.textContent = q
          ? `${matches.length} result${matches.length === 1 ? '' : 's'}`
          : `All entries (${Math.min(wikiData.entries.length, 200)} of ${wikiData.entries.length} shown)`;
      }

      listEl.innerHTML = matches.length
        ? matches.map(listRowHtml).join('')
        : `<div class="wiki-empty">No matches.</div>`;
      listEl.querySelectorAll('[data-open]').forEach((row) => {
        row.addEventListener('click', () => {
          openEntryId = row.dataset.open;
          paint();
        });
      });
    }

    paint();

    if (!wikiData && !loadError) {
      fetchWikiData().then(paint);
    }
  }

  api.registerSettings({
    title: 'Wiki',
    render: renderWiki,
  });
}

function destroy() {
  // Nothing beyond what api.__cleanup() already handles (container removal,
  // settings unregistration) — no timers/tick subscriptions/overlays here.
  // The injected <style id="ol-wiki-plugin-style"> in document.head is left
  // in place intentionally: it's idempotent (guarded by id) and harmless to
  // leave loaded, same as loader.js-injected global styles elsewhere in
  // OldLite.
}

export default {
  id: 'wiki',
  name: 'Wiki',
  description: 'Searchable in-client wiki for items and NPCs.',
  version: '1.0.5',
  author: 'goku',
  native: true,
  icon: 'Wiki.png',
  init,
  destroy,
};
