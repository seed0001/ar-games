import * as THREE from 'three';

/* ⚔️ COVER FIRE — WebXR positional-tracking cover shooter.
 *
 * AR mode (Android Chrome): hit-test finds your real floor, you tap to
 * deploy a hard-light arena onto it. ARCore tracks your physical position,
 * so walking behind virtual cover REALLY blocks enemy line-of-sight.
 *
 * Sim mode (no WebXR): pointer-lock + WASD, same arena and game logic,
 * used for development on desktop.
 */

const UP = new THREE.Vector3(0, 1, 0);
const COL = {
  edge: 0x34e1ff,
  grid: 0x2bd8ff,
  tracer: 0x58f0ff,
  enemy: 0xff3355,
  enemyCore: 0x1a1030,
};

/* ---------------- procedural sound effects ---------------- */
class SFX {
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  blip({ type = 'square', f0 = 880, f1 = 110, dur = 0.08, vol = 0.2, noise = 0 }) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
    if (noise > 0) {
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = c.createBufferSource();
      s.buffer = buf;
      const ng = c.createGain();
      ng.gain.value = noise;
      s.connect(ng).connect(c.destination);
      s.start(t);
    }
  }
  shoot()      { this.blip({ type: 'square',   f0: 900,  f1: 140, dur: 0.09, vol: 0.15, noise: 0.06 }); }
  enemyShoot() { this.blip({ type: 'sawtooth', f0: 320,  f1: 70,  dur: 0.18, vol: 0.18 }); }
  spark()      { this.blip({ type: 'triangle', f0: 2100, f1: 700, dur: 0.05, vol: 0.09, noise: 0.1 }); }
  kill()       { this.blip({ type: 'sine',     f0: 200,  f1: 38,  dur: 0.35, vol: 0.3,  noise: 0.22 }); }
  hurt()       { this.blip({ type: 'sine',     f0: 130,  f1: 45,  dur: 0.3,  vol: 0.35, noise: 0.12 }); }
  overheat()   { this.blip({ type: 'square',   f0: 200,  f1: 180, dur: 0.3,  vol: 0.12 }); }
  waveUp()     { this.blip({ type: 'sine',     f0: 440,  f1: 880, dur: 0.3,  vol: 0.18 }); }
  deploy()     { this.blip({ type: 'sine',     f0: 110,  f1: 440, dur: 0.5,  vol: 0.25 }); }
}

/* ---------------- helpers ---------------- */
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(60,225,255,0.55)';
  x.lineWidth = 1.5;
  for (let i = 0; i <= 512; i += 32) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(512, i); x.stroke();
  }
  x.strokeStyle = 'rgba(60,225,255,1)';
  x.lineWidth = 8;
  x.strokeRect(2, 2, 508, 508);
  return new THREE.CanvasTexture(c);
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* ================================================================ */
export class ShooterGame {
  constructor({ container, hud, xr, onExit }) {
    this.container = container;
    this.hud = hud;
    this.xr = xr;               // true = WebXR AR, false = desktop simulator
    this.onExit = onExit;
    this.sfx = new SFX();
    this.state = 'boot';        // placing | intermission | combat | dead
    this.playerPos = new THREE.Vector3(0, 1.6, 0);
    this.enemies = [];
    this.effects = [];
    this.coverMeshes = [];
    this.raycaster = new THREE.Raycaster();
    this.tmpV = new THREE.Vector3();
    this.tmpV2 = new THREE.Vector3();
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.glowTex = glowTexture();
    this._stopped = false;
  }

  /* ---------------- lifecycle ---------------- */
  async start() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 60);
    this.camera.position.set(0, 1.6, 0);
    this.camera.rotation.order = 'YXZ';

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x30405a, 1.4));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(2, 5, 3);
    this.scene.add(dir);

    this.buildArena();
    this.buildHUD();

    this._onResize = () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    this.clock = new THREE.Clock();

    if (this.xr) await this.startXR();
    else this.startSim();

    this.renderer.setAnimationLoop((time, frame) => this.tick(frame));
  }

  async startXR() {
    this.renderer.xr.enabled = true;

    // reticle for floor placement
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.13, 0.17, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.9 })
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: this.hud },
    });
    this.session = session;

    try { this.renderer.xr.setReferenceSpaceType('local-floor'); }
    catch (e) { this.renderer.xr.setReferenceSpaceType('local'); }
    await this.renderer.xr.setSession(session);

    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    // taps on HUD buttons must not fire the weapon
    this._beforeSelect = (e) => {
      if (e.target.closest && e.target.closest('button')) e.preventDefault();
    };
    this.hud.addEventListener('beforexrselect', this._beforeSelect);

    this._onSelect = () => this.handlePrimary();
    session.addEventListener('select', this._onSelect);

    session.addEventListener('end', () => { if (!this._stopped) this.stop(); });

    this.sfx.ensure();
    this.setState('placing');
  }

  startSim() {
    // desktop dev fallback: pointer-lock look + WASD movement
    this.keys = {};
    this.simYaw = 0;
    this.simPitch = 0;
    this._onKey = (e) => { this.keys[e.code] = e.type === 'keydown'; };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);

    const canvas = this.renderer.domElement;
    this._onCanvasClick = () => {
      this.sfx.ensure();
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
      else this.handlePrimary();
    };
    canvas.addEventListener('click', this._onCanvasClick);

    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.simYaw -= e.movementX * 0.0024;
      this.simPitch = Math.max(-1.45, Math.min(1.45, this.simPitch - e.movementY * 0.0024));
    };
    window.addEventListener('mousemove', this._onMouseMove);

    // auto-place the arena ahead of the player
    this.placeArena(new THREE.Vector3(0, 0, -3.2));
    this.beginGame();
    this.setHint('Click to lock mouse · WASD move · click = fire · Esc frees the mouse');
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.renderer.setAnimationLoop(null);
    try { this.session?.end(); } catch (e) { /* already ended */ }
    this.hud.removeEventListener('beforexrselect', this._beforeSelect || (() => {}));
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKey || (() => {}));
    window.removeEventListener('keyup', this._onKey || (() => {}));
    window.removeEventListener('mousemove', this._onMouseMove || (() => {}));
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.innerHTML = '';
    this.renderer.dispose();
    this.container.innerHTML = '';
    this.onExit?.();
  }

  /* ---------------- arena ---------------- */
  buildArena() {
    const g = new THREE.Group();
    g.visible = false;
    this.arena = g;
    this.scene.add(g);

    // translucent grid floor pad marks the battlefield on your real floor
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 7.5).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: gridTexture(),
        color: COL.grid,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    pad.position.y = 0.01;
    g.add(pad);

    // hard-light cover: dark solid blocks with glowing edges
    // local space: +z faces the player when deployed
    const cover = [
      { size: [1.8, 0.9, 0.18], pos: [0, 0.45, 1.3] },          // front low wall
      { size: [1.0, 1.7, 0.4],  pos: [0.35, 0.85, -0.4] },      // tall center block
      { size: [0.72, 0.72, 0.72], pos: [-1.6, 0.36, 0.35] },    // crate L
      { size: [0.72, 0.72, 0.72], pos: [1.55, 0.36, 0.15] },    // crate R
      { size: [0.5, 0.5, 0.5],  pos: [1.55, 0.97, 0.15] },      // stacked crate
      { size: [1.5, 0.9, 0.18], pos: [-2.2, 0.45, -1.1], rotY: 0.5 },
      { size: [1.5, 0.9, 0.18], pos: [2.3, 0.45, -1.3], rotY: -0.45 },
      { cyl: [0.32, 0.85],      pos: [-0.85, 0.425, -1.5] },    // barrel
      { cyl: [0.32, 0.85],      pos: [-2.4, 0.425, 0.9] },      // barrel
    ];
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0e1420,
      roughness: 0.55,
      metalness: 0.35,
      transparent: true,
      opacity: 0.94,
    });
    for (const c of cover) {
      const geo = c.cyl
        ? new THREE.CylinderGeometry(c.cyl[0], c.cyl[0], c.cyl[1], 14)
        : new THREE.BoxGeometry(...c.size);
      const mesh = new THREE.Mesh(geo, bodyMat);
      mesh.position.set(...c.pos);
      if (c.rotY) mesh.rotation.y = c.rotY;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 20),
        new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.9 })
      );
      mesh.add(edges);
      g.add(mesh);
      this.coverMeshes.push(mesh);
    }
  }

  placeArena(worldPos) {
    this.arena.position.copy(worldPos);
    // rotate so local +z (the cover-facing side) points at the player
    const yaw = Math.atan2(this.playerPos.x - worldPos.x, this.playerPos.z - worldPos.z);
    this.arena.rotation.y = yaw;
    this.arena.visible = true;
    this.arena.scale.set(1, 0.001, 1);
    this.deployAnim = 0;
    this.sfx.deploy();
    if (this.reticle) this.reticle.visible = false;
  }

  /* ---------------- HUD ---------------- */
  buildHUD() {
    this.hud.innerHTML = `
      <div class="xr-hud">
        <div class="xhair"><span></span><span></span><span></span><span></span><i></i></div>
        <div class="hud-top">
          <div class="hp-wrap"><div class="hp-bar" id="cf-hp"></div></div>
          <div class="hud-score" id="cf-score">0</div>
        </div>
        <div class="heat-wrap"><div class="heat-bar" id="cf-heat"></div></div>
        <div class="hud-banner hidden" id="cf-banner"></div>
        <div class="hud-hint" id="cf-hint"></div>
        <div class="dmg-vignette" id="cf-dmg"></div>
        <button class="exit-btn hud-exit" id="cf-exit">✕</button>
      </div>
    `;
    this.el = {
      hp: this.hud.querySelector('#cf-hp'),
      score: this.hud.querySelector('#cf-score'),
      heat: this.hud.querySelector('#cf-heat'),
      banner: this.hud.querySelector('#cf-banner'),
      hint: this.hud.querySelector('#cf-hint'),
      dmg: this.hud.querySelector('#cf-dmg'),
      xhair: this.hud.querySelector('.xhair'),
    };
    this.hud.querySelector('#cf-exit').addEventListener('click', () => this.stop());
  }

  setHint(text) {
    this.el.hint.textContent = text || '';
    this.el.hint.classList.toggle('hidden', !text);
  }

  banner(text, ms = 1800) {
    this.el.banner.textContent = text;
    this.el.banner.classList.remove('hidden');
    clearTimeout(this._bannerT);
    if (ms) this._bannerT = setTimeout(() => this.el.banner.classList.add('hidden'), ms);
  }

  /* ---------------- game state ---------------- */
  setState(s) {
    this.state = s;
    if (s === 'placing') {
      this.el.xhair.classList.add('hidden');
      this.setHint('Point your phone at the floor — tap to deploy the arena');
    } else {
      this.el.xhair.classList.remove('hidden');
    }
  }

  beginGame() {
    this.hp = 100;
    this.heat = 0;
    this.overheated = false;
    this.score = 0;
    this.wave = 0;
    this.lastHurt = -99;
    this.el.score.textContent = '0';
    this.updateHpBar();
    this.setState('intermission');
    this.stateT = 2.5;
    this.banner('GET READY', 2200);
    this.setHint(this.xr ? 'Move your BODY to take cover. Tap screen to fire.' : '');
  }

  startWave() {
    this.wave++;
    this.setState('combat');
    this.banner(`WAVE ${this.wave}`, 1600);
    this.sfx.waveUp();
    const count = Math.min(8, 1 + this.wave);
    for (let i = 0; i < count; i++) this.spawnEnemy(i / count);
  }

  /* ---------------- enemies ---------------- */
  spawnEnemy(frac) {
    const group = new THREE.Group();

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.17, 0),
      new THREE.MeshStandardMaterial({ color: COL.enemyCore, roughness: 0.3, metalness: 0.7 })
    );
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 12),
      new THREE.MeshBasicMaterial({ color: COL.enemy })
    );
    eye.position.z = 0.13;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.24, 0.018, 8, 24),
      new THREE.MeshBasicMaterial({ color: COL.enemy, transparent: true, opacity: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(core.geometry),
      new THREE.LineBasicMaterial({ color: COL.enemy })
    );
    core.add(edges);
    group.add(core, eye, ring);

    // invisible-but-raycastable hitbox
    const hitbox = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 8, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
    );
    group.add(hitbox);

    const e = {
      group, eye, ring, hitbox,
      hp: 2,
      state: 'move',
      stateT: 0.5 + Math.random() * 1.5 + frac * 2,
      waypoint: this.pickWaypoint(),
      local: this.pickWaypoint(),
      speed: Math.min(1.7, 0.8 + this.wave * 0.12),
      aimBeam: null,
      bob: Math.random() * 10,
      spawnT: 0,
    };
    hitbox.userData.enemy = e;
    group.position.copy(this.arena.localToWorld(e.local.clone()));
    group.scale.setScalar(0.001);
    this.arenaWorldY = this.arena.position.y;
    this.scene.add(group);
    this.enemies.push(e);
    this.spawnFlash(group.position);
  }

  pickWaypoint() {
    // enemy roaming zone: the far half of the arena (local -z is away from player)
    return new THREE.Vector3(
      (Math.random() - 0.5) * 5.6,
      1.0 + Math.random() * 0.9,
      -1.0 - Math.random() * 3.0
    );
  }

  killEnemy(e, i) {
    this.explode(e.group.position, COL.enemy);
    this.sfx.kill();
    this.removeEnemy(e, i);
    this.score += 100;
    this.el.score.textContent = this.score.toLocaleString();
    if (navigator.vibrate) navigator.vibrate(35);
    if (this.enemies.length === 0 && this.state === 'combat') {
      this.score += 250;
      this.el.score.textContent = this.score.toLocaleString();
      this.setState('intermission');
      this.stateT = 3.2;
      this.banner(`WAVE ${this.wave} CLEAR  +250`, 2500);
    }
  }

  removeEnemy(e, i) {
    if (e.aimBeam) { this.scene.remove(e.aimBeam); e.aimBeam.material.dispose(); }
    this.scene.remove(e.group);
    e.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.enemies.splice(i, 1);
  }

  /* ---------------- combat resolution ---------------- */
  losBlocked(from, to) {
    const dist = from.distanceTo(to);
    this.tmpV.copy(to).sub(from).normalize();
    this.raycaster.set(from, this.tmpV);
    this.raycaster.far = dist - 0.05;
    const hits = this.raycaster.intersectObjects(this.coverMeshes, false);
    return hits.length ? hits[0] : null;
  }

  handlePrimary() {
    if (this.state === 'placing') {
      if (this.reticle?.visible) {
        this.tmpV.setFromMatrixPosition(this.reticle.matrix);
        this.placeArena(this.tmpV.clone());
        this.beginGame();
      }
      return;
    }
    if (this.state === 'dead') return;
    this.fire();
  }

  fire() {
    if (this.overheated) return;
    this.heat += 0.16;
    if (this.heat >= 1) {
      this.overheated = true;
      this.sfx.overheat();
      this.el.heat.classList.add('hot');
    }
    this.sfx.shoot();
    if (navigator.vibrate) navigator.vibrate(12);

    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const origin = new THREE.Vector3();
    cam.getWorldPosition(origin);
    const dirV = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);

    this.raycaster.set(origin, dirV);
    this.raycaster.far = 60;
    const targets = [...this.coverMeshes, ...this.enemies.map((e) => e.hitbox)];
    const hits = this.raycaster.intersectObjects(targets, false);

    // tracer starts slightly off-center so it reads as "from your weapon"
    const gunPos = origin.clone()
      .add(dirV.clone().multiplyScalar(0.25))
      .add(new THREE.Vector3(0, -0.07, 0));

    let end;
    if (hits.length) {
      end = hits[0].point;
      const enemy = hits[0].object.userData.enemy;
      if (enemy) {
        enemy.hp--;
        if (enemy.hp <= 0) {
          this.killEnemy(enemy, this.enemies.indexOf(enemy));
        } else {
          this.spark(end, COL.enemy);
          this.sfx.spark();
          enemy.group.scale.setScalar(1.25); // flinch
        }
      } else {
        this.spark(end, COL.edge); // shot absorbed by cover
        this.sfx.spark();
      }
    } else {
      end = origin.clone().add(dirV.multiplyScalar(30));
    }
    this.spawnBeam(gunPos, end, COL.tracer, 0.09, 0.012);
  }

  enemyFire(e) {
    this.sfx.enemyShoot();
    const from = new THREE.Vector3();
    e.eye.getWorldPosition(from);
    const blocked = this.losBlocked(from, this.playerPos);
    if (blocked) {
      // your cover ate the shot — the whole point of the game
      this.spawnBeam(from, blocked.point, COL.enemy, 0.12, 0.02);
      this.spark(blocked.point, COL.edge);
      this.sfx.spark();
    } else {
      this.spawnBeam(from, this.playerPos, COL.enemy, 0.12, 0.02);
      this.damage(8 + this.wave * 2);
    }
  }

  damage(amt) {
    if (this.state === 'dead') return;
    this.hp = Math.max(0, this.hp - amt);
    this.lastHurt = this.elapsed;
    this.updateHpBar();
    this.el.dmg.style.opacity = '1';
    setTimeout(() => { this.el.dmg.style.opacity = '0'; }, 120);
    this.sfx.hurt();
    if (navigator.vibrate) navigator.vibrate([70, 30, 70]);
    if (this.hp <= 0) this.die();
  }

  updateHpBar() {
    this.el.hp.style.width = `${this.hp}%`;
    this.el.hp.classList.toggle('low', this.hp <= 30);
  }

  die() {
    this.setState('dead');
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      this.explode(this.enemies[i].group.position, COL.enemy);
      this.removeEnemy(this.enemies[i], i);
    }
    if (document.pointerLockElement) document.exitPointerLock();
    window.dispatchEvent(new CustomEvent('camfun:score', { detail: { mode: 'shooter', score: this.score } }));

    const over = document.createElement('div');
    over.className = 'game-over';
    over.innerHTML = `
      <div class="game-over-card">
        <h2>⚔️ TERMINATED</h2>
        <div class="final">${this.score.toLocaleString()}</div>
        <div style="color:var(--dim);margin:-10px 0 16px;font-size:14px">wave ${this.wave}</div>
        <button class="btn-primary" id="cf-again">Redeploy</button>
        <button class="btn-secondary" id="cf-lb">🏆 Leaderboard</button>
      </div>
    `;
    this.hud.querySelector('.xr-hud').appendChild(over);
    over.querySelector('#cf-again').addEventListener('click', () => {
      over.remove();
      this.beginGame();
    });
    over.querySelector('#cf-lb').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('camfun:showleaderboard', { detail: { mode: 'shooter' } }));
    });
  }

  /* ---------------- effects ---------------- */
  spawnBeam(from, to, color, life, radius) {
    const len = from.distanceTo(to);
    if (len < 0.01) return;
    const mesh = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    mesh.scale.set(radius, len, radius);
    mesh.position.copy(from).lerp(to, 0.5);
    this.tmpV.copy(to).sub(from).normalize();
    mesh.quaternion.setFromUnitVectors(UP, this.tmpV);
    this.scene.add(mesh);
    this.effects.push({ mesh, life, maxLife: life, type: 'beam' });
  }

  spark(pos, color) {
    this.burst(pos, color, 8, 2.2, 0.09, 0.35);
  }

  explode(pos, color) {
    this.burst(pos, color, 26, 3.6, 0.14, 0.7);
  }

  spawnFlash(pos) {
    this.burst(pos, COL.edge, 12, 1.6, 0.1, 0.4);
  }

  burst(pos, color, count, speed, size, life) {
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    const vels = [];
    for (let i = 0; i < count; i++) {
      arr.set([pos.x, pos.y, pos.z], i * 3);
      vels.push(new THREE.Vector3(
        (Math.random() - 0.5), (Math.random() - 0.35), (Math.random() - 0.5)
      ).normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.8)));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      map: this.glowTex, color, size, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scene.add(pts);
    this.effects.push({ mesh: pts, vels, life, maxLife: life, type: 'burst' });
  }

  /* ---------------- main loop ---------------- */
  tick(frame) {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed = this.clock.elapsedTime;

    // player position from real-world tracking (or sim controls)
    if (this.renderer.xr.isPresenting) {
      this.renderer.xr.getCamera().getWorldPosition(this.playerPos);
    } else if (!this.xr) {
      this.updateSim(dt);
      this.playerPos.copy(this.camera.position);
    }

    // XR floor placement reticle
    if (this.state === 'placing' && frame && this.hitTestSource) {
      const results = frame.getHitTestResults(this.hitTestSource);
      if (results.length) {
        const pose = results[0].getPose(this.renderer.xr.getReferenceSpace());
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        this.reticle.visible = false;
      }
    }

    // arena deploy animation
    if (this.arena.visible && this.arena.scale.y < 1) {
      this.deployAnim = Math.min(1, this.deployAnim + dt * 2.2);
      const s = 1 - Math.pow(1 - this.deployAnim, 3);
      this.arena.scale.set(1, Math.max(0.001, s), 1);
    }

    // heat dissipation
    this.heat = Math.max(0, (this.heat ?? 0) - dt * 0.38);
    if (this.overheated && this.heat < 0.35) {
      this.overheated = false;
      this.el.heat.classList.remove('hot');
    }
    if (this.el?.heat) this.el.heat.style.width = `${this.heat * 100}%`;

    // hp regen out of combat fire
    if (this.state === 'combat' || this.state === 'intermission') {
      if (this.hp > 0 && this.hp < 100 && this.elapsed - this.lastHurt > 4) {
        this.hp = Math.min(100, this.hp + dt * 9);
        this.updateHpBar();
      }
    }

    // intermission countdown
    if (this.state === 'intermission') {
      this.stateT -= dt;
      if (this.stateT <= 0) this.startWave();
    }

    // enemies
    if (this.state === 'combat') this.updateEnemies(dt);

    // effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      const p = Math.max(0, fx.life / fx.maxLife);
      if (fx.type === 'beam') {
        fx.mesh.material.opacity = p;
      } else {
        const pos = fx.mesh.geometry.attributes.position;
        for (let j = 0; j < fx.vels.length; j++) {
          pos.array[j * 3] += fx.vels[j].x * dt;
          pos.array[j * 3 + 1] += fx.vels[j].y * dt;
          pos.array[j * 3 + 2] += fx.vels[j].z * dt;
          fx.vels[j].y -= dt * 2.5;
        }
        pos.needsUpdate = true;
        fx.mesh.material.opacity = p;
      }
      if (fx.life <= 0) {
        this.scene.remove(fx.mesh);
        if (fx.type === 'burst') fx.mesh.geometry.dispose();
        fx.mesh.material.dispose();
        this.effects.splice(i, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  updateEnemies(dt) {
    const eyePos = new THREE.Vector3();
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];

      // spawn-in scale
      if (e.group.scale.x < 1) {
        e.group.scale.setScalar(Math.min(1, e.group.scale.x + dt * 3));
      } else if (e.group.scale.x > 1) {
        e.group.scale.setScalar(Math.max(1, e.group.scale.x - dt * 2)); // flinch recovery
      }

      e.bob += dt * 2.4;
      e.group.lookAt(this.playerPos);
      e.ring.rotation.z += dt * 3;

      if (e.state === 'move') {
        // drift toward waypoint (in arena-local space, converted to world)
        this.tmpV.copy(e.waypoint);
        this.arena.localToWorld(this.tmpV);
        this.tmpV.y = e.waypoint.y + this.arena.position.y + Math.sin(e.bob) * 0.08;
        const d = this.tmpV2.copy(this.tmpV).sub(e.group.position);
        const dist = d.length();
        if (dist > 0.08) {
          e.group.position.addScaledVector(d.normalize(), Math.min(dist, e.speed * dt));
        }
        e.stateT -= dt;
        if (e.stateT <= 0) {
          e.eye.getWorldPosition(eyePos);
          if (dist < 0.4 && !this.losBlocked(eyePos, this.playerPos)) {
            // clear line of sight — start the aim telegraph
            e.state = 'aim';
            e.stateT = Math.max(0.55, 1.35 - this.wave * 0.08);
            e.aimBeam = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
              color: COL.enemy, transparent: true, opacity: 0.12,
              blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            this.scene.add(e.aimBeam);
          } else {
            e.waypoint = this.pickWaypoint();
            e.stateT = 0.6 + Math.random() * 1.6;
          }
        }
      } else if (e.state === 'aim') {
        e.eye.getWorldPosition(eyePos);
        // abort if the player broke line of sight mid-aim (you dodged!)
        if (this.losBlocked(eyePos, this.playerPos)) {
          this.scene.remove(e.aimBeam);
          e.aimBeam.material.dispose();
          e.aimBeam = null;
          e.state = 'move';
          e.waypoint = this.pickWaypoint();
          e.stateT = 0.4;
          continue;
        }
        // telegraph beam tracks you, brightening as it locks
        const len = eyePos.distanceTo(this.playerPos);
        e.aimBeam.scale.set(0.006, len, 0.006);
        e.aimBeam.position.copy(eyePos).lerp(this.playerPos, 0.5);
        this.tmpV.copy(this.playerPos).sub(eyePos).normalize();
        e.aimBeam.quaternion.setFromUnitVectors(UP, this.tmpV);
        e.aimBeam.material.opacity = 0.12 + (1 - e.stateT / 1.35) * 0.5;

        e.stateT -= dt;
        if (e.stateT <= 0) {
          this.scene.remove(e.aimBeam);
          e.aimBeam.material.dispose();
          e.aimBeam = null;
          this.enemyFire(e);
          e.state = 'move';
          e.waypoint = this.pickWaypoint();
          e.stateT = 1.0 + Math.random() * 1.4;
        }
      }
    }
  }

  updateSim(dt) {
    this.camera.rotation.set(this.simPitch, this.simYaw, 0);
    const f = new THREE.Vector3(-Math.sin(this.simYaw), 0, -Math.cos(this.simYaw));
    const r = new THREE.Vector3(f.z, 0, -f.x);
    const v = new THREE.Vector3();
    if (this.keys['KeyW']) v.add(f);
    if (this.keys['KeyS']) v.sub(f);
    if (this.keys['KeyA']) v.add(r);
    if (this.keys['KeyD']) v.sub(r);
    if (v.lengthSq() > 0) this.camera.position.addScaledVector(v.normalize(), dt * 2.6);
    this.camera.position.y = 1.6;
  }
}

/** Is real AR available here? */
export async function arSupported() {
  if (!navigator.xr) return false;
  try { return await navigator.xr.isSessionSupported('immersive-ar'); }
  catch (e) { return false; }
}
