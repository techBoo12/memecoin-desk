// ============================================================================
// THE INSIDER-EXIT LANE (training pack section 9, wired into the desk engine)
//   detect fresh pump.fun graduates (R14) -> map the dev's cluster -> rug filter R1-R7
//   + second opinions + manipulation flags -> size (step e) -> quote/fee caps (R11/R13)
//   -> paper buy -> monitor >= 1/s (pool reserves, authorities, LP, deployer + cluster
//   balances in ONE read) -> E1-E8 in order -> R18 alerts -> label every token at
//   +1h/+24h -> 9.4 metrics + go/no-go.
// Paper only. Reads only. One unit of work per call so a Worker invocation stays small.
// ============================================================================
import { newBuild, stepBuild } from './gather.js';
import { makeRpc, bindKeyedLedger, jitoBundleOf, jitoBundleTxs, jitoTipFloorSol, tokenDeltas, BURN_OWNERS, PUMPSWAP_PROGRAM } from './solana.js';
// pump.fun's migration account: it takes part in every graduation (seen in MELT's 46k migrations and live on Oct 31 2026)
export const MIGRATION_ACCOUNT = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
import { rugChecks, riskChecks, secondOpinion, manipulationChecks, execChecks, decide, liquidityUsd } from './rules.js';
import { firstTrigger } from './exits.js';
import { estimateFeeSol, sizeInsider, kellyCapPct, paperCostUsd } from './fees.js';
import { newLabelBook, trackToken, dueMints, applySample, evaluate, labelSummary } from './labels.js';
import { signalText } from './signals.js';
import { why } from './kb.js';
import { quote, solPriceUsd } from '../desk/honeypot.js';
import { rugcheckReport } from '../desk/filter.js';
import { getJSON, SOL_MINT } from '../lib/http.js';
import { equity, rollDay } from '../desk/risk.js';
import { sellPaper } from '../desk/executor.js';

export function newPlaybookState() {
  return { seen: {}, queue: [], build: null, recent: [], skips: {}, stats: { detected: 0, built: 0, entered: 0, skipped: 0, rpcCalls: 0 },
    latency: [], symbols: {}, rugDeployers: [], shareRefs: {}, alertSeq: 0, killDays: {}, killSwitch: null, cpuMs: [],
    timers: { nextDiscover: 0, nextMonitor: 0, nextLabels: 0 } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goplusReport = async (mint) => {
  const r = await getJSON(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`, { retries: 1, timeoutMs: 8000 });
  return r.ok ? r.data?.result?.[mint] || null : null;
};

export function defaultIo() {
  return { rpc: makeRpc(), jitoBundleOf, jitoBundleTxs, jitoTipFloor: jitoTipFloorSol, rugcheck: (m) => rugcheckReport(m, 60_000), goplus: goplusReport, getJSON, quote, solPriceUsd };
}

export function createPlaybookLane({ config, S, now = () => Date.now(), ev, notify, dirty, io = defaultIo() }) {
  const cfg = config.playbook;
  S.pb ||= newPlaybookState();
  S.labels ||= newLabelBook();
  const P = S.pb, st = S.desk;
  bindKeyedLedger(P.keyed ||= { day: '', used: 0, denied: 0 }); // today's Helius calls, kept in state so a restart doesn't reset the count
  const insiderOpen = () => st.positions.filter((p) => p.strategy === 'insider');
  const counted = (fn) => async (...a) => { P.stats.rpcCalls++; return fn(...a); };
  const rio = { ...io, rpc: counted(io.rpc) };
  const skip = (tok, code, note, extra = {}) => {
    P.skips[code] = (P.skips[code] || 0) + 1; P.stats.skipped++;
    P.recent.unshift({ at: now(), sym: tok.symbol, mint: tok.mint, d: 'skip', code, note: String(note).slice(0, 140), ...extra }); P.recent.length = Math.min(P.recent.length, 60);
    ev('pb_skip', { mint: tok.mint, code, note }, `◇ INSIDER SKIP $${tok.symbol} ${code}: ${String(note).slice(0, 110)}`);
    dirty('pb');
  };
  const dayLossPct = () => { rollDay(st); return ((st.dayStartEquity - equity(st)) / st.dayStartEquity) * 100; };
  const killSwitchOn = () => {
    if (P.killSwitch && P.killSwitch !== st.day) P.killSwitch = null;
    if (!P.killSwitch && dayLossPct() >= cfg.max_daily_loss_pct) { P.killSwitch = st.day; P.killDays[st.day] = { hit: true, fired: false }; }
    return P.killSwitch ? `day loss >= ${cfg.max_daily_loss_pct}% (${st.day})` : null;
  };
  let solUsd = 0;
  const sol = async () => (solUsd = (await io.solPriceUsd()) || solUsd);

  // ---------- (a) detect: free polling, not a stream (pack wants Geyser/Bitquery streams: paid)
  // source 1 (on-chain, exact): pump.fun's migration account signs/joins every graduation. One cheap call
  // lists the latest ones; each new one is read once for its pool + mint + exact migration time.
  async function discoverChain(found) {
    const sigs = await rio.rpc('getSignaturesForAddress', [cfg.migration_account || MIGRATION_ACCOUNT, { limit: 25 }]);
    let reads = 0;
    for (const s of sigs) {
      if (s.err || P.seen['sig:' + s.signature] || reads >= 4) continue;
      P.seen['sig:' + s.signature] = now();
      if (now() - (s.blockTime || 0) * 1000 > cfg.max_minutes_since_migration * 60_000) continue;
      reads++;
      const tx = await rio.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
      const keys = (tx?.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      if (!tx || tx.meta?.err || !keys.includes(PUMPSWAP_PROGRAM)) continue; // not a migration into PumpSwap
      const post = tx.meta.postTokenBalances || [];
      const wsolOwners = new Set(post.filter((b) => b.mint === SOL_MINT).map((b) => b.owner));
      const base = post.find((b) => b.mint !== SOL_MINT && wsolOwners.has(b.owner) && Number(b.uiTokenAmount.amount) > 0);
      if (!base) continue;
      found.push({ mint: base.mint, pool: base.owner, symbol: base.mint.slice(0, 4), createdAt: (tx.blockTime || s.blockTime) * 1000, migrationSig: s.signature, src: 'chain' });
    }
  }

  async function discover() {
    P.timers.nextDiscover = now() + cfg.discover_every_s * 1000;
    const found = [];
    try { await discoverChain(found); } catch (e) { ev('warn', {}, `insider discover (chain): ${String(e.message).slice(0, 80)}`); }
    const gtOk = now() > (P.gtBackoffUntil || 0);
    for (const page of gtOk ? [1, 2] : []) {
      const r = await io.getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}&include=base_token`, { minGapMs: 2100, retries: 0, timeoutMs: 8000 });
      if (!r.ok) { P.gtBackoffUntil = now() + 5 * 60_000; break; } // free tier said slow down (429): chain + DexScreener carry on
      for (const p of r.data?.data || []) {
        if (p.relationships?.dex?.data?.id !== 'pumpswap') continue;
        const mint = p.relationships.base_token.data.id.replace(/^solana_/, '');
        found.push({ mint, pool: p.attributes.address, symbol: (p.attributes.name || '?').split(' / ')[0], createdAt: Date.parse(p.attributes.pool_created_at) });
      }
    }
    const ds = await io.getJSON('https://api.dexscreener.com/latest/dex/search?q=pumpswap', { retries: 0, timeoutMs: 8000 });
    for (const p of ds.data?.pairs || []) if (p.chainId === 'solana' && p.dexId === 'pumpswap' && p.quoteToken?.address === SOL_MINT) found.push({ mint: p.baseToken.address, pool: p.pairAddress, symbol: p.baseToken.symbol, createdAt: p.pairCreatedAt });
    let added = 0;
    for (const f of found) {
      if (P.seen[f.pool]) continue;
      P.seen[f.pool] = now();
      if (!Number.isFinite(f.createdAt) || now() - f.createdAt > cfg.max_minutes_since_migration * 60_000) continue; // older than the niche window (or no date): not ours, not counted
      P.queue.push({ ...f, t0: now() }); P.stats.detected++; added++; P.stats.bySource = { ...(P.stats.bySource || {}), [f.src || 'api']: ((P.stats.bySource || {})[f.src || 'api'] || 0) + 1 };
    }
    for (const [k, t] of Object.entries(P.seen)) if (now() - t > 6 * 3.6e6) delete P.seen[k];
    if (P.queue.length > 12) for (const t of P.queue.splice(0, P.queue.length - 12)) skip(t, 'R14', 'queue full: too stale by the time we could read it');
    dirty('pb');
    return added ? `pb_discover +${added}` : 'pb_discover';
  }

  // ---------- (b)-(e) build the cluster a few calls at a time, then decide
  async function buildStep(budget = 8) {
    if (!P.build) {
      const tok = P.queue.shift();
      if (!tok) return 'pb_idle';
      const risk = decide(riskChecks({ killSwitch: killSwitchOn(), openInsider: insiderOpen().length, holdingMint: st.positions.some((p) => p.mint === tok.mint) }, cfg));
      if (!risk.ok) { skip(tok, risk.failed.code, risk.failed.note); return 'pb_skip'; }
      P.build = newBuild({ mint: tok.mint, pool: tok.pool, symbol: tok.symbol, t0: tok.t0, migrationSig: tok.migrationSig || null, migratedAt: tok.migrationSig ? tok.createdAt : null });
    }
    const b = P.build;
    await stepBuild(b, rio, cfg, budget);
    dirty('pb');
    if (b.stage === 'fail') {
      P.build = null; P.stats.built++;
      if (b.fail.code !== 'R14' && b.migratedAt) label(b, null, 'skipped', b.fail.code);
      skip(b, b.fail.code, b.fail.note, { calls: b.calls });
      return 'pb_skip';
    }
    if (b.stage !== 'done') return `pb_build:${b.stage}`;
    P.build = null; P.stats.built++;
    return decideToken(b);
  }

  function label(b, res, decision, reason) {
    const px = res?.priceSol && solUsd ? res.priceSol * solUsd : null;
    trackToken(S.labels, { mint: b.mint, symbol: b.symbol, pool: b.pool, t0: b.t0, price0: px, liq0: res ? liquidityUsd(res.reserves, solUsd) : null, share0: res?.clusterPct ?? null,
      deployer: b.deployer, deployerFunder: res?.cluster?.deployerFunder || b.wallets?.[b.deployer]?.funder || null, decision, reason });
    if (res?.tokenAccounts) {
      P.shareRefs[b.mint] = { tas: Object.entries(res.tokenAccounts).slice(0, 40), supply: res.supply };
      const keys = Object.keys(P.shareRefs); if (keys.length > 300) delete P.shareRefs[keys[0]];
    }
    dirty('labels');
  }

  async function decideToken(b) {
    const res = b.result;
    await sol();
    const [rc, gp] = await Promise.all([io.rugcheck(b.mint).catch(() => null), io.goplus(b.mint).catch(() => null)]);
    const lp2 = rc?.markets?.find((m) => m.pubkey === b.pool)?.lp?.lpLockedPct ?? null;
    // R7 sell simulation: small buy then sell, both live Jupiter quotes
    let sim;
    const lam = Math.round((cfg.sim_test_usd / (solUsd || 1)) * 1e9);
    const qb = solUsd ? await io.quote(SOL_MINT, b.mint, lam, cfg.max_exit_slippage_bps) : { failed: 'api_error' };
    if (qb.failed) sim = qb.failed === 'api_error' ? { unknown: true, reason: 'quote API busy' } : { ok: false, reason: 'no buy route' };
    else {
      const qs = await io.quote(b.mint, SOL_MINT, qb.outAmount, cfg.max_exit_slippage_bps);
      if (qs.failed) sim = qs.failed === 'api_error' ? { unknown: true, reason: 'quote API busy' } : { ok: false, reason: "CAN'T SELL: no sell route" };
      else sim = { ok: true, roundTripLossPct: +((1 - Number(qs.outAmount) / lam) * 100).toFixed(2) };
    }
    const so = secondOpinion({ goplus: gp, rugcheck: rc });
    const wash = new Set(b.sells.map((x) => x.wallet).filter((w) => b.buys.some((y) => y.wallet === w))).size;
    const checks = [
      ...rugChecks({ res, sim, lp2, solUsd }, cfg), so.check,
      ...manipulationChecks({ symbol: b.symbol, recentSymbols: P.symbols, deployer: b.deployer, deployerFunder: res.cluster.deployerFunder, rugDeployers: new Set(P.rugDeployers), earlyWash: wash, now: now() }, cfg),
    ];
    P.symbols[String(b.symbol).toLowerCase()] = now();
    for (const [k, t] of Object.entries(P.symbols)) if (now() - t > cfg.copycat_block_minutes * 60_000) delete P.symbols[k];
    const d = decide(checks);
    const summary = checks.map((c) => `${c.code} ${c.status}${c.value != null ? ` ${c.value}` : ''}`).join(' · ');
    if (!d.ok) { label(b, res, 'skipped', d.failed.code); skip(b, d.failed.code, `${d.failed.note || d.failed.value} · ${why(d.failed.code)}`, { checks: summary, cluster: res.cluster.size, share: res.clusterPct }); return 'pb_skip'; }

    // (e) size + execution caps
    const trades = st.closed.filter((t) => t.strategy === 'insider');
    const size = sizeInsider({ equity: equity(st), cash: st.cash, poolSol: res.reserves.sol, solUsd, kellyPct: kellyCapPct(trades, cfg) }, cfg);
    const lamports = Math.round((size.sizeUsd / solUsd) * 1e9);
    const q = lamports > 0 ? await io.quote(SOL_MINT, b.mint, lamports, cfg.max_slippage_bps) : { failed: 'size' };
    const fee = await estimateFeeSol(rio, b.pool, cfg);
    const ex = execChecks({ impactBps: q.failed ? null : Math.round(Number(q.priceImpactPct || 0) * 1e4), feeSol: fee.feeSol }, cfg);
    const dx = decide(ex);
    if (!dx.ok || size.sizeUsd < 0.5) { label(b, res, 'skipped', dx.failed?.code || 'size'); skip(b, dx.failed?.code || 'size', dx.failed ? `${dx.failed.note || dx.failed.value} · ${why(dx.failed.code)}` : `size $${size.sizeUsd} too small`); return 'pb_skip'; }

    // paper buy, pessimistic (9.4): the live quote, minus priority fee + tip, minus a sandwich haircut
    const dec = res.mintInfo.decimals ?? 6;
    const tokens = Number(q.outAmount) / 10 ** dec;
    const costs = paperCostUsd({ sizeUsd: size.sizeUsd, feeSol: fee.feeSol, solUsd }, cfg);
    const spent = size.sizeUsd + costs;
    const entryPrice = spent / tokens;
    const alertId = `A${String(++P.alertSeq).padStart(4, '0')}`;
    const id = `X${String(st.closed.filter((t) => t.strategy === 'insider').length + insiderOpen().length + 1).padStart(3, '0')}`;
    const pos = {
      id, strategy: 'insider', mint: b.mint, symbol: b.symbol, url: `https://dexscreener.com/solana/${b.pool}`, decimals: dec,
      entryAt: new Date(now()).toISOString(), entryPrice, sizeUsd: spent, riskUsd: spent * (cfg.trailing_stop_pct / 100),
      tokens, tokensOriginal: tokens, realizedUsd: 0, markUsd: tokens * res.priceSol * solUsd, lastPrice: res.priceSol * solUsd,
      stopPrice: entryPrice * (1 - cfg.trailing_stop_pct / 100), peakPrice: entryPrice, trailing: true, tpDone: [], score: null,
      why: { checks: summary, cluster: `${res.cluster.size} wallets hold ${res.clusterPct?.toFixed(2)}%`, size: `${size.limit}: $${size.sizeUsd}`, costs: `$${costs.toFixed(4)} fees+tip+haircut`, fee },
      pb: { pool: b.pool, alertId, t0: b.t0, latencyMs: now() - b.t0, deployer: b.deployer, baseVault: b.poolInfo.baseVault, quoteVault: b.poolInfo.quoteVault, lpMint: b.poolInfo.lpMint,
        supply: res.supply, members: [...res.cluster.members.keys()], tokenAccounts: res.tokenAccounts, lastBal: { ...(res.taBal || {}) }, checkedSigs: [], shareHist: [[now(), res.clusterPct]], tpDone: [], warned: 0, sellFails: 0,
        entry: { lpSupply: b.poolInfo.lpSupply, deployerBal: res.deployerBal, clusterBal: res.clusterBal, clusterShare: res.clusterPct }, minSinceMigration: b.minutesSinceMigration },
    };
    st.cash -= spent; st.positions.push(pos);
    P.latency.push(pos.pb.latencyMs); if (P.latency.length > 500) P.latency.shift();
    P.stats.entered++;
    label(b, res, 'traded', 'entered');
    P.recent.unshift({ at: now(), sym: b.symbol, mint: b.mint, d: 'buy', code: 'BUY', note: `$${spent.toFixed(2)} · cluster ${res.cluster.size} wallets ${res.clusterPct?.toFixed(1)}%` });
    ev('buy', { pos: { ...pos, pb: undefined } }, `▲ INSIDER PAPER BUY ${id} $${b.symbol} $${spent.toFixed(2)} @ $${entryPrice.toPrecision(4)} · ${summary.slice(0, 160)}`);
    notify('buy', signalText({ type: 'ENTRY', alertId, at: now(), slot: b.creation?.slot, name: b.symbol, symbol: b.symbol, mint: b.mint, pool: b.pool, priceSol: res.priceSol, priceUsd: res.priceSol * solUsd,
      mcapUsd: res.priceSol * solUsd * Number(res.supply) / 10 ** dec, liqUsd: liquidityUsd(res.reserves, solUsd), minSinceMigration: b.minutesSinceMigration,
      filters: filtersOf(checks), clusterWallets: res.cluster.size, clusterShare: res.clusterPct, clusterChange5m: 0, sizePct: (spent / equity(st)) * 100 }));
    P.timers.nextMonitor = now();
    dirty('pb', 'desk');
    return 'pb_buy';
  }
  const filtersOf = (checks) => Object.fromEntries([['mint', 'R1'], ['freeze', 'R2'], ['lp', 'R3'], ['top10', 'R4'], ['cluster', 'R5'], ['sim', 'R7']].map(([k, c]) => { const x = checks.find((y) => y.code === c); return [k, x ? `${x.status}${x.value != null ? ` ${x.value}` : ''}` : 'n/a']; }));

  // ---------- (f) one read per position: reserves, LP, authorities, deployer + cluster balances
  async function observe(pos) {
    const pb = pos.pb;
    const tas = Object.keys(pb.tokenAccounts).slice(0, 94);
    const keys = [pb.pool, pb.baseVault, pb.quoteVault, pos.mint, pb.lpMint, ...tas];
    const r = await rio.rpc('getMultipleAccounts', [keys, { encoding: 'jsonParsed' }], { priority: true });
    const v = r.value;
    const at = now();
    if (!v[0]) return { at, poolGone: true };
    const raw = Array.isArray(v[0].data) ? v[0].data[0] : null;
    let lpSupply = null;
    if (raw) { const d = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) + BigInt(d[203 + i]); lpSupply = x.toString(); }
    const tok = Number(v[1]?.data?.parsed?.info?.tokenAmount?.amount || 0) / 10 ** pos.decimals;
    const solR = Number(v[2]?.data?.parsed?.info?.tokenAmount?.amount || 0) / 1e9;
    const mi = v[3]?.data?.parsed?.info || {};
    const bal = {}; let clusterBal = 0, deployerBal = 0;
    tas.forEach((ta, i) => { const a = Number(v[5 + i]?.data?.parsed?.info?.tokenAmount?.amount || 0); bal[ta] = a; clusterBal += a; if (pb.tokenAccounts[ta] === pb.deployer) deployerBal += a; });
    if (!solUsd) await sol();
    return { at, priceSol: tok > 0 ? solR / tok : 0, price: tok > 0 ? (solR / tok) * solUsd : 0, solReserve: solR, lpSupply, lpMintSupply: v[4]?.data?.parsed?.info?.supply ?? null,
      mintAuthority: mi.mintAuthority ?? null, freezeAuthority: mi.freezeAuthority ?? null, bal, clusterBal, deployerBal, clusterShare: (clusterBal / Number(pb.supply)) * 100 };
  }

  // wallet splitting (step f / 9.1 E): a cluster token account dropped -> read its newest tx; a non-pool recipient joins the cluster
  async function followSplits(pos, obs) {
    const pb = pos.pb; let added = 0, looked = 0;
    for (const [ta, a] of Object.entries(obs.bal)) {
      const before = pb.lastBal[ta];
      if (before == null || a >= before || looked >= 2) continue;
      looked++;
      const sigs = await rio.rpc('getSignaturesForAddress', [ta, { limit: 2 }], { priority: true });
      for (const s of sigs) {
        if (pb.checkedSigs.includes(s.signature)) continue;
        pb.checkedSigs.push(s.signature); if (pb.checkedSigs.length > 50) pb.checkedSigs.shift();
        const tx = await rio.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }], { priority: true });
        if (!tx) continue;
        for (const [owner, d] of Object.entries(tokenDeltas(tx, pos.mint))) {
          if (d.delta <= 0n || owner === pb.pool || BURN_OWNERS.has(owner) || pb.tokenAccounts[d.ta]) continue;
          pb.tokenAccounts[d.ta] = owner; if (!pb.members.includes(owner)) pb.members.push(owner);
          obs.bal[d.ta] = Number(d.post); obs.clusterBal += Number(d.post); added++;
        }
      }
    }
    if (added) obs.clusterShare = (obs.clusterBal / Number(pb.supply)) * 100;
    return added;
  }

  async function exitFill(pos, qty) {
    const raw = BigInt(Math.floor(qty * 10 ** pos.decimals)).toString();
    let q = null;
    for (let i = 0; i < 2 && (!q || q.failed); i++) q = await io.quote(pos.mint, SOL_MINT, raw, cfg.max_exit_slippage_bps);
    const fee = await estimateFeeSol(rio, pos.pb.pool, cfg);
    let gross, source;
    if (q && !q.failed) { gross = (Number(q.outAmount) / 1e9) * solUsd; source = 'jupiter sell quote'; }
    else { // "a sell fails twice": price it at the pool minus the full exit slippage cap, and tell a human
      pos.pb.sellFails++;
      gross = qty * (pos.lastPrice || 0) * (1 - cfg.max_exit_slippage_bps / 1e4); source = 'sell quote failed twice: pool price minus max exit slippage';
      notify('emergency', `⚠️ insider lane: sell quote for $${pos.symbol} failed twice. paper-filled at pool price minus ${cfg.max_exit_slippage_bps / 100}%. check it`);
    }
    const net = Math.max(0, gross - paperCostUsd({ sizeUsd: gross, feeSol: fee.feeSol ?? cfg.max_priority_fee, solUsd }, cfg));
    return { price: net / qty, source };
  }

  async function act(pos, t, obs) {
    const qty = Math.min(pos.tokens, t.ofOriginal ? pos.tokensOriginal * t.fraction : pos.tokens * t.fraction);
    const f = await exitFill(pos, qty);
    const feeAdj = 1 - config.risk.paperFeePct / 100; // sellPaper takes the desk's flat paper fee; our costs are already in f.price
    const { fill, trade } = sellPaper(st, pos, t.ofOriginal ? t.fraction : t.fraction, f.price / feeAdj, `${t.code} ${t.reason}`, config, { ofOriginal: t.ofOriginal });
    if (t.code === 'E7') pos.pb.tpDone.push(t.rung);
    const base = { alertId: `A${String(++P.alertSeq).padStart(4, '0')}`, entryAlertId: pos.pb.alertId, at: now(), name: pos.symbol, symbol: pos.symbol, mint: pos.mint, pool: pos.pb.pool,
      priceSol: obs.priceSol, priceUsd: obs.price, liqUsd: obs.solReserve * 2 * solUsd, minSinceMigration: (pos.pb.minSinceMigration || 0) + (now() - Date.parse(pos.entryAt)) / 60000,
      clusterWallets: pos.pb.members.length, clusterShare: obs.clusterShare, clusterChange5m: change5m(pos, obs), code: t.code, multiple: f.price / pos.entryPrice, note: `${t.reason} · fill: ${f.source}` };
    if (trade) {
      Object.assign(trade, { strategy: 'insider', code: t.code, peakPrice: pos.peakPrice, exitSource: f.source, latencyMs: pos.pb.latencyMs });
      P.recent.unshift({ at: now(), sym: pos.symbol, mint: pos.mint, d: 'sell', code: t.code, note: `${trade.pnlPct}% · ${t.reason}` });
      ev('sell', { trade }, `▼ INSIDER PAPER SELL ${trade.id} $${pos.symbol} ${trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(trade.pnlUsd).toFixed(2)} (${trade.pnlPct}%) · ${t.code} ${t.reason}`);
      notify(t.code === 'E1' || t.code === 'E2' || t.code === 'E3' ? 'emergency' : 'sell', signalText({ type: 'EXIT', ...base }));
    } else {
      ev('sell', { fill }, `▼ INSIDER PAPER SELL ${pos.id} $${pos.symbol} part: ${t.reason}`);
      notify('take_profit', signalText({ type: 'TAKE_PROFIT', ...base }));
    }
    dirty('desk', 'pb');
  }
  const change5m = (pos, obs) => { const old = (pos.pb.shareHist || []).find(([t]) => t >= obs.at - 300_000); return old ? obs.clusterShare - old[1] : null; };

  async function killAll(reason) {
    for (const pos of [...st.positions]) {
      if (pos.strategy === 'insider') { const obs = await observe(pos).catch(() => ({ at: now(), price: pos.lastPrice })); await act(pos, { code: 'E1', action: 'SELL_ALL', fraction: 1, reason }, obs); continue; }
      const f = await exitFill(pos, pos.tokens).catch(() => ({ price: pos.lastPrice }));
      const { trade } = sellPaper(st, pos, 1, f.price / (1 - config.risk.paperFeePct / 100), `E1 ${reason}`, config);
      if (trade) ev('sell', { trade }, `▼ PAPER SELL ${trade.id} $${pos.symbol} E1 kill switch`);
    }
    if (P.killDays[st.day]) P.killDays[st.day].fired = true;
    notify('freeze', `🛑 kill switch (E1): ${reason}. everything sold (paper), no new entries until tomorrow (UTC)`);
  }

  async function monitorOnce() {
    const t0 = now();
    for (const pos of insiderOpen()) {
      let obs;
      try { obs = await observe(pos); } catch (e) { ev('warn', {}, `insider monitor: ${String(e.message).slice(0, 80)}`); continue; }
      if (!obs.poolGone) {
        await followSplits(pos, obs).catch(() => 0);
        pos.lastPrice = obs.price; pos.markUsd = pos.tokens * obs.price; pos.lastCheckAt = obs.at;
        pos.peakPrice = Math.max(pos.peakPrice, obs.price); pos.stopPrice = Math.max(pos.stopPrice, pos.peakPrice * (1 - cfg.trailing_stop_pct / 100));
      }
      const killed = killSwitchOn();
      const t = firstTrigger(pos, obs, cfg, { dayLossPct: dayLossPct() });
      if (!obs.poolGone) { pos.pb.lastBal = obs.bal; pos.pb.shareHist.push([obs.at, obs.clusterShare]); pos.pb.shareHist = pos.pb.shareHist.filter(([x]) => x >= obs.at - 330_000); }
      if (t.warn && pos.pb.warned < 3 && !t.code) {
        const lvl = Math.floor(parseFloat(t.warn.match(/[\d.]+/)?.[0] || 0) / 5);
        if (lvl > (pos.pb.warnLvl ?? -1)) { pos.pb.warnLvl = lvl; pos.pb.warned++; notify('pb_warn', signalText({ type: 'WARNING', alertId: `A${String(++P.alertSeq).padStart(4, '0')}`, entryAlertId: pos.pb.alertId, at: now(), symbol: pos.symbol, name: pos.symbol, mint: pos.mint, pool: pos.pb.pool, priceSol: obs.priceSol, priceUsd: obs.price, liqUsd: obs.solReserve * 2 * solUsd, clusterWallets: pos.pb.members.length, clusterShare: obs.clusterShare, clusterChange5m: change5m(pos, obs), note: t.warn })); }
      }
      if (t.code === 'E1' || (killed && t.code)) { await killAll(t.reason); break; }
      if (t.action !== 'HOLD') await act(pos, t, obs);
      dirty('desk', 'pb');
    }
    P.cpuMs.push(now() - t0); if (P.cpuMs.length > 50) P.cpuMs.shift();
  }

  async function monitor(burst = 1) {
    for (let i = 0; i < burst && insiderOpen().length; i++) {
      if (i) await sleep(cfg.monitor_every_s * 1000);
      await monitorOnce();
    }
    P.timers.nextMonitor = now() + cfg.monitor_every_s * 1000;
    return 'pb_monitor';
  }

  // ---------- (h) labels at +5m/+15m/+30m/+1h/+24h for every token seen
  async function labelsStep() {
    P.timers.nextLabels = now() + 60_000;
    const due = dueMints(S.labels, now(), cfg.label_checks_min).slice(0, 30);
    if (!due.length) return 'pb_labels';
    const r = await io.getJSON(`https://api.dexscreener.com/tokens/v1/solana/${[...new Set(due.map((x) => x.mint))].join(',')}`, { retries: 1, timeoutMs: 8000 });
    if (!r.ok) return 'pb_labels';
    const best = {};
    for (const p of r.data || []) { const m = p.baseToken?.address; const l = Number(p.liquidity?.usd) || 0; if (!best[m] || l > best[m].liq) best[m] = { liq: l, price: Number(p.priceUsd) || 0 }; }
    let shareReads = 0;
    for (const { mint, k } of due) {
      const it = S.labels.items[mint];
      let share = null;
      const ref = P.shareRefs[mint];
      if ((k === 60 || k === 1440) && ref && shareReads < 3) {
        shareReads++;
        try { const g = await rio.rpc('getMultipleAccounts', [ref.tas.map(([ta]) => ta), { encoding: 'jsonParsed' }]); share = (g.value.reduce((s, a) => s + Number(a?.data?.parsed?.info?.tokenAmount?.amount || 0), 0) / Number(ref.supply)) * 100; } catch { /* null */ }
      }
      applySample(it, { k, at: now(), price: best[mint]?.price ?? null, liq: best[mint]?.liq ?? null, share });
      const l = it.label || it.label1h;
      if (l === 'RUG') for (const w of [it.dep, it.fun]) if (w && !P.rugDeployers.includes(w)) { P.rugDeployers.push(w); if (P.rugDeployers.length > 500) P.rugDeployers.shift(); }
    }
    dirty('labels', 'pb');
    return 'pb_labels';
  }

  function metrics() {
    const trades = st.closed.filter((t) => t.strategy === 'insider');
    const days = Object.keys(S.curve?.length ? Object.fromEntries(S.curve.map((p) => [new Date(p.t).toISOString().slice(0, 10), 1])) : {}).length;
    const kd = Object.values(P.killDays);
    return evaluate({ trades, curve: S.curve || [], book: S.labels, latenciesMs: P.latency, killSwitchDays: { hit: kd.filter((x) => x.hit).length, fired: kd.filter((x) => x.fired).length }, days }, cfg);
  }

  function reportLines() {
    const sk = Object.entries(P.skips).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    const ls = labelSummary(S.labels);
    const m = metrics();
    const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet';
    return [
      '🕵️ insider-exit lane (training pack §9, paper)',
      `fresh graduates detected ${P.stats.detected} · fully traced ${P.stats.built} · entered ${P.stats.entered}`,
      `skips by rule: ${sk}`,
      `labels (skipped): ${fmt(ls.skipped)} · (traded): ${fmt(ls.traded)} · filter value ${ls.filterValuePct ?? 'n/a'}% of skips later RUG`,
      `trades ${m.trades} · win ${m.winRatePct ?? 'n/a'}% · avg ${m.avgPnlPct ?? 'n/a'}% · max DD ${m.maxDrawdownPct}% · rug-exit ${m.rugExitRatePct ?? 'n/a'}% · latency median ${m.latencyMedianMs ?? 'n/a'} ms`,
      `go/no-go for real money: ${m.go ? 'GO' : 'NO-GO'} (${m.goNoGo.filter((x) => x.pass).length}/6 bars)`,
    ];
  }

  return {
    discover, buildStep, monitor, labelsStep, metrics, reportLines, killAll, observe, state: P,
    monitorDue: () => insiderOpen().length > 0 && now() >= P.timers.nextMonitor,
    buildDue: () => Boolean(P.build || P.queue.length),
    discoverDue: () => now() >= P.timers.nextDiscover,
    labelsDue: () => now() >= P.timers.nextLabels,
    nextAt: () => Math.min(insiderOpen().length ? P.timers.nextMonitor : Infinity, P.build || P.queue.length ? now() + 300 : Infinity, P.timers.nextDiscover, P.timers.nextLabels),
  };
}
