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

/menu  the button panel (buy, sell, positions, settings)
paste a coin address  safety check + paper buy buttons
/status  balance, open trades, today p/l
/pause  stop new trades (stops still run)
/resume  back to work
/report  head of desk report
/trades  trades + why in, why out
/nearmiss  coins it almost bought + what they did
/insider  the insider-exit lane (training pack): skips, trades, labels, go/no-go
/alerts on|off  dev-crew alerts (loading / dumping a fresh coin)
/smart  smart-wallet list + the copy lane's own paper stats
/hype  the hype lane: trending coins watchlist, its own paper trades
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
    ...(state.campaign && state.test ? [`📅 day ${(state.test.n || 1) - state.campaign.firstN + 1} of ${state.campaign.days} (paper run, go/no-go at day ${state.campaign.days})`] : []),
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
    case '/hype': { const d = desk.snapshot(); return d.S?.hypeLines ? hypeText(d.S) : 'the hype lane is off'; }
    case '/insider': { const d = desk.snapshot(); return d.S?.pbLines ? insiderText(d.S) : 'the insider-exit lane is off'; }
    case '/smart': { const d = desk.snapshot(); return d.S?.copyLines ? smartText(d.S) : 'the copy lane is off'; }
    case '/alerts': {
      const d = desk.snapshot();
      const on = d.config?.playbook?.alerts?.enabled !== false;
      if (!args.length) return alertsText(d, on);
      const r = await desk.set('insideralerts', args[0]);
      if (!r.ok) return `❌ ${r.error.replace('insideralerts', '/alerts')}`;
      return r.value ? '🚨 insider alerts on. max a few an hour, one per coin per event' : '🔕 insider alerts off. /alerts on to bring them back';
    }
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

// day 5: the training pack's insider-exit lane at a glance
export function insiderText(S, { limit = 8 } = {}) {
  const recent = (S.pb?.recent || []).slice(0, limit).map((x) => `• $${x.sym} ${x.d === 'skip' ? `skip ${x.code}` : x.d} · ${String(x.note).slice(0, 90)}`);
  return [...S.pbLines(), '', ...(recent.length ? ['latest:', ...recent] : ['nothing seen yet']), '', 'paper only · numbers are starting guesses to tune'].join('\n').slice(0, 4000);
}

// Oct 31: dev-crew alerts status
export function alertsText(d, on) {
  const a = d.S?.pb?.alerts || {}, c = d.config?.playbook?.alerts || {};
  const lastHour = (a.sent || []).filter((t) => Date.now() - t < 3.6e6).length;
  return [`🚨 insider alerts: ${on ? 'on' : 'off'}`,
    `loading: the dev's linked wallets hold ${c.crew_buy_pct ?? 20}%+ of a fresh coin`,
    `dumping: their share drops ${c.dump_drop_pts ?? 5}+ pts (or ${c.dump_drop_rel_pct ?? 30}%) within ${c.watch_minutes ?? 60} min`,
    `max ${c.max_per_hour ?? 6} an hour, one per coin per event · sent ${a.n || 0} so far (${lastHour} in the last hour)${a.suppressed ? ` · ${a.suppressed} held back by the hourly cap` : ''}`,
    `watching ${Object.keys(a.watch || {}).length} crews now`, '', on ? '/alerts off to mute' : '/alerts on to switch on'].join('\n');
}

// Oct 31: the smart-wallet list + the copy lane's own paper stats
export function smartText(S, { limit = 10 } = {}) {
  const sm = S.smart || {}, list = sm.list || [];
  const rows = list.slice(0, limit).map((x, i) => `${i + 1}. ${x.w.slice(0, 4)}…${x.w.slice(-4)} · win ${Math.round((x.winRate || 0) * 100)}% of ${x.closed} · ${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol} SOL · ${x.txPerDay}/day`);
  const recent = (S.copy?.recent || []).slice(0, 5).map((x) => `• $${x.sym} ${x.d === 'skip' ? `skip ${x.code}` : x.d} · ${String(x.note).slice(0, 80)}`);
  return [
    ...S.copyLines(), '',
    list.length ? `top ${Math.min(limit, list.length)} of ${list.length} (realized, last ~7 days, from their own on-chain trades):` : 'no list yet (it is built once a day off the worker)',
    ...rows,
    ...(sm.winners?.length ? ['', `built from early buyers of: ${sm.winners.slice(0, 6).map((w) => `$${w.symbol} ${w.x}x`).join(', ')}`] : []),
    ...(recent.length ? ['', 'latest:', ...recent] : []),
    '', '"smart" = a statistical label from past trades (small sample), not proof of skill or inside info. paper only',
  ].join('\n').slice(0, 4000);
}

// day 6: the hype lane (trend-matched coins, own paper book, not in the 14-day numbers)
export function hypeText(S, { limit = 6 } = {}) {
  const H = S.hype || {};
  const hot = (H.watch?.items || []).slice(0, 5).map((x) => `• $${x.symbol} ${x.score}${x.bigName ? ' 👑' : ''}${x.early ? ' 🌱early' : ''} · ${String(x.why?.[0] || '').slice(0, 80)}`);
  const recent = (H.recent || []).slice(0, limit).map((x) => `• $${x.sym} ${x.d === 'skip' ? `skip ${x.code}` : x.d} · ${String(x.note).slice(0, 90)}`);
  return [...S.hypeLines(), '', ...(hot.length ? ['watchlist:', ...hot] : ['watchlist empty']), '', ...(recent.length ? ['latest:', ...recent] : []), '', 'paper only · 👑 = big-name exception candidate · numbers are starting guesses'].join('\n').slice(0, 4000);
}
