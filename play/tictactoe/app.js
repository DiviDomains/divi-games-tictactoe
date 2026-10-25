// Tic-tac-toe on Divi Games testnet. Plain ES module, no build step, no requests except to the chain API and the site's own rank line (rank.js).
//
//   /play/tictactoe/                    lobby
//   /play/tictactoe/#<id>               a table
//   ?chain=http://127.0.0.1:7410        use another chain API root (default: <this origin>/chain; only on localhost, or this site's own origin)

import { Chain, Key, NETWORK, formatAmount, parseAmount, isAddress, txBody, txidOf, localTime, timeLeft, readableError, setTextWithLinks, faucetFastNote } from '../../sdk/divigames.js';
import { mountWallets } from '../../sdk/connect.js';
import { showRank } from '../rank.js';
import { generateMnemonic, keyFromMnemonic, validateMnemonic } from '../../sdk/hd.js';
import { CELL_NAMES as CELL, LINES, rankMoves } from './bot.js';

/** A square's name for a screen reader: "Top left, row 1, column 1". */
const cellLabel = (/** @type {number} */ i) =>
  `${CELL[i][0].toUpperCase()}${CELL[i].slice(1)}, row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}`;
import { createChainLog } from './chainlog.js';
import { inviteUrl, idFromHash, shareText, telegramShareUrl, arrival } from './invite.js';
import { BASE_TITLE, turnAlert, shouldNotify, notifyPlan } from './alerts.js';
import { rematchParams, findRematch } from './rematch.js';
import { normGame, gamesOf, invitedTables as invitedTablesFor, openExpiredAt } from './tables.js';

const GAME = 'tictactoe';
const KEY_STORE = 'dg.playkey.wif';
// "Tell me when it's my move": '1' once the player has turned browser notifications on, '0' after they turn them off.
const ALERT_STORE = 'dg.turn-alerts';
// The two bots each have their own 12-word testnet recovery phrase in this browser, the same kind an IronDivi wallet
// makes, and sign with address 0 of it. They play for no stake, so they never hold anything.
const BOT_PHRASES = { x: 'dg.botphrase.x', o: 'dg.botphrase.o' };
// Before the phrases, each bot had a single key. Tables they played still show, and still finish, with those keys.
const BOT_STORES = { x: 'dg.botkey.x.wif', o: 'dg.botkey.o.wif' };

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const chain = Chain.fromPage();

/** Page state. */
const state = {
  /** @type {Key} */ key: loadKey(KEY_STORE),
  /** Set by initBots() before anything else runs. @type {{x: Key, o: Key}} */
  bots: /** @type {any} */ ({ x: null, o: null }),
  /** The derivation path of each bot's key. */
  botPaths: { x: '', o: '' },
  /** The lobby shows every game, not just the recent ones. */
  showOlder: false,
  /** @type {{x: Key|null, o: Key|null}} */
  oldBots: { x: loadKeyIfAny(BOT_STORES.x), o: loadKeyIfAny(BOT_STORES.o) },
  /** The address that plays: the connected wallet's, or the guest key's. */
  me: '',
  decimals: 2,
  timeoutBlocks: 150,
  timeoutMs: 5 * 60 * 1000,
  /** Block time from which timeouts run on the clock instead of on block height. */
  clockFrom: Infinity,
  /** How long an open table waits for a second player, and the block time from which the chain enforces it. */
  openExpiryMs: 24 * 60 * 60 * 1000,
  v3From: 1793577600000,
  height: 0,
  /** @type {string|null} */ gameId: null,
  /** @type {any} */ game: null,
  /** @type {number|null} */ pendingCell: null,
  /** The mark shown in the pending cell (yours, or a bot's). */
  pendingMark: '',
  /** Your GOLD in base units; null until the first answer. @type {bigint|null} */ balance: null,
  /** Turn alerts: what the last look at this table said, whether it was open, and whether notifications are on. */
  alert: { /** @type {string|undefined} */ kind: undefined, wasOpen: false, notify: false },
  /** The rematch table for the finished game in view: one to join, or one you made and wait on. @type {{kind: 'join'|'wait', table: any}|null} */
  rematch: null,
};

// ---------- small helpers ----------

/**
 * Create an element. Text children are set with textContent, so chain data is never parsed as HTML.
 * @param {string} tag @param {Record<string, any>} [props] @param {...(Node|string|null|undefined|false)} children
 */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') /** @type {any} */ (n)[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}

const short = (/** @type {string|null|undefined} */ a) => (a ? (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a) : '');
const who = (/** @type {string|null|undefined} */ a) => {
  if (!a) return '';
  if (a === state.me) return 'you';
  for (const m of /** @type {const} */ (['x', 'o'])) {
    if (a === state.bots[m]?.address) return `Bot ${m.toUpperCase()}`;
    if (a === state.oldBots[m]?.address) return `Bot ${m.toUpperCase()} (old key)`;
  }
  return short(a);
};
const gold = (/** @type {any} */ base) => {
  try {
    return formatAmount(String(base ?? '0'), state.decimals);
  } catch {
    return String(base);
  }
};

/** Show a message in an inline status element. kind: error | ok | info. Empty text hides it. */
const clearTimers = new WeakMap();

/** Show a status line under a control. Success notes fade after a few seconds; errors stay until replaced. */
function say(/** @type {HTMLElement} */ node, text = '', kind = 'info') {
  clearTimeout(clearTimers.get(node));
  text = readableError(text);
  setTextWithLinks(node, text);
  node.dataset.kind = kind;
  node.hidden = !text;
  if (text && kind === 'ok') {
    clearTimers.set(node, setTimeout(() => { if (node.textContent === text) say(node, ''); }, 5000));
  }
}

const errText = (/** @type {any} */ e) => (e && e.message) || String(e);

// ---------- the play key ----------

function storageGet(store = KEY_STORE) {
  try {
    return localStorage.getItem(store);
  } catch {
    return null;
  }
}
function storageSet(/** @type {string} */ wif, store = KEY_STORE) {
  try {
    localStorage.setItem(store, wif);
    return true;
  } catch {
    return false;
  }
}

function loadKey(/** @type {string} */ store) {
  const k = loadKeyIfAny(store);
  if (k) return k;
  const fresh = Key.generate(NETWORK);
  storageSet(fresh.toWif(), store);
  return fresh;
}

/** The testnet key saved under `store`, or null. Never makes one. */
function loadKeyIfAny(/** @type {string} */ store) {
  const wif = storageGet(store);
  if (!wif) return null;
  try {
    const k = Key.fromWif(wif);
    return k.network === NETWORK ? k : null;
  } catch {
    return null;
  }
}

/** Each bot's 12 words, made once and kept in this browser. */
function botPhrase(/** @type {'x'|'o'} */ mark) {
  const saved = storageGet(BOT_PHRASES[mark]);
  if (saved && validateMnemonic(saved)) return saved;
  const phrase = generateMnemonic();
  storageSet(phrase, BOT_PHRASES[mark]);
  return phrase;
}

/** Derive both bots' keys from their phrases: address 0 on the testnet path an IronDivi wallet uses. */
async function initBots() {
  for (const m of /** @type {const} */ (['x', 'o'])) {
    const { key, path } = await keyFromMnemonic(botPhrase(m), { network: NETWORK });
    state.bots[m] = key;
    state.botPaths[m] = path;
  }
}

/** The bot key that sits at `addr` as `mark`: today's phrase key, or the old single key. */
function botKeyFor(/** @type {string|null|undefined} */ addr, /** @type {'x'|'o'} */ mark) {
  if (!addr) return null;
  if (addr === state.bots[mark]?.address) return state.bots[mark];
  if (addr === state.oldBots[mark]?.address) return state.oldBots[mark];
  return null;
}

// ---------- normalising chain responses (cheap defence against small naming differences) ----------

/** Balance of `token` from an account response: `balances` as {SYM: "n"} or [{token|symbol, amount|balance}]. */
function balanceOf(/** @type {any} */ account, token = 'GOLD') {
  const b = account?.balances ?? account?.balance;
  if (Array.isArray(b)) {
    const row = b.find((r) => (r.token ?? r.symbol) === token);
    return String(row?.amount ?? row?.balance ?? '0');
  }
  if (b && typeof b === 'object') return String(b[token] ?? '0');
  return '0';
}

// ---------- sending actions ----------

let queue = Promise.resolve();

/**
 * Sign and submit a game op (or any action), wait for its block, and report the outcome inline.
 * Actions from this page run one at a time, so each gets the right nonce.
 * @param {any} action @param {HTMLElement} msg @param {HTMLButtonElement[]} [buttons] @param {Key} [signer] who signs: you, or a bot
 * @returns {Promise<any|null>} the receipt when ok, else null
 */
function run(action, msg, buttons = [], signer = state.key) {
  const job = async () => {
    buttons.forEach((b) => (b.disabled = true));
    let txid = '';
    try {
      say(msg, 'Signing and sending…');
      // What chain.send() does, step by step, so the chain panel can show the exact signed bytes.
      const { next_nonce: nonce } = await chain.account(signer.address);
      const body = txBody(signer.address, { nonce, action, chain: chain.chainId });
      const sig = await signer.signMessage(body);
      txid = txidOf(body);
      const op = action.type === 'game' ? action.op : null;
      chainlog.signed({ txid, body, sig, gameId: op?.id ?? (op?.kind === 'create' ? txid.slice(0, 16) : null) });
      await chain.submit({ body, sig });
      chainlog.sent(txid);
      say(msg, 'Sent. Waiting for the next block…');
      const receipt = await chain.waitForReceipt(txid);
      chainlog.receipt(receipt);
      if (!receipt.ok) {
        say(msg, receipt.error || 'The transaction failed.', 'error');
        return null;
      }
      say(msg, '');
      return receipt;
    } catch (e) {
      say(msg, errText(e), 'error');
      if (txid) chainlog.failed(txid, errText(e));
      return null;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      refreshAccount();
    }
  };
  const p = queue.then(job, job);
  queue = p.then(() => {}, () => {});
  return p;
}

const gameAction = (/** @type {any} */ op) => ({ type: 'game', game: GAME, op });

// ---------- wallet ----------

async function refreshAccount() {
  try {
    wallets.refresh();
    const acct = await chain.account(state.me);
    state.balance = BigInt(balanceOf(acct, 'GOLD'));
    $('balance').textContent = gold(String(state.balance));
    if (state.game) renderGame(); // the Join button and the arrival note depend on the balance
    showRank($('rank-line'), GAME, [state.me, state.key.address]);
  } catch (e) {
    $('balance').textContent = '?';
    say($('wallet-msg'), `Could not reach the chain: ${errText(e)}`, 'error');
  }
}

function showKey() {
  $('me').textContent = state.me;
  $('me').title = state.me;
  const wif = $('wif');
  wif.hidden = true;
  wif.textContent = '';
  $('export').textContent = 'Show WIF';
}

$('copy-addr').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.me);
    say($('wallet-msg'), 'Address copied.', 'ok');
  } catch {
    say($('wallet-msg'), `Your address: ${state.me}`, 'info');
  }
});

$('faucet').addEventListener('click', async (ev) => {
  const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  const r = await run({ type: 'faucet', token: 'GOLD' }, $('wallet-msg'), [btn]);
  if (r) say($('wallet-msg'), 'GOLD received.', 'ok');
});

$('export').addEventListener('click', () => {
  const wif = $('wif');
  if (wif.hidden) {
    wif.textContent = state.key.toWif();
    wif.hidden = false;
    $('export').textContent = 'Hide WIF';
  } else showKey();
});

$('import').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('import-wif'));
  const text = input.value.trim();
  const msg = $('key-msg');
  try {
    const k = Key.fromWif(text);
    if (k.network !== NETWORK) throw new Error('That is a mainnet key. Import a testnet WIF (it starts with c).');
    if (k.address === state.me) {
      say(msg, 'That key is already in use.', 'info');
      return;
    }
    if (!confirmReplace()) return;
    state.key = k;
    state.me = k.address;
    wallets.setGuestKey(k);
    const saved = storageSet(k.toWif());
    input.value = '';
    showKey();
    say(msg, saved ? 'Key imported.' : 'Key imported for this visit only: this browser would not save it.', saved ? 'ok' : 'info');
    refreshAll();
  } catch (e) {
    say(msg, `Not a valid WIF: ${errText(e)}`, 'error');
  }
});

/** Two-step import: the first click warns inline, a second click within 10 s replaces the key. */
let armedAt = 0;
function confirmReplace() {
  if (Date.now() - armedAt < 10000) {
    armedAt = 0;
    return true;
  }
  armedAt = Date.now();
  say($('key-msg'), 'This replaces the current play key. Export it first if it holds anything you want. Press Import again to continue.', 'info');
  return false;
}

// ---------- lobby ----------

/** Whether an open table has waited a day for a second player: the chain then refuses a join and lets anyone
 *  cancel it for the creator's refund. Judged on this device's clock, so it can be a few seconds off the chain's.
 *  A table from before the clock rules has no create time and is long past the day. */
function openExpired(/** @type {any} */ g) {
  return openExpiredAt(g, Date.now(), { v3From: state.v3From, openExpiryMs: state.openExpiryMs });
}

/** @param {any} g */
function lobbyRow(g, { showStatus = false } = {}) {
  const me = state.me;
  const mine = g.x === me || g.o === me;
  const reservedForOther = g.opponent && g.opponent !== me && g.x !== me;
  const canJoin = g.status === 'open' && g.x !== me && !reservedForOther && !openExpired(g);
  const yourTurn = g.status === 'playing' && g[g.turn] === me;
  let sub = `${gold(g.stake)} GOLD · by ${who(g.x)}`;
  if (g.opponent) sub += ` · for ${who(g.opponent)}`;
  if (g.o) sub += ` · vs ${who(g.o)}`;
  const join = el('button', { type: 'button', onclick: (/** @type {Event} */ e) => joinGame(g.id, g.stake, /** @type {any} */ (e.currentTarget), $('open-msg')) }, 'Join');
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'info' },
      el('a', { href: `#${encodeURIComponent(g.id)}` }, `Table ${g.id.slice(0, 8)}`),
      showStatus && el('span', { class: 'pill' }, statusWord(g)),
      yourTurn && el('span', { class: 'pill you' }, 'your move'),
      !showStatus && mine && el('span', { class: 'pill you' }, 'yours'),
      el('div', { class: 'sub' }, sub),
    ),
    el('div', { class: 'btns' }, canJoin && join, el('a', { class: 'btn ghost', href: `#${encodeURIComponent(g.id)}` }, 'View')),
  );
}

function statusWord(/** @type {any} */ g) {
  if (g.status === 'finished') {
    if (g.result === 'draw') return 'draw';
    return g.winner === state.me ? 'won' : g.winner ? 'lost' : 'finished';
  }
  return openExpired(g) ? 'expired' : g.status;
}

/** Finished games a list shows before the rest go behind "Show older". */
const RECENT_DONE = 4;

/** Fill a list. With `trim`, only open and running games and the newest finished ones show; cancelled and older
 *  games wait behind a "Show older" button. Lists are newest first. */
function fillList(/** @type {HTMLElement} */ ul, /** @type {any[]} */ games, empty, { trim = false, ...opts } = {}) {
  let done = 0;
  const shown = trim && !state.showOlder
    ? games.filter((g) => g.status === 'open' || g.status === 'playing' || (g.status === 'finished' && done++ < RECENT_DONE))
    : games;
  const hidden = games.length - shown.length;
  const rows = shown.length ? shown.map((g) => lobbyRow(g, opts)) : [el('li', { class: 'muted' }, hidden ? 'No recent games.' : empty)];
  if (hidden) {
    rows.push(el('li', { class: 'muted' }, el('button', {
      type: 'button', class: 'ghost',
      onclick: () => { state.showOlder = true; refreshLobby(); },
    }, `Show ${hidden} older`)));
  }
  ul.replaceChildren(...rows);
}

async function refreshLobby() {
  try {
    // Tables of the bots' old single keys stay out of the list; a link to one still opens it.
    const [open, mine, bots, invited] = await Promise.all([
      chain.game(GAME, { open: 1 }),
      chain.game(GAME, { player: state.me }),
      chain.game(GAME, { player: state.bots.o.address }),
      invitedTables(),
    ]);
    say($('open-msg'), '');
    const inv = invited.slice().reverse();
    $('invited').hidden = !inv.length;
    $('invited-list').replaceChildren(...inv.map((g) => lobbyRow(g)));
    // Newest first for people browsing.
    fillList($('open-list'), gamesOf(open).filter((g) => !openExpired(g)).reverse(), 'No open tables. Create one.');
    const my = gamesOf(mine).reverse();
    const rank = (/** @type {any} */ g) => (g.status === 'playing' ? (g[g.turn] === state.me ? 0 : 1) : g.status === 'open' ? 2 : 3);
    my.sort((a, b) => rank(a) - rank(b));
    fillList($('my-list'), my, 'You have not played yet.', { showStatus: true, trim: true });
    fillList($('bot-list'), gamesOf(bots).reverse(), 'No bot tables yet.', { showStatus: true, trim: true });
  } catch (e) {
    say($('open-msg'), `Could not load tables: ${errText(e)}`, 'error');
  }
}

/** Open tables made for you, newest last (see tables.js). */
const invitedTables = () => invitedTablesFor({ chain, me: state.me, expired: openExpired });

/** Join table `id` at the stake it was shown with; the chain refuses the join if the table's stake is not that. */
async function joinGame(/** @type {string} */ id, /** @type {string} */ stake, /** @type {HTMLButtonElement} */ btn, /** @type {HTMLElement} */ msg) {
  const r = await run(gameAction({ kind: 'join', id, expected_stake: String(stake ?? '0') }), msg, [btn]);
  if (r) location.hash = `#${encodeURIComponent(id)}`;
}

$('create').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = /** @type {HTMLFormElement} */ (ev.currentTarget);
  const msg = /** @type {HTMLElement} */ (form.querySelector('.msg'));
  const btn = /** @type {HTMLButtonElement} */ (form.querySelector('button[type=submit]'));
  const stakeText = /** @type {HTMLInputElement} */ (form.elements.namedItem('stake')).value.trim() || '0';
  const opponent = /** @type {HTMLInputElement} */ (form.elements.namedItem('opponent')).value.trim();
  /** @type {any} */ const op = { kind: 'create' };
  try {
    op.stake = parseAmount(stakeText, state.decimals);
  } catch {
    say(msg, `Stake must be a GOLD amount with at most ${state.decimals} decimals, like 1 or 2.5.`, 'error');
    return;
  }
  if (opponent) {
    if (!isAddress(opponent, NETWORK)) return say(msg, 'Opponent must be a testnet address (starts with x or y).', 'error');
    if (opponent === state.me) return say(msg, 'You cannot invite yourself.', 'error');
    op.opponent = opponent;
  }
  const r = await run(gameAction(op), msg, [btn]);
  if (!r) return;
  const created = r.events?.find((/** @type {any} */ e) => e.kind === 'tictactoe.created');
  const id = created?.data?.id ?? r.txid?.slice(0, 16);
  if (id) location.hash = `#${encodeURIComponent(id)}`;
});

/**
 * Start a table against Bot O: `x` creates it for no stake, reserved for Bot O, and Bot O joins.
 * `x` is you, or Bot X when you only watch.
 * @param {Key} x @param {HTMLElement} msg @param {HTMLButtonElement[]} buttons
 */
async function startBotTable(x, msg, buttons) {
  const r = await run(gameAction({ kind: 'create', stake: '0', opponent: state.bots.o.address }), msg, buttons, x);
  const id = r?.events?.find((/** @type {any} */ e) => e.kind === 'tictactoe.created')?.data?.id;
  if (!id) return;
  say(msg, 'Seating the bot…');
  seated.add(id);
  const j = await run(gameAction({ kind: 'join', id, expected_stake: '0' }), msg, buttons, state.bots.o);
  if (j) location.hash = `#${encodeURIComponent(id)}`;
}

$('vs-bot').addEventListener('click', (ev) => startBotTable(state.key, $('bot-lobby-msg'), [/** @type {any} */ (ev.currentTarget)]));
$('watch-bots').addEventListener('click', (ev) => startBotTable(state.bots.x, $('bot-lobby-msg'), [/** @type {any} */ (ev.currentTarget)]));

// ---------- one table ----------

const board = $('board');
const cells = Array.from({ length: 9 }, (_, i) =>
  el('button', { type: 'button', class: 'cell', role: 'gridcell', 'aria-label': cellLabel(i), onclick: () => playCell(i) }),
);
board.replaceChildren(...cells);

async function loadGame() {
  const id = state.gameId;
  if (!id) return;
  try {
    const g = normGame(await chain.game(GAME, { id }));
    if (state.gameId !== id) return; // navigated away meanwhile
    state.game = g;
    say($('g-msg'), $('g-msg').dataset.kind === 'error' ? $('g-msg').textContent ?? '' : '', 'error');
    renderGame();
    loadRematch();
  } catch (e) {
    if (state.gameId !== id) return;
    state.game = null;
    renderGame();
    say($('g-msg'), /** @type {any} */ (e).status === 404 ? `There is no table ${id}.` : `Could not load the table: ${errText(e)}`, 'error');
  }
}

// ---------- rematch ----------

let rematchBusy = false;

/** Look for the rematch table of the finished game in view: the one you made, or the one the other player made for you. */
async function loadRematch() {
  const g = state.game;
  const id = state.gameId;
  if (!g || !id || rematchBusy || !rematchParams(g, state.me) || botSeats(g)) return;
  rematchBusy = true;
  try {
    const [mine, invited] = await Promise.all([chain.game(GAME, { player: state.me }).then(gamesOf), invitedTables()]);
    if (state.gameId !== id) return;
    const next = findRematch(g, state.me, [...mine, ...invited], openExpired);
    if (next?.kind !== state.rematch?.kind || next?.table.id !== state.rematch?.table.id) {
      state.rematch = next;
      renderGame();
    }
  } catch {
    /* the button still works; the offer shows on the next block */
  } finally {
    rematchBusy = false;
  }
}

/** Rematch, the offer to join one, or the note that one is waiting. */
function renderRematch(/** @type {any} */ g) {
  const p = !botSeats(g) ? rematchParams(g, state.me) : null;
  const r = p ? state.rematch : null;
  $('rematch').hidden = !p;
  if (!p) return;
  const offer = r?.kind === 'join';
  $('rematch-offer').hidden = !offer;
  $('rematch-offer').textContent = offer ? `${who(r.table.x)} wants a rematch${g.stake !== '0' ? ` for ${gold(g.stake)} GOLD each` : ''}.` : '';
  const join = /** @type {HTMLAnchorElement} */ ($('rematch-join'));
  join.hidden = !offer;
  if (offer) join.setAttribute('href', `#${encodeURIComponent(r.table.id)}`);
  $('rematch-btn').hidden = Boolean(r);
  const wait = r?.kind === 'wait';
  $('rematch-note').hidden = !wait;
  $('rematch-note').textContent = wait ? `Your rematch is waiting for ${who(p.opponent)}. You play X and move first.` : '';
}

$('rematch-btn').addEventListener('click', async (ev) => {
  const p = rematchParams(state.game, state.me);
  if (!p) return;
  const msg = $('rematch-msg');
  const r = await run(gameAction({ kind: 'create', stake: p.stake, opponent: p.opponent }), msg, [/** @type {any} */ (ev.currentTarget)]);
  const id = r?.events?.find((/** @type {any} */ e) => e.kind === 'tictactoe.created')?.data?.id ?? r?.txid?.slice(0, 16);
  if (id) location.hash = `#${encodeURIComponent(id)}`;
});

$('rematch-join').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const t = state.rematch?.table;
  if (t) await joinGame(t.id, t.stake, /** @type {any} */ (ev.currentTarget), $('rematch-msg'));
});

function renderGame() {
  const g = state.game;
  const me = state.me;
  $('g-id').textContent = state.gameId ?? '';
  const myMark = g ? (g.x === me ? 'x' : g.o === me ? 'o' : null) : null;
  const over = g && (g.status === 'finished' || g.status === 'cancelled');
  const myTurn = g && g.status === 'playing' && g.turn === myMark;
  const botTurn = Boolean(botToMove(g));
  const hint = botHint();
  const winLine = g && g.status === 'finished' && g.reason === 'line' ? LINES.find((l) => l.every((i) => g.board[i] !== '.' && g.board[i] === g.board[l[0]])) : null;

  cells.forEach((c, i) => {
    const v = g ? g.board[i] : '.';
    const pending = state.pendingCell === i && v === '.';
    const ghost = !pending && v === '.' && state.pendingCell == null && hint ? (hint.cell === i ? hint.mark : hint.expect === i ? hint.reply : '') : '';
    c.textContent = v === '.' ? (pending ? state.pendingMark.toUpperCase() : ghost.toUpperCase()) : v.toUpperCase();
    c.className = `cell ${v !== '.' ? v : pending ? state.pendingMark : ghost}`;
    if (pending) c.classList.add('pending');
    if (ghost) c.classList.add(hint?.cell === i ? 'proposed' : 'expected');
    if (winLine?.includes(i)) c.classList.add('win');
    const playable = Boolean((myTurn || botTurn) && v === '.' && state.pendingCell == null);
    c.classList.toggle('playable', playable);
    c.disabled = !playable;
    c.setAttribute('aria-label', `${cellLabel(i)}: ${v === '.' ? 'empty' : v.toUpperCase()}`);
  });

  $('g-stake').textContent = g ? `${gold(g.stake)} GOLD each` : '';
  $('g-x').textContent = g ? who(g.x) : '';
  $('g-x').title = g?.x ?? '';
  $('g-o').textContent = !g ? '' : g.o ? who(g.o) : over ? 'nobody joined'
    : g.opponent ? `waiting for ${who(g.opponent)}` : 'waiting for anyone';
  $('g-o').title = g?.o ?? g?.opponent ?? '';

  // Whose turn
  let status = '';
  if (!g) status = '';
  else if (openExpired(g)) status = 'This table waited 24 hours with nobody joining, so it has expired. Anyone can cancel it, and the stake goes back to its creator.';
  else if (g.status === 'open') status = g.x === me ? 'Waiting for an opponent to join.' : 'This table is open.';
  else if (g.status === 'playing') {
    const turnName = g.turn.toUpperCase();
    status = myTurn ? `Your move (${turnName}).` : `${turnName} to move: ${who(g[g.turn])}.`;
  }
  $('g-status').textContent = status;
  renderBot();

  // Result banner
  const banner = $('banner');
  if (over) {
    let text = 'Game over.';
    let kind = 'info';
    const payout = g.stake !== '0' ? ` (${gold(BigInt(g.stake) * 2n)} GOLD pot)` : '';
    if (g.status === 'cancelled' || g.result === 'cancelled') text = 'Table cancelled. The stake went back to its creator.';
    else if (g.result === 'draw') text = 'Draw. Each player got their stake back.';
    else if (g.winner) {
      const how = g.reason === 'timeout' ? ' on timeout' : '';
      if (g.winner === me) [text, kind] = [`You won${how}${payout}.`, 'win'];
      else if (myMark) [text, kind] = [`You lost${how}.`, 'loss'];
      else text = `${g.winner === g.o ? 'O' : 'X'} won${how}: ${who(g.winner)}.`;
    }
    banner.textContent = text;
    banner.dataset.kind = kind;
    banner.hidden = false;
  } else banner.hidden = true;

  // Buttons
  const joinBtn = /** @type {HTMLButtonElement} */ ($('g-join'));
  const expired = openExpired(g);
  joinBtn.hidden = !(g && g.status === 'open' && g.x !== me && (!g.opponent || g.opponent === me)) || expired || arrivalFor(g)?.kind === 'needgold';
  joinBtn.textContent = g && g.stake !== '0' ? `Join for ${gold(g.stake)} GOLD` : 'Join';
  // your own open table, free for anyone or kept for Bot O: Bot O can take the other seat
  const botJoin = /** @type {HTMLButtonElement} */ ($('g-bot-join'));
  botJoin.hidden = expired || !(g && g.status === 'open' && g.x === me && me !== state.bots.o?.address
    && (!g.opponent || g.opponent === state.bots.o?.address) && !seated.has(g.id));
  botJoin.textContent = g && g.stake !== '0' ? `Let the bot join (${gold(g.stake)} GOLD)` : 'Let the bot join';
  $('g-cancel').hidden = !(g && g.status === 'open' && (g.x === me || expired));
  $('g-cancel').textContent = g && expired && g.x !== me ? 'Cancel table (refunds its creator)' : 'Cancel table';

  const claim = /** @type {HTMLButtonElement} */ ($('g-claim'));
  const waiting = g && g.status === 'playing' && myMark && g.turn !== myMark && !botTurn; // a bot never times out
  claim.hidden = !waiting;
  if (waiting) showClaimCountdown(claim, g);
  clearInterval(claimTimer);
  if (waiting) claimTimer = setInterval(() => showClaimCountdown(claim, g), 1000);
  renderRematch(g);
  renderInvite(g);
  chainlog.show(g, state.gameId);
  refreshAlert();
}

/** What someone who is not at table `g` is told about it, or null. */
function arrivalFor(/** @type {any} */ g) {
  return g && botSeats(g) !== 'xo' ? arrival(g, { me: state.me, balance: state.balance, expired: openExpired(g), short, gold }) : null;
}

/** The invite control (while the table waits for a player) and the arrival view (for someone who is not at the table). */
function renderInvite(/** @type {any} */ g) {
  // the table that waits for a player: this one, or (on a finished game) the rematch you made
  const t = g && g.status === 'open' && g.x === state.me && !openExpired(g) ? g
    : g && g.status === 'finished' && !botSeats(g) && state.rematch?.kind === 'wait' ? state.rematch.table : null;
  $('invite').hidden = !t;
  if (t) {
    const url = inviteUrl(location, t.id);
    /** @type {HTMLInputElement} */ ($('invite-url')).value = url;
    $('invite-tg').setAttribute('href', telegramShareUrl(url, shareText(t.stake, gold(t.stake))));
    $('invite-for').hidden = !t.opponent;
    $('invite-for').textContent = t.opponent ? `This table is for ${who(t.opponent)} only: ${t.opponent}. Send them the link.` : '';
  }
  const a = arrivalFor(g);
  const show = Boolean(a && a.text);
  $('arrival').hidden = !show;
  $('arrival-text').textContent = a?.text ?? '';
  $('arrival-faucet').hidden = !a?.faucet;
}

$('invite-copy').addEventListener('click', async () => {
  const url = /** @type {HTMLInputElement} */ ($('invite-url')).value;
  try {
    await navigator.clipboard.writeText(url);
    say($('invite-msg'), 'Invite link copied.', 'ok');
  } catch {
    /** @type {HTMLInputElement} */ ($('invite-url')).select();
    say($('invite-msg'), 'Select the link and copy it.', 'info');
  }
});
$('invite-url').addEventListener('focus', (ev) => /** @type {HTMLInputElement} */ (ev.currentTarget).select());
$('arrival-faucet').addEventListener('click', async (ev) => {
  const r = await run({ type: 'faucet', token: 'GOLD' }, $('g-msg'), [/** @type {HTMLButtonElement} */ (ev.currentTarget)]);
  if (r) say($('g-msg'), 'GOLD received.', 'ok');
});

let claimTimer = 0;

/** When the player on the move can be claimed against, on the clock: null for an old game that runs on block height. */
function claimDueMs(/** @type {any} */ g) {
  return g.last_move_ms != null ? g.last_move_ms + state.timeoutMs : Date.now() >= state.clockFrom ? state.clockFrom + state.timeoutMs : null;
}

// ---------- turn alerts ----------
//
// A player who has left the tab (for Telegram, say) is told by the tab title when it is their move, someone joins their
// table, or the game ends. A browser notification is a local `new Notification(...)` they must ask for, and it fires only
// while the tab is hidden. Nothing here makes a request: it reads the game the page already has.

/** Set the tab title and the urgent line from the current table; notify when something worth leaving the tab for happened. */
function refreshAlert() {
  const g = state.gameId ? state.game : null;
  const a = turnAlert(g, state.me, { prev: state.alert.wasOpen ? { status: 'open' } : null, dueMs: g ? claimDueMs(g) : null, expired: Boolean(g && openExpired(g)), rematch: state.rematch?.kind === 'join' && g?.status === 'finished' ? 'join' : null });
  if (document.title !== a.title) document.title = a.title;
  const urgent = $('g-urgent');
  urgent.hidden = !a.urgent;
  if (urgent.textContent !== (a.urgent ? a.text : '')) urgent.textContent = a.urgent ? a.text : '';
  if (!g) return; // no table in view: nothing to compare, and the first look at a table is never news
  if (shouldNotify(/** @type {any} */ (state.alert.kind), a.kind) && state.alert.notify && document.hidden) notifyNow(a.text, g.id);
  state.alert.kind = a.kind;
  state.alert.wasOpen = g.status === 'open';
}

function notifyNow(/** @type {string} */ text, /** @type {string} */ id) {
  try {
    new Notification('DiviGames · tic-tac-toe', { body: text, tag: `dg-ttt-${id}` });
  } catch {
    /* the browser refused; the title still shows it */
  }
}

/** What this browser can do with notifications right now. */
function notifySupport() {
  const N = /** @type {any} */ (window).Notification;
  return { supported: typeof N === 'function', permission: typeof N === 'function' ? String(N.permission) : 'denied' };
}

/** Show the outcome of a toggle plan: the box, the note, and whether notifications are on. */
function applyNotifyPlan(/** @type {ReturnType<typeof notifyPlan>} */ plan) {
  state.alert.notify = plan.on;
  /** @type {HTMLInputElement} */ ($('alert-toggle')).checked = plan.on;
  $('alert-note').textContent = plan.note;
  $('alert-note').hidden = !plan.note;
}

$('alert-toggle').addEventListener('change', async (ev) => {
  const box = /** @type {HTMLInputElement} */ (ev.currentTarget);
  const wanted = box.checked;
  let plan = notifyPlan({ ...notifySupport(), wanted });
  if (plan.ask) {
    box.disabled = true;
    let permission = 'default';
    try {
      permission = String(await /** @type {any} */ (window).Notification.requestPermission());
    } catch {
      /* treated as not granted */
    }
    box.disabled = false;
    plan = notifyPlan({ supported: true, permission, wanted });
    if (!plan.on && !plan.note) plan.note = 'Notifications were not allowed, so none will be shown. The tab title still shows when it is your move.';
  }
  applyNotifyPlan(plan);
  storageSet(plan.on ? '1' : '0', ALERT_STORE);
});

// Restore the saved choice, but never ask for permission without a click.
{
  const plan = notifyPlan({ ...notifySupport(), wanted: storageGet(ALERT_STORE) === '1' });
  applyNotifyPlan(plan.ask ? { ask: false, on: false, note: '' } : plan);
}
setInterval(refreshAlert, 1000); // the seconds left before a timeout claim count down

/**
 * When the player waiting on the other can claim the game. A move made under the clock rules gives the other
 * player five minutes of block time; an older one runs on block height, or five minutes from the switch.
 * @param {HTMLButtonElement} claim
 * @param {any} g
 */
function showClaimCountdown(claim, g) {
  const dueMs = claimDueMs(g);
  const dueHeight = g.last_move_ms != null ? null : g.last_move_height + state.timeoutBlocks;
  if (dueHeight != null && state.height >= dueHeight) {
    claim.textContent = 'Claim timeout';
    claim.title = `Win: the other player has not moved since height ${g.last_move_height}.`;
  } else if (dueMs != null) {
    const left = timeLeft(dueMs);
    claim.textContent = left === 'now' ? 'Claim timeout' : `Claim timeout (in ${left})`;
    claim.title = `Win if the other player has not moved by ${localTime(dueMs)}.`;
  } else {
    const left = dueHeight - state.height;
    claim.textContent = state.height && left > 0 ? `Claim timeout (in ${left} block${left === 1 ? '' : 's'})` : 'Claim timeout';
    claim.title = `Win if the other player has not moved by height ${dueHeight}.`;
  }
}

async function playCell(/** @type {number} */ i) {
  const g = state.game;
  if (!g || state.pendingCell != null) return;
  if (botToMove(g)) return choose(i);
  const mark = g.x === state.me ? 'x' : 'o';
  state.pendingCell = i;
  state.pendingMark = mark;
  renderGame();
  const r = await run(gameAction({ kind: 'move', id: g.id, cell: i }), $('g-msg'));
  if (r && botSeats(g)) addLog(g.id, { mark, cell: i, how: 'you' });
  state.pendingCell = null;
  await loadGame();
}

// ---------- the bot seats ----------
//
// A seat is the bot's when its address is one of this browser's bot keys. Before each bot move the panel shows the
// move the bot likes best, why, and the reply it expects. You approve it, ask for the next-best move, or pick any free
// square; on a timer pace the bot plays its current choice when the countdown ends.

const bot = {
  /** `${id}:${board}`: the position the ranking below is for. */
  at: '',
  /** @type {ReturnType<typeof rankMoves>} best first */
  ranked: [],
  /** Index into `ranked` of the move on offer. */
  pick: 0,
  /** Whether you chose the move on offer (a square, or Pick another). */
  chosen: false,
  timer: 0,
  ticker: 0,
  deadline: 0,
};
/** Tables this page already asked Bot O to join. */
const seated = new Set();

/** The bot seats at this table: '', 'o', 'x' or 'xo'. */
function botSeats(/** @type {any} */ g) {
  if (!g) return '';
  return (botKeyFor(g.x, 'x') ? 'x' : '') + (botKeyFor(g.o ?? g.opponent, 'o') ? 'o' : '');
}

/** The bot whose move it is, if any: {mark, key}. */
function botToMove(/** @type {any} */ g) {
  if (!g || g.status !== 'playing') return null;
  const mark = /** @type {'x'|'o'} */ (g.turn);
  const key = botKeyFor(g[mark], mark);
  return key ? { mark, key } : null;
}

/** The squares to draw faintly: the bot's move on offer and the reply it expects. */
function botHint() {
  const g = state.game;
  const b = botToMove(g);
  const m = b && bot.at === `${g.id}:${g.board}` ? bot.ranked[bot.pick] : null;
  if (!b || !m) return null;
  return { cell: m.cell, mark: b.mark, expect: m.expect?.cell ?? -1, reply: b.mark === 'x' ? 'o' : 'x' };
}

const paceStore = () => (botSeats(state.game) === 'xo' ? 'dg.bot.pace.watch' : 'dg.bot.pace.play');
function getPace() {
  let v = null;
  try {
    v = localStorage.getItem(paceStore());
  } catch {
    /* default */
  }
  return v ?? 'ask';
}
$('bot-pace').addEventListener('change', (ev) => {
  try {
    localStorage.setItem(paceStore(), /** @type {HTMLSelectElement} */ (ev.currentTarget).value);
  } catch {
    /* this visit only */
  }
  restartTimer();
  renderBot();
});

function stopTimer() {
  clearTimeout(bot.timer);
  clearInterval(bot.ticker);
  bot.timer = 0;
  bot.deadline = 0;
}

/** On a timer pace, play the move on offer when the countdown ends. */
function restartTimer() {
  stopTimer();
  const secs = Number(getPace());
  if (!secs || !botToMove(state.game) || state.pendingCell != null) return;
  bot.deadline = Date.now() + secs * 1000;
  bot.timer = setTimeout(() => approve('auto'), secs * 1000);
  bot.ticker = setInterval(showCount, 250);
}

function showCount() {
  const left = Math.max(0, Math.ceil((bot.deadline - Date.now()) / 1000));
  $('bot-count').textContent = bot.deadline ? `Plays in ${left} s` : '';
}

/** Offer the move on `cell` instead (a square you tapped). */
function choose(/** @type {number} */ cell) {
  const i = bot.ranked.findIndex((m) => m.cell === cell);
  if (i < 0) return;
  bot.pick = i;
  bot.chosen = true;
  restartTimer();
  renderGame();
}

$('bot-other').addEventListener('click', () => {
  if (!bot.ranked.length) return;
  bot.pick = (bot.pick + 1) % bot.ranked.length;
  bot.chosen = true;
  restartTimer();
  renderGame();
});
$('bot-ok').addEventListener('click', () => approve('approved'));

/** Play the move on offer. how: approved | auto */
async function approve(/** @type {string} */ how) {
  stopTimer();
  const g = state.game;
  const b = botToMove(g);
  const m = bot.ranked[bot.pick];
  if (!g || !b || !m || bot.at !== `${g.id}:${g.board}` || state.pendingCell != null) return;
  state.pendingCell = m.cell;
  state.pendingMark = b.mark;
  renderGame();
  const r = await run(gameAction({ kind: 'move', id: g.id, cell: m.cell }), $('g-msg'), [], b.key);
  if (r) addLog(g.id, { mark: b.mark, cell: m.cell, how: bot.chosen ? 'your pick' : how, reason: m.reason });
  state.pendingCell = null;
  await loadGame();
}

$('bot-again').addEventListener('click', (ev) => {
  const x = botSeats(state.game) === 'xo' ? state.bots.x : state.key;
  startBotTable(x, $('g-msg'), [/** @type {any} */ (ev.currentTarget)]);
});

// The move log: what each side played and why, kept per table in this browser.

/** @typedef {{mark: string, cell: number, how: string, reason?: string}} LogEntry */
function getLog(/** @type {string} */ id) {
  try {
    return /** @type {LogEntry[]} */ (JSON.parse(localStorage.getItem(`dg.botlog.${id}`) ?? '[]'));
  } catch {
    return [];
  }
}
function addLog(/** @type {string} */ id, /** @type {LogEntry} */ entry) {
  const log = [...getLog(id), entry];
  try {
    localStorage.setItem(`dg.botlog.${id}`, JSON.stringify(log));
  } catch {
    /* this visit only */
  }
  memLog.set(id, log);
}
const memLog = new Map();

const OUTCOME = { win: ['wins', 'win'], draw: ['draws', 'draw'], loss: ['loses', 'loss'] };
const CAP = (/** @type {string} */ m) => m.toUpperCase();

function renderBot() {
  const g = state.game;
  const seats = botSeats(g);
  const panel = $('bot');
  panel.hidden = !seats;
  if (!seats) {
    stopTimer();
    return;
  }
  // A table made for Bot O that it has not joined yet (the join failed, or the page was closed): seat it now.
  const o = g.status === 'open' && g.stake === '0' ? botKeyFor(g.opponent, 'o') : null; // a staked one waits for Let the bot join
  if (o && !seated.has(g.id)) {
    seated.add(g.id);
    run(gameAction({ kind: 'join', id: g.id, expected_stake: '0' }), $('g-msg'), [], o).then(() => loadGame());
  }
  /** @type {HTMLSelectElement} */ ($('bot-pace')).value = getPace();
  const b = botToMove(g);
  const at = `${g.id}:${g.board}`;
  if (b && bot.at !== at) {
    bot.at = at;
    bot.ranked = rankMoves(g.board, b.mark);
    bot.pick = 0;
    bot.chosen = false;
    restartTimer();
  } else if (b && !bot.deadline && state.pendingCell == null) {
    // the position arrived while the last move was still being sent, so the countdown never started
    restartTimer();
  }
  if (!b) stopTimer();
  const m = b ? bot.ranked[bot.pick] : null;
  const thinking = Boolean(b && m && state.pendingCell == null);
  $('bot-think').hidden = !thinking;
  $('bot-mark').textContent = b ? CAP(b.mark) : seats === 'xo' ? '' : 'O';
  $('bot-mark').className = `mark ${b ? b.mark : seats === 'xo' ? '' : 'o'}`;
  $('bot-title').textContent = b ? `Bot ${CAP(b.mark)} is thinking` : seats === 'xo' ? 'Two bots' : 'Bot O';
  if (thinking && b && m) {
    const them = b.mark === 'x' ? 'O' : 'X';
    const first = bot.pick === 0 && !bot.chosen;
    $('bot-plan').textContent = `${first ? 'I will play' : 'Instead, I’ll play'} the ${m.name}.`;
    const [verb, kind] = OUTCOME[/** @type {'win'|'draw'|'loss'} */ (m.outcome)];
    $('bot-outcome').textContent = `${verb} with best play`;
    $('bot-outcome').dataset.kind = kind;
    $('bot-why').textContent = m.reason;
    $('bot-next').textContent = m.expect ? `${them} will most likely answer on the ${m.expect.name}: ${m.expect.reason}` : 'That ends the game.';
    const best = bot.ranked[0];
    // an overridden move that throws away a result says what the best move would have kept
    $('bot-verdict').textContent = m.outcome !== best.outcome
      ? `My best move is the ${best.name}, which ${OUTCOME[/** @type {'win'|'draw'|'loss'} */ (best.outcome)][0]}. This one ${verb} if ${them} plays well.`
      : best.outcome === 'win' ? `I can force a win from here.`
      : best.outcome === 'draw' ? `With best play from both sides, this game is a draw.`
      : `${them} can force a win whatever I play.`;
    $('bot-ok').textContent = first ? 'Approve' : 'Play it';
    $('bot-other').hidden = bot.ranked.length < 2;
    $('bot-other').textContent = `Pick another (${bot.pick + 1} of ${bot.ranked.length})`;
    $('bot-alts').replaceChildren(
      ...bot.ranked.map((r, i) =>
        el('button', {
          type: 'button',
          class: `alt ${r.outcome}${i === bot.pick ? ' on' : ''}`,
          'aria-pressed': String(i === bot.pick),
          title: r.reason,
          onclick: () => choose(r.cell),
        }, `${r.name} · ${OUTCOME[/** @type {'win'|'draw'|'loss'} */ (r.outcome)][0]}`),
      ),
    );
    showCount();
  }
  const idle = $('bot-idle');
  idle.hidden = thinking;
  idle.textContent = state.pendingCell != null ? 'Sending the move…'
    : g.status === 'open' ? 'Seating the bot…'
    : g.status === 'playing' ? 'Your move. The bot answers when you have played.'
    : g.status === 'finished' ? (g.result === 'draw' ? 'Draw: neither side found a way through.' : `${g.winner === g.x ? 'X' : 'O'} won.`)
    : '';
  $('bot-again').hidden = !(g.status === 'finished' || g.status === 'cancelled');
  const log = memLog.get(g.id) ?? getLog(g.id);
  memLog.set(g.id, log);
  $('bot-log').replaceChildren(
    ...log.map((e) =>
      el('li', {},
        el('span', { class: `mark ${e.mark}` }, CAP(e.mark)),
        ' ',
        el('strong', {}, (e.how === 'you' ? 'You' : `Bot ${CAP(e.mark)}`) + ` played the ${CELL[e.cell] ?? e.cell}`),
        e.how !== 'you' && el('span', { class: 'how' }, ` · ${e.how}`),
        e.reason && el('div', { class: 'sub' }, e.reason),
      ),
    ),
  );
}

$('g-join').addEventListener('click', async (ev) => {
  if (!state.game) return;
  await joinGame(state.game.id, state.game.stake, /** @type {any} */ (ev.currentTarget), $('g-msg'));
  loadGame();
});
$('g-bot-join').addEventListener('click', async (ev) => {
  const g = state.game;
  const o = state.bots.o;
  if (!g || !o) return;
  const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  const msg = $('g-msg');
  // A staked table: Bot O puts up the same stake, so it first claims GOLD from the faucet if it has too little.
  if (g.stake !== '0') {
    let have = 0n;
    try {
      have = BigInt(balanceOf(await chain.account(o.address)));
    } catch {
      /* a new address has no account yet */
    }
    if (have < BigInt(g.stake)) {
      say(msg, `The bot has ${gold(String(have))} GOLD and the stake is ${gold(g.stake)}. Claiming GOLD from the faucet for it…`);
      const r = await run({ type: 'faucet', token: 'GOLD' }, msg, [btn], o);
      if (!r) {
        const text = msg.textContent ?? '';
        const next = Number(/height (\d+)/.exec(text)?.[1]);
        const when = /next claim at (.+)$/.exec(text)?.[1];
        const why = `The bot cannot join yet: it has ${gold(String(have))} GOLD, the stake is ${gold(g.stake)}, and the faucet gives each address GOLD only once an hour. `;
        if (Number.isFinite(next) && next > state.height) {
          say(msg, why + `The bot’s next claim is at block ${next}, ${next - state.height} blocks from now. Try again then, or make a table with a smaller stake.`, 'error');
        } else if (when && !/^height/.test(when)) {
          say(msg, why + `The bot’s next claim is at ${when}. Try again then, or make a table with a smaller stake.`, 'error');
        }
        return;
      }
    }
  }
  say(msg, 'Seating the bot…');
  seated.add(g.id);
  const j = await run(gameAction({ kind: 'join', id: g.id, expected_stake: String(g.stake ?? '0') }), msg, [btn], o);
  if (!j) seated.delete(g.id);
  loadGame();
});
$('g-cancel').addEventListener('click', async (ev) => {
  if (!state.game) return;
  await run(gameAction({ kind: 'cancel', id: state.game.id }), $('g-msg'), [/** @type {any} */ (ev.currentTarget)]);
  loadGame();
});
$('g-claim').addEventListener('click', async (ev) => {
  if (!state.game) return;
  await run(gameAction({ kind: 'claim_timeout', id: state.game.id }), $('g-msg'), [/** @type {any} */ (ev.currentTarget)]);
  loadGame();
});

// ---------- routing and live updates ----------

function route() {
  const id = idFromHash(location.hash);
  const changed = id !== (state.gameId ?? '');
  state.gameId = id || null;
  $('lobby').hidden = Boolean(id);
  $('game').hidden = !id;
  if (changed) {
    state.game = null;
    state.pendingCell = null;
    bot.at = ''; // think afresh (and restart the pace timer) when you come back to a table
    state.alert.kind = undefined;
    state.alert.wasOpen = false;
    state.rematch = null;
    stopTimer();
    say($('g-msg'), '');
  }
  if (id) {
    renderGame();
    loadGame();
  } else {
    refreshLobby();
    refreshAlert();
  }
}

function refreshAll() {
  refreshAccount();
  if (state.gameId) loadGame();
  else refreshLobby();
}

function onBlock(/** @type {any} */ block) {
  chainlog.block(block);
  const h = Number(block?.header?.height);
  if (Number.isFinite(h)) state.height = h;
  let lobbyDirty = false;
  let gameDirty = false;
  let touchesMe = false;
  for (const r of block?.receipts ?? []) {
    for (const ev of r?.events ?? []) {
      const kind = String(ev?.kind ?? '');
      if (kind.startsWith(`${GAME}.`)) lobbyDirty = true;
      if (state.gameId && String(ev?.data?.id ?? '') === state.gameId) gameDirty = true;
      if (JSON.stringify(ev?.data ?? {}).includes(state.me)) touchesMe = true;
    }
  }
  if (touchesMe) refreshAccount();
  if (gameDirty) loadGame();
  else if (state.gameId && state.game) renderGame(); // height moved: update the timeout countdown
  if (lobbyDirty && !state.gameId) refreshLobby();
  else if (lobbyDirty && state.game?.status === 'finished') loadRematch();
}

function setConn(/** @type {boolean} */ on) {
  const c = $('conn');
  c.dataset.state = on ? 'on' : 'off';
  c.textContent = on ? 'live' : 'reconnecting…';
  if (on) refreshAll(); // blocks may have been missed while disconnected
}

// ---------- IronDivi wallets ----------

const wallets = mountWallets({
  chain,
  card: /** @type {HTMLElement} */ (document.querySelector('.card.wallet')),
  guestKey: state.key,
  onChange: () => {
    useWallet();
    showKey();
    refreshAll();
  },
});

/** Play with the connected wallet's session key, or with the guest key. */
function useWallet() {
  state.key = wallets.key;
  state.me = wallets.me;
}
useWallet();

// ---------- On the chain ----------

/** Who an address is, for the chain panel. @returns {import('./chainlog.js').Who} */
function identify(/** @type {string} */ addr) {
  for (const m of /** @type {const} */ (['x', 'o'])) {
    if (addr === state.bots[m]?.address) {
      return { name: `Bot ${m.toUpperCase()}`, mark: m, kind: 'phrase', path: state.botPaths[m], phrase: () => botPhrase(m) };
    }
    if (addr === state.oldBots[m]?.address) return { name: `Bot ${m.toUpperCase()} (old key)`, mark: m, kind: 'legacy' };
  }
  if (addr === state.key.address && addr !== state.me) {
    return { name: 'Your session key', kind: 'session', note: `Signs for your IronDivi wallet ${short(state.me)}` };
  }
  if (addr === state.me) return { name: 'You', kind: state.key.address === state.me ? 'play' : 'wallet' };
  return { name: short(addr), kind: 'other' };
}

const chainlog = createChainLog({ chain, root: $('chain-body'), identify });

async function start() {
  $('chain-url').textContent = chain.baseUrl;
  await initBots();
  for (const id of ['vs-bot', 'watch-bots']) /** @type {HTMLButtonElement} */ ($(id)).disabled = false;
  showKey();
  window.addEventListener('hashchange', route);
  route();
  refreshAccount();
  chain.subscribe(onBlock, { onStatus: setConn });
  try {
    const [tokens, info, view] = await Promise.all([
      chain.tokens().catch(() => null),
      chain.info().catch(() => null),
      chain.game(GAME).catch(() => null),
    ]);
    const list = Array.isArray(tokens) ? tokens : Array.isArray(tokens?.tokens) ? tokens.tokens : [];
    const goldTok = list.find((t) => (t?.symbol ?? t?.token) === 'GOLD');
    if (Number.isInteger(goldTok?.decimals)) state.decimals = goldTok.decimals;
    if (Number.isFinite(Number(info?.height))) state.height = Number(info.height);
    chainlog.heads(info);
    {
      const fast = faucetFastNote(info);
      if (fast && $('wallet-msg').hidden) say($('wallet-msg'), fast);
    }
    if (Number.isFinite(Number(view?.timeout_blocks))) state.timeoutBlocks = Number(view.timeout_blocks);
    if (Number.isFinite(Number(view?.timeout_ms))) state.timeoutMs = Number(view.timeout_ms);
    if (Number.isFinite(Number(view?.clock_rules_from_ms))) state.clockFrom = Number(view.clock_rules_from_ms);
    if (Number.isFinite(Number(view?.open_expiry_ms))) state.openExpiryMs = Number(view.open_expiry_ms);
    if (Number.isFinite(Number(view?.rules_v3_from_ms))) state.v3From = Number(view.rules_v3_from_ms);
    refreshAll();
  } catch {
    /* defaults stand */
  }
}

start();
