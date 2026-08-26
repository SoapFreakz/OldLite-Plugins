// OldLite Wiki — offline build script.
//
// Run this manually whenever losthq bumps their dataset:
//   node scripts/build-wiki-data.js
//
// It fetches the losthq JSON databases, normalizes items + npcs into one
// flat shape, and writes wiki-data/wiki.json into the plugins repo root.
// wiki.js (the plugin) fetches that ONE file at runtime the same way
// loader.js fetches icons/*.png — straight off raw.githubusercontent.com,
// never hitting losthq directly from the client. Reasons:
//   - losthq's endpoints almost certainly don't send CORS headers for an
//     oldrune.com / file:// origin fetch from inside the Electron webview.
//   - The merge work below (herb identify-levels, clue-tier grouping) is
//     static until losthq's dataset changes again — no reason to redo it
//     on every plugin load.
//
// THIS FILE IS BASELINE ONLY (per current scope):
//   - Items and NPCs are normalized and merged into one list.
//   - Herb identify-level attachment and clue-tier merging are NOT done
//     here yet — that's the next pass, once the baseline plugin is
//     confirmed working end-to-end. Doing it now would mean debugging
//     both the data pipeline AND the UI in the same step.
//
// Confirmed source shapes (verified directly against the live endpoints,
// not guessed):
//   item_data.json entries: { debugname, id, name, desc, cost, weight,
//     members, tradeable?, stackable?, dummyitem?, iops: {iop1..iop5},
//     spawn_locations?: string[], equipable_item?: { wearpos,
//     stabattack, slashattack, crushattack, stabdefence, slashdefence,
//     crushdefence, magicattack, magicdefence, rangebonus,
//     strengthbonus, attackrate } }
//   npc_data.json / shop_data.json / shared_drops.json: NOT re-fetched by
//   this script yet (left as a follow-up) — see comment on fetchNpcs().

const fs = require('fs');
const path = require('path');

const ITEM_DATA_URL = 'https://2004.losthq.rs/js/itemdb/item_data.json?v=274';
const NPC_DATA_URL = 'https://2004.losthq.rs/js/npcdb/npc_data.json?v=274';
// Not consumed yet — kept here so the next pass (shop locations, clue-tier
// drop merging) doesn't have to go rediscover these URLs.
const SHOP_DATA_URL = 'https://2004.losthq.rs/js/npcdb/shop_data.json?v=274';
const SHARED_DROPS_URL = 'https://2004.losthq.rs/js/npcdb/shared_drops.json?v=274';

const OUT_PATH = path.join(__dirname, '..', 'wiki-data', 'wiki.json');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status}`);
  return res.json();
}

// Wear-slot key -> display label, for the equip infobox row.
const WEARPOS_LABELS = {
  head: 'Head',
  cape: 'Cape',
  neck: 'Neck',
  weapon: 'Weapon',
  body: 'Body',
  shield: 'Shield',
  legs: 'Legs',
  hands: 'Hands',
  feet: 'Feet',
  ring: 'Ring',
  ammunition: 'Ammo',
};

function normalizeItem(raw) {
  const iopVerbs = raw.iops ? Object.values(raw.iops) : [];
  const equip = raw.equipable_item || null;

  return {
    kind: 'item',
    id: `item-${raw.id}`,
    sourceId: raw.id,
    debugname: raw.debugname,
    name: raw.name,
    examine: raw.desc || '',
    value: typeof raw.cost === 'number' ? raw.cost : null,
    weight: typeof raw.weight === 'number' ? raw.weight : null,
    membersOnly: !!raw.members,
    tradeable: !!raw.tradeable,
    stackable: !!raw.stackable,
    dummyitem: !!raw.dummyitem,
    actions: iopVerbs.filter((v) => v && v !== 'Drop'),
    spawnLocations: raw.spawn_locations || [],
    equip: equip
      ? {
          slot: WEARPOS_LABELS[equip.wearpos] || equip.wearpos || null,
          stabAttack: equip.stabattack ?? null,
          slashAttack: equip.slashattack ?? null,
          crushAttack: equip.crushattack ?? null,
          magicAttack: equip.magicattack ?? null,
          rangeAttack: equip.rangeattack ?? null,
          stabDefence: equip.stabdefence ?? null,
          slashDefence: equip.slashdefence ?? null,
          crushDefence: equip.crushdefence ?? null,
          magicDefence: equip.magicdefence ?? null,
          rangeDefence: equip.rangedefence ?? null,
          rangeBonus: equip.rangebonus ?? null,
          strengthBonus: equip.strengthbonus ?? null,
          attackRate: equip.attackrate ?? null,
        }
      : null,
  };
}

// NPC normalization is intentionally defensive: this script hasn't been
// run against npc_data.json's real shape yet in this pass, so it reads a
// handful of plausible field names and just omits whatever isn't present
// rather than guessing a rigid schema. Tighten this once npc_data.json's
// actual fields are confirmed (follow-up pass, alongside shop_data.json
// and shared_drops.json's clue/drop-table merging).
function normalizeNpc(raw, index) {
  const id = raw.id ?? raw.npcid ?? index;
  return {
    kind: 'npc',
    id: `npc-${id}`,
    sourceId: id,
    debugname: raw.debugname || raw.debug_name || null,
    name: raw.name || 'Unknown NPC',
    examine: raw.desc || raw.examine || '',
    combatLevel: raw.combat ?? raw.combat_level ?? raw.level ?? null,
    hitpoints: raw.hitpoints ?? raw.hp ?? null,
    members: !!raw.members,
    attackable: raw.attackable !== undefined ? !!raw.attackable : null,
    // Raw drop/tertiary refs kept as-is for now (e.g. "~clue-easy") so a
    // later pass can resolve them against shared_drops.json without
    // needing to re-fetch npc_data.json.
    drops: raw.drops || null,
  };
}

async function main() {
  console.log('[wiki-build] fetching item_data.json ...');
  const itemsRaw = await fetchJson(ITEM_DATA_URL);
  console.log(`[wiki-build] got ${itemsRaw.length} items`);

  console.log('[wiki-build] fetching npc_data.json ...');
  const npcsRaw = await fetchJson(NPC_DATA_URL);
  console.log(`[wiki-build] got ${npcsRaw.length} npcs`);

  const items = itemsRaw
    // Skip dummy items and blank/placeholder "notes" — the "Swap this
    // note at any bank for a X" certs are real game items though, so
    // those stay in (osrs wiki lists them too).
    .filter((it) => !it.dummyitem)
    .map(normalizeItem);

  const npcs = npcsRaw.map(normalizeNpc);

  const entries = [...items, ...npcs];

  const output = {
    generatedAt: new Date().toISOString(),
    sourceVersion: 'v274',
    counts: { items: items.length, npcs: npcs.length },
    entries,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));
  console.log(`[wiki-build] wrote ${entries.length} entries -> ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[wiki-build] failed:', err);
  process.exit(1);
});
