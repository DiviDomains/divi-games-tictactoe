// Tic-tac-toe tables as the chain serves them, shared by the game page and the /play hub: tidying a game from the
// view, judging whether an open table has expired, and finding the tables made for one address. No DOM.
import { invitedIds, isInvitedTo } from './rematch.js';

/** How many pages of 100 recent transactions the invitation search reads. */
const INVITE_PAGES = 3;

/** A game from the view, with defaults filled in. */
export function normGame(/** @type {any} */ g) {
  if (!g || typeof g !== 'object') return null;
  let board = g.board ?? '.........';
  if (Array.isArray(board)) board = board.map((c) => (c === 'x' || c === 'o' ? c : '.')).join('');
  board = String(board).toLowerCase().replace(/[^xo]/g, '.').padEnd(9, '.').slice(0, 9);
  return {
    ...g,
    id: String(g.id ?? g.game_id ?? ''),
    x: g.x ?? g.player_x ?? g.creator ?? null,
    o: g.o ?? g.player_o ?? null,
    opponent: g.opponent ?? g.invited ?? null,
    stake: String(g.stake ?? '0'),
    board,
    turn: String(g.turn ?? 'x').toLowerCase(),
    status: String(g.status ?? 'open').toLowerCase(),
    winner: g.winner ?? null,
    result: g.result ?? null,
    reason: g.reason ?? null,
    last_move_height: Number(g.last_move_height ?? g.created_height ?? 0),
    /** @type {number|null} */ last_move_ms: g.last_move_ms == null ? null : Number(g.last_move_ms),
  };
}

/** The games in a view response: a bare list or `{games}`. */
export const gamesOf = (/** @type {any} */ v) => (Array.isArray(v) ? v : Array.isArray(v?.games) ? v.games : []).map(normGame).filter(Boolean);

/**
 * Whether an open table has waited a day for a second player: the chain then refuses a join and lets anyone cancel it
 * for the creator's refund. Judged on this device's clock (`now`), so it can be a few seconds off the chain's.
 * A table from before the clock rules has no create time and is long past the day.
 * @param {any} g @param {number} now @param {{v3From: number, openExpiryMs: number}} rules
 */
export function openExpiredAt(g, now, { v3From, openExpiryMs }) {
  if (!g || g.status !== 'open' || now < v3From) return false;
  return g.last_move_ms == null || now >= g.last_move_ms + openExpiryMs;
}

/**
 * Open tables made for `me`. The chain lists an invited table neither among the open ones nor under the invited player,
 * so this reads the newest transactions' receipts for tables created with `me` as opponent, then loads each one.
 * @param {{chain: {baseUrl: string, game: (g: string, q: any) => Promise<any>}, me: string, expired: (t: any) => boolean, fetch?: typeof fetch}} o
 * @returns {Promise<any[]>} newest last
 */
export async function invitedTables({ chain, me, expired, fetch = globalThis.fetch.bind(globalThis) }) {
  const ids = [];
  try {
    let before = '';
    for (let page = 0; page < INVITE_PAGES; page++) {
      const res = await fetch(`${chain.baseUrl}/v1/txs?limit=100${before}`);
      if (!res.ok) break;
      const txs = await res.json();
      if (!Array.isArray(txs) || !txs.length) break;
      for (const id of invitedIds(txs, me)) if (!ids.includes(id)) ids.push(id);
      const low = Math.min(...txs.map((t) => Number(t?.receipt?.height)).filter(Number.isFinite));
      if (txs.length < 100 || !Number.isFinite(low)) break;
      before = `&before=${low}`;
    }
  } catch {
    return [];
  }
  const found = await Promise.all(ids.slice(0, 20).map((id) => chain.game('tictactoe', { id }).then(normGame).catch(() => null)));
  return found.filter((g) => isInvitedTo(g, me, expired)).reverse();
}
