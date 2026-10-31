// ============================================================================
// EXECUTION, FEES, SIZING (pack sections 1, 4, 9.1 B step e, R11-R13, 9.4)
// ============================================================================
// x*y=k (pack section 1): price impact of putting `solIn` into a pool holding `solReserve`
export const cpImpactPct = (solIn, solReserve) => (solReserve > 0 ? (solIn / (solReserve + solIn)) * 100 : null);

// R13: priority fee (recent fees paid on this pool, 75th pct of non-zero) x compute units + base fee + Jito tip floor (p50)
export async function estimateFeeSol(io, pool, cfg) {
  let prio = null, tip = null;
  try {
    const fees = (await io.rpc('getRecentPrioritizationFees', [[pool]])).map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
    const p75 = fees.length ? fees[Math.floor(fees.length * 0.75)] : 0;
    prio = (p75 * (cfg.est_compute_units || 150000)) / 1e6 / 1e9 + 5000 / 1e9;
  } catch { /* unknown */ }
  try { tip = await io.jitoTipFloor(); } catch { /* unknown */ }
  if (prio == null || tip == null) return { feeSol: null, prio, tip };
  return { feeSol: prio + tip, prio, tip };
}

// Kelly (pack section 4): f* = W - (1-W)/R, used at a fraction and only once there are enough trades
export function kellyCapPct(trades, cfg) {
  if (trades.length < (cfg.kelly_min_trades ?? 30)) return null;
  const wins = trades.filter((t) => t.pnlUsd > 0), losses = trades.filter((t) => t.pnlUsd <= 0);
  if (!wins.length || !losses.length) return null;
  const W = wins.length / trades.length;
  const avgW = wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length;
  const avgL = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) || 1e-9;
  const f = W - (1 - W) / (avgW / avgL);
  return Math.max(0, f * (cfg.kelly_fraction ?? 0.25) * 100);
}

// step e: smallest of max_position_pct of equity and max_pool_impact_pct of the pool's SOL reserve (+ Kelly cap, + cash)
export function sizeInsider({ equity, cash, poolSol, solUsd, kellyPct = null }, cfg) {
  const byEquity = equity * (cfg.max_position_pct / 100);
  const byPool = poolSol > 0 && solUsd ? poolSol * solUsd * (cfg.max_pool_impact_pct / 100) : 0;
  const byKelly = kellyPct != null ? equity * (kellyPct / 100) : Infinity;
  const sizeUsd = Math.max(0, Math.min(byEquity, byPool, byKelly, cash));
  const limit = sizeUsd === byEquity ? 'max_position_pct' : sizeUsd === byPool ? 'max_pool_impact_pct' : sizeUsd === byKelly ? 'kelly' : 'cash';
  return { sizeUsd: +sizeUsd.toFixed(4), byEquity, byPool, byKelly, limit };
}

// 9.4 pessimistic paper fill: the real quote, minus priority fee + tip, minus a sandwich haircut (pack section 7 tip 3)
export function paperCostUsd({ sizeUsd, feeSol, solUsd }, cfg) {
  return (feeSol || 0) * (solUsd || 0) + sizeUsd * ((cfg.paper_sandwich_haircut_bps || 0) / 1e4);
}
