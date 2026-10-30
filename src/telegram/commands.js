// ============================================================================
// COMMANDS (owner only)
// /status /pause /resume /report /settings /set <key> <value> /help
// Job: turn a command into a short reply that reads well on a phone.
//      The desk is passed in as plain functions, so this file never touches
//      prices, wallets or Telegram itself.
// HARD STOP: commands can pause, resume and change whitelisted settings.
//            Nothing here can buy, sell, or switch off paper mode.
// ============================================================================
import { listSettings, showValue } from '../desk/settings.js';
import { RULE_WORDS } from './alerts.js';
import { testReportText, nearMissText, tradesText } from '../desk/report.js';

const size = (x) => (typeof x === 'number' ? x : x?.size ?? 0);
const n = (x, word) => `${x} ${word}${x === 1 ? '' : 's'}`;

const money = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const signed = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const sp = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));

export const HELP = `🤖 memecoin desk · paper mode

/status  balance, open trades, today p/l
/pause  stop new trades (stops still run)
/resume  back to work
/report  head of desk report
/trades  trades + why in, why out
/nearmiss  coins it almost bought + what they did
/settings  what you can change
/set <key> <value>  e.g. /set stop 7
/help  this list`;

export function statusText(d) {
  const { st, state, todayR, paused } = d;
  const open = state.positions.map((p) => {
    const chg = (p.lastPrice / p.entryPrice - 1) * 100;
    return `• $${p.symbol} ${signed(chg, 1)}% · worth $${p.markUsd.toFixed(2)} · stop $${sp(p.stopPrice)}${p.trailing ? ' (trailing)' : ''}`;
  });
  const deskWord = st.frozen ? `🧊 frozen: ${st.frozen.why}` : paused ? '⏸ paused by you (stops still run)' : st.cooldown ? '⏸ cooldown after losses' : '✅ running, not frozen';
  return [
    '📊 desk status · paper',
    `balance $${st.equity.toFixed(2)} (cash $${state.cash.toFixed(2)})`,
    `today ${signed(st.dayPnlPct)}% · ${signed(todayR)}R`,
    `open trades: ${state.positions.length}`,
    ...open,
    `desk: ${deskWord}`,
    ...(state.test?.endsAt ? [`🧪 ${state.test.hours}h test${state.test.n > 1 ? ` #${state.test.n}` : ''}: ${Math.max(0, (Date.now() - state.test.startedAt) / 3.6e6).toFixed(1)}h in · report at ${new Date(state.test.endsAt).toISOString().slice(11, 16)} utc`] : []),
    ...(d.config?.loop?.watchEverySec ? [`exits checked every ${d.config.loop.watchEverySec}s`] : []),
  ].join('\n');
}

export function reportText(d) {
  const { st, state, stats: s, run, config } = d;
  const kills = Object.entries(run.killsByRule || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => { const [num, id] = k.split(' '); return `${RULE_WORDS[id] || id} ${v} (rule ${num})`; }).join(', ') || 'none';
  const closed = state.closed.slice(-5).map((x) => `• $${x.symbol} ${x.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(x.pnlUsd).toFixed(2)} (${signed(x.pnlPct)}%, ${signed(x.R)}R) ${x.exitReason}`);
  return [
    `📋 head of desk report · ${state.day}`,
    `balance $${st.equity.toFixed(2)} (started $${state.startBalance.toFixed(2)}) · today ${signed(st.dayPnlPct)}%`,
    '',
    `this session: ${n(run.scans, 'scan')} · ${n(size(run.uniqueCoins), 'coin')} · ${size(run.killedCoins)} killed`,
    `killed by: ${kills}`,
    `passed all 8 rules: ${size(run.alive)} · paper buys: ${run.approved} · no-trade calls: ${run.vetoes}`,
    '',
    `trades closed: ${s.trades} (${n(s.wins, 'win')}, ${n(s.losses, 'loss').replace('losss', 'losses')})`,
    `realized ${money(s.realizedUsd)} · expectancy ${signed(s.expectancyR)}R per trade`,
    ...closed,
    state.positions.length ? `open: ${state.positions.map((p) => '$' + p.symbol).join(', ')}` : 'open: none',
    '',
    s.trades < 20 ? `${n(s.trades, 'trade')} is too few to judge. thinking in probabilities` : '20+ trades, the numbers start to mean something',
    `rule #1: ${config.topRule}`,
  ].join('\n');
}

export function settingsText(config) {
  return ['⚙️ settings you can change', ...listSettings(config).map(({ key, spec, value }) => `${key}: ${showValue(spec, value)}  (${spec.label})`),
    '', 'change one: /set stop 7', 'mode: paper (locked)'].join('\n');
}

// desk = { snapshot(), pause(), resume(), set(key, value) }
export async function runCommand(text, desk) {
  const [cmdRaw, ...args] = String(text).trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
  switch (cmd) {
    case '/start':
    case '/help': return HELP;
    case '/status': return statusText(desk.snapshot());
    case '/report': { const d = desk.snapshot(); return d.S ? testReportText({ S: d.S, config: d.config }) : reportText(d); }
    case '/trades': { const d = desk.snapshot(); return tradesText(d.state); }
    case '/nearmiss':
    case '/nearmisses': { const d = desk.snapshot(); return d.S ? nearMissText(d.S) : 'near-miss tracker runs with the day 3 desk'; }
    case '/settings': return settingsText(desk.snapshot().config);
    case '/pause': {
      if (desk.snapshot().paused) return '⏸ already paused';
      await desk.pause();
      return '⏸ paused. no new trades, no scans. open trades keep their stops. /resume when ready';
    }
    case '/resume': {
      if (!desk.snapshot().paused) return '✅ already running';
      await desk.resume();
      return '▶️ back on. next scan in a moment';
    }
    case '/set': {
      if (args.length < 2) return 'how: /set <key> <value>\nexample: /set stop 7\n/settings shows the keys';
      const r = await desk.set(args[0], args.slice(1).join(' '));
      if (!r.ok) return `❌ ${r.error}`;
      const note = ['stop', 'trailat', 'trail'].includes(r.key) ? '\nnew trades only. open trades keep their stop (stops only go up)' : '';
      return `✅ ${r.key}: ${showValue(r.spec, r.old)} → ${showValue(r.spec, r.value)}${note}`;
    }
    default: return `don't know ${cmd} 🤔\n\n${HELP}`;
  }
}
