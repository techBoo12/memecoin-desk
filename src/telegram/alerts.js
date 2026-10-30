// ============================================================================
// ALERTS
// Job: turn desk events into short phone-sized messages. One function per
//      event, plain text, lowercase, a little emoji, no walls of numbers.
// HARD STOP: formatting only. Alerts never decide anything.
// ============================================================================
const sp = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}m` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Number(x).toFixed(0)}`);
const signed = (x, d = 2) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;

export const RULE_WORDS = {
  mint_freeze: 'mint/freeze live', lp_locked: 'lp not locked', liquidity: 'low liq', volume_1h: 'low volume',
  top10: 'top10 too big', dev: 'dev bag', bundled: 'bundled', pumped_1h: 'already pumped', sell_test: 'sell test',
};

export function scanAlert({ scan, checked, kills, passed, picks, sellFails, equity }) {
  const killed = Object.values(kills).reduce((a, b) => a + b, 0);
  const why = Object.entries(kills).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${RULE_WORDS[id] || id} ${n}`).join(', ');
  return [
    `🔎 scan #${scan} · ${checked} coins checked`,
    `✖ ${killed} killed${why ? ` (${why})` : ''}`,
    `✔ ${passed} passed all 8 rules${picks ? ` · ${picks} scored 70+` : ''}`,
    ...(sellFails ? [`⇄ ${sellFails} failed the sell test`] : []),
    `balance $${equity.toFixed(2)}`,
  ].join('\n');
}

export function vetoWords(reason, symbol) {
  const r = String(reason);
  if (/stopped out on this coin/.test(r)) return `no revenge trade on $${symbol}. it stopped us out earlier`;
  if (/cooldown/.test(r)) return 'no revenge trades: 2 losses in a row, cooling off';
  if (/frozen/.test(r)) return 'desk is frozen, no new trades today';
  if (/paused/.test(r)) return 'desk is paused by you';
  if (/max \d+ open/.test(r)) return `already holding the max (${r.match(/max (\d+)/)[1]} trades), skipping`;
  const tape = r.match(/5m (-?[\d.]+)%, 1h (-?[\d.]+)%/);
  if (/falling tape/.test(r)) return `chart is falling${tape ? ` (5m ${tape[1]}%, 1h ${tape[2]}%)` : ''}, waiting for it to turn`;
  if (/size under/.test(r)) return 'size under $1, not worth the fees';
  return r;
}

export function pickAlert({ symbol, score, mcap, liq, ageMin, verdict }) {
  return [
    `⭐ pick: $${symbol} scored ${score}/100`,
    `mcap ${usd(mcap)} · liq ${usd(liq)} · ${ageMin >= 120 ? Math.round(ageMin / 60) + 'h' : Math.round(ageMin) + 'm'} old`,
    verdict.approved ? '✅ head of desk: approved' : `🙅 head of desk: ${vetoWords(verdict.reason, symbol)}`,
  ].join('\n');
}

export function buyAlert(pos, config) {
  return [
    `🟢 paper buy $${pos.symbol}`,
    `$${pos.sizeUsd.toFixed(2)} @ $${sp(pos.entryPrice)}`,
    `stop $${sp(pos.stopPrice)} (-${config.risk.stopLossPct}%) · 1R = $${pos.riskUsd.toFixed(2)}`,
  ].join('\n');
}

export function sellAlert(trade) {
  const stop = /stop/.test(trade.exitReason) && trade.pnlUsd < 0;
  return [
    stop ? `🛑 stopped out: $${trade.symbol}` : `${trade.pnlUsd >= 0 ? '💰' : '🔴'} paper sell $${trade.symbol}`,
    `entry $${sp(trade.entryPrice)} → exit $${sp(trade.exitPrice)}`,
    `p/l ${trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(trade.pnlUsd).toFixed(2)} (${signed(trade.pnlPct)}%, ${signed(trade.R)}R)`,
    `why: ${trade.exitReason}`,
  ].join('\n');
}

export function partialAlert(fill) {
  return `💰 ${fill.reason}: sold part of $${fill.symbol} @ $${sp(fill.priceUsd)} for $${fill.proceeds.toFixed(2)}`;
}

export function trailAlert(pos, note) {
  return `📈 $${pos.symbol} ${note}. stop moved up, never down`;
}

export function freezeAlert(frozen, dayPnlPct, config) {
  return [
    `🧊 desk frozen: ${frozen.why}`,
    `today ${signed(dayPnlPct)}% (limit -${config.account.dailyLossLimitPct}%)`,
    'stops still run. no new trades till tomorrow',
  ].join('\n');
}

export function cooldownAlert(config) {
  return `⏸ cooldown ${config.risk.cooldownMin} min: ${config.risk.lossStreakForCooldown} losses in a row. no revenge trades`;
}

export function onlineAlert({ equity, config, open }) {
  return `🟢 desk online · paper\nbalance $${equity.toFixed(2)} · ${open} open trade${open === 1 ? '' : 's'}\nscanning every ${Math.round(config.loop.scanEverySec / 60)} min`;
}
