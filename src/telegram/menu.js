// ============================================================================
// THE BUTTON MENU (day 4): memecoin desk in Telegram, tap instead of type.
//   🏠 home panel: balance, today p/l, open positions, desk status, auto-buy
//   🟢 Buy: paste a coin address -> full safety check card -> $5 / $10 / $25 / custom
//   🔴 Sell + 📂 Positions: per-position card -> 25% / 50% / 100%
//   👀 near misses · 📋 report · ⚙️ settings (steppers + toggles) · ⏸ pause · 🔄 refresh
// One panel, edited in place (editMessageText), not a new message per tap.
// Callback data is tiny ("ps:T006:50" etc, far under Telegram's 64 bytes).
// Every tap gets answerCallbackQuery. Old buttons get a fresh panel, not an error.
// HARD STOP: owner only (checked on every tap). Paper only. Mode can't be
//            changed from here. Settings go through the same whitelist + ranges as /set.
// Platform-free: the worker passes in `io` (telegram calls) and `desk` (actions).
// ============================================================================
import { listSettings, showValue, getSetting, SETTINGS, STEPS } from '../desk/settings.js';
import { positionView, isMint } from '../desk/manual.js';
import { stats } from '../desk/head.js';
import { testReportText, nearMissText } from '../desk/report.js';
import { usd } from '../desk/filter.js';

export const CHECK_TTL_MS = 10 * 60_000;   // a check card's prices are trusted for 10 min, then it re-checks
export const AMOUNTS = [5, 10, 25];
export const PRIVATE_TAP = 'this desk is private 🔒';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sg = (x, d = 2) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
const sp = (x) => (x >= 1 ? Number(x).toFixed(4) : Number(x).toPrecision(4));
const b = (text, data) => ({ text, callback_data: data });
const hhmm = (t) => new Date(t).toISOString().slice(11, 19);
const HOME = b('🏠 home', 'h');
export const LINE = '▰▰▰▰▰▰▰▰▰▰▰▰▰▰';

// ---------------------------------------------------------------- panels
export function homeView(d, now = Date.now()) {
  const { st, state, todayR, paused, config } = d;
  const open = state.positions.length;
  const auto = config.autoBuy !== false;
  const status = st.frozen ? `🧊 frozen: ${esc(st.frozen.why)}` : paused ? '⏸ paused (stops still run)' : st.cooldown ? '⏸ cooldown after losses' : '✅ running';
  const dayUsd = st.equity - state.dayStartEquity;
  const t = state.test;
  const text = [
    '🟩 <b>memecoin desk</b> · paper',
    LINE,
    `💰 balance  <b>$${st.equity.toFixed(2)}</b>`,
    `📈 today  <b>${sg(st.dayPnlPct)}%</b>  (${money(dayUsd)} · ${sg(todayR)}R)`,
    `📂 open  <b>${open}</b> position${open === 1 ? '' : 's'}`,
    `🤖 desk  ${status}`,
    `⚡ auto-buy  <b>${auto ? 'on' : 'off'}</b>`,
    ...(t?.endsAt ? [`🧪 ${t.hours}h window${t.n > 1 ? ` #${t.n}` : ''} · ${Math.max(0, (now - t.startedAt) / 3.6e6).toFixed(1)}h in`] : []),
    LINE,
    '<i>tap a button, or paste a coin address to buy</i>',
    `<i>updated ${hhmm(now)} utc</i>`,
  ].join('\n');
  const kb = [
    [b('🟢 Buy', 'b'), b('🔴 Sell', 'sl')],
    [b('📂 Positions', 'p'), b('👀 Near misses', 'nm')],
    [b('📋 Report', 'rp'), b('⚙️ Settings', 'st')],
    [paused ? b('▶️ Resume', 'pz') : b('⏸ Pause', 'pz'), b('🔄 Refresh', 'h')],
  ];
  return { text, kb };
}

export function buyPromptView(d) {
  return {
    text: ['🟢 <b>buy</b> · paper money', LINE, 'paste a Solana token address here in the chat.',
      '', 'before any buy the desk runs:', '• all 8 safety rules', '• the Jupiter sell test (can we get out?)', '• the score + quality check',
      '', `cash free: <b>$${d.state.cash.toFixed(2)}</b>`].join('\n'),
    kb: [[HOME]],
  };
}

export function checkView(ck, c, { cash } = {}) {
  if (!c.ok) return { text: `🔎 <b>check</b>\n${LINE}\n❌ ${esc(c.error)}\n\n<code>${esc(c.mint)}</code>`, kb: [[b('🟢 try another', 'b'), HOME]] };
  const ageH = c.ageMin != null ? (c.ageMin >= 1440 ? `${(c.ageMin / 1440).toFixed(1)}d` : `${Math.round(c.ageMin / 60)}h`) : '?';
  const lines = [
    `🔎 <b>$${esc(c.symbol)}</b> · ${esc(c.name || '')}`,
    `<code>${esc(c.mint)}</code>`,
    LINE,
    `price $${sp(c.priceUsd)} · mcap ${usd(c.mcap)} · liq ${usd(c.liq)} · age ${ageH}`,
    `🛡 safety rules  <b>${c.rulesPassed}/8</b>`,
    `🚪 sell test  ${c.sellOk ? '✅' : '❌'} ${esc(c.sellTest)}`,
    `⭐ score  <b>${c.score}/100</b> · quality ${c.quality}`,
  ];
  if (!c.safe) lines.push('', '⚠️ <b>FAILED the safety check</b>', ...c.safety.map((x) => `• ${esc(x)}`));
  else if (!c.deskPick) lines.push('', '🟡 safe, but the desk itself would pass on it:', ...c.taste.slice(0, 4).map((x) => `• ${esc(x)}`));
  else lines.push('', '✅ passes everything. the desk would buy this one too');
  if (c.frozen) lines.push(`🧊 desk is frozen (${esc(c.frozen)}), buying needs a confirm`);
  if (c.holding) lines.push('📂 you already hold it');
  lines.push('', `cash free $${(cash ?? 0).toFixed(2)} · manual buys are tagged <i>manual</i>, kept apart from the bot's stats`);
  const risky = !c.safe || c.frozen;
  const amt = (n) => b(`${risky ? '⚠️ ' : ''}$${n}`, `${risky ? 'bw' : 'ba'}:${ck}:${n}`);
  return {
    text: lines.join('\n'),
    kb: [AMOUNTS.map(amt), [b('✏️ custom $', `bx:${ck}`), b('🔄 re-check', `bk:${ck}`)], [b('✖ cancel', `bn:${ck}`), HOME]],
  };
}

export function confirmView(ck, c, amount) {
  return {
    text: ['⚠️ <b>buy anyway?</b> (paper)', LINE, `$${esc(c.symbol)} failed the desk's safety check:`, ...c.safety.map((x) => `• ${esc(x)}`),
      ...(c.frozen ? [`• desk is frozen: ${esc(c.frozen)}`] : []),
      '', `the desk would never touch this. it's paper money, so you can still test your read: <b>$${amount}</b>`].join('\n'),
    kb: [[b(`⚠️ buy anyway $${amount} (paper)`, `bf:${ck}:${amount}`)], [b('✖ cancel', `bn:${ck}`), HOME]],
  };
}

export function customView(ck, c, cash) {
  return { text: `✏️ <b>custom amount</b> for $${esc(c.symbol)}\n${LINE}\ntype the $ amount in the chat (1 to ${cash.toFixed(2)})\nexample: 7.5`, kb: [[b('✖ cancel', `bn:${ck}`), HOME]] };
}

export function boughtView(r, config) {
  const p = r.pos;
  const tp = config.risk.takeProfitLadder?.[0];
  return {
    text: ['✅ <b>paper buy filled</b> · manual', LINE, `${p.id} <b>$${esc(p.symbol)}</b>`, `$${p.sizeUsd.toFixed(2)} @ $${sp(p.entryPrice)}`,
      `filled at a live Jupiter quote · impact ${r.impactPct}% · ${esc(r.route)}`,
      `🛑 stop $${sp(p.stopPrice)} (-${config.risk.stopLossPct}%)${tp ? ` · 🎯 first tp ${tp.atMultiple}x` : ''} · trail at +${config.risk.trailActivatePct}%`,
      'the desk watches it every few seconds like its own trades'].join('\n'),
    kb: [[b('📂 open card', `pc:${p.id}`), HOME]],
  };
}

export function positionsView(d, { forSell = false } = {}) {
  const ps = d.state.positions;
  if (!ps.length) return { text: `📂 <b>positions</b>\n${LINE}\nnothing open right now.`, kb: [[b('🟢 Buy', 'b'), HOME]] };
  const rows = ps.map((p) => { const v = positionView(p, d.config); return { p, v }; });
  return {
    text: [`${forSell ? '🔴 <b>sell</b> · pick a position' : '📂 <b>positions</b>'}`, LINE,
      ...rows.map(({ p, v }) => `${v.pnlUsd >= 0 ? '🟢' : '🔴'} ${p.id} <b>$${esc(p.symbol)}</b> ${sg(v.pnlPct, 1)}% · $${v.worth.toFixed(2)}${v.manual ? ' · manual' : ''}`),
      '', '<i>tap one to open its card</i>'].join('\n'),
    kb: [...rows.map(({ p, v }) => [b(`${p.id} $${p.symbol} ${sg(v.pnlPct, 1)}%`.slice(0, 40), `pc:${p.id}`)]), [b('🔄 Refresh', forSell ? 'sl' : 'p'), HOME]],
  };
}

export function positionCardView(pos, config, note) {
  const v = positionView(pos, config);
  const text = [
    `${v.pnlUsd >= 0 ? '🟢' : '🔴'} <b>${v.id} $${esc(v.symbol)}</b>${v.manual ? ' · manual' : ' · bot pick'}`,
    LINE,
    `entry $${sp(v.entry)} · now $${sp(v.now)}`,
    `p/l <b>${sg(v.pnlPct, 1)}%</b> (${money(v.pnlUsd)}) · <b>${sg(v.R)}R</b>`,
    `in $${v.sizeUsd.toFixed(2)} · worth now $${v.worth.toFixed(2)}${v.soldPct > 0.5 ? ` · sold ${v.soldPct.toFixed(0)}% (got $${v.realized.toFixed(2)})` : ''}`,
    `🛑 stop $${sp(v.stop)} (${sg(v.stopPct, 1)}%)${v.trailing ? ' · trailing ✅' : ` · trail at +${v.trailAt}%`}`,
    v.nextTp ? `🎯 next tp ${v.nextTp.at}x = $${sp(v.nextTp.price)} (sells ${v.nextTp.sellPct}%)` : '🎯 take profit ladder done',
    ...(note ? ['', note] : []),
    `<i>updated ${hhmm(Date.now())} utc</i>`,
  ].join('\n');
  return { text, kb: [[b('25%', `ps:${v.id}:25`), b('50%', `ps:${v.id}:50`), b('100%', `ps:${v.id}:100`)], [b('🔄 refresh', `pr:${v.id}`), b('« positions', 'p'), HOME]] };
}

export function closedView(trade) {
  return {
    text: [`${trade.pnlUsd >= 0 ? '💰' : '🔴'} <b>closed ${trade.id} $${esc(trade.symbol)}</b>${trade.source === 'manual' ? ' · manual' : ''}`, LINE,
      `entry $${sp(trade.entryPrice)} → exit $${sp(trade.exitPrice)}`,
      `p/l <b>${money(trade.pnlUsd)}</b> (${sg(trade.pnlPct)}%, ${sg(trade.R)}R)`, `why: ${esc(trade.exitReason)}`,
      trade.exit?.fillSource ? `filled at ${esc(trade.exit.fillSource)}` : ''].filter(Boolean).join('\n'),
    kb: [[b('📂 Positions', 'p'), HOME]],
  };
}

const SETTINGS_ROWS = [
  ['stop', '🛑 stop'], ['tp', '🎯 take profit'], ['trailat', '📈 trail at'], ['trail', '📉 trail dist'],
  ['minscore', '⭐ min score'], ['maxtrades', '🔢 trades/day'], ['maxopen', '📂 max open'], ['slippage', '💧 slippage'],
];
export function settingsView(config, note) {
  const val = (k) => showValue(SETTINGS[k], getSetting(config, k));
  const kb = SETTINGS_ROWS.map(([k, label]) => [b('➖', `s-:${k}`), b(`${label} ${k === 'trailat' ? '+' : k === 'stop' ? '-' : ''}${val(k)}`, `si:${k}`), b('➕', `s+:${k}`)]);
  kb.push([b(`⚡ auto-buy: ${val('autobuy')}`, 'sg:autobuy'), b(`🔔 alerts: ${val('alerts') === 'trades' ? 'trades only' : 'all'}`, 'sg:alerts')]);
  kb.push([HOME]);
  const text = ['⚙️ <b>settings</b>', LINE, 'tap ➖ ➕ to change. same safe ranges as /set',
    ...(note ? ['', note] : []),
    '', 'new stop / trail / tp apply to new trades. open trades keep their stop (stops only go up)',
    `max per trade ${val('maxpertrade')} · daily loss limit ${val('dailyloss')}`,
    '🔒 mode: <b>paper</b> (locked, not changeable here)'].join('\n');
  return { text, kb };
}

export function textView(title, body, refresh) {
  const t = `${title}\n${LINE}\n${esc(body)}`;
  return { text: t.length > 3900 ? t.slice(0, 3890) + '\n…' : t, kb: [[...(refresh ? [b('🔄 Refresh', refresh)] : []), HOME]] };
}

// ---------------------------------------------------------------- the router
// io   = { send(text, kb) -> message_id, edit(msgId, text, kb), answer(cbId, text?, alert?) }
// desk = { snapshot(), pause(), resume(), step(key, dir), check(mint), buy(check, usd, force), sell(posId, pct), refresh(posId), save() }
// ui   = persisted { panel, await, checks: { ck: check }, seq }
export function createMenu({ io, desk, ui, ownerId, now = () => Date.now() }) {
  ui.checks ||= {}; ui.seq ||= 0;
  const busy = new Set();
  const seenTaps = [];

  const show = async (msgId, v) => {
    if (msgId) { const ok = await io.edit(msgId, v.text, v.kb); if (ok !== false) return msgId; }
    const id = await io.send(v.text, v.kb); // edit failed (too old / deleted): a fresh message instead
    return id;
  };
  const home = () => homeView(desk.snapshot(), now());

  function newCheckId(check) {
    const ck = (++ui.seq).toString(36);
    ui.checks[ck] = check;
    const keys = Object.keys(ui.checks); // keep it small: last 8 checks, none older than 2h
    for (const k of keys) if (keys.length > 8 && k !== ck && (keys.indexOf(k) < keys.length - 8 || now() - (ui.checks[k].at || 0) > 2 * 3.6e6)) delete ui.checks[k];
    return ck;
  }

  async function runCheck(mint, msgId) {
    const c = await desk.check(mint);
    const ck = c.ok ? newCheckId(c) : null;
    await show(msgId, checkView(ck, c, { cash: desk.snapshot().state.cash }));
    ui.await = null;
    await desk.save();
    return { ck, c };
  }

  async function doBuy(ck, amount, force, msgId) {
    const c = ui.checks[ck];
    const r = await desk.buy(c, amount, force);
    if (r.needConfirm) return show(msgId, confirmView(ck, c, amount));
    if (!r.ok) return show(msgId, { text: `❌ <b>no buy</b>\n${LINE}\n${esc(r.error)}`, kb: [[b('🔄 back to the card', `bk:${ck}`), HOME]] });
    delete ui.checks[ck];
    ui.await = null;
    await desk.save();
    return show(msgId, boughtView(r, desk.snapshot().config));
  }

  // ---- a tap on an inline button
  async function onCallback(cq) {
    const from = cq.from?.id, chat = cq.message?.chat?.id;
    if (!ownerId || from !== ownerId || (chat != null && chat !== ownerId)) { await io.answer(cq.id, PRIVATE_TAP, true); return 'private'; }
    if (seenTaps.includes(cq.id)) { await io.answer(cq.id); return 'dupe'; } // telegram retried the webhook
    seenTaps.push(cq.id); if (seenTaps.length > 50) seenTaps.shift();
    const msgId = cq.message?.message_id;
    const [cmd, a1, a2] = String(cq.data || '').split(':');
    const d = desk.snapshot();
    const lockKey = cmd === 'ps' || cmd === 'pr' ? `pos:${a1}` : ['ba', 'bf', 'bk'].includes(cmd) ? `ck:${a1}` : null;
    if (lockKey && busy.has(lockKey)) { await io.answer(cq.id, 'on it, one sec ⏳'); return 'busy'; }
    if (lockKey) busy.add(lockKey);
    try {
      switch (cmd) {
        case 'h': await io.answer(cq.id, a1 === 'x' ? '' : '🔄'); ui.panel = await show(msgId, home()); break;
        case 'b': await io.answer(cq.id); ui.await = { kind: 'mint', msg: msgId, at: now() }; await show(msgId, buyPromptView(d)); break;
        case 'sl': case 'p': {
          await io.answer(cq.id);
          const ps = d.state.positions;
          if (cmd === 'sl' && ps.length === 1) await show(msgId, positionCardView(ps[0], d.config));
          else await show(msgId, positionsView(d, { forSell: cmd === 'sl' }));
          break;
        }
        case 'pc': case 'pr': {
          const pos = d.state.positions.find((p) => p.id === a1);
          if (!pos) { await io.answer(cq.id, 'that position is closed now'); await show(msgId, positionsView(d)); break; }
          await io.answer(cq.id, cmd === 'pr' ? 'getting a live price…' : '');
          if (cmd === 'pr') await desk.refresh(a1);
          const p2 = desk.snapshot().state.positions.find((p) => p.id === a1);
          await show(msgId, p2 ? positionCardView(p2, d.config) : positionsView(desk.snapshot()));
          break;
        }
        case 'ps': {
          const pct = Number(a2);
          const pos = d.state.positions.find((p) => p.id === a1);
          if (!pos || ![25, 50, 100].includes(pct)) { await io.answer(cq.id, 'that position is closed now'); await show(msgId, positionsView(d)); break; }
          await io.answer(cq.id, `selling ${pct}% at a live quote…`);
          const r = await desk.sell(a1, pct);
          if (!r.ok) { await show(msgId, r.gone ? positionsView(desk.snapshot()) : positionCardView(pos, d.config, `❌ ${esc(r.error)}`)); break; }
          await desk.save();
          if (r.trade) await show(msgId, closedView(r.trade));
          else await show(msgId, positionCardView(r.pos, d.config, `✅ sold ${pct}% @ $${sp(r.price)} for $${r.fill.proceeds.toFixed(2)} (${esc(r.source)})`));
          break;
        }
        case 'nm': await io.answer(cq.id); await show(msgId, textView('👀 <b>near misses</b>', nearMissText(d.S), 'nm')); break;
        case 'rp': await io.answer(cq.id); await show(msgId, textView('📋 <b>report</b>', reportBody(d), 'rp')); break;
        case 'st': await io.answer(cq.id); await show(msgId, settingsView(d.config)); break;
        case 'si': { const s = SETTINGS[a1]; await io.answer(cq.id, s ? `${s.label}: ${showValue(s, getSetting(d.config, a1))}` : ''); break; }
        case 's+': case 's-': case 'sg': {
          if (!SETTINGS[a1] || (cmd !== 'sg' && !STEPS[a1]) || (cmd === 'sg' && !(SETTINGS[a1].bool || SETTINGS[a1].choices))) { await io.answer(cq.id, 'that setting moved, here is the fresh panel'); await show(msgId, settingsView(d.config)); break; }
          const r = await desk.step(a1, cmd === 's-' ? -1 : 1);
          if (!r.ok) { await io.answer(cq.id, r.error, false); break; }
          await io.answer(cq.id, `${a1}: ${showValue(r.spec, r.value)}`);
          await show(msgId, settingsView(desk.snapshot().config, `✅ ${a1}: ${showValue(r.spec, r.old)} → <b>${showValue(r.spec, r.value)}</b>`));
          break;
        }
        case 'pz': {
          if (d.paused) { await desk.resume(); await io.answer(cq.id, '▶️ back on'); } else { await desk.pause(); await io.answer(cq.id, '⏸ paused. open trades keep their stops'); }
          ui.panel = await show(msgId, home());
          break;
        }
        case 'ba': case 'bw': case 'bf': case 'bx': case 'bk': case 'bn': {
          const c = ui.checks[a1];
          if (!c) { await io.answer(cq.id, 'that check expired, paste the address again'); await show(msgId, buyPromptView(d)); ui.await = { kind: 'mint', msg: msgId, at: now() }; break; }
          if (cmd === 'bn') { await io.answer(cq.id, 'cancelled'); delete ui.checks[a1]; ui.await = null; await show(msgId, home()); break; }
          if (cmd === 'bk' || now() - c.at > CHECK_TTL_MS) {
            await io.answer(cq.id, cmd === 'bk' ? 're-checking…' : 'that check is 10+ min old, prices moved. re-checking first…');
            delete ui.checks[a1];
            await runCheck(c.mint, msgId);
            break;
          }
          if (cmd === 'bx') { await io.answer(cq.id); ui.await = { kind: 'amount', ck: a1, msg: msgId, at: now() }; await show(msgId, customView(a1, c, d.state.cash)); break; }
          const amount = Number(a2);
          if (!(amount > 0)) { await io.answer(cq.id, 'pick an amount'); break; }
          if (cmd === 'bw') { await io.answer(cq.id, '⚠️ confirm first'); await show(msgId, confirmView(a1, c, amount)); break; }
          await io.answer(cq.id, `buying $${amount} at a live Jupiter quote…`);
          await doBuy(a1, amount, cmd === 'bf', msgId);
          break;
        }
        default:
          await io.answer(cq.id, 'that button is from an older menu, here is a fresh one');
          ui.panel = await show(msgId, home());
      }
    } finally { if (lockKey) busy.delete(lockKey); }
    await desk.save();
    return cmd;
  }

  // ---- owner typed something that isn't a /command
  async function onText(text) {
    const t = String(text).trim();
    if (isMint(t)) {
      const id = await io.send(`🔎 checking <code>${esc(t)}</code>…\n8 safety rules · sell test · score`, []);
      await runCheck(t, id);
      return 'check';
    }
    const w = ui.await;
    if (w?.kind === 'amount' && now() - w.at < 15 * 60_000 && /^\$?\s*\d+(\.\d+)?\s*\$?$/.test(t)) {
      const amount = Number(t.replace(/[$\s]/g, ''));
      const c = ui.checks[w.ck];
      if (!c) { ui.await = null; await io.send('that check expired, paste the address again', [[b('🟢 Buy', 'b'), HOME]]); return 'expired'; }
      const msg = await io.send(`buying $${amount} of $${esc(c.symbol)}…`, []);
      if (now() - c.at > CHECK_TTL_MS) { delete ui.checks[w.ck]; await runCheck(c.mint, msg); return 'recheck'; }
      ui.await = null;
      await doBuy(w.ck, amount, false, msg);
      return 'amount';
    }
    if (w?.kind === 'mint' && now() - w.at < 15 * 60_000) { await io.send("that's not a Solana token address 🤔 paste the coin's address (32-44 letters/numbers)", [[HOME]]); return 'bad_mint'; }
    ui.panel = await io.send(home().text, home().kb);
    await desk.save();
    return 'home';
  }

  async function sendHome() { ui.panel = await io.send(home().text, home().kb); await desk.save(); return ui.panel; }

  return { onCallback, onText, sendHome, ui };
}

function reportBody(d) {
  const bot = stats(d.state), man = stats(d.state, 'manual');
  const base = d.S ? testReportText({ S: d.S, config: d.config }) : '';
  const extra = man.trades ? `\n\nmanual (you, all time): ${man.trades} trades · ${man.wins} wins · ${money(man.realizedUsd)}\nbot (all time): ${bot.trades} trades · ${bot.wins} wins · ${money(bot.realizedUsd)}` : '';
  return base + extra;
}
