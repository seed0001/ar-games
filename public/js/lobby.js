import { RealtimeClient } from './ws-client.js';

const $ = (id) => document.getElementById(id);

/**
 * Create/join-by-code matchmaking UI, rendered into the existing leaderboard
 * modal (same idiom the worlds gallery already uses — no new screen).
 * Resolves nothing itself; calls onMatched({roomId, playerId, seat, rt})
 * once both seats are filled, then closes the modal.
 */
export async function openLobby({ gameType, gameLabel = 'Game', supportsBot = false, onMatched }) {
  const rt = new RealtimeClient();

  $('modal-title').textContent = `${gameLabel} — Room`;
  $('modal').classList.remove('hidden');
  renderChoose();

  // swap the shared close button for one that also tears down the socket —
  // restored to its default (just hide the modal) once we're done with it
  const closeBtn = $('modal-close');
  const freshClose = closeBtn.cloneNode(true);
  closeBtn.replaceWith(freshClose);
  freshClose.addEventListener('click', () => {
    rt.disconnect();
    $('modal').classList.add('hidden');
  });

  function renderChoose(error) {
    $('modal-body').innerHTML = `
      ${supportsBot ? `
        <button class="btn-primary" id="lobby-bot">🤖 Play vs Bot</button>
        <div class="lobby-or">— or play a friend —</div>
      ` : ''}
      <button class="${supportsBot ? 'btn-secondary' : 'btn-primary'}" id="lobby-create">Create room</button>
      <div class="lobby-or">— or join one —</div>
      <div class="lobby-join-row">
        <input id="lobby-code" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off">
        <button class="btn-secondary" id="lobby-join">Join</button>
      </div>
      ${error ? `<div class="lobby-error">${error}</div>` : ''}
    `;
    if (supportsBot) {
      $('modal-body').querySelector('#lobby-bot').addEventListener('click', () => {
        rt.send('room:create', { gameType, vsBot: true });
      });
    }
    $('modal-body').querySelector('#lobby-create').addEventListener('click', () => {
      rt.send('room:create', { gameType });
    });
    $('modal-body').querySelector('#lobby-join').addEventListener('click', () => {
      const code = $('modal-body').querySelector('#lobby-code').value.trim().toUpperCase();
      if (code) rt.send('room:join', { code });
    });
  }

  function renderWaiting(code) {
    $('modal-body').innerHTML = `
      <div class="lobby-waiting">
        <div class="lobby-code-display">${code}</div>
        <p class="lobby-hint">Share this code — waiting for your opponent…</p>
        <div class="lobby-spinner"></div>
      </div>`;
  }

  function renderConnecting(hint = 'Joining room…') {
    $('modal-body').innerHTML = `
      <div class="lobby-waiting">
        <p class="lobby-hint">${hint}</p>
        <div class="lobby-spinner"></div>
      </div>`;
  }

  rt.on('room:created', (payload) => {
    rt.roomId = payload.roomId;
    rt.saveSession({ roomId: payload.roomId, playerId: payload.playerId, reconnectToken: payload.reconnectToken, seat: payload.seat, gameType });
    if (payload.vsBot) renderConnecting('Setting up your bot opponent…');
    else renderWaiting(payload.code);
  });

  rt.on('room:joined', (payload) => {
    rt.roomId = payload.roomId;
    rt.saveSession({ roomId: payload.roomId, playerId: payload.playerId, reconnectToken: payload.reconnectToken, seat: payload.seat, gameType });
    renderConnecting();
  });

  rt.on('error', (payload) => renderChoose(payload.message || 'Something went wrong'));

  rt.on('room:ready', () => {
    const session = rt.loadSession();
    $('modal').classList.add('hidden');
    onMatched({ roomId: session.roomId, playerId: session.playerId, seat: session.seat, rt });
  });

  await rt.connect();
}
