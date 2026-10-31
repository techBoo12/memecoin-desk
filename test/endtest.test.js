// her call Oct 31: stop the running test window early, keep every trade, report it, start the next window
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../src/desk/engine.js';

const CONFIG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function setup() {
  const config = structuredClone(CONFIG); config.playbook = { ...(config.playbook || {}), enabled: false };
  const S = {}; const sent = [];
  const engine = createEngine({ config, S, log: { event() {}, warn() {}, info() {} }, notify: (k, t) => { sent.push({ k, t }); return true; } });
  return { engine, S, sent };
}

test('endTestEarly writes the partial report, keeps trades, starts window #2', () => {
  const { engine, S, sent } = setup();
  const t1 = engine.startTest(24);
  t1.startedAt -= 18 * 3.6e6; t1.endsAt -= 18 * 3.6e6;
  S.desk.closed.push({ id: 'T1', symbol: 'AAA', entryAt: new Date(t1.startedAt + 3.6e6).toISOString(), exitAt: new Date().toISOString(), pnlUsd: -1, R: -0.5, score: 85, exitReason: 'stop' });
  const closedBefore = S.desk.closed.length;
  const r = engine.endTestEarly({ expectN: 1 });
  assert.equal(r.ok, true);
  assert.equal(S.desk.closed.length, closedBefore, 'no trade lost');
  assert.equal(S.desk.reports.length, 1);
  assert.equal(S.desk.reports[0].early, true);
  assert.ok(Math.abs(S.desk.reports[0].hoursRun - 18) < 0.05);
  assert.match(sent.at(-1).t, /stopped early at your request · 18\.0h of 24h/);
  assert.match(sent.at(-1).t, /trades: 1/);
  assert.equal(S.desk.test.n, 2);
  assert.ok(S.desk.test.endsAt - S.desk.test.startedAt === 24 * 3.6e6);
  assert.equal(S.desk.test.reportSentAt, null);
});

test('endTestEarly with a report already sent does not send twice, and refuses a second call', () => {
  const { engine, S, sent } = setup();
  engine.startTest(24);
  const r = engine.endTestEarly({ expectN: 1, text: 'already sent', sentAt: Date.now() - 1000, stoppedAt: Date.now() - 60_000 });
  assert.equal(r.ok, true);
  assert.equal(sent.filter((x) => x.k === 'report').length, 0);
  assert.equal(S.desk.reports[0].text, 'already sent');
  const again = engine.endTestEarly({ expectN: 1 });
  assert.equal(again.ok, false);
  assert.equal(S.desk.test.n, 2);
});

import { finalSummaryText, campaignDay } from '../src/desk/campaign.js';

test('14-day run: every 24h report says day N of 14, day 14 adds the go/no-go, then it keeps going', async () => {
  let clock = Date.parse('2026-10-31T06:30:00Z');
  const config = structuredClone(CONFIG);
  const S = {}; const sent = [];
  const engine = createEngine({ config, S, now: () => clock, log: { event() {}, warn() {}, info() {} }, notify: (k, t) => { sent.push({ k, t }); return true; } });
  engine.startTest(24);
  const r = engine.endTestEarly({ expectN: 1, campaignDays: 14 });
  assert.equal(r.ok, true);
  assert.equal(S.desk.campaign.firstN, 2);
  assert.equal(S.desk.campaign.finalAt - S.desk.campaign.startedAt, 14 * 86.4e6);
  sent.length = 0;
  for (let day = 1; day <= 15; day++) {
    clock += 24 * 3.6e6 + 1000;
    S.desk.closed.push({ id: 'T' + day, mint: 'M' + day, symbol: 'C' + day, entryAt: new Date(clock - 3.6e6).toISOString(), exitAt: new Date(clock - 1800e3).toISOString(), sizeUsd: 10, pnlUsd: day % 2 ? 1 : -0.5, pnlPct: day % 2 ? 10 : -5, R: day % 2 ? 1 : -0.5, score: 85, exitReason: 'tp' });
    const out = await engine.tick();
    assert.equal(out.did, 'report', 'day ' + day);
    const reports = sent.filter((x) => x.k === 'report');
    if (day <= 14) assert.match(reports[0].t, new RegExp(`^📅 day ${day} of 14`));
    else assert.match(reports[0].t, /^📅 day 15 · past the 14-day run/);
    if (day === 14) {
      assert.equal(reports.length, 2, 'day 14 sends the final check as its own message');
      assert.match(reports[1].t, /14-day paper run · final check/);
      assert.match(reports[1].t, /❌ 14\+ days and 100\+ closed paper trades · 14 days, 14 trades/);
      assert.match(reports[1].t, /win rate >= 35% · 50%/);
      assert.match(reports[1].t, /verdict: NO-GO/);
    } else assert.equal(reports.length, 1);
    sent.length = 0;
  }
  assert.ok(S.desk.campaign.finalSentAt);
  assert.equal(S.desk.test.n, 17, 'still rolling 24h windows after day 14');
});

test('startCampaign attaches the 14-day run to the running window, silently, once', () => {
  const { engine, S, sent } = setup();
  engine.startTest(24); engine.endTestEarly({ expectN: 1, text: 'x', sentAt: Date.now() });
  sent.length = 0;
  assert.equal(engine.startCampaign({ days: 14, expectN: 3 }).ok, false);
  const r = engine.startCampaign({ days: 14, expectN: 2 });
  assert.equal(r.ok, true);
  assert.equal(S.desk.campaign.firstN, 2);
  assert.equal(S.desk.campaign.startedAt, S.desk.test.startedAt);
  assert.equal(sent.length, 0);
  assert.equal(engine.startCampaign({ days: 14, expectN: 2 }).ok, false);
});

import { makeRpc } from '../src/playbook/solana.js';
test('archive rpc falls back to publicnode when mainnet-beta answers 403 (cloudflare), and skips the blocked one after', async () => {
  const hits = [];
  const fetchImpl = async (url) => { hits.push(url); if (url.includes('mainnet-beta')) return { ok: false, status: 403 }; return { ok: true, json: async () => ({ result: ['sig'] }) }; };
  const rpc = makeRpc({ archive: true, fetchImpl });
  assert.deepEqual(await rpc('getSignaturesForAddress', ['x']), ['sig']);
  assert.deepEqual(hits, ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']);
  hits.length = 0;
  await rpc('getTransaction', ['y']);
  assert.deepEqual(hits, ['https://solana-rpc.publicnode.com']);
});
