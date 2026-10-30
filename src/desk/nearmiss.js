// ============================================================================
// NEAR-MISS TRACKER (added day 3)
// "log every trade your bot almost took and why it passed. half the bugs and
//  most of the edge hide in the skipped signals."
// Job: every coin the desk ALMOST bought gets written down with the exact
//      reason it was skipped, then re-checked at +15m, +1h, +4h and +24h.
//      The report then shows: skipped coins that pumped vs dumped, by reason.
//      Pumped a lot = that rule may be too strict. Dumped = the rule saved us.
// A near miss is any coin that:
//   - failed exactly ONE of the 8 kill rules (passed 7/8), or
//   - passed all 8 rules but failed the sell test, or
//   - passed everything but scored close (nearMissScore..passScore-1), or
//   - scored high enough but the quality gate or the head of desk said no.
// HARD STOP: the tracker only watches and writes. It never trades.
// ============================================================================
import { getJSON } from '../lib/http.js';

export const CHECKPOINTS = [
  { key: '15m', ms: 15 * 60_000 },
  { key: '1h', ms: 60 * 60_000 },
  { key: '4h', ms: 4 * 60 * 60_000 },
  { key: '24h', ms: 24 * 60 * 60_000 },
];
const DEDUPE_MS = 6 * 60 * 60_000; // one record per coin per 6h (later looks just count)
const KEEP_MS = 26 * 60 * 60_000;  // after the 24h check, roll into the totals

export function newNearMissBook() { return { items: [], seq: 0, archived: { total: 0, byReason: {} } }; }

// stage: 'kill_rules' | 'sell_test' | 'score' | 'quality' | 'head'
export function recordNearMiss(book, { c, stage, reasons, score = null, rulesPassed = null, quality = null, now = Date.now() }) {
  const prev = book.items.find((x) => x.mint === c.mint && now - x.at < DEDUPE_MS);
  if (prev) { prev.looks = (prev.looks || 1) + 1; prev.lastReasons = reasons; return null; }
  const item = {
    id: `N${String(++book.seq).padStart(4, '0')}`, at: now, mint: c.mint, symbol: c.symbol, url: c.url,
    stage, reasons, reasonKey: reasonKey(stage, reasons), score, rulesPassed, quality,
    price: c.priceUsd, liq: c.liqUsd, mcap: c.mcap, looks: 1, checks: {},
  };
  book.items.push(item);
  return item;
}

// one short label to group reasons in the report, e.g. "score 65-79", "quality: buys_5m", "rule 4 volume_1h"
export function reasonKey(stage, reasons) {
  const r = reasons[0] || {};
  if (stage === 'kill_rules') return `rule ${r.n} ${r.id}`;
  if (stage === 'sell_test') return 'sell test';
  if (stage === 'score') return 'score below 80';
  if (stage === 'quality') return `quality: ${r.id}`;
  return `head: ${String(r.note || r.id || '').replace(/[\d.]+/g, '#').slice(0, 40)}`;
}

export function dueChecks(book, now = Date.now()) {
  const due = [];
  for (const it of book.items) for (const cp of CHECKPOINTS) if (!it.checks[cp.key] && now - it.at >= cp.ms) due.push({ it, cp });
  return due;
}

// fetch fresh prices (DexScreener, 30 mints a call) and fill due checkpoints
export async function recheckDue(book, { now = Date.now(), maxCalls = 2 } = {}) {
  const due = dueChecks(book, now);
  if (!due.length) return { checked: 0 };
  const mints = [...new Set(due.map((d) => d.it.mint))].slice(0, maxCalls * 30);
  const prices = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const r = await getJSON(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { minGapMs: 300 });
    if (!r.ok) continue;
    for (const p of r.data || []) {
      const m = p.baseToken?.address; const liq = Number(p.liquidity?.usd) || 0;
      if (!prices.has(m) || liq > prices.get(m).liq) prices.set(m, { price: Number(p.priceUsd) || 0, liq });
    }
    if (r.ok) for (const m of mints.slice(i, i + 30)) if (!prices.has(m)) prices.set(m, { price: 0, liq: 0, gone: true });
  }
  let checked = 0;
  for (const { it, cp } of due) {
    const p = prices.get(it.mint);
    if (!p) continue; // api failed: try again next round
    const dead = p.gone || p.liq < 5000;
    const chg = dead ? -100 : it.price ? +(((p.price / it.price) - 1) * 100).toFixed(1) : null;
    it.checks[cp.key] = { at: now, price: p.price, chgPct: chg, liq: Math.round(p.liq), dead };
    checked++;
  }
  // roll finished items (24h checked, or too old) into the archive totals
  const keep = [];
  for (const it of book.items) {
    if (it.checks['24h'] || now - it.at > KEEP_MS) {
      book.archived.total++;
      const o = outcome(it);
      const b = (book.archived.byReason[it.reasonKey] ||= { n: 0, pumped: 0, dumped: 0, flat: 0, pending: 0 });
      b.n++; b[o.label]++;
    } else keep.push(it);
  }
  book.items = keep;
  return { checked };
}

// pumped: +30% or more at its latest check · dumped: -30% or worse, or liquidity gone · else flat
export function outcome(it, pump = 30, dump = -30) {
  const latest = ['24h', '4h', '1h', '15m'].map((k) => [k, it.checks[k]]).find(([, v]) => v);
  if (!latest) return { label: 'pending', at: null, chg: null };
  const [k, v] = latest;
  const best = Math.max(...Object.values(it.checks).map((x) => x.chgPct ?? -100));
  const label = v.dead || v.chgPct <= dump ? 'dumped' : v.chgPct >= pump || best >= pump * 2 ? 'pumped' : 'flat';
  return { label, at: k, chg: v.chgPct, best };
}

export function summarize(book, { since = 0 } = {}) {
  const items = book.items.filter((x) => x.at >= since);
  const byReason = {};
  const totals = { n: 0, pumped: 0, dumped: 0, flat: 0, pending: 0 };
  for (const it of items) {
    const o = outcome(it);
    const b = (byReason[it.reasonKey] ||= { n: 0, pumped: 0, dumped: 0, flat: 0, pending: 0, examples: [] });
    b.n++; b[o.label]++; totals.n++; totals[o.label]++;
    if (o.label !== 'pending' && b.examples.length < 2) b.examples.push(`$${it.symbol} ${o.chg >= 0 ? '+' : ''}${o.chg}% @${o.at}`);
  }
  for (const [k, a] of Object.entries(book.archived.byReason || {})) {
    if (since) break; // archive has no timestamps per item; only for all-time views
    const b = (byReason[k] ||= { n: 0, pumped: 0, dumped: 0, flat: 0, pending: 0, examples: [] });
    for (const f of ['n', 'pumped', 'dumped', 'flat', 'pending']) { b[f] += a[f] || 0; totals[f] += a[f] || 0; }
  }
  const verdicts = Object.entries(byReason).filter(([, b]) => b.pumped + b.dumped >= 3).map(([k, b]) =>
    b.pumped > b.dumped * 1.5 ? `${k}: ${b.pumped} pumped vs ${b.dumped} dumped, might be too strict`
      : b.dumped > b.pumped * 1.5 ? `${k}: ${b.dumped} dumped vs ${b.pumped} pumped, it's saving us`
        : `${k}: mixed (${b.pumped} up, ${b.dumped} down)`);
  return { totals, byReason, verdicts };
}
