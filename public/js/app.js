import { tlog, flush } from './telemetry.js';
import { ShooterGame, arSupported } from './xr-shooter.js';
import { GauntletGame } from './xr-gauntlet.js';
import { MiniGolfGame } from './xr-minigolf.js';
import { openLobby } from './lobby.js';
import { UnoGame } from './xr-uno.js';
import { WorldScanner } from './world-scanner.js';
import { WorldExplorer } from './world-explorer.js';

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function show(screenId) {
  for (const id of ['auth', 'hub', 'stage']) $(id).classList.toggle('hidden', id !== screenId);
}

// ---------- experiences ----------
const MODES = [
  {
    id: 'shooter', icon: '⚔️', name: 'Cover Fire', glow: 'rgba(0,229,255,0.25)',
    desc: 'A hard-light arena deploys onto your real floor. Enemies track your ACTUAL body — physically walk behind cover to block their shots, pop out and fire back. Real movement, real cover. Leaderboard.',
    leaderboard: true,
    launch: launchShooter,
  },
  {
    id: 'gauntlet', icon: '🏃', name: 'Gauntlet Run', glow: 'rgba(255,170,60,0.22)',
    desc: 'A 100-foot hard-light obstacle course deploys down your driveway. Physically run it — duck behind barricades, clear each zone of drones to unlock the gate, and race the clock to the finish line. Leaderboard.',
    leaderboard: true,
    launch: launchGauntlet,
  },
  {
    id: 'minigolf', icon: '⛳', name: 'Mini-Golf', glow: 'rgba(88,255,150,0.22)',
    desc: 'An 18-hole course deploys onto your real tabletop, one hole at a time. Drag back and release to putt — ramps, water, sand, and windmills included. Leaderboard.',
    leaderboard: true,
    launch: launchMiniGolf,
  },
  {
    id: 'uno', icon: '🃏', name: 'Uno', glow: 'rgba(138,92,255,0.25)',
    desc: 'Play Uno with a friend, each of you on your own phone — a table deploys onto your own real tabletop while the game itself stays perfectly in sync between you. Leaderboard tracks total wins.',
    leaderboard: true,
    launch: launchUnoLobby,
  },
  {
    id: 'scanner', icon: '🌍', name: 'World Scanner', glow: 'rgba(0,255,170,0.22)',
    desc: 'Walk your yard, your street, your house — the phone paints everything you sweep it across into a 3D map, trees and terrain and all. Save it to your account and share it.',
    launch: launchScanner,
  },
  {
    id: 'worlds', icon: '🗺️', name: 'Explore Worlds', glow: 'rgba(124,92,255,0.25)',
    desc: 'Wander through worlds other players scanned — fly through them on any device, or shrink one onto your own floor in AR like a hologram diorama.',
    launch: () => showWorldsGallery(),
  },
];

// ---------- auth ----------
let currentUser = null;
let registering = false;

function setAuthMode(reg) {
  registering = reg;
  $('auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('auth-toggle-text').textContent = reg ? 'Already have an account?' : 'New here?';
  $('auth-toggle-link').textContent = reg ? 'Sign in' : 'Create an account';
  $('auth-password').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-error').classList.add('hidden');
}

$('auth-toggle-link').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(!registering);
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  const errEl = $('auth-error');
  errEl.classList.add('hidden');
  $('auth-submit').disabled = true;
  try {
    const data = await api(registering ? '/api/register' : '/api/login', {
      method: 'POST',
      body: { username, password },
    });
    currentUser = data.user;
    enterHub();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  show('auth');
});

// ---------- hub ----------
function enterHub() {
  $('hub-username').textContent = currentUser.username;
  show('hub');
}

function buildHub() {
  const grid = $('mode-grid');
  grid.innerHTML = '';
  for (const m of MODES) {
    const card = document.createElement('div');
    card.className = 'mode-card' + (m.disabled ? ' disabled' : '');
    card.style.setProperty('--glow', m.glow);
    card.innerHTML = `
      <div class="mode-icon">${m.icon}</div>
      <div class="mode-name">${m.name}</div>
      <div class="mode-desc">${m.desc}</div>
    `;
    if (m.leaderboard) {
      const badge = document.createElement('button');
      badge.className = 'mode-badge';
      badge.textContent = '🏆';
      badge.title = 'Leaderboard';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        showLeaderboard(m.id, m.name);
      });
      card.appendChild(badge);
    }
    if (!m.disabled) card.addEventListener('click', () => m.launch(m));
    grid.appendChild(card);
  }
}

async function showLeaderboard(modeId, modeName) {
  $('modal-title').textContent = `🏆 ${modeName}`;
  $('modal-body').innerHTML = '<div class="lb-empty">Loading…</div>';
  $('modal').classList.remove('hidden');
  try {
    const { top } = await api(`/api/leaderboard?mode=${modeId}`);
    if (!top.length) {
      $('modal-body').innerHTML = '<div class="lb-empty">No scores yet — be the first!</div>';
      return;
    }
    $('modal-body').innerHTML = top.map((r, i) => `
      <div class="lb-row">
        <span class="rank">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
        <span class="name">${escapeHtml(r.username)}</span>
        <span class="pts">${r.best.toLocaleString()}</span>
      </div>
    `).join('');
  } catch (err) {
    $('modal-body').innerHTML = `<div class="lb-empty">${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// human-readable byte size (1 KB = 1024 B)
function fmtBytes(b) {
  if (!b || b < 0) return '0 KB';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

$('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) $('modal').classList.add('hidden');
});

// ---------- shooter launch ----------
let game = null;

async function launchShooter(modeDef) {
  const xr = await arSupported();
  show('stage');
  $('hud').innerHTML = '';

  $('intro-icon').textContent = modeDef.icon;
  $('intro-title').textContent = modeDef.name;
  $('intro-desc').textContent = xr
    ? 'Find some open space. Aim at your floor and tap to deploy the arena, then USE YOUR BODY — step behind cover to block enemy fire, lean out to shoot back.'
    : 'No AR on this device — launching the desktop simulator so you can try the gameplay. The real experience runs in Chrome on Android.';
  $('intro-perms').textContent = xr ? 'uses AR camera + motion tracking' : 'desktop simulator (WASD + mouse)';
  $('intro').classList.remove('hidden');

  const startBtn = $('intro-start');
  const freshBtn = startBtn.cloneNode(true);
  freshBtn.textContent = xr ? 'Enter AR' : 'Launch simulator';
  startBtn.replaceWith(freshBtn);

  freshBtn.addEventListener('click', async () => {
    freshBtn.disabled = true;
    try {
      game = new ShooterGame({
        container: $('gl-container'),
        hud: $('hud'),
        xr,
        onExit: () => { game = null; show('hub'); },
      });
      await game.start();
      window.__game = game; // debug handle
      $('intro').classList.add('hidden');
    } catch (err) {
      console.error(err);
      toast('Could not start AR: ' + err.message, 4500);
      game = null;
      show('hub');
    } finally {
      freshBtn.disabled = false;
    }
  }, { once: true });
}

// ---------- gauntlet launch ----------
async function launchGauntlet(modeDef) {
  const xr = await arSupported();
  show('stage');
  $('hud').innerHTML = '';

  $('intro-icon').textContent = modeDef.icon;
  $('intro-title').textContent = modeDef.name;
  $('intro-desc').textContent = xr
    ? 'You need a LONG clear path — a driveway is perfect. Stand at the start, aim down it, and tap to lay a 100-foot course. Then physically walk it: use the barricades as cover, clear each zone of drones to unlock the gate, and race to the finish.'
    : 'No AR on this device — launching the desktop simulator so you can try the course. The real experience runs in Chrome on Android.';
  $('intro-perms').textContent = xr
    ? 'uses AR camera + motion tracking · needs ~100 ft of clear space · watch where you walk!'
    : 'desktop simulator (WASD + mouse)';
  $('intro').classList.remove('hidden');

  const startBtn = $('intro-start');
  const freshBtn = startBtn.cloneNode(true);
  freshBtn.textContent = xr ? 'Enter AR' : 'Launch simulator';
  startBtn.replaceWith(freshBtn);

  freshBtn.addEventListener('click', async () => {
    freshBtn.disabled = true;
    try {
      game = new GauntletGame({
        container: $('gl-container'),
        hud: $('hud'),
        xr,
        onExit: () => { game = null; show('hub'); },
      });
      await game.start();
      window.__game = game; // debug handle
      $('intro').classList.add('hidden');
    } catch (err) {
      console.error(err);
      toast('Could not start AR: ' + err.message, 4500);
      game = null;
      show('hub');
    } finally {
      freshBtn.disabled = false;
    }
  }, { once: true });
}

// ---------- mini-golf launch ----------
async function launchMiniGolf(modeDef) {
  const xr = await arSupported();
  show('stage');
  $('hud').innerHTML = '';

  $('intro-icon').textContent = modeDef.icon;
  $('intro-title').textContent = modeDef.name;
  $('intro-desc').textContent = xr
    ? 'Find a real tabletop. Aim at it and tap to place the course, then drag back on the ball and release to putt — same feel as a slingshot. The course stays put as you play all 18 holes.'
    : 'No AR on this device — launching the desktop version so you can try the course. The real experience runs in Chrome on Android.';
  $('intro-perms').textContent = xr ? 'uses AR camera + motion tracking' : 'desktop mode (mouse drag + scroll)';
  $('intro').classList.remove('hidden');

  const startBtn = $('intro-start');
  const freshBtn = startBtn.cloneNode(true);
  freshBtn.textContent = xr ? 'Enter AR' : 'Launch course';
  startBtn.replaceWith(freshBtn);

  freshBtn.addEventListener('click', async () => {
    freshBtn.disabled = true;
    try {
      game = new MiniGolfGame({
        container: $('gl-container'),
        hud: $('hud'),
        xr,
        onExit: () => { game = null; show('hub'); },
      });
      await game.start();
      window.__game = game; // debug handle
      $('intro').classList.add('hidden');
    } catch (err) {
      console.error(err);
      toast('Could not start AR: ' + err.message, 4500);
      game = null;
      show('hub');
    } finally {
      freshBtn.disabled = false;
    }
  }, { once: true });
}

// ---------- uno launch ----------
async function launchUnoLobby(modeDef) {
  try {
    await openLobby({
      gameType: 'uno',
      gameLabel: modeDef.name,
      onMatched: async ({ roomId, playerId, seat, rt }) => {
        const xr = await arSupported();
        show('stage');
        $('hud').innerHTML = '';
        $('intro').classList.add('hidden');
        try {
          game = new UnoGame({
            container: $('gl-container'),
            hud: $('hud'),
            xr,
            room: { roomId, playerId, seat, rt },
            onExit: () => { game = null; show('hub'); },
          });
          await game.start();
          window.__game = game; // debug handle
        } catch (err) {
          console.error(err);
          toast('Could not start AR: ' + err.message, 4500);
          game = null;
          show('hub');
        }
      },
    });
  } catch (err) {
    console.error(err);
    toast('Could not connect: ' + err.message, 4500);
  }
}

// ---------- world scanner launch ----------
async function launchScanner(modeDef) {
  const xr = await arSupported();
  show('stage');
  $('hud').innerHTML = '';

  $('intro-icon').textContent = modeDef.icon;
  $('intro-title').textContent = modeDef.name;
  $('intro-desc').textContent = xr
    ? 'Walk slowly and sweep your phone across everything — ground, trees, walls. The 3D map paints in live as you move. Get close to things (the depth camera reaches about 5 metres).'
    : 'No AR on this device — generating a demo world instead so you can try the save + explore pipeline. Real scanning runs in Chrome on Android.';
  $('intro-perms').textContent = xr
    ? 'uses AR camera, depth + motion tracking · points are processed on your phone'
    : 'demo generator (no camera needed)';
  $('intro').classList.remove('hidden');

  const startBtn = $('intro-start');
  const freshBtn = startBtn.cloneNode(true);
  freshBtn.textContent = xr ? 'Start scanning' : 'Generate demo world';
  startBtn.replaceWith(freshBtn);

  freshBtn.addEventListener('click', async () => {
    freshBtn.disabled = true;
    tlog('scanner-launch', { xr });
    try {
      game = new WorldScanner({
        container: $('gl-container'),
        hud: $('hud'),
        xr,
        onExit: () => { game = null; show('hub'); },
        onSaved: ({ name }) => toast(`🌍 “${name}” saved — find it in Explore Worlds`),
      });
      await game.start();
      window.__game = game;
      $('intro').classList.add('hidden');
    } catch (err) {
      console.error(err);
      tlog('scanner-start-failed', { msg: String(err.message).slice(0, 200) });
      flush();
      toast('Could not start the scanner: ' + err.message, 5000);
      game = null;
      show('hub');
    } finally {
      freshBtn.disabled = false;
    }
  }, { once: true });
}

// ---------- worlds gallery + explorer ----------
async function showWorldsGallery() {
  $('modal-title').textContent = '🗺️ Worlds';
  $('modal-body').innerHTML = '<div class="lb-empty">Loading…</div>';
  $('modal').classList.remove('hidden');
  try {
    const { worlds } = await api('/api/worlds');
    if (!worlds.length) {
      $('modal-body').innerHTML = '<div class="lb-empty">No worlds yet — be the first to scan one!</div>';
      return;
    }
    $('modal-body').innerHTML = worlds.map((w) => `
      <div class="world-row" data-id="${w.id}">
        <div class="world-info">
          <span class="world-name">${escapeHtml(w.name)}</span>
          <span class="world-meta">by ${escapeHtml(w.username)} · ${(w.points / 1000).toFixed(0)}k pts · ${fmtBytes(w.size)} · ${w.created.slice(0, 10)}</span>
        </div>
        ${w.mine ? `<button class="world-del" data-del="${w.id}" title="Delete">🗑</button>` : ''}
      </div>
    `).join('');

    for (const row of $('modal-body').querySelectorAll('.world-row')) {
      row.addEventListener('click', () => {
        const w = worlds.find((x) => x.id === Number(row.dataset.id));
        $('modal').classList.add('hidden');
        launchExplorer(w);
      });
    }
    for (const btn of $('modal-body').querySelectorAll('.world-del')) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this world for everyone?')) return;
        try {
          await api(`/api/worlds/${btn.dataset.del}`, { method: 'DELETE' });
          showWorldsGallery();
        } catch (err) { toast(err.message); }
      });
    }
  } catch (err) {
    $('modal-body').innerHTML = `<div class="lb-empty">${escapeHtml(err.message)}</div>`;
  }
}

async function launchExplorer(world) {
  const xr = await arSupported();
  show('stage');
  $('intro').classList.add('hidden');
  $('hud').innerHTML = '';
  try {
    game = new WorldExplorer({
      container: $('gl-container'),
      hud: $('hud'),
      world,
      xr,
      onExit: () => { game = null; show('hub'); },
    });
    await game.start();
    window.__game = game;
  } catch (err) {
    console.error(err);
    toast('Could not open world: ' + err.message, 5000);
    game = null;
    show('hub');
  }
}

// scores + leaderboard events from the game
window.addEventListener('camfun:score', async (e) => {
  const { mode, score } = e.detail;
  try {
    await api('/api/scores', { method: 'POST', body: { mode, score } });
  } catch (err) {
    toast('Score not saved: ' + err.message);
  }
});

window.addEventListener('camfun:showleaderboard', (e) => {
  const m = MODES.find((x) => x.id === e.detail.mode);
  if (m) showLeaderboard(m.id, m.name);
});

// ---------- boot ----------
buildHub();
setAuthMode(false);
(async () => {
  try {
    const { user } = await api('/api/me');
    if (user) {
      currentUser = user;
      enterHub();
      return;
    }
  } catch (e) { /* fall through to auth */ }
  show('auth');
})();
