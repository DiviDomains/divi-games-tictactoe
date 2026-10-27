// The "your rank" line on the game pages, from the site's GET /leaderboard/rank.json. It only reads the address the
// page already shows; the endpoint is same-origin, which the play pages' CSP (connect-src 'self') allows.
//
// The site's indexer reads the chain once a minute, and each reply carries the `height` its totals cover. After a game
// or hand finishes, the page asks again (`refreshRank`) until a reply covers the block it finished in.

import { siteUrl } from '../sdk/divigames.js';

const ENDPOINT = '/leaderboard/rank.json';

/**
 * Where to ask for the rank, or null when there is nowhere: a static copy of a game (one that names its site in a
 * `divigames-site` meta tag, say on IPFS) lives away from the site, and the site answers rank.json to its own pages
 * only. Such a page shows no rank line rather than asking its own host, which has no leaderboard.
 */
export function rankEndpoint(doc = globalThis.document) {
  return siteUrl(ENDPOINT, doc) === ENDPOINT ? ENDPOINT : null;
}

/**
 * How often to ask again after a finish, and for how long. The indexer runs every 60 s, so a finish is in the totals
 * within about a minute; asking every 10 s shows it at most 10 s after that, and 3 minutes leaves room for an indexer
 * run that failed or a slow node, at 18 requests per address for each finish.
 */
export const RETRY = { everyMs: 10_000, giveUpMs: 180_000 };

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

/** Whether `reply`'s totals include the block at `finishedAt`. A reply with no height covers nothing. */
export function covers(/** @type {any} */ reply, /** @type {number} */ finishedAt) {
  const h = reply?.height;
  return typeof h === 'number' && Number.isFinite(h) && h >= finishedAt;
}

/**
 * How long to wait before the next try of a loop that started (or last saw a finish) at `startedAt`, or null to give
 * up: a try is made only while it lands within `giveUpMs` of the start.
 * @param {number} startedAt @param {number} now @param {{everyMs: number, giveUpMs: number}} [plan]
 */
export function nextTry(startedAt, now, plan = RETRY) {
  return now + plan.everyMs <= startedAt + plan.giveUpMs ? plan.everyMs : null;
}

/**
 * A finish at `finishedAt` while a loop waits for `target` (null when none runs): the target is the later of the two,
 * and a new loop starts only when none runs.
 * @param {number|null} target @param {number} finishedAt
 */
export function addFinish(target, finishedAt) {
  return target == null ? { target: finishedAt, start: true } : { target: Math.max(target, finishedAt), start: false };
}

/**
 * The rank line's state for one element: the height of the reply it shows, and at most one loop asking again after a
 * finish. `fetchReplies(addrs)` gets one reply (or null) per address; `draw(reply)` shows it.
 * @param {{game: 'tictactoe'|'blackjack', fetchReplies: (addrs: string[]) => Promise<any[]>, draw: (reply: any) => void,
 *   plan?: {everyMs: number, giveUpMs: number}, now?: () => number, sleep?: (ms: number) => Promise<unknown>}} o
 */
export function createRankRefresher({ game, fetchReplies, draw, plan = RETRY, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  /** The height of the reply on show: undefined before any, null for a reply without one. @type {number|null|undefined} */
  let shown;
  /** The finish the running loop waits for, or null when none runs. @type {number|null} */
  let target = null;
  /** The latest finish ever asked for: a finish at or below it starts nothing once its loop has ended. */
  let asked = -Infinity;
  let startedAt = 0;
  /** @type {string[]} */
  let addrs = [];
  /** @type {Promise<void>|null} */
  let loop = null;

  const shownCovers = (/** @type {number} */ at) => typeof shown === 'number' && shown >= at;

  /** Show `reply` unless it is older than the line, or below the finish a loop waits for. */
  function offer(/** @type {any} */ reply) {
    if (!reply) return false;
    const h = typeof reply.height === 'number' ? reply.height : null;
    if (target != null && !covers(reply, target)) return false;
    if (shown != null && (h == null || h < shown)) return false;
    if (h != null && h === shown) return true; // already on show
    shown = h;
    draw(reply);
    return true;
  }

  /** Every reply must cover the finish (the two addresses are read apart); then the one with a rank is drawn. */
  async function look(/** @type {number|null} */ at) {
    const replies = (await fetchReplies(addrs)).filter(Boolean);
    if (!replies.length) return false;
    if (at != null && !replies.every((r) => covers(r, at))) return false;
    return offer(pickReply(game, replies));
  }

  async function run() {
    try {
      for (;;) {
        const wait = nextTry(startedAt, now(), plan);
        if (wait == null) return; // give up: the line keeps its last text
        await sleep(wait);
        if (target == null || shownCovers(target)) return;
        if (await look(target)) return;
      }
    } finally {
      target = null;
      loop = null;
    }
  }

  return {
    /** Look once (page load, another address): drawn unless older than the line or below a pending finish. */
    async show(/** @type {string[]} */ list) {
      addrs = [...new Set(list.filter(Boolean))];
      const replies = (await fetchReplies(addrs)).filter(Boolean);
      offer(pickReply(game, replies));
    },
    /**
     * A game of `list` finished in the block at `finishedAt`: ask again until a reply covers it. Returns the running
     * loop, the same one for finishes close together.
     */
    finished(/** @type {string[]} */ list, /** @type {number} */ finishedAt) {
      addrs = [...new Set(list.filter(Boolean))];
      if (!Number.isFinite(finishedAt) || shownCovers(finishedAt)) return loop ?? Promise.resolve();
      if (loop == null && finishedAt <= asked) return Promise.resolve(); // that finish's loop already ended
      asked = Math.max(asked, finishedAt);
      const next = addFinish(target, finishedAt);
      if (next.target !== target || next.start) startedAt = now();
      target = next.target;
      if (next.start) loop = run();
      return /** @type {Promise<void>} */ (loop);
    },
  };
}

async function fetchRank(/** @type {string} */ addr) {
  try {
    const r = await fetch(`${ENDPOINT}?addr=${encodeURIComponent(addr)}`, { headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** @type {WeakMap<HTMLElement, ReturnType<typeof createRankRefresher>>} */
const refreshers = new WeakMap();

function refresherFor(/** @type {HTMLElement} */ el, /** @type {'tictactoe'|'blackjack'} */ game) {
  let r = refreshers.get(el);
  if (!r) {
    r = createRankRefresher({
      game,
      fetchReplies: (addrs) => Promise.all(addrs.map(fetchRank)),
      draw: (reply) => {
        el.replaceChildren(document.createTextNode(`${rankText(game, reply)} · `));
        const a = document.createElement('a');
        a.href = siteUrl('/leaderboard');
        a.textContent = 'Leaderboard →';
        el.append(a);
        el.hidden = false;
      },
    });
    refreshers.set(el, r);
  }
  return r;
}

/**
 * Fill `el` with the rank line for `addrs` (the playing address first, then any session key behind it). The element
 * keeps its last text if the site cannot be reached, and says nothing at all until the first reply.
 * @param {HTMLElement} el
 * @param {'tictactoe'|'blackjack'} game
 * @param {string[]} addrs
 */
export function showRank(el, game, addrs) {
  if (!rankEndpoint()) return Promise.resolve();
  return refresherFor(el, game).show(addrs);
}

/**
 * After a game of `addrs` finished in the block at `finishedAt`: ask again every `RETRY.everyMs` until the reply
 * covers that block, then fill `el` as `showRank` does. Finishes close together share one loop.
 * @param {HTMLElement} el
 * @param {'tictactoe'|'blackjack'} game
 * @param {string[]} addrs
 * @param {number} finishedAt
 */
export function refreshRank(el, game, addrs, finishedAt) {
  if (!rankEndpoint()) return Promise.resolve();
  return refresherFor(el, game).finished(addrs, finishedAt);
}
