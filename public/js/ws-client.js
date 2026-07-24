/**
 * Generic reconnecting WebSocket client — game-agnostic, reusable for any
 * future realtime multiplayer game (chess, checkers, dominoes, ...).
 * Persists the active room/player/reconnect-token in sessionStorage so a
 * refresh or brief connection drop can resume the same seat.
 */
const SESSION_KEY = 'camfun:rt-session';

export class RealtimeClient {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.roomId = null;
    this.reconnectAttempts = 0;
    this._manualClose = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      let settled = false;
      ws.addEventListener('open', () => {
        this.reconnectAttempts = 0;
        settled = true;
        resolve();
      });
      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        const hs = this.handlers.get(msg.type);
        if (hs) for (const h of hs) h(msg.payload);
      });
      ws.addEventListener('close', () => {
        if (!settled) { reject(new Error('Could not connect')); return; }
        if (this._manualClose) return;
        const delay = Math.min(5000, 500 * 2 ** this.reconnectAttempts++);
        setTimeout(() => {
          this.connect().then(() => this._tryResume()).catch(() => {});
        }, delay);
      });
      ws.addEventListener('error', () => {});
    });
  }

  _tryResume() {
    const saved = this.loadSession();
    if (saved) {
      this.roomId = saved.roomId;
      this.send('room:reconnect', saved);
    }
  }

  send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, roomId: this.roomId, payload }));
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
  }

  off(type, handler) {
    this.handlers.get(type)?.delete(handler);
  }

  saveSession(data) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); }
  loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
  clearSession() { sessionStorage.removeItem(SESSION_KEY); }

  disconnect() {
    this._manualClose = true;
    this.clearSession();
    try { this.ws?.close(); } catch (e) { /* already closed */ }
  }
}
