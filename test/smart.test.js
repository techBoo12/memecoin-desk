// Oct 31 (her "both"): insider alerts + smart-wallet copy lane (paper). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tradeOf, parseMigration, earlyBuyers, walletStats, scoreWallet, pickList, copyTrigger, recordSmartTrade, smartExited, hookToken, WSOL, PUMPSWAP } from '../src/playbook/smart.js';
import { createEngine } from '../src/desk/engine.js';
import { chargeKeyed, bindKeyedLedger, setKeyedRpc } from '../src/playbook/solana.js';
import { runCommand } from '../src/telegram/commands.js';
import { changeSetting } from '../src/desk/settings.js';
import { makeChain, A, ta } from './fixtures/fakechain.mjs';

const T0 = Date.parse('2026-10-31T05:00:00Z');
const W = 'SmArTwALLet1111111111111111111111111111111', W2 = 'SmArTwALLet2222222222222222222222222222222', W3 = 'SmArTwALLet3333333333333333333333333333333';
const MINT = 'CoiNmint11111111111111111111111111111pump', POOL = 'PooLaddr111111111111111111111111111111111';
const tb = (i, owner, mint, amount, dec = 6) => ({ accountIndex: i, owner, mint, uiTokenAmount: { amount: String(amount), decimals: dec } });
// a PumpSwap swap by `w`: sol < 0 = buy (SOL out, tokens in)
function swap(w, { mint = MINT, pool = POOL, sol = -1, tokens = 1e9, at = T0, sig = 's' + Math.random(), pumpswap = true, loaded = false } = {}) {
  const keys = [w, pool, 'TA_w', 'TA_pool', ...(pumpswap && !loaded ? [PUMPSWAP] : [])];
  return { blockTime: Math.floor(at / 1000), slot: 1,
    meta: { err: null, preBalances: [10e9, 0, 0, 0, 0], postBalances: [10e9 + sol * 1e9, 0, 0, 0, 0], loadedAddresses: loaded ? { writable: [], readonly: [PUMPSWAP] } : undefined,
      preTokenBalances: [tb(2, w, mint, tokens < 0 ? -tokens : 0), tb(3, pool, mint, 5e14), tb(4, pool, WSOL, 80e9, 9)],
      postTokenBalances: [tb(2, w, mint, tokens < 0 ? 0 : tokens), tb(3, pool, mint, 5e14 - tokens), tb(4, pool, WSOL, 80e9 - sol * 1e9, 9)] },
    transaction: { signatures: [sig], message: { accountKeys: keys } } };
}

test('smart: tradeOf reads a PumpSwap buy and a sell (SOL incl. fees), the pool, and v0 loaded keys', () => {
  const b = tradeOf(swap(W, { sol: -1.5, tokens: 2e9, loaded: true }), W);
  assert.equal(b.side, 'buy'); assert.equal(b.mint, MINT); assert.equal(b.sol, -1.5); assert.equal(b.tokens, 2000); assert.equal(b.pumpswap, true); assert.equal(b.pool, POOL);
  const s = tradeOf(swap(W, { sol: 3, tokens: -2e9 }), W);
  assert.equal(s.side, 'sell'); assert.equal(s.sol, 3);
  assert.equal(tradeOf(swap(W, { sol: -0.000005, tokens: -5e8 }), W).side, 'out'); // tokens left, no SOL back = a transfer
  assert.equal(tradeOf(swap(W2), W).side, 'other'); // not this wallet's trade
});

test('smart: parseMigration takes the pool seeded by a pump.fun Migrate', () => {
  const tx = { blockTime: T0 / 1000, meta: { err: null, logMessages: ['Program log: Instruction: MigrateV2'], postTokenBalances: [tb(1, POOL, MINT, 206.9e12), tb(2, POOL, WSOL, 79e9, 9), tb(3, 'X', MINT, 5)] }, transaction: { signatures: ['m'], message: { accountKeys: [] } } };
  const m = parseMigration(tx);
  assert.equal(m.pool, POOL); assert.equal(m.mint, MINT); assert.ok(Math.abs(m.solRes - 79) < 1e-9); assert.ok(Math.abs(m.priceSol - 79 / 206.9e6) < 1e-15);
  assert.equal(parseMigration({ ...tx, meta: { ...tx.meta, logMessages: ['Instruction: Buy'] } }), null);
});

test('smart: early buyers = buyers inside the window after the migration, signer only, pool skipped', () => {
  const txs = [swap(W, { at: T0 + 60_000, sol: -1 }), swap(W, { at: T0 + 120_000, sol: -0.5 }), swap(W2, { at: T0 + 11 * 60_000 }), swap(W3, { at: T0 + 30_000, sol: 2, tokens: -1e9 })];
  const eb = earlyBuyers(txs, { mint: MINT, migratedAt: T0, windowMin: 10 });
  assert.deepEqual(eb.map((x) => x.wallet), [W]); assert.equal(eb[0].sol, 1.5); assert.equal(eb[0].n, 2);
});

test('smart: walletStats = realized PnL of closed positions only; bought-before-window and moved-out bags are not scored', () => {
  const D = 86_400_000, txs = [];
  const coin = (k) => `Coin${k}`.padEnd(40, 'x') + 'pump';
  // 4 round trips: 3 wins, 1 loss
  [[1, 2], [1, 3], [2, 1], [1, 1.5]].forEach(([inS, outS], i) => { txs.push(swap(W, { mint: coin(i), sol: -inS, tokens: 1e9, at: T0 + i * D })); txs.push(swap(W, { mint: coin(i), sol: outS, tokens: -1e9, at: T0 + i * D + 3_600_000 })); });
  txs.push(swap(W, { mint: coin(9), sol: 5, tokens: -1e9, at: T0 })); // sold a bag bought before the window: unscorable
  txs.push(swap(W, { mint: coin(8), sol: -1, tokens: 1e9, at: T0 })); txs.push(swap(W, { mint: coin(8), sol: -0.000005, tokens: -1e9, at: T0 + 1000 })); // moved out
  txs.push(swap(W, { mint: coin(7), sol: -1, tokens: 1e9, at: T0 })); // still open
  const s = walletStats(txs.reverse(), W); // newest-first input, as the API returns it
  assert.equal(s.closed, 4); assert.equal(s.wins, 3); assert.equal(s.winRate, 0.75); assert.equal(s.pnlSol, 2.5); assert.equal(s.open, 1);
  assert.equal(s.medianHoldMin, 60);
});

test('smart: the gate refuses small samples, losers, bots and same-block flippers; score grows with pnl and win rate', () => {
  const base = { closed: 12, winRate: 0.6, pnlSol: 4, txPerDay: 40, medianHoldMin: 20 };
  assert.equal(scoreWallet(base).ok, true);
  assert.equal(scoreWallet({ ...base, closed: 3 }).ok, false);
  assert.equal(scoreWallet({ ...base, winRate: 0.3 }).ok, false);
  assert.equal(scoreWallet({ ...base, pnlSol: -1 }).ok, false);
  assert.match(scoreWallet({ ...base, txPerDay: 900 }).why, /bot-like/);
  assert.match(scoreWallet({ ...base, medianHoldMin: 0.1 }).why, /flipper/);
  assert.ok(scoreWallet({ ...base, pnlSol: 8 }).score > scoreWallet(base).score);
});

test('smart: pickList keeps the best that fit the daily webhook budget', () => {
  const sc = [{ wallet: 'a', score: 9, txPerDay: 2000 }, { wallet: 'b', score: 8, txPerDay: 300 }, { wallet: 'c', score: 7, txPerDay: 300 }, { wallet: 'd', score: 1, txPerDay: 10 }];
  const p = pickList(sc, { max: 2, hookBudgetDay: 1000 });
  assert.deepEqual(p.list.map((x) => x.wallet), ['b', 'c']); assert.equal(p.expectedEventsDay, 600);
});

test('copy signal: K distinct smart wallets on PumpSwap inside the window, once per coin; sells counted for the C1 exit', () => {
  const C = {};
  recordSmartTrade(C, tradeOf(swap(W, { at: T0 }), W), W, T0);
  recordSmartTrade(C, tradeOf(swap(W, { at: T0 + 60_000 }), W), W, T0); // same wallet twice = one vote
  assert.equal(copyTrigger(C, MINT, T0 + 60_000, { minWallets: 2, windowMin: 15 }), null);
  recordSmartTrade(C, tradeOf(swap(W2, { at: T0 + 20 * 60_000 }), W2), W2, T0); // outside the 15 min window
  assert.equal(copyTrigger(C, MINT, T0 + 20 * 60_000, { minWallets: 2, windowMin: 15 }), null);
  recordSmartTrade(C, tradeOf(swap(W3, { at: T0 + 21 * 60_000, pumpswap: false }), W3), W3, T0); // not a PumpSwap buy
  assert.equal(copyTrigger(C, MINT, T0 + 21 * 60_000, { minWallets: 2, windowMin: 15 }), null);
  recordSmartTrade(C, tradeOf(swap(W3, { at: T0 + 22 * 60_000 }), W3), W3, T0);
  const trig = copyTrigger(C, MINT, T0 + 22 * 60_000, { minWallets: 2, windowMin: 15 });
  assert.deepEqual(trig.wallets.sort(), [W2, W3].sort()); assert.equal(trig.pool, POOL);
  C.fired = { [MINT]: T0 }; assert.equal(copyTrigger(C, MINT, T0 + 22 * 60_000, { minWallets: 2 }), null);
  recordSmartTrade(C, tradeOf(swap(W2, { sol: 2, tokens: -6e8 }), W2), W2, T0);
  assert.equal(smartExited(C, MINT, [W2, W3]), 1);
});

test('webhook auth token: derived from the admin key, stable, and never the key itself', async () => {
  const a = await hookToken('k1'), b = await hookToken('k1');
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(a, await hookToken('k2')); assert.ok(!a.includes('k1'));
});

test('budget: credits spent off the rpc client (list build, webhook pushes) land on the same daily Helius ledger', () => {
  const L = bindKeyedLedger({ day: new Date().toISOString().slice(0, 10), used: 100, denied: 0 });
  chargeKeyed(2000); chargeKeyed(3);
  assert.equal(L.used, 2103);
});

// ---------------------------------------------------------------- inside the engine (fake chain)
function deskConfig(over = {}, copy = {}, alerts = {}) {
  const c = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
  c.playbook = { ...c.playbook, discover_every_s: 9999, ...over, copy: { ...c.playbook.copy, ...copy }, alerts: { ...c.playbook.alerts, ...alerts } };
  c.loop.scanEverySec = 1e9;
  return c;
}
function boot({ over = {}, copy = {}, alerts = {}, insider = true } = {}) {
  const ch = makeChain();
  let t = ch.MIGRATED + 2 * 60_000;
  const S = {}, sent = [];
  const config = deskConfig(over, copy, alerts);
  const eng = createEngine({ config, S, log: { event() {}, warn() {}, info() {} }, notify: (k, txt) => sent.push([k, txt]), now: () => t, pbIo: ch.io });
  S.timers.nextScan = Infinity; S.timers.nextNm = Infinity; S.pb.timers.nextLabels = Infinity;
  if (!insider) S.pb.timers.nextDiscover = Infinity;
  return { ch, S, eng, sent, config, now: () => t, adv: (ms) => { t += ms; }, ticks: async (n, ms = 300) => { for (let i = 0; i < n; i++) { await eng.tick({ pbBudget: 8 }); t += ms; } } };
}

test('insider alert (Oct 31 change): a dev crew loading a coin is logged QUIETLY, never sent; the buy card carries the crew + dev history', async () => {
  const B = boot({ alerts: { crew_buy_pct: 10 } });
  await B.ticks(40);
  assert.equal(B.sent.filter(([k]) => k === 'insider_alert').length, 0, 'no loading alert');
  assert.equal(B.S.pb.alerts.quiet.buy, 1, 'but it was detected and counted');
  const card = B.sent.find(([k]) => k === 'buy')?.[1] || '';
  assert.match(card, /dev crew: \d+ linked wallets hold/); assert.match(card, /dev history: /);
  assert.equal(B.eng.pb.crewAlert('buy', { mint: 'zzz', pool: 'p', symbol: 'X', share: 30, wallets: 5 }), false, 'loading never alerts');
});

test('insider alert: a crew dumping a coin she does NOT hold is quiet; a coin she HOLDS alerts once; hourly cap; /alerts off silences', async () => {
  const B = boot({ alerts: { crew_buy_pct: 10, watch_min_pct: 5 } });
  await B.ticks(40);
  assert.equal(B.S.desk.positions.length, 1, 'the test coin was bought (held)');
  assert.equal(Object.keys(B.S.pb.alerts.watch).length, 1);
  for (const k of Object.keys(B.ch.S.bal)) if (k !== A.BV) B.ch.S.bal[k] = Math.floor(B.ch.S.bal[k] * 0.3); // the crew sells 70%
  B.adv(130_000);
  assert.equal(B.eng.pb.alertsDue(), true);
  await B.eng.pb.alertsStep();
  const dump = B.sent.filter(([k, t]) => k === 'insider_alert' && /dumping/.test(t));
  assert.equal(dump.length, 1); assert.match(dump[0][1], /→/); assert.match(dump[0][1], /you HOLD this one/);
  assert.equal(Object.keys(B.S.pb.alerts.watch).length, 0);
  // not held: quiet
  const q0 = B.S.pb.alerts.quiet.dump || 0;
  assert.equal(B.eng.pb.crewAlert('dump', { mint: 'notheld', symbol: 'N', from: 40, to: 20, mins: 3 }), false);
  assert.equal(B.S.pb.alerts.quiet.dump, q0 + 1);
  // hourly cap (held coins)
  B.S.copy.book.positions.push({ mint: 'held1' }, { mint: 'held2' });
  B.config.playbook.alerts.max_per_hour = 2;
  assert.equal(B.eng.pb.crewAlert('dump', { mint: 'held1', symbol: 'H', from: 40, to: 20, mins: 3 }), true);
  assert.equal(B.eng.pb.crewAlert('dump', { mint: 'held2', symbol: 'H', from: 40, to: 20, mins: 3 }), false); // 2 already this hour
  assert.equal(B.S.pb.alerts.suppressed, 1);
  // toggle
  const r = changeSetting(B.config, {}, 'insideralerts', 'off'); assert.equal(r.ok, true);
  B.adv(2 * 3.6e6);
  assert.equal(B.eng.pb.crewAlert('dump', { mint: 'held2', symbol: 'H', from: 40, to: 20, mins: 3 }), false);
  B.S.copy.book.positions.length = 0;
});

test('/alerts on|off and /smart answer from the desk', async () => {
  const B = boot();
  const overrides = {};
  const desk = { snapshot: () => B.eng.snapshot(), set: async (k, v) => changeSetting(B.config, overrides, k, v), pause() {}, resume() {} };
  assert.match(await runCommand('/alerts', desk), /insider alerts: on/);
  assert.match(await runCommand('/alerts off', desk), /off/); assert.equal(B.config.playbook.alerts.enabled, false); assert.equal(overrides.insideralerts, false);
  assert.match(await runCommand('/alerts maybe', desk), /use on or off/);
  B.eng.pb.setSmartList({ list: [{ w: W, winRate: 0.7, closed: 12, pnlSol: 9.4, txPerDay: 35 }], builtAt: '2026-10-31T07:00:00Z' });
  const sm = await runCommand('/smart', desk);
  assert.match(sm, /copy lane/); assert.match(sm, /SmAr…1111 · win 70% of 12 · \+9\.4 SOL/); assert.match(sm, /statistical label/); assert.match(sm, /NOT in the 14-day/);
});

test('copy lane: 2 smart wallets buy a fresh graduate -> safety checks -> PAPER buy in its OWN book (main desk untouched) -> C1 when they sell', async () => {
  const B = boot({ over: { max_cluster_share_pct: 20 }, insider: false });
  const X1 = 'SmArTX1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', X2 = 'SmArTX2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const r = B.eng.pb.setSmartList({ list: [{ w: X1 }, { w: X2 }], builtAt: new Date(B.now()).toISOString(), credits: 0 });
  assert.equal(r.wallets, 2);
  const eqBefore = B.S.desk.cash, closedBefore = B.S.desk.closed.length;
  assert.equal(B.eng.pb.onSmartTx(swap(X1, { mint: A.MINT, pool: A.POOL, at: B.now() - 60_000, sol: -1 })), null);
  const q = B.eng.pb.onSmartTx(swap(X2, { mint: A.MINT, pool: A.POOL, at: B.now(), sol: -2 }));
  assert.ok(q, 'second smart wallet = a copy candidate'); assert.equal(B.S.pb.copyQueue.length, 1);
  await B.ticks(40);
  const cp = B.S.copy.book.positions[0];
  assert.ok(cp, `no copy buy: ${JSON.stringify(B.S.copy.recent[0])}`);
  assert.equal(cp.strategy, 'copy'); assert.match(cp.id, /^C\d{3}$/); assert.deepEqual(cp.copy.wallets.sort(), [X1, X2].sort());
  assert.equal(B.S.desk.positions.length, 0); assert.equal(B.S.desk.cash, eqBefore, 'main desk balance untouched');
  assert.ok(B.sent.find(([k, t]) => k === 'buy' && /copy lane \(own \$100 book/.test(t)));
  // a third push of the same coin does not open a second copy
  assert.equal(B.eng.pb.onSmartTx(swap(X1, { mint: A.MINT, pool: A.POOL, at: B.now(), sol: -1 })), null);
  // both copied wallets sell half+ -> C1 at the next look
  B.eng.pb.onSmartTx(swap(X1, { mint: A.MINT, pool: A.POOL, at: B.now(), sol: 1.4, tokens: -2e9 }));
  await B.ticks(3, 1000);
  assert.equal(B.S.copy.book.positions.length, 0);
  const tr = B.S.copy.book.closed.at(-1);
  assert.equal(tr.code, 'C1'); assert.equal(tr.strategy, 'copy');
  assert.equal(B.S.desk.closed.length, closedBefore, 'the 14-day numbers never see copy trades');
  assert.match(B.S.copyLines().join('\n'), /trades 1/);
});

test('copy lane off: a signal is logged as a skip, nothing is bought; non-list wallets are ignored', async () => {
  const B = boot({ copy: { enabled: false }, insider: false });
  B.eng.pb.setSmartList({ list: [{ w: W }, { w: W2 }] });
  assert.equal(B.eng.pb.onSmartTx(swap(W3, { at: B.now() })), null);
  assert.deepEqual(B.S.copy.buys, {});
  B.eng.pb.onSmartTx(swap(W, { at: B.now() })); B.eng.pb.onSmartTx(swap(W2, { at: B.now() }));
  assert.equal(B.S.pb.copyQueue.length, 0); assert.equal(B.S.copy.skips.OFF, 1);
  await B.ticks(10);
  assert.equal(B.S.copy.book.positions.length, 0);
});

test('worker: webhook route checks the derived auth, admin/smart + smart-hook routes exist, parts persisted', () => {
  const src = fs.readFileSync(new URL('../src/cloudflare/worker.js', import.meta.url), 'utf8');
  assert.match(src, /'\/hook\/smart'/); assert.match(src, /hookToken\(env\.ADMIN_KEY\)/); assert.match(src, /'copy', 'smart'/);
  assert.match(src, /chargeKeyed\(txs\.length\)/); assert.match(src, /hook_budget_day/);
  const tool = fs.readFileSync(new URL('../tools/smart_wallets.mjs', import.meta.url), 'utf8');
  assert.ok(!/sendTransaction|signTransaction|secretKey|privateKey|Keypair/.test(tool + fs.readFileSync(new URL('../src/playbook/smart.js', import.meta.url), 'utf8')), 'reads only');
});
