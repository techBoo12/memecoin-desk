import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readPage, createdMint, dumpOf, judgeLaunch, verdictOf, runDevHist, labelLaunches, devCfg, devHistLine } from '../src/playbook/devhist.js';
import { buyCard, passedList } from '../src/telegram/buycard.js';
import { createEngine } from '../src/desk/engine.js';
import { makeChain, A } from './fixtures/fakechain.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', SYS = '11111111111111111111111111111111';
const NOW = Date.parse('2026-10-31T09:00:00Z');
const D = devCfg({});
let n = 0;
const sig = () => `sig${++n}`;
const bal = (mint, owner, amount) => ({ mint, owner, uiTokenAmount: { amount: String(amount) } });
function createTx(dev, mint, at) {
  return { blockTime: Math.floor(at / 1000), transaction: { signatures: [sig()], message: { accountKeys: [dev, mint, 'CurveXXXX', PUMP, SYS] } },
    meta: { err: null, logMessages: ['Program log: Instruction: Create'], preBalances: [5e9, 0, 0, 1, 1], postBalances: [4e9, 1e6, 1e6, 1, 1], preTokenBalances: [],
      postTokenBalances: [bal(mint, 'CurveXXXX', 793e12), bal(mint, dev, 50e12)] } };
}
function sellTx(dev, mint, at, from, to) {
  return { blockTime: Math.floor(at / 1000), transaction: { signatures: [sig()], message: { accountKeys: [dev, 'PoolYYYY', PUMP] } },
    meta: { err: null, logMessages: ['Program log: Instruction: Sell'], preBalances: [1, 1, 1], postBalances: [1, 1, 1], preTokenBalances: [bal(mint, dev, from)], postTokenBalances: [bal(mint, dev, to)] } };
}
function fundTx(funder, child, at) {
  return { blockTime: Math.floor(at / 1000), transaction: { signatures: [sig()], message: { accountKeys: [funder, child, SYS] } },
    meta: { err: null, logMessages: [], preBalances: [9e9, 0, 1], postBalances: [8e9, 1e9, 1], preTokenBalances: [], postTokenBalances: [] } };
}
const pair = (mint, liq, mcap, symbol = 'OLD') => ({ baseToken: { address: mint, symbol }, liquidity: { usd: liq }, marketCap: mcap });
const H = 3.6e6;

test('dev history: a page shows the launches the wallet signed, its token flows, and the fresh wallets it funded', () => {
  const tx = createTx('DevAAA', 'MintOld1pump', NOW - 5 * 864e5);
  assert.equal(createdMint(tx), 'MintOld1pump');
  const pg = readPage([tx, sellTx('DevAAA', 'MintOld1pump', NOW - 5 * 864e5 + H, 50e12, 0), fundTx('DevAAA', 'ChildWallet111', NOW - 864e5)], 'DevAAA');
  assert.equal(pg.launches.length, 1); assert.equal(pg.launches[0].mint, 'MintOld1pump');
  assert.equal(pg.flows.MintOld1pump.length, 2);
  assert.deepEqual(pg.funded.map((f) => f.w), ['ChildWallet111']);
  // someone else's create in the wallet's history is not the wallet's launch
  assert.equal(readPage([createTx('Other', 'MintZ', NOW)], 'DevAAA').launches.length, 0);
});

test('dev history: each launch judged rug / died / survived / too new, honestly', () => {
  const l = (ageH, dump) => ({ mint: 'M', at: NOW - ageH * H, dump });
  assert.equal(judgeLaunch(l(48, dumpOf([[NOW - 48 * H, 50e12], [NOW - 47 * H, -50e12]], NOW - 48 * H, D)), pair('M', 50000, 200000), D, NOW).outcome, 'rug', 'sold 100% in 1h = rug even if a pool lives on');
  assert.equal(judgeLaunch(l(48, { bought: true, soldFastPct: 10, soldPct: 10 }), pair('M', 40000, 150000), D, NOW).outcome, 'survived');
  assert.equal(judgeLaunch(l(48, { bought: true, soldFastPct: 10, soldPct: 10 }), null, D, NOW).outcome, 'died');
  assert.equal(judgeLaunch(l(48, { bought: true, soldFastPct: 10, soldPct: 10 }), pair('M', 5000, 12000), D, NOW).outcome, 'weak');
  assert.equal(judgeLaunch(l(3, { bought: true, soldFastPct: 0, soldPct: 0 }), pair('M', 40000, 150000), D, NOW).outcome, 'too_new');
});

test('dev history verdict: clean needs 2+ survivors and 0 rugs; serial rugger; mixed; no history = UNKNOWN, never clean', () => {
  const j = (...o) => o.map((x) => ({ outcome: x }));
  assert.equal(verdictOf(j('survived', 'survived', 'died'), D).verdict, 'clean');
  assert.equal(verdictOf(j('survived'), D).verdict, 'mixed', 'one survivor is not enough');
  assert.equal(verdictOf(j('survived', 'survived', 'rug'), D).verdict, 'mixed', 'any rug kills clean');
  assert.equal(verdictOf(j('rug', 'rug', 'died'), D).verdict, 'serial_rugger');
  assert.equal(verdictOf(j('too_new', 'too_new'), D).verdict, 'unknown');
  const fresh = verdictOf([], D, { fresh: true });
  assert.equal(fresh.verdict, 'unknown'); assert.match(fresh.why, /NOT clean/);
  assert.match(devHistLine({ verdict: 'serial_rugger', why: 'x' }), /serial rugger/);
});

function fakeIo({ pages = {}, pairs = [] } = {}) {
  const calls = [];
  return { calls,
    rpc: async (m, p, o) => { calls.push([m, p[0], o]); if (m !== 'getTransactionsForAddress') throw new Error('unexpected ' + m); return { data: pages[p[0]] || [], paginationToken: null }; },
    getJSON: async (url) => ({ ok: true, data: pairs.filter((x) => url.includes(x.baseToken.address)) }) };
}

test('dev history end to end: dev with 2 surviving launches = clean; reads are Helius-only and cost 10 credits each', async () => {
  const dev = 'DevCleanAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const io = fakeIo({ pages: { [dev]: [createTx(dev, 'Old1pump', NOW - 10 * 864e5), createTx(dev, 'Old2pump', NOW - 20 * 864e5), ...Array.from({ length: 40 }, (_, i) => fundTx('x', 'y' + i, NOW))] },
    pairs: [pair('Old1pump', 80000, 400000, 'ONE'), pair('Old2pump', 30000, 90000, 'TWO')] });
  const h = await runDevHist({ mint: 'NewMintpump', dev, funder: null }, io, {}, NOW);
  assert.equal(h.verdict, 'clean', h.why); assert.equal(h.counts.survived, 2);
  assert.ok(io.calls.every(([m, , o]) => m === 'getTransactionsForAddress' && o.keyedOnly && o.credits === 10));
  assert.equal(h.credits, 10 * h.calls);
  assert.ok(h.evidence.some((e) => e.symbol === 'ONE' && e.outcome === 'survived'));
});

test('dev history: fresh dev funded by a serial launcher (siblings dumped their coins) = serial rugger; a fresh dev alone = unknown', async () => {
  const dev = 'DevFresh', funder = 'FunderHub';
  const s1 = 'Sib1', s2 = 'Sib2';
  const io = fakeIo({ pages: {
    [dev]: [createTx(dev, 'NewMintpump', NOW - 0.2 * H)],
    [funder]: [fundTx(funder, dev, NOW - H), fundTx(funder, s1, NOW - 50 * H), fundTx(funder, s2, NOW - 30 * H)],
    [s1]: [createTx(s1, 'Rug1pump', NOW - 49 * H), sellTx(s1, 'Rug1pump', NOW - 48.5 * H, 50e12, 0)],
    [s2]: [createTx(s2, 'Rug2pump', NOW - 29 * H), sellTx(s2, 'Rug2pump', NOW - 28 * H, 50e12, 1e12)],
  } });
  const h = await runDevHist({ mint: 'NewMintpump', dev, funder }, io, {}, NOW);
  assert.equal(h.verdict, 'serial_rugger', h.why); assert.equal(h.counts.rugs, 2);
  const alone = await runDevHist({ mint: 'NewMintpump', dev, funder: null }, fakeIo({ pages: { [dev]: [createTx(dev, 'NewMintpump', NOW - 0.2 * H)] } }), {}, NOW);
  assert.equal(alone.verdict, 'unknown'); assert.match(alone.why, /fresh wallet/);
});

test('dev history: the bot\'s own RUG labels count (0 credits); a failed read = unknown, never clean', async () => {
  const book = { items: { a: { mint: 'a', sym: 'OLDA', dep: 'Funder9', fun: null, t0: NOW - 30 * H, label: 'RUG' }, b: { mint: 'b', sym: 'OLDB', dep: 'Sib', fun: 'Funder9', t0: NOW - 26 * H, label1h: 'RUG' } } };
  assert.equal(labelLaunches(book, { mint: 'z', dev: 'Dev', funder: 'Funder9' }).length, 2);
  const io = { rpc: async () => { throw new Error('rpc getTransactionsForAddress: HTTP 429'); }, getJSON: async () => ({ ok: true, data: [] }) };
  const h = await runDevHist({ mint: 'z', dev: 'Dev', funder: 'Funder9', labels: book }, io, {}, NOW);
  assert.equal(h.verdict, 'serial_rugger', 'two labelled rugs from the same funder family');
  const h2 = await runDevHist({ mint: 'z', dev: 'Dev', funder: null }, io, {}, NOW);
  assert.equal(h2.verdict, 'unknown'); assert.ok(h2.notes.some((x) => /failed/.test(x)));
});

test('buy card: coin, short mint, dexscreener link, lane, size, entry, crew %, dev history + evidence, rules passed, why', () => {
  const t = buyCard({ lane: 'trusted_dev', symbol: 'ABC', mint: 'AbCd1111111111111111111111111111111111pump', pool: 'PoolX', sizeUsd: 0.5, entryPrice: 0.0000123, liqUsd: 45000, mcapUsd: 120000,
    crew: { wallets: 7, pct: 34.5, cap: 20 }, devHist: { verdict: 'clean', why: '2 of 2 earlier launches still trading, 0 rugs', evidence: [{ mint: 'm1', symbol: 'OLD', by: 'dev', outcome: 'survived', why: 'still trading' }] },
    passed: passedList([{ code: 'R1', status: 'pass', value: 'revoked' }, { code: 'R5', status: 'fail' }, { code: 'M2', status: 'warn', value: 0 }]), why: 'because' });
  for (const re of [/TRUSTED-DEV EXCEPTION · quarter size/, /\$ABC · mint AbCd…pump/, /dexscreener\.com\/solana\/PoolX/, /size \$0\.50 · entry \$0\.00001230/, /7 linked wallets hold 34\.5% \(cap 20%\)/,
    /dev history: ✅ clean/, /\$OLD \(dev\): survived/, /rules passed: R1 revoked · M2 0 \(warn\)/, /why: because/, /not proof/]) assert.match(t, re);
  assert.doesNotMatch(t, /R5/);
});

// ---------------------------------------------------------------- the trusted-dev exception inside the lane (fake chain)
function laneWith(over, history) {
  const ch = makeChain();
  const rpc0 = ch.io.rpc, gj0 = ch.io.getJSON;
  const looked = [];
  ch.io.rpc = async (m, p, o) => { if (m === 'getTransactionsForAddress') { looked.push(p[0]); return { data: history.pages?.[p[0]] || [], paginationToken: null }; } return rpc0(m, p, o); };
  ch.io.getJSON = async (url, o) => (url.includes('/tokens/v1/') && !url.includes(A.MINT) ? { ok: true, data: (history.pairs || []).filter((x) => url.includes(x.baseToken.address)) } : gj0(url, o));
  let t = ch.MIGRATED + 2 * 60_000;
  const S = {}, sent = [], events = [];
  const c = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
  c.playbook = { ...c.playbook, discover_every_s: 9999, ...over };
  c.loop.scanEverySec = 1e9;
  const eng = createEngine({ config: c, S, log: { event: (...a) => events.push(a.map(String).join(' ')), warn() {}, info() {} }, notify: (k, txt) => sent.push([k, txt]), now: () => t, pbIo: ch.io });
  S.timers.nextScan = Infinity; S.timers.nextNm = Infinity; S.pb.timers.nextLabels = Infinity;
  return { ch, S, eng, sent, looked, events, run: async () => { for (let i = 0; i < 40 && !S.desk.positions.length && !S.pb.stats.skipped; i++) { await eng.tick({ pbBudget: 8 }); t += 300; } } };
}
const cleanHistory = () => ({ pages: { [A.DEP]: [createTx(A.DEP, 'Old1pump', Date.now() - 10 * 864e5), createTx(A.DEP, 'Old2pump', Date.now() - 20 * 864e5)] },
  pairs: [pair('Old1pump', 80000, 400000, 'ONE'), pair('Old2pump', 30000, 90000, 'TWO')] });

test('trusted-dev exception: crew over the cap + CLEAN dev history -> paper buy at QUARTER size, tagged trusted_dev, inside the main 14-day book', async () => {
  const base = laneWith({ max_cluster_share_pct: 20 }, cleanHistory()); await base.run();
  const normal = base.S.desk.positions[0]; assert.ok(normal);
  const L = laneWith({ max_cluster_share_pct: 15 }, cleanHistory()); await L.run();
  const p = L.S.desk.positions[0];
  assert.ok(p, `no buy: ${JSON.stringify(L.S.pb.recent[0])}`);
  assert.equal(p.strategy, 'insider'); assert.equal(p.trusted_dev, true); assert.match(p.id, /^X\d{3}$/);
  assert.ok(Math.abs(p.sizeUsd - normal.sizeUsd / 4) < 0.05, `quarter size: ${p.sizeUsd} vs ${normal.sizeUsd}`);
  assert.equal(L.S.pb.trusted.used, 1);
  assert.ok(L.events.some((e) => /TRUSTED-DEV EXCEPTION/.test(e)), 'logged as TRUSTED-DEV EXCEPTION');
  const card = L.sent.find(([k]) => k === 'buy')[1];
  assert.match(card, /TRUSTED-DEV EXCEPTION/); assert.match(card, /dev history: ✅ clean/); assert.match(card, /over the 15% cap BUT under 60%/);
});

test('trusted-dev exception refused: unknown (fresh) dev -> R5 skip as before; crew over the hard cap -> no lookup at all', async () => {
  const L = laneWith({ max_cluster_share_pct: 15 }, { pages: {} }); await L.run();
  assert.equal(L.S.desk.positions.length, 0); assert.equal(L.S.pb.skips.R5, 1);
  assert.match(L.S.pb.recent[0].note, /trusted-dev exception refused: dev history: ❔ unknown/);
  const H2 = laneWith({ max_cluster_share_pct: 5, trusted_dev: { max_crew_pct: 10 } }, cleanHistory()); await H2.run();
  assert.equal(H2.S.desk.positions.length, 0); assert.equal(H2.S.pb.skips.R5, 1);
  assert.equal(H2.looked.length, 0, 'crew over the 60%-style hard cap: no history read, no credits');
  const off = laneWith({ max_cluster_share_pct: 15, trusted_dev: { enabled: false } }, cleanHistory()); await off.run();
  assert.equal(off.S.desk.positions.length, 0);
});

test('serial rugger: a coin that passes every rule is still skipped (DH) when the dev\'s earlier launches were dumped', async () => {
  const now = Date.now();
  const L = laneWith({ max_cluster_share_pct: 20 }, { pages: { [A.DEP]: [createTx(A.DEP, 'R1pump', now - 50 * H), sellTx(A.DEP, 'R1pump', now - 49.5 * H, 50e12, 0), createTx(A.DEP, 'R2pump', now - 30 * H), sellTx(A.DEP, 'R2pump', now - 29.9 * H, 50e12, 0)] } });
  await L.run();
  assert.equal(L.S.desk.positions.length, 0); assert.equal(L.S.pb.skips.DH, 1);
  assert.match(L.S.pb.recent[0].note, /serial rugger/);
  assert.equal(L.sent.filter(([k]) => k === 'buy' || k === 'insider_alert').length, 0, 'no alert for a coin it did not buy');
});
