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
