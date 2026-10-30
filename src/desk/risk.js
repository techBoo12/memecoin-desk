// ============================================================================
// RISK DESK
// Job: protect the balance first, profit second. Sizes every trade by RISK
//      (Van Tharp): risk 0.5% of equity per trade -> size = risk / stop
//      distance, capped at 8% of equity. Sets the -6% stop BEFORE entry.
//      Moves stops UP only (trail after +12%). Takes profit on a ladder.
//      Freezes new trades on the daily loss limit, the weekly drawdown, or
//      after 2 losses in a row (cooldown, no revenge trades).
// HARD STOP: the risk desk never picks coins and never widens a stop.
//            A stop can only go up. If it would go down, the code throws.
// ============================================================================
export function utcDay(t = Date.now()) { return new Date(t).toISOString().slice(0, 10); }

export function newState(config) {
  const b = config.account.startingBalanceUsd;
  return {
    cash: b, startBalance: b, positions: [], closed: [], lossStreak: 0, cooldownUntil: 0,
    noReentry: {}, day: utcDay(), dayStartEquity: b, weekStartEquity: b, frozen: null,
  };
}

export const equity = (state) => state.cash + state.positions.reduce((s, p) => s + p.markUsd, 0);

export function rollDay(state) {
  const d = utcDay();
  if (d !== state.day) { state.day = d; state.dayStartEquity = equity(state); if (state.frozen?.why === 'daily loss limit') state.frozen = null; }
}

export function riskStatus(state, config) {
  rollDay(state);
  const eq = equity(state);
  const dayPnlPct = ((eq - state.dayStartEquity) / state.dayStartEquity) * 100;
  const weekDdPct = ((eq - state.weekStartEquity) / state.weekStartEquity) * 100;
  if (!state.frozen && dayPnlPct <= -config.account.dailyLossLimitPct) state.frozen = { why: 'daily loss limit', at: Date.now(), dayPnlPct: +dayPnlPct.toFixed(2) };
  if (!state.frozen && weekDdPct <= -config.account.weeklyMaxDrawdownPct) state.frozen = { why: 'weekly max drawdown', at: Date.now() };
  return { equity: eq, dayPnlPct, weekDdPct, frozen: state.frozen, cooldown: Date.now() < state.cooldownUntil };
}

export function sizeTrade(state, config) {
  const eq = equity(state);
  const riskUsd = eq * (config.risk.riskPerTradePct / 100);           // 1R in dollars
  const bySizing = riskUsd / (config.risk.stopLossPct / 100);          // risk / stop distance
  const sizeUsd = Math.min(bySizing, eq * (config.risk.maxPositionPct / 100), state.cash);
  return { sizeUsd: +sizeUsd.toFixed(2), riskUsd: +(sizeUsd * config.risk.stopLossPct / 100).toFixed(4) };
}

export function raiseStop(pos, newStop) {
  if (newStop < pos.stopPrice) throw new Error(`refusing to widen stop on ${pos.symbol}: ${pos.stopPrice} -> ${newStop}`);
  pos.stopPrice = newStop;
}

// returns the actions the executor must take for this position at this price
export function manage(pos, priceUsd, config) {
  const r = config.risk;
  const actions = [];
  pos.lastPrice = priceUsd;
  pos.peakPrice = Math.max(pos.peakPrice, priceUsd);
  const gainPct = (priceUsd / pos.entryPrice - 1) * 100;

  if (priceUsd <= pos.stopPrice) {
    actions.push({ type: 'exit', fraction: 1, reason: pos.trailing ? 'trailing stop' : `stop -${r.stopLossPct}%` });
    return actions;
  }
  if (!pos.trailing && gainPct >= r.trailActivatePct) { pos.trailing = true; actions.push({ type: 'note', reason: `+${gainPct.toFixed(1)}%: trailing stop ON` }); }
  if (pos.trailing) {
    const trail = pos.peakPrice * (1 - r.trailDistancePct / 100);
    if (trail > pos.stopPrice) raiseStop(pos, trail);
  }
  for (const step of r.takeProfitLadder) {
    if (!pos.tpDone.includes(step.atMultiple) && priceUsd >= pos.entryPrice * step.atMultiple) {
      pos.tpDone.push(step.atMultiple);
      actions.push({ type: 'sell', fraction: step.sellPct / 100, ofOriginal: true, reason: `take profit ${step.sellPct}% at ${step.atMultiple}x` });
    }
  }
  return actions;
}

// after every closed trade: streaks, cooldown, no-revenge list
export function afterClose(state, trade, config) {
  if (trade.source === 'manual') return { cooldown: false }; // her own trades don't put the bot in cooldown
  if (trade.pnlUsd < 0) state.lossStreak += 1; else state.lossStreak = 0;
  if (state.lossStreak >= config.risk.lossStreakForCooldown) {
    state.cooldownUntil = Date.now() + config.risk.cooldownMin * 60_000;
    state.lossStreak = 0;
    return { cooldown: true };
  }
  if (/stop/.test(trade.exitReason) && trade.pnlUsd < 0) state.noReentry[trade.mint] = Date.now() + config.risk.noReentryAfterStopMin * 60_000;
  return { cooldown: false };
}
