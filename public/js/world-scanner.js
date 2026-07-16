/**
 * WORLD SCANNER — walk around and paint reality into a point-cloud map.
 *
 * AR mode (Android Chrome with the Depth API): every ~6th frame the depth
 * image is unprojected through the device pose into world space and fused
 * into a voxel-deduped point cloud, which renders live over the camera view.
 * With WebXR raw camera access the points get real color; otherwise they get
 * a holographic elevation tint.
 *
 * No AR? A synthetic demo yard is generated so the save/upload/explore
 * pipeline still works everywhere.
 */
import * as THREE from 'three';
import { VOXEL, encodePoints } from './world-format.js';

const CAP = 1_500_000;               // max points per world (~15 MB binary)
const CAPTURE_MS = 170;              // initial depth fuse interval (self-throttles)
const CAM_GRAB_MS = 450;             // camera readPixels stalls the GPU — keep it rare
const DEPTH_MIN = 0.25, DEPTH_MAX = 6.0;
const CAM_W = 160, CAM_H = 120;      // downscaled camera color grab
const CHUNK_BYTES = 4 * 1024 * 1024; // upload chunk size

/* Open-addressing hash set of occupied voxels — flat typed array so a
   full 1.5M-point scan stays memory-sane on a phone. */
class VoxelSet {
  constructor(points) {
    let cap = 1;
    while (cap < points * 2) cap *= 2;
    this.keys = new Float64Array(cap);   // 0 = empty, else packed key + 1
    this.mask = cap - 1;
    this.size = 0;
  }
  /** returns true if the voxel was new */
  add(qx, qy, qz) {
    const key = (qx + 32768) * 4294967296 + (qy + 32768) * 65536 + (qz + 32768) + 1;
    let h = ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) & this.mask;
    const keys = this.keys;
    while (keys[h] !== 0) {
      if (keys[h] === key) return false;
      h = (h + 1) & this.mask;
    }
    keys[h] = key;
    this.size++;
    return true;
  }
}

export class WorldScanner {
  constructor({ container, hud, xr, onExit, onSaved }) {
    this.container = container;
    this.hud = hud;
    this.xr = xr;                 // true = real AR scan, false = demo generator
    this.onExit = onExit;
    this.onSaved = onSaved;
    this.state = 'boot';          // scanning | review | saving | done

    this.qpos = new Int16Array(CAP * 3);
    this.cols = new Uint8Array(CAP * 3);
    this.count = 0;
    this.voxels = new VoxelSet(CAP);
    this.groundCells = new Set(); // ~1.3m ground cells, for the m² readout
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];

    this.tmpV = new THREE.Vector3();
    this.invProj = new THREE.Matrix4();
    this.viewMat = new THREE.Matrix4();
    this.hasColor = false;
    this.camPix = null;
    this.captureInterval = CAPTURE_MS;
    this._phase = 0;
    this._depthStatus = 'waiting for depth…';
    this._lastCapture = 0;
    this._lastCamGrab = 0;
    this._startedAt = 0;
    this._stopped = false;
  }

  /* ---------------- lifecycle ---------------- */
  async start() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);
    this.gl = this.renderer.getContext();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 300);
    this.camera.position.set(0, 1.6, 0);

    // live point cloud with preallocated buffers
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Uint8Array(CAP * 3), 3, true).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    this.cloud = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.03, vertexColors: true, sizeAttenuation: true,
    }));
    this.cloud.frustumCulled = false;
    this.scene.add(this.cloud);

    this._onResize = () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    if (this.xr) await this.startXR();
    else this.startDemo();

    this.renderer.setAnimationLoop((time, frame) => this.tick(time, frame));
  }

  async startXR() {
    this.renderer.xr.enabled = true;
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing'],
        optionalFeatures: ['dom-overlay', 'local-floor', 'camera-access'],
        domOverlay: { root: this.hud },
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32'],
        },
      });
    } catch (err) {
      throw new Error('This phone supports AR but not the Depth API, which scanning needs. (' + err.message + ')');
    }
    this.session = session;

    try { this.renderer.xr.setReferenceSpaceType('local-floor'); }
    catch (e) { this.renderer.xr.setReferenceSpaceType('local'); }
    await this.renderer.xr.setSession(session);

    try { this.glBinding = new XRWebGLBinding(session, this.gl); }
    catch (e) { this.glBinding = null; }

    session.addEventListener('end', () => {
      if (this._stopped || this.state !== 'scanning') return;
      // system back gesture ended the session mid-scan
      if (this.count > 5000) this.enterReview();
      else this.stop();
    });

    this.state = 'scanning';
    this._startedAt = performance.now();
    this.buildScanHUD();
  }

  /* ---------------- per-frame ---------------- */
  tick(time, frame) {
    if (this._stopped) return;

    if (this.state === 'scanning' && frame && time - this._lastCapture >= this.captureInterval && this.count < CAP) {
      this._lastCapture = time;
      try { this.captureFrame(frame); } catch (e) { /* single bad frame — keep scanning */ }
    }

    if (this.state === 'scanning' && time - (this._lastHud || 0) > 250) {
      this._lastHud = time;
      this.updateScanHUD();
    }

    // after the AR session ends we show the captured world on a slow orbit
    if ((this.state === 'review' || this.state === 'saving') && !this.renderer.xr.isPresenting) {
      this.orbitPreview(time);
    }

    this.renderer.render(this.scene, this.camera);
  }

  captureFrame(frame) {
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (!refSpace) return;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) { this._depthStatus = 'tracking…'; return; }
    const view = pose.views[0];

    let depth = null;
    try { depth = frame.getDepthInformation(view); }
    catch (e) { this._depthStatus = 'depth err: ' + e.message.slice(0, 40); return; }
    if (!depth) { this._depthStatus = 'no depth yet — keep moving'; return; }

    const t0 = performance.now();

    if (this.glBinding && view.camera && t0 - this._lastCamGrab > CAM_GRAB_MS) {
      this._lastCamGrab = t0;
      const pix = this.grabCameraPixels(view.camera);
      if (pix) { this.camPix = pix; this.hasColor = true; }
    }

    this.invProj.fromArray(view.projectionMatrix).invert();
    this.viewMat.fromArray(view.transform.matrix);
    const before = this.count;

    if (depth.data && depth.normDepthBufferFromNormView) this.fuseDepthBuffer(depth);
    else if (depth.getDepthInMeters) this.fuseDepthSlow(depth);
    else { this._depthStatus = 'unsupported depth format'; return; }

    this.flushGeometry(before);

    // self-throttle: a slow device spaces captures out instead of locking up
    const ms = performance.now() - t0;
    if (ms > 34) this.captureInterval = Math.min(700, this.captureInterval * 1.5);
    else if (ms < 12 && this.captureInterval > CAPTURE_MS) {
      this.captureInterval = Math.max(CAPTURE_MS, this.captureInterval * 0.8);
    }
  }

  /** Fast path: index the raw CPU depth buffer directly — no per-pixel API calls. */
  fuseDepthBuffer(depth) {
    const w = depth.width, h = depth.height, n = w * h;
    let raw, scale;
    if (depth.data.byteLength === n * 4) { raw = new Float32Array(depth.data); scale = depth.rawValueToMeters || 1; }
    else if (depth.data.byteLength === n * 2) { raw = new Uint16Array(depth.data); scale = depth.rawValueToMeters || 0.001; }
    else { this._depthStatus = `odd depth layout ${w}×${h}/${depth.data.byteLength}b`; return; }
    this._depthStatus = `depth ${w}×${h} ok`;

    // maps depth-buffer UV → normalized view UV (handles the portrait rotation)
    const inv = depth.normDepthBufferFromNormView.inverse.matrix;

    const sx = Math.max(1, Math.round(w / 96));
    const sy = Math.max(1, Math.round(h / 72)) * 2;   // every other row,
    this._phase = 1 - this._phase;                     // alternating each tick
    const y0 = this._phase * (sy >> 1);

    for (let py = y0; py < h; py += sy) {
      const dv = (py + 0.5) / h;
      const row = py * w;
      for (let px = 0; px < w; px += sx) {
        const d = raw[row + px] * scale;
        if (!(d >= DEPTH_MIN && d <= DEPTH_MAX)) continue;
        const du = (px + 0.5) / w;
        const u = inv[0] * du + inv[4] * dv + inv[12];
        const v = inv[1] * du + inv[5] * dv + inv[13];
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        this.fusePoint(u, v, d);
        if (this.count >= CAP) return;
      }
    }
  }

  /** Fallback when raw buffer access is unavailable: sparse getDepthInMeters grid. */
  fuseDepthSlow(depth) {
    this._depthStatus = 'depth slow-path';
    for (let iy = 0; iy < 30; iy++) {
      const v = (iy + 0.5) / 30;
      for (let ix = 0; ix < 40; ix++) {
        const u = (ix + 0.5) / 40;
        let d;
        try { d = depth.getDepthInMeters(u, v); } catch (e) { continue; }
        if (!(d >= DEPTH_MIN && d <= DEPTH_MAX)) continue;
        this.fusePoint(u, v, d);
        if (this.count >= CAP) return;
      }
    }
  }

  /** Unproject one (viewU, viewV, metres) sample into world space and fuse it. */
  fusePoint(u, v, d) {
    const v3 = this.tmpV;
    v3.set(u * 2 - 1, 1 - v * 2, 0.5).applyMatrix4(this.invProj);
    if (v3.z > -1e-6) return;
    v3.multiplyScalar(d / -v3.z).applyMatrix4(this.viewMat);

    let r, g, b;
    const camPix = this.camPix;
    if (camPix) {
      const px = Math.min(CAM_W - 1, (u * CAM_W) | 0);
      const py = Math.min(CAM_H - 1, ((1 - v) * CAM_H) | 0);
      const o = (py * CAM_W + px) * 4;
      r = camPix[o]; g = camPix[o + 1]; b = camPix[o + 2];
    } else {
      const t = Math.max(0, Math.min(1, (v3.y + 0.6) / 3.6));
      r = 16 + t * 180; g = 60 + t * 180; b = 120 + t * 135;
    }
    this.addPoint(v3.x, v3.y, v3.z, r, g, b);
  }

  addPoint(x, y, z, r, g, b) {
    const qx = Math.round(x / VOXEL), qy = Math.round(y / VOXEL), qz = Math.round(z / VOXEL);
    if (qx < -32700 || qx > 32700 || qy < -32700 || qy > 32700 || qz < -32700 || qz > 32700) return;
    if (!this.voxels.add(qx, qy, qz)) return;

    const i = this.count * 3;
    this.qpos[i] = qx; this.qpos[i + 1] = qy; this.qpos[i + 2] = qz;
    this.cols[i] = r; this.cols[i + 1] = g; this.cols[i + 2] = b;
    const pa = this.posAttr.array;
    pa[i] = qx * VOXEL; pa[i + 1] = qy * VOXEL; pa[i + 2] = qz * VOXEL;
    const ca = this.colAttr.array;
    ca[i] = r; ca[i + 1] = g; ca[i + 2] = b;
    this.count++;

    if (x < this.min[0]) this.min[0] = x; if (x > this.max[0]) this.max[0] = x;
    if (y < this.min[1]) this.min[1] = y; if (y > this.max[1]) this.max[1] = y;
    if (z < this.min[2]) this.min[2] = z; if (z > this.max[2]) this.max[2] = z;
    if (y < 1.0) this.groundCells.add(((qx >> 5) + 2048) * 4096 + ((qz >> 5) + 2048));
  }

  flushGeometry(before) {
    if (this.count === before) return;
    const off = before * 3, len = (this.count - before) * 3;
    for (const attr of [this.posAttr, this.colAttr]) {
      if (attr.addUpdateRange) attr.addUpdateRange(off, len);
      else { attr.updateRange.offset = off; attr.updateRange.count = len; }
      attr.needsUpdate = true;
    }
    this.cloud.geometry.setDrawRange(0, this.count);
  }

  /* ---------------- raw camera color grab ---------------- */
  grabCameraPixels(xrCamera) {
    const gl = this.gl;
    let camTex;
    try { camTex = this.glBinding.getCameraImage(xrCamera); } catch (e) { return null; }
    if (!camTex) return null;

    if (!this.blit) {
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER,
        'attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER,
        'precision mediump float; varying vec2 v; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, v); }'));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.glBinding = null; return null; }

      const buf = gl.createBuffer();
      const vao = gl.createVertexArray ? gl.createVertexArray() : null;
      if (vao) gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      if (vao) gl.bindVertexArray(null);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CAM_W, CAM_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this.blit = { prog, buf, vao, loc, fbo, uTex: gl.getUniformLocation(prog, 't'), pixels: new Uint8Array(CAM_W * CAM_H * 4) };
    }

    const bl = this.blit;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bl.fbo);
    gl.viewport(0, 0, CAM_W, CAM_H);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(bl.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, camTex);
    gl.uniform1i(bl.uTex, 0);
    if (bl.vao) { gl.bindVertexArray(bl.vao); }
    else {
      gl.bindBuffer(gl.ARRAY_BUFFER, bl.buf);
      gl.enableVertexAttribArray(bl.loc);
      gl.vertexAttribPointer(bl.loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, CAM_W, CAM_H, gl.RGBA, gl.UNSIGNED_BYTE, bl.pixels);
    if (bl.vao) gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.renderer.resetState();
    return bl.pixels;
  }

  /* ---------------- scan HUD ---------------- */
  buildScanHUD() {
    this.hud.innerHTML = `
      <div class="scan-top">
        <span class="scan-stat" id="scan-pts">0 pts</span>
        <span class="scan-stat" id="scan-area">0 m²</span>
        <span class="scan-stat" id="scan-time">0:00</span>
      </div>
      <div class="scan-cap"><div class="scan-cap-fill" id="scan-cap-fill"></div></div>
      <div class="scan-debug" id="scan-debug"></div>
      <div class="scan-hint" id="scan-hint">Walk slowly and sweep the phone across ground, trees and walls — the map paints in as you go.</div>
      <div class="scan-actions">
        <button class="btn-primary" id="scan-done">✓ Finish &amp; save</button>
        <button class="btn-ghost" id="scan-exit">discard</button>
      </div>`;
    this.hud.querySelector('#scan-done').addEventListener('click', () => {
      if (this.state !== 'scanning') return;
      if (this.count < 2000) {
        this.setHint('Not enough scanned yet — keep sweeping a little longer.');
        return;
      }
      this.enterReview();
    });
    this.hud.querySelector('#scan-exit').addEventListener('click', () => this.stop());
  }

  setHint(msg) {
    const el = this.hud.querySelector('#scan-hint');
    if (el) el.textContent = msg;
  }

  updateScanHUD() {
    const q = (id) => this.hud.querySelector('#' + id);
    if (!q('scan-pts')) return;
    q('scan-pts').textContent = this.count.toLocaleString() + ' pts';
    q('scan-area').textContent = Math.round(this.groundCells.size * 1.64) + ' m²';
    const s = Math.floor((performance.now() - this._startedAt) / 1000);
    q('scan-time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    q('scan-cap-fill').style.width = Math.min(100, (this.count / CAP) * 100) + '%';
    q('scan-debug').textContent =
      `${this._depthStatus} · ${this.hasColor ? 'color ✓' : 'tint'} · ${Math.round(this.captureInterval)}ms`;
    if (this.count >= CAP) this.setHint('Memory full — finish and save your world.');
    else if (this.count === 0 && performance.now() - this._startedAt > 6000 && !this._zeroWarned) {
      this._zeroWarned = true;
      this.setHint('No 3D data yet — aim at the ground 1–3 m ahead and pan slowly.');
    } else if (!this.hasColor && this.count > 4000 && !this._colorWarned) {
      this._colorWarned = true;
      this.setHint('No camera-color access on this phone — scanning in hologram tint instead.');
    }
  }

  /* ---------------- review + save ---------------- */
  async enterReview() {
    if (this.state !== 'scanning' && this.state !== 'boot') return;
    this.state = 'review';
    const session = this.session;
    this.session = null;
    if (session) { try { await session.end(); } catch (e) { /* already gone */ } }
    this.renderer.xr.enabled = false;
    this._onResize();
    this.showSaveDialog();
  }

  orbitPreview(time) {
    const cx = (this.min[0] + this.max[0]) / 2;
    const cy = (this.min[1] + this.max[1]) / 2;
    const cz = (this.min[2] + this.max[2]) / 2;
    const spanX = this.max[0] - this.min[0], spanZ = this.max[2] - this.min[2];
    const r = Math.max(4, Math.sqrt(spanX * spanX + spanZ * spanZ) * 0.75);
    const a = time * 0.00012;
    this.camera.position.set(cx + Math.cos(a) * r, cy + r * 0.5, cz + Math.sin(a) * r);
    this.camera.lookAt(cx, cy, cz);
  }

  showSaveDialog() {
    this.hud.innerHTML = `
      <div class="save-dialog">
        <div class="save-card">
          <h3>🌍 World captured</h3>
          <p class="save-meta">${this.count.toLocaleString()} points · ~${Math.round(this.groundCells.size * 1.64)} m² covered</p>
          <input id="world-name" type="text" maxlength="40" placeholder="Name this world (e.g. Front Yard)" autocomplete="off">
          <div class="save-error hidden" id="save-error"></div>
          <div class="save-progress hidden" id="save-progress"><div class="save-progress-fill" id="save-progress-fill"></div></div>
          <div class="save-actions">
            <button class="btn-primary" id="save-btn">Save &amp; share</button>
            <button class="btn-ghost" id="save-discard">discard</button>
          </div>
        </div>
      </div>`;
    const nameEl = this.hud.querySelector('#world-name');
    const errEl = this.hud.querySelector('#save-error');
    const saveBtn = this.hud.querySelector('#save-btn');
    nameEl.focus();

    this.hud.querySelector('#save-discard').addEventListener('click', () => this.stop());
    saveBtn.addEventListener('click', async () => {
      const name = nameEl.value.trim();
      if (!name) { errEl.textContent = 'Give it a name first.'; errEl.classList.remove('hidden'); return; }
      errEl.classList.add('hidden');
      saveBtn.disabled = true;
      this.state = 'saving';
      this.hud.querySelector('#save-progress').classList.remove('hidden');
      try {
        await this.upload(name, (f) => {
          this.hud.querySelector('#save-progress-fill').style.width = Math.round(f * 100) + '%';
        });
        this.state = 'done';
        this.onSaved?.({ name, points: this.count });
        this.stop();
      } catch (err) {
        this.state = 'review';
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        saveBtn.disabled = false;
      }
    });
  }

  async upload(name, onProgress) {
    const json = async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed (' + res.status + ')');
      return data;
    };
    const { id } = await json(await fetch('/api/worlds', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }));

    const bin = encodePoints(this.qpos, this.cols, this.count);
    for (let off = 0; off < bin.byteLength; off += CHUNK_BYTES) {
      const part = bin.subarray(off, Math.min(off + CHUNK_BYTES, bin.byteLength));
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await json(await fetch(`/api/worlds/${id}/data`, {
            method: 'PUT', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: part,
          }));
          lastErr = null;
          break;
        } catch (err) { lastErr = err; }
      }
      if (lastErr) throw lastErr;
      onProgress(Math.min(1, (off + part.byteLength) / bin.byteLength));
    }

    await json(await fetch(`/api/worlds/${id}/finish`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: this.count, bounds: { min: this.min, max: this.max } }),
    }));
  }

  /* ---------------- demo world (no AR available) ---------------- */
  startDemo() {
    this.scene.background = new THREE.Color(0x05060a);
    const rand = mulberry32(1337);
    const height = (x, z) =>
      Math.sin(x * 0.16 + 1.7) * Math.cos(z * 0.13 - 0.4) * 0.8 +
      Math.sin(x * 0.045 - 0.8) * 1.4 +
      Math.sin((x + z) * 0.31) * 0.18;

    // rolling lawn with worn dirt path
    for (let x = -16; x <= 16; x += 0.055) {
      for (let z = -16; z <= 16; z += 0.055) {
        const y = height(x, z);
        const pathDist = Math.abs(x - Math.sin(z * 0.25) * 3.2);
        const n = rand();
        let r, g, b;
        if (pathDist < 0.9) { r = 128 + n * 30; g = 100 + n * 26; b = 70 + n * 20; }
        else { r = 40 + n * 30; g = 110 + n * 60; b = 38 + n * 26; }
        this.addPoint(x, y, z, r, g, b);
      }
    }
    // the house
    const hx = 5.5, hz = -6, hw = 7, hd = 5, wallH = 3;
    const hy = height(hx, hz);
    for (let t = 0; t < 90000; t++) {
      const side = (rand() * 4) | 0;
      const along = rand(), up = rand() * wallH;
      let x, z;
      if (side === 0) { x = hx - hw / 2 + along * hw; z = hz - hd / 2; }
      else if (side === 1) { x = hx - hw / 2 + along * hw; z = hz + hd / 2; }
      else if (side === 2) { x = hx - hw / 2; z = hz - hd / 2 + along * hd; }
      else { x = hx + hw / 2; z = hz - hd / 2 + along * hd; }
      const window_ = up > 1.1 && up < 2.2 && (along % 0.34) > 0.1 && (along % 0.34) < 0.22;
      const n = rand() * 18;
      if (window_) this.addPoint(x, hy + up, z, 40 + n, 70 + n, 110 + n);
      else this.addPoint(x, hy + up, z, 205 + n, 190 + n, 160 + n);
    }
    for (let t = 0; t < 60000; t++) { // pitched roof
      const along = rand(), across = rand();
      const x = hx - hw / 2 + along * hw;
      const z = hz - hd / 2 + across * hd;
      const y = hy + wallH + (1 - Math.abs(across - 0.5) * 2) * 1.6;
      const n = rand() * 16;
      this.addPoint(x, y, z, 120 + n, 45 + n, 40 + n);
    }
    // trees
    for (let i = 0; i < 11; i++) {
      const tx = -14 + rand() * 24, tz = -14 + rand() * 28;
      if (Math.abs(tx - hx) < 5 && Math.abs(tz - hz) < 4.5) continue;
      const ty = height(tx, tz);
      const trunkH = 1.6 + rand() * 1.8, canR = 1.1 + rand() * 1.3;
      for (let t = 0; t < 2600; t++) {
        const a = rand() * Math.PI * 2, up = rand() * trunkH;
        const rr = 0.1 + rand() * 0.08;
        const n = rand() * 20;
        this.addPoint(tx + Math.cos(a) * rr, ty + up, tz + Math.sin(a) * rr, 92 + n, 62 + n, 38 + n);
      }
      for (let t = 0; t < 9000; t++) {
        const u = rand() * 2 - 1, a = rand() * Math.PI * 2;
        const rr = canR * Math.cbrt(rand());
        const sq = Math.sqrt(1 - u * u);
        const n = rand() * 42;
        this.addPoint(tx + rr * sq * Math.cos(a), ty + trunkH + canR * 0.8 + rr * u * 0.85, tz + rr * sq * Math.sin(a), 26 + n, 96 + n, 30 + n);
      }
    }
    this.flushGeometry(0);
    this.hasColor = true;
    this.state = 'review';
    this.showSaveDialog();
    const meta = this.hud.querySelector('.save-meta');
    if (meta) meta.textContent = 'Demo terrain (no AR on this device) · ' + this.count.toLocaleString() + ' points';
  }

  /* ---------------- teardown ---------------- */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.renderer.setAnimationLoop(null);
    try { this.session?.end(); } catch (e) { /* already ended */ }
    window.removeEventListener('resize', this._onResize);
    this.hud.innerHTML = '';
    this.cloud.geometry.dispose();
    this.cloud.material.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
    this.onExit?.();
  }
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
