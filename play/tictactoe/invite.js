// Invite links for tic-tac-toe tables: the link, the Telegram share link, and what someone who opens a table link
// is told. Pure functions, no DOM, so tests/sdk/invite.test.mjs can run them.

/** The full link to table `id`, built from the page's `location` (origin and path, never its query or old hash). */
export function inviteUrl(/** @type {{origin: string, pathname: string}} */ loc, /** @type {string} */ id) {
  return `${loc.origin}${loc.pathname}#${encodeURIComponent(id)}`;
}

/** The table id in a location hash ('' for none). */
export function idFromHash(/** @type {string} */ hash) {
  try {
    return decodeURIComponent(hash.replace(/^#/, '')).trim();
  } catch {
    return '';
  }
}

/** The line that goes with the link when it is shared. `stakeText` is the stake in GOLD, as the page shows it. */
export function shareText(/** @type {string} */ stake, /** @type {string} */ stakeText = stake) {
  return stake === '0' ? 'Play me at tic-tac-toe on DiviGames. It is free.' : `Play me at tic-tac-toe on DiviGames for ${stakeText} GOLD each (testnet).`;
}

/** Telegram's share page for `url` with `text`. A plain link: nothing is sent to Telegram until the person taps it. */
export function telegramShareUrl(/** @type {string} */ url, /** @type {string} */ text) {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/**
 * What a person who opened a table link is told.
 * kind: own | seated | finished | full | expired | reserved | needgold | join
 * @param {{id: string, status: string, x: string|null, o: string|null, opponent: string|null, stake: string}} g
 * @param {{me: string, balance: bigint|null, expired: boolean, short: (a: string) => string, gold?: (base: string) => string}} ctx
 *   `balance` is the viewer's GOLD in base units, or null while unknown (which never blocks a join).
 * @returns {{kind: string, host: string, text: string, canJoin: boolean, faucet: boolean}}
 */
export function arrival(g, { me, balance, expired, short, gold = (s) => s }) {
  const host = g.x ? short(g.x) : '';
  const out = (/** @type {string} */ kind, /** @type {string} */ text, canJoin = false, faucet = false) => ({ kind, host, text, canJoin, faucet });
  if (g.x === me) return out('own', '');
  if (g.o === me) return out('seated', '');
  if (g.status === 'finished' || g.status === 'cancelled') return out('finished', `This game is over, so there is nothing to join. Table by ${host}.`);
  if (g.status !== 'open' || g.o) return out('full', `This table is already full: ${host} is playing someone else.`);
  if (expired) return out('expired', `This table waited a day with nobody joining, so it has expired. Table by ${host}.`);
  if (g.opponent && g.opponent !== me) return out('reserved', `${host} made this table for someone else, so you cannot join it.`);
  const forYou = g.opponent === me ? ' It is for you.' : '';
  const stake = BigInt(g.stake || '0');
  if (stake === 0n) return out('join', `Table by ${host}. Free to play, no stake.${forYou}`, true);
  const staked = `${gold(g.stake)} GOLD each`;
  if (balance != null && balance < stake) {
    return out('needgold', `Table by ${host}. The stake is ${staked} and you have ${gold(String(balance))}. Get some GOLD from the faucet, then join.${forYou}`, false, true);
  }
  return out('join', `Table by ${host}. The stake is ${staked}.${forYou}`, true);
}
