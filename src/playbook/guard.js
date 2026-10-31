// ============================================================================
// EARLY-EXIT GUARD (her ask, Oct 31 2026 9:26 + 9:29 AM Lagos): spot a COORDINATED EXIT on a position she holds
// before the big dump, and ASK her: one Telegram alert with the evidence + [Sell now] [Hold]. It never sells on its
// own; it sells only when she taps Sell. The pack's own exits (E1-E8: kill switch, LP pulled, deployer sells, crew
// sold 20%+, crew share -15% in 60 s, trailing stop, take profit, max hold) are UNCHANGED and still act by themselves.
// Signals (each is a pattern, not proof):
//   G1 crew sells   : 2+ different linked wallets' balances drop inside crew_sell_window_s
//   G2 fast drop    : the crew's share of supply falls fast_drop_pts+ points inside fast_drop_window_s
//   G3 shuffle      : crew wallets move tokens to brand-new wallets (often the step before a dump)
//   G5 sell pressure: the pool's SOL side falls sol_drop_pct%+ inside sol_drop_window_s (big sells hitting the pool)
//   (LP removal / authority change = E2, which already sells at once.)
// Per trade it records: when the first signal came, what an instant sell then would have returned, what she chose,
// when the big dump came (lead time), and what actually happened, so the 14-day report can show the cost/benefit.
// Pure: no I/O. The lane feeds it the 1 s observations it already makes (no extra Helius calls).
// ============================================================================
export const GUARD_DEFAULTS = { enabled: true, crew_sellers: 2, crew_sell_window_s: 60, fast_drop_pts: 2, fast_drop_window_s: 120,
  sol_drop_pct: 15, sol_drop_window_s: 60, desk_liq_drop_pct: 15, desk_liq_window_s: 120, realert_min: 10, dump_crew_drop_pts: 10, dump_price_drop_pct: 30, max_alerts_per_trade: 3 };
export const guardCfg = (cfg = {}) => ({ ...GUARD_DEFAULTS, ...(cfg.guard || {}) });

const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '?');

// pos.pb: { tokenAccounts: {ta: owner}, lastBal: {ta: amount}, shareHist: [[at, share]], deployer }
// obs: { at, bal: {ta: amount}, clusterShare, solReserve, price }; extra: { newWallets: n }
export function guardSignals(pos, obs, g, extra = {}) {
  const G = (pos.guard ||= newGuard());
  const at = obs.at, out = [];
  // G1: which crew wallets just sold (balance down), remembered with their first time
  for (const [ta, a] of Object.entries(obs.bal || {})) {
    const before = pos.pb.lastBal?.[ta];
    if (before == null || !(a < before)) continue;
    const owner = pos.pb.tokenAccounts?.[ta] || ta;
    if (!G.sellers[owner]) G.sellers[owner] = { at, pct: before > 0 ? +(((before - a) / before) * 100).toFixed(1) : null };
  }
  const recent = Object.entries(G.sellers).filter(([, s]) => at - s.at <= g.crew_sell_window_s * 1000);
  if (recent.length >= g.crew_sellers) out.push({ code: 'G1', at, evidence: `${recent.length} linked wallets sold inside ${g.crew_sell_window_s}s: ${recent.slice(0, 3).map(([w, s]) => `${short(w)}${s.pct != null ? ` -${s.pct}%` : ''}`).join(', ')}` });
  // G2: crew share falling fast
  if (obs.clusterShare != null) {
    const win = (pos.pb.shareHist || []).filter(([t]) => t >= at - g.fast_drop_window_s * 1000).map(([, s]) => s);
    const peak = Math.max(...win, obs.clusterShare);
    if (peak - obs.clusterShare >= g.fast_drop_pts) out.push({ code: 'G2', at, evidence: `crew share ${peak.toFixed(1)}% → ${obs.clusterShare.toFixed(1)}% inside ${g.fast_drop_window_s}s (-${(peak - obs.clusterShare).toFixed(1)} pts)` });
  }
  // G3: tokens moved to brand-new wallets (the lane's wallet-split follower found new recipients this look)
  if (extra.newWallets > 0) out.push({ code: 'G3', at, evidence: `crew moved tokens to ${extra.newWallets} brand-new wallet(s) (pre-dump shuffle pattern)` });
  // G5: the pool's SOL side falling fast = sells hitting the pool
  if (obs.solReserve > 0) {
    G.solHist.push([at, obs.solReserve]); G.solHist = G.solHist.filter(([t]) => t >= at - Math.max(g.sol_drop_window_s, 60) * 1000);
    const peak = Math.max(...G.solHist.filter(([t]) => t >= at - g.sol_drop_window_s * 1000).map(([, s]) => s));
    if (peak > 0 && (peak - obs.solReserve) / peak * 100 >= g.sol_drop_pct) out.push({ code: 'G5', at, evidence: `pool SOL ${peak.toFixed(1)} → ${obs.solReserve.toFixed(1)} inside ${g.sol_drop_window_s}s (-${(((peak - obs.solReserve) / peak) * 100).toFixed(1)}%, big sells)` });
  }
  return out;
}

export function newGuard() { return { sellers: {}, solHist: [], log: [], firstSignalAt: null, alerts: 0, lastAlertAt: 0, codesAlerted: [], decision: null, autoSell: null, dumpAt: null, dumpWhy: null }; }

// should this look send an alert? (first signal, or a NEW kind of signal after realert_min, at most max_alerts_per_trade)
export function guardShouldAlert(G, sigs, g, at) {
  if (!sigs.length || G.decision === 'sold') return false;
  if (G.alerts >= g.max_alerts_per_trade) return false;
  const fresh = sigs.filter((s) => !G.codesAlerted.includes(s.code));
  if (!G.alerts) return true;
  return fresh.length > 0 && at - G.lastAlertAt >= g.realert_min * 60_000;
}

// the "big dump" (for lead time): crew share down dump_crew_drop_pts from the first signal, price -dump_price_drop_pct%,
// or one of the pack's hard exits (E2-E5) firing
export function guardDump(G, obs, g, exitCode = null) {
  if (!G.firstSignalAt || G.dumpAt) return null;
  const why = exitCode && /^E[2-5]$/.test(exitCode) ? `${exitCode} fired`
    : G.shareAtSignal != null && obs.clusterShare != null && G.shareAtSignal - obs.clusterShare >= g.dump_crew_drop_pts ? `crew share ${G.shareAtSignal.toFixed(1)}% → ${obs.clusterShare.toFixed(1)}%`
      : G.priceAtSignal > 0 && obs.price > 0 && obs.price <= G.priceAtSignal * (1 - g.dump_price_drop_pct / 100) ? `price -${(((G.priceAtSignal - obs.price) / G.priceAtSignal) * 100).toFixed(0)}% from the first signal` : null;
  if (!why) return null;
  G.dumpAt = obs.at; G.dumpWhy = why;
  return { at: obs.at, why, leadS: Math.round((obs.at - G.firstSignalAt) / 1000) };
}

// what goes on the closed trade (and into the report)
export function guardTradeRecord(G, trade) {
  if (!G?.firstSignalAt) return null;
  const auto = G.autoSell?.pnlUsd ?? null;
  return { firstSignalAt: new Date(G.firstSignalAt).toISOString(), codes: [...new Set(G.log.map((x) => x.code))], alerts: G.alerts, decision: G.decision || 'no answer (held)',
    leadTimeS: G.dumpAt ? Math.round((G.dumpAt - G.firstSignalAt) / 1000) : null, dumpWhy: G.dumpWhy, autoSellPnlUsd: auto,
    actualPnlUsd: trade?.pnlUsd ?? null, autoMinusActualUsd: auto != null && trade?.pnlUsd != null ? +(auto - trade.pnlUsd).toFixed(2) : null };
}

export function guardSummary(trades = []) {
  const g = trades.map((t) => t.guard).filter(Boolean);
  if (!g.length) return null;
  const lead = g.map((x) => x.leadTimeS).filter((x) => x != null);
  const saved = g.map((x) => x.autoMinusActualUsd).filter((x) => x != null);
  return { trades: g.length, soldOnTap: g.filter((x) => x.decision === 'sold').length, leadMedianS: lead.length ? lead.sort((a, b) => a - b)[Math.floor(lead.length / 2)] : null,
    autoMinusActualUsd: saved.length ? +saved.reduce((s, x) => s + x, 0).toFixed(2) : null };
}

// main desk positions (DexScreener lane): no crew wallet list there, so the one signal is the pool itself:
// liquidity falling desk_liq_drop_pct%+ inside desk_liq_window_s (big sells / liquidity being pulled), read every 10 s
// by the desk's own liquidity check. The desk's 40%-drop emergency exit stays automatic.
export function deskGuardSignals(pos, liqNow, at, g) {
  const G = (pos.guard ||= newGuard());
  if (!(liqNow > 0)) return [];
  (G.liqHist ||= []).push([at, liqNow]); G.liqHist = G.liqHist.filter(([t]) => t >= at - g.desk_liq_window_s * 1000);
  const peak = Math.max(...G.liqHist.map(([, l]) => l));
  const drop = peak > 0 ? ((peak - liqNow) / peak) * 100 : 0;
  return drop >= g.desk_liq_drop_pct ? [{ code: 'G5', at, evidence: `pool liquidity $${Math.round(peak / 1000)}k → $${Math.round(liqNow / 1000)}k inside ${g.desk_liq_window_s}s (-${drop.toFixed(0)}%)` }] : [];
}
