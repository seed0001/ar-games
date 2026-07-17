import * as THREE from 'three';
import { SFX, glowTexture } from './xr-shooter.js';
import { MusicEngine } from './music.js';

/* 🏃 GAUNTLET RUN — WebXR walking cover-shooter obstacle course.
 *
 * A hard-light corridor ~3 m wide and 30 m long (10 ft × 100 ft) deploys
 * down a real driveway / hallway / yard. The course is split into 5 zones:
 * each zone is full of barricades and drones. Clear the drones to unlock
 * the gate, PHYSICALLY WALK through it, and the next zone activates.
 * Cross the finish line for a time bonus. Die and you restart.
 *
 * Sim mode (no WebXR): pointer-lock + WASD, same course and logic.
 */

const UP = new THREE.Vector3(0, 1, 0);
const COL = {
  edge: 0x34e1ff,
  grid: 0x2bd8ff,
  tracer: 0x58f0ff,
  enemy: 0xff3355,
  sentry: 0xff9d2e,
  enemyCore: 0x1a1030,
  locked: 0xff2244,
  open: 0x2bffb0,
  finish: 0xffd34d,
};

const COURSE_W = 3;      // ≈ 10 ft wide
const COURSE_L = 30;     // ≈ 100 ft long
const ZONES = 5;
const ZONE_L = COURSE_L / ZONES;
const M_TO_FT = 3.28084;

/* seamless grid tile (no border, so it can repeat down the strip) */
function stripTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(60,225,255,0.5)';
  x.lineWidth = 1.5;
  for (let i = 0; i <= 256; i += 32) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ================================================================ */
export class GauntletGame {
  constructor({ container, hud, xr, onExit }) {
    this.container = container;
    this.hud = hud;
    this.xr = xr;
    this.onExit = onExit;
    this.sfx = new SFX();
    this.music = new MusicEngine();
    this.state = 'boot';        // placing | run | dead | won
    this.playerPos = new THREE.Vector3(0, 1.6, 0);
    this.enemies = [];
    this.effects = [];
    this.coverMeshes = [];
    this.gates = [];
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
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 90);
    this.camera.position.set(0, 1.6, 0);
    this.camera.rotation.order = 'YXZ';

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x30405a, 1.4));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(2, 5, 3);
    this.scene.add(dir);

    this.buildCourse();
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

    // long directional reticle: shows where the start line will land AND
    // which way the course will run (away from you)
    const ret = new THREE.Group();
    ret.add(new THREE.Mesh(
      new THREE.RingGeometry(0.13, 0.17, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.9 })
    ));
    const arrow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.1, 0.8).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.5 })
    );
    arrow.position.z = -0.65;
    ret.add(arrow);
    ret.matrixAutoUpdate = false;
    ret.visible = false;
    this.reticle = ret;
    this.scene.add(ret);

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

    this.placeCourse(new THREE.Vector3(0, 0, -2));
    this.beginGame();
    this.setHint('Click to lock mouse · WASD walk the course · click = fire · Esc frees the mouse');
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.music.stop(true);
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

  /* ---------------- course construction ----------------
   * Course local space: origin = center of the start line on the floor,
   * the course runs along local -z (same convention as the arena shooter:
   * local +z points back at the player when deployed).
   */
  buildCourse() {
    const g = new THREE.Group();
    g.visible = false;
    this.course = g;
    this.scene.add(g);

    // floor strip
    const tex = stripTexture();
    tex.repeat.set(2, COURSE_L / 1.5);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(COURSE_W, COURSE_L).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: tex, color: COL.grid, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    floor.position.set(0, 0.01, -COURSE_L / 2);
    g.add(floor);

    // glowing side rails + posts so the course edges read at a distance
    const railMat = new THREE.MeshBasicMaterial({
      color: COL.edge, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, COURSE_L), railMat);
      rail.position.set(side * COURSE_W / 2, 0.03, -COURSE_L / 2);
      g.add(rail);
      for (let z = 0; z <= COURSE_L; z += 3) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.05), railMat);
        post.position.set(side * COURSE_W / 2, 0.2, -z);
        g.add(post);
      }
    }

    // start line
    const startLine = new THREE.Mesh(
      new THREE.PlaneGeometry(COURSE_W, 0.16).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: COL.open, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    startLine.position.set(0, 0.02, 0);
    g.add(startLine);

    // obstacles: 3 rows per zone, each row blocks 1-2 of 3 lanes so there
    // is always a walkable gap — they double as cover from drone fire
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0e1420, roughness: 0.55, metalness: 0.35,
      transparent: true, opacity: 0.94,
    });
    const lanes = [-1.05, 0, 1.05];
    for (let zone = 0; zone < ZONES; zone++) {
      const zs = -zone * ZONE_L;
      for (const rowOff of [1.6, 3.2, 4.7]) {
        const rz = zs - rowOff + (Math.random() - 0.5) * 0.5;
        const blockCount = Math.random() < 0.4 ? 2 : 1;
        const order = [0, 1, 2].sort(() => Math.random() - 0.5);
        for (let b = 0; b < blockCount; b++) {
          const lane = lanes[order[b]];
          const kind = Math.random();
          let geo, y;
          if (kind < 0.45) {           // low wall
            const h = 0.8 + Math.random() * 0.4;
            geo = new THREE.BoxGeometry(1.15, h, 0.16);
            y = h / 2;
          } else if (kind < 0.75) {    // crate
            geo = new THREE.BoxGeometry(0.62, 0.62, 0.62);
            y = 0.31;
          } else {                     // barrel
            geo = new THREE.CylinderGeometry(0.3, 0.3, 0.8, 14);
            y = 0.4;
          }
          const mesh = new THREE.Mesh(geo, bodyMat);
          mesh.position.set(lane + (Math.random() - 0.5) * 0.2, y, rz);
          mesh.rotation.y = (Math.random() - 0.5) * 0.5;
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo, 20),
            new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.9 })
          );
          mesh.add(edges);
          g.add(mesh);
          this.coverMeshes.push(mesh);

          // 30% of crates get a second crate stacked on top
          if (kind >= 0.45 && kind < 0.75 && Math.random() < 0.3) {
            const g2 = new THREE.BoxGeometry(0.45, 0.45, 0.45);
            const m2 = new THREE.Mesh(g2, bodyMat);
            m2.position.set(mesh.position.x, 0.62 + 0.225, rz);
            m2.rotation.y = Math.random();
            m2.add(new THREE.LineSegments(
              new THREE.EdgesGeometry(g2, 20),
              new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.9 })
            ));
            g.add(m2);
            this.coverMeshes.push(m2);
          }
        }
      }

      // gate at the end of this zone (the last one is the finish line)
      this.gates.push(this.buildGate(-(zone + 1) * ZONE_L, zone === ZONES - 1));
    }
  }

  buildGate(z, isFinish) {
    const grp = new THREE.Group();
    grp.position.set(0, 0, z);
    this.course.add(grp);

    const frameMat = new THREE.MeshBasicMaterial({
      color: COL.locked, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.1), frameMat);
      post.position.set(side * (COURSE_W / 2 + 0.05), 1.2, 0);
      grp.add(post);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(COURSE_W + 0.2, 0.1, 0.1), frameMat);
    bar.position.set(0, 2.45, 0);
    grp.add(bar);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(COURSE_W, 2.4),
      new THREE.MeshBasicMaterial({
        color: COL.locked, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    plane.position.set(0, 1.2, 0);
    grp.add(plane);

    return { grp, plane, frameMat, z, isFinish, open: false, flash: 0, fade: 1 };
  }

  resetGates() {
    for (const gate of this.gates) {
      gate.open = false;
      gate.flash = 0;
      gate.fade = 1;
      gate.plane.visible = true;
      gate.plane.material.opacity = 0.2;
      gate.plane.material.color.setHex(COL.locked);
      gate.frameMat.color.setHex(COL.locked);
    }
  }

  openGate(i) {
    const gate = this.gates[i];
    if (gate.open) return;
    gate.open = true;
    gate.frameMat.color.setHex(gate.isFinish ? COL.finish : COL.open);
    gate.plane.material.color.setHex(gate.isFinish ? COL.finish : COL.open);
    this.sfx.waveUp();
    this.banner(gate.isFinish ? '🏁 FINISH OPEN — RUN!' : 'GATE OPEN — MOVE UP', 2200);
    if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
  }

  placeCourse(worldPos) {
    this.course.position.copy(worldPos);
    // course runs AWAY from where the player is standing
    const yaw = Math.atan2(this.playerPos.x - worldPos.x, this.playerPos.z - worldPos.z);
    this.course.rotation.y = yaw;
    this.course.visible = true;
    this.course.scale.set(1, 0.001, 1);
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
          <div class="hp-wrap"><div class="hp-bar" id="gr-hp"></div></div>
          <div class="hud-score" id="gr-score">0</div>
        </div>
        <div class="run-wrap">
          <div class="run-track"><div class="run-fill" id="gr-fill"></div></div>
          <div class="run-meta"><span id="gr-dist">0 ft</span> · <span id="gr-time">0:00</span></div>
        </div>
        <div class="heat-wrap"><div class="heat-bar" id="gr-heat"></div></div>
        <div class="hud-banner hidden" id="gr-banner"></div>
        <div class="hud-hint" id="gr-hint"></div>
        <div class="dmg-vignette" id="gr-dmg"></div>
        <button class="exit-btn hud-exit" id="gr-exit">✕</button>
        <button class="exit-btn hud-mute" id="gr-mute">${this.music.muted ? '🔇' : '🔊'}</button>
      </div>
    `;
    this.el = {
      hp: this.hud.querySelector('#gr-hp'),
      score: this.hud.querySelector('#gr-score'),
      heat: this.hud.querySelector('#gr-heat'),
      fill: this.hud.querySelector('#gr-fill'),
      dist: this.hud.querySelector('#gr-dist'),
      time: this.hud.querySelector('#gr-time'),
      banner: this.hud.querySelector('#gr-banner'),
      hint: this.hud.querySelector('#gr-hint'),
      dmg: this.hud.querySelector('#gr-dmg'),
      xhair: this.hud.querySelector('.xhair'),
    };
    this.hud.querySelector('#gr-exit').addEventListener('click', () => this.stop());
    const muteBtn = this.hud.querySelector('#gr-mute');
    muteBtn.addEventListener('click', () => {
      this.music.setMuted(!this.music.muted);
      muteBtn.textContent = this.music.muted ? '🔇' : '🔊';
    });
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

  fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  /* ---------------- game state ---------------- */
  setState(s) {
    this.state = s;
    if (s === 'placing') {
      this.el.xhair.classList.add('hidden');
      this.setHint('Stand at the START of your driveway, aim down it, tap to lay the course');
    } else {
      this.el.xhair.classList.remove('hidden');
    }
  }

  beginGame() {
    // clear any leftovers from a previous run
    for (let i = this.enemies.length - 1; i >= 0; i--) this.removeEnemy(this.enemies[i], i);
    this.resetGates();
    this.hp = 100;
    this.heat = 0;
    this.overheated = false;
    this.score = 0;
    this.kills = 0;
    this.currentZone = 0;
    this.progress = 0;
    this.lastHurt = -99;
    this.wallHurtT = 0;
    this.runStart = this.clock ? this.clock.elapsedTime : 0;
    // the run arms when the player is at the start line — after a mid-course
    // restart they walk back first, without gates zapping them on the way
    this.armed = false;
    this.el.score.textContent = '0';
    this.updateHpBar();
    this.setState('run');
    this.sfx.ensure();
    this.music.start(this.sfx.ctx);
    this.music.setLevel(0);
    this.setHint(this.xr
      ? 'Shoot the drones from cover, then WALK through the gate when it opens'
      : '');
  }

  addScore(n) {
    this.score += n;
    this.el.score.textContent = this.score.toLocaleString();
  }

  /* ---------------- enemies ---------------- */
  spawnZone(zone) {
    this.music.setLevel(zone);                    // track heats up per zone
    const count = 2 + zone;                       // 2,3,4,5,6
    const sentries = zone >= 2 ? Math.min(2, zone - 1) : 0;
    for (let i = 0; i < count; i++) {
      this.spawnEnemy(zone, i / count, i < sentries);
    }
  }

  spawnEnemy(zone, frac, isSentry) {
    const color = isSentry ? COL.sentry : COL.enemy;
    const group = new THREE.Group();

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(isSentry ? 0.2 : 0.17, 0),
      new THREE.MeshStandardMaterial({ color: COL.enemyCore, roughness: 0.3, metalness: 0.7 })
    );
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    eye.position.z = 0.13;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.24, 0.018, 8, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(core.geometry),
      new THREE.LineBasicMaterial({ color })
    );
    core.add(edges);
    group.add(core, eye, ring);

    const hitbox = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 8, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
    );
    group.add(hitbox);

    const e = {
      group, eye, ring, hitbox, zone,
      isSentry,
      hp: isSentry ? 3 : 2,
      state: 'move',
      stateT: 0.6 + Math.random() * 1.5 + frac * 1.6,
      waypoint: this.pickWaypoint(zone),
      speed: Math.min(1.8, 0.8 + zone * 0.15),
      aimTime: isSentry ? 0.85 : Math.max(0.55, 1.35 - zone * 0.1),
      aimBeam: null,
      bob: Math.random() * 10,
    };
    hitbox.userData.enemy = e;
    const spawn = this.pickWaypoint(zone);
    group.position.copy(this.course.localToWorld(spawn.clone()));
    group.position.y = this.course.position.y + spawn.y;
    group.scale.setScalar(0.001);
    this.scene.add(group);
    this.enemies.push(e);
    this.spawnFlash(group.position);
  }

  pickWaypoint(zone) {
    // roam inside this zone's stretch of the corridor
    return new THREE.Vector3(
      (Math.random() - 0.5) * (COURSE_W - 0.6),
      1.0 + Math.random() * 1.1,
      -zone * ZONE_L - 1.2 - Math.random() * (ZONE_L - 1.8)
    );
  }

  killEnemy(e, i) {
    this.explode(e.group.position, e.isSentry ? COL.sentry : COL.enemy);
    this.sfx.kill();
    const zone = e.zone;
    this.removeEnemy(e, i);
    this.kills++;
    this.addScore(e.isSentry ? 150 : 100);
    if (navigator.vibrate) navigator.vibrate(35);

    if (!this.enemies.some((x) => x.zone === zone) && !this.gates[zone].open) {
      this.addScore(250);
      this.openGate(zone);
    }
  }

  removeEnemy(e, i) {
    if (e.aimBeam) { this.scene.remove(e.aimBeam); e.aimBeam.material.dispose(); }
    this.scene.remove(e.group);
    e.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.enemies.splice(i, 1);
  }

  /* ---------------- combat ---------------- */
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
        this.placeCourse(this.tmpV.clone());
        this.beginGame();
      }
      return;
    }
    if (this.state === 'dead' || this.state === 'won') return;
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
          this.spark(end, enemy.isSentry ? COL.sentry : COL.enemy);
          this.sfx.spark();
          enemy.group.scale.setScalar(1.25);
        }
      } else {
        this.spark(end, COL.edge);
        this.sfx.spark();
      }
    } else {
      end = origin.clone().add(dirV.multiplyScalar(40));
    }
    this.spawnBeam(gunPos, end, COL.tracer, 0.09, 0.012);
  }

  enemyFire(e) {
    this.sfx.enemyShoot();
    const from = new THREE.Vector3();
    e.eye.getWorldPosition(from);
    const blocked = this.losBlocked(from, this.playerPos);
    if (blocked) {
      this.spawnBeam(from, blocked.point, COL.enemy, 0.12, 0.02);
      this.spark(blocked.point, COL.edge);
      this.sfx.spark();
    } else {
      this.spawnBeam(from, this.playerPos, COL.enemy, 0.12, 0.02);
      this.damage(e.isSentry ? 12 : 8 + e.zone * 2);
    }
  }

  damage(amt) {
    if (this.state === 'dead' || this.state === 'won') return;
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

  /* ---------------- endings ---------------- */
  die() {
    this.setState('dead');
    this.music.stop();
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      this.explode(this.enemies[i].group.position, COL.enemy);
      this.removeEnemy(this.enemies[i], i);
    }
    if (document.pointerLockElement) document.exitPointerLock();
    window.dispatchEvent(new CustomEvent('camfun:score', { detail: { mode: 'gauntlet', score: this.score } }));
    this.showOverlay({
      title: '🏃 RUN ENDED',
      sub: `made it ${Math.round(this.progress * M_TO_FT)} ft · ${this.kills} drones down`,
      btn: 'Run it again',
    });
  }

  win() {
    this.setState('won');
    this.music.stop();
    const t = this.elapsed - this.runStart;
    const timeBonus = Math.max(0, Math.round((420 - t) * 8));
    this.addScore(1000 + timeBonus);
    this.sfx.waveUp();
    if (document.pointerLockElement) document.exitPointerLock();
    window.dispatchEvent(new CustomEvent('camfun:score', { detail: { mode: 'gauntlet', score: this.score } }));
    this.showOverlay({
      title: '🏁 COURSE CLEAR',
      sub: `100 ft in ${this.fmtTime(t)} · ${this.kills} drones · time bonus +${timeBonus.toLocaleString()}`,
      btn: 'Run it again',
    });
  }

  showOverlay({ title, sub, btn }) {
    const over = document.createElement('div');
    over.className = 'game-over';
    over.innerHTML = `
      <div class="game-over-card">
        <h2>${title}</h2>
        <div class="final">${this.score.toLocaleString()}</div>
        <div style="color:var(--dim);margin:-10px 0 16px;font-size:14px">${sub}</div>
        <button class="btn-primary" id="gr-again">${btn}</button>
        <button class="btn-secondary" id="gr-lb">🏆 Leaderboard</button>
      </div>
    `;
    this.hud.querySelector('.xr-hud').appendChild(over);
    over.querySelector('#gr-again').addEventListener('click', () => {
      over.remove();
      // in AR the player has to physically walk back to the start line
      if (this.xr) this.banner('WALK BACK TO THE START LINE', 2600);
      this.beginGame();
    });
    over.querySelector('#gr-lb').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('camfun:showleaderboard', { detail: { mode: 'gauntlet' } }));
    });
  }

  /* ---------------- effects (same family as Cover Fire) ---------------- */
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

  spark(pos, color) { this.burst(pos, color, 8, 2.2, 0.09, 0.35); }
  explode(pos, color) { this.burst(pos, color, 26, 3.6, 0.14, 0.7); }
  spawnFlash(pos) { this.burst(pos, COL.edge, 12, 1.6, 0.1, 0.4); }

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

    if (this.renderer.xr.isPresenting) {
      this.renderer.xr.getCamera().getWorldPosition(this.playerPos);
    } else if (!this.xr) {
      this.updateSim(dt);
      this.playerPos.copy(this.camera.position);
    }

    // XR floor placement reticle (aims the course away from the player)
    if (this.state === 'placing' && frame && this.hitTestSource) {
      const results = frame.getHitTestResults(this.hitTestSource);
      if (results.length) {
        const pose = results[0].getPose(this.renderer.xr.getReferenceSpace());
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
        // orient the direction arrow: course will run player→reticle
        this.tmpV.setFromMatrixPosition(this.reticle.matrix);
        const yaw = Math.atan2(this.playerPos.x - this.tmpV.x, this.playerPos.z - this.tmpV.z);
        this.reticle.matrix.makeRotationY(yaw).setPosition(this.tmpV);
      } else {
        this.reticle.visible = false;
      }
    }

    // deploy animation
    if (this.course.visible && this.course.scale.y < 1) {
      this.deployAnim = Math.min(1, this.deployAnim + dt * 2.2);
      const s = 1 - Math.pow(1 - this.deployAnim, 3);
      this.course.scale.set(1, Math.max(0.001, s), 1);
    }

    // heat dissipation
    this.heat = Math.max(0, (this.heat ?? 0) - dt * 0.38);
    if (this.overheated && this.heat < 0.35) {
      this.overheated = false;
      this.el.heat.classList.remove('hot');
    }
    if (this.el?.heat) this.el.heat.style.width = `${this.heat * 100}%`;

    if (this.state === 'run') {
      // hp regen after 4s without damage
      if (this.hp > 0 && this.hp < 100 && this.elapsed - this.lastHurt > 4) {
        this.hp = Math.min(100, this.hp + dt * 9);
        this.updateHpBar();
      }
      this.updateProgress(dt);
      this.updateEnemies(dt);
    }

    // gates: pulse when locked, dissolve when opened
    for (const gate of this.gates) {
      if (!gate.open) {
        gate.flash = Math.max(0, gate.flash - dt * 3);
        gate.plane.material.opacity =
          0.16 + Math.sin(this.elapsed * 3 + gate.z) * 0.05 + gate.flash * 0.45;
      } else if (gate.fade > 0) {
        gate.fade = Math.max(0, gate.fade - dt * 1.4);
        gate.plane.material.opacity = 0.35 * gate.fade;
        if (gate.fade === 0) gate.plane.visible = false;
      }
    }

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

  updateProgress(dt) {
    // player position in course-local space → distance down the corridor
    this.tmpV.copy(this.playerPos);
    this.course.worldToLocal(this.tmpV);
    const raw = -this.tmpV.z;                       // unclamped, for gate crossings
    this.progress = Math.max(0, Math.min(COURSE_L, raw));

    this.el.fill.style.width = `${(this.progress / COURSE_L) * 100}%`;
    this.el.dist.textContent = `${Math.round(this.progress * M_TO_FT)} ft`;
    this.el.time.textContent = this.fmtTime(this.armed ? this.elapsed - this.runStart : 0);

    // not armed yet: wait for the player to reach the start line
    if (!this.armed) {
      if (raw < 0.5) {
        this.armed = true;
        this.runStart = this.elapsed;
        this.banner('ZONE 1 — GO!', 2000);
        this.sfx.waveUp();
        this.spawnZone(0);
      }
      return;
    }

    // gate crossing: the end of the current zone
    const gate = this.gates[this.currentZone];
    const boundary = (this.currentZone + 1) * ZONE_L;
    if (raw > boundary + 0.05) {
      if (gate.open) {
        if (gate.isFinish) { this.win(); return; }
        this.currentZone++;
        this.spawnZone(this.currentZone);
        this.banner(`ZONE ${this.currentZone + 1}`, 1600);
        this.sfx.deploy();
      } else {
        // walked through a locked energy gate — it bites back
        this.wallHurtT -= dt;
        if (this.wallHurtT <= 0) {
          this.wallHurtT = 0.7;
          gate.flash = 1;
          this.damage(8);
          this.banner('⚠ GATE LOCKED — CLEAR THE DRONES', 1200);
        }
      }
    }
  }

  updateEnemies(dt) {
    const eyePos = new THREE.Vector3();
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];

      if (e.group.scale.x < 1) {
        e.group.scale.setScalar(Math.min(1, e.group.scale.x + dt * 3));
      } else if (e.group.scale.x > 1) {
        e.group.scale.setScalar(Math.max(1, e.group.scale.x - dt * 2));
      }

      e.bob += dt * 2.4;
      e.group.lookAt(this.playerPos);
      e.ring.rotation.z += dt * 3;

      if (e.state === 'move') {
        let dist = 0;
        if (e.isSentry) {
          // sentries hold position, just hover in place
          e.group.position.y += Math.sin(e.bob) * 0.0015;
        } else {
          this.tmpV.copy(e.waypoint);
          this.course.localToWorld(this.tmpV);
          this.tmpV.y = e.waypoint.y + this.course.position.y + Math.sin(e.bob) * 0.08;
          const d = this.tmpV2.copy(this.tmpV).sub(e.group.position);
          dist = d.length();
          if (dist > 0.08) {
            e.group.position.addScaledVector(d.normalize(), Math.min(dist, e.speed * dt));
          }
        }
        e.stateT -= dt;
        if (e.stateT <= 0) {
          e.eye.getWorldPosition(eyePos);
          if ((e.isSentry || dist < 0.4) && !this.losBlocked(eyePos, this.playerPos)) {
            e.state = 'aim';
            e.stateT = e.aimTime;
            e.aimBeam = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
              color: e.isSentry ? COL.sentry : COL.enemy, transparent: true, opacity: 0.12,
              blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            this.scene.add(e.aimBeam);
          } else {
            e.waypoint = this.pickWaypoint(e.zone);
            e.stateT = 0.6 + Math.random() * 1.6;
          }
        }
      } else if (e.state === 'aim') {
        e.eye.getWorldPosition(eyePos);
        if (this.losBlocked(eyePos, this.playerPos)) {
          this.scene.remove(e.aimBeam);
          e.aimBeam.material.dispose();
          e.aimBeam = null;
          e.state = 'move';
          e.waypoint = this.pickWaypoint(e.zone);
          e.stateT = 0.4;
          continue;
        }
        const len = eyePos.distanceTo(this.playerPos);
        e.aimBeam.scale.set(0.006, len, 0.006);
        e.aimBeam.position.copy(eyePos).lerp(this.playerPos, 0.5);
        this.tmpV.copy(this.playerPos).sub(eyePos).normalize();
        e.aimBeam.quaternion.setFromUnitVectors(UP, this.tmpV);
        e.aimBeam.material.opacity = 0.12 + (1 - e.stateT / e.aimTime) * 0.5;

        e.stateT -= dt;
        if (e.stateT <= 0) {
          this.scene.remove(e.aimBeam);
          e.aimBeam.material.dispose();
          e.aimBeam = null;
          this.enemyFire(e);
          e.state = 'move';
          e.waypoint = this.pickWaypoint(e.zone);
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
