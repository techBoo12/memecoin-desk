import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guardSignals, guardShouldAlert, guardDump, guardTradeRecord, guardSummary, newGuard, GUARD_DEFAULTS as G0, deskGuardSignals } from '../src/playbook/guard.js';
import { createEngine } from '../src/desk/engine.js';
import { makeChain, A } from './fixtures/fakechain.mjs';

const T = 1_800_000_000_000;
const posWith = (bal, share = 30) => ({ id: 'X001', symbol: 'T', sizeUsd: 2, tokens: 1000, entryAt: new Date(T - 60_000).toISOString(),
  pb: { tokenAccounts: { ta1: 'W1', ta2: 'W2', ta3: 'W3' }, lastBal: { ...bal }, shareHist: [[T - 30_000, share]] } });

test('guard G1: two different linked wallets selling inside 60 s fire; one does not; old sells age out', () => {
  const pos = posWith({ ta1: 100, ta2: 100, ta3: 100 });
  assert.equal(guardSignals(pos, { at: T, bal: { ta1: 90, ta2: 100, ta3: 100 }, clusterShare: 29.9 }, G0).some((s) => s.code === 'G1'), false, 'one seller is not a pattern');
  pos.pb.lastBal = { ta1: 90, ta2: 100, ta3: 100 };
  const s = guardSignals(pos, { at: T + 20_000, bal: { ta1: 90, ta2: 80, ta3: 100 }, clusterShare: 29.5 }, G0);
  const g1 = s.find((x) => x.code === 'G1'); assert.ok(g1); assert.match(g1.evidence, /2 linked wallets sold inside 60s: W1…W1 -10%, W2…W2 -20%/);
  const p2 = posWith({ ta1: 100, ta2: 100 });
  guardSignals(p2, { at: T, bal: { ta1: 90, ta2: 100 } }, G0); p2.pb.lastBal = { ta1: 90, ta2: 100 };
  assert.equal(guardSignals(p2, { at: T + 90_000, bal: { ta1: 90, ta2: 80 } }, G0).some((x) => x.code === 'G1'), false, '90 s apart: not coordinated');
});

test('guard G2 (crew share -2 pts fast), G3 (tokens to brand-new wallets), G5 (pool SOL -15% in 60 s)', () => {
  const pos = posWith({ ta1: 100 }, 30);
  const s = guardSignals(pos, { at: T, bal: { ta1: 100 }, clusterShare: 27.5, solReserve: 100 }, G0, { newWallets: 2 });
  assert.ok(s.find((x) => x.code === 'G2')); assert.ok(s.find((x) => x.code === 'G3' && /2 brand-new/.test(x.evidence)));
  assert.equal(s.some((x) => x.code === 'G5'), false);
  const s2 = guardSignals(pos, { at: T + 30_000, bal: { ta1: 100 }, clusterShare: 30, solReserve: 80 }, G0);
  assert.ok(s2.find((x) => x.code === 'G5' && /-20\.0%/.test(x.evidence)));
  assert.equal(guardSignals(posWith({ ta1: 100 }, 30), { at: T, bal: { ta1: 100 }, clusterShare: 29, solReserve: 100 }, G0).length, 0, '-1 pt, no new wallets, steady pool: quiet');
});

test('guard: alerts once, a NEW kind of signal may re-alert after 10 min, max 3; sold = never again', () => {
  const G = newGuard();
  assert.equal(guardShouldAlert(G, [{ code: 'G1' }], G0, T), true);
  G.alerts = 1; G.lastAlertAt = T; G.codesAlerted = ['G1'];
  assert.equal(guardShouldAlert(G, [{ code: 'G1' }], G0, T + 20 * 60_000), false, 'same signal again: no repeat');
  assert.equal(guardShouldAlert(G, [{ code: 'G2' }], G0, T + 5 * 60_000), false, 'new signal but too soon');
  assert.equal(guardShouldAlert(G, [{ code: 'G2' }], G0, T + 11 * 60_000), true);
  G.decision = 'sold'; assert.equal(guardShouldAlert(G, [{ code: 'G5' }], G0, T + 60 * 60_000), false);
});

test('guard: lead time to the big dump + instant-sell vs actual on the trade, and the report summary', () => {
  const G = newGuard(); G.firstSignalAt = T; G.shareAtSignal = 30; G.priceAtSignal = 1; G.autoSell = { pnlUsd: 0.4 }; G.log = [{ code: 'G1' }, { code: 'G2' }]; G.alerts = 1;
  assert.equal(guardDump(G, { at: T + 10_000, clusterShare: 25, price: 0.9 }, G0), null);
  const d = guardDump(G, { at: T + 45_000, clusterShare: 19, price: 0.8 }, G0);
  assert.equal(d.leadS, 45); assert.match(d.why, /crew share 30\.0% → 19\.0%/);
  const rec = guardTradeRecord(G, { pnlUsd: -0.6 });
  assert.equal(rec.leadTimeS, 45); assert.equal(rec.autoMinusActualUsd, 1); assert.equal(rec.decision, 'no answer (held)'); assert.deepEqual(rec.codes, ['G1', 'G2']);
  const sum = guardSummary([{ guard: rec }, { guard: { ...rec, decision: 'sold', leadTimeS: 15, autoMinusActualUsd: 0 } }, { pnlUsd: 1 }]);
  assert.equal(sum.trades, 2); assert.equal(sum.soldOnTap, 1); assert.equal(sum.autoMinusActualUsd, 1);
  const G2 = newGuard(); G2.firstSignalAt = T; assert.equal(guardDump(G2, { at: T + 5000 }, G0, 'E4').leadS, 5, 'a pack exit firing counts as the dump');
});

test('guard (main desk): pool liquidity -15% inside 2 min is the signal; a slow bleed is not', () => {
  const pos = { id: 'D1' };
  assert.equal(deskGuardSignals(pos, 100000, T, G0).length, 0);
  assert.equal(deskGuardSignals(pos, 95000, T + 10_000, G0).length, 0);
  assert.match(deskGuardSignals(pos, 80000, T + 30_000, G0)[0].evidence, /\$100k → \$80k/);
  const slow = { id: 'D2' };
  for (let i = 0; i < 10; i++) assert.equal(deskGuardSignals(slow, 100000 * (1 - 0.02 * i), T + i * 60_000, G0).length, 0);
});

test('guard in the lane: crew wallets start selling (under the 20% E4 line) -> ONE alert with [Sell now] [Hold], NO auto-sell; Sell now sells at that moment and records it', async () => {
  const ch = makeChain();
  let t = ch.MIGRATED + 2 * 60_000;
  const S = {}, sent = [];
  const c = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
  c.playbook = { ...c.playbook, discover_every_s: 9999, dev_history: { ...c.playbook.dev_history, enabled: false } };
  c.loop.scanEverySec = 1e9;
  const eng = createEngine({ config: c, S, log: { event() {}, warn() {}, info() {} }, notify: (k, txt, o) => sent.push([k, txt, o]), now: () => t, pbIo: ch.io });
  S.timers.nextScan = Infinity; S.timers.nextNm = Infinity; S.pb.timers.nextLabels = Infinity;
  for (let i = 0; i < 40 && !S.desk.positions.length; i++) { await eng.tick({ pbBudget: 8 }); t += 300; }
  const pos = S.desk.positions[0]; assert.ok(pos, 'bought');
  // two crew wallets (not the deployer) each sell 10% of their bag
  const crewTas = Object.entries(pos.pb.tokenAccounts).filter(([, o]) => o !== pos.pb.deployer).map(([ta]) => ta).filter((ta) => ch.S.bal[ta] > 0).slice(0, 2);
  assert.equal(crewTas.length, 2);
  for (const ta of crewTas) ch.S.bal[ta] = Math.floor(ch.S.bal[ta] * 0.9);
  t += 1000; await eng.tick({});
  const al = sent.filter(([k]) => k === 'guard');
  assert.equal(al.length, 1, 'one guard alert');
  assert.match(al[0][1], /EARLY EXIT WARNING/); assert.match(al[0][1], /G1 2 linked wallets sold/); assert.match(al[0][1], /no answer = hold/);
  assert.deepEqual(al[0][2].kb[0].map((b) => b.callback_data), [`gs:${pos.id}`, `gh:${pos.id}`]);
  assert.equal(S.desk.positions.length, 1, 'the guard did NOT sell by itself');
  t += 1000; await eng.tick({});
  assert.equal(sent.filter(([k]) => k === 'guard').length, 1, 'no repeat');
  // she taps Hold, then Sell now
  assert.equal(eng.pb.guardHold(pos.id).ok, true); assert.equal(pos.guard.decision, 'hold');
  const r = await eng.pb.guardSell(pos.id);
  assert.equal(r.ok, true); assert.equal(S.desk.positions.length, 0);
  assert.equal(r.trade.code, 'G0'); assert.equal(r.trade.guard.decision, 'sold'); assert.ok(r.trade.guard.autoSellPnlUsd != null); assert.ok(r.trade.guard.codes.includes('G1'));
  assert.equal(r.trade.strategy, 'insider', 'counts in the 14-day book like any insider trade');
  assert.match(S.pbLines().join('\n'), /early-exit guard: 1 trades warned · you sold on 1/);
});
