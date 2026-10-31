// ============================================================================
// R18 SIGNAL FORMAT: every alert carries the pack's fields, and every entry gets
// an exit alert that quotes its alert_id, losers included (a complete track record).
// The paper desk sends these only to its owner's Telegram. Selling them as a product
// (pack section 8 "sell the signal") is her call, later.
// ============================================================================
export const RISK_LINE = 'High risk. Most new tokens go to zero. Not financial advice.';
const n = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? 'n/a' : Number(x).toFixed(d));
const sp = (x) => (x == null ? 'n/a' : x >= 1 ? Number(x).toFixed(4) : Number(x).toPrecision(4));

export function signalText(s) {
  const f = s.filters || {};
  const L = [
    `${s.type} · ${s.alertId}${s.entryAlertId ? ` (entry ${s.entryAlertId})` : ''} · ${new Date(s.at).toISOString().replace('.000', '')} · slot ${s.slot ?? 'n/a'}`,
    `${s.name || s.symbol} ($${s.symbol}) · mint ${s.mint} · pool ${s.pool} · ${s.dex || 'pumpswap'}`,
    `price ${sp(s.priceSol)} SOL / $${sp(s.priceUsd)} · mcap $${n(s.mcapUsd, 0)} · liq $${n(s.liqUsd, 0)} · ${n(s.minSinceMigration, 1)} min since migration`,
    `filters: mint ${f.mint ?? 'n/a'} · freeze ${f.freeze ?? 'n/a'} · LP ${f.lp ?? 'n/a'} · top10 ${f.top10 ?? 'n/a'} · cluster ${f.cluster ?? 'n/a'} · sell sim ${f.sim ?? 'n/a'}`,
    `cluster: ${s.clusterWallets ?? 'n/a'} wallets · ${n(s.clusterShare)}% · 5m change ${s.clusterChange5m == null ? 'n/a' : `${s.clusterChange5m >= 0 ? '+' : ''}${n(s.clusterChange5m)} pts`}`,
    s.type === 'ENTRY' ? `action: BUY (paper) · size ${n(s.sizePct)}% of bankroll` : s.type === 'WARNING' ? `action: HOLD · ${s.note || ''}` : `action: ${s.type === 'TAKE_PROFIT' ? 'SELL PART' : 'SELL ALL'} · trigger ${s.code} · ${n(s.multiple)}x the entry alert price${s.note ? ` · ${s.note}` : ''}`,
    RISK_LINE,
  ];
  return L.join('\n');
}
