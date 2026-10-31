#!/usr/bin/env node
// ============================================================================
// SMART-WALLET LIST BUILDER (runs OFF the worker, once a day, on Tab's box)
// Why off-worker: it reads thousands of full transactions (MBs of JSON). A Cloudflare free-plan
// invocation has ~10 ms of CPU; this box has minutes. The worker only receives the finished list.
//
// How the list is made (all from public on-chain data, her free Helius key, no paid feed):
//   1. graduates: every pump.fun migration of the last --days (pump.fun's migration account joins
//      each one; Helius getTransactionsForAddress, full txs, 10 credits per 100)
//   2. winners: graduates whose price went >= --winx times the migration price. Peak from
//      GeckoTerminal hourly candles (free), current from DexScreener (free)
//   3. early buyers: the wallets that bought each winner on PumpSwap in its first --early-min minutes
//      after graduation (the bot's own window). One page of the pool's first txs per winner.
//   4. candidates: early buyers seen in the most winners (bots/MEV filtered later)
//   5. score: each candidate's OWN last ~days of txs (one page) -> realized PnL per token (SOL in vs out,
//      fees included), win rate, txs/day, median hold. Gate + score in src/playbook/smart.js
//   6. keep the top --max that fit the daily webhook budget (1 Helius credit per pushed tx)
// A "smart wallet" is a statistical label from a small sample of past trades, not proof of skill.
//
// Usage (key only via env, never printed):
//   HELIUS_RPC_URL=... node tools/smart_wallets.mjs [--days 2] [--max 30] [--budget 2500] [--push] [--hook]
//   --push  POST the list to the worker (/admin/smart, admin key from state/cloudflare.json)
//   --hook  create/update her ONE free Helius webhook so the smart wallets' txs are pushed to the worker
// Writes state/smart_wallets.json (gitignored state dir).
// ============================================================================
import fs from 'node:fs';
import { parseMigration, earlyBuyers, walletStats, scoreWallet, pickList, hookToken, short, keysOf } from '../src/playbook/smart.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const DAYS = Number(arg('days', 2)), MAX = Number(arg('max', 30)), WINX = Number(arg('winx', 5)), EARLY_MIN = Number(arg('early-min', 10));
const CREDIT_BUDGET = Number(arg('budget', 2500)), HOOK_BUDGET = Number(arg('hook-budget', 2500)), CANDS = Number(arg('candidates', 60)), WIN_CAP = Number(arg('winners', 40));
const SCORE_DAYS = Number(arg('score-days', 7)), WALLET_PAGE = Number(arg('wallet-page', 200));
const MIN_GRAD_SOL = 40; // real graduations seed the pool with ~67+ SOL; the many 0.1-SOL "graduations" are spam
const MIGRATION_ACCOUNT = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) { console.error('HELIUS_RPC_URL not set'); process.exit(2); }
const API_KEY = new URL(RPC).searchParams.get('api-key');
const here = new URL('..', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let credits = 0;
const meter = { gtfa: 0, std: 0, hookMgmt: 0 };
async function rpc(method, params) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: String(e.message) }));
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) { if (/rate|limit/i.test(j.error.message)) { await sleep(1500 * (i + 1)); continue; } throw new Error(`${method}: ${j.error.message}`); }
    return j.result;
  }
  throw new Error(`${method}: gave up after retries`);
}
// Helius getTransactionsForAddress: full txs = 10 credits per 100 returned (min 10). Budget-guarded.
async function gtfa(address, opts) {
  const lim = opts.limit || 100;
  const worst = Math.max(10, Math.ceil(lim / 100) * 10);
  if (credits + worst > CREDIT_BUDGET) throw new Error(`credit budget ${CREDIT_BUDGET} reached`);
  const r = await rpc('getTransactionsForAddress', [address, { transactionDetails: 'full', maxSupportedTransactionVersion: 1, ...opts }]);
  const n = r?.data?.length || 0; const c = Math.max(10, Math.ceil(n / 100) * 10);
  credits += c; meter.gtfa += c;
  return r;
}
const stat = { gt429: 0, gtOk: 0 };
async function getJSON(url, { gapMs = 0, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r?.ok) { if (gapMs) await sleep(gapMs); return r.json(); }
    if (r?.status === 429 && url.includes('geckoterminal')) stat.gt429++;
    await sleep(r?.status === 429 ? 30_000 : 2000);
  }
  return null;
}

async function main() {
  const t0 = Date.now(), nowS = Math.floor(t0 / 1000);
  // 1. graduates
  const migs = new Map(); let token = null, pages = 0;
  do {
    const r = await gtfa(MIGRATION_ACCOUNT, { limit: 1000, sortOrder: 'desc', filters: { blockTime: { gte: nowS - DAYS * 86400 }, status: 'succeeded' }, ...(token ? { paginationToken: token } : {}) });
    for (const tx of r.data || []) { const m = parseMigration(tx); if (m && (!migs.has(m.mint) || migs.get(m.mint).at > m.at)) migs.set(m.mint, m); }
    token = r.paginationToken; pages++;
  } while (token && pages < 8);
  const real = [...migs.values()].filter((m) => m.solRes >= MIN_GRAD_SOL);
  log(`graduates in ${DAYS}d: ${migs.size} (real, >= ${MIN_GRAD_SOL} SOL seeded: ${real.length}) · credits ${credits}`);

  // 2. winners: current price from DexScreener (30 per call), peak from GeckoTerminal hourly candles
  const sol = (await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${'So11111111111111111111111111111111111111112'}`))?.pairs?.find((p) => p.quoteToken?.symbol === 'USDC')?.priceUsd;
  const cur = {};
  for (let i = 0; i < real.length; i += 30) {
    const batch = real.slice(i, i + 30);
    const d = await getJSON(`https://api.dexscreener.com/tokens/v1/solana/${batch.map((m) => m.mint).join(',')}`, { gapMs: 250 });
    for (const p of d || []) { const m = migs.get(p.baseToken?.address); if (!m || p.pairAddress !== m.pool) continue; cur[m.mint] = { priceSol: Number(p.priceNative) || 0, vol24: p.volume?.h24 || 0, symbol: p.baseToken.symbol, fdv: p.fdv || 0, liq: p.liquidity?.usd || 0 }; }
  }
  for (const m of real) { m.symbol = cur[m.mint]?.symbol || m.mint.slice(0, 4); m.nowX = cur[m.mint] ? cur[m.mint].priceSol / m.priceSol : null; m.vol24 = cur[m.mint]?.vol24 || 0; }
  const peekList = real.filter((m) => (m.nowX ?? 0) >= 1.5 || m.vol24 >= 250_000).sort((a, b) => (b.nowX ?? 0) - (a.nowX ?? 0)).slice(0, Number(arg('peak-checks', 30)));
  log(`candidates for a peak check: ${peekList.length} (now >= 1.5x or 24h vol >= $250k)`);
  for (const m of peekList) {
    if (stat.gt429 >= 6) { m.peakX = null; continue; } // geckoterminal keeps refusing: fall back to the current price for the rest
    const d = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${m.pool}/ohlcv/hour?limit=72&currency=token`, { gapMs: 4000, tries: 2 });
    if (d) stat.gtOk++;
    const highs = (d?.data?.attributes?.ohlcv_list || []).filter((c) => c[0] * 1000 >= m.at).map((c) => Number(c[2]));
    // currency=token -> candles priced in the quote token (SOL) for a token/SOL pool
    m.peakX = highs.length ? Math.max(...highs) / m.priceSol : null;
  }
  const winners = real.filter((m) => Math.max(m.peakX ?? 0, m.nowX ?? 0) >= WINX).sort((a, b) => Math.max(b.peakX ?? 0, b.nowX ?? 0) - Math.max(a.peakX ?? 0, a.nowX ?? 0)).slice(0, WIN_CAP);
  log(`peak checks: ${stat.gtOk} ok, ${stat.gt429} refused (429)`);
  log(`winners (>= ${WINX}x the migration price): ${winners.length}: ${winners.map((w) => `$${w.symbol} ${Math.max(w.peakX ?? 0, w.nowX ?? 0).toFixed(1)}x`).join(', ')}`);

  // 3. early buyers per winner (first page of the pool's txs after migration)
  const hits = new Map();
  for (const w of winners) {
    try {
      const r = await gtfa(w.pool, { limit: 100, sortOrder: 'asc', filters: { blockTime: { gte: Math.floor(w.at / 1000) }, status: 'succeeded' } });
      const eb = earlyBuyers(r.data || [], { mint: w.mint, migratedAt: w.at, windowMin: EARLY_MIN, skip: [w.pool] });
      w.earlyBuyers = eb.length;
      for (const b of eb) { const h = hits.get(b.wallet) || { wallet: b.wallet, winners: [], sol: 0 }; h.winners.push(w.symbol); h.sol += b.sol; hits.set(b.wallet, h); }
    } catch (e) { log(`early buyers $${w.symbol}: ${e.message}`); if (/budget/.test(e.message)) break; }
  }
  const cands = [...hits.values()].sort((a, b) => b.winners.length - a.winners.length || b.sol - a.sol).slice(0, CANDS);
  log(`early buyers across winners: ${hits.size} wallets · in 2+ winners: ${[...hits.values()].filter((h) => h.winners.length > 1).length} · scoring ${cands.length} · credits ${credits}`);

  // 5. score each candidate on its own recent trades
  const scored = [], rejected = {}, table = [];
  for (const c of cands) {
    try {
      const r = await gtfa(c.wallet, { limit: WALLET_PAGE, sortOrder: 'desc', filters: { blockTime: { gte: nowS - SCORE_DAYS * 86400 }, status: 'succeeded' } });
      const s = walletStats(r.data || [], c.wallet);
      if ((r.data || []).length >= WALLET_PAGE) s.partial = true; // page full: busier than WALLET_PAGE txs in SCORE_DAYS, span measured from the page
      const g = scoreWallet(s);
      table.push({ w: c.wallet, winners: c.winners.length, closed: s.closed, winRate: s.winRate, pnlSol: s.pnlSol, roiPct: s.roiPct, txPerDay: s.txPerDay, spanDays: s.spanDays, medianHoldMin: s.medianHoldMin, verdict: g.ok ? 'kept' : g.why });
      if (g.ok) scored.push({ ...s, score: g.score, winnersHit: c.winners, earlySol: +c.sol.toFixed(2) });
      else { const k = g.why.replace(/[\d.]+/g, 'N'); rejected[k] = (rejected[k] || 0) + 1; }
    } catch (e) { if (/budget/.test(e.message)) { log('credit budget reached while scoring, stopping'); break; } }
  }
  const pick = pickList(scored, { max: MAX, hookBudgetDay: HOOK_BUDGET });
  log(`passed the gate: ${scored.length} · kept: ${pick.list.length} · expected webhook load ${pick.expectedEventsDay} txs/day · credits used ${credits}`);
  const out = {
    builtAt: new Date().toISOString(), tookS: Math.round((Date.now() - t0) / 1000), credits, meter, solUsd: Number(sol) || null,
    params: { days: DAYS, winx: WINX, earlyMin: EARLY_MIN, scoreDays: SCORE_DAYS, walletPage: WALLET_PAGE, max: MAX, hookBudgetDay: HOOK_BUDGET, creditBudget: CREDIT_BUDGET },
    counts: { graduates: migs.size, realGraduates: real.length, peakChecked: peekList.length, winners: winners.length, earlyBuyers: hits.size, scored: cands.length, passed: scored.length, kept: pick.list.length, rejected },
    expectedEventsDay: pick.expectedEventsDay,
    winners: winners.map((w) => ({ symbol: w.symbol, mint: w.mint, pool: w.pool, migratedAt: new Date(w.at).toISOString(), peakX: w.peakX && +w.peakX.toFixed(1), nowX: w.nowX && +w.nowX.toFixed(1), earlyBuyers: w.earlyBuyers ?? null })),
    candidates: table,
    list: pick.list.map((s) => ({ w: s.wallet, score: s.score, winRate: s.winRate, closed: s.closed, wins: s.wins, pnlSol: s.pnlSol, spentSol: s.spentSol, roiPct: s.roiPct, txPerDay: s.txPerDay, spanDays: s.spanDays, partial: Boolean(s.partial), medianHoldMin: s.medianHoldMin, winnersHit: s.winnersHit, earlySol: s.earlySol })),
    note: 'statistical label from public on-chain trades (small sample, past only). not proof of skill or insider info. paper copy only.',
  };
  fs.mkdirSync(here + 'state', { recursive: true });
  fs.writeFileSync(here + 'state/smart_wallets.json', JSON.stringify(out, null, 1));
  for (const s of out.list.slice(0, 15)) log(`  ${short(s.w)} score ${s.score} · win ${(s.winRate * 100).toFixed(0)}% of ${s.closed} · pnl ${s.pnlSol} SOL (${s.roiPct}% on ${s.spentSol} SOL) · ${s.txPerDay} tx/d · hit ${s.winnersHit.join(',')}`);

  const cf = fs.existsSync(here + 'state/cloudflare.json') ? JSON.parse(fs.readFileSync(here + 'state/cloudflare.json', 'utf8')) : null;
  if (arg('hook', false) === true) {
    if (!cf?.adminKey || !cf?.url) throw new Error('state/cloudflare.json missing (url, adminKey)');
    if (!out.list.length) log('no wallets kept: webhook left as it is');
    else {
      const auth = await hookToken(cf.adminKey);
      const base = 'https://api-mainnet.helius-rpc.com/v0/webhooks';
      const all = await getJSON(`${base}?api-key=${API_KEY}`);
      const mine = (all || []).find((h) => String(h.webhookURL || '').startsWith(cf.url.replace(/\/$/, '') + '/hook/smart'));
      const body = { webhookURL: cf.url.replace(/\/$/, '') + '/hook/smart', transactionTypes: ['ANY'], accountAddresses: out.list.map((s) => s.w), webhookType: 'raw', authHeader: auth, txnStatus: 'success' };
      const r = await fetch(mine ? `${base}/${mine.webhookID}?api-key=${API_KEY}` : `${base}?api-key=${API_KEY}`, { method: mine ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      credits += 100; meter.hookMgmt += 100;
      out.hook = { ok: r.ok, id: j.webhookID || mine?.webhookID || null, addresses: out.list.length, action: mine ? 'updated' : 'created', status: r.status };
      log(`webhook ${out.hook.action}: ${r.ok ? 'ok' : 'FAILED ' + r.status + ' ' + JSON.stringify(j).slice(0, 200)}`);
      fs.writeFileSync(here + 'state/smart_wallets.json', JSON.stringify(out, null, 1));
    }
  }
  if (arg('push', false) === true) {
    if (!cf?.adminKey || !cf?.url) throw new Error('state/cloudflare.json missing (url, adminKey)');
    const r = await fetch(cf.url.replace(/\/$/, '') + '/admin/smart', { method: 'POST', headers: { 'x-admin-key': cf.adminKey, 'content-type': 'application/json' }, body: JSON.stringify({ list: out.list, builtAt: out.builtAt, counts: out.counts, credits: out.credits, expectedEventsDay: out.expectedEventsDay, hook: out.hook || null, winners: out.winners.slice(0, 10).map((w) => ({ symbol: w.symbol, x: Math.max(w.peakX || 0, w.nowX || 0) })) }) });
    log(`pushed to the worker: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}
main().catch((e) => { console.error('smart wallet build failed: ' + e.message); process.exit(1); });
