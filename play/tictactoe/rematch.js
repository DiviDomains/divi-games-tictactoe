// Rematches and invitations for tic-tac-toe tables. Pure functions, no DOM, so tests/sdk/rematch.test.mjs can run them.
//
// A rematch is an ordinary invited table: the chain's create op with `opponent` set, at the same stake. Whoever makes it
// is the table's creator, so they are X and move first. Nothing here needs a new chain op or view.

/**
 * The create-op fields for a rematch of finished game `g`, as seen by `me`; null when there is none to offer
 * (not a player, not finished, or the game never had two players).
 * @param {any} g a normalised game @param {string} me
 * @returns {{stake: string, opponent: string}|null}
 */
export function rematchParams(g, me) {
  if (!g || !me || g.status !== 'finished' || !g.x || !g.o) return null;
  if (g.x !== me && g.o !== me) return null;
  return { stake: String(g.stake ?? '0'), opponent: g.x === me ? g.o : g.x };
}

/**
 * The rematch table for finished game `g` among `tables` (games to look through, any status): one the other player made
 * for me ('join', preferred) or one I made for them ('wait'). A table counts only if it is open, unexpired, at the same
 * stake, made for exactly this pair, and made after the game's last move (when both times are known).
 * @param {any} g @param {string} me @param {any[]} tables @param {(t: any) => boolean} expired
 * @returns {{kind: 'join'|'wait', table: any}|null}
 */
export function findRematch(g, me, tables, expired) {
  const p = rematchParams(g, me);
  if (!p) return null;
  const fits = (/** @type {any} */ t) =>
    t && t.id !== g.id && t.status === 'open' && !t.o && String(t.stake ?? '0') === p.stake && !expired(t)
    && !(t.last_move_ms != null && g.last_move_ms != null && t.last_move_ms < g.last_move_ms);
  const newest = (/** @type {any[]} */ a) => a.reduce((best, t) => (!best || Number(t.last_move_ms ?? 0) >= Number(best.last_move_ms ?? 0) ? t : best), null);
  const theirs = newest((tables ?? []).filter((t) => fits(t) && t.x === p.opponent && t.opponent === me));
  if (theirs) return { kind: 'join', table: theirs };
  const mine = newest((tables ?? []).filter((t) => fits(t) && t.x === me && t.opponent === p.opponent));
  return mine ? { kind: 'wait', table: mine } : null;
}

/**
 * Ids of tables created for `me` (not by me), from recent transactions as `GET /v1/txs` serves them. The chain lists an
 * invited table neither as open nor under the invited player, so the receipts' `tictactoe.created` events are the way in.
 * @param {any[]|null|undefined} txs @param {string} me @returns {string[]}
 */
export function invitedIds(txs, me) {
  const out = new Set();
  if (!me) return [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx?.receipt?.ok) continue;
    for (const e of tx.receipt.events ?? []) {
      if (e?.kind === 'tictactoe.created' && e.data?.opponent === me && e.data?.x !== me && e.data?.id) out.add(String(e.data.id));
    }
  }
  return [...out];
}

/** Whether table `g` is an open invitation to `me` that can still be joined. @param {any} g @param {string} me @param {(t: any) => boolean} expired */
export function isInvitedTo(g, me, expired) {
  return Boolean(g && me && g.status === 'open' && g.opponent === me && g.x !== me && !expired(g));
}
