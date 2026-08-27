// OldLite plugin: Tileman Mode
// Ported from the reference Tampermonkey userscript (Oldrune Tileman Mode).
// Logic is unchanged from the reference — client capture, the diagonal-walk
// confirm-polling fix, absolute-world tile storage, and the real projection
// math are all load-bearing and were NOT redesigned. What changed:
//   - IIFE -> init(api)/destroy(api)
//   - manual bind-hook + setTimeout poll/redraw loops -> api.onTick()
//   - manual overlay canvas setup -> api.createOverlay()
//   - raw localStorage -> api.storage (namespaced per-plugin automatically)
//   - the reference's embedded base64 login-screen logo image is replaced
//     with a lightweight text wordmark here, to avoid shipping a multi-KB
//     data URI in every plugin file. Swap in a real image the same way the
//     reference did if you want one.

const TILE_SIZE = 128;
const POLL_MS = 100;
const REDRAW_MS = 40;
const RENDER_DISTANCE_TILES = 15;

const TEXTBOX_SCALE_FRACTIONS = { 0.25: 1 / 10, 0.5: 1 / 7, 1: 1 / 4.5, 2: 1 / 3 };
const HUD_FONT_TO_WIDTH_RATIO = 0.055;

const DEFAULT_SETTINGS = {
  opacity: 1,
  colorAvailable: '#00ff00',
  colorRestricted: '#ff0000',
  xpPerTile: 500,
  restrictionEnabled: false,
  restrictionStepXp: 100000,
  restrictionStepIncrease: 500,
  textboxScale: 1,
  manualUnlocks: false,
};
const RESTRICTION_MAX_ITERATIONS = 1000000;
const TILE_CONFIRM_POLLS = 2; // polls (~200ms at POLL_MS=100) before committing a new tile

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function costPerTileAtBracket(bracketIndex, s) {
  return s.xpPerTile + bracketIndex * s.restrictionStepIncrease;
}

function computeAllowance(totalXp, s) {
  if (!s.restrictionEnabled) return Math.floor(totalXp / s.xpPerTile);
  const fullBrackets = Math.floor(totalXp / s.restrictionStepXp);
  let tiles = 0;
  for (let k = 0; k < fullBrackets; k++) {
    const cost = costPerTileAtBracket(k, s);
    if (cost > 0) tiles += Math.floor(s.restrictionStepXp / cost);
  }
  const remainder = totalXp - fullBrackets * s.restrictionStepXp;
  const currentCost = costPerTileAtBracket(fullBrackets, s);
  if (currentCost > 0) tiles += Math.floor(remainder / currentCost);
  return tiles;
}

function xpRequiredForTileCount(n, s) {
  if (!s.restrictionEnabled) return n * s.xpPerTile;
  let tilesRemaining = n;
  let xpNeeded = 0;
  let k = 0;
  while (tilesRemaining > 0 && k < RESTRICTION_MAX_ITERATIONS) {
    const cost = costPerTileAtBracket(k, s);
    const tilesThisBracket = cost > 0 ? Math.floor(s.restrictionStepXp / cost) : 0;
    if (tilesRemaining <= tilesThisBracket) {
      xpNeeded += tilesRemaining * cost;
      tilesRemaining = 0;
    } else {
      xpNeeded += s.restrictionStepXp;
      tilesRemaining -= tilesThisBracket;
      k++;
    }
  }
  return xpNeeded;
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export default {
  id: 'tileman',
  name: 'TileMan Mode',
  description:
    'Unlock the world of Gielinor 1 tile at a time',
  version: '1.2.0',
  author: 'goku',
  native: false,

  init(api) {
    const s = this;

    // ---- LOGIN-STATE OVERRIDE ----
    // api.isAtLoginScreen() relies on loader.js's CLIENT_MAP, which is baked
    // into the packaged app and has drifted out of sync with this client
    // build's obfuscated property names (loginState/loadingState no longer
    // point at the right fields there). Since tileman.js is fetched live
    // from GitHub at runtime, we can ship a fix here immediately without
    // waiting on a repackage/redistribution of the app. This re-implements
    // the exact same logic loader.js uses, but against the confirmed-correct
    // raw field names for this build (Tv/Pz), read straight off the live
    // client object via api.getClient() instead of going through api.raw().
    function isAtLoginScreen() {
      const client = api.getClient();
      if (!client) return true;
      const loginState = client.Tv;
      const loadingState = client.Pz;
      if (loginState === 0) return true;
      if (loginState === 2 && loadingState === 0) return true;
      return false;
    }

    let visitedTiles = new Map();
    let settings = { ...DEFAULT_SETTINGS, ...api.storage.get('settings', {}) };
    const warnedTiles = new Set();
    let pendingTile = null;
    let pendingStableCount = 0;
    let drawnTileScreens = new Map();

    (function loadVisited() {
      const arr = api.storage.get('visited', []);
      for (const t of arr) visitedTiles.set(t.x + ',' + t.z, t);
      api.log('loaded', visitedTiles.size, 'previously unlocked tiles.');
    })();

    function saveVisited() {
      api.storage.set('visited', [...visitedTiles.values()]);
    }

    function saveSettings() {
      api.storage.set('settings', settings);
    }

    function resetAllTiles() {
      visitedTiles.clear();
      warnedTiles.clear();
      pendingTile = null;
      pendingStableCount = 0;
      saveVisited();
      api.log('all unlocked tiles have been reset.');
    }

    function getTileStats(client) {
      const totalXp = api.getTotalXp(client);
      const allowance = computeAllowance(totalXp, settings);
      const xpForNextTile = xpRequiredForTileCount(allowance + 1, settings);
      const xpUntilNext = Math.max(0, xpForNextTile - totalXp);
      const used = visitedTiles.size;
      const available = Math.max(0, allowance - used);
      return { totalXp, allowance, used, available, xpUntilNext };
    }

    // ---- OVERLAY ----
    const overlay = api.createOverlay();

    // ---- HUD ----
    let hudEl = null;
    function makeDraggable(el) {
      let dragging = false,
        offsetX = 0,
        offsetY = 0;
      const saved = api.storage.get('hudPos', null);
      if (saved && typeof saved.left === 'number') {
        el.style.left = saved.left + 'px';
        el.style.top = saved.top + 'px';
        el.style.right = 'auto';
      }
      el.addEventListener('mousedown', (e) => {
        if (!e.shiftKey) return;
        e.preventDefault();
        dragging = true;
        const rect = el.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
      });
      const onMove = (e) => {
        if (!dragging) return;
        el.style.left = e.clientX - offsetX + 'px';
        el.style.top = e.clientY - offsetY + 'px';
        el.style.right = 'auto';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        api.storage.set('hudPos', {
          left: parseInt(el.style.left, 10) || 0,
          top: parseInt(el.style.top, 10) || 0,
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    function ensureHud() {
      if (hudEl) return;
      const style = document.createElement('style');
      style.textContent = `
        #tileman-hud .tm-row { display: flex; justify-content: space-between; gap: 0.4em; white-space: nowrap; }
        #tileman-hud .tm-row span:last-child { color: #ffe4b3; font-weight: bold; margin-left: 0.4em; }
      `;
      api.container.appendChild(style);

      hudEl = document.createElement('div');
      hudEl.id = 'tileman-hud';
      hudEl.style.cssText = [
        'position: fixed', 'top: 10px', 'right: 10px', 'background: rgba(0,0,0,0.75)',
        'border: 1px solid #5a4a30', 'border-radius: 3px', 'font-family: monospace',
        'font-size: 13px', 'color: #ff981f', 'line-height: 1.7', 'z-index: 10000',
        'user-select: none', 'cursor: default', 'box-sizing: border-box',
      ].join(';');
      hudEl.innerHTML = `
        <div class="tm-row"><span>Available Tiles:</span><span id="tm-available">0</span></div>
        <div class="tm-row"><span>XP Until Next Tile:</span><span id="tm-xpnext">0</span></div>
        <div class="tm-row"><span>Tiles Unlocked:</span><span id="tm-unlocked">0</span></div>
      `;
      api.container.appendChild(hudEl);
      makeDraggable(hudEl);
      syncHudWidth();
    }

    function syncHudWidth() {
      const gameCanvas = api.getGameCanvas();
      if (!hudEl || !gameCanvas) return;
      const rect = gameCanvas.getBoundingClientRect();
      const frac = TEXTBOX_SCALE_FRACTIONS[settings.textboxScale] || TEXTBOX_SCALE_FRACTIONS[1];
      const width = rect.width * frac;
      const fontPx = width * HUD_FONT_TO_WIDTH_RATIO;
      hudEl.style.width = width + 'px';
      hudEl.style.fontSize = fontPx + 'px';
      hudEl.style.padding = fontPx * 0.45 + 'px ' + fontPx * 0.75 + 'px';
    }

    function updateHud(stats) {
      if (!hudEl) return;
      const client = api.getClient();
      if (!client || isAtLoginScreen() || api.isModalOpen()) {
        hudEl.style.display = 'none';
        return;
      }
      hudEl.style.display = '';
      hudEl.querySelector('#tm-available').textContent = stats.available;
      hudEl.querySelector('#tm-xpnext').textContent = stats.xpUntilNext;
      hudEl.querySelector('#tm-unlocked').textContent = stats.used;
    }

    // ---- LOGIN-SCREEN WORDMARK (simplified stand-in for the reference's logo image) ----
    let logoEl = null;
    function ensureLogo() {
      if (logoEl) return;
      const gameCanvas = api.getGameCanvas();
      if (!gameCanvas) return;
      logoEl = document.createElement('div');
      logoEl.id = 'tileman-logo';
      logoEl.textContent = 'TILEMAN MODE';
      logoEl.style.cssText = [
        'position: absolute', 'pointer-events: none', 'z-index: 10000',
        'font-family: monospace', 'font-weight: bold', 'letter-spacing: 2px',
        'color: #ff981f', 'text-shadow: 0 2px 6px rgba(0,0,0,0.8)',
      ].join(';');
      gameCanvas.parentElement.appendChild(logoEl);
    }

    function positionLogo() {
      const gameCanvas = api.getGameCanvas();
      if (!logoEl || !gameCanvas) return;
      const rect = gameCanvas.getBoundingClientRect();
      logoEl.style.fontSize = Math.max(12, rect.width * 0.02) + 'px';
      const bandTop = gameCanvas.offsetTop + rect.height * 0.74;
      const bandHeight = rect.height * 0.2;
      logoEl.style.top = bandTop + bandHeight / 2 - 8 + 'px';
      logoEl.style.left = gameCanvas.offsetLeft + rect.width / 2 + 'px';
      logoEl.style.transform = 'translateX(-50%)';
    }

    function updateLogoVisibility() {
      if (!logoEl) return;
      positionLogo();
      logoEl.style.display = isAtLoginScreen() ? 'block' : 'none';
    }

    // ---- SETTINGS ----
    // Registered declaratively with the loader's shared settings panel
    // (rail's Installed tab -> gear icon on this plugin's card) instead of
    // building our own floating gear button + backdrop. The loader owns the
    // rendering, theming, and draft/back-button navigation; we only supply
    // the schema and the logic behind each action. See loader.js's
    // api.registerSettings() doc comment for the schema shape.
    api.registerSettings({
      title: 'Tileman Settings',
      sections: [
        {
          label: 'Appearance',
          fields: [
            { key: 'opacity', type: 'range', label: 'Tile Opacity', min: 0, max: 100, unit: '%', displayScale: 100 },
            { key: 'colorAvailable', type: 'color', label: 'Available Color' },
            { key: 'colorRestricted', type: 'color', label: 'Restricted Color' },
            {
              key: 'textboxScale',
              type: 'select',
              label: 'Textbox Scale',
              options: [
                { value: 0.25, label: 'x0.25' },
                { value: 0.5, label: 'x0.5' },
                { value: 1, label: 'x1' },
                { value: 2, label: 'x2' },
              ],
            },
          ],
        },
        {
          label: 'Tile Cost',
          fields: [
            { key: 'xpPerTile', type: 'number', label: 'XP per Tile', min: 1 },
            { key: 'manualUnlocks', type: 'checkbox', label: 'Manual Unlocks' },
            { key: 'restrictionEnabled', type: 'checkbox', label: 'Progressive Cost Increase' },
            {
              key: 'restrictionStepXp',
              type: 'number',
              label: 'Every (Total XP)',
              min: 1,
              indent: true,
              showWhen: { key: 'restrictionEnabled', equals: true },
            },
            {
              key: 'restrictionStepIncrease',
              type: 'number',
              label: 'Increase Cost By',
              min: 1,
              indent: true,
              showWhen: { key: 'restrictionEnabled', equals: true },
            },
          ],
        },
      ],
      actions: [
        {
          id: 'reset',
          label: 'Reset All Tiles',
          style: 'danger',
          confirm: "This will permanently reset ALL of your unlocked tiles. This can't be undone. Are you sure?",
        },
        { id: 'save', label: 'Save Settings', style: 'primary' },
      ],
      getValues: () => ({ ...settings }),
      onAction(actionId, draft) {
        if (actionId === 'reset') {
          resetAllTiles();
          return false; // stay on the settings view, same as the reference behavior
        }
        if (actionId === 'save') {
          settings = { ...draft };
          saveSettings();
          syncHudWidth();
          api.log('settings saved:', settings);
          return true; // back out to the plugin list, same as closeSettingsPanel() used to
        }
        return false;
      },
    });

    // ---- HEIGHTMAP ----
    function getCornerHeights(client, tileX, tileZ) {
      const level = (window.__tilemanConfig && window.__tilemanConfig.level) || 0;
      const Fh = api.raw(client, 'heightmap') && api.raw(client, 'heightmap')[level];
      if (!Fh) return null;
      const h = (x, z) => {
        const row = Fh[x];
        if (!row) return null;
        const v = row[z];
        return typeof v === 'number' ? v : null;
      };
      const y0 = h(tileX, tileZ),
        y1 = h(tileX + 1, tileZ),
        y2 = h(tileX + 1, tileZ + 1),
        y3 = h(tileX, tileZ + 1);
      if (y0 === null || y1 === null || y2 === null || y3 === null) return null;
      return { y0, y1, y2, y3 };
    }

    // ---- DRAWING ----
    function drawTileOutline(gameCanvas, worldX, worldZ, corners, cam, color) {
      const points = [
        api.project(worldX, corners.y0, worldZ, cam, gameCanvas),
        api.project(worldX + TILE_SIZE, corners.y1, worldZ, cam, gameCanvas),
        api.project(worldX + TILE_SIZE, corners.y2, worldZ + TILE_SIZE, cam, gameCanvas),
        api.project(worldX, corners.y3, worldZ + TILE_SIZE, cam, gameCanvas),
      ];
      if (points.some((p) => p === null)) return null;
      overlay.ctx.strokeStyle = color;
      overlay.ctx.lineWidth = 2;
      overlay.ctx.beginPath();
      overlay.ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) overlay.ctx.lineTo(points[i].x, points[i].y);
      overlay.ctx.closePath();
      overlay.ctx.stroke();
      return points;
    }

    function findTileAtScreenPoint(client, base, cam, gameCanvas, px, py) {
      const localTile = api.getPlayerLocalTile(client);
      const playerAbs = api.localToAbsolute(localTile.x, localTile.z, base);
      const maxDistSq = RENDER_DISTANCE_TILES * RENDER_DISTANCE_TILES;
      const candidates = [];
      for (let dx = -RENDER_DISTANCE_TILES; dx <= RENDER_DISTANCE_TILES; dx++) {
        for (let dz = -RENDER_DISTANCE_TILES; dz <= RENDER_DISTANCE_TILES; dz++) {
          const distSq = dx * dx + dz * dz;
          if (distSq > maxDistSq) continue;
          candidates.push({ absX: playerAbs.x + dx, absZ: playerAbs.z + dz, distSq });
        }
      }
      candidates.sort((a, b) => a.distSq - b.distSq);
      for (const c of candidates) {
        const local = api.absoluteToLocal(c.absX, c.absZ, base);
        const corners = getCornerHeights(client, local.x, local.z);
        if (!corners) continue;
        const worldX = local.x * TILE_SIZE;
        const worldZ = local.z * TILE_SIZE;
        const points = [
          api.project(worldX, corners.y0, worldZ, cam, gameCanvas),
          api.project(worldX + TILE_SIZE, corners.y1, worldZ, cam, gameCanvas),
          api.project(worldX + TILE_SIZE, corners.y2, worldZ + TILE_SIZE, cam, gameCanvas),
          api.project(worldX, corners.y3, worldZ + TILE_SIZE, cam, gameCanvas),
        ];
        if (points.some((p) => p === null)) continue;
        if (pointInPolygon(px, py, points)) return { x: c.absX, z: c.absZ };
      }
      return null;
    }

    function handleTileShiftRightClick(e) {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const client = api.getClient();
      if (!client || api.isModalOpen() || isAtLoginScreen()) return;

      const rect = overlay.canvas.getBoundingClientRect();
      const scaleX = overlay.canvas.width / rect.width;
      const scaleY = overlay.canvas.height / rect.height;
      const px = (e.clientX - rect.left) * scaleX;
      const py = (e.clientY - rect.top) * scaleY;

      for (const [key, poly] of drawnTileScreens) {
        if (pointInPolygon(px, py, poly)) {
          visitedTiles.delete(key);
          drawnTileScreens.delete(key);
          saveVisited();
          api.log('removed tile (world):', key);
          return;
        }
      }

      const base = api.getAbsoluteBase(client);
      if (!base) return;
      const cam = api.getCam(client);
      const gameCanvas = api.getGameCanvas();
      const target = findTileAtScreenPoint(client, base, cam, gameCanvas, px, py);
      if (!target) return;

      const key = target.x + ',' + target.z;
      const stats = getTileStats(client);
      if (stats.available <= 0) {
        api.warn('cannot manually unlock tile (world):', key, '- no available unlocks.');
        return;
      }
      visitedTiles.set(key, { x: target.x, z: target.z });
      saveVisited();
      api.log('manually unlocked tile (world):', key, '- total unlocked:', visitedTiles.size);
    }

    function drawFrame(client, stats) {
      const gameCanvas = api.getGameCanvas();
      overlay.ctx.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height);
      drawnTileScreens.clear();
      if (api.isModalOpen() || isAtLoginScreen()) return;

      const base = api.getAbsoluteBase(client);
      if (!base) return;
      const cam = api.getCam(client);

      const baseColor = stats.available > 0 ? settings.colorAvailable : settings.colorRestricted;
      const color = hexToRgba(baseColor, settings.opacity);

      const gameView = api.getGameViewRect(gameCanvas);
      overlay.ctx.save();
      overlay.ctx.beginPath();
      overlay.ctx.rect(gameView.x, gameView.y, gameView.w, gameView.h);
      overlay.ctx.clip();

      const localTile = api.getPlayerLocalTile(client);
      const playerAbs = api.localToAbsolute(localTile.x, localTile.z, base);
      const maxDistSq = RENDER_DISTANCE_TILES * RENDER_DISTANCE_TILES;

      for (const t of visitedTiles.values()) {
        const dx = t.x - playerAbs.x;
        const dz = t.z - playerAbs.z;
        if (dx * dx + dz * dz > maxDistSq) continue;
        const local = api.absoluteToLocal(t.x, t.z, base);
        const corners = getCornerHeights(client, local.x, local.z);
        if (!corners) continue;
        const worldX = local.x * TILE_SIZE;
        const worldZ = local.z * TILE_SIZE;
        const points = drawTileOutline(gameCanvas, worldX, worldZ, corners, cam, color);
        if (points) drawnTileScreens.set(t.x + ',' + t.z, points);
      }
      overlay.ctx.restore();
    }

    // ---- POLL ----
    function poll() {
      const client = api.getClient();
      if (!client || isAtLoginScreen()) return;
      const base = api.getAbsoluteBase(client);
      if (!base) return;

      const localTile = api.getPlayerLocalTile(client);
      const abs = api.localToAbsolute(localTile.x, localTile.z, base);
      const key = abs.x + ',' + abs.z;

      if (visitedTiles.has(key)) {
        pendingTile = null;
        pendingStableCount = 0;
        return;
      }
      if (settings.manualUnlocks) {
        pendingTile = null;
        pendingStableCount = 0;
        return;
      }

      // Diagonal-walk fix: a candidate tile only commits once it's shown up
      // on TILE_CONFIRM_POLLS consecutive polls, so a transient corner tile
      // crossed mid-diagonal-move never gets marked. See reference script
      // for the full explanation — this logic is unchanged.
      if (pendingTile && pendingTile.key === key) {
        pendingStableCount++;
      } else {
        pendingTile = { key, x: abs.x, z: abs.z };
        pendingStableCount = 1;
      }
      if (pendingStableCount < TILE_CONFIRM_POLLS) return;

      const stats = getTileStats(client);
      if (stats.available > 0) {
        visitedTiles.set(key, { x: abs.x, z: abs.z });
        saveVisited();
        api.log('unlocked new tile (world):', abs.x, abs.z, '- total unlocked:', visitedTiles.size);
      } else if (!warnedTiles.has(key)) {
        warnedTiles.add(key);
        api.warn('stepped onto a NEW tile with 0 available unlocks (world):', abs.x, abs.z);
      }
    }

    // ---- WIRE UP ----
    let contextMenuGuardAttached = false;
    api.onTick((client) => {
      const gameCanvas = api.getGameCanvas();
      if (!gameCanvas) return;
      if (!overlay.sync()) return;

      if (!contextMenuGuardAttached) {
        gameCanvas.addEventListener('contextmenu', handleTileShiftRightClick, true);
        contextMenuGuardAttached = true;
      }

      ensureHud();
      // Recomputed every tick (not just on settings save) so the HUD keeps
      // scaling live as the window/game canvas is resized.
      syncHudWidth();
      ensureLogo();

      if (client) {
        const stats = getTileStats(client);
        drawFrame(client, stats);
        updateHud(stats);
        updateLogoVisibility();
      } else if (hudEl) {
        hudEl.style.display = 'none';
      }
    }, REDRAW_MS);

    api.onTick(() => poll(), POLL_MS);

    // Stash the context-menu handler + canvas ref so destroy() can remove it.
    this.__contextMenuHandler = handleTileShiftRightClick;
  },

  destroy(api) {
    // api.__cleanup() (called by the loader right after this returns)
    // already unsubscribes every api.onTick(), removes the overlay canvas,
    // removes api.container (which the HUD and injected <style> tags were
    // appended into), and unregisters our settings definition from the
    // loader's shared settings panel. One thing lives OUTSIDE api.container
    // on purpose — the login-screen wordmark is position:absolute against
    // the game canvas's own parent (so its offsetLeft/offsetTop math lines
    // up with the canvas), not against api.container — so it needs explicit
    // removal here, along with the contextmenu listener on the raw canvas.
    const logoEl = document.getElementById('tileman-logo');
    if (logoEl) logoEl.remove();

    const gameCanvas = api.getGameCanvas();
    if (gameCanvas && this.__contextMenuHandler) {
      gameCanvas.removeEventListener('contextmenu', this.__contextMenuHandler, true);
    }
    api.log('tileman destroyed, cleanup complete.');
  },
};
