// ============================================================================
// DEV HISTORY (her ask, WhatsApp voice Oct 31 2026 9:23 AM Lagos: "devs might be holding a big chunk and
// it's not a rugger ... detect the history of the dev wallet")
// Job: for a coin's dev (creator) wallet and the wallet that funded it, find the pump.fun coins they launched
//   in the last `days` (default 45), and judge each one: rugged, died, survived, or too new to tell.
//   The funder's other fresh wallets ("siblings": wallets it funded that then launched a coin) count too,
//   because serial launchers use a new dev wallet per coin (seen live Oct 31: $Rockstar's dev was funded by
//   the wallet that launched $MrBeast 20 min earlier).
// HONEST LIMITS (said in every verdict): history is evidence, not proof. A fresh wallet is UNKNOWN, not clean.
//   "rug" here = the launching wallet sold >= dump_sold_pct of its bag within dump_hours of launch, or the coin is
//   dead (no pool / liquidity gone) after a day. "survived" = still trading a day+ later with real liquidity
//   and market cap (DexScreener, free). Holder growth is NOT measured (no free source for it).
// Reads only. Helius getTransactionsForAddress (10 credits per call of <= 100 txs) + DexScreener (free).
// Runs only for coins that already passed every other rule (or would, apart from the dev-crew cap), so the
// daily cost stays small. One unit of work per step so a Worker invocation stays small.
// ============================================================================
import { PUMP_PROGRAM, SYSTEM, keysOf, signerOf } from './solana.js';

export const DEV_HISTORY_DEFAULTS = {
  enabled: true, days: 45, pages_dev: 2, pages_funder: 1, funder_page: 50, max_siblings: 3, sibling_page: 40, max_calls: 7, max_tokens_judged: 20,
  dump_sold_pct: 80, dump_hours: 6, survive_min_liq_usd: 10000, survive_min_mcap_usd: 30000, judge_min_age_h: 24,
  dead_max_liq_usd: 2000, clean_min_survived: 2, clean_min_survival_rate: 0.34, rugger_min_rugs: 2, rugger_min_rug_rate: 0.5,
  hub_min_tx_per_min: 100, cache_hours: 6, max_lookups_day: 60, credits_per_gtfa: 10,
};
export const devCfg = (cfg = {}) => ({ ...DEV_HISTORY_DEFAULTS, ...(cfg.dev_history || {}) });

const isCreateTx = (tx) => {
  if (!tx?.meta || tx.meta.err) return false;
  if (!keysOf(tx).includes(PUMP_PROGRAM)) return false;
  return (tx.meta.logMessages || []).some((l) => /Program log: Instruction: Create(V2)?$/.test(l));
};
// the mint a pump.fun create tx made: a mint with post balances and no pre balances, the biggest one
export function createdMint(tx) {
  const pre = new Set((tx.meta?.preTokenBalances || []).map((b) => b.mint));
  const sums = {};
  for (const b of tx.meta?.postTokenBalances || []) if (!pre.has(b.mint)) sums[b.mint] = (sums[b.mint] || 0) + Number(b.uiTokenAmount?.amount || 0);
  const best = Object.entries(sums).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// one page of a wallet's txs -> launches it signed, its token flows per mint, wallets it freshly funded
export function readPage(txs, wallet) {
  const launches = [], flows = {}, funded = [];
  for (const tx of txs || []) {
    if (!tx?.meta || tx.meta.err) continue;
    const at = (tx.blockTime || 0) * 1000, keys = keysOf(tx), signer = signerOf(tx);
    if (signer === wallet && isCreateTx(tx)) { const m = createdMint(tx); if (m) launches.push({ mint: m, at, by: wallet, sig: tx.transaction.signatures?.[0] }); }
    // the wallet's own token balance moves (buys +, sells -)
    const d = {};
    for (const b of tx.meta.preTokenBalances || []) if (b.owner === wallet) d[b.mint] = (d[b.mint] || 0) - Number(b.uiTokenAmount?.amount || 0);
    for (const b of tx.meta.postTokenBalances || []) if (b.owner === wallet) d[b.mint] = (d[b.mint] || 0) + Number(b.uiTokenAmount?.amount || 0);
    for (const [m, x] of Object.entries(d)) if (x) (flows[m] ||= []).push([at, x]);
    // fresh-wallet funding: the wallet signs a plain SOL send and a brand-new account (0 SOL before) gets >= 0.05 SOL
    if (signer === wallet && keys.includes(SYSTEM) && !keys.includes(PUMP_PROGRAM)) {
      const pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
      for (let i = 1; i < keys.length; i++) if (pre[i] === 0 && post[i] - pre[i] >= 5e7 && keys[i] !== SYSTEM) funded.push({ w: keys[i], at, lamports: post[i] });
    }
  }
  return { launches, flows, funded };
}

// did the launching wallet dump its bag fast? flows = [[at, raw delta], ...]
export function dumpOf(flows = [], launchAt, d) {
  const s = [...flows].sort((a, b) => a[0] - b[0]);
  let held = 0, peak = 0, soldFast = 0, sold = 0;
  for (const [at, x] of s) {
    if (x > 0) { held += x; peak = Math.max(peak, held); } else { held += x; sold += -x; if (at - launchAt <= d.dump_hours * 3.6e6) soldFast += -x; }
  }
  if (peak <= 0) return { bought: false, soldFastPct: null, soldPct: null };
  return { bought: true, soldFastPct: Math.min(100, (soldFast / peak) * 100), soldPct: Math.min(100, (sold / peak) * 100) };
}

// one launch -> rug | died | survived | weak | too_new. pair = best DexScreener pair (or null)
export function judgeLaunch(l, pair, d, now = Date.now()) {
  const ageH = (now - l.at) / 3.6e6;
  const liq = Number(pair?.liquidity?.usd || 0), mcap = Number(pair?.marketCap || pair?.fdv || 0);
  const dump = l.dump || { bought: false };
  const fast = dump.bought && dump.soldFastPct >= d.dump_sold_pct;
  const base = { mint: l.mint, by: l.role || 'dev', ageH: +ageH.toFixed(1), liq: Math.round(liq), mcap: Math.round(mcap), devSoldFastPct: dump.soldFastPct == null ? null : Math.round(dump.soldFastPct), symbol: pair?.baseToken?.symbol || null };
  if (fast && (ageH >= 1 || liq < d.dead_max_liq_usd)) return { ...base, outcome: 'rug', why: `launcher sold ${Math.round(dump.soldFastPct)}% of its bag within ${d.dump_hours}h` };
  if (ageH < d.judge_min_age_h) return { ...base, outcome: 'too_new', why: `${ageH.toFixed(1)}h old, too new to judge` };
  if (!pair || liq < d.dead_max_liq_usd) return { ...base, outcome: dump.bought && dump.soldPct >= d.dump_sold_pct ? 'rug' : 'died', why: !pair ? 'no pool trading now' : `liquidity $${Math.round(liq)} now (dead)` };
  if (liq >= d.survive_min_liq_usd && mcap >= d.survive_min_mcap_usd) return { ...base, outcome: 'survived', why: `still trading: liq $${Math.round(liq / 1000)}k, mcap $${Math.round(mcap / 1000)}k after ${Math.round(ageH / 24 * 10) / 10}d` };
  return { ...base, outcome: 'weak', why: `alive but small: liq $${Math.round(liq)}, mcap $${Math.round(mcap)}` };
}

// all judged launches -> clean | mixed | serial_rugger | unknown
export function verdictOf(judged, d, meta = {}) {
  const n = (o) => judged.filter((j) => j.outcome === o).length;
  const rugs = n('rug'), died = n('died'), survived = n('survived'), weak = n('weak'), tooNew = n('too_new');
  const counted = rugs + died + survived + weak;
  const counts = { launches: judged.length, rugs, died, survived, weak, tooNew };
  let verdict, why;
  if (!judged.length) { verdict = 'unknown'; why = meta.fresh ? 'fresh wallet, no earlier launches found: unknown, NOT clean' : 'no earlier launches found in the window: unknown, NOT clean'; }
  else if (rugs >= d.rugger_min_rugs && rugs / Math.max(1, counted) >= d.rugger_min_rug_rate) { verdict = 'serial_rugger'; why = `${rugs} of ${counted} earlier launches rugged`; }
  else if (!counted) { verdict = 'unknown'; why = `${tooNew} earlier launch(es), all too new to judge`; }
  else if (rugs === 0 && survived >= d.clean_min_survived && survived / counted >= d.clean_min_survival_rate) { verdict = 'clean'; why = `${survived} of ${counted} earlier launches still trading, 0 rugs`; }
  else { verdict = 'mixed'; why = `${counted} judged: ${survived} survived, ${rugs} rugged, ${died} died, ${weak} small`; }
  return { verdict, why, counts };
}

// ---------------- the step machine (one wallet page / one sibling / one judge call per step) ----------------
// the bot's own labels (labels.js: RUG = liquidity removed or -90% within 1 h of detection) for coins launched by this
// dev, by its funder, or by another wallet the same funder paid: free evidence, 0 credits
export function labelLaunches(book, { mint, dev, funder }) {
  const out = [];
  for (const it of Object.values(book?.items || {})) {
    if (!it?.mint || it.mint === mint) continue;
    const role = it.dep && it.dep === dev ? 'dev' : it.dep && it.dep === funder ? 'funder' : funder && it.fun === funder ? 'sibling' : dev && it.fun === dev ? 'funded by dev' : null;
    if (!role) continue;
    out.push({ mint: it.mint, at: it.t0 || 0, by: it.dep || null, role, botLabel: it.label || it.label1h || null, symbol: it.sym || null });
  }
  return out;
}

export function newDevHistJob({ mint, dev, funder, labels = null, now = Date.now() }) {
  const q = [];
  if (dev) q.push({ w: dev, role: 'dev', pages: 0, cursor: null });
  if (funder && funder !== dev) q.push({ w: funder, role: 'funder', pages: 0, cursor: null });
  return { mint, dev, funder: funder || null, startedAt: now, stage: 'scan', q, launches: labelLaunches(labels, { mint, dev, funder }), flows: {}, siblings: [], siblingIdx: 0, calls: 0, credits: 0, notes: [], fresh: false, hub: false };
}

const addFlows = (job, wallet, flows) => { for (const [m, f] of Object.entries(flows)) ((job.flows[wallet] ||= {})[m] ||= []).push(...f); };

export async function stepDevHist(job, io, cfg, now = Date.now()) {
  const d = devCfg(cfg);
  const since = Math.floor((now - d.days * 864e5) / 1000);
  const gtfa = async (w, opts) => {
    job.calls++; job.credits += d.credits_per_gtfa;
    return io.rpc('getTransactionsForAddress', [w, { transactionDetails: 'full', encoding: 'json', maxSupportedTransactionVersion: 1, ...opts }], { keyedOnly: true, credits: d.credits_per_gtfa, timeoutMs: 15000 });
  };
  if (job.stage !== 'judge' && job.stage !== 'done' && job.calls >= d.max_calls) { job.notes.push(`stopped at ${d.max_calls} history reads (cap)`); job.stage = 'judge'; }
  if (job.stage === 'scan') {
    const it = job.q[0];
    if (!it) { job.stage = 'siblings'; return job.stage; }
    const maxPages = it.role === 'dev' ? d.pages_dev : d.pages_funder;
    const r = await gtfa(it.w, { limit: it.role === 'dev' ? 100 : d.funder_page, sortOrder: 'desc', filters: { blockTime: { gte: since }, status: 'succeeded' }, ...(it.cursor ? { paginationToken: it.cursor } : {}) });
    const txs = r?.data || [];
    const pg = readPage(txs, it.w);
    for (const l of pg.launches) job.launches.push({ ...l, role: it.role });
    addFlows(job, it.w, pg.flows);
    if (it.role === 'dev' && it.pages === 0 && txs.length < 30) job.fresh = true; // a few dozen txs in total: a fresh wallet
    if (it.pages === 0 && txs.length >= (it.role === 'dev' ? 100 : d.funder_page)) { const span = ((txs[0].blockTime - txs[txs.length - 1].blockTime) || 1) / 60; if (span < 60) job.notes.push(`${it.role} wallet is very busy (${Math.round(txs.length / span)} txs/min, bot-like): only its last ${Math.max(1, Math.round(span * Math.min(it.role === 'dev' ? d.pages_dev : d.pages_funder, 2)))} min were read`); }
    if (it.role === 'funder') {
      const span = txs.length > 1 ? ((txs[0].blockTime - txs[txs.length - 1].blockTime) || 1) / 60 : Infinity;
      if (txs.length >= d.funder_page && txs.length / span >= d.hub_min_tx_per_min) { job.hub = true; job.notes.push(`funder sends ${Math.round(txs.length / span)} txs/min: an exchange or hub, its other wallets are not counted`); }
      else for (const f of pg.funded) if (f.w !== job.dev && !job.siblings.some((s) => s.w === f.w)) job.siblings.push(f);
    }
    it.pages++; it.cursor = r?.paginationToken || null;
    if (!it.cursor || it.pages >= maxPages || txs.length < (it.role === 'dev' ? 100 : d.funder_page)) job.q.shift();
    return 'scan';
  }
  if (job.stage === 'siblings') {
    const sib = job.siblings.sort((a, b) => b.at - a.at).slice(0, d.max_siblings)[job.siblingIdx];
    if (!sib || job.hub) { job.stage = 'judge'; return job.stage; }
    job.siblingIdx++;
    // a sibling's launch + its dump sit in its first txs: oldest first
    const r = await gtfa(sib.w, { limit: d.sibling_page, sortOrder: 'asc', filters: { status: 'succeeded' } });
    const pg = readPage(r?.data || [], sib.w);
    for (const l of pg.launches) job.launches.push({ ...l, role: 'sibling' });
    addFlows(job, sib.w, pg.flows);
    return 'siblings';
  }
  if (job.stage === 'judge') {
    const byMint = {};
    for (const l of job.launches) { if (l.mint === job.mint) continue; const o = byMint[l.mint]; byMint[l.mint] = o ? { ...o, ...l, botLabel: o.botLabel || l.botLabel, symbol: o.symbol || l.symbol, at: Math.min(o.at || Infinity, l.at || Infinity) } : { ...l }; }
    const list = Object.values(byMint).sort((a, b) => b.at - a.at).slice(0, d.max_tokens_judged);
    for (const l of list) l.dump = dumpOf(job.flows[l.by]?.[l.mint], l.at, d);
    const pairs = {};
    if (list.length) {
      const r = await io.getJSON(`https://api.dexscreener.com/tokens/v1/solana/${list.map((l) => l.mint).join(',')}`, { retries: 1, timeoutMs: 8000 });
      if (!r.ok) job.notes.push('DexScreener did not answer: survival unknown for this read');
      for (const p of Array.isArray(r.data) ? r.data : []) {
        const m = p.baseToken?.address; if (!m) continue;
        if (!pairs[m] || Number(p.liquidity?.usd || 0) > Number(pairs[m].liquidity?.usd || 0)) pairs[m] = p;
      }
      if (!r.ok) { job.result = finish(job, list.map((l) => ({ mint: l.mint, by: l.role, outcome: l.dump?.bought && l.dump.soldFastPct >= d.dump_sold_pct ? 'rug' : 'too_new', why: 'survival not readable' })), d, now); job.stage = 'done'; return 'done'; }
    }
    job.result = finish(job, list.map((l) => {
      const j = judgeLaunch(l, pairs[l.mint] || null, d, now);
      if (!j.symbol && l.symbol) j.symbol = l.symbol;
      if (l.botLabel === 'RUG' && j.outcome !== 'rug') return { ...j, outcome: 'rug', why: `the bot's own label: RUG (liquidity removed or -90% within 1h)` };
      return j;
    }), d, now);
    job.stage = 'done';
    return 'done';
  }
  return job.stage;
}

function finish(job, judged, d, now) {
  const v = verdictOf(judged, d, { fresh: job.fresh && !judged.length });
  return { ...v, dev: job.dev, funder: job.funder, at: now, credits: job.credits, calls: job.calls, notes: job.notes, fresh: job.fresh,
    evidence: judged.slice(0, 8).map((j) => ({ mint: j.mint, symbol: j.symbol, by: j.by, outcome: j.outcome, why: j.why, ageH: j.ageH })) };
}

// short phone line for alerts/logs
export function devHistLine(h) {
  if (!h) return 'dev history: not checked';
  const tag = { clean: '✅ clean', mixed: '🟡 mixed', serial_rugger: '⛔ serial rugger', unknown: '❔ unknown' }[h.verdict] || h.verdict;
  return `dev history: ${tag} (${h.why})`;
}
export function devHistEvidence(h, n = 3) {
  if (!h?.evidence?.length) return [];
  return h.evidence.slice(0, n).map((e) => `· ${e.symbol ? '$' + e.symbol : e.mint.slice(0, 4) + '…' + e.mint.slice(-4)} (${e.by}): ${e.outcome}, ${e.why}`);
}

// the whole lookup inline, capped (max_calls Helius reads + one DexScreener read). Errors -> verdict unknown.
export async function runDevHist(args, io, cfg, now = Date.now()) {
  const job = newDevHistJob({ ...args, now });
  let steps = 0;
  try { while (job.stage !== 'done' && steps < 25) { await stepDevHist(job, io, cfg, now); steps++; } }
  catch (e) {
    job.notes.push(`history read failed: ${String(e?.message || e).slice(0, 80)}`);
    // what we already read still counts (the bot's own labels + any pages that came back)
    const made = job.calls;
    try { job.stage = 'judge'; job.calls = Infinity; await stepDevHist(job, { ...io, rpc: async () => { throw new Error('stopped'); } }, cfg, now); }
    catch { job.result = { verdict: 'unknown', why: 'history not readable right now: unknown, NOT clean', counts: { launches: 0 }, evidence: [], notes: job.notes }; }
    job.calls = made;
  }
  const r = job.result || { verdict: 'unknown', why: 'history not finished: unknown, NOT clean', counts: { launches: 0 }, evidence: [], notes: job.notes };
  return { ...r, dev: args.dev, funder: args.funder || null, at: now, credits: Number.isFinite(job.credits) ? job.credits : 0, calls: Number.isFinite(job.calls) ? job.calls : 0, notes: job.notes };
}
