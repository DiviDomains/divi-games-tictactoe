// The "your rank" line on the game pages, from the site's GET /leaderboard/rank.json. It only reads the address the
// page already shows; the endpoint is same-origin, which the play pages' CSP (connect-src 'self') allows.

const ENDPOINT = '/leaderboard/rank.json';

/**
 * The line for one game from the endpoint's reply, without the link. `game` is 'tictactoe' or 'blackjack'.
 * @param {'tictactoe'|'blackjack'} game
 * @param {any} data
 */
export function rankText(game, data) {
  const g = data?.[game];
  if (!g || g.rank == null) return game === 'tictactoe' ? 'No finished games yet' : 'No finished hands yet';
  const place = `Rank #${g.rank} of ${g.of}`;
  if (game === 'tictactoe') return `${place} · ${g.wins}–${g.losses}–${g.draws}`;
  return `${place} · ${g.hands} hand${g.hands === 1 ? '' : 's'}, ${g.net_text} GOLD`;
}

/** Of two replies (the playing address and its session key), the one that has a rank, the first when both do. */
export function pickReply(game, replies) {
  const list = replies.filter(Boolean);
  return list.find((r) => r?.[game]?.rank != null) ?? list[0] ?? null;
}

async function fetchRank(/** @type {string} */ addr) {
  try {
    const r = await fetch(`${ENDPOINT}?addr=${encodeURIComponent(addr)}`, { headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * Fill `el` with the rank line for `addrs` (the playing address first, then any session key behind it). The element
 * keeps its last text if the site cannot be reached, and says nothing at all until the first reply.
 * @param {HTMLElement} el
 * @param {'tictactoe'|'blackjack'} game
 * @param {string[]} addrs
 */
export async function showRank(el, game, addrs) {
  const unique = [...new Set(addrs.filter(Boolean))];
  const reply = pickReply(game, await Promise.all(unique.map(fetchRank)));
  if (!reply) return;
  el.replaceChildren(document.createTextNode(`${rankText(game, reply)} · `));
  const a = document.createElement('a');
  a.href = '/leaderboard';
  a.textContent = 'Leaderboard →';
  el.append(a);
  el.hidden = false;
}
