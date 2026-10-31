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
import { makeRpc, bindKeyedLedger, chargeKeyed, jitoBundleOf, jitoBundleTxs, jitoTipFloorSol, tokenDeltas, BURN_OWNERS, PUMPSWAP_PROGRAM } from './solana.js';
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
import { equity, rollDay, newState } from '../desk/risk.js';
import { keysOf, tradeOf, recordSmartTrade, pruneSmartTrades, copyTrigger, smartExited, short } from './smart.js';
import { sellPaper } from '../desk/executor.js';

export function newPlaybookState() {
  return { seen: {}, queue: [], build: null, recent: [], skips: {}, stats: { detected: 0, built: 0, entered: 0, skipped: 0, rpcCalls: 0 },
    latency: [], symbols: {}, rugDeployers: [], shareRefs: {}, alertSeq: 0, killDays: {}, killSwitch: null, cpuMs: [],
    timers: { nextDiscover: 0, nextMonitor: 0, nextLabels: 0, nextAlerts: 0 },
    alerts: { sent: [], perCoin: {}, watch: {}, suppressed: 0, n: 0 }, copyQueue: [] };
}

// the copy lane's own paper book (her ask Oct 31: "copy smart wallets", kept apart from the 14-day test numbers)
export function newCopyState(config) {
  return { book: newState(config), buys: {}, sells: {}, fired: {}, recent: [], skips: {}, stats: { signals: 0, built: 0, entered: 0, skipped: 0, events: 0 }, startedAt: Date.now() };
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
  P.alerts ||= { sent: [], perCoin: {}, watch: {}, suppressed: 0, n: 0 }; P.copyQueue ||= []; P.timers.nextAlerts ??= 0;
  S.copy ||= newCopyState(config);
  S.smart ||= { list: [], builtAt: null, hook: { day: '', events: 0, disabled: null } };
  const C = S.copy, CB = S.copy.book;
  const ccfg = () => ({ enabled: false, min_wallets: 2, window_min: 15, max_minutes_since_migration: 60, max_open: 3, exit_on_smart_sell: true, min_buy_sol: 0.1, ...(cfg.copy || {}) });
  const acfg = () => ({ enabled: true, crew_buy_pct: 20, watch_min_pct: 10, dump_drop_pts: 5, dump_drop_rel_pct: 30, watch_minutes: 60, watch_every_s: 120, max_watch: 6, max_per_hour: 6, ...(cfg.alerts || {}) });
  const copyOpen = () => CB.positions;
  const bookOf = (pos) => (pos.strategy === 'copy' ? CB : st);
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


  // ====================== feature 2: the COPY lane (paper, own book) ======================
  const copySkip = (tok, code, note, extra = {}) => {
    C.skips[code] = (C.skips[code] || 0) + 1; C.stats.skipped++;
    C.recent.unshift({ at: now(), sym: tok.symbol, mint: tok.mint, d: 'skip', code, note: String(note).slice(0, 140), ...extra }); C.recent.length = Math.min(C.recent.length, 40);
    ev('pb_skip', { mint: tok.mint, code, note, lane: 'copy' }, `◇ COPY SKIP $${tok.symbol} ${code}: ${String(note).slice(0, 110)}`);
    dirty('copy');
  };
  const copyDayLossPct = () => { rollDay(CB); return ((CB.dayStartEquity - equity(CB)) / CB.dayStartEquity) * 100; };

  // the daily list from tools/smart_wallets.mjs (built off-worker). Its Helius credits go on today's shared ledger.
  function setSmartList(body = {}) {
    const list = (body.list || []).filter((x) => typeof x?.w === 'string' && x.w.length >= 32 && x.w.length <= 44).slice(0, 60);
    S.smart = { ...S.smart, list, builtAt: body.builtAt || new Date(now()).toISOString(), counts: body.counts || null, expectedEventsDay: body.expectedEventsDay ?? null,
      winners: (body.winners || []).slice(0, 10), hookId: body.hook?.id ?? S.smart.hookId ?? null, receivedAt: now() };
    S.smart.hook ||= { day: '', events: 0, disabled: null };
    if (body.hook?.ok) S.smart.hook.disabled = null; // a fresh build re-armed the webhook
    if (Number(body.credits) > 0) chargeKeyed(Math.round(Number(body.credits)));
    smartSet = null;
    dirty('smart', 'pb');
    return { ok: true, wallets: list.length };
  }
  let smartSet = null;
  const smartWallets = () => (smartSet ||= new Set((S.smart.list || []).map((x) => x.w)));

  // one pushed tx from the Helius webhook (raw tx). Reads only; may queue one copy candidate.
  function onSmartTx(tx) {
    const set = smartWallets();
    if (!set.size || !tx?.meta) return null;
    const ks = keysOf(tx).filter((k) => set.has(k));
    let queued = null;
    for (const w of new Set(ks)) {
      const t = tradeOf(tx, w, { minSol: 0.01 });
      if (t.side === 'other' || t.side === 'in') continue;
      if (t.side === 'buy' && -t.sol < ccfg().min_buy_sol) continue; // dust buys don't count as a vote
      recordSmartTrade(C, t, w, now());
      dirty('copy');
      if (t.side !== 'buy' || !t.pumpswap) continue;
      const cc = ccfg();
      const trig = copyTrigger(C, t.mint, now(), { minWallets: cc.min_wallets, windowMin: cc.window_min });
      if (!trig) continue;
      C.fired[t.mint] = now(); C.stats.signals++;
      const tok = { mint: t.mint, pool: trig.pool, symbol: t.mint.slice(0, 4), t0: now(), src: 'copy', copy: { ...trig, at: now() } };
      if (!cc.enabled) { copySkip(tok, 'OFF', `${trig.wallets.length} smart wallets bought within ${cc.window_min} min, copy lane is off (/set copyon on)`); continue; }
      if (st.paused) { copySkip(tok, 'PAUSED', 'desk paused by you'); continue; }
      if (P.copyQueue.some((x) => x.mint === t.mint)) continue;
      P.copyQueue.push(tok); if (P.copyQueue.length > 5) copySkip(P.copyQueue.shift(), 'QUEUE', 'copy queue full');
      ev('info', { mint: t.mint, wallets: trig.wallets }, `🧠 COPY SIGNAL ${short(t.mint)}: ${trig.wallets.length} smart wallets bought ${trig.sol} SOL within ${cc.window_min} min`);
      queued = tok; dirty('pb');
    }
    pruneSmartTrades(C, now());
    return queued;
  }

  function copyMetrics() {
    const tr = CB.closed;
    const wins = tr.filter((t) => t.pnlUsd > 0).length;
    const pnl = tr.reduce((s, t) => s + t.pnlUsd, 0);
    return { trades: tr.length, wins, winRatePct: tr.length ? +((wins / tr.length) * 100).toFixed(1) : null, pnlUsd: +pnl.toFixed(2), avgPct: tr.length ? +(tr.reduce((s, t) => s + t.pnlPct, 0) / tr.length).toFixed(2) : null,
      balance: +equity(CB).toFixed(2), start: CB.startBalance, open: CB.positions.length };
  }
  function copyLines() {
    const m = copyMetrics(), sm = S.smart || {};
    const sk = Object.entries(C.skips).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    return [
      `🧠 copy lane (smart wallets, paper, own $${m.start} book, NOT in the 14-day numbers) · ${ccfg().enabled ? 'on' : 'off'}`,
      `list: ${(sm.list || []).length} wallets · built ${sm.builtAt ? String(sm.builtAt).slice(0, 16).replace('T', ' ') + ' utc' : 'never'} · pushes today ${sm.hook?.events ?? 0}${sm.hook?.disabled ? ' (webhook paused: daily budget)' : ''}`,
      `signals ${C.stats.signals} · checked ${C.stats.built} · copied ${C.stats.entered} · skips: ${sk}`,
      `trades ${m.trades} · win ${m.winRatePct ?? 'n/a'}% · pnl ${m.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(m.pnlUsd).toFixed(2)} · balance $${m.balance} · open ${m.open}`,
    ];
  }

  // ====================== feature 1: insider ALERTS (rate-limited) ======================
  // what the lane already reads (the dev's linked wallets and their share) turned into ONE concise Telegram line.
  // "dev crew" = wallets linked to the deployer by funding / same slot / same bundle / transfers (cluster.js).
  // That link is an inference from on-chain patterns, not proof the same person controls them.
  function alertAllowedNow(mint, kind) {
    const a = acfg(), A = P.alerts;
    if (a.enabled === false) return false;
    const pc = (A.perCoin[mint] ||= {});
    if (pc[kind]) return false; // dedupe: one alert per coin per kind
    A.sent = A.sent.filter((t) => now() - t < 3.6e6);
    if (A.sent.length >= a.max_per_hour) { A.suppressed++; return false; }
    return true;
  }
  function crewAlert(kind, x) {
    if (!alertAllowedNow(x.mint, kind)) return false;
    const A = P.alerts; A.sent.push(now()); A.perCoin[x.mint][kind] = now(); A.n++;
    for (const [m, v] of Object.entries(A.perCoin)) if (now() - Math.max(...Object.values(v), 0) > 24 * 3.6e6) delete A.perCoin[m];
    const link = `https://dexscreener.com/solana/${x.pool || x.mint}`;
    const text = kind === 'buy'
      ? [`🚨 dev crew loading $${x.symbol}`, `${x.wallets} wallets linked to the dev hold ${x.share.toFixed(1)}% of supply${x.share > cfg.max_cluster_share_pct ? ` (over the ${cfg.max_cluster_share_pct}% cap)` : ''}`,
        `mint ${short(x.mint)} · ${x.min != null ? `${Number(x.min).toFixed(1)} min after graduation` : 'fresh graduate'}`, link, 'linked = on-chain pattern, not proof · paper desk']
      : [`🔻 dev crew dumping $${x.symbol}`, `linked wallets: ${x.from.toFixed(1)}% → ${x.to.toFixed(1)}% of supply in ${Math.max(1, Math.round(x.mins))} min`,
        `mint ${short(x.mint)}`, link, 'linked = on-chain pattern, not proof · paper desk'];
    notify('insider_alert', text.join('\n'));
    ev('info', { kind, mint: x.mint }, `🚨 INSIDER ALERT ${kind} $${x.symbol} ${kind === 'buy' ? x.share.toFixed(1) + '%' : `${x.from.toFixed(1)}%→${x.to.toFixed(1)}%`}`);
    dirty('pb');
    return true;
  }
  function crewBuyCheck(b, res) {
    const a = acfg();
    if (a.enabled === false || res?.clusterPct == null) return;
    const share = res.clusterPct;
    if (share >= a.crew_buy_pct) crewAlert('buy', { mint: b.mint, pool: b.pool, symbol: b.symbol, share, wallets: res.cluster?.size ?? 0, min: b.minutesSinceMigration });
    // watch it for a dump (one getMultipleAccounts per look, counted on the shared Helius ledger)
    if (share >= a.watch_min_pct && res.tokenAccounts && Object.keys(P.alerts.watch).length < a.max_watch) {
      P.alerts.watch[b.mint] = { symbol: b.symbol, pool: b.pool, tas: Object.keys(res.tokenAccounts).slice(0, 60), supply: String(res.supply), share0: share, peak: share, at: now(), until: now() + a.watch_minutes * 60_000 };
    }
  }
  async function alertsStep() {
    const a = acfg();
    P.timers.nextAlerts = now() + a.watch_every_s * 1000;
    const W = P.alerts.watch;
    for (const [m, w] of Object.entries(W)) if (now() > w.until) delete W[m];
    if (a.enabled === false) return 'alerts_off';
    let looked = 0;
    for (const [mint, w] of Object.entries(W)) {
      if (looked >= 3) break;
      looked++;
      let share;
      try {
        const g = await rio.rpc('getMultipleAccounts', [w.tas, { encoding: 'jsonParsed' }]);
        share = (g.value.reduce((s, x) => s + Number(x?.data?.parsed?.info?.tokenAmount?.amount || 0), 0) / Number(w.supply)) * 100;
      } catch { continue; }
      w.peak = Math.max(w.peak, share);
      const drop = w.peak - share;
      if (drop >= a.dump_drop_pts || (w.peak > 0 && drop / w.peak * 100 >= a.dump_drop_rel_pct && drop >= 1)) {
        crewAlert('dump', { mint, pool: w.pool, symbol: w.symbol, from: w.peak, to: share, mins: (now() - w.at) / 60000 });
        delete W[mint];
      }
    }
    dirty('pb');
    return 'alerts_watch';
  }

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
      const fromCopy = ccfg().enabled && P.copyQueue.length > 0; // a copy signal is minutes old already: it goes first
      const tok = fromCopy ? P.copyQueue.shift() : P.queue.shift();
      if (!tok) return 'pb_idle';
      if (fromCopy) {
        const cc = ccfg();
        const risk = decide(riskChecks({ killSwitch: null, openInsider: copyOpen().length, holdingMint: CB.positions.some((p) => p.mint === tok.mint) }, { ...cfg, max_open_positions: cc.max_open }));
        if (!risk.ok) { copySkip(tok, risk.failed.code, risk.failed.note); return 'copy_skip'; }
        if (!tok.pool) { copySkip(tok, 'R14', 'no PumpSwap pool in the smart wallets\' buys: not a graduate'); return 'copy_skip'; }
      } else {
        const risk = decide(riskChecks({ killSwitch: killSwitchOn(), openInsider: insiderOpen().length, holdingMint: st.positions.some((p) => p.mint === tok.mint) }, cfg));
        if (!risk.ok) { skip(tok, risk.failed.code, risk.failed.note); return 'pb_skip'; }
      }
      P.build = newBuild({ mint: tok.mint, pool: tok.pool, symbol: tok.symbol, t0: tok.t0, migrationSig: tok.migrationSig || null, migratedAt: tok.migrationSig ? tok.createdAt : null });
      if (fromCopy) P.build.copy = tok.copy;
    }
    const b = P.build;
    // copy candidates may be older than the insider niche (10 min): the smart wallets often buy a bit later
    await stepBuild(b, rio, b.copy ? { ...cfg, max_minutes_since_migration: ccfg().max_minutes_since_migration } : cfg, budget);
    dirty('pb');
    if (b.stage === 'fail') {
      P.build = null;
      if (b.copy) { C.stats.built++; copySkip(b, b.fail.code, b.fail.note); return 'copy_skip'; }
      P.stats.built++;
      if (b.fail.code !== 'R14' && b.migratedAt) label(b, null, 'skipped', b.fail.code);
      skip(b, b.fail.code, b.fail.note, { calls: b.calls });
      return 'pb_skip';
    }
    if (b.stage !== 'done') return `pb_build:${b.stage}`;
    P.build = null;
    if (b.copy) C.stats.built++; else P.stats.built++;
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
    if (!b.copy) crewBuyCheck(b, res); // feature 1: a dev crew holding a big share of a fresh coin -> one alert (rate-limited)
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
      ...manipulationChecks({ symbol: b.symbol, recentSymbols: b.copy ? {} : P.symbols, /* copy: the insider lane may have seen this very coin */ deployer: b.deployer, deployerFunder: res.cluster.deployerFunder, rugDeployers: new Set(P.rugDeployers), earlyWash: wash, now: now() }, cfg),
    ];
    if (!b.copy) P.symbols[String(b.symbol).toLowerCase()] = now();
    for (const [k, t] of Object.entries(P.symbols)) if (now() - t > cfg.copycat_block_minutes * 60_000) delete P.symbols[k];
    const d = decide(checks);
    const summary = checks.map((c) => `${c.code} ${c.status}${c.value != null ? ` ${c.value}` : ''}`).join(' · ');
    if (!d.ok && b.copy) { copySkip(b, d.failed.code, `${d.failed.note || d.failed.value} · ${why(d.failed.code)}`, { checks: summary }); return 'copy_skip'; }
    if (!d.ok) { label(b, res, 'skipped', d.failed.code); skip(b, d.failed.code, `${d.failed.note || d.failed.value} · ${why(d.failed.code)}`, { checks: summary, cluster: res.cluster.size, share: res.clusterPct }); return 'pb_skip'; }

    // (e) size + execution caps
    const book = b.copy ? CB : st, strat = b.copy ? 'copy' : 'insider';
    const trades = book.closed.filter((t) => t.strategy === strat);
    const size = sizeInsider({ equity: equity(book), cash: book.cash, poolSol: res.reserves.sol, solUsd, kellyPct: kellyCapPct(trades, cfg) }, cfg);
    const lamports = Math.round((size.sizeUsd / solUsd) * 1e9);
    const q = lamports > 0 ? await io.quote(SOL_MINT, b.mint, lamports, cfg.max_slippage_bps) : { failed: 'size' };
    const fee = await estimateFeeSol(rio, b.pool, cfg);
    const ex = execChecks({ impactBps: q.failed ? null : Math.round(Number(q.priceImpactPct || 0) * 1e4), feeSol: fee.feeSol }, cfg);
    const dx = decide(ex);
    if ((!dx.ok || size.sizeUsd < 0.5) && b.copy) { copySkip(b, dx.failed?.code || 'size', dx.failed ? `${dx.failed.note || dx.failed.value}` : `size $${size.sizeUsd} too small`); return 'copy_skip'; }
    if (!dx.ok || size.sizeUsd < 0.5) { label(b, res, 'skipped', dx.failed?.code || 'size'); skip(b, dx.failed?.code || 'size', dx.failed ? `${dx.failed.note || dx.failed.value} · ${why(dx.failed.code)}` : `size $${size.sizeUsd} too small`); return 'pb_skip'; }

    // paper buy, pessimistic (9.4): the live quote, minus priority fee + tip, minus a sandwich haircut
    const dec = res.mintInfo.decimals ?? 6;
    const tokens = Number(q.outAmount) / 10 ** dec;
    const costs = paperCostUsd({ sizeUsd: size.sizeUsd, feeSol: fee.feeSol, solUsd }, cfg);
    const spent = size.sizeUsd + costs;
    const entryPrice = spent / tokens;
    const alertId = `A${String(++P.alertSeq).padStart(4, '0')}`;
    const id = b.copy ? `C${String(CB.closed.length + CB.positions.length + 1).padStart(3, '0')}` : `X${String(st.closed.filter((t) => t.strategy === 'insider').length + insiderOpen().length + 1).padStart(3, '0')}`;
    const pos = {
      id, strategy: strat, ...(b.copy ? { copy: { wallets: b.copy.wallets, sol: b.copy.sol, firstAt: b.copy.firstAt, signalAt: b.copy.at } } : {}), mint: b.mint, symbol: b.symbol, url: `https://dexscreener.com/solana/${b.pool}`, decimals: dec,
      entryAt: new Date(now()).toISOString(), entryPrice, sizeUsd: spent, riskUsd: spent * (cfg.trailing_stop_pct / 100),
      tokens, tokensOriginal: tokens, realizedUsd: 0, markUsd: tokens * res.priceSol * solUsd, lastPrice: res.priceSol * solUsd,
      stopPrice: entryPrice * (1 - cfg.trailing_stop_pct / 100), peakPrice: entryPrice, trailing: true, tpDone: [], score: null,
      why: { checks: summary, cluster: `${res.cluster.size} wallets hold ${res.clusterPct?.toFixed(2)}%`, size: `${size.limit}: $${size.sizeUsd}`, costs: `$${costs.toFixed(4)} fees+tip+haircut`, fee },
      pb: { pool: b.pool, alertId, t0: b.t0, latencyMs: now() - b.t0, deployer: b.deployer, baseVault: b.poolInfo.baseVault, quoteVault: b.poolInfo.quoteVault, lpMint: b.poolInfo.lpMint,
        supply: res.supply, members: [...res.cluster.members.keys()], tokenAccounts: res.tokenAccounts, lastBal: { ...(res.taBal || {}) }, checkedSigs: [], shareHist: [[now(), res.clusterPct]], tpDone: [], warned: 0, sellFails: 0,
        entry: { lpSupply: b.poolInfo.lpSupply, deployerBal: res.deployerBal, clusterBal: res.clusterBal, clusterShare: res.clusterPct }, minSinceMigration: b.minutesSinceMigration },
    };
    book.cash -= spent; book.positions.push(pos);
    if (b.copy) {
      C.stats.entered++;
      C.recent.unshift({ at: now(), sym: b.symbol, mint: b.mint, d: 'buy', code: 'COPY', note: `$${spent.toFixed(2)} · ${b.copy.wallets.length} smart wallets · cluster ${res.clusterPct?.toFixed(1)}%` }); C.recent.length = Math.min(C.recent.length, 40);
      dirty('copy');
    } else {
      P.latency.push(pos.pb.latencyMs); if (P.latency.length > 500) P.latency.shift();
      P.stats.entered++;
      label(b, res, 'traded', 'entered');
      P.recent.unshift({ at: now(), sym: b.symbol, mint: b.mint, d: 'buy', code: 'BUY', note: `$${spent.toFixed(2)} · cluster ${res.cluster.size} wallets ${res.clusterPct?.toFixed(1)}%` });
    }
    ev('buy', { pos: { ...pos, pb: undefined } }, `▲ ${b.copy ? 'COPY' : 'INSIDER'} PAPER BUY ${id} $${b.symbol} $${spent.toFixed(2)} @ $${entryPrice.toPrecision(4)} · ${summary.slice(0, 160)}`);
    const copyHead = b.copy ? `🧠 COPY LANE (paper, own $${CB.startBalance} book, not in the 14-day numbers): ${b.copy.wallets.length} smart wallets bought within ${Math.max(1, Math.round((b.copy.at - b.copy.firstAt) / 60000))} min: ${b.copy.wallets.slice(0, 4).map(short).join(', ')}\n` : '';
    notify('buy', copyHead + signalText({ type: 'ENTRY', alertId, at: now(), slot: b.creation?.slot, name: b.symbol, symbol: b.symbol, mint: b.mint, pool: b.pool, priceSol: res.priceSol, priceUsd: res.priceSol * solUsd,
      mcapUsd: res.priceSol * solUsd * Number(res.supply) / 10 ** dec, liqUsd: liquidityUsd(res.reserves, solUsd), minSinceMigration: b.minutesSinceMigration,
      filters: filtersOf(checks), clusterWallets: res.cluster.size, clusterShare: res.clusterPct, clusterChange5m: 0, sizePct: (spent / equity(book)) * 100 }));
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
    const { fill, trade } = sellPaper(bookOf(pos), pos, t.ofOriginal ? t.fraction : t.fraction, f.price / feeAdj, `${t.code} ${t.reason}`, config, { ofOriginal: t.ofOriginal });
    if (t.code === 'E7') pos.pb.tpDone.push(t.rung);
    const base = { alertId: `A${String(++P.alertSeq).padStart(4, '0')}`, entryAlertId: pos.pb.alertId, at: now(), name: pos.symbol, symbol: pos.symbol, mint: pos.mint, pool: pos.pb.pool,
      priceSol: obs.priceSol, priceUsd: obs.price, liqUsd: obs.solReserve * 2 * solUsd, minSinceMigration: (pos.pb.minSinceMigration || 0) + (now() - Date.parse(pos.entryAt)) / 60000,
      clusterWallets: pos.pb.members.length, clusterShare: obs.clusterShare, clusterChange5m: change5m(pos, obs), code: t.code, multiple: f.price / pos.entryPrice, note: `${t.reason} · fill: ${f.source}` };
    if (trade) {
      Object.assign(trade, { strategy: pos.strategy, code: t.code, peakPrice: pos.peakPrice, exitSource: f.source, latencyMs: pos.pb.latencyMs, ...(pos.copy ? { copyWallets: pos.copy.wallets.length } : {}) });
      (pos.strategy === 'copy' ? C.recent : P.recent).unshift({ at: now(), sym: pos.symbol, mint: pos.mint, d: 'sell', code: t.code, note: `${trade.pnlPct}% · ${t.reason}` });
      if (pos.strategy === 'copy') dirty('copy');
      ev('sell', { trade }, `▼ ${pos.strategy === 'copy' ? 'COPY' : 'INSIDER'} PAPER SELL ${trade.id} $${pos.symbol} ${trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(trade.pnlUsd).toFixed(2)} (${trade.pnlPct}%) · ${t.code} ${t.reason}`);
      notify(t.code === 'E1' || t.code === 'E2' || t.code === 'E3' ? 'emergency' : 'sell', (pos.strategy === 'copy' ? '🧠 COPY LANE (paper)\n' : '') + signalText({ type: 'EXIT', ...base }));
    } else {
      ev('sell', { fill }, `▼ INSIDER PAPER SELL ${pos.id} $${pos.symbol} part: ${t.reason}`);
      notify('take_profit', (pos.strategy === 'copy' ? '🧠 COPY LANE (paper)\n' : '') + signalText({ type: 'TAKE_PROFIT', ...base }));
    }
    dirty('desk', 'pb', 'copy');
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
    for (const pos of [...insiderOpen(), ...copyOpen()]) {
      const isCopy = pos.strategy === 'copy';
      let obs;
      try { obs = await observe(pos); } catch (e) { ev('warn', {}, `insider monitor: ${String(e.message).slice(0, 80)}`); continue; }
      if (!obs.poolGone) {
        await followSplits(pos, obs).catch(() => 0);
        pos.lastPrice = obs.price; pos.markUsd = pos.tokens * obs.price; pos.lastCheckAt = obs.at;
        pos.peakPrice = Math.max(pos.peakPrice, obs.price); pos.stopPrice = Math.max(pos.stopPrice, pos.peakPrice * (1 - cfg.trailing_stop_pct / 100));
      }
      const killed = isCopy ? null : killSwitchOn(); // the copy book has its own E1 (its own day loss), it never fires the main kill switch
      let t = firstTrigger(pos, obs, cfg, { dayLossPct: isCopy ? copyDayLossPct() : dayLossPct() });
      // copy exit C1 (ours, not the pack's): most of the smart wallets we copied sold >= half their bag. E1-E8 keep priority.
      if (isCopy && t.action === 'HOLD' && ccfg().exit_on_smart_sell) {
        const n = smartExited(C, pos.mint, pos.copy.wallets), need = Math.ceil(pos.copy.wallets.length / 2);
        if (n >= need) t = { code: 'C1', action: 'SELL_ALL', fraction: 1, reason: `${n} of the ${pos.copy.wallets.length} smart wallets we copied sold half or more` };
      }
      if (!obs.poolGone) { pos.pb.lastBal = obs.bal; pos.pb.shareHist.push([obs.at, obs.clusterShare]); pos.pb.shareHist = pos.pb.shareHist.filter(([x]) => x >= obs.at - 330_000); }
      if (t.warn && pos.pb.warned < 3 && !t.code) {
        const lvl = Math.floor(parseFloat(t.warn.match(/[\d.]+/)?.[0] || 0) / 5);
        if (lvl > (pos.pb.warnLvl ?? -1)) { pos.pb.warnLvl = lvl; pos.pb.warned++; notify('pb_warn', signalText({ type: 'WARNING', alertId: `A${String(++P.alertSeq).padStart(4, '0')}`, entryAlertId: pos.pb.alertId, at: now(), symbol: pos.symbol, name: pos.symbol, mint: pos.mint, pool: pos.pb.pool, priceSol: obs.priceSol, priceUsd: obs.price, liqUsd: obs.solReserve * 2 * solUsd, clusterWallets: pos.pb.members.length, clusterShare: obs.clusterShare, clusterChange5m: change5m(pos, obs), note: t.warn })); }
      }
      if (!isCopy && (t.code === 'E1' || (killed && t.code))) { await killAll(t.reason); break; }
      if (t.action !== 'HOLD') await act(pos, t, obs);
      dirty('desk', 'pb');
    }
    P.cpuMs.push(now() - t0); if (P.cpuMs.length > 50) P.cpuMs.shift();
  }

  async function monitor(burst = 1) {
    for (let i = 0; i < burst && (insiderOpen().length || copyOpen().length); i++) {
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
    onSmartTx, setSmartList, copyLines, copyMetrics, alertsStep, crewAlert,
    alertsDue: () => Object.keys(P.alerts.watch).length > 0 && now() >= P.timers.nextAlerts,
    monitorDue: () => (insiderOpen().length > 0 || copyOpen().length > 0) && now() >= P.timers.nextMonitor,
    buildDue: () => Boolean(P.build || P.queue.length || (ccfg().enabled && P.copyQueue.length)),
    discoverDue: () => now() >= P.timers.nextDiscover,
    labelsDue: () => now() >= P.timers.nextLabels,
    nextAt: () => Math.min(insiderOpen().length || copyOpen().length ? P.timers.nextMonitor : Infinity, P.build || P.queue.length || P.copyQueue.length ? now() + 300 : Infinity, P.timers.nextDiscover, P.timers.nextLabels,
      Object.keys(P.alerts.watch).length ? P.timers.nextAlerts : Infinity),
  };
}
