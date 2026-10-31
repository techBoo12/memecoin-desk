// ============================================================================
// LABELS + EVALUATION (pack 9.1 B step h, section 8 tip 1, 9.4)
// Every token the lane sees (traded or skipped) is re-checked at +5m/+15m/+30m/+1h (to catch the
// 1h peak and any crash) and at +24h, then labelled:
//   RUG  = liquidity removed, or price down 90%+ from its peak within 1 h
//   PUMP = price reached 2x the detection price
//   DIED = 24 h price <= 50% of the detection price
//   FLAT = everything else
// The 1h peak comes from these samples (free polling), not a tick stream: a spike between two
// samples is missed. Stated in every summary.
// ============================================================================
export function newLabelBook() { return { items: {}, order: [] }; }

export function trackToken(book, t, cap = 1500) {
  if (book.items[t.mint]) return book.items[t.mint];
  const it = { mint: t.mint, sym: t.symbol, pool: t.pool, t0: t.t0, p0: t.price0, l0: t.liq0, s0: t.share0 ?? null, dep: t.deployer || null, fun: t.deployerFunder || null,
    d: t.decision, why: t.reason || null, samples: [], peak1h: t.price0 || 0, crash1h: false, liqGone: false, label1h: null, label: null, share1h: null, share24h: null };
  book.items[t.mint] = it; book.order.push(t.mint);
  while (book.order.length > cap) delete book.items[book.order.shift()];
  return it;
}

export function dueMints(book, now, checksMin = [5, 15, 30, 60, 1440]) {
  const due = [];
  for (const m of book.order) {
    const it = book.items[m]; if (it.label) continue;
    const next = checksMin.find((x) => !it.samples.some((s) => s.k === x));
    if (next != null && now >= it.t0 + next * 60_000) due.push({ mint: m, k: next });
  }
  return due;
}

export function applySample(it, { k, at, price, liq, share = null }) {
  it.samples.push({ k, at, p: price ?? null, l: liq ?? null });
  if (k <= 60) {
    if (price > it.peak1h) it.peak1h = price;
    if (price != null && it.peak1h > 0 && price <= it.peak1h * 0.1) it.crash1h = true;
    if (liq == null || (it.l0 > 0 && liq <= it.l0 * 0.1)) it.liqGone = true; // pair gone or 90% of liquidity removed
  }
  if (k === 60) { it.share1h = share; it.label1h = labelOf(it, false); }
  if (k === 1440) { it.share24h = share; it.p24 = price; it.label = labelOf(it, true); }
  return it;
}

export function labelOf(it, final) {
  if (it.liqGone || it.crash1h) return 'RUG';
  const maxP = Math.max(...it.samples.map((s) => s.p || 0), it.peak1h || 0);
  if (it.p0 > 0 && maxP >= it.p0 * 2) return 'PUMP';
  if (final && it.p0 > 0 && (it.p24 == null || it.p24 <= it.p0 * 0.5)) return 'DIED';
  return final ? 'FLAT' : 'FLAT (1h)';
}

export function labelSummary(book) {
  const by = { traded: {}, skipped: {} };
  for (const m of book.order) {
    const it = book.items[m]; const l = it.label || it.label1h; if (!l) continue;
    const side = it.d === 'traded' ? 'traded' : 'skipped';
    by[side][l] = (by[side][l] || 0) + 1;
  }
  const sk = Object.values(by.skipped).reduce((s, x) => s + x, 0);
  return { ...by, filterValuePct: sk ? +((((by.skipped.RUG || 0) / sk) * 100).toFixed(1)) : null, labelled: sk + Object.values(by.traded).reduce((s, x) => s + x, 0) };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctile = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// 9.4 metrics + the go/no-go bar for real money
export function evaluate({ trades, curve = [], book, latenciesMs = [], killSwitchDays = { hit: 0, fired: 0 }, days = 0 }, cfg) {
  const n = trades.length;
  const pnl = trades.map((t) => t.pnlPct);
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const avg = n ? pnl.reduce((s, x) => s + x, 0) / n : null;
  const best = n ? Math.max(...pnl) : null;
  const avgNoBest = n > 1 ? (pnl.reduce((s, x) => s + x, 0) - best) / (n - 1) : null;
  let peak = -Infinity, dd = 0;
  for (const p of curve) { peak = Math.max(peak, p.eq); dd = Math.max(dd, peak > 0 ? ((peak - p.eq) / peak) * 100 : 0); }
  // rug-exit rate: traded tokens later labelled RUG where our final sell landed above 50% of the pre-crash peak
  const rugTraded = trades.filter((t) => (book?.items[t.mint]?.label || book?.items[t.mint]?.label1h) === 'RUG');
  const rugExited = rugTraded.filter((t) => t.exitPrice >= 0.5 * Math.max(t.peakPrice || 0, book.items[t.mint].peak1h || 0));
  const ls = book ? labelSummary(book) : null;
  const m = {
    trades: n, winRatePct: n ? +((wins / n) * 100).toFixed(1) : null, avgPnlPct: avg != null ? +avg.toFixed(2) : null, medianPnlPct: median(pnl),
    avgPnlPctWithoutBest: avgNoBest != null ? +avgNoBest.toFixed(2) : null, maxDrawdownPct: +dd.toFixed(2),
    rugExitRatePct: rugTraded.length ? +((rugExited.length / rugTraded.length) * 100).toFixed(1) : null, rugTraded: rugTraded.length,
    filterValuePct: ls?.filterValuePct ?? null, latencyMedianMs: median(latenciesMs), latencyP90Ms: pctile(latenciesMs, 0.9), days,
  };
  m.goNoGo = [
    { bar: '14+ days and 100+ closed paper trades', pass: days >= 14 && n >= 100, value: `${days} days, ${n} trades` },
    { bar: 'avg net PnL > 0, also without the best trade', pass: avg > 0 && avgNoBest > 0, value: `${m.avgPnlPct}% / ${m.avgPnlPctWithoutBest}%` },
    { bar: 'max drawdown <= 20%', pass: dd <= 20 && n > 0, value: `${m.maxDrawdownPct}%` },
    { bar: 'rug-exit rate >= 80%', pass: m.rugExitRatePct != null && m.rugExitRatePct >= 80, value: m.rugExitRatePct == null ? 'no rugged trades yet' : `${m.rugExitRatePct}%` },
    { bar: 'win rate >= 35%', pass: m.winRatePct != null && m.winRatePct >= 35, value: `${m.winRatePct}%` },
    { bar: `kill switch fired every day it should; median latency < ${cfg.max_latency_ms} ms`, pass: killSwitchDays.fired >= killSwitchDays.hit && m.latencyMedianMs != null && m.latencyMedianMs < cfg.max_latency_ms, value: `${killSwitchDays.fired}/${killSwitchDays.hit} days, median ${m.latencyMedianMs} ms` },
  ];
  m.go = m.goNoGo.every((x) => x.pass);
  return m;
}
