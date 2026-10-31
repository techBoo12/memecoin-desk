// Oct 31 fix: smart-wallet list sanity (fake fund / fake dollar "winners", idle wallets). No network.
// Rows below are the real DexScreener numbers read Oct 31 ~08:00 UTC for the first list's "winners".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lookalike, winnerSanity, taintClones, lastTradeAt, recencyGate, newestOkSig, SANITY } from '../src/playbook/smart_list.js';
import { WSOL, PUMPSWAP } from '../src/playbook/smart.js';

const NOW = Date.parse('2026-10-31T08:00:00Z'), H = 3.6e6;
const W = 'SmArTwALLet1111111111111111111111111111111', MINT = 'CoiNmint11111111111111111111111111111pump', POOL = 'PooLaddr111111111111111111111111111111111';
const tb = (i, owner, mint, amount, dec = 6) => ({ accountIndex: i, owner, mint, uiTokenAmount: { amount: String(amount), decimals: dec } });
function swap(w, { sol = -1, tokens = 1e9, at = NOW } = {}) {
  return { blockTime: Math.floor(at / 1000), slot: 1,
    meta: { err: null, preBalances: [10e9, 0, 0, 0, 0], postBalances: [10e9 + sol * 1e9, 0, 0, 0, 0],
      preTokenBalances: [tb(2, w, MINT, tokens < 0 ? -tokens : 0), tb(3, POOL, MINT, 5e14), tb(4, POOL, WSOL, 80e9, 9)],
      postTokenBalances: [tb(2, w, MINT, tokens < 0 ? 0 : tokens), tb(3, POOL, MINT, 5e14 - tokens), tb(4, POOL, WSOL, 80e9 - sol * 1e9, 9)] },
    transaction: { signatures: ['s' + Math.random()], message: { accountKeys: [w, POOL, 'TA_w', 'TA_pool', PUMPSWAP] } } };
}
const noop = (w, at) => ({ blockTime: Math.floor(at / 1000), slot: 1, meta: { err: null, preBalances: [1e9], postBalances: [1e9 - 5000], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: ['n'], message: { accountKeys: [w] } } });

test('sanity: stablecoin / fake-fund lookalikes are flagged, ordinary meme names are not', () => {
  for (const [s, n] of [['USDP', 'USDP'], ['USDF', 'United States Dividend Fund'], ['USOE', 'United States Oil Exchange'], ['NODF', 'NODF🔥'], ['AOTF', 'American Oil Trust Fund'],
    ['UDTF', 'United Dividend Trust Fund'], ['ADF', 'American Dream Fund'], ['NAFF', 'National American Future Fund'], ['$USDC', 'whatever'], ['FODF', 'Federal Oil Dividend Fund 🔥']])
    assert.ok(lookalike(s, n), `${s} / ${n} should be flagged`);
  for (const [s, n] of [['Leverhedge', 'Leverhedge'], ['CONSOLE', 'Console'], ['HALVE', 'HALVE'], ['GROKVORTEX', 'Grokvortex'], ['FOMO', 'Fomo Family'], ['SUBX', 'SubX'], ['GEOM', 'GEOM'], ['WTF', 'wtf'], ['BONK', 'Bonk']])
    assert.equal(lookalike(s, n), null, `${s} / ${n} should pass`);
});

test('sanity: impossible peaks, thin managed pools, one-sided flow and pinned prices are dropped; a real runner passes', () => {
  const at = NOW - 38 * H;
  // $USOE: 42,385x, fdv 281x liq, 49,948 buys vs 1,028 sells
  assert.match(winnerSanity({ symbol: 'ZZZ', name: 'zzz', peakX: 42385.6, nowX: 42358.6, fdv: 531721445, liq: 1892927, buys24: 49948, sells24: 1028, at }, NOW), /not believable/);
  // the same pool under an innocent name still fails on fdv/liquidity once under the peak cap
  assert.match(winnerSanity({ symbol: 'ZZZ', peakX: 900, nowX: 899, fdv: 194407054, liq: 1141865, buys24: 100, sells24: 90, at }, NOW), /FDV 170x/);
  assert.match(winnerSanity({ symbol: 'ZZZ', peakX: 40, nowX: 30, fdv: 2e6, liq: 1e5, buys24: 49948, sells24: 1028, at }, NOW), /buys per sell/);
  assert.match(winnerSanity({ symbol: 'ZZZ', peakX: 300, nowX: 299, fdv: 3e6, liq: 1.5e5, buys24: 3000, sells24: 1500, at }, NOW), /pinned at 300x/);
  // pinned check waits for 12h of history: a fresh coin at its high is fine
  assert.equal(winnerSanity({ symbol: 'ZZZ', peakX: 300, nowX: 299, fdv: 3e6, liq: 1.5e5, buys24: 3000, sells24: 1500, at: NOW - 3 * H }, NOW), null);
  // $HALVE, real-looking: peak 511.6x, now 303.9x, fdv 38x liq, 27,624 buys / 14,416 sells
  assert.equal(winnerSanity({ symbol: 'HALVE', name: 'HALVE', peakX: 511.6, nowX: 303.9, fdv: 9650717, liq: 253859, buys24: 27624, sells24: 14416, at: NOW - 44 * H }, NOW), null);
  // $Leverhedge: 18x, fdv 10x liq
  assert.equal(winnerSanity({ symbol: 'Leverhedge', name: 'Leverhedge', peakX: null, nowX: 18.1, fdv: 699941, liq: 69555, buys24: 13736, sells24: 5437, at: NOW - 8 * H }, NOW), null);
  // the cap is a knob
  assert.match(winnerSanity({ symbol: 'HALVE', peakX: 511.6, nowX: 303.9, at }, NOW, { maxPeakX: 500 }), /> 500x/);
  assert.equal(SANITY.maxPeakX, 1000);
});

test('sanity: a flagged ticker taints its clones in the same window', () => {
  const list = [{ symbol: 'XTO' }, { symbol: 'xto' }, { symbol: 'HALVE' }];
  assert.deepEqual(taintClones(list, new Set(['XTO'])).map((m) => m.symbol), ['HALVE']);
});

test('recency: last BUY/SELL time from the wallet page; idle > 12h is refused; a fee-only tx does not count as a trade', () => {
  const txs = [noop(W, NOW - 1 * H), swap(W, { at: NOW - 20 * H }), swap(W, { sol: 1.2, tokens: -1e9, at: NOW - 14 * H })];
  const last = lastTradeAt(txs, W);
  assert.equal(last, NOW - 14 * H);
  const g = recencyGate(last, NOW, 12);
  assert.equal(g.ok, false); assert.match(g.why, /14\.0h ago/);
  assert.equal(recencyGate(lastTradeAt([...txs, swap(W, { at: NOW - 2 * H })], W), NOW, 12).ok, true);
  assert.equal(recencyGate(null, NOW).ok, false);
  assert.equal(lastTradeAt([noop(W, NOW)], W), null);
});

test('recency pre-check: newest successful signature; failed txs ignored', () => {
  const s = Math.floor(NOW / 1000);
  assert.equal(newestOkSig([{ blockTime: s - 10, err: { x: 1 } }, { blockTime: s - 3600, err: null }, { blockTime: s - 7200, err: null }]), (s - 3600) * 1000);
  assert.equal(newestOkSig([]), null);
});

test('builder: wires the sanity + recency checks, keeps the hook inside the credit budget, and the worker never imports smart_list.js', () => {
  const tool = fs.readFileSync(new URL('../tools/smart_wallets.mjs', import.meta.url), 'utf8');
  assert.match(tool, /winnerSanity/); assert.match(tool, /taintClones/); assert.match(tool, /recencyGate/); assert.match(tool, /getSignaturesForAddress/);
  assert.match(tool, /CREDIT_BUDGET - HOOK_RESERVE/);
  assert.match(tool, /'candidates', 100/);
  const lib = fs.readFileSync(new URL('../src/playbook/smart_list.js', import.meta.url), 'utf8');
  assert.ok(!/sendTransaction|signTransaction|secretKey|privateKey|Keypair/.test(lib), 'reads only');
  assert.match(lib, /statistical red flag, not proof/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
  const src = new URL('../src', import.meta.url).pathname;
  for (const f of walk(src).filter((f) => f.endsWith('.js') && !f.endsWith('smart_list.js'))) assert.ok(!fs.readFileSync(f, 'utf8').includes('smart_list'), `${f} must not import smart_list.js`);
});
