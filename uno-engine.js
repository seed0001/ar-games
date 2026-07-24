const crypto = require('crypto');

const COLORS = ['red', 'yellow', 'green', 'blue'];
const HAND_SIZE = 7;

function buildDeck() {
  const deck = [];
  const push = (color, value) => deck.push({ id: crypto.randomUUID(), color, value });
  for (const color of COLORS) {
    push(color, '0');
    for (let n = 1; n <= 9; n++) { push(color, String(n)); push(color, String(n)); }
    for (let i = 0; i < 2; i++) { push(color, 'skip'); push(color, 'reverse'); push(color, 'draw2'); }
  }
  for (let i = 0; i < 4; i++) { push('wild', 'wild'); push('wild', 'wild4'); }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function reshuffleIfNeeded(state) {
  if (state.deck.length > 0) return;
  const top = state.discard.pop();
  state.deck = shuffle(state.discard);
  state.discard = [top];
}

function drawOne(state) {
  reshuffleIfNeeded(state);
  return state.deck.pop();
}

function isPlayable(card, top, currentColor) {
  if (card.color === 'wild') return true;
  return card.color === currentColor || card.value === top.value;
}

function advanceTurn(state, steps = 1) {
  const n = state.order.length;
  state.turnIndex = (state.turnIndex + steps * state.direction + n * steps) % n;
}

function createGame(playerIds) {
  const deck = shuffle(buildDeck());
  const hands = {};
  for (const id of playerIds) hands[id] = [];
  for (let i = 0; i < HAND_SIZE; i++) {
    for (const id of playerIds) hands[id].push(deck.pop());
  }
  // first discard can't be a wild4 or wild (keeps opening color well-defined)
  let firstIdx = deck.length - 1;
  while (deck[firstIdx].color === 'wild') firstIdx--;
  const [first] = deck.splice(firstIdx, 1);

  const state = {
    deck, discard: [first], hands,
    order: [...playerIds],
    turnIndex: 0,
    direction: 1,
    currentColor: first.color,
    status: 'playing',
    winner: null,
    log: [],
  };
  return state;
}

function pushLog(state, msg) {
  state.log.push(msg);
  if (state.log.length > 20) state.log.shift();
}

function currentPlayer(state) {
  return state.order[state.turnIndex];
}

/**
 * action: { type: 'play'|'draw'|'pass', payload }
 * Returns { ok, error?, events? }. Mutates state in place on success.
 *
 * Calling "UNO" is a flag on the `play` action itself (payload.callUno),
 * not a separate action — the penalty for forgetting is checked the instant
 * a play drops a hand to 1 card, so there's no later turn in which a
 * standalone call could still beat it.
 */
function applyAction(state, playerId, action) {
  if (state.status !== 'playing') return { ok: false, error: 'Game is over' };
  if (playerId !== currentPlayer(state)) return { ok: false, error: 'Not your turn' };
  const hand = state.hands[playerId];
  const top = state.discard[state.discard.length - 1];

  if (action.type === 'draw') {
    const card = drawOne(state);
    hand.push(card);
    pushLog(state, `${playerId} drew a card`);
    return { ok: true, drewPlayable: isPlayable(card, top, state.currentColor) };
  }

  if (action.type === 'pass') {
    advanceTurn(state);
    return { ok: true };
  }

  if (action.type === 'play') {
    const { cardId, chosenColor, callUno } = action.payload || {};
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return { ok: false, error: 'Card not in hand' };
    const card = hand[idx];
    if (!isPlayable(card, top, state.currentColor)) return { ok: false, error: 'Card does not match color/value' };
    if (card.color === 'wild' && !COLORS.includes(chosenColor)) return { ok: false, error: 'Must choose a color for a wild card' };

    hand.splice(idx, 1);
    state.discard.push(card);
    state.currentColor = card.color === 'wild' ? chosenColor : card.color;

    if (hand.length === 0) {
      state.status = 'finished';
      state.winner = playerId;
      pushLog(state, `${playerId} played their last card and won!`);
      return { ok: true, gameOver: true };
    }
    // calling UNO happens in the same action as the play that drops you to 1 card —
    // there's no separate turn in between to call it, so a standalone 'callUno'
    // action could never beat this check otherwise
    if (hand.length === 1 && !callUno) {
      hand.push(drawOne(state), drawOne(state));
      pushLog(state, `${playerId} forgot to call UNO — penalty draw 2`);
    } else if (hand.length === 1) {
      pushLog(state, `${playerId} called UNO!`);
    }

    switch (card.value) {
      case 'skip':
        advanceTurn(state, 2);
        break;
      case 'reverse':
        state.direction *= -1;
        // with exactly 2 players a reverse behaves like a skip (bounces back to the same player)
        advanceTurn(state, state.order.length === 2 ? 2 : 1);
        break;
      case 'draw2': {
        advanceTurn(state);
        const victim = currentPlayer(state);
        state.hands[victim].push(drawOne(state), drawOne(state));
        pushLog(state, `${victim} drew 2`);
        advanceTurn(state);
        break;
      }
      case 'wild4': {
        advanceTurn(state);
        const victim = currentPlayer(state);
        state.hands[victim].push(drawOne(state), drawOne(state), drawOne(state), drawOne(state));
        pushLog(state, `${victim} drew 4`);
        advanceTurn(state);
        break;
      }
      default:
        advanceTurn(state);
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown action' };
}

/** sanitized per-player view: own hand in full, opponents as counts only */
function viewFor(state, playerId) {
  const top = state.discard[state.discard.length - 1];
  return {
    hand: state.hands[playerId] || [],
    topCard: top,
    currentColor: state.currentColor,
    order: state.order,
    turnPlayer: currentPlayer(state),
    direction: state.direction,
    deckCount: state.deck.length,
    opponentCounts: Object.fromEntries(state.order.filter((id) => id !== playerId).map((id) => [id, state.hands[id].length])),
    status: state.status,
    winner: state.winner,
    log: state.log.slice(-5),
  };
}

module.exports = { createGame, applyAction, viewFor, COLORS };
