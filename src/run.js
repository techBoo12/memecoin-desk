// ============================================================================
// THE DESK: one loop that runs the roles in order.
//   scout -> filter (8 kill rules) -> sell test -> analyst -> risk sizing
//   -> HEAD OF DESK approve/veto -> paper executor -> risk desk watches exits
// Everything is logged. Node runner for now; core files are plain fetch so
// they can move to a Cloudflare Workers cron later.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scout, refreshPairs } from './desk/scout.js';
import { filter, usd } from './desk/filter.js';
import { honeypotCheck } from './desk/honeypot.js';
import { analyze } from './desk/analyst.js';
import { newState, riskStatus, sizeTrade, manage, afterClose, equity } from './desk/risk.js';
import { openPaper, markPrice, sellPaper } from './desk/executor.js';
import { review, dailyReport } from './desk/head.js';
import { createLogger } from './desk/logger.js';
import { sleep } from './lib/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const runMin = Number(process.argv[2] || config.loop.runMinutes);
const log = createLogger(path.join(ROOT, 'logs'));
const statePath = path.join(ROOT, 'state', 'desk.json');
fs.mkdirSync(path.dirname(statePath), { recursive: true });
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : newState(config);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));

const run = { scans: 0, checks: 0, uniqueCoins: new Set(), killsByRule: {}, killedCoins: new Set(), honeypotKills: 0, lowScore: 0, fallingTape: 0, vetoes: 0, approved: 0, unknownCounts: {}, alive: new Set() };
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const sym = (c) => pad('$' + c.symbol, 11);
const sp = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));

async function scanOnce() {
  run.scans++;
  const status = riskStatus(state, config);
  const sc = await scout({ config, log });
  log.event('scan', { scan: run.scans, tokensSeen: sc.tokensSeen, inWindow: sc.pairsInWindow, checking: sc.candidates.length },
    `SCAN #${run.scans}  ${sc.tokensSeen} tokens seen · ${sc.pairsInWindow} in window (30m-72h, $300k-$20M) · equity $${status.equity.toFixed(2)}`);

  for (const c of sc.candidates) {
    run.checks++; run.uniqueCoins.add(c.mint);
    const f = await filter(c, { config });
    for (const u of f.unknowns) run.unknownCounts[u] = (run.unknownCounts[u] || 0) + 1;
    if (!f.alive) {
      const k = f.killedBy;
      if (!run.killedCoins.has(c.mint)) { run.killedCoins.add(c.mint); const key = `${k.n} ${k.id}`; run.killsByRule[key] = (run.killsByRule[key] || 0) + 1; }
      log.event('kill', { mint: c.mint, symbol: c.symbol, rule: k.id, ruleN: k.n, value: k.value, why: k.note, unknowns: f.unknowns, mcap: c.mcap, liq: c.liqUsd, ageMin: c.ageMin },
        `✖ KILL   ${sym(c)} rule ${k.n} ${pad(k.id, 11)} ${k.note}`);
      continue;
    }
    run.alive.add(c.mint);
    log.event('alive', { mint: c.mint, symbol: c.symbol, rules: f.results, unknowns: f.unknowns },
      `✔ ALIVE  ${sym(c)} 8/8 rules pass · mcap ${usd(c.mcap)} · liq ${usd(c.liqUsd)} · age ${Math.round(c.ageMin / 60)}h${f.unknowns.length ? ' · unknown: ' + f.unknowns.join(',') : ''}`);

    if (state.positions.some((p) => p.mint === c.mint)) continue;
    const hp = await honeypotCheck(c, f.rc, { config });
    if (!hp.ok && hp.unknown) {
      log.event('no_trade', { mint: c.mint, symbol: c.symbol, why: hp.reason }, `○ NO TRADE ${sym(c)} ${hp.reason} (exit not proven = no entry)`);
      continue;
    }
    if (!hp.ok) {
      run.honeypotKills++;
      log.event('kill', { mint: c.mint, symbol: c.symbol, rule: 'sell_test', why: hp.reason, hp }, `✖ KILL   ${sym(c)} sell test   ${hp.reason}`);
      continue;
    }
    log.event('sell_test', { mint: c.mint, symbol: c.symbol, hp }, `⇄ SELL TEST ${sym(c)} ok · $${hp.testUsd} round trip ${hp.roundTripLossPct}% · impact ${hp.impactPct}% · ${hp.route}`);

    const a = analyze(c, f.rc, { config });
    const p = a.parts;
    log.event('score', { mint: c.mint, symbol: c.symbol, a },
      `★ SCORE  ${sym(c)} ${String(a.score).padStart(3)}/100  mom ${p.momentum.toFixed(0)} buys ${p.buyPressure.toFixed(0)} act ${p.activity.toFixed(0)} turn ${p.turnover.toFixed(0)} liq ${p.liqMcap.toFixed(0)} hold ${p.holders.toFixed(0)}`);
    if (!a.passes) run.lowScore++; else if (!a.tapeOk) run.fallingTape++;

    const size = sizeTrade(state, config);
    const verdict = review({ c, a, size }, riskStatus(state, config), state, config);
    if (!verdict.approved) {
      run.vetoes++;
      log.event('no_trade', { mint: c.mint, symbol: c.symbol, score: a.score, reason: verdict.reason }, `○ NO TRADE ${sym(c)} head of desk: ${verdict.reason}`);
      continue;
    }
    run.approved++;
    const pos = openPaper(state, c, a, hp, size, config);
    log.event('buy', { pos }, `▲ PAPER BUY ${pos.id} ${sym(c)} $${pos.sizeUsd.toFixed(2)} @ $${sp(pos.entryPrice)} · stop $${sp(pos.stopPrice)} (-${config.risk.stopLossPct}%) · 1R = $${pos.riskUsd.toFixed(2)}`);
    log.trade({ time: pos.entryAt, id: pos.id, side: 'BUY', symbol: pos.symbol, mint: pos.mint, price: pos.entryPrice, usd: pos.sizeUsd, qty: pos.tokens, reason: verdict.reason });
    save();
  }
}

async function watchOnce(verbose) {
  if (!state.positions.length) return;
  const pairs = await refreshPairs(state.positions.map((p) => p.mint));
  for (const pos of [...state.positions]) {
    const m = await markPrice(pos, pairs.get(pos.mint)?.priceUsd, config);
    if (!m) continue;
    pos.markUsd = pos.tokens * m.price;
    const acts = manage(pos, m.price, config);
    const chg = (m.price / pos.entryPrice - 1) * 100;
    for (const act of acts) {
      if (act.type === 'note') { log.event('hold', { id: pos.id, note: act.reason }, `◆ ${pos.id} $${pos.symbol} ${act.reason}`); continue; }
      const { fill, trade } = sellPaper(state, pos, act.fraction, m.price, act.reason, config, { ofOriginal: act.ofOriginal });
      log.trade({ time: fill.at, id: pos.id, side: 'SELL', symbol: pos.symbol, mint: pos.mint, price: m.price, usd: fill.proceeds, qty: fill.qty, reason: act.reason, pnl: trade?.pnlUsd, R: trade?.R });
      if (trade) {
        log.event('sell', { trade }, `▼ PAPER SELL ${trade.id} $${pad(trade.symbol, 9)} ${trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(trade.pnlUsd).toFixed(2)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct}%, ${trade.R >= 0 ? '+' : ''}${trade.R}R) · ${act.reason}`);
        const ac = afterClose(state, trade, config);
        if (ac.cooldown) log.event('freeze', {}, `⏸ COOLDOWN ${config.risk.cooldownMin} min: ${config.risk.lossStreakForCooldown} losses in a row, no revenge trades`);
      } else {
        log.event('sell', { fill }, `▼ PAPER SELL ${pos.id} $${pos.symbol} partial: ${act.reason}`);
      }
    }
    if (verbose && state.positions.includes(pos)) {
      log.event('hold', { id: pos.id, mark: pos.markUsd, chg, stop: pos.stopPrice, src: m.source },
        `● HOLD   ${pos.id} ${pad('$' + pos.symbol, 10)} ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · mark $${pos.markUsd.toFixed(2)} · stop $${sp(pos.stopPrice)}${pos.trailing ? ' (trailing)' : ''}`);
    }
  }
  const st = riskStatus(state, config);
  if (st.frozen && !run.frozenLogged) { run.frozenLogged = true; log.event('freeze', st.frozen, `■ FROZEN: ${st.frozen.why} (day ${st.dayPnlPct.toFixed(2)}%). Stops still run, no new trades.`); }
  save();
}

async function main() {
  log.event('info', { config }, `memecoin desk · PAPER MODE · $${equity(state).toFixed(2)} virtual · run ${runMin} min · rule #1: ${config.topRule}`);
  const end = Date.now() + runMin * 60_000;
  let nextScan = 0, nextLoud = 0;
  while (Date.now() < end) {
    if (Date.now() >= nextScan) {
      nextScan = Date.now() + config.loop.scanEverySec * 1000;
      try { await scanOnce(); } catch (e) { log.warn(`scan error: ${e.message}`); }
    }
    const loud = Date.now() >= nextLoud;
    if (loud) nextLoud = Date.now() + 60_000;
    try { await watchOnce(loud); } catch (e) { log.warn(`watch error: ${e.message}`); }
    await sleep(config.loop.watchEverySec * 1000);
  }
  const status = riskStatus(state, config);
  const report = dailyReport(state, run, status, config);
  fs.writeFileSync(path.join(ROOT, 'logs', `report-${state.day}.md`), report);
  const summary = { ...run, uniqueCoins: run.uniqueCoins.size, killedCoins: run.killedCoins.size, alive: run.alive.size, equity: status.equity, cash: state.cash, open: state.positions, closed: state.closed };
  fs.writeFileSync(path.join(ROOT, 'logs', 'run-summary.json'), JSON.stringify(summary, null, 1));
  log.event('report', { summary }, `■ DONE  ${run.scans} scans · ${run.uniqueCoins.size} coins · ${run.killedCoins.size} killed · ${run.approved} paper buys · equity $${status.equity.toFixed(2)} · report written`);
  save();
}

main();
