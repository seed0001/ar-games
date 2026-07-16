/**
 * WORLD SCANNER — walk around and paint reality into a point-cloud map.
 *
 * AR mode (Android Chrome with the Depth API): every capture tick the raw
 * CPU depth buffer (~40 KB) plus the view matrices are copied to a Web
 * Worker (world-fuse-worker.js) which does all the heavy lifting —
 * unprojection, voxel dedupe, storage — and posts back only the new points.
 * The XR frame loop itself stays nearly idle, is wrapped so an error can
 * never kill it, and a watchdog restarts it if it stalls anyway.
 *
 * With WebXR raw camera access the points get real color (the readPixels
 * grab is timed, and disabled for the session if this device is slow at
 * it); otherwise a holographic elevation tint.
 *
 * No AR? A synthetic demo yard is generated through the same worker so the
 * save/upload/explore pipeline still works everywhere.
 */
import * as THREE from 'three';
import { tlog, flush } from './telemetry.js';

const CAP = 1_500_000;               // max points per world (~15 MB binary)
const PAGE = 250_000;                // points per GPU geometry page
const CAPTURE_MS = 170;              // min gap between capture ticks
const CAM_GRAB_MS = 450;             // camera readPixels stalls the GPU — keep it rare
const CAM_W = 160, CAM_H = 120;      // downscaled camera color grab
const CHUNK_BYTES = 4 * 1024 * 1024; // upload chunk size
const WARMUP_MS = 1200;              // let the session settle before first capture

export class WorldScanner {
  constructor({ container, hud, xr, onExit, onSaved }) {
    this.container = container;
    this.hud = hud;
    this.xr = xr;                 // true = real AR scan, false = demo generator
    this.onExit = onExit;
    this.onSaved = onSaved;
    this.state = 'boot';          // scanning | generating | review | saving | done

    // mirrors of the worker's authoritative state
    this.count = 0;
    this._ground = 0;
    this._min = [0, 0, 0];
    this._max = [0, 0, 0];

    this.pages = [];
    this.invProj = new THREE.Matrix4();
    this.hasColor = false;
    this.colorDisabled = false;
    this._workerBusy = false;
    this._pendingBatches = 0;
    this._lastCapture = 0;
    this._lastCamGrab = 0;
    this._lastTick = performance.now();
    this._recoveries = 0;
    this._lastErr = null;
    this._depthStatus = 'waiting for depth…';
    this._startedAt = 0;
    this._stopped = false;

    // rolling per-second telemetry window
    this._stats = { frames: 0, maxGap: 0, capMs: 0, appendMs: 0, lastEmit: 0 };
    this._fps = 0;
    this._rtt = 0;
    this._postedAt = 0;
    this._depthLogged = false;
    this._loggedDepthStatus = '';
    this._lastXRFrame = 0;
    this._xrDeadLogged = false;
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
    this.cloudMat = new THREE.PointsMaterial({ size: 0.03, vertexColors: true, sizeAttenuation: true });
    clampPointSize(this.cloudMat);

    this.worker = new Worker('/js/world-fuse-worker.js');
    this.worker.postMessage({ type: 'init', cap: CAP });
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => { this._lastErr = 'worker: ' + (e.message || 'failed to load'); };

    this._onResize = () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    if (this.xr) await this.startXR();
    else this.startDemo();

    this._loop = (time, frame) => this.tick(time, frame);
    this.renderer.setAnimationLoop(this._loop);

    // a plain DOM timer keeps firing even if rAF dies — resurrect the loop
    this._watchdog = setInterval(() => {
      if (this._stopped) return;
      // rAF is legitimately paused while backgrounded — restarting can't help
      if (document.visibilityState === 'hidden') { this._lastTick = performance.now(); return; }
      const stall = performance.now() - this._lastTick;
      if (stall > 2200) {
        this._recoveries++;
        this._lastErr = null;
        tlog('watchdog-recover', { n: this._recoveries, stall: Math.round(stall), pts: this.count, state: this.state });
        flush();
        try {
          this.renderer.setAnimationLoop(null);
          this.renderer.setAnimationLoop(this._loop);
        } catch (e) { this._lastErr = 'restart: ' + e.message; }
        this.setHint(`Recovered a stalled frame loop (×${this._recoveries}) — keep scanning.`);
      }
    }, 1200);
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

    // three r164's WebXRManager sees 'depth-sensing' among enabledFeatures and
    // calls the GPU depth API (XRWebGLBinding.getDepthInformation) for its own
    // occlusion feature. On a cpu-optimized session Chrome throws
    // InvalidStateError, which kills three's XR frame chain on the first
    // tracked frame — the AR feed freezes while the DOM HUD stays alive.
    // Shadow the property so three never sees the feature; we read the depth
    // buffer ourselves via frame.getDepthInformation (the CPU API).
    let threeDepthHidden = false;
    try {
      const feats = session.enabledFeatures
        ? Array.from(session.enabledFeatures).filter((f) => f !== 'depth-sensing') : [];
      Object.defineProperty(session, 'enabledFeatures', { configurable: true, get: () => feats });
      threeDepthHidden = !session.enabledFeatures.includes('depth-sensing');
    } catch (e) { /* shadow failed — telemetry below records it */ }

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
    this._lastCapture = this._startedAt + WARMUP_MS - CAPTURE_MS;
    this.buildScanHUD();

    let depthUsage = null, depthFormat = null;
    try { depthUsage = session.depthUsage; depthFormat = session.depthDataFormat; } catch (e) { /* not exposed */ }
    tlog('xr-session', {
      features: session.enabledFeatures ? Array.from(session.enabledFeatures) : null,
      depthUsage, depthFormat,
      glBinding: !!this.glBinding,
      threeDepthHidden,
    });
    flush();
  }

  /* ---------------- worker plumbing ---------------- */
  onWorkerMessage(m) {
    if (this._stopped) return;
    if (m.type === 'points') {
      this._workerBusy = false;
      if (this._postedAt) { this._rtt = Math.round(performance.now() - this._postedAt); this._postedAt = 0; }
      this.count = m.total;
      this._ground = m.ground;
      this._min = m.min;
      this._max = m.max;
      if (m.n > 0) {
        const a0 = performance.now();
        this.appendPoints(new Float32Array(m.pos), new Uint8Array(m.col), m.n);
        const aMs = performance.now() - a0;
        if (aMs > this._stats.appendMs) this._stats.appendMs = aMs;
      }
      if (this._pendingBatches > 0 && --this._pendingBatches === 0 && this.state === 'generating') {
        this.state = 'review';
        this.showSaveDialog();
        const meta = this.hud.querySelector('.save-meta');
        if (meta) meta.textContent = 'Demo terrain (no AR on this device) · ' + this.count.toLocaleString() + ' points';
      }
    } else if (m.type === 'encoded') {
      const r = this._encodeResolve;
      this._encodeResolve = null;
      r?.(m);
    } else if (m.type === 'error') {
      this._workerBusy = false;
      this._lastErr = 'worker: ' + m.message.slice(0, 50);
      tlog('worker-error', { msg: m.message.slice(0, 200) });
      flush();
    }
  }

  /** render the worker's new points into fixed-size GPU pages */
  appendPoints(pos, col, n) {
    let i = 0;
    while (i < n) {
      let page = this.pages[this.pages.length - 1];
      if (!page || page.used >= PAGE) page = this.addPage();
      const take = Math.min(n - i, PAGE - page.used);
      page.pos.array.set(pos.subarray(i * 3, (i + take) * 3), page.used * 3);
      page.col.array.set(col.subarray(i * 3, (i + take) * 3), page.used * 3);
      for (const attr of [page.pos, page.col]) {
        if (attr.addUpdateRange) attr.addUpdateRange(page.used * 3, take * 3);
        attr.needsUpdate = true;
      }
      page.used += take;
      page.geo.setDrawRange(0, page.used);
      i += take;
    }
  }

  addPage() {
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(PAGE * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(new Uint8Array(PAGE * 3), 3, true).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(geo, this.cloudMat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    const page = { geo, pos, col, pts, used: 0 };
    this.pages.push(page);
    return page;
  }

  /* ---------------- per-frame ---------------- */
  tick(time, frame) {
    const now = performance.now();
    const gap = now - this._lastTick;
    this._lastTick = now;
    if (this._stopped) return;
    try {
      const st = this._stats;
      st.frames++;
      if (gap > st.maxGap) st.maxGap = gap;
      if (this.state === 'scanning' && now - st.lastEmit > 1000) {
        this._fps = st.lastEmit ? Math.round(st.frames * 1000 / (now - st.lastEmit)) : 0;
        if (st.lastEmit) {
          tlog('scan1s', {
            fps: this._fps, maxGap: Math.round(st.maxGap),
            capMs: Math.round(st.capMs), appendMs: Math.round(st.appendMs),
            rtt: this._rtt, pts: this.count, pages: this.pages.length,
            depth: this._depthStatus.slice(0, 40),
            color: this.hasColor ? 1 : 0, colorOff: this.colorDisabled ? 1 : 0,
            rec: this._recoveries, err: this._lastErr,
            heap: performance.memory ? (performance.memory.usedJSHeapSize / 1048576) | 0 : undefined,
          });
        }
        st.lastEmit = now;
        st.frames = 0; st.maxGap = 0; st.capMs = 0; st.appendMs = 0;
      }

      // three's XR frame chain can die independently of the window rAF that
      // keeps this tick alive (an exception inside WebXRManager kills only the
      // XR loop). If we're presenting but XR frames stop arriving, say so.
      if (frame) this._lastXRFrame = now;
      else if (this.state === 'scanning' && this.renderer.xr.isPresenting &&
               this._lastXRFrame && now - this._lastXRFrame > 2500 && !this._xrDeadLogged) {
        this._xrDeadLogged = true;
        this._lastErr = 'XR frame loop died — restart the scan';
        tlog('xr-frames-dead', { pts: this.count, at: Math.round(now - this._startedAt) });
        flush();
        this.setHint('The AR tracking loop stalled — back out and start the scan again.');
      }

      if (this.state === 'scanning' && frame &&
          time - this._lastCapture >= CAPTURE_MS && !this._workerBusy && this.count < CAP) {
        this._lastCapture = time;
        this.captureFrame(frame);
        const capMs = performance.now() - now;
        if (capMs > st.capMs) st.capMs = capMs;
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
    } catch (e) {
      this._lastErr = String(e && e.message || e).slice(0, 60);
    }
  }

  captureFrame(frame) {
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (!refSpace) return;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) { this._depthStatus = 'tracking…'; return; }
    const view = pose.views[0];

    let depth = null;
    try { depth = frame.getDepthInformation(view); }
    catch (e) { this._depthStatus = 'depth err: ' + e.message.slice(0, 40); this.logDepthStatus(); return; }
    if (!depth) { this._depthStatus = 'no depth yet — keep moving'; this.logDepthStatus(); return; }
    if (!depth.data || !depth.normDepthBufferFromNormView) {
      this._depthStatus = 'no raw depth buffer on this device';
      this.logDepthStatus();
      return;
    }

    const n = depth.width * depth.height;
    let isFloat;
    if (depth.data.byteLength === n * 4) isFloat = true;
    else if (depth.data.byteLength === n * 2) isFloat = false;
    else { this._depthStatus = `odd depth layout ${depth.width}×${depth.height}/${depth.data.byteLength}b`; this.logDepthStatus(); return; }
    this._depthStatus = `depth ${depth.width}×${depth.height} ok`;
    if (!this._depthLogged) {
      this._depthLogged = true;
      tlog('depth-ok', { w: depth.width, h: depth.height, isFloat, scale: depth.rawValueToMeters });
      flush();
    }

    // occasional, timed camera color grab; give up on it if this device is slow
    let cam = null;
    const t0 = performance.now();
    if (!this.colorDisabled && this.glBinding && view.camera && t0 - this._lastCamGrab > CAM_GRAB_MS) {
      this._lastCamGrab = t0;
      try {
        const pix = this.grabCameraPixels(view.camera);
        const grabMs = performance.now() - t0;
        if (grabMs > 30) {
          this.colorDisabled = true;
          tlog('color-disabled', { why: 'slow readPixels', ms: Math.round(grabMs) });
        }
        if (pix) {
          cam = { buf: pix.slice().buffer, w: CAM_W, h: CAM_H };
          this.hasColor = true;
        }
      } catch (e) {
        this.colorDisabled = true;
        tlog('color-disabled', { why: String(e.message || e).slice(0, 100) });
      }
    }

    this.invProj.fromArray(view.projectionMatrix).invert();
    const msg = {
      type: 'fuse',
      buf: depth.data.slice(0),
      w: depth.width, h: depth.height,
      isFloat,
      scale: depth.rawValueToMeters || (isFloat ? 1 : 0.001),
      invDepth: Array.from(depth.normDepthBufferFromNormView.inverse.matrix),
      invProj: Array.from(this.invProj.elements),
      viewMat: Array.from(view.transform.matrix),
      cam,
    };
    this._workerBusy = true;
    this._postedAt = performance.now();
    this.worker.postMessage(msg, cam ? [msg.buf, cam.buf] : [msg.buf]);
  }

  /** log depth-status transitions (once per distinct status, not per frame) */
  logDepthStatus() {
    if (this._depthStatus === this._loggedDepthStatus) return;
    this._loggedDepthStatus = this._depthStatus;
    tlog('depth-status', { s: this._depthStatus.slice(0, 80) });
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
    q('scan-area').textContent = Math.round(this._ground * 1.64) + ' m²';
    const s = Math.floor((performance.now() - this._startedAt) / 1000);
    q('scan-time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    q('scan-cap-fill').style.width = Math.min(100, (this.count / CAP) * 100) + '%';
    q('scan-debug').textContent = this._lastErr
      ? 'ERR ' + this._lastErr
      : `${this._fps}fps · ${this._depthStatus} · ${this.hasColor ? 'color ✓' : 'tint'}${this._recoveries ? ' · rec×' + this._recoveries : ''}`;
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
    tlog('review', { pts: this.count });
    flush();
    const session = this.session;
    this.session = null;
    if (session) { try { await session.end(); } catch (e) { /* already gone */ } }
    this.renderer.xr.enabled = false;
    this._onResize();
    this.showSaveDialog();
  }

  orbitPreview(time) {
    const cx = (this._min[0] + this._max[0]) / 2;
    const cy = (this._min[1] + this._max[1]) / 2;
    const cz = (this._min[2] + this._max[2]) / 2;
    const spanX = this._max[0] - this._min[0], spanZ = this._max[2] - this._min[2];
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
          <p class="save-meta">${this.count.toLocaleString()} points · ~${Math.round(this._ground * 1.64)} m² covered</p>
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
        tlog('save-start', { pts: this.count });
        await this.upload(name, (f) => {
          this.hud.querySelector('#save-progress-fill').style.width = Math.round(f * 100) + '%';
        });
        this.state = 'done';
        tlog('save-done', { pts: this.count });
        this.onSaved?.({ name, points: this.count });
        this.stop();
      } catch (err) {
        this.state = 'review';
        tlog('save-failed', { msg: String(err.message).slice(0, 200) });
        flush();
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        saveBtn.disabled = false;
      }
    });
  }

  requestEncode() {
    return new Promise((resolve, reject) => {
      this._encodeResolve = resolve;
      this.worker.postMessage({ type: 'encode' });
      setTimeout(() => {
        if (this._encodeResolve === resolve) {
          this._encodeResolve = null;
          reject(new Error('Timed out packing the scan'));
        }
      }, 30000);
    });
  }

  async upload(name, onProgress) {
    const json = async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed (' + res.status + ')');
      return data;
    };
    const encoded = await this.requestEncode();
    const bin = new Uint8Array(encoded.buf);

    const { id } = await json(await fetch('/api/worlds', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }));

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
      body: JSON.stringify({ points: encoded.total, bounds: { min: encoded.min, max: encoded.max } }),
    }));
  }

  /* ---------------- demo world (no AR available) ---------------- */
  startDemo() {
    this.scene.background = new THREE.Color(0x05060a);
    this.state = 'generating';
    this.hasColor = true;

    let batch = [];
    const batches = [];
    const push = (x, y, z, r, g, b) => {
      batch.push(x, y, z, r, g, b);
      if (batch.length >= 480000) { batches.push(new Float32Array(batch)); batch = []; }
    };

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
        if (pathDist < 0.9) push(x, y, z, 128 + n * 30, 100 + n * 26, 70 + n * 20);
        else push(x, y, z, 40 + n * 30, 110 + n * 60, 38 + n * 26);
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
      if (window_) push(x, hy + up, z, 40 + n, 70 + n, 110 + n);
      else push(x, hy + up, z, 205 + n, 190 + n, 160 + n);
    }
    for (let t = 0; t < 60000; t++) { // pitched roof
      const along = rand(), across = rand();
      const x = hx - hw / 2 + along * hw;
      const z = hz - hd / 2 + across * hd;
      const y = hy + wallH + (1 - Math.abs(across - 0.5) * 2) * 1.6;
      const n = rand() * 16;
      push(x, y, z, 120 + n, 45 + n, 40 + n);
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
        push(tx + Math.cos(a) * rr, ty + up, tz + Math.sin(a) * rr, 92 + n, 62 + n, 38 + n);
      }
      for (let t = 0; t < 9000; t++) {
        const u = rand() * 2 - 1, a = rand() * Math.PI * 2;
        const rr = canR * Math.cbrt(rand());
        const sq = Math.sqrt(1 - u * u);
        const n = rand() * 42;
        push(tx + rr * sq * Math.cos(a), ty + trunkH + canR * 0.8 + rr * u * 0.85, tz + rr * sq * Math.sin(a), 26 + n, 96 + n, 30 + n);
      }
    }
    if (batch.length) batches.push(new Float32Array(batch));

    this._pendingBatches = batches.length;
    for (const b of batches) this.worker.postMessage({ type: 'raw', buf: b.buffer }, [b.buffer]);
  }

  /* ---------------- teardown ---------------- */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    tlog('scanner-stop', { state: this.state, pts: this.count, rec: this._recoveries });
    flush();
    clearInterval(this._watchdog);
    this.worker?.terminate();
    this.renderer.setAnimationLoop(null);
    try { this.session?.end(); } catch (e) { /* already ended */ }
    window.removeEventListener('resize', this._onResize);
    this.hud.innerHTML = '';
    for (const page of this.pages) page.geo.dispose();
    this.cloudMat.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
    this.onExit?.();
  }
}

/**
 * Cap the screen-space size of attenuated points. Without this, points close
 * to the camera rasterize as ~100px quads on a phone XR framebuffer; a dense
 * near cloud then costs hundreds of millions of overdrawn pixels per frame,
 * which stalls mobile GPUs to a slideshow (reads as the whole app freezing).
 */
export function clampPointSize(material, maxPx = 7.0) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <logdepthbuf_vertex>',
      `gl_PointSize = clamp( gl_PointSize, 1.0, ${maxPx.toFixed(1)} );\n\t#include <logdepthbuf_vertex>`
    );
  };
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
