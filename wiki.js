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

const WIKI_DATA_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/wiki-data/wiki.json';

function init(api) {
  let wikiData = null; // { entries: [...] } once loaded
  let loadError = null;
  let loadPromise = null;

  let searchText = '';
  let openEntryId = null; // null = list view, else showing that entry's page

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

  function matchesSearch(entry, q) {
    if (!q) return true;
    return entry.name.toLowerCase().includes(q);
  }

  function iconLetter(entry) {
    return entry.kind === 'npc' ? 'N' : 'I';
  }

  function listRowHtml(entry) {
    return `
      <div class="wiki-row" data-open="${entry.id}">
        <span class="wiki-row-icon wiki-row-icon-${entry.kind}">${iconLetter(entry)}</span>
        <div class="wiki-row-text">
          <div class="wiki-row-name">${escapeHtml(entry.name)}</div>
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
    rows.push(['Members', entry.membersOnly ? 'Yes' : 'No']);
    rows.push(['Tradeable', entry.tradeable ? 'Yes' : 'No']);
    rows.push(['Stackable', entry.stackable ? 'Yes' : 'No']);
    if (entry.equip) {
      rows.push(['Equip slot', entry.equip.slot || 'Unknown']);
    }
    return rows;
  }

  function infoboxRowsForNpc(entry) {
    const rows = [];
    if (entry.combatLevel != null) rows.push(['Combat level', String(entry.combatLevel)]);
    if (entry.hitpoints != null) rows.push(['Hitpoints', String(entry.hitpoints)]);
    rows.push(['Members', entry.members ? 'Yes' : 'No']);
    if (entry.attackable != null) rows.push(['Attackable', entry.attackable ? 'Yes' : 'No']);
    return rows;
  }

  function combatStatsTableHtml(entry) {
    if (entry.kind !== 'item' || !entry.equip) return '';
    const e = entry.equip;
    const atk = [
      ['Stab', e.stabAttack],
      ['Slash', e.slashAttack],
      ['Crush', e.crushAttack],
      ['Magic', e.magicAttack],
      ['Range', e.rangeAttack],
    ].filter(([, v]) => v != null && v !== 0);
    const def = [
      ['Stab', e.stabDefence],
      ['Slash', e.slashDefence],
      ['Crush', e.crushDefence],
      ['Magic', e.magicDefence],
      ['Range', e.rangeDefence],
    ].filter(([, v]) => v != null && v !== 0);
    const bonuses = [
      ['Strength', e.strengthBonus],
      ['Range bonus', e.rangeBonus],
      ['Attack rate', e.attackRate],
    ].filter(([, v]) => v != null && v !== 0);

    if (!atk.length && !def.length && !bonuses.length) return '';

    const cell = ([label, v]) => `<div class="wiki-stat-cell"><span>${label}</span><b>${v > 0 ? '+' : ''}${v}</b></div>`;

    return `
      <div class="wiki-section-title">Combat Stats</div>
      <div class="wiki-stat-grid">
        ${[...atk, ...def, ...bonuses].map(cell).join('')}
      </div>
    `;
  }

  function detailHtml(entry) {
    const rows = entry.kind === 'npc' ? infoboxRowsForNpc(entry) : infoboxRowsForItem(entry);
    return `
      <div class="wiki-detail">
        <div class="wiki-infobox">
          <div class="wiki-infobox-title">${escapeHtml(entry.name)}</div>
          ${rows
            .map(
              ([label, val]) =>
                `<div class="wiki-infobox-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(val)}</b></div>`
            )
            .join('')}
        </div>
        <div class="wiki-examine">${escapeHtml(entry.examine || 'No description available.')}</div>
        ${combatStatsTableHtml(entry)}
        ${
          entry.kind === 'item' && entry.actions && entry.actions.length
            ? `<div class="wiki-section-title">Actions</div><div class="wiki-actions">${entry.actions
                .map((a) => `<span class="wiki-action-pill">${escapeHtml(a)}</span>`)
                .join('')}</div>`
            : ''
        }
      </div>
    `;
  }

  function renderWiki(container, exit) {
    const style = document.createElement('style');
    style.textContent = `
      .wiki-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      .wiki-search-wrap { padding: 8px 10px; border-bottom: 1px solid #2e2818; }
      .wiki-search-input {
        box-sizing: border-box; width: 100%; background: var(--ol-bg); color: var(--ol-text);
        border: 1px solid #2e2818; border-radius: 6px; padding: 7px 9px; font-size: 1.15vw;
        font-family: inherit;
      }
      .wiki-search-input:focus { outline: none; border-color: var(--ol-accent); }
      .wiki-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px; }
      .wiki-row {
        display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 6px;
        cursor: pointer;
      }
      .wiki-row:hover { background: var(--ol-panel-bg); }
      .wiki-row-icon {
        flex-shrink: 0; width: 22px; height: 22px; border-radius: 5px; display: flex;
        align-items: center; justify-content: center; font-size: 1.05vw; font-weight: bold;
        color: var(--ol-bg);
      }
      .wiki-row-icon-item { background: var(--ol-accent); }
      .wiki-row-icon-npc { background: #c96a4a; }
      .wiki-row-name { color: var(--ol-text); font-size: 1.2vw; }
      .wiki-row-sub { color: var(--ol-text-tertiary); font-size: 1.02vw; }
      .wiki-empty { color: var(--ol-text-tertiary); font-size: 1.15vw; text-align: center; padding: 24px 10px; }

      .wiki-detail { padding: 10px 12px; overflow-y: auto; }
      .wiki-infobox {
        background: var(--ol-panel-bg); border: 1px solid #2e2818; border-radius: 8px;
        padding: 10px 12px; margin-bottom: 12px;
      }
      .wiki-infobox-title { color: var(--ol-text); font-size: 1.4vw; font-weight: bold; margin-bottom: 8px; }
      .wiki-infobox-row {
        display: flex; justify-content: space-between; gap: 10px; padding: 3px 0;
        font-size: 1.08vw; border-top: 1px solid #241f14;
      }
      .wiki-infobox-row:first-of-type { border-top: none; }
      .wiki-infobox-row span { color: var(--ol-text-tertiary); }
      .wiki-infobox-row b { color: var(--ol-text); font-weight: 600; }
      .wiki-examine { color: var(--ol-text-secondary); font-size: 1.12vw; font-style: italic; line-height: 1.4; margin-bottom: 10px; }
      .wiki-section-title { color: var(--ol-text); font-size: 1.2vw; font-weight: bold; margin: 12px 0 6px; }
      .wiki-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; }
      .wiki-stat-cell { display: flex; justify-content: space-between; font-size: 1.05vw; color: var(--ol-text-secondary); }
      .wiki-stat-cell b { color: var(--ol-accent); }
      .wiki-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .wiki-action-pill {
        background: var(--ol-panel-bg); border: 1px solid #2e2818; color: var(--ol-text-secondary);
        border-radius: 12px; padding: 3px 10px; font-size: 1.02vw;
      }
      .wiki-loading, .wiki-error { color: var(--ol-text-tertiary); font-size: 1.15vw; text-align: center; padding: 24px 10px; }
    `;

    function paint() {
      container.innerHTML = `
        <div class="ol-list-header">
          <span class="ol-back-btn" id="wiki-back" title="Back">&#x2190;</span>
          <span class="ol-list-title">${openEntryId ? 'Wiki' : 'Wiki'}</span>
        </div>
        <div class="wiki-root"></div>
      `;
      container.querySelector('#wiki-back').addEventListener('click', () => {
        if (openEntryId) {
          openEntryId = null;
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

      root.innerHTML = `
        <div class="wiki-search-wrap">
          <input type="text" class="wiki-search-input" id="wiki-search" placeholder="Search items and NPCs..." value="${escapeHtml(
            searchText
          )}" />
        </div>
        <div class="wiki-list" id="wiki-list"></div>
      `;

      const searchInput = root.querySelector('#wiki-search');
      searchInput.addEventListener('input', () => {
        searchText = searchInput.value;
        renderList();
      });
      // Keep focus + caret position stable across re-renders while typing.
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);

      function renderList() {
        const q = searchText.trim().toLowerCase();
        const matches = wikiData.entries.filter((e) => matchesSearch(e, q)).slice(0, 200);
        const listEl = root.querySelector('#wiki-list');
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
      renderList();
    }

    container.appendChild(style);
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
}

export default {
  id: 'wiki',
  name: 'Wiki',
  description: 'Searchable in-client wiki for items and NPCs.',
  version: '1.0.0',
  author: 'goku',
  native: true,
  icon: 'Wiki.png',
  init,
  destroy,
};
