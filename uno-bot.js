const COLORS = ['red', 'yellow', 'green', 'blue'];

/** the color the bot has the most of in hand — maximizes future playable cards */
function pickBestColor(hand, excludeCardId) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (c.id !== excludeCardId && c.color !== 'wild') counts[c.color]++;
  let best = COLORS[0], bestN = -1;
  for (const color of COLORS) if (counts[color] > bestN) { best = color; bestN = counts[color]; }
  return best;
}

/**
 * Decides the bot's single next action from the current engine state.
 * realtime.js calls this repeatedly as a turn plays out (e.g. draw, then a
 * follow-up play-or-pass) — same shape as a human working through one turn.
 * `alreadyDrewThisTurn` stops the bot from drawing more than once per turn.
 */
function chooseBotAction(state, botId, alreadyDrewThisTurn) {
  const hand = state.hands[botId];
  const top = state.discard[state.discard.length - 1];
  const playable = hand.filter((c) => c.color === 'wild' || c.color === state.currentColor || c.value === top.value);

  if (playable.length === 0) {
    return alreadyDrewThisTurn ? { type: 'pass' } : { type: 'draw' };
  }

  // prefer a non-wild match first, saving wilds for when genuinely stuck
  const nonWild = playable.filter((c) => c.color !== 'wild');
  const pool = nonWild.length ? nonWild : playable;
  const card = pool[Math.floor(Math.random() * pool.length)];

  const payload = { cardId: card.id };
  if (card.color === 'wild') payload.chosenColor = pickBestColor(hand, card.id);
  if (hand.length === 2) payload.callUno = true; // about to drop to 1 card — a bot never forgets to call it

  return { type: 'play', payload };
}

module.exports = { chooseBotAction };
