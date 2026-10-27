// The status line of a tic-tac-toe table that has ended. Pure, no DOM, so tests/sdk/end-status.test.mjs can run it.
//
// The banner above says the result; this line says the next step, naming only controls the page already shows for
// that table: Rematch or Join rematch (rematch.js), Play again in the bot panel, or the Lobby's New table.

import { rematchParams } from './rematch.js';

/**
 * The status line for ended game `g` as `me` sees it, or null while it is open or playing (the page keeps its own text).
 * @param {any} g a normalised game @param {string} me
 * @param {{who?: (a: string) => string, bots?: string, rematch?: {kind: 'join'|'wait', table: any}|null}} [opts]
 *   who names an address; bots is the table's bot seats ('', 'o', 'x' or 'xo'); rematch is the page's state.rematch
 * @returns {string|null}
 */
export function endStatus(g, me, { who = (a) => a, bots = '', rematch = null } = {}) {
  if (!g || (g.status !== 'finished' && g.status !== 'cancelled')) return null;
  const mine = Boolean(me) && (g.x === me || g.o === me);
  const newTable = 'Go back to the Lobby to start a new table.';
  if (g.status === 'cancelled' || g.result === 'cancelled') {
    const back = g.x === me ? 'Your stake is back in your balance.' : 'Its creator has the stake back.';
    return `${back} ${bots ? 'Press Play again for a new bot table.' : newTable}`;
  }
  if (bots) return bots === 'xo' ? 'Press Play again to watch two new bots.' : 'Press Play again for a new game against the bot.';
  if (!mine) {
    if (!g.winner) return 'This game is over, and it ended in a draw.';
    return `This game is over; ${g.winner === g.o ? 'O' : 'X'} (${who(g.winner)}) won.`;
  }
  const p = rematchParams(g, me);
  if (!p) return newTable;
  if (rematch?.kind === 'join') return `Press Join rematch to play ${who(p.opponent)} again.`;
  if (rematch?.kind === 'wait') return `Your rematch waits for ${who(p.opponent)}: send them the invite link below.`;
  return `Press Rematch to play ${who(p.opponent)} again at the same stake.`;
}
