import * as THREE from 'three';
import { SFX as BaseSFX, gridTexture, glowTexture } from './xr-shooter.js';
import { HOLES, BALL_RADIUS } from './minigolf-holes.js';

/* ⛳ MINI-GOLF — 18 hand-designed holes, tabletop-scale AR.
 *
 * AR mode: tap your real tabletop once to anchor the whole round there.
 * Each hole's geometry loads at that same anchor as you advance — the
 * course isn't re-placed per hole. Drag-to-putt: pull back, release to shoot,
 * same direction/power convention as a slingshot.
 *
 * Sim mode (no AR support — most phones/tablets land here): the course
 * sits on a rendered elevated table stand you orbit around freely, like
 * walking around a table. A finger/click on the ball putts; a finger/click
 * anywhere else orbits; pinch or scroll zooms.
 */

const COL = { green: 0x1c6b3a, wall: 0x0e1420, edge: 0x34e1ff, water: 0x1670c9, sand: 0xd8b979, cup: 0x05070c };
const FRICTION = 0.9;
const SAND_FRICTION = 3.4;
const RESTITUTION = 0.62;
const MAX_PUTT_SPEED = 2.6;
const REST_SPEED = 0.02;
const SINK_SPEED = 0.9;
const WALL_H = 0.006; // collision half-thickness of interior walls/perimeter

class SFX extends BaseSFX {
  putt()        { this.blip({ type: 'triangle', f0: 500, f1: 220, dur: 0.1,  vol: 0.22, noise: 0.05 }); }
  wallBounce()  { this.blip({ type: 'square',   f0: 700, f1: 380, dur: 0.05, vol: 0.12 }); }
  splash()      { this.blip({ type: 'sine',     f0: 320, f1: 60,  dur: 0.35, vol: 0.22, noise: 0.3 }); }
  sink()        { this.blip({ type: 'sine',     f0: 700, f1: 1400, dur: 0.4, vol: 0.28 }); }
  holeAdvance() { this.blip({ type: 'sine',     f0: 440, f1: 880, dur: 0.25, vol: 0.16 }); }
}

/* ---------------- 2D geometry helpers (green-local XZ plane) ---------------- */
function closestOnSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - x1) * dx + (pz - z1) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + dx * t, z: z1 + dz * t };
}

function closestOnRect(px, pz, rx, rz, rw, rd, rot = 0) {
  // transform point into the rect's local (unrotated) space, clamp, transform back
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = (px - rx) * c - (pz - rz) * s;
  const lz = (px - rx) * s + (pz - rz) * c;
  const cx = Math.max(-rw / 2, Math.min(rw / 2, lx));
  const cz = Math.max(-rd / 2, Math.min(rd / 2, lz));
  const c2 = Math.cos(rot), s2 = Math.sin(rot);
  return { x: rx + cx * c2 - cz * s2, z: rz + cx * s2 + cz * c2, inside: lx > -rw / 2 && lx < rw / 2 && lz > -rd / 2 && lz < rd / 2 };
}

function pointInRect(px, pz, rx, rz, rw, rd, rot = 0) {
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = (px - rx) * c - (pz - rz) * s;
  const lz = (px - rx) * s + (pz - rz) * c;
  return lx >= -rw / 2 && lx <= rw / 2 && lz >= -rd / 2 && lz <= rd / 2;
}

/* ================================================================ */
export class MiniGolfGame {
  constructor({ container, hud, xr, onExit }) {
    this.container = container;
    this.hud = hud;
    this.xr = xr;
    this.onExit = onExit;
    this.sfx = new SFX();
    this.glowTex = glowTexture();
    this.gridTex = gridTexture();
    this._stopped = false;
    this.placed = false;
    this.arPhase = 'searching'; // AR only: 'searching' | 'preview' | 'confirmed'
    this._freshPlacement = true; // whether the next Place should start a new round
    this.holeIndex = 0;
    this.scorecard = []; // strokes per hole
    this.effects = [];
    this.decor = [];
    this.ballPos = { x: 0, z: 0 };
    this.ballVel = { x: 0, z: 0 };
    this.lastRest = { x: 0, z: 0 };
    this.resting = true;
    this.awaitingInput = false;
  }

  /* ---------------- lifecycle ---------------- */
  async start() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.02, 30);
    this.camera.rotation.order = 'YXZ';

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x30405a, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 5, 3);
    this.scene.add(dir);

    this.courseGroup = new THREE.Group();
    this.courseGroup.visible = false;
    this.scene.add(this.courseGroup);

    this.buildBall();
    this.buildTableStand();
    this.buildHUD();
    this.bindPuttInput();

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

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.03, 0.04, 32).rotateX(-Math.PI / 2),
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

    this._beforeSelect = (e) => {
      if (e.target.closest && e.target.closest('button')) e.preventDefault();
    };
    this.hud.addEventListener('beforexrselect', this._beforeSelect);
    this._onSelect = () => this.arPlaceHere();
    session.addEventListener('select', this._onSelect);
    session.addEventListener('end', () => { if (!this._stopped) this.stop(); });

    this.sfx.ensure();
    this.updatePlacementHUD();
    this.setHint('Point your phone at the floor — tap or press Place');
  }

  startSim() {
    this.simOrbit = { theta: 0.6, phi: 0.85, radius: 1.8 };
    this._onWheel = (e) => {
      e.preventDefault();
      this.simOrbit.radius = Math.max(0.6, Math.min(2.8, this.simOrbit.radius + e.deltaY * 0.0015));
    };
    this.renderer.domElement.addEventListener('wheel', this._onWheel, { passive: false });
    this._onCtxMenu = (e) => e.preventDefault();
    this.renderer.domElement.addEventListener('contextmenu', this._onCtxMenu);

    this.placeCourse(new THREE.Vector3(0, 0, 0));
    this.setHint('Drag the ball to putt · drag anywhere else to walk around · pinch/scroll to zoom');
  }

  /* ---------------- placement (sim: instant; AR: see arPlaceHere/arConfirm/arReposition/arReset) ---------------- */
  placeCourse(pos) {
    this.courseGroup.position.copy(pos);
    this.courseGroup.rotation.y = 0;
    this.courseGroup.visible = true;
    this.placed = true;
    if (this.reticle) this.reticle.visible = false;
    this.sfx.deploy ? this.sfx.deploy() : this.sfx.holeAdvance();
    this.beginRound();
  }

  beginRound() {
    this.holeIndex = 0;
    this.scorecard = [];
    this.loadHole(0);
  }

  /* ---------------- AR placement flow ----------------
   * searching (reticle follows the detected floor) -> preview (translucent
   * table dropped at the tapped spot, rotate/scale adjustable) -> confirmed
   * (locked anchor, full gameplay, walk around freely — real device tracking).
   */
  arPlaceHere() {
    if (this.arPhase !== 'searching' || !this.reticle?.visible) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
    this.courseGroup.position.copy(pos);
    this.courseGroup.visible = true;
    this.reticle.visible = false;
    this.arPhase = 'preview';
    if (this._freshPlacement) {
      this.courseGroup.rotation.y = 0;
      this.courseGroup.scale.setScalar(1);
      this.beginRound();
      this._freshPlacement = false;
    }
    this.setPreviewTranslucent(true);
    this.updatePlacementHUD();
    this.setHint('Drag to rotate · pinch to resize · tap Confirm when ready');
  }

  arConfirm() {
    if (this.arPhase !== 'preview') return;
    this.setPreviewTranslucent(false);
    this.arPhase = 'confirmed';
    this.placed = true;
    this.updatePlacementHUD();
    this.setHint('Walk around the table — drag the ball to putt');
    this.sfx.holeAdvance();
  }

  arReposition() {
    if (this.arPhase === 'searching') return;
    this.placed = false;
    this.setPreviewTranslucent(false);
    this.courseGroup.visible = false;
    this.arPhase = 'searching';
    this.updatePlacementHUD();
    this.setHint('Point your phone at the floor — tap or press Place');
  }

  arReset() {
    this.placed = false;
    this.setPreviewTranslucent(false);
    this.courseGroup.visible = false;
    this.courseGroup.rotation.y = 0;
    this.courseGroup.scale.setScalar(1);
    this._freshPlacement = true;
    this.arPhase = 'searching';
    this.updatePlacementHUD();
    this.setHint('Point your phone at the floor — tap or press Place');
  }

  /** dim every material in the placed course so it reads as a not-yet-confirmed ghost */
  setPreviewTranslucent(on) {
    this.courseGroup.traverse((obj) => {
      const mat = obj.material;
      if (!mat) return;
      if (on) {
        if (mat._origOpacity === undefined) {
          mat._origOpacity = mat.opacity;
          mat._origTransparent = mat.transparent;
        }
        mat.transparent = true;
        mat.opacity = Math.min(mat._origOpacity, 0.5);
      } else if (mat._origOpacity !== undefined) {
        mat.opacity = mat._origOpacity;
        mat.transparent = mat._origTransparent;
      }
    });
  }

  updatePlacementHUD() {
    if (!this.xr || !this.el?.place) return;
    const phase = this.arPhase;
    this.el.place.classList.toggle('hidden', phase !== 'searching');
    this.el.confirm.classList.toggle('hidden', phase !== 'preview');
    this.el.reposition.classList.toggle('hidden', phase === 'searching');
    this.el.reset.classList.toggle('hidden', phase === 'searching');
  }

  /* ---------------- ball ---------------- */
  buildBall() {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.05, emissive: 0x113344, emissiveIntensity: 0.4 });
    this.ballMesh = new THREE.Mesh(geo, mat);
    this.courseGroup.add(this.ballMesh);
  }

  /* ---------------- table stand ----------------
   * A rendered, walk-around-able elevated stand the course sits on — built
   * once, sized to comfortably fit every hole. Shown in both modes: in AR
   * the player aims at real floor, and this stand is what supplies the
   * waist-height playing surface (rather than requiring a real table).
   */
  buildTableStand() {
    const TABLE_W = 1.55, TABLE_D = 0.85, THICK = 0.03, LEG_H = 0.75, INSET = 0.07;
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: COL.wall, roughness: 0.5, metalness: 0.35 });
    const edgeMat = new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.75 });

    const slabGeo = new THREE.BoxGeometry(TABLE_W, THICK, TABLE_D);
    const slab = new THREE.Mesh(slabGeo, bodyMat);
    slab.position.y = -THICK / 2 - 0.001;
    slab.add(new THREE.LineSegments(new THREE.EdgesGeometry(slabGeo), edgeMat));
    g.add(slab);

    const legGeo = new THREE.BoxGeometry(0.05, LEG_H, 0.05);
    const legX = TABLE_W / 2 - INSET, legZ = TABLE_D / 2 - INSET, legY = -THICK - LEG_H / 2;
    for (const [x, z] of [[legX, legZ], [-legX, legZ], [legX, -legZ], [-legX, -legZ]]) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(x, legY, z);
      leg.add(new THREE.LineSegments(new THREE.EdgesGeometry(legGeo), edgeMat));
      g.add(leg);
    }

    const floorSpan = Math.min(TABLE_W, TABLE_D) * 0.95;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(floorSpan * 0.45, floorSpan * 0.52, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
    );
    ring.position.y = -THICK - LEG_H + 0.001;
    g.add(ring);

    this.tableStand = g;
    this.courseGroup.add(g);
  }

  /* ---------------- hole load / geometry ---------------- */
  loadHole(index) {
    if (this.holeGroup) {
      this.courseGroup.remove(this.holeGroup);
      this.holeGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    this.decor = [];
    const def = HOLES[index];
    this.currentHole = def;
    this.holeStrokes = 0;
    this.holeGroup = this.buildHoleGeometry(def);
    this.courseGroup.add(this.holeGroup);

    this.ballPos.x = def.tee[0];
    this.ballPos.z = def.tee[1];
    this.ballVel.x = 0; this.ballVel.z = 0;
    this.resting = true;
    this.lastRest.x = def.tee[0]; this.lastRest.z = def.tee[1];
    this.awaitingInput = true;
    this.ballMesh.position.set(this.ballPos.x, BALL_RADIUS, this.ballPos.z);

    this.updateHudHole();
    if (index > 0) this.sfx.holeAdvance();
  }

  buildHoleGeometry(def) {
    const g = new THREE.Group();
    const { w, d } = def;

    const green = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: COL.green, roughness: 0.85, map: this.gridTex, transparent: true, opacity: 1 })
    );
    green.position.y = 0;
    g.add(green);

    this.walls = []; // {x1,z1,x2,z2}
    this.obstacles = []; // {kind:'circle'|'rect', ...}
    this.ramps = def.ramps || [];
    this.hazards = def.hazards || [];

    const wallMat = new THREE.MeshStandardMaterial({ color: COL.wall, roughness: 0.5, metalness: 0.3 });
    const addWallMesh = (x1, z1, x2, z2, h) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, WALL_H * 2), wallMat);
      mesh.position.set((x1 + x2) / 2, h / 2, (z1 + z2) / 2);
      mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.7 }));
      mesh.add(edges);
      g.add(mesh);
      this.walls.push({ x1, z1, x2, z2 });
    };

    // perimeter (implicit closed rectangle)
    const hw = w / 2, hd = d / 2, ph = 0.03;
    addWallMesh(-hw, -hd, hw, -hd, ph);
    addWallMesh(hw, -hd, hw, hd, ph);
    addWallMesh(hw, hd, -hw, hd, ph);
    addWallMesh(-hw, hd, -hw, -hd, ph);

    for (const wDef of (def.walls || [])) addWallMesh(wDef.x1, wDef.z1, wDef.x2, wDef.z2, wDef.h || 0.04);

    for (const o of (def.obstacles || [])) {
      if (o.type === 'cylinder') {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(o.radius, o.radius, o.h || 0.05, 16), wallMat);
        mesh.position.set(o.x, (o.h || 0.05) / 2, o.z);
        g.add(mesh);
        this.obstacles.push({ kind: 'circle', x: o.x, z: o.z, r: o.radius });
      } else {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h || 0.05, o.d), wallMat);
        mesh.position.set(o.x, (o.h || 0.05) / 2, o.z);
        mesh.rotation.y = o.rotY || 0;
        g.add(mesh);
        this.obstacles.push({ kind: 'rect', x: o.x, z: o.z, w: o.w, d: o.d, rot: o.rotY || 0 });
      }
    }

    for (const r of this.ramps) {
      const norm = Math.hypot(r.dir[0], r.dir[1]) || 1;
      r._dx = r.dir[0] / norm; r._dz = r.dir[1] / norm;
      const tint = new THREE.Mesh(
        new THREE.PlaneGeometry(r.w, r.d).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffa64d, transparent: true, opacity: 0.16 })
      );
      tint.position.set(r.x, 0.004, r.z);
      tint.rotation.y = r.rotY || 0;
      g.add(tint);
    }

    for (const h of this.hazards) {
      const color = h.type === 'water' ? COL.water : COL.sand;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(h.w, h.d).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: h.type === 'water' ? 0.65 : 0.55 })
      );
      mesh.position.set(h.x, 0.003, h.z);
      g.add(mesh);
    }

    for (const dcr of (def.decor || [])) {
      if (dcr.type === 'spinner') {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8), wallMat);
        post.position.set(dcr.x, 0.025, dcr.z);
        g.add(post);
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(dcr.radius * 2, 0.008, 0.016),
          new THREE.MeshStandardMaterial({ color: COL.edge, roughness: 0.4 })
        );
        blade.position.set(dcr.x, 0.05, dcr.z);
        g.add(blade);
        this.decor.push({ mesh: blade, speed: dcr.speed });
      }
    }

    // cup + flagstick
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(def.cupRadius, def.cupRadius, 0.012, 20), new THREE.MeshBasicMaterial({ color: COL.cup }));
    cup.position.set(def.cup[0], 0.001, def.cup[1]);
    g.add(cup);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.16, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    stick.position.set(def.cup[0], 0.08, def.cup[1]);
    g.add(stick);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.032), new THREE.MeshBasicMaterial({ color: 0xff3355, side: THREE.DoubleSide }));
    flag.position.set(def.cup[0] + 0.026, 0.145, def.cup[1]);
    g.add(flag);

    // tee marker
    const tee = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.016, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    tee.position.set(def.tee[0], 0.002, def.tee[1]);
    g.add(tee);

    return g;
  }

  /* ---------------- input ----------------
   * One finger on the ball putts; one finger anywhere else either walks the
   * sim camera around the table, or — during AR preview — rotates the
   * placed-but-not-yet-confirmed table; two fingers pinch to zoom (sim) or
   * resize (AR preview). Works identically for touch and mouse since it's
   * driven entirely by ball-screen-proximity, not click buttons.
   */
  bindPuttInput() {
    const el = this.hud;
    const pointers = new Map(); // pointerId -> {x,y}
    let mode = null; // 'putt' | 'orbit' | 'rotate' | 'pinch'
    let dragPointerId = null;
    let puttStart = null;
    let dragLast = null;
    let pinchStart = null; // {dist, radius?, scale?}

    const flatAxes = () => {
      const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
      const q = new THREE.Quaternion();
      cam.getWorldQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q); right.y = 0; right.normalize();
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q); fwd.y = 0; fwd.normalize();
      return { right, fwd };
    };

    const ballScreenPos = () => {
      const v = new THREE.Vector3();
      this.ballMesh.getWorldPosition(v);
      const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
      v.project(cam);
      return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
    };

    const pinchDist = () => {
      const pts = [...pointers.values()];
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    const finishPutt = (x, y) => {
      const dx = x - puttStart.x, dy = y - puttStart.y;
      const len = Math.hypot(dx, dy);
      if (len > 8) {
        const { right, fwd } = flatAxes();
        const pull = new THREE.Vector3().addScaledVector(right, dx).addScaledVector(fwd, -dy);
        if (pull.lengthSq() > 1e-6) {
          pull.normalize().multiplyScalar(-1); // shoot opposite of pull
          const local = pull.clone().applyQuaternion(this.courseGroup.quaternion.clone().invert());
          this.putt(local.x, local.z, Math.min(1, len / 220));
        }
      }
      this.showPowerMeter(false);
    };

    const canAdjustPlacement = () => this.xr && this.arPhase === 'preview';

    this._onDown = (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        const canPutt = this.awaitingInput && this.placed;
        const nearBall = canPutt && (this.xr || Math.hypot(e.clientX - ballScreenPos().x, e.clientY - ballScreenPos().y) < 70);
        if (nearBall) {
          mode = 'putt';
          dragPointerId = e.pointerId;
          puttStart = { x: e.clientX, y: e.clientY };
          this.setPowerMeter(0);
          this.showPowerMeter(true);
        } else if (canAdjustPlacement()) {
          mode = 'rotate';
          dragPointerId = e.pointerId;
          dragLast = { x: e.clientX, y: e.clientY };
        } else if (!this.xr) {
          mode = 'orbit';
          dragPointerId = e.pointerId;
          dragLast = { x: e.clientX, y: e.clientY };
        } else {
          mode = null;
        }
      } else if (pointers.size === 2 && (!this.xr || canAdjustPlacement())) {
        if (mode === 'putt') this.showPowerMeter(false);
        mode = 'pinch';
        pinchStart = { dist: pinchDist(), radius: this.simOrbit?.radius, scale: this.courseGroup.scale.x };
      }
    };

    this._onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mode === 'pinch' && pointers.size >= 2) {
        const d = pinchDist();
        if (d > 1) {
          if (this.xr) this.courseGroup.scale.setScalar(Math.max(0.7, Math.min(1.5, pinchStart.scale * (d / pinchStart.dist))));
          else this.simOrbit.radius = Math.max(0.6, Math.min(2.8, pinchStart.radius * (pinchStart.dist / d)));
        }
      } else if (mode === 'orbit' && e.pointerId === dragPointerId) {
        const dx = e.clientX - dragLast.x, dy = e.clientY - dragLast.y;
        this.simOrbit.theta -= dx * 0.006;
        this.simOrbit.phi = Math.max(0.28, Math.min(1.45, this.simOrbit.phi - dy * 0.006));
        dragLast = { x: e.clientX, y: e.clientY };
      } else if (mode === 'rotate' && e.pointerId === dragPointerId) {
        this.courseGroup.rotation.y += (e.clientX - dragLast.x) * 0.008;
        dragLast = { x: e.clientX, y: e.clientY };
      } else if (mode === 'putt' && e.pointerId === dragPointerId) {
        this.setPowerMeter(Math.min(1, Math.hypot(e.clientX - puttStart.x, e.clientY - puttStart.y) / 220));
      }
    };

    this._onUp = (e) => {
      pointers.delete(e.pointerId);

      if (mode === 'putt' && e.pointerId === dragPointerId) {
        finishPutt(e.clientX, e.clientY);
        mode = null; dragPointerId = null; puttStart = null;
      } else if (mode === 'pinch' && pointers.size < 2) {
        const remainingId = [...pointers.keys()][0];
        const remainingPos = pointers.get(remainingId);
        if (remainingPos && canAdjustPlacement()) { mode = 'rotate'; dragPointerId = remainingId; dragLast = remainingPos; }
        else if (remainingPos && !this.xr) { mode = 'orbit'; dragPointerId = remainingId; dragLast = remainingPos; }
        else mode = null;
      } else if (pointers.size === 0) {
        mode = null;
      }
    };

    el.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  putt(dirX, dirZ, power) {
    const speed = Math.max(0.25, power) * MAX_PUTT_SPEED;
    this.ballVel.x = dirX * speed;
    this.ballVel.z = dirZ * speed;
    this.resting = false;
    this.awaitingInput = false;
    this.holeStrokes++;
    this.updateHudHole();
    this.sfx.putt();
    if (navigator.vibrate) navigator.vibrate(15);
  }

  /* ---------------- physics ---------------- */
  integrateBall(dt) {
    if (this.resting) return;
    const def = this.currentHole;

    for (const r of this.ramps) {
      if (pointInRect(this.ballPos.x, this.ballPos.z, r.x, r.z, r.w, r.d, r.rotY || 0)) {
        this.ballVel.x += r._dx * r.accel * dt;
        this.ballVel.z += r._dz * r.accel * dt;
      }
    }

    let friction = FRICTION;
    let inSand = false;
    for (const h of this.hazards) {
      if (h.type === 'sand' && pointInRect(this.ballPos.x, this.ballPos.z, h.x, h.z, h.w, h.d)) inSand = true;
    }
    if (inSand) friction = SAND_FRICTION;
    const decay = Math.exp(-friction * dt);
    this.ballVel.x *= decay; this.ballVel.z *= decay;

    this.ballPos.x += this.ballVel.x * dt;
    this.ballPos.z += this.ballVel.z * dt;

    // perimeter + interior walls
    const hw = def.w / 2, hd = def.d / 2;
    if (this.ballPos.x - BALL_RADIUS < -hw) { this.ballPos.x = -hw + BALL_RADIUS; this.ballVel.x = -this.ballVel.x * RESTITUTION; this.sfx.wallBounce(); }
    if (this.ballPos.x + BALL_RADIUS > hw)  { this.ballPos.x = hw - BALL_RADIUS;  this.ballVel.x = -this.ballVel.x * RESTITUTION; this.sfx.wallBounce(); }
    if (this.ballPos.z - BALL_RADIUS < -hd) { this.ballPos.z = -hd + BALL_RADIUS; this.ballVel.z = -this.ballVel.z * RESTITUTION; this.sfx.wallBounce(); }
    if (this.ballPos.z + BALL_RADIUS > hd)  { this.ballPos.z = hd - BALL_RADIUS;  this.ballVel.z = -this.ballVel.z * RESTITUTION; this.sfx.wallBounce(); }

    for (const wSeg of this.walls) {
      const cp = closestOnSegment(this.ballPos.x, this.ballPos.z, wSeg.x1, wSeg.z1, wSeg.x2, wSeg.z2);
      const dx = this.ballPos.x - cp.x, dz = this.ballPos.z - cp.z;
      const dist = Math.hypot(dx, dz);
      const minDist = BALL_RADIUS + WALL_H;
      if (dist < minDist && dist > 1e-6) {
        const nx = dx / dist, nz = dz / dist;
        this.ballPos.x = cp.x + nx * minDist;
        this.ballPos.z = cp.z + nz * minDist;
        const vDotN = this.ballVel.x * nx + this.ballVel.z * nz;
        if (vDotN < 0) {
          this.ballVel.x -= (1 + RESTITUTION) * vDotN * nx;
          this.ballVel.z -= (1 + RESTITUTION) * vDotN * nz;
          this.sfx.wallBounce();
        }
      }
    }

    for (const o of this.obstacles) {
      let cp, minDist;
      if (o.kind === 'circle') {
        const dx0 = this.ballPos.x - o.x, dz0 = this.ballPos.z - o.z;
        const d0 = Math.hypot(dx0, dz0) || 1e-6;
        cp = { x: o.x + (dx0 / d0) * o.r, z: o.z + (dz0 / d0) * o.r };
        minDist = BALL_RADIUS;
      } else {
        cp = closestOnRect(this.ballPos.x, this.ballPos.z, o.x, o.z, o.w, o.d, o.rot);
        minDist = BALL_RADIUS;
      }
      const dx = this.ballPos.x - cp.x, dz = this.ballPos.z - cp.z;
      const dist = Math.hypot(dx, dz);
      if (dist < minDist && dist > 1e-6) {
        const nx = dx / dist, nz = dz / dist;
        this.ballPos.x = cp.x + nx * minDist;
        this.ballPos.z = cp.z + nz * minDist;
        const vDotN = this.ballVel.x * nx + this.ballVel.z * nz;
        if (vDotN < 0) {
          this.ballVel.x -= (1 + RESTITUTION) * vDotN * nx;
          this.ballVel.z -= (1 + RESTITUTION) * vDotN * nz;
          this.sfx.wallBounce();
        }
      }
    }

    // water hazard: instant penalty + reset
    for (const h of this.hazards) {
      if (h.type === 'water' && pointInRect(this.ballPos.x, this.ballPos.z, h.x, h.z, h.w, h.d)) {
        this.sfx.splash();
        this.holeStrokes++;
        this.updateHudHole();
        this.banner('SPLASH! +1', 1400);
        this.ballPos.x = this.lastRest.x; this.ballPos.z = this.lastRest.z;
        this.ballVel.x = 0; this.ballVel.z = 0;
        this.resting = true;
        this.awaitingInput = true;
        return;
      }
    }

    // cup check
    const cdx = this.ballPos.x - def.cup[0], cdz = this.ballPos.z - def.cup[1];
    const cdist = Math.hypot(cdx, cdz);
    const speed = Math.hypot(this.ballVel.x, this.ballVel.z);
    if (cdist < def.cupRadius - BALL_RADIUS * 0.5 && speed < SINK_SPEED) {
      this.sinkHole();
      return;
    }

    if (speed < REST_SPEED) {
      this.ballVel.x = 0; this.ballVel.z = 0;
      this.resting = true;
      this.awaitingInput = true;
      this.lastRest.x = this.ballPos.x; this.lastRest.z = this.ballPos.z;
    }
  }

  sinkHole() {
    this.resting = true;
    this.ballVel.x = 0; this.ballVel.z = 0;
    this.sfx.sink();
    this.burst({ x: this.currentHole.cup[0], y: 0.02, z: this.currentHole.cup[1] }, COL.edge);
    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    this.scorecard[this.holeIndex] = this.holeStrokes;
    const par = this.currentHole.par;
    const rel = this.holeStrokes - par;
    const label = rel <= -2 ? 'EAGLE!' : rel === -1 ? 'BIRDIE!' : rel === 0 ? 'PAR' : rel === 1 ? 'BOGEY' : 'IN THE HOLE';
    this.banner(`${label} · ${this.holeStrokes} strokes`, 1800);
    setTimeout(() => {
      if (this._stopped) return;
      if (this.holeIndex + 1 < HOLES.length) {
        this.holeIndex++;
        this.loadHole(this.holeIndex);
      } else {
        this.finishRound();
      }
    }, 1500);
  }

  finishRound() {
    let total = 0;
    for (let i = 0; i < HOLES.length; i++) {
      const par = HOLES[i].par;
      const strokes = this.scorecard[i] ?? par * 2;
      total += Math.max(0, Math.min(par * 2, par * 2 - strokes));
    }
    const score = Math.round(total * 10);
    window.dispatchEvent(new CustomEvent('camfun:score', { detail: { mode: 'minigolf', score } }));

    const rows = HOLES.map((h, i) => `<tr><td>${h.id}</td><td>${h.par}</td><td>${this.scorecard[i] ?? '–'}</td></tr>`).join('');
    const over = document.createElement('div');
    over.className = 'game-over';
    over.innerHTML = `
      <div class="game-over-card mg-scorecard">
        <h2>⛳ ROUND COMPLETE</h2>
        <div class="final">${score.toLocaleString()}</div>
        <table class="mg-table"><thead><tr><th>Hole</th><th>Par</th><th>Strokes</th></tr></thead><tbody>${rows}</tbody></table>
        <button class="btn-primary" id="mg-again">Play Again</button>
        <button class="btn-secondary" id="mg-lb">🏆 Leaderboard</button>
      </div>`;
    this.hud.querySelector('.mg-hud').appendChild(over);
    over.querySelector('#mg-again').addEventListener('click', () => { over.remove(); this.beginRound(); });
    over.querySelector('#mg-lb').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('camfun:showleaderboard', { detail: { mode: 'minigolf' } }));
    });
  }

  /* ---------------- effects ---------------- */
  burst(pos, color) {
    const count = 18;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    const vels = [];
    for (let i = 0; i < count; i++) {
      arr.set([pos.x, pos.y, pos.z], i * 3);
      vels.push(new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.6, (Math.random() - 0.5)).normalize().multiplyScalar(0.5 + Math.random() * 0.6));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ map: this.glowTex, color, size: 0.02, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.holeGroup.add(pts);
    this.effects.push({ mesh: pts, vels, life: 0.6, maxLife: 0.6 });
  }

  /* ---------------- HUD ---------------- */
  buildHUD() {
    const placementControls = this.xr ? `
      <div class="mg-placement" id="mg-placement">
        <button class="btn-primary" id="mg-place" disabled>Place</button>
        <button class="btn-primary hidden" id="mg-confirm">Confirm</button>
        <button class="btn-ghost hidden" id="mg-reposition">Reposition</button>
      </div>
      <button class="exit-btn hud-reset hidden" id="mg-reset" title="Reset placement">⟲</button>
    ` : '';
    this.hud.innerHTML = `
      <div class="mg-hud">
        <div class="mg-top">
          <span class="mg-holeinfo" id="mg-holeinfo">Hole 1/18 · Par 3</span>
          <span class="mg-strokes" id="mg-strokes">0</span>
        </div>
        <div class="power-wrap hidden" id="mg-power-wrap"><div class="power-bar" id="mg-power"></div></div>
        <div class="hud-banner hidden" id="mg-banner"></div>
        <div class="hud-hint" id="mg-hint"></div>
        ${placementControls}
        <button class="exit-btn hud-exit" id="mg-exit">✕</button>
      </div>
    `;
    this.el = {
      holeinfo: this.hud.querySelector('#mg-holeinfo'),
      strokes: this.hud.querySelector('#mg-strokes'),
      powerWrap: this.hud.querySelector('#mg-power-wrap'),
      power: this.hud.querySelector('#mg-power'),
      banner: this.hud.querySelector('#mg-banner'),
      hint: this.hud.querySelector('#mg-hint'),
      place: this.hud.querySelector('#mg-place'),
      confirm: this.hud.querySelector('#mg-confirm'),
      reposition: this.hud.querySelector('#mg-reposition'),
      reset: this.hud.querySelector('#mg-reset'),
    };
    this.hud.querySelector('#mg-exit').addEventListener('click', () => this.stop());
    if (this.xr) {
      this.el.place.addEventListener('click', () => this.arPlaceHere());
      this.el.confirm.addEventListener('click', () => this.arConfirm());
      this.el.reposition.addEventListener('click', () => this.arReposition());
      this.el.reset.addEventListener('click', () => this.arReset());
    }
  }

  updateHudHole() {
    if (!this.el) return;
    this.el.holeinfo.textContent = `Hole ${this.holeIndex + 1}/${HOLES.length} · Par ${this.currentHole.par}`;
    this.el.strokes.textContent = this.holeStrokes;
  }

  setPowerMeter(f) { if (this.el) this.el.power.style.width = Math.round(f * 100) + '%'; }
  showPowerMeter(on) { if (this.el) this.el.powerWrap.classList.toggle('hidden', !on); }

  setHint(text) {
    this.el.hint.textContent = text || '';
    this.el.hint.classList.toggle('hidden', !text);
  }

  banner(text, ms = 1600) {
    this.el.banner.textContent = text;
    this.el.banner.classList.remove('hidden');
    clearTimeout(this._bannerT);
    if (ms) this._bannerT = setTimeout(() => this.el.banner.classList.add('hidden'), ms);
  }

  /* ---------------- main loop ---------------- */
  tick(frame) {
    if (this._stopped) return;
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.arPhase === 'searching' && frame && this.hitTestSource && this.reticle) {
      const hits = frame.getHitTestResults(this.hitTestSource);
      const refSpace = this.renderer.xr.getReferenceSpace();
      if (hits.length && refSpace) {
        const pose = hits[0].getPose(refSpace);
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        this.reticle.visible = false;
      }
      if (this.el?.place) this.el.place.disabled = !this.reticle.visible;
    }

    if (!this.renderer.xr.isPresenting) this.updateSimCamera();

    if (this.placed) {
      this.integrateBall(dt);
      this.ballMesh.position.set(this.ballPos.x, BALL_RADIUS, this.ballPos.z);
      for (const d of this.decor) d.mesh.rotation.y += d.speed * dt;
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        this.holeGroup?.remove(fx.mesh);
        fx.mesh.geometry.dispose(); fx.mesh.material.dispose();
        this.effects.splice(i, 1);
        continue;
      }
      const pos = fx.mesh.geometry.attributes.position;
      for (let j = 0; j < fx.vels.length; j++) {
        pos.array[j * 3] += fx.vels[j].x * dt;
        pos.array[j * 3 + 1] += fx.vels[j].y * dt;
        pos.array[j * 3 + 2] += fx.vels[j].z * dt;
      }
      pos.needsUpdate = true;
      fx.mesh.material.opacity = Math.max(0, fx.life / fx.maxLife);
    }

    this.renderer.render(this.scene, this.camera);
  }

  updateSimCamera() {
    const { theta, phi, radius } = this.simOrbit;
    const target = this.courseGroup.position;
    this.camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi) + 0.15,
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    this.camera.lookAt(target.x, target.y, target.z);
  }

  /* ---------------- teardown ---------------- */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.renderer.setAnimationLoop(null);
    try { this.session?.end(); } catch (e) { /* already ended */ }
    if (this._beforeSelect) this.hud.removeEventListener('beforexrselect', this._beforeSelect);
    window.removeEventListener('resize', this._onResize);
    if (this._onDown) this.hud.removeEventListener('pointerdown', this._onDown);
    if (this._onMove) window.removeEventListener('pointermove', this._onMove);
    if (this._onUp) {
      window.removeEventListener('pointerup', this._onUp);
      window.removeEventListener('pointercancel', this._onUp);
    }
    if (this._onWheel) this.renderer.domElement.removeEventListener('wheel', this._onWheel);
    if (this._onCtxMenu) this.renderer.domElement.removeEventListener('contextmenu', this._onCtxMenu);
    this.hud.innerHTML = '';
    this.renderer.dispose();
    this.container.innerHTML = '';
    this.onExit?.();
  }
}
