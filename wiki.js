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
//
// v1.2 changes:
//   - Bank-note items are no longer shown as separate list entries. The
//     old isNotedItem() flag-based check is kept (in case wiki.json ever
//     does set one of those fields), but since it isn't catching
//     everything, visibleEntries() now also runs a name-based dedupe pass
//     (dedupeNotedItems) that collapses any items sharing an exact name
//     down to whichever one looks like the "real" item.
//   - Item infobox no longer shows raw Value. It now shows High Alch,
//     Low Alch, General Store Max, and General Store Min, derived from
//     value.
//   - The examine/description text now lives inside the infobox (between
//     the icon and the stat table) instead of at the top of the page
//     body, for both items and NPCs.
//   - The item "Actions" pill list has been removed entirely.
//   - Page layout is now infobox-first, with combat stats (etc.) below it.
//
// v1.3 changes:
//   - Item/NPC sprites are now real icons instead of "I"/"N" letter
//     badges — both in the list rows and in the page infobox.
//   - Sprite extraction is ported 1:1 from losthq's own client code
//     (js/spriteLoader.js): fetch the spritesheet once via
//     fetch -> blob -> createImageBitmap (cached at module scope, so it
//     only ever loads once per session), then for a given sprite index
//     compute `sx = (id % perRow) * spriteSize`,
//     `sy = floor(id / perRow) * spriteSize`, and
//     `ctx.drawImage(bitmap, sx, sy, spriteSize, spriteSize, 0, 0, w, h)`
//     onto a per-entry <canvas>. This replaces the previous CSS
//     background-position based `spriteStyle()` hack, which also had a
//     real bug: it assumed 64 columns/64 rows for BOTH sheets, but per
//     losthq's own loader the NPC sheet is 32-per-row at 256px each (only
//     the item sheet is 64-per-row at 32px) — that mismatch is why NPC
//     icons could come out misaligned/cropped. The per-sheet constants
//     below match losthq's loader exactly.
//   - Sprites are drawn into <canvas> elements after each paint() (list
//     rows and the infobox), same pattern as losthq's
//     renderItemSpriteToCanvas/renderNPCSpriteToCanvas being called after
//     DOM insertion — see renderSpritesIn().
//   - NOT ported: losthq's `stackableSpriteOverrides` quantity-variant
//     icon table (e.g. showing a "handful of arrows" sprite instead of a
//     single arrow past certain stack sizes). The wiki only ever shows
//     one static icon per item, so there's no stack count to vary on. If
//     that's wanted somewhere, it needs to be wired in separately.
//
// v1.4 changes -- shops, drop tables, clue combining:
//   - wiki.json now (per the rebuilt scripts/build-wiki-data.js) carries
//     two new top-level keys alongside `entries`: `shops` (array) and
//     `sharedDropTables` (object keyed by table name -- randomherb,
//     randomjewel, ultrarare_getitem, megararetable, clue-easy,
//     clue-medium, clue-hard). NPC entries also now carry a `drops`
//     object: `{ main: [...], tertiary: [...] }`, where a tertiary entry
//     whose `item` string starts with `~` (e.g. "~clue-easy") is a
//     pointer into `sharedDropTables` rather than a real item.
//   - This file does NOT hardcode the exact inner shape of a shop/table
//     row beyond what was confirmed in the planning discussion (shop:
//     { name, npc, stock }, stock keyed by item id with either a bare
//     qty or a { qty, price } object; shared table rows: { item, weight }
//     with optional per-table `rollBase` / `rollBaseRingOfWealth`, and a
//     rare floor-conditional row shaped like
//     "aboveground = <id> | underground = <id>" for the talisman slot).
//     Every lookup below (normalizeShopStock, normalizeDropTableRow,
//     resolveEntryRef, etc.) is written defensively against a couple of
//     plausible field-name variants for exactly this reason -- if
//     something renders as "Unknown"/blank, that's the signal the real
//     wiki.json uses a field name this file isn't checking yet, not that
//     the row doesn't exist. Paste one real shop/table/drops object and
//     the relevant normalize* function is the only thing that needs to
//     change.
//   - New page kinds: 'shop', 'droptable', 'clue'. These are synthesized
//     in buildDerived() (not present in wikiData.entries itself) and
//     merged into search/browse/detail lookup alongside the real
//     item/npc entries -- see allEntries().
//   - The old standalone "Clue Scroll" item page(s) are dropped from
//     visibleEntries() (name match, see CLUE_ITEM_NAME_RE) in favour of
//     three synthesized 'clue' pages (easy/medium/hard). Each shows (a)
//     which monsters drop that tier and at what combined odds -- read
//     straight off each NPC's `drops.tertiary` entry, which per the
//     Lost City data is already the single combined per-tier chance, not
//     the per-step chance -- and (b) the tier's own scroll contents from
//     `sharedDropTables['clue-<tier>']`, grouped by clue sub-type
//     (map/simple/vague/sextant/riddle/anagram/coordinate/cryptic) so it
//     reads as "14 anagram clues" instead of 14 separate rows. Sub-type
//     is read off a `subtype`/`type` field on the row if present,
//     otherwise guessed from the row's item name -- see CLUE_SUBTYPE_RE.
//   - Explicit-reference hyperlinks only: item/shop/npc/table names that
//     we already have a resolved id for (a shop's stock row, a drop
//     table's item row, a monster's drops row, etc.) are clickable and
//     open that page. Free-text "any word that happens to match a page
//     title" auto-linking was intentionally skipped per plan -- that's a
//     separate, bigger pass over arbitrary description/examine text.

const WIKI_DATA_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/wiki-data/wiki.json';

const ITEM_SPRITESHEET_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/sprites/item_spritesheet.png';

const NPC_SPRITESHEET_URL =
  'https://raw.githubusercontent.com/SoapFreakz/OldLite-Plugins/main/sprites/npc_spritesheet.png';

const STYLE_ID = 'ol-wiki-plugin-style';

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
  .wiki-detail { padding: 0.9em 1em; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
  .wiki-page-title {
    color: var(--ol-text); font-size: 1.4em; font-weight: bold; border-bottom: 2px solid #2e2818;
    padding-bottom: 0.4em; margin-bottom: 0.7em; display: flex; align-items: center; gap: 0.6em;
    overflow-wrap: break-word; word-break: break-word;
  }
  .wiki-page-title .wiki-page-kind {
    font-size: 0.62em; font-weight: normal; color: var(--ol-text-tertiary); text-transform: uppercase;
    letter-spacing: 0.04em;
  }
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
    font-size: 0.85em; padding: 0.35em 0.65em; vertical-align: top; border-top: 1px solid #241f14;
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

  /* combat bonuses table, OSRS-wiki style */
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

  /* ---------- generic data tables: shop stock, drops, drop-table rows ---------- */
    .wiki-data-table {
    width: 100%; max-width: 100%; table-layout: fixed; border-collapse: collapse;
    font-size: 0.9em; margin-bottom: 0.4em;
  }
  .wiki-data-table th, .wiki-data-table td {
    border: 1px solid #2e2818; padding: 0.4em 0.55em; text-align: left; vertical-align: middle;
    overflow-wrap: break-word; word-break: break-word;
  }
  .wiki-data-table th {
    background: var(--ol-panel-bg); color: var(--ol-text-tertiary); font-weight: 600;
  }
  .wiki-data-table tr:nth-child(even) td { background: var(--ol-bg); }
  .wiki-data-table td.wiki-data-num { text-align: right; color: var(--ol-text); white-space: normal; }
  .wiki-data-table td.wiki-data-name { color: var(--ol-text); }
  .wiki-link {
    color: var(--ol-accent); cursor: pointer; text-decoration: none;
  }
  .wiki-link:hover { text-decoration: underline; }
  .wiki-subnote {
    color: var(--ol-text-tertiary); font-size: 0.85em; font-style: italic; margin: -0.2em 0 0.6em;
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
    const flaggedRemoved = wikiData.entries.filter(
      (e) => !isNotedItem(e) && !(e.kind === 'item' && CLUE_ITEM_NAME_RE.test(safeName(e)))
    );
    return dedupeNotedItems(flaggedRemoved);
  }

  function matchesSearch(entry, q) {
    if (!q) return true;
    return safeName(entry).toLowerCase().includes(q);
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

  // Normalizes one shop's `stock` field. Supports the two shapes we
  // expect the build script to plausibly produce:
  //   { "item-556": 10 }                         (bare qty)
  //   { "item-556": { qty: 10, price: 200 } }     (qty + explicit price)
  //   [ { item: "item-556", stock: 10, price: 200 } ]  (array form)
  function normalizeShopStock(stock) {
    const rows = [];
    if (!stock) return rows;
    if (Array.isArray(stock)) {
      for (const row of stock) {
        if (!row) continue;
        rows.push({
          itemRef: row.item ?? row.itemId ?? row.id,
          qty: row.stock ?? row.qty ?? row.quantity ?? null,
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
  // give one explicitly, the same way the infobox already derives
  // General Store Min/Max from an item's base value (see
  // infoboxRowsForItem). This is a rough approximation for
  // non-general-store shops -- if wiki.json ever adds a real per-shop
  // price multiplier, swap this for that instead of the flat 0.4x guess.
  function derivedShopPrice(itemEntry) {
    if (!itemEntry || itemEntry.value == null) return null;
    return Math.floor(itemEntry.value * 0.4);
  }

  function normalizeShopNpcRefs(shop) {
    const raw = shop.npc ?? shop.npcs ?? shop.shopkeeper ?? shop.shopkeepers;
    if (raw == null) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  function buildShops() {
    const rawShops = Array.isArray(wikiData.shops) ? wikiData.shops : [];
    const entries = [];
    const byItemId = new Map(); // itemEntry.id -> [{ shopEntry, qty, price }]
    const byNpcId = new Map(); // npcEntry.id -> [shopEntry]

    rawShops.forEach((shop, idx) => {
      const name = shop.name || `Shop ${idx + 1}`;
      const id = `shop:${slugify(name)}-${idx}`;
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

      const rows = rawRows.map((row) => normalizeDropTableRow(row, rollBase));

      const entry = {
        id: `droptable:${slugify(key)}`,
        kind: 'droptable',
        name: table.name || prettifyTableName(key),
        tableKey: key,
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
  // those rows).
  function normalizeDropTableRow(row, rollBase) {
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

    return {
      itemEntry: resolveEntryRef(row.itemId),
      itemRef: row.itemId ?? row.debugname,
      odds,
      qty: row.quantity,
      note: row.note || null,
    };
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
  // "~tablekey" string for shared-table pointers. qty itself can be a
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

  function sectionHtml(title, innerHtml) {
    return `<div class="wiki-section-title">${escapeHtml(title)}</div>${innerHtml}`;
  }

  function emptySection(text) {
    return `<div class="wiki-empty-section">${escapeHtml(text)}</div>`;
  }

  // ---- item page additions: shop locations / ground spawns / dropped by ----

  function shopLocationsHtml(itemEntry) {
    ensureDerived();
    const rows = (derived.shops.byItemId.get(itemEntry.id) || []);
    if (!rows.length) return sectionHtml('Shop Locations', emptySection('Not sold in any shop.'));
    const body = rows
      .map(
        ({ shopEntry, qty, price }) => `
          <tr>
            <td class="wiki-data-name">${linkHtml(shopEntry)}</td>
            <td class="wiki-data-num">${qty != null ? escapeHtml(String(qty)) : '&mdash;'}</td>
            <td class="wiki-data-num">${price != null ? `${price.toLocaleString()} gp` : '&mdash;'}</td>
          </tr>`
      )
      .join('');
    return sectionHtml(
      'Shop Locations',
      `<table class="wiki-data-table">
        <thead><tr><th>Shop</th><th>Stock</th><th>Price</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`
    );
  }

  function groundSpawnsHtml(itemEntry) {
    return '';
  }

  function droppedByHtml(itemEntry) {
    ensureDerived();
    const rows = derived.npcDropIndex.byItemId.get(itemEntry.id) || [];
    if (!rows.length) return '';
    const body = rows
      .map(
        ({ npcEntry, odds, min, max }) => `
          <tr>
            <td class="wiki-data-name">${linkHtml(npcEntry)}</td>
            <td class="wiki-data-num">${
              min != null || max != null
                ? escapeHtml(min === max || max == null ? String(min) : `${min}-${max}`)
                : '&mdash;'
            }</td>
            <td class="wiki-data-num">${odds ? escapeHtml(odds) : '&mdash;'}</td>
          </tr>`
      )
      .join('');
    return sectionHtml(
      'Dropped By',
      `<table class="wiki-data-table">
        <thead><tr><th>Monster</th><th>Quantity</th><th>Rarity</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`
    );
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
      return `
        <tr>
          <td class="wiki-data-name">${linkHtml(target, target ? safeName(target) || target.name : prettifyTableName(tableKey))}</td>
          <td class="wiki-data-num">&mdash;</td>
          <td class="wiki-data-num">${odds ? escapeHtml(odds) : '&mdash;'}</td>
        </tr>`;
    }

    function itemRowHtml(itemEntry, ref, qty, odds) {
      const label = itemEntry ? linkHtml(itemEntry) : escapeHtml(String(ref));
      const { min, max } = parseQtyRange(qty);
      const qtyLabel = min != null ? (min === max ? String(min) : `${min}-${max}`) : null;
      return `
        <tr>
          <td class="wiki-data-name">${label}</td>
          <td class="wiki-data-num">${qtyLabel ? escapeHtml(qtyLabel) : '&mdash;'}</td>
          <td class="wiki-data-num">${odds ? escapeHtml(odds) : '&mdash;'}</td>
        </tr>`;
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

    return sectionHtml(
      'Drops',
      `<table class="wiki-data-table">
        <thead><tr><th>Item</th><th>Quantity</th><th>Rarity</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    );
  }

  function npcShopRefHtml(npcEntry) {
    ensureDerived();
    const shops = derived.shops.byNpcId.get(npcEntry.id) || [];
    if (!shops.length) return '';
    const links = shops.map((s) => linkHtml(s)).join(', ');
    return sectionHtml('Runs Shop', `<div class="wiki-plain-text">${links}</div>`);
  }

  // ---- shop page ----

  function shopDetailHtml(shopEntry) {
    const keeperLinks = shopEntry.shopkeepers.length
      ? shopEntry.shopkeepers.map((n) => linkHtml(n)).join(', ')
      : 'Unknown';
    const rows = shopEntry.stockRows
      .map((row) => {
        const label = row.itemEntry ? linkHtml(row.itemEntry) : escapeHtml(String(row.itemRef));
        return `
          <tr>
            <td class="wiki-data-name">${label}</td>
            <td class="wiki-data-num">${row.qty != null ? escapeHtml(String(row.qty)) : '&mdash;'}</td>
            <td class="wiki-data-num">${row.price != null ? `${row.price.toLocaleString()} gp` : '&mdash;'}</td>
          </tr>`;
      })
      .join('');

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(shopEntry.name)}
          <span class="wiki-page-kind">Shop</span>
        </div>
        <div class="wiki-infobox">
          <div class="wiki-infobox-header">${escapeHtml(shopEntry.name)}</div>
          <table class="wiki-infobox-table">
            <tr><td class="wiki-infobox-label">Shopkeeper</td><td class="wiki-infobox-value">${keeperLinks}</td></tr>
          </table>
        </div>
        ${sectionHtml(
          'Stock',
          shopEntry.stockRows.length
            ? `<table class="wiki-data-table">
                <thead><tr><th>Item</th><th>Stock</th><th>Price</th></tr></thead>
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
          const noteHtml = row.note ? `<div class="wiki-subnote">${escapeHtml(row.note)}</div>` : '';
          return `
            <tr>
              <td class="wiki-data-name">Aboveground: ${
                aboveground ? linkHtml(aboveground) : '&mdash;'
              }<br>Underground: ${underground ? linkHtml(underground) : '&mdash;'}${noteHtml}</td>
              <td class="wiki-data-num">${row.odds ? escapeHtml(row.odds) : '&mdash;'}</td>
            </tr>`;
        }
        if (row.tableRef) {
          const target = derived.dropTables.byKey.get(row.tableRef);
          const label = linkHtml(target, target ? target.name : prettifyTableName(row.tableRef));
          const noteHtml = row.note ? `<div class="wiki-subnote">${escapeHtml(row.note)}</div>` : '';
          return `
            <tr>
              <td class="wiki-data-name">${label}${noteHtml}</td>
              <td class="wiki-data-num">${row.odds ? escapeHtml(row.odds) : '&mdash;'}</td>
            </tr>`;
        }
        const label = row.itemEntry ? linkHtml(row.itemEntry) : escapeHtml(String(row.itemRef));
        const qtyLabel = row.qty != null && row.qty !== 1 ? ` (${row.qty})` : '';
        const noteHtml = row.note ? `<div class="wiki-subnote">${escapeHtml(row.note)}</div>` : '';
        return `
          <tr>
            <td class="wiki-data-name">${label}${escapeHtml(qtyLabel)}${noteHtml}</td>
            <td class="wiki-data-num">${row.odds ? escapeHtml(row.odds) : '&mdash;'}</td>
          </tr>`;
      })
      .join('');

    const rowOfWealthNote =
      tableEntry.rollBaseRingOfWealth != null
        ? `<div class="wiki-subnote">With a Ring of Wealth equipped, rolls are out of ${tableEntry.rollBaseRingOfWealth} instead of ${tableEntry.rollBase}.</div>`
        : '';

    const droppedByBody = droppedBy
      .map(
        ({ npcEntry, odds }) => `
          <tr>
            <td class="wiki-data-name">${linkHtml(npcEntry)}</td>
            <td class="wiki-data-num">${odds ? escapeHtml(odds) : '&mdash;'}</td>
          </tr>`
      )
      .join('');

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(tableEntry.name)}
          <span class="wiki-page-kind">Drop Table</span>
        </div>
        ${sectionHtml(
          'Table Contents',
          `<table class="wiki-data-table">
            <thead><tr><th>Item</th><th>Odds</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${rowOfWealthNote}`
        )}
        ${sectionHtml(
          'Dropped By',
          droppedBy.length
            ? `<table class="wiki-data-table">
                <thead><tr><th>Monster</th><th>Roll Chance</th></tr></thead>
                <tbody>${droppedByBody}</tbody>
              </table>`
            : emptySection('No monster currently references this table.')
        )}
      </div>
    `;
  }

  // ---- clue scroll page (combined easy/medium/hard) ----

  function clueDetailHtml(clueEntry) {
    const droppedByBody = clueEntry.droppedBy
      .map(
        ({ npcEntry, odds }) => `
          <tr>
            <td class="wiki-data-name">${linkHtml(npcEntry)}</td>
            <td class="wiki-data-num">${odds ? escapeHtml(odds) : '&mdash;'}</td>
          </tr>`
      )
      .join('');

    const subtypeBody = clueEntry.bySubtype
      .map(([subtype, count]) => `<tr><td class="wiki-data-name">${escapeHtml(subtype)}</td><td class="wiki-data-num">${count}</td></tr>`)
      .join('');

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(clueEntry.name)}
          <span class="wiki-page-kind">Clue Scroll</span>
        </div>
        ${sectionHtml(
          'Dropped By',
          clueEntry.droppedBy.length
            ? `<table class="wiki-data-table">
                <thead><tr><th>Monster</th><th>Chance</th></tr></thead>
                <tbody>${droppedByBody}</tbody>
              </table>`
            : emptySection('No monster currently drops this clue tier.')
        )}
        ${sectionHtml(
          'Scroll Steps',
          clueEntry.bySubtype.length
            ? `<table class="wiki-data-table">
                <thead><tr><th>Step Type</th><th>Count</th></tr></thead>
                <tbody>${subtypeBody}</tbody>
              </table>
              <div class="wiki-subnote">${clueEntry.totalSteps} possible ${clueEntry.tier} clue steps in total, grouped by type.</div>`
            : emptySection('No scroll-step data available for this tier.')
        )}
      </div>
    `;
  }

  // Infobox is always first, then any stats sections below it (currently
  // just Combat Stats for equippable items, plus the new Shop
  // Locations / Ground Spawns / Dropped By sections for items and Drops
  // / Runs Shop for NPCs). Actions/"wear" pills have been removed
  // entirely, and the examine text has moved into the infobox (see
  // infoboxHtml above) rather than sitting up here.
  function detailHtml(entry) {
    if (entry.kind === 'shop') return shopDetailHtml(entry);
    if (entry.kind === 'droptable') return dropTableDetailHtml(entry);
    if (entry.kind === 'clue') return clueDetailHtml(entry);

    const stats = combatStatsHtml(entry);
    const extraSections =
      entry.kind === 'npc'
        ? [npcDropsHtml(entry), npcShopRefHtml(entry)]
        : [droppedByHtml(entry), shopLocationsHtml(entry), groundSpawnsHtml(entry)];

    return `
      <div class="wiki-detail">
        <div class="wiki-page-title">
          ${escapeHtml(safeName(entry))}
          <span class="wiki-page-kind">${entry.kind === 'npc' ? 'NPC' : 'Item'}</span>
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
    return `
      <div class="wiki-home">
        <div class="wiki-home-title">Oldrune Wiki</div>
        <div class="wiki-home-desc">
          Search for an item, NPC, shop or drop table above, or browse everything the wiki currently knows about.
        </div>
        <div class="wiki-home-stats">
          <div class="wiki-home-stat"><b>${items}</b> items</div>
          <div class="wiki-home-stat"><b>${npcs}</b> NPCs</div>
          <div class="wiki-home-stat"><b>${shops}</b> shops</div>
          <div class="wiki-home-stat"><b>${tables}</b> drop tables</div>
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
        const entry = findEntryById(openEntryId);
        if (!entry) {
          openEntryId = null;
          paint();
          return;
        }
        root.innerHTML = detailHtml(entry);
        renderSpritesIn(root);
        // Cross-reference links inside the page body (shop stock rows,
        // drop table rows, "Dropped By" monster names, etc.) — same
        // open-by-id mechanism as the list rows, just delegated over
        // whatever wiki-link spans detailHtml happened to render.
        root.querySelectorAll('[data-open]').forEach((link) => {
          link.addEventListener('click', () => {
            openEntryId = link.dataset.open;
            paint();
          });
        });
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
      let pool;
      try {
        pool = allEntries();
        matches = pool.filter((e) => matchesSearch(e, q)).slice(0, 200);
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
          : `All entries (${Math.min(pool.length, 200)} of ${pool.length} shown)`;
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
  version: '1.1.10',
  author: 'goku',
  native: true,
  icon: 'Wiki.png',
  init,
  destroy,
};
