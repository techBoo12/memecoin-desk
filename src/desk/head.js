// ============================================================================
// HEAD OF DESK
// Job: the only one who says yes. Reads every proposal from the analyst and
//      the risk desk and APPROVES or VETOES it with one plain reason. Writes
//      one daily report: P/L, R-multiples, expectancy, every kill rule count.
//      "No trade" is a real decision and gets logged like a trade.
// HARD STOP: the Head of Desk NEVER trades. This file imports no executor,
//            no quote, no wallet. Top rule: protect the balance first,
//            profit second.
// ============================================================================
export function review(proposal, status, state, config) {
  const veto = (reason) => ({ approved: false, reason });
  const { c, a, size } = proposal;
  if (config.mode !== 'paper') return veto('desk is in paper mode only');
  if (status.frozen) return veto(`trading frozen: ${status.frozen.why}`);
  if (status.cooldown) return veto(`cooldown after ${config.risk.lossStreakForCooldown} losses in a row (no revenge trades)`);
  if (state.positions.some((p) => p.mint === c.mint)) return veto('already holding it');
  if ((state.noReentry[c.mint] || 0) > Date.now()) return veto('stopped out on this coin recently, no re-entry');
  if (state.positions.length >= config.risk.maxOpenPositions) return veto(`max ${config.risk.maxOpenPositions} open positions`);
  const cap = config.quality?.maxTradesPerDay;
  const day = new Date().toISOString().slice(0, 10);
  const today = [...state.positions, ...state.closed].filter((t) => String(t.entryAt).slice(0, 10) === day).length;
  if (cap && today >= cap) return veto(`daily trade cap: ${today}/${cap} trades today (quality over quantity)`);
  if (!a.passes) return veto(`score ${a.score} < ${config.analyst.passScore}`);
  if (!a.tapeOk) return veto(`falling tape (5m ${a.tape.m5}%, 1h ${a.tape.h1}%), wait for confirmation`);
  if (proposal.q && !proposal.q.ok) return veto(`quality gate: ${proposal.q.failed.map((x) => x.note).join('; ')}`);
  if (size.sizeUsd < 1) return veto('size under $1, not worth the fees');
  return { approved: true, reason: `score ${a.score}, risk ${size.riskUsd.toFixed(2)} (1R), size $${size.sizeUsd.toFixed(2)}` };
}

export function stats(state) {
  const t = state.closed;
  const wins = t.filter((x) => x.pnlUsd > 0);
  const losses = t.filter((x) => x.pnlUsd <= 0);
  const avg = (xs, f) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : 0);
  return {
    trades: t.length, wins: wins.length, losses: losses.length,
    winRate: t.length ? wins.length / t.length : 0,
    avgWinR: avg(wins, (x) => x.R), avgLossR: avg(losses, (x) => x.R),
    expectancyR: avg(t, (x) => x.R), // Van Tharp: average R per trade
    realizedUsd: t.reduce((s, x) => s + x.pnlUsd, 0),
  };
}

export function dailyReport(state, run, status, config) {
  const s = stats(state);
  const allHits = Object.entries(run.allHitsByRule || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  const killLines = Object.entries(run.killsByRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v} coins`).join('\n') || '- none';
  const open = state.positions.map((p) => `- ${p.id} ${p.symbol}: mark $${p.markUsd.toFixed(2)} (cost $${p.sizeUsd.toFixed(2)}), stop $${p.stopPrice.toPrecision(4)}${p.trailing ? ' trailing' : ''}`).join('\n') || '- none';
  const closed = state.closed.map((x) => `- ${x.id} ${x.symbol}: ${x.pnlUsd >= 0 ? '+' : ''}$${x.pnlUsd.toFixed(2)} (${x.pnlPct}%, ${x.R}R), ${x.exitReason}`).join('\n') || '- none';
  return `# Head of Desk report · ${state.day} (PAPER)

Top rule: ${config.topRule}.

## Balance
- equity: $${status.equity.toFixed(2)} (start $${state.startBalance.toFixed(2)}), cash $${state.cash.toFixed(2)}
- today: ${status.dayPnlPct >= 0 ? '+' : ''}${status.dayPnlPct.toFixed(2)}% (limit -${config.account.dailyLossLimitPct}%) · week goal +${config.account.weeklyGoalPct}%, max drawdown -${config.account.weeklyMaxDrawdownPct}%
- frozen: ${status.frozen ? status.frozen.why : 'no'}

## Desk activity
- scans: ${run.scans} · coin checks: ${run.checks} · unique coins: ${run.uniqueCoins.size}
- killed (unique coins, by first rule hit):
${killLines}
- every rule hit (a coin can fail several): ${allHits}
- failed sell test: ${run.honeypotKills} · scored below ${config.analyst.passScore}: ${run.lowScore} · falling tape: ${run.fallingTape}
- head of desk vetoes: ${run.vetoes} · approved: ${run.approved}

## Trades
- closed: ${s.trades} (wins ${s.wins}, losses ${s.losses}, win rate ${(s.winRate * 100).toFixed(0)}%)
- realized P/L: ${s.realizedUsd >= 0 ? '+' : ''}$${s.realizedUsd.toFixed(2)}
- expectancy: ${s.expectancyR.toFixed(2)}R per trade (avg win ${s.avgWinR.toFixed(2)}R, avg loss ${s.avgLossR.toFixed(2)}R)
- ${s.trades < 20 ? `sample is ${s.trades} trades: under 20, not enough to judge the system yet (think in probabilities)` : 'sample is 20+ trades: stats are starting to mean something'}

Closed:
${closed}

Open:
${open}
`;
}
