# 🌀 CAMFUN — AR Games Platform

Point your phone at the world. Weird things happen.

A web platform for camera-based AR games with accounts and leaderboards. No app install — it runs in the phone browser.

## ⚔️ Cover Fire

A WebXR cover shooter with **real positional tracking** (Android Chrome):

- Aim at your floor and tap — a hard-light arena deploys onto it in real meters
- ARCore tracks your physical body: **walk behind virtual cover and enemy line-of-sight raycasts genuinely can't reach you**
- Drones strafe, telegraph with an aiming laser, and fire hitscan shots your cover blocks
- Crosshair shooting with a heat/overheat mechanic, escalating waves, combo-free pure-skill scoring
- Global leaderboard per account

No WebXR available (desktop, iPhone)? It falls back to a pointer-lock + WASD simulator with identical game logic.

## Run locally

```bash
npm install
npm start        # http://localhost:3000
```

WebXR AR requires HTTPS — test the real thing on a deployed URL or an HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).

## Deploy on Railway

1. **New Project → Deploy from GitHub repo**. Railway auto-detects Node and runs `npm start`.
2. Set environment variables:
   - `JWT_SECRET` — any long random string (required; sessions are signed with it)
3. **Persist the database**: add a Volume (e.g. mount path `/data`) and set `DATA_DIR=/data`. Without it, accounts and leaderboards reset on every deploy.
4. Open the generated URL in Chrome on Android. Done.

## Architecture

```
server.js              Express: static hosting + auth + leaderboard API (SQLite, bcrypt, JWT cookie)
public/
  index.html           auth / hub / AR stage shells
  js/app.js            auth flow, hub, game launcher
  js/xr-shooter.js     the game: WebXR session + hit-test floor placement,
                       arena, enemy AI with line-of-sight checks, heat weapon,
                       waves, procedural sound effects, desktop simulator fallback
```

## Privacy

The AR camera view is composited by the OS/browser — the app only receives your device pose, never camera pixels. Nothing is recorded or uploaded.
