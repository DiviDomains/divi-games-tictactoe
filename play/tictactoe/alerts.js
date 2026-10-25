// Turn alerts for tic-tac-toe tables: what the tab title and the alert text say for a game and a viewer, and what the
// "Tell me when it's my move" toggle may do. Pure functions, no DOM, so tests/sdk/turn-alert.test.mjs can run them.

export const BASE_TITLE = 'Tic-tac-toe · DiviGames';
/** The page calls it urgent when the player on the move has this long (or less) before the other can claim a timeout. */
export const URGENT_MS = 60_000;

const NAME = 'Tic-tac-toe';
const t = (/** @type {string} */ lead) => `${lead} · ${NAME}`;

/**
 * @typedef {'none'|'rematch'|'waiting'|'joined'|'your-move'|'their-move'|'won'|'lost'|'drawn'|'timeout-won'|'timeout-lost'|'cancelled'|'expired'} Kind
 * @typedef {{kind: Kind, title: string, text: string, urgent: boolean, secondsLeft: number|null}} Alert
 */

/**
 * The alert for game `g` as seen by address `me`.
 * @param {any} g a normalised game, or null
 * @param {string} me
 * @param {{prev?: any, dueMs?: number|null, now?: number, expired?: boolean, rematch?: string|null}} [o]
 *   `prev`: the game as last seen (to tell that someone joined). `dueMs`: when the player on the move can be claimed
 *   against, or null when unknown. `expired`: an open table past its day. `rematch`: 'join' when the other player has a rematch table waiting for me.
 * @returns {Alert}
 */
export function turnAlert(g, me, { prev = null, dueMs = null, now = Date.now(), expired = false, rematch = null } = {}) {
  /** @type {(kind: Kind, title: string, text?: string, urgent?: boolean, secondsLeft?: number|null) => Alert} */
  const out = (kind, title, text = '', urgent = false, secondsLeft = null) => ({ kind, title, text, urgent, secondsLeft });
  const none = out('none', BASE_TITLE);
  if (!g || !me) return none;
  const seated = g.x === me || g.o === me;

  if (g.status === 'open') {
    if (g.x !== me) return none;
    return expired ? out('expired', t('Table expired'), 'Your table waited a day with nobody joining.') : out('waiting', t('Waiting for a player'), 'Waiting for a player to join your table.');
  }
  if (!seated) return none;
  if (g.status === 'cancelled' || g.result === 'cancelled') return out('cancelled', t('Table cancelled'), 'The table was cancelled.');
  if (g.status === 'finished') {
    if (rematch === 'join') return out('rematch', t('↻ Rematch offered'), 'Your opponent wants a rematch.');
    if (g.result === 'draw') return out('drawn', t('= Draw'), 'The game ended in a draw.');
    if (!g.winner) return none;
    const timeout = g.reason === 'timeout';
    if (g.winner === me) return timeout ? out('timeout-won', t('✓ You won on timeout'), 'You won: your opponent ran out of time.') : out('won', t('✓ You won'), 'You won the game.');
    return timeout ? out('timeout-lost', t('✗ You lost on timeout'), 'You lost on timeout: you did not move in time.') : out('lost', t('✗ You lost'), 'You lost the game.');
  }
  if (g.status !== 'playing') return none;

  const mark = g.x === me ? 'x' : 'o';
  if (g.turn !== mark) return out('their-move', BASE_TITLE, 'Waiting for your opponent to move.');

  const joined = prev?.status === 'open' && g.x === me;
  const left = dueMs == null ? null : dueMs - now;
  if (left != null && left <= URGENT_MS) {
    if (left <= 0) return out(joined ? 'joined' : 'your-move', t('⚠ Your move, time is up'), 'Your time is up: your opponent can claim the timeout now.', true, 0);
    const secs = Math.ceil(left / 1000);
    return out(joined ? 'joined' : 'your-move', t(`⚠ Your move, ${secs}s left`), `Your move: ${secs} second${secs === 1 ? '' : 's'} left before your opponent can claim the timeout.`, true, secs);
  }
  return joined
    ? out('joined', t('● Your move'), 'Your opponent joined your table. It is your move.')
    : out('your-move', t('● Your move'), 'It is your move.');
}

const NEWS = new Set(['rematch', 'joined', 'your-move', 'won', 'lost', 'drawn', 'timeout-won', 'timeout-lost']);

/**
 * Whether going from `prevKind` to `kind` is worth a notification. `prevKind` is undefined on the first look at a
 * table, which is never news; every block re-renders the table, so staying in a state is not news either.
 * @param {Kind|undefined} prevKind @param {Kind} kind
 */
export function shouldNotify(prevKind, kind) {
  if (prevKind === undefined || prevKind === kind) return false;
  if (prevKind === 'joined' && kind === 'your-move') return false;
  return NEWS.has(kind);
}

/**
 * What the "Tell me when it's my move" toggle does when clicked (or restored from the saved choice).
 * `ask`: call Notification.requestPermission() (only ever from a click). `on`: notifications are enabled. `note`: what
 * to tell the player when they cannot be.
 * @param {{supported: boolean, permission: string, wanted: boolean}} o
 */
export function notifyPlan({ supported, permission, wanted }) {
  if (!wanted) return { ask: false, on: false, note: '' };
  if (!supported) return { ask: false, on: false, note: 'This browser does not support notifications. The tab title still shows when it is your move.' };
  if (permission === 'denied') return { ask: false, on: false, note: 'Notifications are blocked for this site in your browser settings. The tab title still shows when it is your move.' };
  if (permission === 'granted') return { ask: false, on: true, note: '' };
  return { ask: true, on: false, note: '' };
}
