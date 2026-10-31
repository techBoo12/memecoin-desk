import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanWatch, judge, safety, createHypeLane, concentration, hypeStats } from '../src/hype/lane.js';
import { hypeText } from '../src/telegram/commands.js';

const CONFIG = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const MINT = '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'; // $TRUMP
const MINT2 = 'HobLudRPrJDvHm1kmKJendPK65QQ2FVBxL9ZcVevpump';
const pair = (o = {}) => ({ mint: MINT, symbol: 'TRUMP', url: 'https://dexscreener.com/solana/x', priceUsd: 1, liqUsd: 2_000_000, mcap: 9e9, vol: { m5: 0, h1: 5_000_000, h6: 0, h24: 0 }, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, ...o });
const rc = ({ top = [10, 5, 3], insider = false, lp = 100, mintAuth = null } = {}) => ({
  token: { supply: 1e9, mintAuthority: mintAuth, freezeAuthority: null }, creatorBalance: 0, risks: [],
  markets: [{ pubkey: 'POOL', liquidityA: 'VA', liquidityB: 'VB', lp: { lpLockedPct: lp, lpLockedUSD: 1 } }],
  topHolders: top.map((pct, i) => ({ owner: 'W' + i, address: 'A' + i, pct, insider })), insiderNetworks: [], knownAccounts: {},
});
const item = (o = {}) => ({ mint: MINT, symbol: 'TRUMP', score: 70, tier: 'high', bigName: true, why: ['own tweet @realDonaldTrump [Government badge]'], ...o });

test('hype watchlist from the scanner is validated: bad mints dropped, fields clamped', () => {
  const r = cleanWatch({ at: 5, items: [{ mint: 'not a mint', score: 99 }, { mint: MINT, symbol: '<b>TRUMP</b>'.repeat(5), score: '71', tier: 'high', bigName: 'yes', why: ['a'.repeat(500)] }], sources: { x: true, y: 'no' } }, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.watch.items.length, 1);
  const it = r.watch.items[0];
  assert.equal(it.score, 71); assert.equal(it.bigName, false); // only a real boolean true counts
  assert.ok(it.symbol.length <= 16 && !it.symbol.includes('<'));
  assert.ok(it.why[0].length <= 160);
  assert.deepEqual(r.watch.sources, { x: true, y: false });
  assert.equal(cleanWatch({}).ok, false);
});

const J = (it, c, r, cfg) => judge(it, c, safety(r, null, c, cfg), cfg);
test('judge: normal coin passes; concentrated coin skips; $TRUMP-like big name passes at quarter size, logged', () => {
  const cfg = CONFIG.hype;
  assert.equal(J(item({ bigName: false, score: 50 }), pair(), rc(), cfg).code, 'OK');
  // team holds ~80% (TRUMP): normal caps say no
  const trumpRc = rc({ top: [40, 20, 10, 10] });
  assert.equal(concentration(trumpRc).top10, 80);
  const small = J(item(), pair({ vol: { h1: 50_000 }, liqUsd: 60_000 }), trumpRc, cfg);
  assert.equal(small.ok, false); assert.equal(small.code, 'H7'); assert.match(small.note, /not huge/);
  const big = J(item(), pair(), trumpRc, cfg);
  assert.equal(big.ok, true); assert.equal(big.code, 'BIG'); assert.equal(big.sizeFrac, 0.25);
  assert.match(big.note, /BIG-NAME EXCEPTION/);
  // even the exception has a ceiling
  assert.equal(J(item(), pair(), rc({ top: [60, 30, 5] }), cfg).code, 'H7');
  // switched off = auto-skip again
  assert.equal(J(item(), pair(), trumpRc, { ...cfg, big_name: { ...cfg.big_name, enabled: false } }).ok, false);
  // hard safety is never waived
  assert.equal(J(item(), pair(), rc({ mintAuth: 'X' }), cfg).code, 'H2');
  assert.equal(J(item(), pair({ liqUsd: 1000 }), rc(), cfg).code, 'H4');
  assert.equal(J(item(), null, rc(), cfg).code, 'H0');
});

test('rugcheck down: Jupiter audit is the fallback ($TRUMP reads 80.7% top holders there)', () => {
  const cfg = CONFIG.hype;
  const jupTrump = { id: MINT, decimals: 6, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 80.65860091665418, devMints: 1 } };
  const sf = safety(null, jupTrump, pair({ dexId: 'meteora' }), cfg);
  assert.equal(sf.src, 'jupiter audit'); assert.equal(sf.top10, 80.7); assert.equal(sf.lp, null);
  const v = judge(item(), pair({ dexId: 'meteora' }), sf, cfg);
  assert.equal(v.code, 'BIG'); assert.match(v.note, /LP lock unknown/); assert.match(v.note, /jupiter audit/);
  // a small pump.fun graduate: LP burned by protocol, normal path
  const g = safety(null, { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18 } }, pair({ dexId: 'pumpswap' }), cfg);
  assert.equal(judge(item({ bigName: false, score: 50 }), pair({ dexId: 'pumpswap', liqUsd: 60_000, vol: { h1: 40_000 } }), g, cfg).code, 'OK');
  assert.equal(judge(item(), pair(), safety(null, { audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true, topHoldersPercentage: 5 } }, pair(), cfg), cfg).code, 'H2');
  assert.equal(judge(item(), pair(), safety(null, null, pair(), cfg), cfg).code, 'H1');
});

test('hype lane: own book, buys a watchlist coin, exits on its stop, never touches the desk', async () => {
  let t = Date.parse('2026-10-31T08:00:00Z');
  const now = () => t;
  const S = { desk: { cash: 97.76, positions: [], closed: [{ id: 'T004' }] } };
  const deskBefore = JSON.stringify(S.desk);
  let price = 1;
  const io = {
    pairs: async (mints) => new Map(mints.map((m) => [m, pair({ mint: m, priceUsd: price })])),
    rugcheck: async () => rc({ top: [40, 20, 10, 10] }),
    honeypot: async () => ({ ok: true, fillPriceUsd: 1, decimals: 6 }),
    markPrice: async (pos, fb) => ({ price: fb }),
  };
  const sent = [];
  const lane = createHypeLane({ config: CONFIG, S, now, log: () => {}, notify: (k, txt) => sent.push(txt), io });
  assert.equal(lane.due(), false); // no watchlist yet
  assert.equal(lane.setWatch({ items: [item(), item({ mint: MINT2, symbol: 'GIRAFFE', bigName: false, score: 30, tier: 'watch' })] }).ok, true);
  assert.equal(lane.due(), true);
  assert.equal(await lane.step(), 'hype_buy_big');
  const pos = S.hype.book.positions[0];
  assert.equal(pos.lane, 'hype'); assert.equal(pos.bigName, true); assert.equal(pos.id, 'H001');
  assert.equal(pos.sizeUsd, CONFIG.hype.position_usd * 0.25);
  assert.equal(S.hype.book.cash, 100 - pos.sizeUsd);
  assert.equal(JSON.stringify(S.desk), deskBefore); // the 14-day test book is untouched
  assert.match(sent[0], /big-name exception/);
  // the 'watch' tier coin is not bought
  t += 120_000; assert.equal(await lane.checkOne(), 'hype_idle');
  // price dumps through the stop
  price = 0.7; t += 10_000;
  assert.equal(await lane.step(), 'hype_watch');
  assert.equal(S.hype.book.positions.length, 0);
  const tr = S.hype.book.closed[0];
  assert.equal(tr.lane, 'hype'); assert.match(tr.exitReason, /stop/); assert.ok(tr.pnlUsd < 0);
  const st = hypeStats(S.hype); assert.equal(st.trades, 1); assert.equal(st.wins, 0);
  assert.equal(S.hype.stats.bigName, 1);
  Object.defineProperty(S, 'hypeLines', { value: () => lane.lines() });
  const txt = hypeText(S);
  assert.match(txt, /hype lane \(paper, own \$100 book, not in the 14-day numbers\)/);
  assert.match(txt, /big-name exceptions used 1/);
  // stale watchlist: lane waits instead of trading on old hype
  t += 31 * 60_000; assert.equal(lane.due(), false); assert.match(lane.lines()[2], /STALE/);
});

test('scout: Meteora pairs only when the meteora switch is on', () => {
  const src = readFileSync(new URL('../src/desk/scout.js', import.meta.url), 'utf8');
  assert.match(src, /cfg\.meteora\) queries\.unshift\('meteora'\)/);
  assert.equal(CONFIG.scout.meteora, false); // off by default: the 14-day test keeps its coin universe
});
