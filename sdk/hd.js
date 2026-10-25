// hd.js: 12-word recovery phrases and HD keys, the same way the IronDivi wallets make them.
//
// BIP-39 (English wordlist, PBKDF2-HMAC-SHA512 with 2048 rounds) turns a phrase into a 64-byte seed, and
// BIP-32 walks the seed down the BIP-44 path m/44'/<coin>'/0'/0/<index>, where the coin is 1 on testnet and
// 301 on mainnet. A phrase made here opens the same addresses in the IronDivi Browser, Web and Telegram
// wallets. See ARCHITECTURE.md §1.5.

import * as secp from '../vendor/noble-secp256k1/index.js';
import { sha256, sha512 } from '../vendor/noble-hashes/sha2.js';
import { hmac } from '../vendor/noble-hashes/hmac.js';
import { ENGLISH } from '../vendor/bip39/english.js';
import { Key } from './divigames.js';

/** BIP-44 coin type per Divi network, as the IronDivi wallets use them. */
export const COIN_TYPES = { testnet: 1, mainnet: 301 };

const N = secp.CURVE.n;
const HARDENED = 0x80000000;
const utf8 = new TextEncoder();

/** @param {...Uint8Array} parts */
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** @param {Uint8Array} b */
const toBigInt = b => BigInt('0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join(''));

/** @param {bigint} n */
function fromBigInt(n) {
  const hex = n.toString(16).padStart(64, '0');
  return Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16));
}

// ---------------------------------------------------------------------------------------------------------
// BIP-39

/** @param {Uint8Array} bytes */
const toBits = bytes => Array.from(bytes, b => b.toString(2).padStart(8, '0')).join('');

/**
 * Words for 16 bytes of entropy (12 words) or 32 bytes (24 words).
 * @param {Uint8Array} entropy
 */
export function entropyToMnemonic(entropy) {
  if (![16, 20, 24, 28, 32].includes(entropy.length)) throw new Error('entropy must be 16 to 32 bytes');
  const bits = toBits(entropy) + toBits(sha256(entropy)).slice(0, entropy.length / 4);
  return (bits.match(/.{11}/g) ?? []).map(b => ENGLISH[parseInt(b, 2)]).join(' ');
}

/** A new random 12-word phrase from the browser's secure random source. */
export function generateMnemonic() {
  return entropyToMnemonic(crypto.getRandomValues(new Uint8Array(16)));
}

/** @param {string} phrase */
const words = phrase => phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/);

/**
 * True if every word is on the list and the checksum (the last few bits) matches.
 * @param {string} phrase
 */
export function validateMnemonic(phrase) {
  const w = words(phrase);
  if (![12, 15, 18, 21, 24].includes(w.length)) return false;
  const idx = w.map(x => ENGLISH.indexOf(x));
  if (idx.includes(-1)) return false;
  const bits = idx.map(i => i.toString(2).padStart(11, '0')).join('');
  const cs = w.length / 3;
  const entropy = Uint8Array.from(bits.slice(0, -cs).match(/.{8}/g) ?? [], b => parseInt(b, 2));
  return toBits(sha256(entropy)).slice(0, cs) === bits.slice(-cs);
}

/**
 * The 64-byte BIP-39 seed: PBKDF2-HMAC-SHA512(phrase, "mnemonic" + passphrase, 2048 rounds).
 * @param {string} phrase
 * @param {string} [passphrase] the optional extra word some wallets call a "25th word"
 */
export async function mnemonicToSeed(phrase, passphrase = '') {
  const pass = utf8.encode(words(phrase).join(' '));
  const salt = utf8.encode('mnemonic' + passphrase.normalize('NFKD'));
  const base = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 2048 }, base, 512);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------------------------------------
// BIP-32 (private derivation only)

/**
 * @typedef {{ key: Uint8Array, chainCode: Uint8Array }} Node
 */

/** The master node of a seed. @param {Uint8Array} seed @returns {Node} */
export function masterNode(seed) {
  const I = hmac(sha512, utf8.encode('Bitcoin seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/**
 * One child step. Hardened children (index ≥ 2^31) hash the private key, normal ones the public key.
 * @param {Node} node
 * @param {number} index
 * @returns {Node}
 */
export function childNode(node, index) {
  const ser = new Uint8Array(4);
  new DataView(ser.buffer).setUint32(0, index >>> 0);
  const data = index >= HARDENED
    ? concatBytes(Uint8Array.of(0), node.key, ser)
    : concatBytes(secp.getPublicKey(node.key, true), ser);
  const I = hmac(sha512, node.chainCode, data);
  const il = toBigInt(I.slice(0, 32));
  const k = (il + toBigInt(node.key)) % N;
  if (il >= N || k === 0n) throw new Error('invalid child key; use the next index');
  return { key: fromBigInt(k), chainCode: I.slice(32) };
}

/**
 * Walk a path such as m/44'/1'/0'/0/0 from a seed.
 * @param {Uint8Array} seed
 * @param {string} path
 */
export function derivePath(seed, path) {
  const parts = path.split('/');
  if (parts.shift() !== 'm') throw new Error(`path must start with m: ${path}`);
  return parts.reduce((node, p) => {
    const hard = /['h]$/.test(p);
    const i = Number(hard ? p.slice(0, -1) : p);
    if (!Number.isInteger(i) || i < 0 || i >= HARDENED) throw new Error(`bad path step: ${p}`);
    return childNode(node, hard ? i + HARDENED : i);
  }, masterNode(seed));
}

/**
 * The BIP-44 path the IronDivi wallets use for receive address `index`.
 * @param {'testnet'|'mainnet'} [network]
 * @param {number} [index]
 */
export const walletPath = (network = 'testnet', index = 0) => `m/44'/${COIN_TYPES[network]}'/0'/0/${index}`;

/**
 * The signing key a wallet restored from this phrase shows as its address `index`.
 * @param {string} phrase
 * @param {{ network?: 'testnet'|'mainnet', index?: number, passphrase?: string }} [opts]
 * @returns {Promise<{ key: Key, path: string }>}
 */
export async function keyFromMnemonic(phrase, { network = 'testnet', index = 0, passphrase = '' } = {}) {
  if (!validateMnemonic(phrase)) throw new Error('not a valid 12- or 24-word recovery phrase');
  const path = walletPath(network, index);
  const { key } = derivePath(await mnemonicToSeed(phrase, passphrase), path);
  return { key: new Key(key, network), path };
}
