import * as THREE from 'three';
import { SFX as BaseSFX } from './xr-shooter.js';

/* 🃏 UNO — server-authoritative realtime card game.
 *
 * Each phone hit-test-places its OWN local copy of the table — there's no
 * shared spatial AR anchor between devices (no cloud anchors here). "Synced"
 * means both phones reflect the same logical game state over WebSocket, not
 * the same physical coordinate space. All rules logic lives server-side
 * (uno-engine.js); this class only renders viewFor() payloads and turns
 * taps into game:action messages.
 */

const COLOR_HEX = { red: 0xff4d5e, yellow: 0xffd93d, green: 0x4dff88, blue: 0x4da3ff, wild: 0x8a5cff };
const COLOR_CSS = { red: '#ff4d5e', yellow: '#ffd93d', green: '#4dff88', blue: '#4da3ff', wild: '#8a5cff' };
const OPP_STACK_MAX = 7;

class SFX extends BaseSFX {
  cardPlay() { this.blip({ type: 'triangle', f0: 600, f1: 340, dur: 0.08, vol: 0.18 }); }
  draw()     { this.blip({ type: 'square',   f0: 380, f1: 220, dur: 0.07, vol: 0.14, noise: 0.08 }); }
  shuffle()  { this.blip({ type: 'sawtooth', f0: 200, f1: 600, dur: 0.15, vol: 0.1,  noise: 0.15 }); }
  win()      { this.blip({ type: 'sine',     f0: 440, f1: 1100, dur: 0.5, vol: 0.3 }); }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cardLabel(value) {
  return { skip: '⦸', reverse: '⇄', draw2: '+2', wild: '★', wild4: '+4' }[value] || value;
}

function cardTexture(color, value) {
  const c = document.createElement('canvas');
  c.width = 180; c.height = 260;
  const x = c.getContext('2d');
  x.fillStyle = '#f4f4f8';
  roundRect(x, 4, 4, 172, 252, 20); x.fill();
  x.fillStyle = `#${(COLOR_HEX[color] ?? 0x888888).toString(16).padStart(6, '0')}`;
  roundRect(x, 14, 14, 152, 232, 15); x.fill();
  x.fillStyle = '#fff';
  x.font = 'bold 92px sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(cardLabel(value), 90, 138);
  return new THREE.CanvasTexture(c);
}

function cardBackTexture() {
  const c = document.createElement('canvas');
  c.width = 180; c.height = 260;
  const x = c.getContext('2d');
  x.fillStyle = '#f4f4f8';
  roundRect(x, 4, 4, 172, 252, 20); x.fill();
  x.fillStyle = '#151a2e';
  roundRect(x, 14, 14, 152, 232, 15); x.fill();
  x.fillStyle = '#34e1ff';
  x.font = 'bold 56px sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('UNO', 90, 138);
  return new THREE.CanvasTexture(c);
}

export class UnoGame {
  constructor({ container, hud, xr, onExit, room }) {
    this.container = container;
    this.hud = hud;
    this.xr = xr;
    this.onExit = onExit;
    this.room = room; // { roomId, playerId, seat, rt }
    this.sfx = new SFX();
    this._stopped = false;
    this.placed = false;
    this.pendingWildCardId = null;
    this.callUnoArmed = false;
    this.view = null;
    this.backTex = cardBackTexture();
  }

  async start() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 20);
    this.camera.rotation.order = 'YXZ';

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x30405a, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 5, 3);
    this.scene.add(dir);

    this.tableGroup = new THREE.Group();
    this.tableGroup.visible = false;
    this.scene.add(this.tableGroup);
    this.buildTableVisual();

    this.buildHUD();
    this.bindRealtime();

    this._onResize = () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    if (this.xr) await this.startXR();
    else this.startSim();

    this.renderer.setAnimationLoop((time, frame) => this.tick(frame));
  }

  buildTableVisual() {
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 32).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0e3d24, roughness: 0.9 })
    );
    this.tableGroup.add(felt);

    this.discardMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.09, 0.13).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.backTex, transparent: true })
    );
    this.discardMesh.position.set(0, 0.002, 0);
    this.tableGroup.add(this.discardMesh);

    this.oppStack = [];
    for (let i = 0; i < OPP_STACK_MAX; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.07, 0.1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: this.backTex, transparent: true })
      );
      m.position.set(-0.14 + i * 0.006, 0.001 + i * 0.0008, -0.16);
      m.visible = false;
      this.tableGroup.add(m);
      this.oppStack.push(m);
    }
  }

  async startXR() {
    this.renderer.xr.enabled = true;
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.03, 0.04, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x34e1ff, transparent: true, opacity: 0.9 })
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
    this._onSelect = () => {
      if (!this.placed && this.reticle.visible) {
        const pos = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
        this.placeTable(pos);
      }
    };
    session.addEventListener('select', this._onSelect);
    session.addEventListener('end', () => { if (!this._stopped) this.stop(); });

    this.sfx.ensure();
    this.setHint('Point your phone at a tabletop — tap to place the game');
  }

  startSim() {
    this.camera.position.set(0, 0.55, 0.55);
    this.camera.lookAt(0, 0, -0.15);
    this.placeTable(new THREE.Vector3(0, -0.55, -0.55));
    this.setHint('Play using the cards below');
  }

  placeTable(pos) {
    this.tableGroup.position.copy(pos);
    this.tableGroup.visible = true;
    this.placed = true;
    if (this.reticle) this.reticle.visible = false;
  }

  /* ---------------- realtime ---------------- */
  bindRealtime() {
    const { rt } = this.room;
    this._onState = (view) => this.applyState(view);
    this._onError = (payload) => this.toast(payload.message);
    this._onOppGone = () => this.setHint('Opponent disconnected — waiting for them to reconnect…');
    this._onOppLeft = (payload) => {
      this.banner(payload.reason === 'timeout' ? 'Opponent left — round abandoned' : 'Opponent left the game', 3000);
      setTimeout(() => { if (!this._stopped) this.stop(); }, 2600);
    };
    rt.on('uno:state', this._onState);
    rt.on('error', this._onError);
    rt.on('room:opponent-disconnected', this._onOppGone);
    rt.on('room:opponent-left', this._onOppLeft);
  }

  sendAction(action) {
    this.room.rt.send('game:action', { action });
  }

  applyState(view) {
    const prevTopId = this.view?.topCard?.id;
    this.view = view;

    if (view.topCard && view.topCard.id !== prevTopId) {
      this.discardMesh.material.map = cardTexture(view.currentColor, view.topCard.value);
      this.discardMesh.material.needsUpdate = true;
    }

    const oppCount = Object.values(view.opponentCounts)[0] ?? 0;
    for (let i = 0; i < OPP_STACK_MAX; i++) this.oppStack[i].visible = i < oppCount;

    this.renderHand();
    this.updateTopBar(oppCount);

    if (view.status === 'finished') this.showGameOver(view);
  }

  renderHand() {
    const isMyTurn = this.view.turnPlayer === this.room.playerId;
    const handEl = this.el.hand;
    handEl.innerHTML = this.view.hand.map((c, i) => `
      <button class="uno-card" data-id="${c.id}" style="--card-color:${COLOR_CSS[c.color]};--i:${i}">${cardLabel(c.value)}</button>
    `).join('');
    for (const btn of handEl.querySelectorAll('.uno-card')) {
      btn.addEventListener('click', () => {
        if (!isMyTurn) { this.toast("It's not your turn"); return; }
        const card = this.view.hand.find((c) => c.id === btn.dataset.id);
        this.onPlayCard(card);
      });
    }
    // arm before playing your second-to-last card — the penalty for forgetting
    // is checked the instant a play would drop you to 1, so there's no window
    // to call it afterward
    this.el.callUno.classList.toggle('hidden', this.view.hand.length > 2);
    this.el.draw.disabled = !isMyTurn;
  }

  updateTopBar(oppCount) {
    const isMyTurn = this.view.turnPlayer === this.room.playerId;
    this.el.turn.textContent = isMyTurn ? 'Your turn' : "Opponent's turn";
    this.el.turn.classList.toggle('my-turn', isMyTurn);
    this.el.opp.textContent = `Opponent: ${oppCount} card${oppCount === 1 ? '' : 's'}`;
    if (this.view.log.length) this.el.log.textContent = this.view.log[this.view.log.length - 1];
  }

  onPlayCard(card) {
    if (card.color === 'wild') {
      this.pendingWildCardId = card.id;
      this.el.colorpicker.classList.remove('hidden');
      return;
    }
    this.sendAction({ type: 'play', payload: { cardId: card.id, callUno: this.callUnoArmed } });
    this.disarmCallUno();
    this.sfx.cardPlay();
  }

  onColorChosen(color) {
    this.el.colorpicker.classList.add('hidden');
    this.sendAction({ type: 'play', payload: { cardId: this.pendingWildCardId, chosenColor: color, callUno: this.callUnoArmed } });
    this.pendingWildCardId = null;
    this.disarmCallUno();
    this.sfx.cardPlay();
  }

  onDraw() {
    this.sendAction({ type: 'draw' });
    this.disarmCallUno();
    this.sfx.draw();
  }

  onCallUno() {
    this.callUnoArmed = !this.callUnoArmed;
    this.el.callUno.classList.toggle('armed', this.callUnoArmed);
  }

  disarmCallUno() {
    this.callUnoArmed = false;
    this.el.callUno.classList.remove('armed');
  }

  showGameOver(view) {
    if (this._gameOverShown) return;
    this._gameOverShown = true;
    const won = view.winner === this.room.playerId;
    this.sfx.win();
    const over = document.createElement('div');
    over.className = 'game-over';
    over.innerHTML = `
      <div class="game-over-card">
        <h2>${won ? '🃏 YOU WIN!' : '🃏 OPPONENT WINS'}</h2>
        <button class="btn-primary" id="uno-back">Back to Hub</button>
      </div>`;
    this.hud.querySelector('.uno-hud').appendChild(over);
    over.querySelector('#uno-back').addEventListener('click', () => this.stop());
  }

  /* ---------------- HUD ---------------- */
  buildHUD() {
    this.hud.innerHTML = `
      <div class="uno-hud">
        <div class="uno-top">
          <span class="uno-turn" id="uno-turn">Waiting…</span>
          <span class="uno-opp" id="uno-opp">Opponent: – cards</span>
        </div>
        <div class="uno-log" id="uno-log"></div>
        <div class="hud-hint" id="uno-hint"></div>
        <div class="hud-banner hidden" id="uno-banner"></div>
        <div class="uno-colorpicker hidden" id="uno-colorpicker">
          <button class="uno-swatch" data-color="red" style="--sw:#ff4d5e"></button>
          <button class="uno-swatch" data-color="yellow" style="--sw:#ffd93d"></button>
          <button class="uno-swatch" data-color="green" style="--sw:#4dff88"></button>
          <button class="uno-swatch" data-color="blue" style="--sw:#4da3ff"></button>
        </div>
        <div class="uno-hand" id="uno-hand"></div>
        <div class="uno-actions">
          <button class="btn-ghost" id="uno-draw">Draw</button>
          <button class="btn-ghost hidden" id="uno-call">Call UNO!</button>
        </div>
        <button class="exit-btn hud-exit" id="uno-exit">✕</button>
      </div>
    `;
    this.el = {
      turn: this.hud.querySelector('#uno-turn'),
      opp: this.hud.querySelector('#uno-opp'),
      log: this.hud.querySelector('#uno-log'),
      hint: this.hud.querySelector('#uno-hint'),
      banner: this.hud.querySelector('#uno-banner'),
      hand: this.hud.querySelector('#uno-hand'),
      draw: this.hud.querySelector('#uno-draw'),
      callUno: this.hud.querySelector('#uno-call'),
      colorpicker: this.hud.querySelector('#uno-colorpicker'),
    };
    this.el.draw.addEventListener('click', () => this.onDraw());
    this.el.callUno.addEventListener('click', () => this.onCallUno());
    for (const sw of this.el.colorpicker.querySelectorAll('.uno-swatch')) {
      sw.addEventListener('click', () => this.onColorChosen(sw.dataset.color));
    }
    this.hud.querySelector('#uno-exit').addEventListener('click', () => this.stop());
  }

  setHint(text) { this.el.hint.textContent = text || ''; this.el.hint.classList.toggle('hidden', !text); }

  banner(text, ms = 1800) {
    this.el.banner.textContent = text;
    this.el.banner.classList.remove('hidden');
    clearTimeout(this._bannerT);
    if (ms) this._bannerT = setTimeout(() => this.el.banner.classList.add('hidden'), ms);
  }

  toast(msg) { this.banner(msg, 2200); }

  /* ---------------- main loop ---------------- */
  tick(frame) {
    if (this._stopped) return;
    if (!this.placed && frame && this.hitTestSource && this.reticle) {
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
    this.renderer.render(this.scene, this.camera);
  }

  /* ---------------- teardown ---------------- */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.renderer.setAnimationLoop(null);
    try { this.session?.end(); } catch (e) { /* already ended */ }
    if (this._beforeSelect) this.hud.removeEventListener('beforexrselect', this._beforeSelect);
    window.removeEventListener('resize', this._onResize);
    const { rt } = this.room;
    rt.off('uno:state', this._onState);
    rt.off('error', this._onError);
    rt.off('room:opponent-disconnected', this._onOppGone);
    rt.off('room:opponent-left', this._onOppLeft);
    if (!this._gameOverShown) rt.send('room:leave', {});
    rt.disconnect();
    this.hud.innerHTML = '';
    this.renderer.dispose();
    this.container.innerHTML = '';
    this.onExit?.();
  }
}
