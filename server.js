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
`);

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

app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`camfun running on http://localhost:${PORT}`);
});
