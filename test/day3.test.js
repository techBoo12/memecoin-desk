// node --test test/*.test.js   (no network) · day 3: quality gate, near misses, fast exits
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityGate } from '../src/desk/quality.js';
import { newNearMissBook, recordNearMiss, outcome, summarize, dueChecks } from '../src/desk/nearmiss.js';
import { liquidityAlarm } from '../src/desk/watcher.js';
import { manage } from '../src/desk/risk.js';

const config = {
  quality: { requireNoUnknowns: true, minBuyShare1h: 0.55, minBuyShare5m: 0.52, minTxns5m: 15, requireUp5m: true, requireUp1h: true,
    requireHoldersRising: true, minHolderLookGapSec: 90, minLiqToMcap: 0.08, maxPump6hPct: 250, maxTradesPerDay: 4 },
  risk: { stopLossPct: 6, trailActivatePct: 12, trailDistancePct: 8, takeProfitLadder: [] },
  exits: { liqDropExitPct: 40, minLiqExitUsd: 15000 },
};
const coin = (o = {}) => ({ mint: 'M1', symbol: 'GOOD', priceUsd: 1, liqUsd: 100_000, mcap: 800_000,
  txns: { h1: { buys: 700, sells: 300 }, m5: { buys: 30, sells: 10 } }, change: { m5: 2, h1: 15, h6: 40 }, ...o });

test('quality gate: a clean coin passes all 9 checks', () => {
  const q = qualityGate(coin(), { unknowns: [] }, { holderGrowthPerHourPct: 5, holders: 3000, liqMcap: 0.125 }, config);
  assert.equal(q.ok, true); assert.equal(q.passedCount, 9);
});

test('quality gate: first look (holders not proven rising) is a no, with the reason', () => {
  const q = qualityGate(coin(), { unknowns: [] }, { holderGrowthPerHourPct: null, holders: 3000, liqMcap: 0.125 }, config);
  assert.equal(q.ok, false); assert.deepEqual(q.failed.map((x) => x.id), ['holders_rising']);
});

test('quality gate: unknowns, sellers, a falling 5m and thin liquidity all fail', () => {
  const c = coin({ txns: { h1: { buys: 400, sells: 600 }, m5: { buys: 5, sells: 20 } }, change: { m5: -3, h1: 10, h6: 40 } });
  const q = qualityGate(c, { unknowns: ['top10'] }, { holderGrowthPerHourPct: 2, holders: 3000, liqMcap: 0.04 }, config);
  assert.deepEqual(q.failed.map((x) => x.id), ['no_unknowns', 'buys_1h', 'buys_5m', 'up_5m', 'liq_mcap']);
});

test('near misses: one record per coin, outcome from the latest check', () => {
  const book = newNearMissBook();
  const t0 = Date.now() - 2 * 3.6e6;
  const it = recordNearMiss(book, { c: coin(), stage: 'score', reasons: [{ id: 'score', note: 'score 74 < 80' }], score: 74, now: t0 });
  assert.equal(recordNearMiss(book, { c: coin(), stage: 'score', reasons: [], now: t0 + 60_000 }), null);
  assert.equal(it.reasonKey, 'score below 80');
  assert.equal(dueChecks(book).length, 2); // 15m + 1h are due after 2h
  it.checks['15m'] = { chgPct: 12 }; it.checks['1h'] = { chgPct: 45 };
  assert.equal(outcome(it).label, 'pumped');
  it.checks['1h'] = { chgPct: -60 };
  assert.equal(outcome(it).label, 'dumped');
  assert.equal(summarize(book).totals.dumped, 1);
});

test('fast exits: liquidity pulled = emergency, normal wiggle = nothing', () => {
  assert.match(liquidityAlarm({ entryLiq: 100_000 }, 50_000, config.exits), /emergency: liquidity down 50%/);
  assert.match(liquidityAlarm({ entryLiq: 30_000 }, 14_000, config.exits), /emergency/);
  assert.equal(liquidityAlarm({ entryLiq: 100_000 }, 90_000, config.exits), null);
});

test('stops: price under the stop exits, a trail only moves up', () => {
  const pos = { entryPrice: 1, stopPrice: 0.94, peakPrice: 1, trailing: false, tpDone: [], symbol: 'X' };
  assert.equal(manage(pos, 1.2, config).find((a) => a.type === 'note') != null, true);
  const s1 = pos.stopPrice; manage(pos, 1.1, config);
  assert.equal(pos.stopPrice, s1); // never down
  assert.equal(manage(pos, 1.0, config)[0].reason, 'trailing stop');
});
