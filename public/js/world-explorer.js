/**
 * WORLD EXPLORER — walk through anyone's scanned world.
 *
 * Desktop: pointer-lock mouse look + WASD fly.
 * Phone:   left-thumb joystick to move, drag right side to look.
 * AR:      optional diorama mode — the whole world shrinks onto your real
 *          floor and you walk around it like a model railway.
 */
import * as THREE from 'three';
import { decodePoints } from './world-format.js';

const EYE = 1.7;
const DIORAMA_SIZE = 1.4; // metres, longest side when placed on your floor

export class WorldExplorer {
  constructor({ container, hud, world, xr, onExit }) {
    this.container = container;
    this.hud = hud;
    this.world = world;   // { id, name, username, points, size, bounds }
    this.xr = xr;
    this.onExit = onExit;
    this.keys = {};
    this.yaw = 0; this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.joy = null;      // active joystick touch
    this.look = null;     // active look-drag touch
    this.upDown = 0;
    this._stopped = false;
    this.mode = 'walk';   // walk | ar
  }

  async start() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.Fog(0x05060a, 20, 130);
    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.02, 400);
    this.camera.rotation.order = 'YXZ';

    this.buildLoadingHUD();
    const { positions, colors, count } = await this.load();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    this.baseSize = 0.055;
    this.material = new THREE.PointsMaterial({ size: this.baseSize, vertexColors: true, sizeAttenuation: true });
    this.cloud = new THREE.Points(geo, this.material);
    this.cloud.frustumCulled = false;
    this.worldGroup = new THREE.Group();
    this.worldGroup.add(this.cloud);
    this.scene.add(this.worldGroup);

    geo.computeBoundingBox();
    this.bbox = geo.boundingBox;
    this.center = this.bbox.getCenter(new THREE.Vector3());

    // spawn where the scanner stood (the scan origin), eyes up, facing the middle
    this.camera.position.set(0, Math.max(this.bbox.min.y, 0) + EYE, 0);
    this.yaw = Math.atan2(-(this.center.x - 0), -(this.center.z - 0));
    if (!Number.isFinite(this.yaw)) this.yaw = 0;

    this._onResize = () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    this.isTouch = matchMedia('(pointer: coarse)').matches;
    this.buildHUD();
    if (this.isTouch) this.bindTouch();
    else this.bindDesktop();

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop((time, frame) => this.tick(time, frame));
  }

  async load() {
    const res = await fetch(`/api/worlds/${this.world.id}/data`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not load world (' + res.status + ')');
    const total = Number(res.headers.get('Content-Length')) || this.world.size || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      if (total) this.setLoadProgress(got / total);
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.byteLength; }
    return decodePoints(buf.buffer);
  }

  /* ---------------- HUD ---------------- */
  buildLoadingHUD() {
    this.hud.innerHTML = `
      <div class="save-dialog">
        <div class="save-card">
          <h3>🗺️ ${esc(this.world.name)}</h3>
          <p class="save-meta">by ${esc(this.world.username)} · ${(this.world.points || 0).toLocaleString()} points</p>
          <div class="save-progress"><div class="save-progress-fill" id="load-fill"></div></div>
        </div>
      </div>`;
  }

  setLoadProgress(f) {
    const el = this.hud.querySelector('#load-fill');
    if (el) el.style.width = Math.round(f * 100) + '%';
  }

  buildHUD() {
    const arBtn = this.xr ? '<button class="btn-ghost" id="exp-ar">◈ diorama AR</button>' : '';
    this.hud.innerHTML = `
      <div class="exp-top">
        <span class="exp-title">🗺️ ${esc(this.world.name)} <em>by ${esc(this.world.username)}</em></span>
        <span>${arBtn}<button class="btn-ghost" id="exp-exit">✖ leave</button></span>
      </div>
      <div class="scan-hint" id="exp-hint">${this.isTouch
        ? 'Left thumb = walk · drag right side = look'
        : 'Click to grab the mouse · WASD move · Space / C = up / down · Shift = fast'}</div>
      ${this.isTouch ? `
        <div class="joy" id="joy"><div class="joy-knob" id="joy-knob"></div></div>
        <div class="fly-btns">
          <button class="fly-btn" id="fly-up">▲</button>
          <button class="fly-btn" id="fly-down">▼</button>
        </div>` : ''}`;
    this.hud.querySelector('#exp-exit').addEventListener('click', () => this.stop());
    const ar = this.hud.querySelector('#exp-ar');
    if (ar) ar.addEventListener('click', () => this.enterDiorama().catch((err) => {
      this.setHint('AR failed: ' + err.message);
    }));
    if (this.isTouch) {
      const bindHold = (id, v) => {
        const b = this.hud.querySelector('#' + id);
        b.addEventListener('touchstart', (e) => { e.preventDefault(); this.upDown = v; }, { passive: false });
        b.addEventListener('touchend', () => { this.upDown = 0; });
      };
      bindHold('fly-up', 1);
      bindHold('fly-down', -1);
    }
  }

  setHint(msg) {
    const el = this.hud.querySelector('#exp-hint');
    if (el) el.textContent = msg;
  }

  /* ---------------- input: desktop ---------------- */
  bindDesktop() {
    const canvas = this.renderer.domElement;
    this._onKey = (e) => { this.keys[e.code] = e.type === 'keydown'; };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    this._onClick = () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); };
    canvas.addEventListener('click', this._onClick);
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * 0.0023;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.0023));
    };
    window.addEventListener('mousemove', this._onMouseMove);
  }

  /* ---------------- input: touch ---------------- */
  bindTouch() {
    const joyEl = this.hud.querySelector('#joy');
    const knob = this.hud.querySelector('#joy-knob');
    const area = this.hud; // whole overlay receives look-drags

    this._onTouchStart = (e) => {
      for (const t of e.changedTouches) {
        if (t.target.closest('button')) continue;
        if (t.clientX < window.innerWidth * 0.45 && !this.joy) {
          this.joy = { id: t.identifier, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0 };
          joyEl.style.left = (t.clientX - 60) + 'px';
          joyEl.style.top = (t.clientY - 60) + 'px';
          joyEl.classList.add('active');
        } else if (!this.look) {
          this.look = { id: t.identifier, x: t.clientX, y: t.clientY };
        }
      }
    };
    this._onTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (this.joy && t.identifier === this.joy.id) {
          const dx = t.clientX - this.joy.x0, dy = t.clientY - this.joy.y0;
          const len = Math.hypot(dx, dy), max = 52;
          const k = len > max ? max / len : 1;
          this.joy.dx = (dx * k) / max; this.joy.dy = (dy * k) / max;
          knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        } else if (this.look && t.identifier === this.look.id) {
          this.yaw -= (t.clientX - this.look.x) * 0.0042;
          this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - (t.clientY - this.look.y) * 0.0042));
          this.look.x = t.clientX; this.look.y = t.clientY;
        }
      }
      if (this.joy || this.look) e.preventDefault();
    };
    this._onTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        if (this.joy && t.identifier === this.joy.id) {
          this.joy = null;
          knob.style.transform = 'translate(0,0)';
          joyEl.classList.remove('active');
        }
        if (this.look && t.identifier === this.look.id) this.look = null;
      }
    };
    area.addEventListener('touchstart', this._onTouchStart, { passive: true });
    area.addEventListener('touchmove', this._onTouchMove, { passive: false });
    area.addEventListener('touchend', this._onTouchEnd);
    area.addEventListener('touchcancel', this._onTouchEnd);
  }

  /* ---------------- AR diorama ---------------- */
  async enterDiorama() {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: this.hud },
    });
    this.session = session;
    this.mode = 'ar';
    this.placed = false;

    const span = Math.max(
      this.bbox.max.x - this.bbox.min.x,
      this.bbox.max.y - this.bbox.min.y,
      this.bbox.max.z - this.bbox.min.z, 1);
    this.dioScale = DIORAMA_SIZE / span;
    this.worldGroup.visible = false;
    this.scene.background = null;
    this.scene.fog = null;

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.14, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.9 })
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.renderer.xr.enabled = true;
    try { this.renderer.xr.setReferenceSpaceType('local-floor'); }
    catch (e) { this.renderer.xr.setReferenceSpaceType('local'); }
    await this.renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    this._beforeSelect = (e) => {
      if (e.target.closest && e.target.closest('button')) e.preventDefault();
    };
    this.hud.addEventListener('beforexrselect', this._beforeSelect);
    this._onSelect = () => this.placeDiorama();
    session.addEventListener('select', this._onSelect);
    session.addEventListener('end', () => this.exitDiorama());

    this.setHint('Point at your floor, tap to place the world. Tap again to move it.');
  }

  placeDiorama() {
    if (!this.reticle?.visible) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
    const s = this.dioScale;
    this.worldGroup.scale.setScalar(s);
    // sit the world's lowest point on the tapped spot, centred on it
    this.worldGroup.position.set(
      pos.x - this.center.x * s,
      pos.y - this.bbox.min.y * s,
      pos.z - this.center.z * s);
    this.material.size = this.baseSize * s * 2.2;
    this.worldGroup.visible = true;
    this.placed = true;
  }

  exitDiorama() {
    if (this._stopped || this.mode !== 'ar') return;
    this.mode = 'walk';
    this.session = null;
    this.hitTestSource = null;
    this.renderer.xr.enabled = false;
    if (this.reticle) { this.scene.remove(this.reticle); this.reticle = null; }
    this.hud.removeEventListener('beforexrselect', this._beforeSelect || (() => {}));
    this.worldGroup.scale.setScalar(1);
    this.worldGroup.position.set(0, 0, 0);
    this.worldGroup.visible = true;
    this.material.size = this.baseSize;
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.Fog(0x05060a, 20, 130);
    this._onResize();
    this.setHint(this.isTouch ? 'Left thumb = walk · drag right side = look' : 'Click to grab the mouse · WASD move');
  }

  /* ---------------- per-frame ---------------- */
  tick(time, frame) {
    if (this._stopped) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);

    if (this.mode === 'ar') {
      if (frame && this.hitTestSource && this.reticle) {
        const hits = frame.getHitTestResults(this.hitTestSource);
        const refSpace = this.renderer.xr.getReferenceSpace();
        if (hits.length && refSpace) {
          const pose = hits[0].getPose(refSpace);
          this.reticle.visible = true;
          this.reticle.matrix.fromArray(pose.transform.matrix);
        } else {
          this.reticle.visible = false;
        }
      }
    } else {
      this.moveWalk(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  moveWalk(dt) {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    const fast = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const speed = fast ? 10 : 3.6;

    let fwd = 0, strafe = 0, up = 0;
    if (this.isTouch && this.joy) { fwd = -this.joy.dy; strafe = this.joy.dx; }
    else {
      fwd = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
      strafe = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
      up = (this.keys['Space'] ? 1 : 0) - (this.keys['KeyC'] ? 1 : 0);
    }
    up += this.upDown;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.vel.set(
      (strafe * cos - fwd * sin) * speed,
      up * speed * 0.8,
      (-fwd * cos - strafe * sin) * speed);
    this.camera.position.addScaledVector(this.vel, dt);

    // keep the flyer loosely inside the world
    const m = 25;
    const p = this.camera.position;
    p.x = Math.max(this.bbox.min.x - m, Math.min(this.bbox.max.x + m, p.x));
    p.z = Math.max(this.bbox.min.z - m, Math.min(this.bbox.max.z + m, p.z));
    p.y = Math.max(this.bbox.min.y - 3, Math.min(this.bbox.max.y + 40, p.y));
  }

  /* ---------------- teardown ---------------- */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.renderer.setAnimationLoop(null);
    try { this.session?.end(); } catch (e) { /* already ended */ }
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKey || (() => {}));
    window.removeEventListener('keyup', this._onKey || (() => {}));
    window.removeEventListener('mousemove', this._onMouseMove || (() => {}));
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.innerHTML = '';
    this.cloud?.geometry.dispose();
    this.material?.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
    this.onExit?.();
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
