const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const DATA_DIR = process.env.DATA_DIR || __dirname;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'camfun.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    mode TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scores_mode ON scores(mode, score DESC);
  CREATE TABLE IF NOT EXISTS worlds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploading',
    points INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    bounds TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
fs.mkdirSync(WORLDS_DIR, { recursive: true });
const worldFile = (id) => path.join(WORLDS_DIR, `${id}.bin`);

// scrap uploads that never finished (e.g. the app was killed mid-scan)
for (const row of db.prepare(`SELECT id FROM worlds WHERE status = 'uploading'`).all()) {
  try { fs.unlinkSync(worldFile(row.id)); } catch (e) { /* no file yet */ }
  db.prepare('DELETE FROM worlds WHERE id = ?').run(row.id);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

function setAuthCookie(res, user) {
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function auth(required = true) {
  return (req, res, next) => {
    const token = req.cookies.token;
    if (token) {
      try {
        req.user = jwt.verify(token, SECRET);
      } catch (e) {
        /* invalid/expired token — treat as logged out */
      }
    }
    if (required && !req.user) return res.status(401).json({ error: 'Not signed in' });
    next();
  };
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers, or underscores' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'That username is taken' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  const user = { id: info.lastInsertRowid, username };
  setAuthCookie(res, user);
  res.json({ user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const user = { id: row.id, username: row.username };
  setAuthCookie(res, user);
  res.json({ user });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth(false), (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, username: req.user.username } : null });
});

const VALID_MODES = new Set(['shooter']);

app.post('/api/scores', auth(), (req, res) => {
  const { mode, score } = req.body || {};
  if (!VALID_MODES.has(mode)) return res.status(400).json({ error: 'Unknown mode' });
  const s = Math.floor(Number(score));
  if (!Number.isFinite(s) || s < 0 || s > 1000000) return res.status(400).json({ error: 'Invalid score' });
  db.prepare('INSERT INTO scores (user_id, mode, score) VALUES (?, ?, ?)').run(req.user.id, mode, s);
  const best = db.prepare('SELECT MAX(score) AS best FROM scores WHERE user_id = ? AND mode = ?').get(req.user.id, mode);
  res.json({ ok: true, best: best.best });
});

app.get('/api/leaderboard', auth(false), (req, res) => {
  const mode = String(req.query.mode || '');
  if (!VALID_MODES.has(mode)) return res.status(400).json({ error: 'Unknown mode' });
  const rows = db.prepare(`
    SELECT u.username, MAX(s.score) AS best
    FROM scores s JOIN users u ON u.id = s.user_id
    WHERE s.mode = ?
    GROUP BY s.user_id
    ORDER BY best DESC
    LIMIT 10
  `).all(mode);
  res.json({ top: rows });
});

/* ---------------- worlds (scanned 3D environments) ---------------- */
const RECORD_BYTES = 10;                    // one point = x,y,z int16 + rgb packed
const MAX_WORLD_BYTES = 24 * 1024 * 1024;   // ~2.4M points
const MAX_WORLDS_PER_USER = 20;

app.post('/api/worlds', auth(), (req, res) => {
  let { name } = req.body || {};
  name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (name.length < 1 || name.length > 40) {
    return res.status(400).json({ error: 'World name must be 1-40 characters' });
  }
  const count = db.prepare(`SELECT COUNT(*) AS n FROM worlds WHERE user_id = ? AND status = 'ready'`).get(req.user.id).n;
  if (count >= MAX_WORLDS_PER_USER) {
    return res.status(400).json({ error: `Limit of ${MAX_WORLDS_PER_USER} worlds — delete one first` });
  }
  // a user only ever has one in-flight upload; abandon any previous one
  for (const row of db.prepare(`SELECT id FROM worlds WHERE user_id = ? AND status = 'uploading'`).all(req.user.id)) {
    try { fs.unlinkSync(worldFile(row.id)); } catch (e) { /* no file yet */ }
    db.prepare('DELETE FROM worlds WHERE id = ?').run(row.id);
  }
  const info = db.prepare('INSERT INTO worlds (user_id, name) VALUES (?, ?)').run(req.user.id, name);
  res.json({ id: info.lastInsertRowid });
});

function ownedUploadingWorld(req, res) {
  const w = db.prepare('SELECT * FROM worlds WHERE id = ?').get(Number(req.params.id));
  if (!w || w.user_id !== req.user.id) { res.status(404).json({ error: 'World not found' }); return null; }
  if (w.status !== 'uploading') { res.status(400).json({ error: 'World already finalized' }); return null; }
  return w;
}

app.put('/api/worlds/:id/data', auth(), express.raw({ type: '*/*', limit: '6mb' }), (req, res) => {
  const w = ownedUploadingWorld(req, res);
  if (!w) return;
  const chunk = req.body;
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) return res.status(400).json({ error: 'Empty chunk' });
  if (w.size_bytes + chunk.length > MAX_WORLD_BYTES) return res.status(413).json({ error: 'World too large' });
  fs.appendFileSync(worldFile(w.id), chunk);
  db.prepare('UPDATE worlds SET size_bytes = size_bytes + ? WHERE id = ?').run(chunk.length, w.id);
  res.json({ ok: true, size: w.size_bytes + chunk.length });
});

app.post('/api/worlds/:id/finish', auth(), (req, res) => {
  const w = ownedUploadingWorld(req, res);
  if (!w) return;
  const { points, bounds } = req.body || {};
  const n = Math.floor(Number(points));
  let size = 0;
  try { size = fs.statSync(worldFile(w.id)).size; } catch (e) { /* missing */ }
  if (!Number.isFinite(n) || n < 100 || n * RECORD_BYTES !== size) {
    try { fs.unlinkSync(worldFile(w.id)); } catch (e) { /* already gone */ }
    db.prepare('DELETE FROM worlds WHERE id = ?').run(w.id);
    return res.status(400).json({ error: 'Upload incomplete or corrupt — scan discarded' });
  }
  db.prepare(`UPDATE worlds SET status = 'ready', points = ?, size_bytes = ?, bounds = ? WHERE id = ?`)
    .run(n, size, JSON.stringify(bounds || null).slice(0, 500), w.id);
  res.json({ ok: true });
});

app.get('/api/worlds', auth(false), (req, res) => {
  const rows = db.prepare(`
    SELECT w.id, w.name, w.points, w.size_bytes, w.bounds, w.created_at, u.username, w.user_id
    FROM worlds w JOIN users u ON u.id = w.user_id
    WHERE w.status = 'ready'
    ORDER BY w.id DESC LIMIT 100
  `).all();
  res.json({
    worlds: rows.map((r) => ({
      id: r.id, name: r.name, points: r.points, size: r.size_bytes,
      bounds: r.bounds ? JSON.parse(r.bounds) : null,
      created: r.created_at, username: r.username,
      mine: !!(req.user && req.user.id === r.user_id),
    })),
  });
});

app.get('/api/worlds/:id/data', (req, res) => {
  const w = db.prepare(`SELECT * FROM worlds WHERE id = ? AND status = 'ready'`).get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'World not found' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(worldFile(w.id));
});

app.delete('/api/worlds/:id', auth(), (req, res) => {
  const w = db.prepare('SELECT * FROM worlds WHERE id = ?').get(Number(req.params.id));
  if (!w || w.user_id !== req.user.id) return res.status(404).json({ error: 'World not found' });
  try { fs.unlinkSync(worldFile(w.id)); } catch (e) { /* file already gone */ }
  db.prepare('DELETE FROM worlds WHERE id = ?').run(w.id);
  res.json({ ok: true });
});

/* ---------------- client telemetry (field-debugging the AR scanner) ---------------- */
const CLIENT_LOG = path.join(DATA_DIR, 'client-log.jsonl');
const MAX_CLIENT_LOG_BYTES = 20 * 1024 * 1024;

app.post('/api/clientlog', auth(false), (req, res) => {
  try {
    const { sid, ua, events } = req.body || {};
    if (Array.isArray(events) && events.length) {
      const entry = {
        at: new Date().toISOString(),
        user: req.user ? req.user.username : null,
        sid: String(sid || '').slice(0, 16),
        ua: String(ua || '').slice(0, 300),
        events: events.slice(0, 500),
      };
      const line = JSON.stringify(entry);
      let size = 0;
      try { size = fs.statSync(CLIENT_LOG).size; } catch (e) { /* not created yet */ }
      if (size < MAX_CLIENT_LOG_BYTES) fs.appendFileSync(CLIENT_LOG, line + '\n');
      console.log('[clientlog]', line.slice(0, 4000));
    }
  } catch (e) { /* telemetry must never 500 */ }
  res.json({ ok: true });
});

app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`camfun running on http://localhost:${PORT}`);
});
