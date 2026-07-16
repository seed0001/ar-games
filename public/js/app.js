import { ShooterGame, arSupported } from './xr-shooter.js';

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
    id: 'soon1', icon: '🧪', name: 'In the lab…', glow: 'rgba(124,92,255,0.15)',
    desc: 'More full-tracking AR experiences are being outlined. This slot is reserved.',
    disabled: true,
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
