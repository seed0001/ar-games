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

## 🌍 World Scanner + 🗺️ Explore Worlds

Walk around your yard or house and **paint reality into a 3D map**:

- Uses the WebXR **Depth API** (Android Chrome): every few frames the depth image is fused through the device pose into a voxel-deduped point cloud, live on screen as you walk
- With WebXR raw camera access the points get **real color**; otherwise an elevation-tinted hologram look
- Terrain height, trees, walls — anything you sweep the phone across within ~5 m gets captured (up to ~1.5M points per world)
- Scans save to your account and appear in the shared **Worlds** gallery
- Anyone can explore a world: WASD fly-through on desktop, joystick + drag-look on phones, or **diorama AR** — the whole world shrunk onto your real floor
- No AR device? The scanner generates a synthetic demo yard so the full save/explore pipeline still works anywhere

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
server.js               Express: static hosting + auth + leaderboard + worlds API
                        (SQLite, bcrypt, JWT cookie; world point data as binary
                        files under DATA_DIR/worlds)
public/
  index.html            auth / hub / AR stage shells
  js/app.js             auth flow, hub, game + scanner + explorer launchers
  js/xr-shooter.js      Cover Fire: WebXR session + hit-test floor placement,
                        arena, enemy AI with line-of-sight checks, heat weapon,
                        waves, procedural sound effects, desktop simulator fallback
  js/world-scanner.js   AR session, timed raw-camera color grab, paged GPU
                        geometry, watchdog-protected frame loop, chunked
                        upload; demo-world generator fallback
  js/world-fuse-worker.js  Web Worker doing the heavy lifting: depth-buffer
                        unprojection, voxel dedupe, point storage, encoding
  js/world-explorer.js  point-cloud viewer: desktop fly, touch joystick,
                        AR diorama placement
  js/world-format.js    shared 10-byte-per-point binary world format
```

## Privacy

- **Cover Fire** only receives your device pose — never camera pixels. Nothing is recorded or uploaded.
- **World Scanner** additionally reads depth maps and (where supported) camera pixels **on your phone** to color the scan. Raw camera frames never leave the device — only the resulting 3D points are uploaded, and only when you explicitly save a world. Saved worlds are visible to all signed-in players until you delete them.
