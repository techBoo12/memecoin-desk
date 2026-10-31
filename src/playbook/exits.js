// ============================================================================
// EXIT TRIGGERS E1-E8, in the pack's priority order (9.1 B step g + R8-R10).
// Pure: firstTrigger(pos, obs, cfg, ctx) -> { code, action, fraction, ofOriginal, reason, warn }
// The first true trigger acts. Decision table extras: the cluster sold something but under
// the trigger -> HOLD with a warning.
//   obs = { at, price, lpSupply, poolGone, mintAuthority, freezeAuthority, deployerBal, clusterBal, clusterShare }
//   pos.pb.entry = { lpSupply, deployerBal, clusterBal, clusterShare }, pos.pb.shareHist = [[at, share], ...]
//   ctx = { dayLossPct }  (realised + open loss of today, % of start-of-day equity)
// ============================================================================
const SELL_ALL = (code, reason) => ({ code, action: 'SELL_ALL', fraction: 1, reason });

export function firstTrigger(pos, obs, cfg, ctx = {}) {
  const e = pos.pb.entry;
  // E1 kill switch
  if (ctx.dayLossPct != null && ctx.dayLossPct >= cfg.max_daily_loss_pct) return SELL_ALL('E1', `kill switch: day loss ${ctx.dayLossPct.toFixed(2)}% >= ${cfg.max_daily_loss_pct}%`);
  // E2 liquidity removed / LP moved / authority set again
  if (obs.poolGone) return SELL_ALL('E2', 'pool account gone');
  if (obs.lpSupply != null && e.lpSupply != null && Number(obs.lpSupply) < Number(e.lpSupply)) return SELL_ALL('E2', `liquidity withdrawn: pool LP supply ${e.lpSupply} -> ${obs.lpSupply}`);
  if (obs.mintAuthority) return SELL_ALL('E2', 'mint authority set again');
  if (obs.freezeAuthority) return SELL_ALL('E2', 'freeze authority set again');
  // E3 deployer sells or moves any tokens
  if (obs.deployerBal != null && e.deployerBal > 0 && obs.deployerBal < e.deployerBal) return SELL_ALL('E3', `deployer moved ${(((e.deployerBal - obs.deployerBal) / e.deployerBal) * 100).toFixed(1)}% of its tokens`);
  // E4 cluster sold >= trigger % of its entry holdings
  let warn = null;
  if (obs.clusterBal != null && e.clusterBal > 0) {
    const soldPct = Math.max(0, ((e.clusterBal - obs.clusterBal) / e.clusterBal) * 100);
    if (soldPct >= cfg.cluster_sell_trigger_pct) return SELL_ALL('E4', `cluster sold ${soldPct.toFixed(1)}% of its entry holdings (>= ${cfg.cluster_sell_trigger_pct}%)`);
    if (soldPct > 0.01) warn = `cluster sold ${soldPct.toFixed(1)}% (< ${cfg.cluster_sell_trigger_pct}%), holding`;
  }
  // E5 cluster_share fell >= drop % (relative) inside the window
  if (obs.clusterShare != null) {
    const from = (obs.at ?? Date.now()) - cfg.cluster_drop_window_s * 1000;
    const win = (pos.pb.shareHist || []).filter(([t]) => t >= from).map(([, s]) => s);
    const peak = Math.max(...win, obs.clusterShare);
    if (peak > 0) {
      const drop = ((peak - obs.clusterShare) / peak) * 100;
      if (drop >= cfg.cluster_drop_pct) return SELL_ALL('E5', `cluster share ${peak.toFixed(2)}% -> ${obs.clusterShare.toFixed(2)}% in ${cfg.cluster_drop_window_s}s (-${drop.toFixed(1)}%)`);
    }
  }
  if (obs.price > 0) {
    // E6 trailing stop from entry (R9: also the stop-loss)
    const peak = Math.max(pos.peakPrice || pos.entryPrice, obs.price);
    if (obs.price <= peak * (1 - cfg.trailing_stop_pct / 100)) return { ...SELL_ALL('E6', `trailing stop: ${(((obs.price / peak) - 1) * 100).toFixed(1)}% from peak`), warn };
    // E7 next unfilled take-profit rung (R8: each rung once, % of ORIGINAL size)
    const done = pos.pb.tpDone || [];
    const rung = cfg.tp_ladder.findIndex((x, i) => !done.includes(i));
    if (rung >= 0 && obs.price >= pos.entryPrice * cfg.tp_ladder[rung].at_x) return { code: 'E7', action: 'SELL_PART', fraction: cfg.tp_ladder[rung].sell_pct / 100, ofOriginal: true, rung, reason: `take profit ${cfg.tp_ladder[rung].at_x}x: sell ${cfg.tp_ladder[rung].sell_pct}% of the original size`, warn };
  }
  // E8 max hold (R10)
  const held = ((obs.at ?? Date.now()) - Date.parse(pos.entryAt)) / 60000;
  if (held >= cfg.max_hold_minutes) return { ...SELL_ALL('E8', `max hold ${cfg.max_hold_minutes} min reached`), warn };
  return { code: null, action: 'HOLD', warn };
}
