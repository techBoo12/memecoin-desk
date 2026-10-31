// ============================================================================
// HEAD OF DESK: the 24h report (day 3)
// Job: one honest page after each 24h window: trades, win rate, P/L, R,
//      expectancy, every trade with WHY it was bought and WHY it was sold,
//      and the near-miss tracker's verdict (are the rules too strict, or are
//      they saving us?). Phone-sized: it goes to Telegram.
// HARD STOP: reporting only.
// ============================================================================
import { equity, riskStatus } from './risk.js';
import { summarize, outcome } from './nearmiss.js';

const signed = (x, d = 2) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

export function windowStats(st, since, which = 'bot') {
  const t = st.closed.filter((x) => Date.parse(x.entryAt) >= since && (which === 'manual' ? x.source === 'manual' : x.source !== 'manual'));
  const wins = t.filter((x) => x.pnlUsd > 0), losses = t.filter((x) => x.pnlUsd <= 0);
  const sumR = t.reduce((s, x) => s + x.R, 0);
  return { t, n: t.length, wins: wins.length, losses: losses.length, winRate: t.length ? wins.length / t.length : 0,
    pnl: t.reduce((s, x) => s + x.pnlUsd, 0), sumR, expectancy: t.length ? sumR / t.length : 0,
    avgWin: wins.length ? wins.reduce((s, x) => s + x.R, 0) / wins.length : 0, avgLoss: losses.length ? losses.reduce((s, x) => s + x.R, 0) / losses.length : 0 };
}

export function testReportText({ S, config, now = Date.now() }) {
  const st = S.desk, run = S.run, t = st.test || { startedAt: run.since, hours: 24, equityAtStart: st.startBalance };
  const since = t.startedAt;
  const w = windowStats(st, since);
  const wm = windowStats(st, since, 'manual');
  const eq = equity(st);
  const open = st.positions.filter((p) => Date.parse(p.entryAt) >= since);
  const carried = st.positions.filter((p) => Date.parse(p.entryAt) < since);
  const nm = summarize(S.nm, { since });
  const qf = Object.entries(run.qualityFails || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const kills = Object.entries(run.killsByRule || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k.split(' ')[1]} ${v}`).join(', ') || 'none';
  const tradeLines = w.t.map((x) => `• $${x.symbol} ${money(x.pnlUsd)} (${signed(x.R)}R) · in: score ${x.score}${x.why?.quality ? `, quality ${x.why.quality.length}/${x.why.quality.length}` : ''} · out: ${x.exitReason}`);
  const nmTop = Object.entries(nm.byReason).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
    .map(([k, b]) => `• ${k}: ${b.n} (📈${b.pumped} 📉${b.dumped} ➖${b.flat}${b.pending ? ` ⏳${b.pending}` : ''})`);
  return [
    `📋 head of desk · ${t.hours}h paper report${t.n > 1 ? ` #${t.n}` : ''}`,
    `${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} utc`,
    '',
    `balance $${eq.toFixed(2)} (window start $${(t.equityAtStart ?? eq).toFixed(2)}, ${signed(((eq / (t.equityAtStart || eq)) - 1) * 100)}%)`,
    `trades: ${w.n} · wins ${w.wins} · losses ${w.losses} · win rate ${(w.winRate * 100).toFixed(0)}%`,
    `p/l ${money(w.pnl)} · ${signed(w.sumR)}R total · expectancy ${signed(w.expectancy)}R/trade`,
    w.n ? `avg win ${signed(w.avgWin)}R · avg loss ${signed(w.avgLoss)}R` : 'no closed trades in this window',
    ...tradeLines,
    ...(wm.n ? [`your manual trades (not in the bot's stats): ${wm.n} · p/l ${money(wm.pnl)} · ${signed(wm.sumR)}R`] : []),
    open.length ? `still open: ${open.map((p) => `$${p.symbol} ${signed(((p.lastPrice / p.entryPrice) - 1) * 100, 1)}%`).join(', ')}` : '',
    carried.length ? `carried from before the test: ${carried.map((p) => '$' + p.symbol).join(', ')}` : '',
    '',
    `desk: ${run.scans} scans · ${run.uniqueCoins} coins · ${run.killedCoins} killed (${kills})`,
    `passed 8/8 rules: ${run.alive} · paper buys: ${run.approved} · skipped by quality/head: ${run.vetoes}`,
    `quality gate said no most for: ${qf}`,
    '',
    `🔍 near misses: ${nm.totals.n} coins it almost bought`,
    `📈 pumped ${nm.totals.pumped} · 📉 dumped ${nm.totals.dumped} · ➖ flat ${nm.totals.flat}${nm.totals.pending ? ` · ⏳ not checked yet ${nm.totals.pending}` : ''}`,
    ...nmTop,
    ...(nm.verdicts.length ? ['verdict:', ...nm.verdicts.map((v) => `• ${v}`)] : ['verdict: not enough checked near misses yet to call it']),
    '',
    w.n < 20 ? `${w.n} trade${w.n === 1 ? '' : 's'} is too few to judge the system. 20+ before any verdict` : '20+ trades: the numbers start to mean something',
    ...(S.pbLines ? ['', ...S.pbLines()] : []),
    `rule #1: ${config.topRule}`,
  ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').slice(0, 4000);
}

export function nearMissText(S, { limit = 8 } = {}) {
  const nm = summarize(S.nm);
  const recent = [...S.nm.items].reverse().slice(0, limit).map((it) => {
    const o = outcome(it);
    const ago = Math.round((Date.now() - it.at) / 60000);
    return `• $${it.symbol} (${ago >= 120 ? Math.round(ago / 60) + 'h' : ago + 'm'} ago) ${it.reasonKey}${it.score != null ? `, score ${it.score}` : ''} → ${o.label === 'pending' ? '⏳ not checked yet' : `${o.label} ${signed(o.chg, 0)}% @${o.at}`}`;
  });
  return [
    `🔍 near misses (coins it almost bought)`,
    `${nm.totals.n} tracked · 📈 ${nm.totals.pumped} pumped · 📉 ${nm.totals.dumped} dumped · ➖ ${nm.totals.flat} flat · ⏳ ${nm.totals.pending}`,
    ...recent,
    ...(nm.verdicts.length ? ['', ...nm.verdicts.map((v) => `• ${v}`)] : []),
    '',
    'checked again at +15m, +1h, +4h, +24h',
  ].join('\n');
}

export function tradesText(st, { limit = 4 } = {}) {
  const lines = [];
  for (const p of st.positions) lines.push(`🟢 $${p.symbol} open ${signed(((p.lastPrice / p.entryPrice) - 1) * 100, 1)}%\n  why in: ${whyIn(p.why, p.score)}`);
  for (const x of st.closed.slice(-limit).reverse()) lines.push(`${x.pnlUsd >= 0 ? '💰' : '🔴'} $${x.symbol} ${money(x.pnlUsd)} (${signed(x.R)}R)\n  why in: ${whyIn(x.why, x.score)}\n  why out: ${x.exitReason}${x.exit?.fillSource ? ` · filled at ${x.exit.fillSource}` : ''}`);
  return lines.length ? `🧾 trades + reasons\n\n${lines.join('\n\n')}` : 'no trades yet. quality over quantity 🙂';
}

export function whyIn(why, score) {
  if (!why) return `score ${score} (before day 3: no reason log)`;
  if (why.manual) return `manual buy by you · score ${why.score} · ${why.rulesPassed}/8 rules · quality ${why.quality} · ${why.safety}`;
  const p = why.parts || {};
  return `score ${why.score} (mom ${p.momentum}, buys ${p.buyPressure}, activity ${p.activity}, turnover ${p.turnover}, liq ${p.liqMcap}, holders ${p.holders}) · 8/8 rules · quality ${why.quality.length}/${why.quality.length} · ${why.buys} buys · holders ${why.holders} · ${why.tape}`;
}
