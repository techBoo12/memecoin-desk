// node --test test/*.test.js   (no network) · day 5: the training pack (section 9) insider-exit lane
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCluster, clusterShare, top10Share, effectiveFunder } from '../src/playbook/cluster.js';
import { rugChecks, riskChecks, execChecks, secondOpinion, manipulationChecks, niche, decide, trapExtensions } from '../src/playbook/rules.js';
import { firstTrigger } from '../src/playbook/exits.js';
import { newLabelBook, trackToken, dueMints, applySample, labelSummary, evaluate } from '../src/playbook/labels.js';
import { sizeInsider, kellyCapPct, cpImpactPct, paperCostUsd, estimateFeeSol } from '../src/playbook/fees.js';
import { signalText, RISK_LINE } from '../src/playbook/signals.js';
import { decodePumpSwapPool, b58encode, funderFromFirstTx, directTransfers, tokenDeltas } from '../src/playbook/solana.js';
import { newBuild, stepBuild } from '../src/playbook/gather.js';
import { createEngine } from '../src/desk/engine.js';
import { makeChain, A, ta } from './fixtures/fakechain.mjs';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url))).playbook;
const cfg = (o = {}) => ({ ...CFG, ...o });

// ---------------------------------------------------------------- config 9.3
test('config 9.3: every pack key is present with the pack value, labelled as a starting guess', () => {
  const want = { max_minutes_since_migration: 10, early_buyer_slots: 3, funding_trace_hops: 2, fresh_wallet_max_age_min: 60, max_cluster_share_pct: 20, max_top10_pct: 30,
    min_liquidity_usd: 15000, min_lp_burned_or_locked_pct: 95, max_sim_roundtrip_loss_pct: 15, cluster_sell_trigger_pct: 20, cluster_drop_pct: 15, cluster_drop_window_s: 60,
    trailing_stop_pct: 25, max_hold_minutes: 60, max_position_pct: 2, max_pool_impact_pct: 1, max_open_positions: 3, max_daily_loss_pct: 6, max_slippage_bps: 300,
    max_exit_slippage_bps: 1500, max_priority_fee: 0.002, max_latency_ms: 1500 };
  for (const [k, v] of Object.entries(want)) assert.equal(CFG[k], v, k);
  assert.deepEqual(CFG.tp_ladder, [{ at_x: 2, sell_pct: 30 }, { at_x: 3, sell_pct: 30 }]);
  assert.equal(CFG.mode, 'paper');
  assert.match(CFG._note, /STARTING GUESSES: TUNE VIA PAPER TRADING/);
});

// ---------------------------------------------------------------- cluster (step b)
const T0 = Date.parse('2026-10-31T04:00:00Z');
const base = () => ({
  deployer: 'DEP', creation: { slot: 100, at: T0, bundleId: 'BUN' },
  earlyBuyers: [], wallets: { DEP: { funder: 'FD' } }, deployerLinks: [],
});
const eb = (wallet, slot = 102, bundleId = null) => ({ wallet, slot, bundleId });

test('cluster rule 1: early buyer funded by the deployer, the deployer funder, or a cluster funder (2 hops)', () => {
  const i = base();
  i.earlyBuyers = [eb('A'), eb('B'), eb('C'), eb('Z')];
  i.wallets.A = { funder: 'DEP' }; i.wallets.B = { funder: 'FD' }; i.wallets.C = { funder: 'MID' }; i.wallets.MID = { funder: 'DEP' }; i.wallets.Z = { funder: 'STRANGER' };
  const C = buildCluster(i, cfg());
  assert.ok(C.members.has('A') && C.members.has('B'));
  assert.ok(C.members.has('C'), 'hop 2: C <- MID <- DEP');
  assert.ok(!C.members.has('Z'));
  assert.ok(!buildCluster(i, cfg({ funding_trace_hops: 1 })).members.has('C'), 'hop 1 only: C is not linked');
});

test('cluster rule 2: same slot as creation or same Jito bundle', () => {
  const i = base();
  i.earlyBuyers = [eb('S', 100), eb('J', 101, 'BUN'), eb('L', 103, 'OTHER')];
  const C = buildCluster(i, cfg());
  assert.ok(C.members.has('S') && C.members.has('J') && !C.members.has('L'));
});

test('cluster rule 3: direct transfer with the deployer (exchanges/hubs never link)', () => {
  const i = base(); i.deployerLinks = ['L1', 'BINANCE', 'HUB']; i.wallets.HUB = { hub: true };
  const C = buildCluster(i, cfg({ exchange_wallets: ['BINANCE'] }), new Set(['BINANCE']));
  assert.ok(C.members.has('L1')); assert.ok(!C.members.has('BINANCE')); assert.ok(!C.members.has('HUB'));
});

test('cluster rule 4: fresh early buyer (< fresh_wallet_max_age_min before creation)', () => {
  const i = base(); i.earlyBuyers = [eb('NEWW'), eb('OLDW'), eb('UNK')];
  i.wallets.NEWW = { firstTxAt: T0 - 59 * 60_000 }; i.wallets.OLDW = { firstTxAt: T0 - 61 * 60_000 }; i.wallets.UNK = { old: true, firstTxAt: null };
  const C = buildCluster(i, cfg());
  assert.ok(C.members.has('NEWW')); assert.ok(!C.members.has('OLDW')); assert.ok(!C.members.has('UNK'), 'age unknown is not "fresh"');
});

test('cluster rule 5: 3+ early buyers sharing one funder; 2 is not enough', () => {
  const i = base(); i.earlyBuyers = [eb('A'), eb('B'), eb('C'), eb('D'), eb('E')];
  for (const w of ['A', 'B', 'C']) i.wallets[w] = { funder: 'F3' };
  for (const w of ['D', 'E']) i.wallets[w] = { funder: 'F2' };
  const C = buildCluster(i, cfg());
  assert.ok(['A', 'B', 'C'].every((w) => C.members.has(w))); assert.ok(!C.members.has('D') && !C.members.has('E'));
});

test('cluster: (1)-(3) run once more with the new members, then stop', () => {
  const i = base();
  // S joins by rule 2 (creation slot); S's funder FS also funded T -> T joins in the 2nd pass (rule 1 via "funder of a wallet already in C")
  i.earlyBuyers = [eb('S', 100), eb('T', 103)];
  i.wallets.S = { funder: 'FS' }; i.wallets.T = { funder: 'FS' };
  const C = buildCluster(i, cfg());
  assert.ok(C.members.has('T'));
  // a 3rd-generation link (U funded by T's other funder chain) needs a 3rd pass: not done
  const j = base(); j.earlyBuyers = [eb('S', 100), eb('T', 103), eb('U', 103)];
  j.wallets.S = { funder: 'FS' }; j.wallets.T = { funder: 'X1' }; j.wallets.X1 = { funder: 'FS' }; j.wallets.U = { funder: 'Y1' }; j.wallets.Y1 = { funder: 'X1' };
  const C2 = buildCluster(j, cfg({ funding_trace_hops: 2 }));
  assert.ok(C2.members.has('T'));
});

test('cluster 9.1 E: exchange-funded buyers link only on near-equal (5%) withdrawals within 10 min', () => {
  const i = base(); i.earlyBuyers = [eb('P'), eb('Q'), eb('R'), eb('W')];
  i.wallets.P = { funder: 'EX', funderLamports: 1_000_000_000, funderAt: T0 - 600_000 };
  i.wallets.Q = { funder: 'EX', funderLamports: 1_030_000_000, funderAt: T0 - 400_000 };
  i.wallets.R = { funder: 'EX', funderLamports: 1_020_000_000, funderAt: T0 - 300_000 };
  i.wallets.W = { funder: 'EX', funderLamports: 5_000_000_000, funderAt: T0 - 300_000 };
  const ex = new Set(['EX']);
  assert.equal(effectiveFunder('W', i, cfg(), (a) => ex.has(a)), null, 'different size: stranger');
  const C = buildCluster(i, cfg(), ex);
  assert.ok(['P', 'Q', 'R'].every((w) => C.members.has(w)), 'a near-equal batch of 3 = a shared funder');
  assert.ok(!C.members.has('W'));
});

test('measure (step c): cluster share + top10 exclude the pool and burn addresses', () => {
  const m = new Set(['DEP', 'A']);
  assert.equal(clusterShare({ DEP: 100, A: 50, POOL: 500, Z: 10 }, m, 1000, new Set(['POOL'])), 15);
  const h = [{ owner: 'POOL', amount: 500 }, { owner: 'BURN', amount: 100 }, ...Array.from({ length: 12 }, (_, k) => ({ owner: `w${k}`, amount: 10 }))];
  assert.equal(top10Share(h, 1000, new Set(['POOL', 'BURN'])), 10);
});

// ---------------------------------------------------------------- entry filters
const goodRes = () => ({ mintInfo: { mintAuthority: null, freezeAuthority: null, extensions: [{ name: 'metadataPointer' }] }, lpBurnedPct: 100, top10Pct: 18, clusterPct: 12, cluster: { size: 6 }, reserves: { sol: 100, token: 7e8 } });
const statusOf = (checks, code) => checks.find((c) => c.code === code).status;
test('R1-R7: a clean graduate passes every rug check', () => {
  const r = rugChecks({ res: goodRes(), sim: { ok: true, roundTripLossPct: 3 }, solUsd: 200 }, cfg());
  assert.deepEqual(r.map((c) => c.code), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
  assert.ok(r.every((c) => c.status === 'pass'), JSON.stringify(r));
});
test('R1 mint authority live = fail', () => { const x = goodRes(); x.mintInfo.mintAuthority = 'M'; assert.equal(statusOf(rugChecks({ res: x, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R1'), 'fail'); });
test('R2 freeze authority or any Token-2022 trap = fail', () => {
  const x = goodRes(); x.mintInfo.freezeAuthority = 'F';
  assert.equal(statusOf(rugChecks({ res: x, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R2'), 'fail');
  for (const e of ['transferFeeConfig', 'transferHook', 'permanentDelegate', 'nonTransferable', 'pausableConfig']) {
    const y = goodRes(); y.mintInfo.extensions.push({ name: e });
    assert.equal(statusOf(rugChecks({ res: y, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R2'), 'fail', e);
  }
  assert.deepEqual(trapExtensions([{ name: 'defaultAccountState', state: { accountState: 'frozen' } }]), ['default-frozen accounts']);
  assert.deepEqual(trapExtensions([{ name: 'metadataPointer' }, { name: 'tokenMetadata' }]), [], "pump.fun's own Token-2022 extensions are fine");
});
test('R3 LP: burned on-chain, or locked per rugcheck; else fail', () => {
  const x = goodRes(); x.lpBurnedPct = 40;
  assert.equal(statusOf(rugChecks({ res: x, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R3'), 'fail');
  assert.equal(statusOf(rugChecks({ res: x, lp2: 99, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R3'), 'pass');
  x.lpBurnedPct = null; assert.equal(statusOf(rugChecks({ res: x, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R3'), 'unknown');
});
test('R4 top10 > 30% = fail · R5 cluster > 20% = fail · R6 liquidity < $15k = fail', () => {
  const x = goodRes(); x.top10Pct = 31; x.clusterPct = 21; x.reserves.sol = 30;
  const r = rugChecks({ res: x, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg());
  assert.equal(statusOf(r, 'R4'), 'fail'); assert.equal(statusOf(r, 'R5'), 'fail'); assert.equal(statusOf(r, 'R6'), 'fail');
  x.clusterPct = null; assert.equal(statusOf(rugChecks({ res: x, sim: { ok: true, roundTripLossPct: 1 }, solUsd: 200 }, cfg()), 'R5'), 'unknown');
});
test('R7 sell simulation: no sell route, loss > 15%, or unknown all block', () => {
  for (const [sim, want] of [[{ ok: false, reason: 'no sell route' }, 'fail'], [{ ok: true, roundTripLossPct: 16 }, 'fail'], [{ unknown: true, reason: 'busy' }, 'unknown'], [{ ok: true, roundTripLossPct: 14.9 }, 'pass']]) {
    assert.equal(statusOf(rugChecks({ res: goodRes(), sim, solUsd: 200 }, cfg()), 'R7'), want);
  }
});
test('R11 entry slippage cap and R13 fee cap', () => {
  const [a, b] = execChecks({ impactBps: 301, feeSol: 0.0021 }, cfg());
  assert.equal(a.status, 'fail'); assert.equal(b.status, 'fail');
  const ok = execChecks({ impactBps: 300, feeSol: 0.002 }, cfg()); assert.ok(ok.every((c) => c.status === 'pass'));
});
test('R14 niche: a non-graduate / too-old migration is skipped', () => {
  assert.equal(niche({ fail: { code: 'R14', note: 'migrated 12 min ago (> 10)' } }).status, 'fail');
  assert.equal(niche({ minutesSinceMigration: 3 }).status, 'pass');
});
test('R15 kill switch and R16 max open / never two in one token', () => {
  assert.equal(decide(riskChecks({ killSwitch: 'day loss', openInsider: 0 }, cfg())).failed.code, 'R15');
  assert.equal(decide(riskChecks({ killSwitch: null, openInsider: 3 }, cfg())).failed.code, 'R16');
  assert.equal(decide(riskChecks({ killSwitch: null, openInsider: 0, holdingMint: true }, cfg())).failed.code, 'R16');
  assert.ok(decide(riskChecks({ killSwitch: null, openInsider: 2 }, cfg())).ok);
});
test('second opinion (GoPlus/RugCheck) blocks on hard flags only; manipulation: copycat + known rugger', () => {
  assert.equal(secondOpinion({ goplus: { closable: { status: '1' } } }).check.status, 'fail');
  assert.equal(secondOpinion({ rugcheck: { risks: [{ name: 'Freeze Authority still enabled', level: 'danger' }] } }).check.status, 'fail');
  const soft = secondOpinion({ rugcheck: { risks: [{ name: 'Low amount of LP Providers', level: 'warn' }] } });
  assert.equal(soft.check.status, 'pass'); assert.equal(soft.warn.length, 1);
  assert.equal(secondOpinion({}).check.status, 'pass', 'second opinion down never blocks: our own on-chain checks are primary');
  const now = Date.now();
  const m = manipulationChecks({ symbol: 'PEPE', recentSymbols: { pepe: now - 5 * 60_000 }, deployer: 'D', rugDeployers: new Set(['D']), now }, cfg());
  assert.equal(m.find((x) => x.code === 'M1').status, 'fail'); assert.equal(m.find((x) => x.code === 'M5').status, 'fail');
  assert.ok(decide(manipulationChecks({ symbol: 'NEW', deployer: 'X', earlyWash: 2, now }, cfg())).ok, 'wash is a warning, not a block');
});

// ---------------------------------------------------------------- exits E1-E8
const pos = (o = {}) => ({ entryPrice: 1, peakPrice: 1, entryAt: new Date(T0).toISOString(), pb: { entry: { lpSupply: '1000', deployerBal: 100, clusterBal: 1000, clusterShare: 10 }, shareHist: [], tpDone: [] }, ...o });
const obs = (o = {}) => ({ at: T0 + 60_000, price: 1.1, lpSupply: '1000', mintAuthority: null, freezeAuthority: null, deployerBal: 100, clusterBal: 1000, clusterShare: 10, ...o });
test('E1 kill switch: day loss >= 6% sells all (and beats everything else)', () => {
  const t = firstTrigger(pos(), obs({ mintAuthority: 'X' }), cfg(), { dayLossPct: 6 });
  assert.equal(t.code, 'E1'); assert.equal(t.action, 'SELL_ALL');
});
test('E2 liquidity withdrawn, pool gone, or an authority set again', () => {
  assert.equal(firstTrigger(pos(), obs({ lpSupply: '999' }), cfg()).code, 'E2');
  assert.equal(firstTrigger(pos(), obs({ poolGone: true }), cfg()).code, 'E2');
  assert.equal(firstTrigger(pos(), obs({ mintAuthority: 'M' }), cfg()).code, 'E2');
  assert.equal(firstTrigger(pos(), obs({ freezeAuthority: 'F' }), cfg()).code, 'E2');
});
test('E3 the deployer sells or moves ANY of its tokens', () => { assert.equal(firstTrigger(pos(), obs({ deployerBal: 99 }), cfg()).code, 'E3'); });
test('E4 cluster sold >= 20% of entry holdings; under it = HOLD + warning', () => {
  assert.equal(firstTrigger(pos(), obs({ clusterBal: 800 }), cfg()).code, 'E4');
  const h = firstTrigger(pos(), obs({ clusterBal: 900, clusterShare: 9.5 }), cfg());
  assert.equal(h.action, 'HOLD'); assert.match(h.warn, /cluster sold 10.0%/);
});
test('E5 cluster share down >= 15% (relative) inside 60 s', () => {
  const p = pos(); p.pb.shareHist = [[T0 + 10_000, 10], [T0 + 30_000, 9.5]];
  assert.equal(firstTrigger(p, obs({ clusterShare: 8.4, clusterBal: 990 }), cfg()).code, 'E5');
  const old = pos(); old.pb.shareHist = [[T0 - 120_000, 10]]; // outside the window
  assert.equal(firstTrigger(old, obs({ clusterShare: 8.4, clusterBal: 990 }), cfg()).action, 'HOLD');
});
test('E6 trailing stop 25% below the peak (from entry, so it is also the stop-loss)', () => {
  assert.equal(firstTrigger(pos({ peakPrice: 2 }), obs({ price: 1.5 }), cfg()).code, 'E6');
  assert.equal(firstTrigger(pos(), obs({ price: 0.75 }), cfg()).code, 'E6', 'fresh entry: -25% stops out');
  assert.equal(firstTrigger(pos({ peakPrice: 2 }), obs({ price: 1.51 }), cfg()).action, 'HOLD');
});
test('E7 take-profit ladder: 30% of the ORIGINAL size at 2x, again at 3x, each rung once', () => {
  const p = pos({ peakPrice: 2 });
  const t = firstTrigger(p, obs({ price: 2 }), cfg());
  assert.deepEqual([t.code, t.action, t.fraction, t.ofOriginal, t.rung], ['E7', 'SELL_PART', 0.3, true, 0]);
  p.pb.tpDone = [0];
  assert.equal(firstTrigger(p, obs({ price: 2.5 }), cfg()).action, 'HOLD');
  assert.equal(firstTrigger({ ...p, peakPrice: 3 }, obs({ price: 3 }), cfg()).rung, 1);
});
test('E8 max hold 60 minutes', () => { assert.equal(firstTrigger(pos(), obs({ at: T0 + 60 * 60_000 }), cfg()).code, 'E8'); });
test('priority order: E2 beats E6, E3 beats E4, E4 beats E7', () => {
  assert.equal(firstTrigger(pos({ peakPrice: 2 }), obs({ price: 1, lpSupply: '1' }), cfg()).code, 'E2');
  assert.equal(firstTrigger(pos(), obs({ deployerBal: 0, clusterBal: 0 }), cfg()).code, 'E3');
  assert.equal(firstTrigger(pos({ peakPrice: 2 }), obs({ price: 2, clusterBal: 700 }), cfg()).code, 'E4');
});

// ---------------------------------------------------------------- labels (step h) + 9.4
test('labels: RUG (liquidity gone / -90% from 1h peak), PUMP (2x), DIED (24h <= 50%), FLAT', () => {
  const book = newLabelBook();
  const mk = (mint) => trackToken(book, { mint, symbol: mint, t0: T0, price0: 1, liq0: 20000, decision: 'skipped', reason: 'R5' });
  const rug = mk('rug'); applySample(rug, { k: 15, price: 1.5, liq: 20000 }); applySample(rug, { k: 30, price: 0.1, liq: 15000 }); applySample(rug, { k: 60, price: 0.1, liq: 15000 });
  assert.equal(rug.label1h, 'RUG');
  const pull = mk('pull'); applySample(pull, { k: 5, price: 1, liq: 1000 }); applySample(pull, { k: 60, price: 1, liq: 1000 }); assert.equal(pull.label1h, 'RUG');
  const pump = mk('pump'); applySample(pump, { k: 30, price: 2.1, liq: 30000 }); applySample(pump, { k: 60, price: 1.2, liq: 30000 }); applySample(pump, { k: 1440, price: 0.2, liq: 30000 });
  assert.equal(pump.label, 'PUMP', 'pump wins over a later death (pack order: RUG, else PUMP, else DIED)');
  const died = mk('died'); applySample(died, { k: 60, price: 0.9, liq: 20000 }); applySample(died, { k: 1440, price: 0.5, liq: 9000 }); assert.equal(died.label, 'DIED');
  const flat = mk('flat'); applySample(flat, { k: 60, price: 1.1, liq: 20000 }); applySample(flat, { k: 1440, price: 0.8, liq: 20000 }); assert.equal(flat.label, 'FLAT');
  const s = labelSummary(book); assert.equal(s.skipped.RUG, 2); assert.equal(s.filterValuePct, 40);
  const fresh = trackToken(book, { mint: 'n', t0: T0, price0: 1, liq0: 1, decision: 'traded' });
  assert.deepEqual(dueMints(book, T0 + 16 * 60_000).filter((d) => d.mint === 'n').map((d) => d.k), [5]);
  assert.ok(fresh);
});
test('9.4 metrics + go/no-go: too few trades = NO-GO with the reasons', () => {
  const trades = [{ mint: 'a', pnlUsd: 1, pnlPct: 50, exitPrice: 1.5, peakPrice: 1.6 }, { mint: 'b', pnlUsd: -0.2, pnlPct: -10, exitPrice: 0.9, peakPrice: 1 }];
  const book = newLabelBook(); const it = trackToken(book, { mint: 'b', t0: T0, price0: 1, liq0: 1, decision: 'traded' }); it.label = 'RUG'; it.peak1h = 1;
  const m = evaluate({ trades, curve: [{ eq: 100 }, { eq: 110 }, { eq: 99 }], book, latenciesMs: [800, 1200, 3000] }, cfg());
  assert.equal(m.winRatePct, 50); assert.equal(m.avgPnlPct, 20); assert.equal(m.avgPnlPctWithoutBest, -10); assert.equal(m.maxDrawdownPct, 10);
  assert.equal(m.rugExitRatePct, 100); assert.equal(m.latencyMedianMs, 1200);
  assert.equal(m.go, false); assert.equal(m.goNoGo[0].pass, false);
});

// ---------------------------------------------------------------- sizing, fees, R18
test('step e sizing: smallest of 2% equity and 1% of the pool SOL reserve; Kelly only after 30 trades', () => {
  assert.equal(sizeInsider({ equity: 100, cash: 100, poolSol: 100, solUsd: 200 }, cfg()).limit, 'max_position_pct');
  const thin = sizeInsider({ equity: 100000, cash: 100000, poolSol: 50, solUsd: 200 }, cfg());
  assert.equal(thin.sizeUsd, 100); assert.equal(thin.limit, 'max_pool_impact_pct');
  assert.equal(kellyCapPct([{ pnlUsd: 1, pnlPct: 10 }], cfg()), null);
  const many = Array.from({ length: 40 }, (_, i) => (i % 2 ? { pnlUsd: 1, pnlPct: 40 } : { pnlUsd: -1, pnlPct: -20 }));
  assert.ok(Math.abs(kellyCapPct(many, cfg()) - 6.25) < 1e-9, 'W .5, R 2 -> f* .25, quarter Kelly = 6.25%');
  assert.ok(Math.abs(cpImpactPct(1, 99) - 1) < 1e-9);
  assert.equal(paperCostUsd({ sizeUsd: 100, feeSol: 0.001, solUsd: 200 }, cfg()), 0.2 + 0.5);
});
test('R13 fee estimate: pool priority fees (p75) x CU + base fee + Jito tip floor', async () => {
  const io = { rpc: async () => [{ prioritizationFee: 0 }, { prioritizationFee: 100_000 }, { prioritizationFee: 200_000 }], jitoTipFloor: async () => 0.0001 };
  const f = await estimateFeeSol(io, 'POOL', cfg());
  assert.ok(Math.abs(f.feeSol - (200_000 * 150_000 / 1e15 + 5e-6 + 0.0001)) < 1e-12);
});
test('R18 alert has every field and the fixed risk line', () => {
  const t = signalText({ type: 'EXIT', alertId: 'A0002', entryAlertId: 'A0001', at: T0, slot: 1, name: 'Test', symbol: 'TST', mint: 'M', pool: 'P', dex: 'pumpswap', priceSol: 1e-6, priceUsd: 2e-4, mcapUsd: 200000, liqUsd: 40000,
    minSinceMigration: 7, filters: { mint: 'pass', freeze: 'pass', lp: 'pass 100%', top10: 'pass', cluster: 'pass 12%', sim: 'pass' }, clusterWallets: 6, clusterShare: 12, clusterChange5m: -1.5, code: 'E4', multiple: 1.3 });
  for (const s of ['A0002', 'entry A0001', 'slot 1', '$TST', 'mint M', 'pool P', 'SOL', 'mcap', 'liq', 'min since migration', 'mint pass', 'freeze', 'LP', 'top10', 'cluster pass 12%', 'sell sim', '6 wallets', '5m change -1.50', 'trigger E4', '1.30x']) assert.ok(t.includes(s), s);
  assert.ok(t.endsWith(RISK_LINE));
});

// ---------------------------------------------------------------- chain parsing + gather on a scripted chain
test('pool decode + parsed-tx helpers', () => {
  const { S } = makeChain(); assert.ok(S);
  const ch = makeChain();
  return ch.io.rpc('getAccountInfo', [A.POOL]).then((a) => {
    const p = decodePumpSwapPool(a.value.data[0]);
    assert.equal(p.baseMint, A.MINT); assert.equal(p.coinCreator, A.DEP); assert.equal(p.lpMint, A.LP); assert.equal(p.lpSupply, '4000000000000');
    assert.equal(b58encode(new Uint8Array([0, 0, 1])), '112');
  });
});

test('gather: the scripted launch maps to the right cluster (and not the old wallet)', async () => {
  const ch = makeChain();
  const b = newBuild({ mint: A.MINT, pool: A.POOL, symbol: 'TEST', t0: ch.MIGRATED + 2 * 60_000 });
  for (let i = 0; i < 40 && !['done', 'fail'].includes(b.stage); i++) await stepBuild(b, ch.io, cfg(), 8);
  assert.equal(b.stage, 'done', JSON.stringify(b.fail || b.lastError));
  const C = b.result.cluster.members;
  for (const w of ['DEP', 'B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'L1']) assert.ok(C.has(A[w]), `${w} in cluster`);
  assert.ok(!C.has(A.B6), 'B6: old unrelated wallet');
  assert.ok(!C.has(A.CURVE), 'the bonding curve is not a buyer');
  assert.ok(!C.has('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), 'a Jito tip is not a link');
  assert.ok(Math.abs(b.result.clusterPct - 16) < 1e-9, `cluster share ${b.result.clusterPct}`);
  assert.ok(Math.abs(b.result.top10Pct - 18) < 1e-9, `top10 ${b.result.top10Pct}`);
  assert.equal(b.result.lpBurnedPct, 100);
  assert.ok(b.minutesSinceMigration <= 10);
});

test('gather: a migration older than 10 min is outside the niche (R14)', async () => {
  const ch = makeChain();
  const b = newBuild({ mint: A.MINT, pool: A.POOL, t0: ch.MIGRATED + 11 * 60_000 });
  for (let i = 0; i < 5 && b.stage !== 'fail'; i++) await stepBuild(b, ch.io, cfg(), 8);
  assert.equal(b.fail.code, 'R14');
});

// ---------------------------------------------------------------- the lane inside the engine, end to end (fake chain)
function deskConfig(over = {}) {
  const c = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
  c.playbook = { ...c.playbook, discover_every_s: 9999, ...over };
  c.loop.scanEverySec = 1e9; // keep desk A's scout out of this test
  return c;
}
async function runLane(over, untilBuy = true) {
  const ch = makeChain();
  let t = ch.MIGRATED + 2 * 60_000;
  const S = {}; const sent = [];
  const eng = createEngine({ config: deskConfig(over), S, log: { event() {}, warn() {}, info() {} }, notify: (k, txt) => sent.push([k, txt]), now: () => t, pbIo: ch.io });
  S.timers.nextScan = Infinity; S.timers.nextNm = Infinity;
  S.pb.timers.nextLabels = Infinity;
  for (let i = 0; i < 40 && !(untilBuy && S.desk.positions.length) && !(S.pb.stats.skipped); i++) { await eng.tick({ pbBudget: 8 }); t += 300; }
  return { ch, S, eng, sent, tick: async (ms = 1000) => { t += ms; return eng.tick({}); }, setT: (x) => { t = x; } };
}

test('lane: detects, traces, passes R1-R16, paper-buys with an R18 ENTRY alert', async () => {
  const { S, sent } = await runLane({ max_cluster_share_pct: 20 });
  const p = S.desk.positions[0];
  assert.ok(p, `no buy: ${JSON.stringify(S.pb.recent[0])}`);
  assert.equal(p.strategy, 'insider'); assert.ok(p.sizeUsd > 1.9 && p.sizeUsd < 2.1, `size ${p.sizeUsd}`);
  const card = sent.find(([k]) => k === 'buy')[1];
  assert.match(card.split('\n')[0], /PAPER BUY · insider lane \(counts in your 14-day test\)/);
  assert.match(card, /dev crew: \d+ linked wallets hold \d+\.\d%/); assert.match(card, /dev history: /); assert.match(card, /rules passed: R1/); assert.match(card, /why: fresh pump\.fun graduate/);
  assert.match(card, /dexscreener\.com\/solana\//);
  assert.ok(card.split('\n').some((l) => l.startsWith('ENTRY · A0001')), 'the R18 entry record rides under the card');
  assert.ok(Object.values(S.labels.items)[0].d === 'traded');
});

test('lane: R5 skips the same coin when its cluster holds more than the cap, and labels it', async () => {
  const { S } = await runLane({ max_cluster_share_pct: 15 });
  assert.equal(S.desk.positions.length, 0);
  assert.equal(S.pb.skips.R5, 1);
  assert.equal(Object.values(S.labels.items)[0].why, 'R5');
});

test('lane monitor: a cluster wallet moving tokens to a NEW wallet is followed (not a sell); the deployer selling fires E3', async () => {
  const L = await runLane({});
  const { ch, S } = L;
  assert.equal(S.desk.positions.length, 1);
  ch.S.split(2e13);
  await L.tick(1000);
  const p = S.desk.positions[0];
  assert.ok(p, 'still holding after a transfer inside the cluster');
  assert.ok(p.pb.members.includes(A.NEW), 'the recipient joined the cluster');
  ch.S.bal[ta(A.DEP)] -= 1e12; // the dev sells 2% of its bag
  await L.tick(1000);
  assert.equal(S.desk.positions.length, 0);
  const tr = S.desk.closed.at(-1);
  assert.equal(tr.code, 'E3'); assert.equal(tr.strategy, 'insider');
});

test('lane monitor: LP withdrawn fires E2; the desk stats keep insider trades apart', async () => {
  const L = await runLane({});
  L.ch.S.lpSupply = 3_000_000_000_000n;
  await L.tick(1000);
  assert.equal(L.S.desk.closed.at(-1).code, 'E2');
  const { stats } = await import('../src/desk/head.js');
  assert.equal(stats(L.S.desk).trades, 0); assert.equal(stats(L.S.desk, 'insider').trades, 1);
});

test('lane monitor: kill switch E1 sells everything when the day loss hits 6%', async () => {
  const L = await runLane({});
  L.S.desk.dayStartEquity = L.S.desk.cash + L.S.desk.positions[0].markUsd + 10; // pretend we're already down ~9% today
  await L.tick(1000);
  assert.equal(L.S.desk.positions.length, 0);
  assert.equal(L.S.desk.closed.at(-1).code, 'E1');
  assert.ok(L.S.pb.killSwitch);
});

test('security (pack section 6 red flags): no dependencies, no install scripts, no key material', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[k], undefined, k);
  const src = fs.readdirSync(new URL('../src/playbook/', import.meta.url)).map((f) => fs.readFileSync(new URL(`../src/playbook/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/sendTransaction|signTransaction|secretKey|privateKey|seed phrase|Keypair/i.test(src), 'the lane reads only: no signing, no sending');
});

test('isOnCurve: wallets are on the curve, program-derived accounts (pools) are not', async () => {
  const { isOnCurve } = await import('../src/playbook/solana.js');
  assert.equal(isOnCurve('Emg2vmFgSg5QQATQkrpKqXCt8cJK28vudZUPTrMsYHom'), true);   // a wallet seen on Oct 31
  assert.equal(isOnCurve('DBqR1iNBa4fzjXMoCyt4XfEvXLySEdv6VAHNLV3pdXPj'), false);  // a PumpSwap pool (PDA)
});
