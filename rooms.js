const crypto = require('crypto');

// human-typeable codes: no 0/O or 1/I/L, so a misread character is never ambiguous
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECONNECT_GRACE_MS = 30_000;

function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

/**
 * Game-type-agnostic room/lobby manager. Knows nothing about Uno (or any
 * other game's rules) — `state` is opaque and owned entirely by whoever
 * calls createRoom/joinRoom. This is the extension point future board/card
 * games (chess, checkers, dominoes) reuse instead of building their own
 * room plumbing.
 */
class RoomManager {
  constructor() {
    this.byCode = new Map();
    this.byId = new Map();
  }

  createRoom(gameType, maxPlayers, hostMeta) {
    let code;
    do { code = randomCode(); } while (this.byCode.has(code));
    const roomId = crypto.randomUUID();
    const player = {
      playerId: crypto.randomUUID(),
      seat: 0,
      ws: null,
      connected: false,
      reconnectToken: crypto.randomUUID(),
      meta: hostMeta,
    };
    const room = {
      code, roomId, gameType, maxPlayers,
      players: [player],
      state: null,
      createdAt: Date.now(),
      disconnectTimers: new Map(),
    };
    this.byCode.set(code, room);
    this.byId.set(roomId, room);
    return { room, player };
  }

  joinRoom(code, playerMeta) {
    const room = this.byCode.get(String(code || '').toUpperCase());
    if (!room) return { error: 'Room not found' };
    if (room.players.length >= room.maxPlayers) return { error: 'Room is full' };
    if (room.state && room.state.status && room.state.status !== 'lobby') return { error: 'Game already in progress' };
    const player = {
      playerId: crypto.randomUUID(),
      seat: room.players.length,
      ws: null,
      connected: false,
      reconnectToken: crypto.randomUUID(),
      meta: playerMeta,
    };
    room.players.push(player);
    return { room, player };
  }

  getRoom(roomId) {
    return this.byId.get(roomId);
  }

  /** fills the next seat with a synthetic, always-connected bot player (no real socket) */
  addBotPlayer(room) {
    const player = {
      playerId: crypto.randomUUID(),
      seat: room.players.length,
      ws: null,
      connected: false,
      reconnectToken: null,
      meta: { isBot: true, username: 'Bot' },
    };
    room.players.push(player);
    return player;
  }

  findPlayer(room, playerId) {
    return room?.players.find((p) => p.playerId === playerId) || null;
  }

  attachSocket(roomId, playerId, ws) {
    const room = this.getRoom(roomId);
    const player = this.findPlayer(room, playerId);
    if (!room || !player) return null;
    player.ws = ws;
    player.connected = true;
    const timer = room.disconnectTimers.get(playerId);
    if (timer) { clearTimeout(timer); room.disconnectTimers.delete(playerId); }
    return room;
  }

  reconnect(roomId, playerId, reconnectToken, ws) {
    const room = this.getRoom(roomId);
    const player = this.findPlayer(room, playerId);
    if (!room || !player) return { error: 'Room not found' };
    if (player.reconnectToken !== reconnectToken) return { error: 'Invalid reconnect token' };
    player.ws = ws;
    player.connected = true;
    const timer = room.disconnectTimers.get(playerId);
    if (timer) { clearTimeout(timer); room.disconnectTimers.delete(playerId); }
    return { room, player };
  }

  markDisconnected(roomId, playerId, onExpire) {
    const room = this.getRoom(roomId);
    const player = this.findPlayer(room, playerId);
    if (!room || !player) return;
    player.connected = false;
    player.ws = null;
    const timer = setTimeout(() => {
      room.disconnectTimers.delete(playerId);
      onExpire(room, player);
    }, RECONNECT_GRACE_MS);
    room.disconnectTimers.set(playerId, timer);
  }

  leaveRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return;
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    this.byId.delete(room.roomId);
    this.byCode.delete(room.code);
  }

  /** send each connected player their own payload — buildViewForPlayer(room, player) -> object */
  broadcast(room, buildViewForPlayer) {
    for (const p of room.players) {
      if (!p.connected || !p.ws) continue;
      const payload = buildViewForPlayer(room, p);
      try { p.ws.send(JSON.stringify(payload)); } catch (e) { /* socket likely closing */ }
    }
  }
}

module.exports = { RoomManager, RECONNECT_GRACE_MS };
