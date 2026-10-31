// ============================================================================
// ALERTS
// Job: turn desk events into short phone-sized messages. One function per
//      event, plain text, lowercase, a little emoji, no walls of numbers.
// HARD STOP: formatting only. Alerts never decide anything.
// ============================================================================
import { buyCard } from './buycard.js';
const sp = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}m` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Number(x).toFixed(0)}`);
const signed = (x, d = 2) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;

// alert level (day 4 ⚙️): 'trades' = only what moves money or freezes the desk; 'all' adds scan digests + picks
export const CHATTY_KINDS = ['scan', 'pick'];
export function alertAllowed(kind, config) {
  if (kind === 'scan' && config.telegram?.scanAlerts === false) return false;
  if (config.telegram?.alertLevel === 'trades' && CHATTY_KINDS.includes(kind)) return false;
  return true;
}

export const RULE_WORDS = {
  mint_freeze: 'mint/freeze live', lp_locked: 'lp not locked', liquidity: 'low liq', volume_1h: 'low volume',
  top10: 'top10 too big', dev: 'dev bag', bundled: 'bundled', pumped_1h: 'already pumped', sell_test: 'sell test',
};

export function scanAlert({ scan, scans = 1, minutes = 0, checked, kills, passed, picks, sellFails, near = 0, equity }) {
  const killed = Object.values(kills).reduce((a, b) => a + b, 0);
  const why = Object.entries(kills).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${RULE_WORDS[id] || id} ${n}`).join(', ');
  return [
    minutes ? `🔎 last ${minutes >= 55 ? 'hour' : minutes + ' min'} · ${scans} scans · ${checked} coin checks` : `🔎 scan #${scan} · ${checked} coins checked`,
    `✖ ${killed} killed${why ? ` (${why})` : ''}`,
    `✔ ${passed} passed all 8 rules${picks ? ` · ${picks} scored 80+` : ''}`,
    ...(sellFails ? [`⇄ ${sellFails} failed the sell test`] : []),
    ...(near ? [`◌ ${near} near miss${near === 1 ? '' : 'es'} logged (/nearmiss)`] : []),
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
  const pct = (x) => `${Number(x) >= 0 ? '+' : ''}${Math.round(Number(x))}%`;
  if (/falling tape/.test(r)) return `chart is dipping${tape ? ` (5m ${pct(tape[1])}, 1h ${pct(tape[2])})` : ''}, waiting for it to turn`;
  if (/size under/.test(r)) return 'size under $1, not worth the fees';
  if (/daily trade cap/.test(r)) return `already took today's max trades (${(r.match(/(\d+\/\d+)/) || [])[1] || ''}). quality over quantity`;
  if (/quality gate/.test(r)) return `quality gate said no: ${r.replace(/^quality gate: /, '')}`;
  return r;
}

export function pickAlert({ symbol, score, mcap, liq, ageMin, verdict, q }) {
  return [
    `⭐ pick: $${symbol} scored ${score}/100`,
    `mcap ${usd(mcap)} · liq ${usd(liq)} · ${ageMin >= 120 ? Math.round(ageMin / 60) + 'h' : Math.round(ageMin) + 'm'} old`,
    ...(q ? [`quality ${q.passedCount}/${q.total}`] : []),
    verdict.approved ? '✅ head of desk: approved' : `🙅 head of desk: ${vetoWords(verdict.reason, symbol)}`,
  ].join('\n');
}

export function buyAlert(pos, config) {
  const w = pos.why;
  if (!w) return [`🟢 paper buy $${pos.symbol}`, `$${pos.sizeUsd.toFixed(2)} @ $${sp(pos.entryPrice)}`, `stop $${sp(pos.stopPrice)} (-${config.risk.stopLossPct}%) · 1R = $${pos.riskUsd.toFixed(2)}`].join('\n');
  // Oct 31 (her ask): one card with everything: crew %, dev history, rules passed, why
  return buyCard({
    lane: 'desk', symbol: pos.symbol, mint: pos.mint, pool: w.pool || pos.pair || null, sizeUsd: pos.sizeUsd, entryPrice: pos.entryPrice, liqUsd: w.liq, mcapUsd: w.mcap,
    crew: { pct: w.crewPct ?? null, cap: config.filter?.maxBundledPct, source: 'linked/insider wallets, rugcheck proxy' }, devPct: Number.isFinite(w.devPct) ? w.devPct : null,
    devHist: pos.devHist || null, passed: (w.rules || []).map((r) => r.replace(/^\d+ /, '')),
    why: `score ${w.score}/100 · 8/8 rules · quality ${w.quality.length}/${w.quality.length} · ${w.head || 'head of desk approved'}`,
    extra: [`stop $${sp(pos.stopPrice)} (-${config.risk.stopLossPct}%) · 1R = $${pos.riskUsd.toFixed(2)}`, `buys ${w.buys} · holders ${w.holders}`, `chart ${w.tape}`, `sell test ok: ${w.sellTest.split(',')[0]}`],
  });
}

export function sellAlert(trade) {
  const stop = /stop/.test(trade.exitReason) && trade.pnlUsd < 0;
  const emergency = /emergency/.test(trade.exitReason);
  return [
    emergency ? `🚨 emergency exit: $${trade.symbol}` : stop ? `🛑 stopped out: $${trade.symbol}` : `${trade.pnlUsd >= 0 ? '💰' : '🔴'} paper sell $${trade.symbol}`,
    `entry $${sp(trade.entryPrice)} → exit $${sp(trade.exitPrice)}`,
    `p/l ${trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(trade.pnlUsd).toFixed(2)} (${signed(trade.pnlPct)}%, ${signed(trade.R)}R)`,
    `why: ${trade.exitReason}`,
    ...(trade.exit ? [`checked every ${trade.exit.checkEverySec}s · filled at ${trade.exit.fillSource}${trade.exit.slipVsStopPct != null ? ` (${trade.exit.slipVsStopPct}% vs stop)` : ''} · peak +${trade.exit.peakPct}%`] : []),
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
  return `🟢 desk online · paper\nbalance $${equity.toFixed(2)} · ${open} open trade${open === 1 ? '' : 's'}\nscanning every ${Math.round(config.loop.scanEverySec / 60)} min · open trades checked every ${config.loop.watchEverySec}s`;
}

export function testStartAlert({ equity, config, hours, where, endsAt }) {
  const q = config.quality;
  return [
    `🚀 ${hours}h paper test started${where ? ` on ${where}` : ''}`,
    `balance $${equity.toFixed(2)} · ends ${new Date(endsAt).toISOString().slice(0, 16).replace('T', ' ')} utc`,
    '',
    'new rules (quality over quantity):',
    `• score ${config.analyst.passScore}+ and all 8 rules pass, zero unknowns`,
    `• buys ${Math.round(q.minBuyShare1h * 100)}%+ on 1h and ${Math.round(q.minBuyShare5m * 100)}%+ on 5m`,
    '• chart up on 5m AND 1h, holders rising',
    `• liq ${Math.round(q.minLiqToMcap * 100)}%+ of mcap, not already pumped`,
    `• max ${q.maxTradesPerDay} trades a day, ${config.risk.maxOpenPositions} open at once`,
    `• open trades checked every ${config.loop.watchEverySec}s + emergency exit if liquidity gets pulled`,
    '• near-miss tracker on: every coin it almost bought, re-checked at 15m/1h/4h/24h',
    '',
    '/status /trades /nearmiss /report',
  ].join('\n');
}

export function offlineAlert(open) {
  return `🔴 desk offline, this run is over\n${open ? `${open} open trade${open === 1 ? '' : 's'} saved, stops resume when it's back` : 'nothing open'}. commands work again when the desk is back`;
}
