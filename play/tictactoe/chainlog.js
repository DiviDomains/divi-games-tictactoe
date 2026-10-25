// The "On the chain" panel beside the table: what each play actually did on the two chains.
//
// Every move is a transaction on the Divi Games sidechain. This browser builds its exact JSON body, signs it with the
// player's own key (each bot has its own 12-word phrase), and sends it to the sequencer, which puts it in a block
// every couple of seconds. Soon after a block holds a move, the sequencer writes one Divi testnet transaction whose
// OP_RETURN holds the newest block's hash and state root, which seals that block and every block before it on Divi.
// It waits only for its previous anchor to reach a Divi block, so a move is sealed within a minute or two.
// The panel follows a move through those stages, with links to the raw data and the Divi explorer.

import { formatAmount, verifyMessage } from '../../sdk/divigames.js';
import { CELL_NAMES } from './bot.js';

const EXPLORER = 'https://services.divi.domains/testnet/explorer2';

/**
 * @typedef {{
 *   txid: string, body: string, sig: string, from: string, nonce: number, action: any,
 *   stage: 'signed'|'mempool'|'block'|'failed', here: boolean, verified: boolean,
 *   height?: number, index?: number, events?: {kind: string, data: any}[], error?: string|null,
 * }} Entry
 * @typedef {{name: string, mark?: string, kind: 'phrase'|'legacy'|'play'|'session'|'wallet'|'other',
 *   path?: string, phrase?: () => string, note?: string}} Who
 */

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
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}

const short = (/** @type {string} */ s, n = 10) => (s && s.length > n + 6 ? `${s.slice(0, n)}…${s.slice(-4)}` : s || '');
const link = (/** @type {string} */ href, /** @type {string} */ text, title = '') =>
  el('a', { href, target: '_blank', rel: 'noopener', title: title || null, class: 'mono' }, text);
const ago = (/** @type {number} */ ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** A labelled row: <dt>label</dt><dd>value</dd>. */
const row = (/** @type {string} */ label, /** @type {...(Node|string|null|undefined|false)} */ ...value) =>
  [el('dt', {}, label), el('dd', {}, ...value)];

/** A stake in GOLD: the op holds base units, and GOLD has 2 decimals (100 = 1 GOLD). */
function stakeText(/** @type {any} */ base) {
  try { return `${formatAmount(String(base ?? '0'), 2)} GOLD`; } catch { return String(base); }
}

/** In plain words, what a tic-tac-toe op asks the chain to do. */
function describe(/** @type {any} */ action) {
  const op = action?.op ?? {};
  if (action?.type !== 'game') return action?.type ?? 'transaction';
  switch (op.kind) {
    case 'create': return `Opens a table${op.opponent ? ' for one named opponent' : ''}, stake ${stakeText(op.stake)}`;
    case 'join': return 'Takes the O seat';
    case 'move': return `Plays the ${CELL_NAMES[op.cell] ?? `cell ${op.cell}`}`;
    case 'cancel': return 'Cancels the open table';
    case 'claim_timeout': return 'Claims the game on a timeout';
    default: return op.kind ?? 'game action';
  }
}

/**
 * @param {{ chain: import('../../sdk/divigames.js').Chain, root: HTMLElement, identify: (addr: string) => Who }} opts
 */
export function createChainLog({ chain, root, identify }) {
  /** @type {Map<string, Map<string, Entry>>} game id → txid → entry */
  const games = new Map();
  /** @type {Map<string, string>} txid → game id, for txs we are following */
  const gameOfTx = new Map();
  /** @type {Map<number, any>} sidechain blocks by height */
  const blocks = new Map();
  /** @type {Set<string>} */ const scanned = new Set();
  /** @type {any[]} newest first */ let anchors = [];
  const head = { height: 0, time: 0, divi: /** @type {{hash: string, height: number}|null} */ (null) };
  /** @type {any} */ let game = null;
  /** @type {string|null} */ let gameId = null;
  /** @type {Map<string, number>} address → next nonce */ const nonces = new Map();
  /** @type {Set<string>} which <details> are open, so a re-render keeps them */ const open = new Set();
  /** @type {Set<string>} addresses whose 12 words are showing */ const revealed = new Set();
  let scanNote = '';
  let frame = 0;

  const entriesOf = (/** @type {string} */ id) => {
    let m = games.get(id);
    if (!m) games.set(id, (m = new Map()));
    return m;
  };

  // A short timer, not requestAnimationFrame: a background tab never runs animation frames, and the panel
  // should be current the moment someone switches back to it.
  const render = () => {
    if (frame) return;
    frame = setTimeout(() => {
      frame = 0;
      draw();
    }, 30);
  };

  /** Fetch one sidechain block into the cache. */
  async function loadBlocks(/** @type {number} */ from, limit = 1) {
    const res = await fetch(`${chain.baseUrl}/v1/blocks?from=${from}&limit=${Math.min(limit, 100)}`);
    if (!res.ok) return [];
    const list = await res.json();
    for (const b of Array.isArray(list) ? list : []) blocks.set(Number(b.header?.height), b);
    return Array.isArray(list) ? list : [];
  }

  async function loadAnchors() {
    try {
      const v = await chain.game('system', { view: 'anchors' });
      anchors = Array.isArray(v?.anchors) ? v.anchors : [];
      render();
    } catch { /* the panel just shows fewer facts */ }
  }

  async function loadNonce(/** @type {string} */ addr) {
    try {
      const a = await chain.account(addr);
      nonces.set(addr, Number(a.next_nonce));
      render();
    } catch { /* ignore */ }
  }

  /** @param {{txid: string, body: string, sig: string}} tx @param {string} id @param {boolean} here */
  function addTx(tx, id, here) {
    /** @type {any} */ let body = {};
    try { body = JSON.parse(tx.body); } catch { /* keep it raw */ }
    const m = entriesOf(id);
    const old = m.get(tx.txid);
    /** @type {Entry} */
    const e = old ?? {
      txid: tx.txid, body: tx.body, sig: tx.sig, from: body.from, nonce: Number(body.nonce), action: body.action,
      stage: 'signed', here, verified: false,
    };
    if (!old) {
      try { e.verified = verifyMessage(body.from, tx.body, tx.sig); } catch { e.verified = false; }
      m.set(tx.txid, e);
      gameOfTx.set(tx.txid, id);
    }
    return e;
  }

  /** @param {Entry} e @param {any} r */
  function applyReceipt(e, r) {
    e.stage = r.ok ? 'block' : 'failed';
    e.height = Number(r.height);
    e.index = Number(r.index);
    e.events = r.events ?? [];
    e.error = r.error ?? null;
    if (!blocks.has(e.height)) loadBlocks(e.height).then(render, () => {});
    if (e.from) loadNonce(e.from);
  }

  const touches = (/** @type {any} */ r, /** @type {string} */ id) => (r?.events ?? []).some((/** @type {any} */ ev) => ev?.data?.id === id);

  /** Find this game's transactions in the blocks it spans: read each block's txids, keep the ones that touch the game. */
  async function scan(/** @type {string} */ id, /** @type {any} */ g) {
    scanned.add(id);
    const from = Number(g.created_height) || 0;
    const to = Math.max(from, Number(g.last_move_height) || from);
    if (!from) return;
    const span = Math.min(to - from + 1, 600);
    scanNote = `Reading sidechain blocks #${from}–#${from + span - 1}…`;
    render();
    try {
      for (let h = from; h < from + span; h += 100) {
        const list = await loadBlocks(h, Math.min(100, from + span - h));
        const txids = list.flatMap((b) => b.txids ?? []).filter((t) => !gameOfTx.has(t));
        const txs = await Promise.all(txids.map((t) => chain.tx(t).catch(() => null)));
        txs.forEach((t, i) => {
          if (!t?.receipt || !touches(t.receipt, id)) return;
          applyReceipt(addTx({ txid: txids[i], body: t.body, sig: t.sig }, id, false), t.receipt);
        });
      }
      scanNote = span < to - from + 1 ? `Showing the first ${span} blocks of this game.` : '';
    } catch {
      scanNote = 'Could not read every block of this game; the list may be missing a move.';
    }
    render();
  }

  // ---------- drawing ----------

  /** A collapsible block whose open state survives re-renders. */
  function details(/** @type {string} */ key, /** @type {string} */ summary, /** @type {Node[]} */ ...body) {
    const d = el('details', { class: 'cp-more' }, el('summary', {}, summary), ...body);
    if (open.has(key)) d.open = true;
    d.addEventListener('toggle', () => (d.open ? open.add(key) : open.delete(key)));
    return d;
  }

  /** The earliest anchor at or after sidechain height h: it seals h, since each block names the one before it. */
  function sealOf(/** @type {number} */ h) {
    const a = anchors.filter((x) => Number(x.height) >= h).sort((p, q) => p.height - q.height)[0];
    return a ? { anchor: a, at: Number(a.height) } : { anchor: null, at: h };
  }

  function drawHeads() {
    return el('div', { class: 'cp-heads' },
      el('div', { class: 'cp-head' },
        el('span', { class: 'cp-chain side' }, 'Divi Games sidechain'),
        head.height
          ? link(`${chain.baseUrl}/v1/blocks?from=${head.height}&limit=1`, `#${head.height}`, 'The newest sidechain block (raw JSON)')
          : el('span', { class: 'mono' }, '…'),
        el('span', { class: 'cp-dim' }, head.time ? ` · ${ago(head.time)}` : '')),
      el('div', { class: 'cp-head' },
        el('span', { class: 'cp-chain divi' }, 'Divi testnet'),
        head.divi
          ? link(`${EXPLORER}/block/${head.divi.hash}`, `#${head.divi.height}`, 'The newest Divi testnet block the sequencer has seen')
          : el('span', { class: 'mono' }, '…')));
  }

  function drawPlayers() {
    if (!game) return null;
    const seats = /** @type {const} */ ([['x', game.x], ['o', game.o ?? game.opponent]]);
    const list = el('div', { class: 'cp-players' });
    for (const [mark, addr] of seats) {
      if (!addr) {
        list.append(el('div', { class: 'cp-player' }, el('span', { class: `mark ${mark}` }, mark.toUpperCase()), el('span', { class: 'cp-dim' }, 'Seat open')));
        continue;
      }
      const w = identify(addr);
      const n = nonces.get(addr);
      if (n == null) { nonces.set(addr, NaN); loadNonce(addr); }
      const kind = {
        phrase: `12-word recovery phrase, address 0 at ${w.path}`,
        legacy: 'A single key (WIF) this browser made before the bots had phrases',
        play: 'Your play key: a single key kept in this browser',
        session: 'A session key that plays for the owner below',
        wallet: 'Your IronDivi wallet signs each move',
        other: 'A key this browser does not hold; only its owner can sign for this seat',
      }[w.kind];
      const card = el('div', { class: `cp-player ${mark}` },
        el('div', { class: 'cp-player-top' },
          el('span', { class: `mark ${mark}` }, mark.toUpperCase()),
          el('strong', {}, w.name),
          Number.isFinite(n) ? el('span', { class: 'cp-dim' }, ` · ${n} tx${n === 1 ? '' : 's'} signed`) : null),
        el('div', { class: 'cp-addr' }, link(`${chain.baseUrl}/v1/account/${addr}`, addr, 'This address on the sidechain (raw JSON)')),
        el('div', { class: 'cp-dim' }, kind),
        w.note ? el('div', { class: 'cp-dim' }, w.note) : null);
      if (w.kind === 'phrase' && w.phrase) {
        const shown = revealed.has(addr);
        card.append(el('button', {
          type: 'button', class: 'ghost small cp-reveal', 'aria-expanded': String(shown),
          onclick: () => { shown ? revealed.delete(addr) : revealed.add(addr); render(); },
        }, shown ? 'Hide the 12 words' : 'Show the 12 words'));
        if (shown) {
          const words = w.phrase().split(' ');
          card.append(el('div', { class: 'cp-phrase' },
            el('ol', { class: 'cp-words' }, ...words.map((x) => el('li', {}, x))),
            el('p', { class: 'cp-dim' },
              `Testnet only. Anyone with these words controls ${w.name}. Restore them in an IronDivi wallet on testnet and it opens this same address.`)));
        }
      }
      list.append(card);
    }
    return el('section', { class: 'cp-sec' },
      el('h3', {}, 'The two players'),
      el('p', { class: 'cp-dim' }, 'Each seat is a separate key. The chain only accepts a move signed by the key in that seat.'),
      list);
  }

  /** Which seat a tx is for. A session key signs for its owner, so go by what the chain recorded, then the seat. */
  function markOf(/** @type {Entry} */ e, /** @type {Who} */ w) {
    for (const ev of e.events ?? []) {
      if (ev.kind === 'tictactoe.created') return 'x';
      if (ev.kind === 'tictactoe.joined') return 'o';
      if (ev.kind === 'tictactoe.moved' && ev.data?.by) return ev.data.by === game?.x ? 'x' : 'o';
    }
    if (e.action?.op?.kind === 'create') return 'x';
    if (e.action?.op?.kind === 'join') return 'o';
    return w.mark ?? (e.from === game?.x ? 'x' : 'o');
  }

  const STEPS = /** @type {const} */ (['Signed', 'Sidechain block', 'Sealed on Divi']);

  function drawEntry(/** @type {Entry} */ e) {
    const w = identify(e.from);
    const mark = markOf(e, w);
    const seal = e.height ? sealOf(e.height) : null;
    const reached = e.stage === 'failed' ? 1 : e.stage === 'block' ? (seal?.anchor ? 3 : 2) : 1;
    const pill = {
      signed: ['Signed, sending…', 'info'],
      mempool: ['In the mempool', 'info'],
      block: [seal?.anchor ? `Sealed on Divi` : `In block #${e.height}`, seal?.anchor ? 'ok' : 'accent'],
      failed: ['Rejected', 'err'],
    }[e.stage];
    const b = e.height ? blocks.get(e.height) : null;

    const facts = el('dl', { class: 'cp-facts' },
      ...row('Signed by', `${w.name} · nonce ${e.nonce}`),
      ...row('Txid', link(`/explorer/tx/${e.txid}`, short(e.txid, 16), 'The transaction in the Divi Games explorer'),
        ' · ', link(`${chain.baseUrl}/v1/tx/${e.txid}`, 'raw JSON', 'The transaction and its receipt (raw JSON)')),
      ...row('Signature', el('span', { class: 'mono' }, short(e.sig, 12)), ' ',
        e.verified ? el('span', { class: 'cp-ok' }, '✓ checked here') : el('span', { class: 'cp-bad' }, '✗ does not match')),
      ...(e.stage === 'failed' ? row('Error', e.error ?? 'rejected') : []),
      ...(b ? [
        ...row('Block', link(`/explorer/block/${e.height}`, `#${e.height}`, 'The block in the Divi Games explorer'), ` · tx ${Number(e.index) + 1} of ${b.txids?.length ?? '?'}`),
        ...row('Block hash', el('span', { class: 'mono' }, short(b.hash, 16))),
        ...row('State root', el('span', { class: 'mono' }, short(b.header?.state_root, 16))),
        ...row('Made by', el('span', { class: 'mono' }, short(b.header?.producer, 10)), ' (the sequencer, which signs each block)'),
        ...(b.header?.divi ? row('Divi tip then', link(`${EXPLORER}/block/${b.header.divi.hash}`, `Divi testnet #${b.header.divi.height}`)) : []),
      ] : e.height ? row('Block', `#${e.height}`) : []),
      ...(e.events?.length ? row('Events', el('ul', { class: 'cp-events' }, ...e.events.map((ev) =>
        el('li', {}, el('span', { class: 'mono' }, ev.kind), ' ', el('span', { class: 'cp-dim' }, eventText(ev.data)))))) : []),
      ...(seal ? row('Divi anchor', seal.anchor
        ? el('span', {}, link(`${EXPLORER}/tx/${seal.anchor.divi_txid}`, short(seal.anchor.divi_txid, 12), 'The Divi testnet transaction that seals it'),
          ` covers sidechain #${seal.at}`)
        : el('span', {}, 'Being written to Divi: usually within a minute or two, once the last anchor is in a Divi block')) : []));

    return el('li', { class: `cp-tx ${mark}${e.stage === 'failed' ? ' failed' : ''}` },
      el('div', { class: 'cp-tx-top' },
        el('span', { class: `mark ${mark}` }, mark.toUpperCase()),
        el('span', { class: 'cp-what' }, describe(e.action)),
        el('span', { class: `cp-pill ${pill[1]}` }, pill[0])),
      el('ol', { class: 'cp-steps', 'aria-label': `Stage ${reached} of 3` },
        ...STEPS.map((s, k) => el('li', { class: k < reached ? (e.stage === 'failed' && k === 1 ? 'bad' : 'on') : '' }, s))),
      facts,
      details(`body:${e.txid}`, 'The exact bytes that were signed', el('pre', { class: 'cp-body' }, pretty(e.body)),
        el('p', { class: 'cp-dim' }, `The txid is the SHA-256 of this text. The signature is ${w.name}'s Divi signed-message signature over it, so any change to one byte breaks it.`)));
  }

  function drawMoves() {
    if (!gameId) return null;
    const list = [...entriesOf(gameId).values()].sort((a, b) =>
      (a.height ?? Infinity) - (b.height ?? Infinity) || (a.index ?? 0) - (b.index ?? 0));
    return el('section', { class: 'cp-sec' },
      el('h3', {}, 'What each move did'),
      el('p', { class: 'cp-dim' }, 'Each move is one sidechain transaction: built here, signed by the player’s key, put in a block by the sequencer, then sealed on Divi with the next anchor.'),
      scanNote ? el('p', { class: 'cp-dim' }, scanNote) : null,
      list.length ? el('ol', { class: 'cp-txs' }, ...list.map((e) => drawEntry(e))) : el('p', { class: 'cp-dim' }, 'No transactions yet.'));
  }

  function drawDivi() {
    const last = anchors[0];
    return el('section', { class: 'cp-sec' },
      el('h3', {}, 'On Divi itself'),
      el('p', { class: 'cp-dim' },
        'Moves are not Divi transactions, and GOLD is a sidechain token. Soon after a block holds a move, the sequencer pays for one ' +
        'Divi testnet transaction with a 77-byte OP_RETURN: the newest block’s height, hash and state root. Each block names the one before it, ' +
        'so that one Divi transaction seals every earlier move. Change any move and the hashes no longer match what Divi recorded.'),
      el('dl', { class: 'cp-facts' },
        ...(last ? [
          ...row('Last anchor', `sidechain #${last.height} → `, link(`${EXPLORER}/tx/${last.divi_txid}`, short(last.divi_txid, 12))),
        ] : row('Last anchor', '…')),
        ...row('Next anchor', 'As soon as a block holds a move and the last anchor is in a Divi block (one comes about once a minute). ' +
          'A quiet chain is still sealed every 300 blocks.')));
  }

  function draw() {
    root.replaceChildren(drawHeads(), ...[drawPlayers(), drawMoves(), drawDivi()].filter(Boolean));
  }

  // ---------- the page tells us what happens ----------

  return {
    /** The page built and signed a tx; nothing is on the chain yet. */
    signed(/** @type {{txid: string, body: string, sig: string, gameId: string|null}} */ t) {
      if (!t.gameId) return;
      addTx(t, t.gameId, true);
      render();
    },
    /** The sequencer accepted it into the mempool. */
    sent(/** @type {string} */ txid) {
      const e = games.get(gameOfTx.get(txid) ?? '')?.get(txid);
      if (e && e.stage === 'signed') { e.stage = 'mempool'; render(); }
    },
    /** It is in a block (ok or failed). */
    receipt(/** @type {any} */ r) {
      const e = games.get(gameOfTx.get(r?.txid) ?? '')?.get(r.txid);
      if (e && e.stage !== 'block') { applyReceipt(e, r); render(); }
    },
    /** It never reached a block. */
    failed(/** @type {string} */ txid, /** @type {string} */ error) {
      const e = games.get(gameOfTx.get(txid) ?? '')?.get(txid);
      if (e && e.stage !== 'block') { e.stage = 'failed'; e.error = error; render(); }
    },
    /** A new sidechain block from the websocket. */
    block(/** @type {any} */ msg) {
      const h = Number(msg?.header?.height);
      if (!Number.isFinite(h)) return;
      blocks.set(h, msg);
      for (const k of blocks.keys()) if (k < h - 400 && ![...gameOfTx.keys()].length) blocks.delete(k);
      head.height = Math.max(head.height, h);
      head.time = Number(msg.header.time_ms) || Date.now();
      if (msg.header.divi) head.divi = msg.header.divi;
      for (const r of msg.receipts ?? []) {
        if ((r.events ?? []).some((/** @type {any} */ ev) => ev.kind === 'system.anchor_recorded')) loadAnchors();
        const id = gameOfTx.get(r.txid);
        if (id) { const e = games.get(id)?.get(r.txid); if (e && e.stage !== 'block') applyReceipt(e, r); continue; }
        // A move from a player in another browser: fetch its signed body so it shows like ours.
        if (gameId && touches(r, gameId)) {
          const gid = gameId;
          chain.tx(r.txid).then((t) => { if (t) { applyReceipt(addTx({ txid: r.txid, body: t.body, sig: t.sig }, gid, false), r); render(); } }, () => {});
        }
      }
      render();
    },
    /** The chain's current heads, from /v1/info at start. */
    heads(/** @type {any} */ info) {
      const h = Number(info?.height);
      if (Number.isFinite(h)) head.height = Math.max(head.height, h);
      if (info?.divi?.hash) head.divi = info.divi;
      loadAnchors();
      render();
    },
    /** The table on screen changed. */
    show(/** @type {any} */ g, /** @type {string|null} */ id) {
      if (id !== gameId) { revealed.clear(); scanNote = ''; }
      game = g;
      gameId = id;
      if (g && id && !scanned.has(id)) scan(id, g);
      render();
    },
  };
}

/** Event data as short "key value" pairs; boards are drawn as nine marks. */
function eventText(/** @type {any} */ data) {
  if (!data || typeof data !== 'object') return '';
  return Object.entries(data)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => {
      if (k === 'board') return `board ${(Array.isArray(v) ? v.map((c) => c || '.').join('') : String(v)).toUpperCase().replace(/\./g, '·')}`;
      if (k === 'cell') return `cell ${v} (${CELL_NAMES[Number(v)] ?? '?'})`;
      if (typeof v === 'string' && v.length > 20) return `${k} ${short(v, 6)}`;
      return `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`;
    })
    .join(' · ');
}

/** The signed body, indented for reading. The signed bytes are the compact form above it. */
function pretty(/** @type {string} */ body) {
  try {
    return `${body}\n\n${JSON.stringify(JSON.parse(body), null, 2)}`;
  } catch {
    return body;
  }
}
