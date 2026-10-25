// A tic-tac-toe bot that explains itself. It searches the whole game tree (nine squares is small enough),
// ranks every legal move, and says in plain words why it likes each one and what it expects back.
// Pure functions only: the page decides who signs and when.

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export const CELL_NAMES = ['top left', 'top middle', 'top right', 'middle left', 'centre', 'middle right', 'bottom left', 'bottom middle', 'bottom right'];
const CORNERS = [0, 2, 6, 8];
const OPPOSITE = { 0: 8, 2: 6, 6: 2, 8: 0 };

const other = (/** @type {string} */ m) => (m === 'x' ? 'o' : 'x');
const put = (/** @type {string} */ b, /** @type {number} */ i, /** @type {string} */ m) => b.slice(0, i) + m + b.slice(i + 1);
const empties = (/** @type {string} */ b) => [...b].flatMap((c, i) => (c === '.' ? [i] : []));

/** The mark that has three in a row, or '' if nobody has. */
export function winner(/** @type {string} */ b) {
  for (const [p, q, r] of LINES) if (b[p] !== '.' && b[p] === b[q] && b[p] === b[r]) return b[p];
  return '';
}

/** Squares where `m` would complete a line right now. */
export function winningCells(/** @type {string} */ b, /** @type {string} */ m) {
  return empties(b).filter((i) => winner(put(b, i, m)) === m);
}

const memo = new Map();
/** Best result for the side to move, from that side's view: positive wins, 0 draws, negative loses.
 * A result one move further away is one point smaller, so a quicker win beats a slower one. */
function negamax(/** @type {string} */ b, /** @type {string} */ m) {
  const key = b + m;
  const hit = memo.get(key);
  if (hit != null) return hit;
  let best = -Infinity;
  const open = empties(b);
  if (!open.length) best = 0;
  for (const i of open) {
    const nb = put(b, i, m);
    const v = winner(nb) === m ? 10 : -negamax(nb, other(m));
    if (v > best) best = v;
  }
  const v = best > 0 ? best - 1 : best < 0 ? best + 1 : 0;
  memo.set(key, v);
  return v;
}

/** What the game comes to with best play from both sides, if `m` plays `i` now. */
function outcomeAfter(/** @type {string} */ b, /** @type {number} */ i, /** @type {string} */ m) {
  const nb = put(b, i, m);
  if (winner(nb) === m) return { score: 10, outcome: 'win' };
  if (!empties(nb).length) return { score: 0, outcome: 'draw' };
  const v = -negamax(nb, other(m));
  return { score: v, outcome: v > 0 ? 'win' : v < 0 ? 'loss' : 'draw' };
}

/** The reply the opponent would pick after `m` plays `i`, with its own reason. */
function bestReply(/** @type {string} */ b, /** @type {number} */ i, /** @type {string} */ m) {
  const nb = put(b, i, m);
  if (winner(nb) || !empties(nb).length) return null;
  const replies = rankMoves(nb, other(m), { reply: false });
  return replies[0] ?? null;
}

/**
 * Every legal move for `mark` on `board`, best first.
 * Each entry: { cell, name, score, outcome, reason, expect? } where `outcome` is what best play leads to
 * ('win' | 'draw' | 'loss'), `reason` explains the move and `expect` is the opponent's most likely answer.
 * @param {string} board nine characters of '.', 'x' and 'o'
 * @param {'x'|'o'} mark the side to move
 * @param {{reply?: boolean}} [opts]
 */
export function rankMoves(board, mark, opts = {}) {
  if (winner(board)) return [];
  const them = other(mark);
  const myWins = winningCells(board, mark);
  const theirWins = winningCells(board, them);
  const forks = (/** @type {string} */ b, /** @type {string} */ m) => empties(b).filter((i) => winningCells(put(b, i, m), m).length >= 2);
  const theirForks = forks(board, them);
  const moves = empties(board).map((cell) => {
    const { score, outcome } = outcomeAfter(board, cell, mark);
    const after = put(board, cell, mark);
    const threats = winningCells(after, mark);
    let reason;
    let rank; // tie-break between moves with the same score: the more instructive move first
    if (myWins.includes(cell)) {
      reason = `Wins now: it completes three in a row.`;
      rank = 9;
    } else if (theirWins.length && theirWins.includes(cell)) {
      reason = theirWins.length > 1
        ? `Blocks one of ${them.toUpperCase()}'s two winning squares, but ${them.toUpperCase()} still has the other.`
        : `Blocks ${them.toUpperCase()}: they would win on the ${CELL_NAMES[cell]} next move.`;
      rank = 8;
    } else if (theirWins.length) {
      reason = `Ignores ${them.toUpperCase()}'s threat on the ${theirWins.map((i) => CELL_NAMES[i]).join(' and ')}, so ${them.toUpperCase()} wins there.`;
      rank = 0;
    } else if (threats.length >= 2) {
      reason = `Makes a fork: two ways to win (${threats.map((i) => CELL_NAMES[i]).join(' and ')}). ${them.toUpperCase()} can only block one.`;
      rank = 7;
    } else if (theirForks.includes(cell)) {
      reason = `Takes the square where ${them.toUpperCase()} could set up two threats at once.`;
      rank = 6;
    } else if (threats.length === 1) {
      reason = `Threatens to win on the ${CELL_NAMES[threats[0]]}, so ${them.toUpperCase()} has to block there.`;
      rank = 5;
    } else if (cell === 4) {
      reason = `Takes the centre: it sits on four of the eight lines.`;
      rank = 4;
    } else if (CORNERS.includes(cell) && board[OPPOSITE[cell]] === them) {
      reason = `Takes the corner opposite ${them.toUpperCase()}'s, closing the long diagonal through it.`;
      rank = 3;
    } else if (CORNERS.includes(cell)) {
      reason = `Takes a corner: it sits on three lines.`;
      rank = 2;
    } else {
      reason = `Takes an edge: it sits on only two lines.`;
      rank = 1;
    }
    if (outcome === 'loss' && rank > 0) reason += ` But ${them.toUpperCase()} can force a win from here.`;
    if (outcome === 'win' && rank < 9) reason += ` From here ${mark.toUpperCase()} can force a win.`;
    return { cell, name: CELL_NAMES[cell], score, outcome, reason, rank };
  });
  moves.sort((a, b) => b.score - a.score || b.rank - a.rank || a.cell - b.cell);
  return moves.map(({ rank, ...m }) => {
    if (opts.reply === false) return m;
    const r = bestReply(board, m.cell, mark);
    return r ? { ...m, expect: { cell: r.cell, name: r.name, reason: r.reason } } : m;
  });
}

/** A one-line verdict for the position, from `mark`'s view, given the best move. */
export function verdict(/** @type {{outcome: string}|undefined} */ best) {
  if (!best) return '';
  return best.outcome === 'win' ? 'With best play this is a win.' : best.outcome === 'draw' ? 'With best play from both sides this is a draw.' : 'The other side can force a win from here.';
}
