// OldLite native plugin — Community Hub
//
// Discord + website shortcuts, plus a vote panel mirroring
// https://www.oldrune.com/vote — one box per vote site, username entry,
// an in-client voting view, and a 12h cooldown timer.
//
// Vote-site URLs below are the CONFIRMED live vote endpoints (verified by
// inspecting each site directly, not the oldrune.com listing links):
//   - RSPS List / MoparScape take the username in the URL itself.
//   - RuneLocus and Rune-Server take no player-identifying data at all —
//     RuneLocus is typed on their own page, Rune-Server's vote is a
//     XenForo CSRF/session request behind a Cloudflare Turnstile check.
//   - Rune-Server's URL is deliberately the `/vote` page, not the `/view`
//     listing page oldrune.com's own nav links to.
//
// Two ways to vote, sharing one underlying state:
//   1. External-link grid (bottom of panel) — click "Vote Now", opens the
//      site in the system browser, marks that box visited.
//   2. "Vote In Client" — fills the client view with a 2x2 grid of real
//      <webview> elements loading the actual vote pages in-app (main.js's
//      will-attach-webview handler sandboxes these regardless of the
//      outer game window's relaxed settings). A site is marked visited
//      once its webview finishes loading the vote page — same "opened,
//      not verified" standard the external-link flow already uses, kept
//      deliberately simple/consistent rather than trying to sniff each
//      site's own success response (fragile, would break silently per-site).
//
// Whichever path a site is marked visited through, it's the same
// `voteState.visited` map — once all 4 are true (any order, either flow,
// across any number of sessions) we stamp `lastVoteAt = Date.now()` and
// clear `visited` back to {}. That timestamp is the ONLY thing the
// cooldown timer ever reads, so the countdown is wall-clock and survives
// reloads/restarts and drives both flows' displays identically.
//
// A separate always-on watcher (started from init(), not tied to the
// settings panel's mount lifecycle) checks once a second whether the
// cooldown has just expired and, if "remind me" is checked, drops a
// small dismissible toast into the page — this works even if the
// Community Hub panel itself isn't open, since it's wired via api.onTick
// rather than the panel's own render-scoped interval.
//
// State — all via api.storage (never localStorage directly):
//   `username`         (string)
//   `voteState`        ({ visited: {siteId: true}, lastVoteAt: number|null })
//   `remindWhenReady`  (bool, default true)
//   `readyNotifShownFor` (number|null — the lastVoteAt cycle already toasted)

const DISCORD_URL = 'https://discord.gg/52xw9H3YqT';
const WEBSITE_URL = 'https://www.oldrune.com';
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

const USERNAME_KEY = 'username';
const VOTE_STATE_KEY = 'voteState';
const REMIND_KEY = 'remindWhenReady';
const SHOWN_FOR_KEY = 'readyNotifShownFor';

const SITES = [
  {
    id: 'rspslist',
    name: 'RSPS List',
    desc: 'Vote for Oldrune on RSPS.org and earn an in-game vote point.',
    points: '+2 Vote Points',
    // Username goes in the URL itself.
    buildUrl: (username) => `https://rsps.org/server/oldrune?callback=${encodeURIComponent(username)}`,
  },
  {
    id: 'runelocus',
    name: 'RuneLocus',
    desc: 'Vote for Oldrune on RuneLocus and earn vote points.',
    points: '+2 Vote Points',
    // No username param — typed on their own page.
    buildUrl: () => 'https://www.rulocus.com/top-rsps-list/oldrune/vote/',
  },
  {
    id: 'runeserver',
    name: 'Rune-Server',
    desc: 'Vote for Oldrune on Rune-Server and earn vote points.',
    points: '+2 Vote Points',
    // The actual /vote page (not the /view listing page) — no username
    // param, this is a pure CSRF/session request behind Turnstile.
    buildUrl: () => 'https://rune-server.org/toplist/oldrune-2004-inspired-runescape-server.11713/vote',
  },
  {
    id: 'moparscape',
    name: 'MoparScape',
    desc: 'Vote for Oldrune on MoparScape and earn vote points.',
    points: '+2 Vote Points',
    // Username goes in the URL itself.
    buildUrl: (username) => `https://mopar-scape.com/vote.php?id=141&userid=${encodeURIComponent(username)}`,
  },
];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// HOURS:MINUTES:SECONDS, e.g. "11:47:32" — hours unpadded, minutes/seconds
// zero-padded, per spec.
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}`;
}

function init(api) {
  function loadUsername() {
    return api.storage.get(USERNAME_KEY, '');
  }
  function saveUsername(v) {
    api.storage.set(USERNAME_KEY, v);
  }
  function loadVoteState() {
    const s = api.storage.get(VOTE_STATE_KEY, { visited: {}, lastVoteAt: null });
    if (!s.visited) s.visited = {};
    return s;
  }
  function saveVoteState(s) {
    api.storage.set(VOTE_STATE_KEY, s);
  }

  // Shared by both the external-link flow and the in-client webview flow —
  // whichever marks a site "visited" first, this is the one place that
  // decides when all 4 are done and stamps/clears the cooldown. No-ops if
  // the site is already marked for the current cycle.
  function markVisited(siteId) {
    const state = loadVoteState();
    if (state.visited[siteId]) return state;
    state.visited[siteId] = true;
    const allVisited = SITES.every((s) => state.visited[s.id]);
    if (allVisited) {
      state.lastVoteAt = Date.now();
      state.visited = {};
    }
    saveVoteState(state);
    return state;
  }

  function timerHtml(state) {
    const remaining = state.lastVoteAt ? state.lastVoteAt + COOLDOWN_MS - Date.now() : 0;
    if (!state.lastVoteAt || remaining <= 0) {
      return `<div class="ch-timer ch-timer-ready">&#10003; You're clear to vote on all 4 sites</div>`;
    }
    return `<div class="ch-timer ch-timer-waiting">Next vote in ${formatCountdown(remaining)}</div>`;
  }

  function voteBoxHtml(site, state) {
    const visited = !!state.visited[site.id];
    return `
      <div class="ch-vote-box">
        ${visited ? '<span class="ch-check" title="Opened">&#10003;</span>' : ''}
        <div class="ch-vote-name">${site.name}</div>
        <div class="ch-vote-desc">${site.desc}</div>
        <div class="ch-vote-meta">${site.points} &middot; 12h cooldown</div>
        <span class="ch-vote-btn" data-site="${site.id}">Vote Now &#8594;</span>
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // ALWAYS-ON READY-NOTIFICATION WATCHER
  // Lives for the plugin's whole lifetime (subscribed here in init, not
  // inside renderSettings), so it fires even if the Community Hub panel
  // isn't open. api.onTick's unsubscribe is collected by buildApiFor and
  // called automatically from api.__cleanup() when the plugin unloads/
  // reloads, so there's nothing extra to tear down in destroy().
  // -----------------------------------------------------------------------
  function showReadyToast() {
    if (document.getElementById('ch-ready-toast')) return; // already up
    const toast = document.createElement('div');
    toast.id = 'ch-ready-toast';
    toast.className = 'ch-ready-toast';
    toast.innerHTML = `
      <span>You can vote again!</span>
      <span class="ch-ready-toast-close" title="Dismiss">&times;</span>
    `;
    api.container.appendChild(toast);
    toast.querySelector('.ch-ready-toast-close').addEventListener('click', () => toast.remove());
  }

  function checkReadyNotification() {
    const state = loadVoteState();
    if (!state.lastVoteAt) return; // never voted yet — nothing to remind about
    const remaining = state.lastVoteAt + COOLDOWN_MS - Date.now();
    if (remaining > 0) return; // still on cooldown
    if (!api.storage.get(REMIND_KEY, true)) return;
    const shownFor = api.storage.get(SHOWN_FOR_KEY, null);
    if (shownFor === state.lastVoteAt) return; // already toasted this cycle
    api.storage.set(SHOWN_FOR_KEY, state.lastVoteAt);
    showReadyToast();
  }

  api.onTick(checkReadyNotification, 1000);

  function renderSettings(container, exit) {
    let tickHandle = null;

    function stopTick() {
      if (tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
    }

    // Runs every second while the panel is mounted. Only touches the
    // timer slot, never the username input, so it can't steal focus or
    // clobber an in-progress keystroke.
    function updateTimerOnly() {
      const slot = document.getElementById('ch-timer-slot');
      if (!slot || !slot.isConnected) {
        stopTick();
        return;
      }
      slot.innerHTML = timerHtml(loadVoteState());
    }

    function requireUsername() {
      const usernameInput = document.getElementById('ch-username');
      const username = (usernameInput && usernameInput.value || '').trim();
      const warn = document.getElementById('ch-username-warn');
      if (!username) {
        if (warn) warn.classList.add('show');
        if (usernameInput) usernameInput.focus();
        return null;
      }
      if (warn) warn.classList.remove('show');
      saveUsername(username);
      return username;
    }

    function handleVote(siteId) {
      const username = requireUsername();
      if (!username) return;

      const site = SITES.find((s) => s.id === siteId);
      if (!site) return;
      window.open(site.buildUrl(username), '_blank', 'noopener');

      markVisited(siteId);
      paint();
    }

    // ---- In-client voting overlay -----------------------------------
    // Full-viewport fixed overlay layered above the whole #oldlite-panel
    // chrome (which is itself position:fixed at z-index 100000) — there's
    // no existing "takeover the screen" popout system elsewhere in this
    // codebase to match, so this is the straightforward fallback: a
    // fixed overlay built fresh into api.container (already a
    // document.body-level element independent of the sidebar DOM), torn
    // down on back-press.
    function openInClientView(username) {
      const overlay = document.createElement('div');
      overlay.className = 'ch-inclient-overlay';
      overlay.innerHTML = `
        <div class="ch-inclient-header">
          <span class="ch-inclient-back" id="ch-inclient-back" title="Back">&#x2190;</span>
          <span class="ch-inclient-title">Vote In Client</span>
        </div>
        <div class="ch-inclient-grid">
          ${SITES.map((site) => `
            <div class="ch-inclient-cell" data-cell="${site.id}">
              <div class="ch-inclient-cell-label">
                <span>${site.name}</span>
                <span class="ch-inclient-check" data-check="${site.id}" style="display:none;">&#10003;</span>
              </div>
              <div class="ch-inclient-webview-wrap" data-wrap="${site.id}"></div>
            </div>
          `).join('')}
        </div>
      `;
      api.container.appendChild(overlay);

      // Per-site guard against a webview's did-finish-load firing more
      // than once in this session (Cloudflare Turnstile in particular can
      // reload the main frame after the challenge resolves) — without
      // this, a single visit could re-trigger markVisited repeatedly.
      const markedThisSession = new Set();

      function refreshChecks() {
        const state = loadVoteState();
        SITES.forEach((site) => {
          const check = overlay.querySelector(`[data-check="${site.id}"]`);
          if (check) check.style.display = state.visited[site.id] ? 'inline' : 'none';
        });
      }

      // <webview> is notorious for painting solid black if it gets attached
      // before its container has a settled, non-flex-computed size — the
      // guest compositor's first frame comes in at whatever size it saw on
      // attach, and CSS alone resizing it afterward doesn't always trigger
      // a repaint. Two mitigations here: (1) each webview lives in its own
      // absolutely-positioned wrapper (`.ch-inclient-webview-wrap`, inset:0
      // inside an already-flex-sized parent) instead of being flex/grid
      // sized itself, and (2) creation is deferred one frame (rAF) past the
      // innerHTML paint so the grid has actually laid out before attach,
      // plus a synthetic window resize dispatch on dom-ready as a repaint
      // nudge — the same trick loader.js already uses elsewhere to force
      // the page to re-layout after a programmatic size change.
      requestAnimationFrame(() => {
        SITES.forEach((site) => {
          const wrap = overlay.querySelector(`[data-wrap="${site.id}"]`);
          if (!wrap) return;
          const webview = document.createElement('webview');
          webview.setAttribute('src', site.buildUrl(username));
          webview.style.width = '100%';
          webview.style.height = '100%';
          wrap.appendChild(webview);

          webview.addEventListener('dom-ready', () => {
            // Nudge the guest compositor to repaint at its real size.
            window.dispatchEvent(new Event('resize'));
            setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
          });

          webview.addEventListener('did-finish-load', () => {
            if (markedThisSession.has(site.id)) return;
            markedThisSession.add(site.id);
            markVisited(site.id);
            refreshChecks();
          });
        });
      });

      refreshChecks();

      document.getElementById('ch-inclient-back').addEventListener('click', () => {
        overlay.remove();
        paint(); // refresh timer/checks/grid in case the 4th site just completed
      });
    }

    function handleOpenInClient() {
      const username = requireUsername();
      if (!username) return;
      openInClientView(username);
    }

    function paint() {
      const state = loadVoteState();
      const username = loadUsername();
      const remindOn = api.storage.get(REMIND_KEY, true);

      container.innerHTML = `
        <div class="ol-list-header">
          <span class="ol-back-btn" id="ch-back" title="Back">&#x2190;</span>
          <span class="ol-list-title">Community Hub</span>
        </div>

        <div class="ch-top-buttons">
          <span class="ch-btn ch-btn-discord" id="ch-discord-btn">Discord</span>
          <span class="ch-btn ch-btn-website" id="ch-website-btn">Oldrune.com</span>
        </div>

        <div class="ch-vote-section">
          <div class="ch-vote-heading">Vote for Oldrune</div>
          <div class="ch-vote-sub">Vote on multiple sites to earn vote points. Use <span class="ch-code">::checkvotes</span> in-game to check your balance.</div>

          <div class="ch-username-row">
            <label for="ch-username">In-game username</label>
            <input type="text" id="ch-username" class="ch-username-input" placeholder="Enter your username" value="${escapeHtml(username)}" autocomplete="off" spellcheck="false">
          </div>
          <div class="ch-username-warn" id="ch-username-warn">You must enter your username before voting.</div>

          <span class="ch-btn ch-btn-inclient" id="ch-inclient-btn">Vote In Client</span>

          <div id="ch-timer-slot">${timerHtml(state)}</div>

          <div class="ch-vote-grid-heading">Or vote manually in your browser:</div>
          <div class="ch-vote-grid">
            ${SITES.map((site) => voteBoxHtml(site, state)).join('')}
          </div>

          <label class="ch-remind-row">
            <input type="checkbox" id="ch-remind-checkbox" ${remindOn ? 'checked' : ''}>
            <span>Remind me when I can vote again</span>
          </label>
        </div>
      `;

      document.getElementById('ch-back').addEventListener('click', () => {
        stopTick();
        exit();
      });

      document.getElementById('ch-discord-btn').addEventListener('click', () => {
        window.open(DISCORD_URL, '_blank', 'noopener');
      });
      document.getElementById('ch-website-btn').addEventListener('click', () => {
        window.open(WEBSITE_URL, '_blank', 'noopener');
      });
      document.getElementById('ch-inclient-btn').addEventListener('click', handleOpenInClient);

      const usernameInput = document.getElementById('ch-username');
      usernameInput.addEventListener('change', () => saveUsername(usernameInput.value.trim()));
      usernameInput.addEventListener('input', () => {
        if (usernameInput.value.trim()) {
          const warn = document.getElementById('ch-username-warn');
          if (warn) warn.classList.remove('show');
        }
      });

      container.querySelectorAll('.ch-vote-btn').forEach((btn) => {
        btn.addEventListener('click', () => handleVote(btn.dataset.site));
      });

      document.getElementById('ch-remind-checkbox').addEventListener('change', (e) => {
        api.storage.set(REMIND_KEY, e.target.checked);
      });
    }

    paint();
    stopTick();
    tickHandle = setInterval(updateTimerOnly, 1000);
  }

  const style = document.createElement('style');
  style.textContent = `
    .ch-top-buttons { display: flex; flex-direction: column; gap: 10px; margin: 14px 0 20px; }
    .ch-btn {
      display: flex; align-items: center; justify-content: center;
      padding: 12px 0; border-radius: 6px; font-weight: bold; font-size: 1.35vw;
      cursor: pointer; user-select: none; transition: filter 0.15s ease;
    }
    .ch-btn:hover { filter: brightness(1.1); }
    .ch-btn:active { filter: brightness(0.9); }
    .ch-btn-discord { background: #5865F2; color: #ffffff; }
    .ch-btn-website { background: var(--ol-accent); color: var(--ol-bg); }
    .ch-btn-inclient { background: var(--ol-accent); color: var(--ol-bg); margin: 10px 0 4px; }

    .ch-vote-heading { color: var(--ol-text); font-size: 1.47vw; font-weight: bold; margin-bottom: 4px; }
    .ch-vote-sub { color: var(--ol-text-tertiary); font-size: 1.2vw; line-height: 1.4; margin-bottom: 14px; }
    .ch-code { color: var(--ol-accent); font-family: inherit; }

    .ch-username-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
    .ch-username-row label { color: var(--ol-text-secondary); font-size: 1.2vw; }
    .ch-username-input {
      box-sizing: border-box; width: 100%; background: var(--ol-bg); color: var(--ol-text);
      border: 1px solid #3a3220; border-radius: 5px; padding: 8px 10px;
      font-family: inherit; font-size: 1.25vw;
    }
    .ch-username-input:focus { outline: none; border-color: var(--ol-accent); }
    .ch-username-input::placeholder { color: var(--ol-text-tertiary); }

    .ch-username-warn { display: none; color: #e05252; font-size: 1.1vw; margin: 4px 0 10px; }
    .ch-username-warn.show { display: block; }

    .ch-timer {
      margin: 10px 0 16px; padding: 10px 12px; border-radius: 6px;
      font-size: 1.2vw; text-align: center; font-weight: bold;
    }
    .ch-timer-ready { background: rgba(80,200,120,0.15); color: #5ecb84; border: 1px solid rgba(80,200,120,0.4); }
    .ch-timer-waiting { background: rgba(224,82,82,0.12); color: #e05252; border: 1px solid rgba(224,82,82,0.35); }

    .ch-vote-grid-heading { color: var(--ol-text-tertiary); font-size: 1.1vw; margin: 4px 0 10px; }
    .ch-vote-grid { display: flex; flex-direction: column; gap: 10px; }
    .ch-vote-box {
      position: relative; background: var(--ol-panel-bg); border: 1px solid #2e2818;
      border-radius: 6px; padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 4px;
    }
    .ch-vote-name { color: var(--ol-text); font-weight: bold; font-size: 1.3vw; }
    .ch-vote-desc { color: var(--ol-text-tertiary); font-size: 1.1vw; line-height: 1.35; }
    .ch-vote-meta { color: var(--ol-text-secondary); font-size: 1.05vw; }
    .ch-vote-btn {
      align-self: flex-start; margin-top: 6px; background: var(--ol-accent); color: var(--ol-bg);
      font-weight: bold; font-size: 1.1vw; padding: 6px 12px; border-radius: 5px;
      cursor: pointer; user-select: none; transition: filter 0.15s ease;
    }
    .ch-vote-btn:hover { filter: brightness(1.1); }
    .ch-vote-btn:active { filter: brightness(0.9); }

    .ch-check {
      position: absolute; top: 8px; right: 8px; width: 18px; height: 18px; border-radius: 50%;
      background: #4caf6d; color: #fff; font-size: 12px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
    }

    .ch-remind-row {
      display: flex; align-items: center; gap: 8px; margin-top: 16px;
      color: var(--ol-text-secondary); font-size: 1.15vw; cursor: pointer; user-select: none;
    }
    .ch-remind-row input[type="checkbox"] {
      width: 15px; height: 15px; accent-color: var(--ol-accent); cursor: pointer; flex-shrink: 0;
    }

    /* ---- In-client voting overlay (full-viewport, above #oldlite-panel) ---- */
    .ch-inclient-overlay {
      position: fixed; inset: 0; z-index: 100001;
      background: var(--ol-bg); display: flex; flex-direction: column;
      padding: 16px; box-sizing: border-box;
    }
    .ch-inclient-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-shrink: 0; }
    .ch-inclient-back {
      width: 2.6vw; height: 2.6vw; min-width: 34px; min-height: 34px; border-radius: 50%;
      background: var(--ol-panel-bg); border: 1px solid var(--ol-accent); color: var(--ol-accent);
      display: flex; align-items: center; justify-content: center; font-size: 1.5vw;
      cursor: pointer; user-select: none; flex-shrink: 0; transition: background 0.15s ease, color 0.15s ease;
    }
    .ch-inclient-back:hover { background: var(--ol-accent); color: var(--ol-bg); }
    .ch-inclient-title { color: var(--ol-text); font-size: 1.4vw; font-weight: bold; }
    .ch-inclient-grid {
      flex: 1; min-height: 0; display: grid;
      grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 10px;
    }
    .ch-inclient-cell {
      position: relative; border: 1px solid #2e2818; border-radius: 6px; overflow: hidden;
      background: #000; display: flex; flex-direction: column; min-height: 0;
    }
    .ch-inclient-cell-label {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 6px 10px; background: var(--ol-panel-bg); color: var(--ol-text);
      font-size: 1.05vw; font-weight: bold; flex-shrink: 0;
    }
    .ch-inclient-check { color: #4caf6d; font-size: 1.1vw; }
    /* Absolutely positioned inside an already flex-sized parent, rather
       than being flex/grid sized itself — see the comment above where
       this is created for why. */
    .ch-inclient-webview-wrap { position: relative; flex: 1; min-height: 0; }
    .ch-inclient-webview-wrap webview { position: absolute; inset: 0; width: 100%; height: 100%; }

    .ch-ready-toast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 100002; background: var(--ol-panel-bg); border: 1px solid var(--ol-accent);
      color: var(--ol-text); padding: 10px 14px; border-radius: 8px; font-size: 1.15vw;
      display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.5);
    }
    .ch-ready-toast-close {
      cursor: pointer; color: var(--ol-text-secondary); font-weight: bold;
      font-size: 1.25vw; line-height: 1;
    }
    .ch-ready-toast-close:hover { color: var(--ol-accent); }
  `;
  api.container.appendChild(style);

  api.registerSettings({
    title: 'Community Hub',
    render: renderSettings,
  });
}

function destroy() {
  // api.__cleanup() removes `container` (which the injected <style> and
  // the ready-toast, if any, live in) wholesale, and also runs every
  // unsub collected via api.onTick() — which includes the always-on
  // ready-notification watcher registered in init(). The 1s countdown
  // interval inside renderSettings' updateTimerOnly clears itself via its
  // own isConnected guard the tick after its panel is unmounted. Nothing
  // else to clean up here.
}

export default {
  id: 'community-hub',
  name: 'Community Hub',
  description: 'Discord, website, and vote-site shortcuts with in-client voting and a 12h cooldown tracker.',
  version: '1.0.1',
  author: 'goku',
  native: true,
  icon: 'Community.png',
  init,
  destroy,
};
