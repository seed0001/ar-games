const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { RoomManager } = require('./rooms');
const uno = require('./uno-engine');
const unoBot = require('./uno-bot');

const HEARTBEAT_MS = 20_000;
const BOT_TURN_DELAY = () => 700 + Math.random() * 500; // feels less robotic than an instant move

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// registry: the extension point future board/card games plug into.
// Each entry owns its own state shape/rules — realtime.js never inspects it.
const gameTypes = new Map();
gameTypes.set('uno', {
  maxPlayers: 2,
  createState: (playerIds) => uno.createGame(playerIds),
  applyAction: (state, playerId, action) => uno.applyAction(state, playerId, action),
  viewFor: (state, playerId) => uno.viewFor(state, playerId),
  stateMessageType: 'uno:state',
  winnerOf: (state) => state.winner,
  currentPlayerOf: (state) => state.order[state.turnIndex],
  supportsBot: true,
  chooseBotAction: (state, botId, alreadyDrewThisTurn) => unoBot.chooseBotAction(state, botId, alreadyDrewThisTurn),
});

module.exports = function attachRealtime(server, db) {
  const rooms = new RoomManager();
  const wss = new WebSocketServer({ server, path: '/ws' });

  function send(ws, type, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type, payload })); } catch (e) { /* socket closing */ }
  }

  function broadcastState(room) {
    const gt = gameTypes.get(room.gameType);
    rooms.broadcast(room, (r, player) => ({
      type: gt.stateMessageType,
      payload: gt.viewFor(r.state, player.playerId),
    }));
  }

  function notifyOthers(room, exceptPlayerId, type, payload) {
    for (const p of room.players) {
      if (p.playerId === exceptPlayerId || !p.connected || !p.ws) continue;
      send(p.ws, type, payload);
    }
  }

  function creditWin(room) {
    if (room.vsBot) return; // practice mode — doesn't touch the real-opponent leaderboard
    const gt = gameTypes.get(room.gameType);
    const winnerPlayerId = gt.winnerOf(room.state);
    if (!winnerPlayerId) return;
    const winner = rooms.findPlayer(room, winnerPlayerId);
    const userId = winner?.meta?.userId;
    if (!userId) return;
    const priorBest = db.prepare('SELECT MAX(score) AS best FROM scores WHERE user_id = ? AND mode = ?').get(userId, room.gameType).best || 0;
    db.prepare('INSERT INTO scores (user_id, mode, score) VALUES (?, ?, ?)').run(userId, room.gameType, priorBest + 1);
  }

  function teardownRoom(room, reason) {
    for (const p of room.players) {
      if (p.connected && p.ws) send(p.ws, 'room:opponent-left', { reason });
    }
    rooms.leaveRoom(room.roomId);
  }

  /** once a room has its full player count, create game state and kick things off */
  function startGameIfReady(room) {
    const gt = gameTypes.get(room.gameType);
    if (room.players.length !== room.maxPlayers) return;
    room.state = gt.createState(room.players.map((p) => p.playerId));
    rooms.broadcast(room, () => ({ type: 'room:ready', payload: {} }));
    broadcastState(room);
    maybeTakeBotTurn(room);
  }

  /** if it's now the bot's turn, play it out (possibly several actions: draw, then play-or-pass) */
  function maybeTakeBotTurn(room, hasDrawn = false) {
    if (!room.vsBot || !room.state || room.state.status !== 'playing') return;
    const gt = gameTypes.get(room.gameType);
    const bot = room.players.find((p) => p.meta?.isBot);
    if (!bot || gt.currentPlayerOf(room.state) !== bot.playerId) return;
    setTimeout(() => {
      if (!rooms.getRoom(room.roomId) || room.state.status !== 'playing') return;
      if (gt.currentPlayerOf(room.state) !== bot.playerId) return; // safety: state may have changed
      const action = gt.chooseBotAction(room.state, bot.playerId, hasDrawn);
      const result = gt.applyAction(room.state, bot.playerId, action);
      if (!result.ok) return; // bot logic should never produce an illegal move, but never let a bad one wedge the game
      broadcastState(room);
      if (result.gameOver) { creditWin(room); return; }
      maybeTakeBotTurn(room, hasDrawn || action.type === 'draw');
    }, BOT_TURN_DELAY());
  }

  wss.on('connection', (ws, req) => {
    const token = parseCookie(req.headers.cookie, 'token');
    let authedUser = null;
    if (token) {
      try { authedUser = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me-in-production'); }
      catch (e) { /* treat as unauthenticated */ }
    }
    if (!authedUser) { ws.close(1008, 'Not signed in'); return; }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const conn = { roomId: null, playerId: null };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      const { type, roomId, payload } = msg || {};

      if (type === 'room:create') {
        const gameType = payload?.gameType;
        const gt = gameTypes.get(gameType);
        if (!gt) return send(ws, 'error', { code: 'unknown_game', message: 'Unknown game type' });
        const vsBot = !!payload?.vsBot;
        if (vsBot && !gt.supportsBot) return send(ws, 'error', { code: 'no_bot', message: 'This game has no bot opponent yet' });
        const { room, player } = rooms.createRoom(gameType, gt.maxPlayers, { userId: authedUser.id, username: authedUser.username });
        rooms.attachSocket(room.roomId, player.playerId, ws);
        conn.roomId = room.roomId; conn.playerId = player.playerId;
        if (vsBot) {
          room.vsBot = true;
          rooms.addBotPlayer(room);
        }
        send(ws, 'room:created', { roomId: room.roomId, code: room.code, playerId: player.playerId, reconnectToken: player.reconnectToken, seat: player.seat, vsBot });
        startGameIfReady(room);
        return;
      }

      if (type === 'room:join') {
        const result = rooms.joinRoom(payload?.code, { userId: authedUser.id, username: authedUser.username });
        if (result.error) return send(ws, 'error', { code: 'join_failed', message: result.error });
        const { room, player } = result;
        rooms.attachSocket(room.roomId, player.playerId, ws);
        conn.roomId = room.roomId; conn.playerId = player.playerId;
        send(ws, 'room:joined', { roomId: room.roomId, playerId: player.playerId, reconnectToken: player.reconnectToken, seat: player.seat });
        notifyOthers(room, player.playerId, 'room:player-joined', { seat: player.seat, playerCount: room.players.length });
        startGameIfReady(room);
        return;
      }

      if (type === 'room:reconnect') {
        const result = rooms.reconnect(payload?.roomId, payload?.playerId, payload?.reconnectToken, ws);
        if (result.error) return send(ws, 'error', { code: 'reconnect_failed', message: result.error });
        conn.roomId = result.room.roomId; conn.playerId = result.player.playerId;
        send(ws, 'room:joined', { roomId: result.room.roomId, playerId: result.player.playerId, reconnectToken: result.player.reconnectToken, seat: result.player.seat });
        if (result.room.state) {
          const gt = gameTypes.get(result.room.gameType);
          send(ws, gt.stateMessageType, gt.viewFor(result.room.state, result.player.playerId));
        }
        return;
      }

      if (type === 'room:leave') {
        const room = rooms.getRoom(roomId || conn.roomId);
        if (room) teardownRoom(room, 'left');
        return;
      }

      if (type === 'game:action') {
        const room = rooms.getRoom(roomId || conn.roomId);
        if (!room || !room.state) return send(ws, 'error', { code: 'no_room', message: 'Not in an active game' });
        const gt = gameTypes.get(room.gameType);
        const result = gt.applyAction(room.state, conn.playerId, payload?.action);
        if (!result.ok) return send(ws, 'error', { code: 'invalid_action', message: result.error });
        broadcastState(room);
        if (result.gameOver) { creditWin(room); return; }
        maybeTakeBotTurn(room);
        return;
      }
    });

    ws.on('close', () => {
      if (!conn.roomId || !conn.playerId) return;
      const room = rooms.getRoom(conn.roomId);
      if (!room) return;
      notifyOthers(room, conn.playerId, 'room:opponent-disconnected', {});
      rooms.markDisconnected(conn.roomId, conn.playerId, (r) => teardownRoom(r, 'timeout'));
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
};
