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
//   - No shop-location / drop-table tables yet (needs shop_data.json /
//     shared_drops.json wiring, also a follow-up).
//
// UI: uses api.registerSettings({ render }) — the same custom-render
// escape hatch Community Hub's Notepad-style plugins use — because this
// needs real list -> detail navigation, not the fixed field/section
// settings schema.
//
// State: none persisted (except Saved Pages, see v1.6 below). Search
// text and the currently-open page are in-memory render state, reset
// each time the panel opens.
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
// never goes unreadably small/huge on extreme window sizes).
//
// v1.7 changes -- sticky header, table icons, herb id, combat stat rows:
//   - The back button / "Wiki" title bar and the search input are now
//     rendered ONCE, inside a `.wiki-sticky-top` wrapper that sits
//     outside the scrolling content (`.wiki-scroll-area`), instead of
//     being rebuilt per-view (and, for the search bar, only on the
//     list/home view). This means: (a) the search bar is now visible
//     and usable on every page, including detail pages -- typing in it
//     while a detail page is open backs out to the list/search-results
//     view; (b) the back button + search bar stay glued to the top of
//     the panel while the content below them scrolls.
//   - Every paint() branch now explicitly resets `.wiki-scroll-area`'s
//     scrollTop to 0 both synchronously and on the next animation frame
//     (scrollToTop()), instead of only doing it (unreliably) inside the
//     detail-page branch. This is what actually fixes "opening a new
//     page doesn't scroll to the top" -- the previous approach reset
//     scrollTop on `container`/`root`, but the element that actually had
//     the scrollbar (varies by panel host) wasn't reliably one of those.
//   - Synthesized shared-drop-table pages (herb/jewel/rare-drop/mega-rare)
//     now carry a `sourceId` (see TABLE_ICON_ITEM_NAMES + buildDropTables)
//     so they get a real icon in lists and their own page, the same way
//     item/npc/clue pages already did. References to a shared table from
//     inside another table's rows or an NPC's drop list (previously
//     always iconless, `iconHtml: ''`) now also draw that table's icon.
//   - Herb-table rows (`sharedDropTables.randomherb`) now resolve to
//     their real, identified herb entry (e.g. "Guam leaf") instead of the
//     unidentified pickup item, via identifiedHerbEntry() -- both the
//     name shown and the link target change, everywhere a herb-table row
//     is rendered (the herb table's own page, and NPC drop lists that
//     reference it).
//   - npcCombatStatsHtml() no longer renders a <table>; it now renders
//     the same one-row-per-stat list style used by drop tables
//     (icon-less, orange label, grey value, no quantity column) for
//     visual consistency with the rest of the detail page.
//   - Home page reordered to Title -> stat counts -> description ->
//     browse buttons, and every browse/saved-pages button now shares one
//     visual style (solid orange, full width, one per row) instead of
//     "Browse All" being visually distinct from the rest.
//
// v1.6 changes -- clue icons, real shop data shape, saved pages, browse
// categories, NPC combat stats:
//   - Clue scroll pages now show an icon. All 3 tiers are visually
//     identical in-game, so rather than guess a sprite id we just borrow
//     the sourceId off whichever real "Clue scroll (...)" item entry
//     wiki.json still has lying around in wikiData.entries (it's already
//     excluded from visibleEntries()/search -- this only reads its
//     sprite id) -- see findClueSpriteSourceId().
//   - Shop parsing rewritten to match the real wiki.json shape: a shop's
//     shopkeeper(s) come from `npcDebugnames`/`npcIds`, not a generic
//     `npc` field, and each stock row is `{ debugname, itemId,
//     sharedTableRef, conditional, quantity }` with NO explicit price --
//     price is always derived from the item's value (derivedShopPrice).
//     The shop detail page's Stock section is now a real <table> (Item /
//     Stock / Cost columns) per plan, instead of the icon-stack rows
//     used for drop tables.
//   - Saved Pages: every detail page (item/npc/shop/droptable/clue) now
//     has a star toggle in the top-right of its title bar. Starring
//     persists the page id to localStorage (this is in-client plugin
//     code, not a claude.ai artifact, so real browser storage is fine
//     here) so it survives reopening the panel/client.
//   - Home page now has a full set of browse-by-category entry points
//     (Browse All / Items / NPCs / Shops / Drop Tables / Saved Pages)
//     instead of just one generic "Browse all" button. "Drop Tables"
//     covers both 'droptable' and 'clue' kind pages, since clues are
//     conceptually drop tables too.
//   - NPCs now get their own "Combat Stats" table (Style/Attack/
//     Strength/Magic/the four defence stats), read off the NPC's
//     `combat` object and `damageType`, mirroring the item equip-bonus
//     table below it. NPC infobox also now shows Respawn rate, Hunt
//     range, Max range and Wander range when present.

const WIKI_DATA_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/wiki-data/wiki.json';

const ITEM_SPRITESHEET_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/sprites/item_spritesheet.png';

const NPC_SPRITESHEET_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/sprites/npc_spritesheet.png';

const STYLE_ID = 'ol-wiki-plugin-style';
const SAVED_PAGES_KEY = 'oldlite-wiki-saved-pages';

// ---------------------------------------------------------------------
// Sprite sheet layout — copied verbatim from losthq's js/spriteLoader.js
// (itemSpriteSize/itemSpritesPerRow and npcSpriteSize/npcSpritesPerRow).
// Do not "fix" these to both be 64/64 — the NPC sheet really is laid out
// differently from the item sheet in the source client.
// ---------------------------------------------------------------------
const ITEM_SPRITE_SIZE = 32;
const ITEM_SPRITES_PER_ROW = 64;
const NPC_SPRITE_SIZE = 256;
const NPC_SPRITES_PER_ROW = 32;

const WIKI_STYLE = `
  .wiki-root {
    display: flex; flex-direction: column; height: 100%; min-height: 0;
    /* single scale knob — everything below is em off this */
    font-size: clamp(2px, 1.05vw, 32px);
    overflow-x: hidden;
  }

  /* ---------- sticky header + search (always visible, all views) ---------- */
  .wiki-sticky-top { flex-shrink: 0; }
  .wiki-scroll-area { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }

  /* ---------- home / front page ---------- */
  .wiki-home { padding: 1.3em 1.1em; }
  .wiki-home-title {
    color: var(--ol-text); font-size: 1.5em; font-weight: bold; margin-bottom: 0.3em;
  }
  .wiki-home-desc {
    color: var(--ol-text-secondary); font-size: 1em; line-height: 1.5; margin-bottom: 1em;
  }
  .wiki-home-stats { display: flex; gap: 1.2em; margin-bottom: 1.2em; flex-wrap: wrap; }
  .wiki-home-stat { color: var(--ol-text-tertiary); font-size: 0.95em; }
  .wiki-home-stat b { color: var(--ol-accent); font-size: 1.15em; }
  .wiki-home-browse-grid { display: flex; flex-direction: column; gap: 0.55em; }
  .wiki-home-browse-btn {
    display: block; width: 100%; box-sizing: border-box; background: var(--ol-accent); color: var(--ol-bg);
    font-weight: bold; font-size: 1.05em; border: none; border-radius: 0.5em; padding: 0.75em 1.1em;
    cursor: pointer; text-align: center;
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
  .wiki-list { padding: 0.3em 0.5em; }
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
  .wiki-row-icon-shop { background: #4a8fc9; }
  .wiki-row-icon-droptable { background: #8a5fc9; }
  .wiki-row-icon-clue { background: #c9a44a; }
  .wiki-row-sprite {
    flex-shrink: 0; display: block; width: 1.9em; height: 1.9em; border-radius: 0.4em;
    background: var(--ol-bg); image-rendering: pixelated; image-rendering: crisp-edges;
  }
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
  .wiki-detail { padding: 0.9em 1em; overflow-x: hidden; box-sizing: border-box; }
  .wiki-page-title {
    color: var(--ol-text); font-size: 1.4em; font-weight: bold; border-bottom: 2px solid #2e2818;
    padding-bottom: 0.4em; margin-bottom: 0.7em; display: flex; align-items: center; gap: 0.6em;
    overflow-wrap: break-word; word-break: break-word;
  }
  .wiki-page-title .wiki-page-kind {
    font-size: 0.62em; font-weight: normal; color: var(--ol-text-tertiary); text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .wiki-star-btn {
    margin-left: auto; cursor: pointer; font-size: 1em; line-height: 1; color: var(--ol-text-tertiary);
    flex-shrink: 0; padding: 0 0.1em; user-select: none;
  }
  .wiki-star-btn:hover { color: var(--ol-accent); }
  .wiki-star-btn.wiki-star-active { color: #e0c343; }
  .wiki-infobox {
    width: 100%; max-width: 100%; box-sizing: border-box; background: var(--ol-panel-bg);
    border: 1px solid #2e2818; border-radius: 0.55em; overflow: hidden; margin-bottom: 1em;
  }
  .wiki-infobox-examine {
    color: var(--ol-text-secondary); font-size: 0.9em; font-style: italic; line-height: 1.4;
    padding: 0.65em 0.8em; border-bottom: 1px solid #2e2818; overflow-wrap: break-word;
    word-break: break-word;
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
  .wiki-infobox-sprite-canvas {
    display: block; width: 4.6em; height: 4.6em; flex-shrink: 0;
    image-rendering: pixelated; image-rendering: crisp-edges;
  }
  .wiki-infobox-table { width: 100%; border-collapse: collapse; }
  .wiki-infobox-table tr:nth-child(even) { background: var(--ol-bg); }
  .wiki-infobox-table td {
    font-size: 0.9em; padding: 0.2em 0.65em; vertical-align: top; border-top: 1px solid #241f14;
  }
  .wiki-infobox-table tr:first-child td { border-top: none; }
  .wiki-infobox-table td.wiki-infobox-label { color: var(--ol-text-tertiary); white-space: nowrap; }
  .wiki-infobox-table td.wiki-infobox-value {
    color: var(--ol-text); font-weight: 600; text-align: right; overflow-wrap: break-word;
    word-break: break-word;
  }

  .wiki-section-title {
    color: var(--ol-text); font-size: 1.05em; font-weight: bold; margin: 1.1em 0 0.55em;
    border-bottom: 1px solid #2e2818; padding-bottom: 0.3em;
  }

  /* combat bonuses table, OSRS-wiki style (item equip bonuses only —
     NPC combat stats now use the .wiki-drop-row list style below) */
  .wiki-bonus-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 0.85em; }
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

  /* ---------- shop stock table (Item / Stock / Cost) ---------- */
  .wiki-shop-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  .wiki-shop-table th {
    background: var(--ol-panel-bg); color: var(--ol-text-tertiary); font-weight: 600;
    text-align: left; padding: 0.4em 0.5em; border-bottom: 1px solid #2e2818;
  }
  .wiki-shop-table th.wiki-shop-col-num, .wiki-shop-table td.wiki-shop-col-num { text-align: right; }
  .wiki-shop-table td {
    padding: 0.4em 0.5em; border-top: 1px solid #241f14; vertical-align: middle; color: var(--ol-text);
  }
  .wiki-shop-item-inner { display: flex; align-items: center; gap: 0.6em; }
  .wiki-shop-item-inner .wiki-drop-icon { flex-shrink: 0; }

  /* ---------- drop / stock / shared-table rows (icon+name, then qty+rarity) ---------- */
  /* Also reused (icon-less) for the NPC Combat Stats section, so each
     stat is its own row: orange label, grey value, no quantity col. */
  .wiki-drop-list { margin-bottom: 0.4em; }
  .wiki-drop-row {
    display: flex; align-items: center; gap: 0.7em; padding: 0.5em 0.3em;
    border-top: 1px solid #241f14;
  }
  .wiki-drop-row:first-child { border-top: none; }
  .wiki-drop-icon {
    flex-shrink: 0; width: 1.9em; height: 1.9em; border-radius: 0.4em;
    background: var(--ol-bg); image-rendering: pixelated; image-rendering: crisp-edges;
  }
  .wiki-drop-body { flex: 1; min-width: 0; }
  .wiki-drop-name { color: var(--ol-accent); font-size: 0.95em; overflow-wrap: break-word; word-break: break-word; }
  .wiki-drop-meta {
    display: flex; justify-content: space-between; gap: 0.6em; color: var(--ol-text-tertiary);
    font-size: 0.8em; margin-top: 0.15em;
  }

  .wiki-link {
    color: var(--ol-accent); cursor: pointer; text-decoration: none;
  }
  .wiki-link:hover { text-decoration: underline; }
  .wiki-subnote {
    color: var(--ol-text-tertiary); font-size: 0.75em; font-style: italic; margin: -0.2em 0 0.6em;
  }
  .wiki-empty-section {
    color: var(--ol-text-tertiary); font-size: 0.9em; font-style: italic; padding: 0.3em 0 0.6em;
  }
  .wiki-plain-list { margin: 0 0 0.6em; padding-left: 1.2em; color: var(--ol-text); font-size: 0.9em; }
  .wiki-plain-text { color: var(--ol-text); font-size: 0.9em; margin-bottom: 0.6em; }

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

// ---------------------------------------------------------------------
// Sprite extraction / rendering — ported 1:1 from losthq's
// js/spriteLoader.js (loadSpriteSheet + drawItemImage/drawNPCImage).
//
// Kept at module scope (not inside init()) so the decoded bitmaps are
// cached for the whole client session and don't get re-fetched every
// time the wiki panel is opened/closed, same as losthq's own
// itemBitmap/npcBitmap module-level state.
// ---------------------------------------------------------------------
let itemBitmap = null;
let itemBitmapWidth = 0;
let itemBitmapHeight = 0;
let itemBitmapLoading = null;
let itemBitmapFailed = false;

let npcBitmap = null;
let npcBitmapWidth = 0;
let npcBitmapHeight = 0;
let npcBitmapLoading = null;
let npcBitmapFailed = false;

function loadSpriteSheet(kind) {
  if (kind === 'item') {
    if (itemBitmap || itemBitmapFailed) return Promise.resolve(itemBitmap);
    if (itemBitmapLoading) return itemBitmapLoading;

    itemBitmapLoading = (async () => {
      try {
        const res = await fetch(ITEM_SPRITESHEET_URL);
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        itemBitmap = bitmap;
        itemBitmapWidth = bitmap.width;
        itemBitmapHeight = bitmap.height;
        itemBitmapLoading = null;
        return itemBitmap;
      } catch (e) {
        itemBitmapFailed = true;
        itemBitmapLoading = null;
        console.error('[wiki] failed to load item spritesheet:', e);
        throw e;
      }
    })();
    return itemBitmapLoading;
  }

  if (kind === 'npc') {
    if (npcBitmap || npcBitmapFailed) return Promise.resolve(npcBitmap);
    if (npcBitmapLoading) return npcBitmapLoading;

    npcBitmapLoading = (async () => {
      try {
        const res = await fetch(NPC_SPRITESHEET_URL);
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        npcBitmap = bitmap;
        npcBitmapWidth = bitmap.width;
        npcBitmapHeight = bitmap.height;
        npcBitmapLoading = null;
        return npcBitmap;
      } catch (e) {
        npcBitmapFailed = true;
        npcBitmapLoading = null;
        console.error('[wiki] failed to load npc spritesheet:', e);
        throw e;
      }
    })();
    return npcBitmapLoading;
  }

  return Promise.resolve(null);
}

// Draws one entry's icon into a <canvas data-sprite-kind="item|npc"
// data-sprite-id="<sourceId>">. Mirrors losthq's
// renderItemSpriteToCanvas/renderNPCSpriteToCanvas: guarded by a "done"
// attribute so a canvas is only ever drawn once, and falls back to
// waiting on loadSpriteSheet() + redrawing if the bitmap isn't decoded
// yet (exactly like drawItemImage/drawNPCImage do when itemBitmap/
// npcBitmap is still null).
function drawSpriteToCanvas(canvas) {
  if (canvas.getAttribute('done')) return;
  canvas.setAttribute('done', 'true');

  const kind = canvas.getAttribute('data-sprite-kind') === 'npc' ? 'npc' : 'item';
  const sourceId = Number(canvas.getAttribute('data-sprite-id'));
  if (!Number.isFinite(sourceId) || sourceId < 0) return;

  const spriteSize = kind === 'npc' ? NPC_SPRITE_SIZE : ITEM_SPRITE_SIZE;
  const perRow = kind === 'npc' ? NPC_SPRITES_PER_ROW : ITEM_SPRITES_PER_ROW;

  // Same coordinate math as losthq: column/row from the flat sprite
  // index, times the fixed per-sheet sprite size.
  const sx = (sourceId % perRow) * spriteSize;
  const sy = Math.floor(sourceId / perRow) * spriteSize;

  const w = canvas.width || spriteSize;
  const h = canvas.height || spriteSize;
  const ctx = canvas.getContext('2d');

  const draw = (bitmap) => {
    if (!bitmap) return;
    const bw = kind === 'npc' ? npcBitmapWidth : itemBitmapWidth;
    const bh = kind === 'npc' ? npcBitmapHeight : itemBitmapHeight;
    if (sx + spriteSize > bw || sy + spriteSize > bh) return;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, sx, sy, spriteSize, spriteSize, 0, 0, w, h);
  };

  const cached = kind === 'npc' ? npcBitmap : itemBitmap;
  if (cached) {
    draw(cached);
    return;
  }

  loadSpriteSheet(kind)
    .then(draw)
    .catch(() => {});
}

// Call after any innerHTML paint that may contain sprite canvases —
// same idea as losthq calling renderItemSpriteToCanvas/
// renderNPCSpriteToCanvas right after inserting each canvas into the DOM.
function renderSpritesIn(root) {
  root.querySelectorAll('canvas[data-sprite-kind]').forEach(drawSpriteToCanvas);
}

function init(api) {
  let wikiData = null; // { entries: [...] } once loaded
  let loadError = null;
  let loadPromise = null;

  let searchText = '';
  let browseCategory = null; // null | 'all' | 'item' | 'npc' | 'shop' | 'droptable' | 'saved'
  let openEntryId = null; // null = list/home view, else showing that entry's page
  let navStack = []; // stack of previous {openEntryId, browseCategory, searchText} states, for Back

  // -----------------------------------------------------------------
  // Saved Pages — persisted to localStorage (this is in-client plugin
  // code, not a claude.ai artifact, so real browser storage works fine
  // and survives closing/reopening the client).
  // -----------------------------------------------------------------
  function loadSavedPageIds() {
    try {
      const raw = localStorage.getItem(SAVED_PAGES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      api.warn('[wiki] failed to load saved pages:', e);
      return new Set();
    }
  }

  function persistSavedPageIds() {
    try {
      localStorage.setItem(SAVED_PAGES_KEY, JSON.stringify(Array.from(savedPageIds)));
    } catch (e) {
      api.warn('[wiki] failed to persist saved pages:', e);
    }
  }

  let savedPageIds = loadSavedPageIds();

  function toggleSaved(id) {
    if (savedPageIds.has(id)) savedPageIds.delete(id);
    else savedPageIds.add(id);
    persistSavedPageIds();
  }

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

  // Bank notes show up in the source data as their own separate item entry
  // (e.g. "Mithril Platelegs" and a distinct "Mithril Platelegs" note-form
  // entry). We don't want those cluttering search/browse as duplicates.
  // Checked in order of how OSRS item dumps usually mark this — if none of
  // these fields exist in your actual wiki.json, tell me the field name it
  // uses instead (or paste one noted + one unnoted entry) and I'll swap
  // this over to match exactly, rather than guessing further.
  function isBankNoteExamine(entry) {
    return typeof entry?.examine === 'string' && /swap this note at any bank for/i.test(entry.examine);
  }

  // Redirects a resolved entry that turns out to be the noted (bank-note)
  // form of an item over to its real, unnoted twin (matched by exact
  // name). Called from inside resolveEntryRef so every drop row / shop
  // row / cross-reference link gets the real item page in ALL cases, not
  // just search/browse.
  function unnoteEntry(entry) {
    if (!entry || !isBankNoteExamine(entry)) return entry;
    const name = safeName(entry).trim().toLowerCase();
    if (!name) return entry;
    const real = wikiData.entries.find(
      (e) => e.kind === 'item' && !isBankNoteExamine(e) && safeName(e).trim().toLowerCase() === name
    );
    return real || entry;
  }

  function isNotedItem(entry) {
    if (entry.kind !== 'item') return false;
    if (isBankNoteExamine(entry)) return true;
    if (entry.noted === true || entry.isNoted === true) return true;
    if (entry.notedTemplate != null || entry.certTemplate != null) return true;
    if (entry.linkedNoteId != null || entry.noteOf != null) return true;
    if (typeof entry.name === 'string' && /\(noted\)$/i.test(entry.name.trim())) return true;
    return false;
  }

  // Fallback dedupe for when isNotedItem()'s flag checks don't catch
  // anything (because wiki.json doesn't set those fields): collapse any
  // items sharing an exact name down to whichever one looks the most like
  // the "real", unnoted item — i.e. has the most item detail (equip data,
  // non-zero weight, actions, a value). Ties keep whichever entry came
  // first.
  //
  // This is intentionally name-based rather than flag-based, so it works
  // without knowing wiki.json's actual note-marker field. If it ever
  // collapses two genuinely different items that just happen to share a
  // name, tell me and I'll special-case it (or wire in the real field once
  // we know what it's called).
  function scoreItemDetail(entry) {
    let score = 0;
    if (entry.equip) score += 3;
    if (entry.weight) score += 1;
    if (entry.actions && entry.actions.length) score += 1;
    if (entry.value) score += 1;
    return score;
  }

  function dedupeNotedItems(entries) {
    const groups = new Map(); // lowercased name -> item entries
    for (const e of entries) {
      if (e.kind !== 'item') continue; // NPCs don't have note duplicates
      const key = safeName(e).trim().toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const dropIds = new Set();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      let best = group[0];
      for (const e of group) {
        if (scoreItemDetail(e) > scoreItemDetail(best)) best = e;
      }
      for (const e of group) {
        if (e !== best) dropIds.add(e.id);
      }
    }

    if (!dropIds.size) return entries;
    return entries.filter((e) => !dropIds.has(e.id));
  }

function visibleEntries() {
    return wikiData.entries.filter(
      (e) => !isNotedItem(e) && !(e.kind === 'item' && CLUE_ITEM_NAME_RE.test(safeName(e)))
    );
  }

function matchesSearch(entry, q) {
  if (!q) return true;
  const name = safeName(entry).toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return words.every((w) => name.includes(w));
}

  function searchRelevance(entry, q) {
  const name = safeName(entry).toLowerCase();
  if (name === q) return 0;                                   // exact match
  if (name.startsWith(q)) return 1;                            // starts with query
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) return 2; // starts a word
  return 3;                                                    // contained anywhere else
}
  
  // Filters an entry pool down to one browse category. null/'all' means
  // no filtering. 'saved' reads off the Saved Pages set. 'droptable'
  // covers both real shared drop tables AND the synthesized clue pages,
  // since clues are conceptually drop tables too.
  function filterByCategory(entries, category) {
    if (!category || category === 'all') return entries;
    if (category === 'saved') return entries.filter((e) => savedPageIds.has(e.id));
    if (category === 'droptable') return entries.filter((e) => e.kind === 'droptable' || e.kind === 'clue');
    return entries.filter((e) => e.kind === category);
  }

  // -----------------------------------------------------------------
  // Shops / drop tables / clue combining
  //
  // Everything in this section is derived, once, from wikiData after it
  // loads (see ensureDerived()), and cached in `derived` for the rest of
  // the panel's lifetime. Nothing here mutates wikiData.entries itself --
  // shop/droptable/clue pages are synthetic entries that live alongside
  // it (see allEntries()).
  // -----------------------------------------------------------------
  let derived = null;

  const CLUE_TIERS = ['easy', 'medium', 'hard'];
  // Matches the old standalone "Clue Scroll" / "Clue scroll (easy)" item
  // page(s) so they can be dropped from visibleEntries() in favour of the
  // 3 synthesized clue pages below. If losthq's item names for these
  // don't actually start with "clue scroll", tell me the exact name and
  // this regex is the only thing that needs to change.
  const CLUE_ITEM_NAME_RE = /^clue scroll\b/i;
  const CLUE_SUBTYPE_RE = /\b(map|simple|vague|sextant|riddle|anagram|coordinate|cryptic|challenge)\b/i;

  // Real, named items used as the "cover icon" for each synthesized
  // shared-drop-table page (and for any row elsewhere that links to that
  // table) — see buildDropTables() / findItemSourceIdByName(). Picked to
  // match what each table actually represents (a herb roll, a jewel
  // roll, the classic Rare Drop Table, the Mega-Rare table). If your
  // wiki.json spells any of these item names differently, update the
  // string here rather than the lookup logic.
  const TABLE_ICON_ITEM_NAMES = {
    randomherb: 'Guam leaf',
    randomjewel: 'Uncut emerald',
    ultrarare_getitem: 'Dragon med helm',
    megararetable: 'Dragon spear',
  };

  function slugify(str) {
    return String(str ?? '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  }

  // Resolves a reference to something in wikiData.entries. Refs in
  // shops/sharedDropTables/drops may come through as an already-resolved
  // entry id (the common case, since the build script resolves debugnames
  // up front), a raw debugname string, or occasionally a bare display
  // name -- so this tries all three before giving up.
  function resolveEntryRef(ref) {
    if (ref == null) return null;
    if (typeof ref === 'object') {
      // Some rows may already carry an inline { id } / { name } shape
      // rather than a plain string ref.
      if (ref.id) return resolveEntryRef(ref.id);
      if (ref.name) return resolveEntryRef(ref.name);
      return null;
    }
    const raw = String(ref).trim();
    if (!raw) return null;
    const byId = wikiData.entries.find((e) => e.id === raw);
    if (byId) return unnoteEntry(byId);
    const byDebugname = wikiData.entries.find(
      (e) => e.debugname === raw || e.debugName === raw
    );
    if (byDebugname) return unnoteEntry(byDebugname);
    const byName = wikiData.entries.find(
      (e) => safeName(e).toLowerCase() === raw.toLowerCase()
    );
    if (byName) return unnoteEntry(byName);
    return null;
  }

  // Given the unidentified pickup entry for a herb (wiki.json names these
  // like "Unidentified Guam"), resolves to the real, identified herb item
  // (e.g. "Guam leaf") so the herb drop table shows/links to the herb the
  // player actually ends up with, not the unidentified intermediate item.
  // Matched by name prefix rather than an explicit "identifiedOf" field
  // (which wiki.json doesn't appear to carry) -- picks the shortest
  // matching real item name so e.g. "guam" prefers "Guam leaf" over any
  // longer item that happens to also start with "Guam". If this ever
  // picks the wrong item for a given herb, tell me and I'll special-case
  // that one herb rather than change the general matching rule.
  function identifiedHerbEntry(unidEntry) {
    if (!unidEntry) return unidEntry;
    const name = safeName(unidEntry);
    const m = /^unidentified\s+(.+)$/i.exec(name.trim());
    if (!m) return unidEntry;
    const base = m[1].trim().toLowerCase();
    const candidates = wikiData.entries.filter(
      (e) =>
        e.kind === 'item' &&
        e !== unidEntry &&
        !isBankNoteExamine(e) &&
        safeName(e).toLowerCase().startsWith(base)
    );
    if (!candidates.length) return unidEntry;
    candidates.sort((a, b) => safeName(a).length - safeName(b).length);
    return candidates[0];
  }

  // Looks up a real item entry by exact display name (case-insensitive),
  // for pulling a representative icon for synthesized table pages — see
  // TABLE_ICON_ITEM_NAMES.
  function findItemSourceIdByName(name) {
    if (!name) return null;
    const target = wikiData.entries.find(
      (e) => e.kind === 'item' && !isBankNoteExamine(e) && safeName(e).toLowerCase() === name.toLowerCase()
    );
    return target && target.sourceId != null ? target.sourceId : null;
  }

  // A "~tablename" tertiary reference points at sharedDropTables instead
  // of a real item.
  function isSharedTableRef(item) {
    return typeof item === 'string' && item.trim().startsWith('~');
  }
  function sharedTableRefKey(item) {
    return String(item).trim().slice(1);
  }

  function clueKeyForTier(tier) {
    return `clue-${tier}`;
  }
  function clueTierFromTableKey(key) {
    const m = /^clue-(easy|medium|hard)$/i.exec(String(key || '').trim());
    return m ? m[1].toLowerCase() : null;
  }

  // Floor-conditional rows (currently only ever seen on the nature/chaos
  // talisman slot in randomjewel) come through as a single string like
  // "aboveground = nature_talisman | underground = chaos_talisman"
  // instead of a plain item ref. Parsed into { aboveground, underground }
  // refs, or null if the row isn't one of these.
  function parseFloorConditionalRef(item) {
    if (typeof item !== 'string' || item.indexOf('=') === -1) return null;
    const parts = item.split('|').map((p) => p.trim());
    const out = {};
    let matched = false;
    for (const part of parts) {
      const m = /^(\w+)\s*=\s*(.+)$/.exec(part);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'aboveground' || key === 'underground') {
        out[key] = m[2].trim();
        matched = true;
      }
    }
    return matched ? out : null;
  }

  function formatChance(row) {
    // Rows may express odds as chance ("1/128"), weight (needs a
    // rollBase from the parent table), or probability (0-1 float).
    if (row.chance != null) return String(row.chance);
    if (row.probability != null) {
      const p = Number(row.probability);
      if (Number.isFinite(p) && p > 0) return `1/${Math.round(1 / p)}`;
    }
    return null;
  }

  function formatWeightAsOdds(weight, rollBase) {
    if (weight == null || !rollBase) return null;
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) return null;
    // Not a clean 1/N in general (weighted tables), so show it as N/base
    // reduced to 1/x only when it divides evenly, else "w/base".
    if (rollBase % w === 0) return `1/${rollBase / w}`;
    return `${w}/${rollBase}`;
  }

  // Normalizes one shop's `shopkeeper` reference(s). Confirmed real shape
  // (from wiki.json's shop objects) is `npcDebugnames: ["lowe"]` plus a
  // parallel `npcIds: [null]` array (often null-padded when the id isn't
  // resolved yet) -- NOT a generic `npc`/`npcs`/`shopkeeper` field, though
  // those are still checked as a fallback in case a different shop entry
  // uses them instead.
  function normalizeShopNpcRefs(shop) {
    const debugnames = Array.isArray(shop.npcDebugnames) ? shop.npcDebugnames : [];
    const ids = Array.isArray(shop.npcIds) ? shop.npcIds : [];
    const fallback = shop.npc ?? shop.npcs ?? shop.shopkeeper ?? shop.shopkeepers;
    const fallbackList = fallback == null ? [] : Array.isArray(fallback) ? fallback : [fallback];
    return [...debugnames, ...ids, ...fallbackList].filter((v) => v != null);
  }

  // Normalizes one shop's `stock` field. Confirmed real shape (from
  // wiki.json's shop objects) is an array of
  // { debugname, itemId, sharedTableRef, conditional, quantity } rows --
  // notably with NO explicit price field, so shop prices always fall
  // back to derivedShopPrice() below. The old key/value object shapes
  // are kept as fallbacks in case a future export uses them instead.
  function normalizeShopStock(stock) {
    const rows = [];
    if (!stock) return rows;
    if (Array.isArray(stock)) {
      for (const row of stock) {
        if (!row) continue;
        rows.push({
          itemRef: row.itemId ?? row.item ?? row.debugname ?? row.id,
          qty: row.quantity ?? row.stock ?? row.qty ?? null,
          price: row.price ?? row.cost ?? null,
        });
      }
      return rows;
    }
    if (typeof stock === 'object') {
      for (const [itemRef, val] of Object.entries(stock)) {
        if (val != null && typeof val === 'object') {
          rows.push({
            itemRef,
            qty: val.qty ?? val.stock ?? val.quantity ?? null,
            price: val.price ?? val.cost ?? null,
          });
        } else {
          rows.push({ itemRef, qty: val, price: null });
        }
      }
    }
    return rows;
  }

  // Derives a sale price for a shop row when the source data doesn't
  // give one explicitly (which per the confirmed shape above is always,
  // for now), the same way the infobox already derives General Store
  // Min/Max from an item's base value (see infoboxRowsForItem). This is a
  // rough approximation for non-general-store shops -- if wiki.json ever
  // adds a real per-shop price multiplier, swap this for that instead of
  // the flat 0.4x guess.
  function derivedShopPrice(itemEntry) {
    if (!itemEntry || itemEntry.value == null) return null;
    return Math.floor(itemEntry.value * 0.4);
  }

  function buildShops() {
    const shopsSource = wikiData.shops;
    const rawShops = Array.isArray(shopsSource)
      ? shopsSource
      : shopsSource && typeof shopsSource === 'object'
      ? Object.values(shopsSource)
      : [];
    const entries = [];
    const byItemId = new Map(); // itemEntry.id -> [{ shopEntry, qty, price }]
    const byNpcId = new Map(); // npcEntry.id -> [shopEntry]

    rawShops.forEach((shop, idx) => {
      const name = shop.name || `Shop ${idx + 1}`;
      const id = `shop:${slugify(shop.key || name)}${shop.key ? '' : `-${idx}`}`;
      const npcRefs = normalizeShopNpcRefs(shop);
      const npcEntries = npcRefs.map(resolveEntryRef).filter(Boolean);

      const stockRows = normalizeShopStock(shop.stock).map((row) => {
        const itemEntry = resolveEntryRef(row.itemRef);
        const price = row.price != null ? row.price : derivedShopPrice(itemEntry);
        return { itemEntry, itemRef: row.itemRef, qty: row.qty, price };
      });

      const shopEntry = {
        id,
        kind: 'shop',
        name,
        shopkeepers: npcEntries,
        stockRows,
      };
      entries.push(shopEntry);

      for (const row of stockRows) {
        if (!row.itemEntry) continue;
        if (!byItemId.has(row.itemEntry.id)) byItemId.set(row.itemEntry.id, []);
        byItemId.get(row.itemEntry.id).push({ shopEntry, qty: row.qty, price: row.price });
      }
      for (const npcEntry of npcEntries) {
        if (!byNpcId.has(npcEntry.id)) byNpcId.set(npcEntry.id, []);
        byNpcId.get(npcEntry.id).push(shopEntry);
      }
    });

    return { entries, byItemId, byNpcId };
  }

  // Builds one 'droptable' page per sharedDropTables key EXCEPT the 3
  // clue tables, which get folded into buildClues() instead.
  //
  // Confirmed real shape (from wiki.json's sharedDropTables.randomherb/
  // randomjewel/ultrarare_getitem/megararetable):
  //   { key, name, rollBase, rollBaseRingOfWealth, rollTable: [
  //       { debugname, itemId, sharedTableRef, conditional, quantity,
  //         chance, note }
  //   ] }
  // Rows are already resolved (itemId is a real entry id like "item-199",
  // sharedTableRef is a bare table key like "megararetable" with no "~"
  // prefix) and quantity is a single number, not a range string --
  // notably different from how NPC drops.roll_table rows are shaped (see
  // parseDropItemField), so this does NOT reuse that parser.
  function buildDropTables() {
    const raw = wikiData.sharedDropTables || {};
    const entries = [];
    const byKey = new Map(); // tableKey -> entry

    for (const [key, table] of Object.entries(raw)) {
      if (clueTierFromTableKey(key)) continue; // handled by buildClues()
      const rollBase = table.rollBase ?? null;
      const rollBaseRingOfWealth = table.rollBaseRingOfWealth ?? null;
      const rawRows = table.rollTable ?? [];

      const rows = rawRows.map((row) => normalizeDropTableRow(row, rollBase, key));

      const entry = {
        id: `droptable:${slugify(key)}`,
        kind: 'droptable',
        name: table.name || prettifyTableName(key),
        tableKey: key,
        // Real-item icon for this table's page + any row elsewhere that
        // links to it — see TABLE_ICON_ITEM_NAMES.
        sourceId: findItemSourceIdByName(TABLE_ICON_ITEM_NAMES[key]),
        rollBase,
        rollBaseRingOfWealth,
        rows,
      };
      entries.push(entry);
      byKey.set(key, entry);
    }

    return { entries, byKey };
  }

  function prettifyTableName(key) {
    return String(key)
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // A single normalized row out of a sharedDropTables.<key>.rollTable
  // entry: either a real item (resolved via itemId), a pointer to
  // another shared table (sharedTableRef), or a floor-conditional pair
  // (conditional: true, the "aboveground = x | underground = y" string
  // living in `debugname` since itemId/sharedTableRef are both null on
  // those rows). `tableKey` is the parent table's own key, used only to
  // special-case the herb table (see identifiedHerbEntry).
  function normalizeDropTableRow(row, rollBase, tableKey) {
    const odds = formatWeightAsOdds(Number(row.chance), rollBase) || (row.chance != null ? `${row.chance}/${rollBase}` : null);

    if (row.conditional) {
      const floorConditional = parseFloorConditionalRef(row.debugname);
      return {
        floorConditional: floorConditional
          ? {
              aboveground: resolveEntryRef(floorConditional.aboveground),
              underground: resolveEntryRef(floorConditional.underground),
            }
          : null,
        odds,
        note: row.note || null,
      };
    }

    if (row.sharedTableRef) {
      return {
        tableRef: row.sharedTableRef,
        odds,
        note: row.note || null,
      };
    }

    let itemEntry = resolveEntryRef(row.itemId);
    // The herb table hands out "Unidentified <herb>" pickups in-game, but
    // for the wiki we want to show/link the real, identified herb the
    // player ends up with once they check it.
    if (tableKey === 'randomherb') itemEntry = identifiedHerbEntry(itemEntry);

    return {
      itemEntry,
      itemRef: row.itemId ?? row.debugname,
      odds,
      qty: row.quantity,
      note: row.note || null,
    };
  }

  // Finds any real "Clue scroll (...)" item entry still sitting in
  // wikiData.entries (visibleEntries()/search already exclude it -- this
  // only reads its sourceId) so the 3 synthesized clue pages have
  // something to draw an icon from. All 3 tiers use the exact same
  // in-game sprite, so any one of them is fine to borrow from.
  function findClueSpriteSourceId() {
    const match = wikiData.entries.find(
      (e) => e.kind === 'item' && CLUE_ITEM_NAME_RE.test(safeName(e)) && e.sourceId != null
    );
    return match ? match.sourceId : null;
  }

  // Builds the 3 combined clue pages (easy/medium/hard). Each pulls:
  //   - droppedBy: every NPC whose drops.tertiary has a "~clue-<tier>"
  //     row, with that row's own chance -- already the single combined
  //     per-tier odds per the Lost City data, not per clue-step.
  //   - contents: the tier's sharedDropTables['clue-<tier>'].rollTable
  //     rows (same shape as any other shared table -- debugname/itemId/
  //     quantity/chance/note), grouped by sub-type into counts instead
  //     of one row each.
  function buildClues(npcDropIndex) {
    const raw = wikiData.sharedDropTables || {};
    const entries = [];
    const clueSourceId = findClueSpriteSourceId();

    for (const tier of CLUE_TIERS) {
      const key = clueKeyForTier(tier);
      const table = raw[key];
      const rawRows = table ? table.rollTable ?? [] : [];

      const bySubtype = new Map(); // subtype -> count
      for (const row of rawRows) {
        const subtype = clueRowSubtype(row);
        bySubtype.set(subtype, (bySubtype.get(subtype) || 0) + 1);
      }

      const droppedBy = (npcDropIndex.byTertiaryTable.get(key) || []).slice();

      entries.push({
        id: `clue:${tier}`,
        kind: 'clue',
        name: `Clue scroll (${tier})`,
        tier,
        sourceId: clueSourceId,
        totalSteps: rawRows.length,
        bySubtype: Array.from(bySubtype.entries()).sort((a, b) => b[1] - a[1]),
        droppedBy,
      });
    }

    return entries;
  }

  // Sub-type is guessed from the row's note/debugname (e.g. "Unidentified
  // Guam", "Cryptic clue (easy)") since the confirmed sharedDropTables
  // row shape has no dedicated subtype/type field of its own.
  function clueRowSubtype(row) {
    const explicit = row.subtype || row.type;
    if (explicit) return prettifyTableName(explicit);
    const text = row.note || row.debugname || '';
    const m = CLUE_SUBTYPE_RE.exec(text);
    return m ? prettifyTableName(m[1]) : 'Other';
  }

  // Splits a drop row's `item` field into { ref, qty, isTable }.
  // Confirmed real shape (from a King Black Dragon drops dump):
  //   roll_table row: { item: ["rune_longsword", 1], chance: "10" }
  //   roll_table row (shared-table pointer): { item: "~ultrarare_getitem", chance: "8" }
  //   always row:     { item: ["dragon_bones", 1] }               (no chance -- 100%)
  //   tertiary row:   { item: "~clue-hard", chance: "1/128" }      (pre-formatted fraction)
  // So `item` is an [debugname, qty] pair for real items, or a bare
  // "~tablekey" string for shared-table pointers -- but a shared-table
  // pointer can ALSO come wrapped in the same [ref, qty] array shape as a
  // real item (e.g. ["~randomjewel", 1]), so that has to be checked
  // before assuming array form means "real item". qty itself can be a
  // plain number or a range string like "1-2".
  function parseDropItemField(item) {
    if (isSharedTableRef(item)) {
      return { isTable: true, tableKey: sharedTableRefKey(item) };
    }
    if (Array.isArray(item)) {
      if (isSharedTableRef(item[0])) {
        return { isTable: true, tableKey: sharedTableRefKey(item[0]) };
      }
      return { isTable: false, ref: item[0], qty: item[1] };
    }
    // Fallback for any row that turns out to just be a bare debugname
    // string with no qty wrapper.
    return { isTable: false, ref: item, qty: null };
  }

  function parseQtyRange(qty) {
    if (qty == null) return { min: null, max: null };
    if (typeof qty === 'number') return { min: qty, max: qty };
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(qty).trim());
    if (m) return { min: Number(m[1]), max: Number(m[2]) };
    const n = Number(qty);
    return Number.isFinite(n) ? { min: n, max: n } : { min: null, max: null };
  }

  // roll_table/always rows carry `chance` as a plain weight number
  // string (e.g. "10") out of the NPC's own drops.roll_base -- NOT a
  // pre-formatted "1/128" fraction like tertiary rows use. This tells
  // formatChance()/formatWeightAsOdds() apart for the two cases.
  function formatRollTableOdds(row, rollBase) {
    if (row.chance == null) return '100% (always)';
    // tertiary rows already come through as "1/128" style strings --
    // pass those through untouched rather than trying to treat them as
    // a weight.
    if (typeof row.chance === 'string' && row.chance.includes('/')) return row.chance;
    return formatWeightAsOdds(Number(row.chance), rollBase) || `${row.chance}/${rollBase}`;
  }

  // Walks every NPC's drops.roll_table / drops.always / drops.tertiary
  // once and builds two reverse indices used across item/table/clue
  // pages:
  //   - byItemId: itemEntry.id -> [{ npcEntry, odds, min, max }]
  //   - byTertiaryTable: sharedDropTables key -> [{ npcEntry, odds }]
  function buildNpcDropIndex() {
    const byItemId = new Map();
    const byTertiaryTable = new Map();

    for (const entry of wikiData.entries) {
      if (entry.kind !== 'npc' || !entry.drops) continue;
      const rollBase = entry.drops.roll_base ?? entry.drops.rollBase ?? null;
      const rollRows = entry.drops.roll_table ?? entry.drops.rollTable ?? [];
      const alwaysRows = entry.drops.always ?? [];
      const tertiaryRows = entry.drops.tertiary ?? [];

      const addTableRef = (tableKey, odds) => {
        if (!byTertiaryTable.has(tableKey)) byTertiaryTable.set(tableKey, []);
        byTertiaryTable.get(tableKey).push({ npcEntry: entry, odds });
      };
      const addItem = (itemEntry, odds, qty) => {
        if (!byItemId.has(itemEntry.id)) byItemId.set(itemEntry.id, []);
        byItemId.get(itemEntry.id).push({ npcEntry: entry, odds, min: qty.min, max: qty.max });
      };

      for (const row of rollRows) {
        const parsed = parseDropItemField(row.item);
        const odds = formatRollTableOdds(row, rollBase);
        if (parsed.isTable) {
          addTableRef(parsed.tableKey, odds);
          continue;
        }
        const itemEntry = resolveEntryRef(parsed.ref);
        if (!itemEntry) continue;
        addItem(itemEntry, odds, parseQtyRange(parsed.qty));
      }

      for (const row of alwaysRows) {
        const parsed = parseDropItemField(row.item);
        if (parsed.isTable) {
          addTableRef(parsed.tableKey, '100% (always)');
          continue;
        }
        const itemEntry = resolveEntryRef(parsed.ref);
        if (!itemEntry) continue;
        addItem(itemEntry, '100% (always)', parseQtyRange(parsed.qty));
      }

      for (const row of tertiaryRows) {
        const parsed = parseDropItemField(row.item);
        const odds = formatChance(row); // already "1/128"-style here
        if (parsed.isTable) {
          addTableRef(parsed.tableKey, odds);
          continue;
        }
        const itemEntry = resolveEntryRef(parsed.ref);
        if (!itemEntry) continue;
        addItem(itemEntry, odds, parseQtyRange(parsed.qty));
      }
    }

    return { byItemId, byTertiaryTable };
  }

  function ensureDerived() {
    if (derived || !wikiData) return;
    const npcDropIndex = buildNpcDropIndex();
    const shops = buildShops();
    const dropTables = buildDropTables();
    const clues = buildClues(npcDropIndex);
    derived = { npcDropIndex, shops, dropTables, clues };
  }

  // All browsable/searchable/openable pages: the real item/npc entries
  // (minus the ones visibleEntries() itself filters, e.g. bank notes and
  // the old standalone clue-scroll item pages) plus the synthesized
  // shop/droptable/clue pages.
  function allEntries() {
    ensureDerived();
    const real = visibleEntries();
    if (!derived) return real;
    return [...real, ...derived.shops.entries, ...derived.dropTables.entries, ...derived.clues];
  }

  function findEntryById(id) {
    ensureDerived();
    const real = wikiData.entries.find((e) => e.id === id);
    if (real) return real;
    if (!derived) return null;
    return (
      derived.shops.entries.find((e) => e.id === id) ||
      derived.dropTables.entries.find((e) => e.id === id) ||
      derived.clues.find((e) => e.id === id)
    );
  }

  function linkHtml(entry, label) {
    if (!entry) return escapeHtml(label || '');
    return `<span class="wiki-link" data-open="${entry.id}">${escapeHtml(
      label || safeName(entry) || entry.name || ''
    )}</span>`;
  }

  function iconLetter(entry) {
    if (entry.kind === 'npc') return 'N';
    if (entry.kind === 'shop') return 'S';
    if (entry.kind === 'droptable') return 'T';
    if (entry.kind === 'clue') return 'C';
    return 'I';
  }

  // Whether an entry has a real sprite to draw. Dummy items match losthq's
  // itemdb.js, which shows a "dummy item" notice instead of an icon for
  // those, so we fall back to the letter badge for them too.
  function hasSprite(entry) {
    if (entry == null || entry.sourceId == null) return false;
    if (entry.kind === 'item' && entry.dummyitem) return false;
    const sourceId = Number(entry.sourceId);
    return Number.isFinite(sourceId) && sourceId >= 0;
  }

  function spriteCanvasHtml(entry, sizeAttr, cssClass) {
    const kind = entry.kind === 'npc' ? 'npc' : 'item';
    const nativeSize = kind === 'npc' ? NPC_SPRITE_SIZE : ITEM_SPRITE_SIZE;
    const size = sizeAttr || nativeSize;
    return `<canvas class="${cssClass}" data-sprite-kind="${kind}" data-sprite-id="${Number(
      entry.sourceId
    )}" width="${size}" height="${size}"></canvas>`;
  }

  function kindLabel(entry) {
    if (entry.kind === 'npc') return 'NPC';
    if (entry.kind === 'shop') return 'Shop';
    if (entry.kind === 'droptable') return 'Drop table';
    if (entry.kind === 'clue') return 'Clue scroll';
    return 'Item';
  }

  function listRowHtml(entry) {
    const iconHtml = hasSprite(entry)
      ? spriteCanvasHtml(entry, null, 'wiki-row-sprite')
      : `<span class="wiki-row-icon wiki-row-icon-${entry.kind}">${iconLetter(entry)}</span>`;
    return `
      <div class="wiki-row" data-open="${entry.id}">
        ${iconHtml}
        <div class="wiki-row-text">
          <div class="wiki-row-name">${escapeHtml(safeName(entry) || entry.name || '(unnamed)')}</div>
          <div class="wiki-row-sub">${kindLabel(entry)}${
      entry.kind === 'npc' && entry.combatLevel != null ? ` &middot; Level ${entry.combatLevel}` : ''
    }</div>
        </div>
      </div>
    `;
  }

  // Alchemy/general-store prices are derived from the item's base value:
  //   High Alch            = value * 0.6
  //   Low Alch              = value * 0.4
  //   General Store Max     = value * 0.4  (same as Low Alch — the price
  //                                         when the store has no stock)
  //   General Store Min     = value * 0.1  (floor price once overstocked)
  function infoboxRowsForItem(entry) {
    const rows = [];
    if (entry.value != null) {
      const value = entry.value;
      const highAlch = Math.floor(value * 0.6);
      const lowAlch = Math.floor(value * 0.4);
      const gstMax = lowAlch;
      const gstMin = Math.floor(value * 0.1);
      rows.push(['High Alch', `${highAlch.toLocaleString()} gp`]);
      rows.push(['Low Alch', `${lowAlch.toLocaleString()} gp`]);
      rows.push(['General Store Max', `${gstMax.toLocaleString()} gp`]);
      rows.push(['General Store Min', `${gstMin.toLocaleString()} gp`]);
    }
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
    if (entry.respawnRate != null) rows.push(['Respawn rate', `${entry.respawnRate}`]);
    if (entry.huntRange != null) rows.push(['Hunt range', `${entry.huntRange}`]);
    if (entry.maxRange != null) rows.push(['Max range', `${entry.maxRange}`]);
    if (entry.wanderRange != null) rows.push(['Wander range', `${entry.wanderRange}`]);
    return rows;
  }

  // Examine text now lives inside the infobox itself (between the icon
  // and the stat table) instead of at the top of the page body, so the
  // infobox can be the very first thing shown on a page.
  function infoboxHtml(entry) {
    const rows = entry.kind === 'npc' ? infoboxRowsForNpc(entry) : infoboxRowsForItem(entry);
    const iconInner = hasSprite(entry)
      ? spriteCanvasHtml(entry, null, 'wiki-infobox-sprite-canvas')
      : iconLetter(entry);

    return `
      <div class="wiki-infobox">
        <div class="wiki-infobox-header">${escapeHtml(safeName(entry))}</div>
        <div class="wiki-infobox-icon">${iconInner}</div>
        <div class="wiki-infobox-examine">${escapeHtml(entry.examine || 'No description available.')}</div>
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
          <tr><td class="wiki-bonus-row-label">ATK</td>${atk.map(bonusCell).join('')}</tr>
          <tr><td class="wiki-bonus-row-label">DEF</td>${def.map(bonusCell).join('')}</tr>
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

  // NPC equivalent of combatStatsHtml() above. Redesigned to match the
  // drop-table row style instead of a <table>: one row per stat, no icon,
  // the stat name in the same orange used for drop-row names, and the
  // number in the same grey used for drop-row meta text. No quantity
  // column here since it's not applicable to a single stat value.
  function npcCombatStatsHtml(entry) {
    if (entry.kind !== 'npc' || !entry.combat) return '';
    const c = entry.combat;
    const styleLabel = entry.damageType ? prettifyTableName(entry.damageType) : 'Unknown';

    const rows = [
      ['Combat style', styleLabel],
      ['Attack', c.attack ?? 0],
      ['Strength', c.strength ?? 0],
      ['Magic', c.magic ?? 0],
      ['Stab defence', c.stabDefence ?? 0],
      ['Slash defence', c.slashDefence ?? 0],
      ['Crush defence', c.crushDefence ?? 0],
      ['Magic defence', c.magicDefence ?? 0],
      ['Range defence', c.rangeDefence ?? 0],
    ];

    const body = rows
      .map(([label, val]) =>
        dropRowHtml({ iconHtml: '', nameHtml: escapeHtml(label), qtyLabel: null, oddsLabel: String(val) })
      )
      .join('');

    return sectionHtml('Combat Stats', `<div class="wiki-drop-list">${body}</div>`);
  }

  function sectionHtml(title, innerHtml) {
    return `<div class="wiki-section-title">${escapeHtml(title)}</div>${innerHtml}`;
  }

  function emptySection(text) {
    return `<div class="wiki-empty-section">${escapeHtml(text)}</div>`;
  }

  // Star toggle rendered into the top-right of every detail page's title
  // bar. Clicking it (handled via delegated [data-star] listener in
  // paint()) adds/removes the page from Saved Pages and repaints so the
  // star's fill updates immediately.
  function starButtonHtml(id) {
    const saved = savedPageIds.has(id);
    return `<span class="wiki-star-btn${
      saved ? ' wiki-star-active' : ''
    }" data-star="${id}" title="${saved ? 'Remove from Saved Pages' : 'Save this page'}">&#9733;</span>`;
  }

  // ---- shared two-line drop/stock row builder ----
  //
  // Every "item + quantity + rarity/price" listing in the wiki (item
  // Dropped By / Shop Locations, NPC Drops, shared drop-table Table
  // Contents, clue Dropped By / Scroll Steps) renders through this
  // instead of a <table>: icon + name on the first line, quantity and
  // rarity/price as a quiet two-column line underneath. This is also
  // reused (icon-less) for the NPC Combat Stats section above. (The shop
  // page's own Stock section uses a real <table> instead -- see
  // shopDetailHtml.)
  function dropRowIconHtml(entry) {
    if (!entry) return '';
    if (hasSprite(entry)) return spriteCanvasHtml(entry, null, 'wiki-drop-icon');
    return '<div class="wiki-drop-icon"></div>';
  }

  function dropRowHtml({ iconHtml, nameHtml, qtyLabel, oddsLabel }) {
    const metaParts = [];
    if (qtyLabel) metaParts.push(`<span>${qtyLabel}</span>`);
    if (oddsLabel) metaParts.push(`<span>${oddsLabel}</span>`);
    const metaHtml = metaParts.length ? `<div class="wiki-drop-meta">${metaParts.join('')}</div>` : '';
    return `
      <div class="wiki-drop-row">
        ${iconHtml || ''}
        <div class="wiki-drop-body">
          <div class="wiki-drop-name">${nameHtml}</div>
          ${metaHtml}
        </div>
      </div>`;
  }

  // ---- item page additions: shop locations / ground spawns / dropped by ----

  function shopLocationsHtml(itemEntry) {
    ensureDerived();
    const rows = (derived.shops.byItemId.get(itemEntry.id) || []);
    if (!rows.length) return sectionHtml('Shop Locations', emptySection('Not sold in any shop.'));
    const body = rows
      .map(({ shopEntry, qty }) =>
        dropRowHtml({
          iconHtml: '',
          nameHtml: linkHtml(shopEntry),
          qtyLabel: qty != null ? `Stock: ${qty}` : null,
          oddsLabel: null,
        })
      )
      .join('');
    return sectionHtml('Shop Locations', `<div class="wiki-drop-list">${body}</div>`);
  }

  function groundSpawnsHtml(itemEntry) {
    // NOT wired in yet: there's no ground-spawn data source in wiki.json
    // (no field on item entries, no top-level table like `shops` /
    // `sharedDropTables`) to read this from yet. No-op until that data
    // exists.
    return '';
  }

  function droppedByHtml(itemEntry) {
    ensureDerived();
    const rows = derived.npcDropIndex.byItemId.get(itemEntry.id) || [];
    if (!rows.length) return '';
    const body = rows
      .map(({ npcEntry, odds, min, max }) =>
        dropRowHtml({
          iconHtml: dropRowIconHtml(npcEntry),
          nameHtml: linkHtml(npcEntry),
          qtyLabel:
            min != null || max != null
              ? `Qty: ${min === max || max == null ? min : `${min}-${max}`}`
              : null,
          oddsLabel: odds || null,
        })
      )
      .join('');
    return sectionHtml('Dropped By', `<div class="wiki-drop-list">${body}</div>`);
  }

  // ---- npc page additions: drops table / shop reference ----

  function npcDropsHtml(npcEntry) {
    if (!npcEntry.drops) return '';
    const rollBase = npcEntry.drops.roll_base ?? npcEntry.drops.rollBase ?? null;
    const rollRows = npcEntry.drops.roll_table ?? npcEntry.drops.rollTable ?? [];
    const alwaysRows = npcEntry.drops.always ?? [];
    const tertiaryRows = npcEntry.drops.tertiary ?? [];
    if (!rollRows.length && !alwaysRows.length && !tertiaryRows.length) return '';

    ensureDerived();

    function tableRefRowHtml(tableKey, odds) {
      const tier = clueTierFromTableKey(tableKey);
      const target = tier
        ? derived.clues.find((c) => c.tier === tier)
        : derived.dropTables.byKey.get(tableKey);
      return dropRowHtml({
        iconHtml: dropRowIconHtml(target),
        nameHtml: linkHtml(target, target ? safeName(target) || target.name : prettifyTableName(tableKey)),
        qtyLabel: null,
        oddsLabel: odds || null,
      });
    }

    function itemRowHtml(itemEntry, ref, qty, odds) {
      const label = itemEntry ? linkHtml(itemEntry) : escapeHtml(String(ref));
      const { min, max } = parseQtyRange(qty);
      const qtyLabel = min != null ? `Qty: ${min === max ? min : `${min}-${max}`}` : null;
      return dropRowHtml({
        iconHtml: dropRowIconHtml(itemEntry),
        nameHtml: label,
        qtyLabel,
        oddsLabel: odds || null,
      });
    }

    function rollRowHtml(row) {
      const parsed = parseDropItemField(row.item);
      const odds = formatRollTableOdds(row, rollBase);
      if (parsed.isTable) return tableRefRowHtml(parsed.tableKey, odds);
      return itemRowHtml(resolveEntryRef(parsed.ref), parsed.ref, parsed.qty, odds);
    }

    function alwaysRowHtml(row) {
      const parsed = parseDropItemField(row.item);
      if (parsed.isTable) return tableRefRowHtml(parsed.tableKey, '100% (always)');
      return itemRowHtml(resolveEntryRef(parsed.ref), parsed.ref, parsed.qty, '100% (always)');
    }

    function tertiaryRowHtml(row) {
      const parsed = parseDropItemField(row.item);
      const odds = formatChance(row); // pre-formatted "1/128" style
      if (parsed.isTable) return tableRefRowHtml(parsed.tableKey, odds);
      return itemRowHtml(resolveEntryRef(parsed.ref), parsed.ref, parsed.qty, odds);
    }

    const rows = [
      ...alwaysRows.map(alwaysRowHtml),
      ...rollRows.map(rollRowHtml),
      ...tertiaryRows.map(tertiaryRowHtml),
    ].join('');

    return sectionHtml('Drops', `<div class="wiki-drop-list">${rows}</div>`);
  }

  function npcShopRefHtml(npcEntry) {
    ensureDerived();
    const shops = derived.shops.byNpcId.get(npcEntry.id) || [];
    if (!shops.length) return '';
    const links = shops.map((s) => linkHtml(s)).join(', ');
    return sectionHtml('Runs Shop', `<div class="wiki-plain-text">${links}</div>`);
  }

  // ---- shop page ----
  //
  // Per plan, the shop's Stock is rendered as a real <table> (Item /
  // Stock / Cost columns) rather than the drop-row stack used elsewhere,
  // since a shop's stock is a flat price list, not a rarity table.

  function shopDetailHtml(shopEntry) {
    const keeperLinks = shopEntry.shopkeepers.length
      ? shopEntry.shopkeepers.map((n) => linkHtml(n)).join(', ')
      : 'Unknown';

    const rows = shopEntry.stockRows
      .map((row) => {
        const label = row.itemEntry ? linkHtml(row.itemEntry) : escapeHtml(String(row.itemRef));
        const icon = dropRowIconHtml(row.itemEntry);
        return `
          <tr>
            <td class="wiki-shop-col-item"><span class="wiki-shop-item-inner">${icon}${label}</span></td>
            <td class="wiki-shop-col-num">${row.qty != null ? Number(row.qty).toLocaleString() : '&mdash;'}</td>
          </tr>`;
      })
      .join('');

    
    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(shopEntry.name)}
          <span class="wiki-page-kind">Shop</span>
          ${starButtonHtml(shopEntry.id)}
        </div>
        <div class="wiki-infobox">
          <div class="wiki-infobox-header">${escapeHtml(shopEntry.name)}</div>
          <table class="wiki-infobox-table">
            <tr><td class="wiki-infobox-label">Shopkeeper</td><td class="wiki-infobox-value">${keeperLinks}</td></tr>
            <tr><td class="wiki-infobox-label">Items sold</td><td class="wiki-infobox-value">${shopEntry.stockRows.length}</td></tr>
          </table>
        </div>
        ${sectionHtml(
          'Stock',
          shopEntry.stockRows.length
            ? `<table class="wiki-shop-table">
                 <thead><tr><th>Item</th><th class="wiki-shop-col-num">Stock</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`
            : emptySection('No stock data available.')
        )}
      </div>
    `;
  }

  // ---- shared drop table page ----

  function dropTableDetailHtml(tableEntry) {
    ensureDerived();
    const droppedBy = derived.npcDropIndex.byTertiaryTable.get(tableEntry.tableKey) || [];

    const rows = tableEntry.rows
      .map((row) => {
        if (row.floorConditional) {
          const { aboveground, underground } = row.floorConditional;
          const nameHtml = `Aboveground: ${
            aboveground ? linkHtml(aboveground) : '&mdash;'
          }<br>Underground: ${underground ? linkHtml(underground) : '&mdash;'}`;
          const rowHtml = dropRowHtml({ iconHtml: '', nameHtml, qtyLabel: null, oddsLabel: row.odds || null });
          return rowHtml + (row.note ? `<div class="wiki-subnote">${escapeHtml(row.note)}</div>` : '');
        }
        if (row.tableRef) {
          const target = derived.dropTables.byKey.get(row.tableRef);
          const label = linkHtml(target, target ? target.name : prettifyTableName(row.tableRef));
          const rowHtml = dropRowHtml({
            iconHtml: dropRowIconHtml(target),
            nameHtml: label,
            qtyLabel: null,
            oddsLabel: row.odds || null,
          });
          return rowHtml + (row.note ? `<div class="wiki-subnote">${escapeHtml(row.note)}</div>` : '');
        }
        const label = row.itemEntry ? linkHtml(row.itemEntry) : escapeHtml(String(row.itemRef));
        const qtyLabel = row.qty != null && row.qty !== 1 ? `Qty: ${row.qty}` : null;
        const rowHtml = dropRowHtml({
          iconHtml: dropRowIconHtml(row.itemEntry),
          nameHtml: label,
          qtyLabel,
          oddsLabel: row.odds || null,
        });
        return rowHtml + (row.note ? `<div class="wiki-subnote">${escapeHtml(row.note)}</div>` : '');
      })
      .join('');

    const rowOfWealthNote =
      tableEntry.rollBaseRingOfWealth != null
        ? `<div class="wiki-subnote">With a Ring of Wealth equipped, rolls are out of ${tableEntry.rollBaseRingOfWealth} instead of ${tableEntry.rollBase}.</div>`
        : '';

    const droppedByBody = droppedBy
      .map(({ npcEntry, odds }) =>
        dropRowHtml({
          iconHtml: dropRowIconHtml(npcEntry),
          nameHtml: linkHtml(npcEntry),
          qtyLabel: null,
          oddsLabel: odds || null,
        })
      )
      .join('');

    const iconInner = hasSprite(tableEntry)
      ? spriteCanvasHtml(tableEntry, null, 'wiki-infobox-sprite-canvas')
      : iconLetter(tableEntry);

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(tableEntry.name)}
          <span class="wiki-page-kind">Drop Table</span>
          ${starButtonHtml(tableEntry.id)}
        </div>
        <div class="wiki-infobox">
          <div class="wiki-infobox-header">${escapeHtml(tableEntry.name)}</div>
          <div class="wiki-infobox-icon">${iconInner}</div>
        </div>
        ${sectionHtml(
          'Table Contents',
          `<div class="wiki-drop-list">${rows}</div>
          ${rowOfWealthNote}`
        )}
        ${sectionHtml(
          'Dropped By',
          droppedBy.length
            ? `<div class="wiki-drop-list">${droppedByBody}</div>`
            : emptySection('No monster currently references this table.')
        )}
      </div>
    `;
  }

  // ---- clue scroll page (combined easy/medium/hard) ----

  function clueDetailHtml(clueEntry) {
    const droppedByBody = clueEntry.droppedBy
      .map(({ npcEntry, odds }) =>
        dropRowHtml({
          iconHtml: dropRowIconHtml(npcEntry),
          nameHtml: linkHtml(npcEntry),
          qtyLabel: null,
          oddsLabel: odds || null,
        })
      )
      .join('');

    const subtypeBody = clueEntry.bySubtype
      .map(([subtype, count]) =>
        dropRowHtml({ iconHtml: '', nameHtml: escapeHtml(subtype), qtyLabel: null, oddsLabel: `${count}` })
      )
      .join('');

    const iconInner = hasSprite(clueEntry)
      ? spriteCanvasHtml(clueEntry, null, 'wiki-infobox-sprite-canvas')
      : iconLetter(clueEntry);

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(clueEntry.name)}
          <span class="wiki-page-kind">Clue Scroll</span>
          ${starButtonHtml(clueEntry.id)}
        </div>
        <div class="wiki-infobox">
          <div class="wiki-infobox-header">${escapeHtml(clueEntry.name)}</div>
          <div class="wiki-infobox-icon">${iconInner}</div>
        </div>
        ${sectionHtml(
          'Dropped By',
          clueEntry.droppedBy.length
            ? `<div class="wiki-drop-list">${droppedByBody}</div>`
            : emptySection('No monster currently drops this clue tier.')
        )}
        ${sectionHtml(
          'Scroll Steps',
          clueEntry.bySubtype.length
            ? `<div class="wiki-drop-list">${subtypeBody}</div>
              <div class="wiki-subnote">${clueEntry.totalSteps} possible ${clueEntry.tier} clue steps in total, grouped by type.</div>`
            : emptySection('No scroll-step data available for this tier.')
        )}
      </div>
    `;
  }

  // Infobox is always first, then any stats sections below it (Combat
  // Stats for equippable items / NPCs, plus Shop Locations / Ground
  // Spawns / Dropped By for items and Drops / Runs Shop for NPCs).
  // Actions/"wear" pills have been removed entirely, and the examine
  // text has moved into the infobox (see infoboxHtml above) rather than
  // sitting up here. Every page kind also gets a Saved Pages star in its
  // title bar (see starButtonHtml).
  function detailHtml(entry) {
    if (entry.kind === 'shop') return shopDetailHtml(entry);
    if (entry.kind === 'droptable') return dropTableDetailHtml(entry);
    if (entry.kind === 'clue') return clueDetailHtml(entry);

    const stats = entry.kind === 'npc' ? npcCombatStatsHtml(entry) : combatStatsHtml(entry);
    const extraSections =
      entry.kind === 'npc'
        ? [npcDropsHtml(entry), npcShopRefHtml(entry)]
        : [droppedByHtml(entry), shopLocationsHtml(entry), groundSpawnsHtml(entry)];

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(safeName(entry))}
          <span class="wiki-page-kind">${entry.kind === 'npc' ? 'NPC' : 'Item'}</span>
          ${starButtonHtml(entry.id)}
        </div>
        ${infoboxHtml(entry)}
        ${stats ? `<div class="wiki-page-main">${stats}</div>` : ''}
        ${extraSections.filter(Boolean).join('')}
      </div>
    `;
  }

  function homeHtml() {
    ensureDerived();
    const visible = visibleEntries();
    const items = visible.filter((e) => e.kind !== 'npc').length;
    const npcs = visible.filter((e) => e.kind === 'npc').length;
    const shops = derived ? derived.shops.entries.length : 0;
    const tables = derived ? derived.dropTables.entries.length + derived.clues.length : 0;
    const saved = savedPageIds.size;
    // Order: Title -> stat counts -> description -> browse buttons.
    return `
      <div class="wiki-home">
        <div class="wiki-home-title">Oldrune Wiki</div>
        <div class="wiki-home-stats">
          <div class="wiki-home-stat"><b>${items}</b> items</div>
          <div class="wiki-home-stat"><b>${npcs}</b> NPCs</div>
          <div class="wiki-home-stat"><b>${shops}</b> shops</div>
          <div class="wiki-home-stat"><b>${tables}</b> drop tables</div>
          <div class="wiki-home-stat"><b>${saved}</b> saved</div>
        </div>
        <div class="wiki-home-desc">
          Search for an item, NPC, shop or drop table above, or browse everything the wiki currently knows about.
        </div>
        <div class="wiki-home-browse-grid">
          <button class="wiki-home-browse-btn" data-category="all">Browse All</button>
          <button class="wiki-home-browse-btn" data-category="item">Browse Items</button>
          <button class="wiki-home-browse-btn" data-category="npc">Browse NPCs</button>
          <button class="wiki-home-browse-btn" data-category="shop">Browse Shops</button>
          <button class="wiki-home-browse-btn" data-category="droptable">Browse Drop Tables</button>
          <button class="wiki-home-browse-btn" data-category="saved">Saved Pages</button>
        </div>
      </div>
    `;
  }

  const CATEGORY_LABELS = {
    all: 'All entries',
    item: 'Items',
    npc: 'NPCs',
    shop: 'Shops',
    droptable: 'Drop tables',
    saved: 'Saved pages',
  };

  function renderWiki(container, exit) {
    ensureStyleInjected();

    // Pushes the current navigation state onto the history stack before
    // switching to a new page, so goBack() can pop back to exactly where
    // the user was (list -> item -> cross-referenced NPC -> ... each own
    // their own history entry) instead of collapsing straight back to
    // search/home like the old two-level back logic did.
    function pushHistory() {
      navStack.push({ openEntryId, browseCategory, searchText });
    }

    // Clicking the "Wiki" panel title always jumps straight to the home
    // page and clears history — a hard reset, not a "go back one step".
    function goHome() {
      navStack = [];
      openEntryId = null;
      browseCategory = null;
      searchText = '';
      paint();
    }

    function goBack() {
      if (navStack.length) {
        const prev = navStack.pop();
        openEntryId = prev.openEntryId;
        browseCategory = prev.browseCategory;
        searchText = prev.searchText;
        paint();
        return;
      }
      if (openEntryId || browseCategory || searchText) {
        goHome();
        return;
      }
      exit();
    }

    // The back button + "Wiki" title and the search input now live in a
    // `.wiki-sticky-top` wrapper that's built once per paint() call and
    // never gets swapped out along with the page content below it — see
    // `.wiki-scroll-area` below, which is the only thing each branch of
    // paint() rewrites. This is what makes the search bar available on
    // every page (previously it only existed on the list/home view) and
    // keeps both it and the back button glued to the top while the
    // content scrolls.
    function paint() {
      container.innerHTML = `
        <div class="wiki-root">
          <div class="wiki-sticky-top">
            <div class="ol-list-header">
              <span class="ol-back-btn" id="wiki-back" title="Back">&#x2190;</span>
              <span class="ol-list-title" id="wiki-home-link" title="Wiki home" style="cursor:pointer;">Wiki</span>
            </div>
            <div class="wiki-search-wrap">
              <input type="text" class="wiki-search-input" id="wiki-search" placeholder="Search items and NPCs..." value="${escapeHtml(
                searchText
              )}" />
            </div>
          </div>
          <div class="wiki-scroll-area" id="wiki-scroll-area"></div>
        </div>
      `;
      container.querySelector('#wiki-back').addEventListener('click', goBack);
      container.querySelector('#wiki-home-link').addEventListener('click', goHome);

      const scrollArea = container.querySelector('#wiki-scroll-area');
      const searchInput = container.querySelector('#wiki-search');

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
        const wasHome = !openEntryId && !browseCategory && !searchText.trim();
        const newValue = searchInput.value;
        if (openEntryId) {
          // The search bar is visible on every page now — typing into it
          // while a detail page is open backs out to the list/search
          // results view instead of doing nothing.
          pushHistory();
          openEntryId = null;
        } else if (wasHome && newValue.trim()) {
          pushHistory();
        }
        searchText = newValue;
        if (searchText.trim()) browseCategory = null;
        paint();
      });

      // Keep focus + caret position stable across the repaint above.
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);

      // Resets the scrollable content area back to the top. Called at the
      // end of every branch below (loading/error/detail/list/home) so
      // opening any new page always starts scrolled to the top — done
      // both synchronously and again on the next animation frame, since
      // some panel hosts don't finish laying out the new content until
      // just after this paint() call returns.
      function scrollToTop() {
        scrollArea.scrollTop = 0;
        requestAnimationFrame(() => {
          scrollArea.scrollTop = 0;
        });
      }

      if (loadError) {
        scrollArea.innerHTML = `<div class="wiki-error">Couldn't load wiki data.<br>${escapeHtml(loadError.message)}</div>`;
        scrollToTop();
        return;
      }
      if (!wikiData) {
        scrollArea.innerHTML = `<div class="wiki-loading">Loading wiki data&hellip;</div>`;
        scrollToTop();
        return;
      }

      if (openEntryId) {
        const entry = findEntryById(openEntryId);
        if (!entry) {
          openEntryId = null;
          paint();
          return;
        }
        scrollArea.innerHTML = detailHtml(entry);
        renderSpritesIn(scrollArea);
        scrollToTop();
        // Cross-reference links inside the page body (shop stock rows,
        // drop table rows, "Dropped By" monster names, etc.) — same
        // open-by-id mechanism as the list rows, just delegated over
        // whatever wiki-link spans detailHtml happened to render.
        scrollArea.querySelectorAll('[data-open]').forEach((link) => {
          link.addEventListener('click', () => {
            pushHistory();
            openEntryId = link.dataset.open;
            paint();
          });
        });
        // Saved Pages star toggle — delegated the same way as [data-open]
        // links above. Doesn't push nav history since it's not a
        // navigation action.
        scrollArea.querySelectorAll('[data-star]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSaved(btn.dataset.star);
            paint();
          });
        });
        return;
      }

      const showingList = browseCategory != null || searchText.trim().length > 0;

      scrollArea.innerHTML = showingList
        ? `<div class="wiki-list-header">
             <span class="wiki-list-header-label" id="wiki-list-label"></span>
             <span class="wiki-list-back-link" id="wiki-to-home">&larr; Home</span>
           </div>
           <div class="wiki-list" id="wiki-list"></div>`
        : homeHtml();

      scrollToTop();

      if (!showingList) {
        scrollArea.querySelectorAll('[data-category]').forEach((btn) => {
          btn.addEventListener('click', () => {
            pushHistory();
            browseCategory = btn.dataset.category;
            paint();
          });
        });
        return;
      }

      const browseLink = scrollArea.querySelector('#wiki-to-home');
      if (browseLink) {
        browseLink.addEventListener('click', goHome);
      }

      const q = searchText.trim().toLowerCase();
      const label = scrollArea.querySelector('#wiki-list-label');
      const listEl = scrollArea.querySelector('#wiki-list');

      let matches;
      let pool;
      try {
        // Typing a search always searches across every page kind; a
        // selected browse category only applies when there's no active
        // search text (see showingList / input handler above).
        pool = q ? allEntries() : filterByCategory(allEntries(), browseCategory);
        matches = pool
  .filter((e) => matchesSearch(e, q))
  .sort((a, b) => searchRelevance(a, q) - searchRelevance(b, q) || safeName(a).localeCompare(safeName(b)))
  .slice(0, 200);
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
          : `${CATEGORY_LABELS[browseCategory] || 'All entries'} (${Math.min(pool.length, 200)} of ${pool.length} shown)`;
      }

      listEl.innerHTML = matches.length
        ? matches.map(listRowHtml).join('')
        : `<div class="wiki-empty">No matches.</div>`;
      listEl.querySelectorAll('[data-open]').forEach((row) => {
        row.addEventListener('click', () => {
          pushHistory();
          openEntryId = row.dataset.open;
          paint();
        });
      });

      renderSpritesIn(listEl);
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
  // OldLite. The decoded item/npc spritesheet ImageBitmaps are likewise
  // left cached at module scope on purpose — same rationale as losthq's
  // own itemBitmap/npcBitmap never getting torn down — so reopening the
  // wiki panel doesn't re-fetch/re-decode the sheets every time.
}

export default {
  id: 'wiki',
  name: 'Wiki',
  description: 'Searchable in-client wiki for items, NPCs, shops, and drop tables.',
  version: '1.8.0',
  author: 'goku',
  native: true,
  icon: 'Wiki.png',
  init,
  destroy,
};
