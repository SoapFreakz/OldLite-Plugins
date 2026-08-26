// OldLite native plugin — Community Hub
//
// Discord + website shortcuts, plus a vote panel mirroring
// https://www.oldrune.com/vote — one box per vote site, username entry,
// and a 12h cooldown timer.
//
// Vote-site links, names, descriptions and point values are pulled from
// the live oldrune.com/vote page (as of authoring). If the site adds,
// removes, or reorders vote sites, update the SITES array below to match.
//
// Cooldown logic: clicking a site's "Vote Now" opens that site in the
// system browser (window.open) and marks the box visited (green check,
// top-right). Once all 4 boxes have been visited — in any order, across
// any number of separate hub sessions — we stamp `lastVoteAt = Date.now()`
// and immediately clear all 4 checks, per spec ("checkmarks should clear
// again once the 4th has been opened"). Reopening the hub any time after
// that recomputes the remaining cooldown from the stored timestamp, so
// the countdown survives reloads/restarts.
//
// State: two small keys in api.storage — `username` (string) and
// `voteState` ({ visited: {siteId: true}, lastVoteAt: number|null }).
// Nothing here needs game-tick access, so there's no api.onTick use —
// the countdown is wall-clock (setInterval), self-clearing once its
// panel is unmounted (see updateTimerOnly's isConnected guard — this
// framework has no explicit unmount hook for registerSettings' custom
// render, so that's the standard idiom for cleaning these up).

const DISCORD_URL = 'https://discord.gg/52xw9H3YqT';
const WEBSITE_URL = 'https://www.oldrune.com';
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

const USERNAME_KEY = 'username';
const VOTE_STATE_KEY = 'voteState';

const SITES = [
  {
    id: 'rspslist',
    name: 'RSPS List',
    desc: 'Vote for Oldrune on RSPS.org and earn an in-game vote point.',
    points: '+2 Vote Points',
    url: 'https://rsps.org/server/oldrune',
  },
  {
    id: 'runelocus',
    name: 'RuneLocus',
    desc: 'Vote for Oldrune on RuneLocus and earn vote points.',
    points: '+2 Vote Points',
    url: 'https://www.rulocus.com/top-rsps-list/oldrune/vote/',
  },
  {
    id: 'runeserver',
    name: 'Rune-Server',
    desc: 'Vote for Oldrune on Rune-Server and earn vote points.',
    points: '+2 Vote Points',
    url: 'https://rune-server.org/toplist/oldrune-2004-inspired-runescape-server.11713/view',
  },
  {
    id: 'moparscape',
    name: 'MoparScape',
    desc: 'Vote for Oldrune on MoparScape and earn vote points.',
    points: '+2 Vote Points',
    url: 'https://mopar-scape.com/vote.php?id=141',
  },
];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${h}h ${pad(m)}m ${pad(s)}s`;
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

  function timerHtml(state) {
    const remaining = state.lastVoteAt ? state.lastVoteAt + COOLDOWN_MS - Date.now() : 0;
    if (!state.lastVoteAt || remaining <= 0) {
      return `<div class="ch-timer ch-timer-ready">&#10003; You're clear to vote on all 4 sites</div>`;
    }
    return `<div class="ch-timer ch-timer-waiting">&#8987; Next vote in ${formatDuration(remaining)}</div>`;
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

    function handleVote(siteId) {
      const usernameInput = document.getElementById('ch-username');
      const username = (usernameInput && usernameInput.value || '').trim();
      const warn = document.getElementById('ch-username-warn');

      if (!username) {
        if (warn) warn.classList.add('show');
        if (usernameInput) usernameInput.focus();
        return;
      }
      if (warn) warn.classList.remove('show');
      saveUsername(username);

      const site = SITES.find((s) => s.id === siteId);
      if (!site) return;
      window.open(site.url, '_blank', 'noopener');

      const state = loadVoteState();
      state.visited[siteId] = true;
      const allVisited = SITES.every((s) => state.visited[s.id]);
      if (allVisited) {
        state.lastVoteAt = Date.now();
        state.visited = {};
      }
      saveVoteState(state);
      paint();
    }

    function paint() {
      const state = loadVoteState();
      const username = loadUsername();

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

          <div id="ch-timer-slot">${timerHtml(state)}</div>

          <div class="ch-vote-grid">
            ${SITES.map((site) => voteBoxHtml(site, state)).join('')}
          </div>
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
    .ch-timer-waiting { background: rgba(216,90,48,0.12); color: var(--ol-accent); border: 1px solid rgba(216,90,48,0.35); }

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
  `;
  api.container.appendChild(style);

  api.registerSettings({
    title: 'Community Hub',
    render: renderSettings,
  });
}

function destroy() {
  // api.__cleanup() removes `container` (which the injected <style> lives
  // in) wholesale. The only other live thing is the 1s countdown
  // interval, and updateTimerOnly's isConnected guard clears that itself
  // the tick after its panel gets unmounted — nothing to do here.
}

export default {
  id: 'community-hub',
  name: 'Community Hub',
  description: 'Discord, website, and vote-site shortcuts with a 12h cooldown tracker.',
  version: '1.0.0',
  author: 'goku',
  native: true,
  icon: 'Community.png',
  init,
  destroy,
};
