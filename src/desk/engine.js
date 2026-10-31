// ============================================================================
// THE DESK ENGINE (day 3): one platform-free brain for Node and Cloudflare.
//   scout -> filter (8 kill rules) -> sell test -> analyst -> QUALITY GATE
//   -> HEAD OF DESK approve/veto -> paper executor -> FAST EXIT WATCHER
//   + NEAR-MISS TRACKER on everything it almost bought.
// The work is cut into small steps (tick) so a Cloudflare Durable Object
// alarm can run it a few seconds at a time, and Node can run it in a loop.
// All state is one plain object (S), saved by the platform. Nothing here
// touches files, keys or wallets.
// ============================================================================
import { scout } from './scout.js';
import { filter, usd } from './filter.js';
import { honeypotCheck } from './honeypot.js';
import { analyze } from './analyst.js';
import { qualityGate } from './quality.js';
import { newState, riskStatus, sizeTrade, manage, afterClose, equity } from './risk.js';
import { openPaper, markPrice, sellPaper } from './executor.js';
import { review, stats } from './head.js';
import { fastPrices, liquidityNow, liquidityAlarm } from './watcher.js';
import { newNearMissBook, recordNearMiss, recheckDue } from './nearmiss.js';
import * as alert from '../telegram/alerts.js';
import { testReportText } from './report.js';
import { createPlaybookLane, newPlaybookState } from '../playbook/lane.js';
import { newLabelBook } from '../playbook/labels.js';

export function newRun() {
  return { since: Date.now(), scans: 0, checks: 0, uniqueCoins: 0, killedCoins: 0, alive: 0, killsByRule: {}, allHitsByRule: {},
    honeypotKills: 0, lowScore: 0, nearScore: 0, qualityFails: {}, fallingTape: 0, vetoes: 0, approved: 0, unknownCounts: {}, nearMisses: 0 };
}

// S = { desk, run, seen, holders, nm, scan, timers, settings, events }
export function initState(S, config) {
  S.desk ||= newState(config);
  S.desk.positions ||= []; S.desk.closed ||= []; S.desk.noReentry ||= {};
  S.run ||= newRun();
  S.seen ||= {};
  S.holders ||= {};
  S.nm ||= newNearMissBook();
  S.scan ||= { phase: 'idle', queue: [], sum: null };
  S.timers ||= { nextScan: 0, nextWatch: 0, nextLiq: 0, nextNm: 0, nextMark: 0 };
  S.settings ||= {};
  S.events ||= [];
  S.curve ||= [];
  if (config.playbook) { S.pb ||= newPlaybookState(); S.labels ||= newLabelBook(); } // day 5: training pack lane
  if (!S.curve.length && S.desk.test?.startedAt) S.curve.push({ t: S.desk.test.startedAt, eq: +(S.desk.test.equityAtStart ?? 0).toFixed(3), open: 0 });
  S._dirty = new Set();
  return S;
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const sym = (c) => pad('$' + c.symbol, 11);
const sp = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));

export function createEngine({ config, S, log, notify, now = () => Date.now(), pbIo } = {}) {
  initState(S, config);
  const st = S.desk;
  const run = S.run;
  const dirty = (...k) => k.forEach((x) => S._dirty.add(x));
  const ev = (type, data, line) => {
    log.event(type, data, line);
    if (line) { S.events.push(`${new Date(now()).toISOString().slice(11, 19)} ${line}`); if (S.events.length > 200) S.events.splice(0, S.events.length - 200); dirty('events'); }
  };

  // day 5: the training pack's insider-exit lane (src/playbook). Own positions (strategy 'insider'), own exits E1-E8.
  const pb = config.playbook ? createPlaybookLane({ config, S, now, ev, notify, dirty, ...(pbIo ? { io: pbIo } : {}) }) : null;

  function markSeen(c, flag) {
    const s = S.seen[c.mint];
    if (!s) { S.seen[c.mint] = [now(), flag]; run.uniqueCoins++; if (flag === 'k') run.killedCoins++; if (flag === 'a') run.alive++; }
    else { s[0] = s[0] || now(); if (flag === 'a' && s[1] !== 'a') { run.alive++; if (s[1] === 'k') run.killedCoins--; s[1] = 'a'; } }
    dirty('seen');
  }

  // a coin that failed ONE rule only counts as a near miss when it was close:
  // half the liquidity/volume floor or more. Safety rules always count.
  function closeCall(c, r) {
    if (r.status === 'unknown') return true;
    if (r.id === 'liquidity') return c.liqUsd >= config.filter.minLiquidityUsd * 0.5;
    if (r.id === 'volume_1h') return c.vol.h1 >= config.filter.minVolume1hUsd * 0.5;
    return true;
  }

  function nearMiss(c, stage, reasons, extra = {}) {
    const it = recordNearMiss(S.nm, { c, stage, reasons, now: now(), ...extra });
    if (it) {
      run.nearMisses++;
      ev('near_miss', { nm: it }, `◌ NEAR MISS ${sym(c)} ${it.reasonKey} · ${reasons.map((r) => r.note).join('; ').slice(0, 140)}`);
    }
    dirty('nm');
  }

  // ---------- scan, step 1: find candidates (one batch of network calls)
  async function scanDiscover() {
    if (st.paused) { S.timers.nextScan = now() + config.loop.scanEverySec * 1000; return 'paused'; }
    run.scans++;
    const status = riskStatus(st, config);
    const sc = await scout({ config, log, scanNo: run.scans, between: maybeWatch });
    S.scan = { phase: 'deep', nearStart: run.nearMisses, queue: sc.candidates, sum: { scan: run.scans, checked: 0, kills: {}, passed: 0, picks: 0, near: 0, sellFails: 0 } };
    ev('scan', { scan: run.scans, tokensSeen: sc.tokensSeen, inWindow: sc.pairsInWindow, checking: sc.candidates.length },
      `SCAN #${run.scans}  ${sc.tokensSeen} tokens seen · ${sc.pairsInWindow} in window · checking ${sc.candidates.length} · equity $${status.equity.toFixed(2)}`);
    S.timers.nextScan = now() + config.loop.scanEverySec * 1000;
    dirty('run', 'scan');
    return 'discover';
  }

  // ---------- scan, step 2..n: deep-check a few candidates per step
  async function scanDeep(maxCoins) {
    const sum = S.scan.sum;
    const chunk = S.scan.queue.splice(0, maxCoins);
    for (const c of chunk) await checkCoin(c, sum);
    if (!S.scan.queue.length) {
      S.scan.phase = 'idle';
      // 24/7 = 30 scans an hour, so telegram gets one scan digest per hour (telegram.scanDigestMin), not one per scan
      const every = (config.telegram?.scanDigestMin ?? 0) * 60_000;
      const agg = (S.timers.scanAgg ||= { from: now(), scans: 0, checked: 0, kills: {}, passed: 0, picks: 0, sellFails: 0, near: 0, nearStart: S.scan.nearStart ?? run.nearMisses });
      agg.scans++; agg.checked += sum.checked; agg.passed += sum.passed; agg.picks += sum.picks; agg.sellFails += sum.sellFails;
      for (const [k, v] of Object.entries(sum.kills)) agg.kills[k] = (agg.kills[k] || 0) + v;
      agg.near = run.nearMisses - agg.nearStart;
      if (!every || now() - agg.from >= every) {
        notify('scan', alert.scanAlert({ ...agg, scan: run.scans, minutes: every ? Math.round((now() - agg.from) / 60000) : 0, equity: riskStatus(st, config).equity }));
        S.timers.scanAgg = null;
      }
    }
    dirty('scan', 'run', 'desk');
    return 'deep';
  }

  // keep exits fast while a scan step is busy: watch in between network calls
  let watching = false;
  async function maybeWatch() {
    if (watching || !st.positions.length || now() < S.timers.nextWatch) return;
    watching = true;
    try { await watch(); } catch (e) { log.warn(`watch error: ${e.message}`); } finally { watching = false; }
  }

  async function checkCoin(c, sum) {
    run.checks++; sum.checked++;
    const f = await filter(c, { config });
    await maybeWatch();
    for (const u of f.unknowns) run.unknownCounts[u] = (run.unknownCounts[u] || 0) + 1;
    const bad = f.results.filter((r) => r.status === 'kill' || (r.status === 'unknown' && config.filter.unknownIsKill.includes(r.id)));
    if (!f.alive) {
      const k = f.killedBy;
      sum.kills[k.id] = (sum.kills[k.id] || 0) + 1;
      const hits = bad.map((r) => `${r.n} ${r.id}`);
      if (!S.seen[c.mint]) {
        const key = `${k.n} ${k.id}`; run.killsByRule[key] = (run.killsByRule[key] || 0) + 1;
        for (const h of hits) run.allHitsByRule[h] = (run.allHitsByRule[h] || 0) + 1;
      }
      markSeen(c, 'k');
      ev('kill', { mint: c.mint, symbol: c.symbol, rule: k.id, value: k.value, why: k.note, hits, unknowns: f.unknowns },
        `✖ KILL   ${sym(c)} rule ${k.n} ${pad(k.id, 11)} ${k.note}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`);
      if (bad.length === 1 && closeCall(c, bad[0])) nearMiss(c, 'kill_rules', bad.map((r) => ({ n: r.n, id: r.id, value: r.value, note: r.status === 'unknown' ? `unknown ${r.id} (${r.note})` : r.note })), { rulesPassed: '7/8' });
      return;
    }
    markSeen(c, 'a'); sum.passed++;
    ev('alive', { mint: c.mint, symbol: c.symbol, rules: f.results, unknowns: f.unknowns },
      `✔ ALIVE  ${sym(c)} 8/8 rules pass · mcap ${usd(c.mcap)} · liq ${usd(c.liqUsd)} · age ${Math.round(c.ageMin / 60)}h${f.unknowns.length ? ' · unknown: ' + f.unknowns.join(',') : ''}`);
    if (st.positions.some((p) => p.mint === c.mint)) return;

    const hp = await honeypotCheck(c, f.rc, { config });
    await maybeWatch();
    if (!hp.ok) {
      if (!hp.unknown) { run.honeypotKills++; sum.sellFails++; }
      ev(hp.unknown ? 'no_trade' : 'kill', { mint: c.mint, symbol: c.symbol, why: hp.reason }, `${hp.unknown ? '○ NO TRADE' : '✖ KILL  '} ${sym(c)} sell test: ${hp.reason}`);
      nearMiss(c, 'sell_test', [{ id: 'sell_test', note: hp.reason }], { rulesPassed: '8/8' });
      return;
    }
    const a = analyze(c, f.rc, { config, holderHistory: S.holders, now: now() });
    dirty('holders');
    const q = qualityGate(c, f, a, config);
    const p = a.parts;
    ev('score', { mint: c.mint, symbol: c.symbol, a, q: q.checks },
      `★ SCORE  ${sym(c)} ${String(a.score).padStart(3)}/100  mom ${p.momentum.toFixed(0)} buys ${p.buyPressure.toFixed(0)} act ${p.activity.toFixed(0)} turn ${p.turnover.toFixed(0)} liq ${p.liqMcap.toFixed(0)} hold ${p.holders.toFixed(0)} · quality ${q.passedCount}/${q.total}`);
    for (const x of q.failed) run.qualityFails[x.id] = (run.qualityFails[x.id] || 0) + 1;

    const nmBase = { score: a.score, rulesPassed: '8/8', quality: `${q.passedCount}/${q.total}` };
    if (a.score < config.analyst.nearMissScore) { run.lowScore++; ev('no_trade', { mint: c.mint, score: a.score }, `○ NO TRADE ${sym(c)} score ${a.score} (< ${config.analyst.nearMissScore}, not close)`); return; }
    if (!a.passes) {
      run.nearScore++;
      ev('no_trade', { mint: c.mint, score: a.score }, `○ NO TRADE ${sym(c)} score ${a.score} < ${config.analyst.passScore}`);
      nearMiss(c, 'score', [{ id: 'score', note: `score ${a.score} < ${config.analyst.passScore}` }, ...q.failed], nmBase);
      return;
    }

    const size = sizeTrade(st, config);
    const verdict = review({ c, a, size, q }, riskStatus(st, config), st, config);
    sum.picks++;
    if (verdict.approved && config.autoBuy === false) {
      // day 4: auto-buy switched off in ⚙️ settings. the desk still finds and checks everything, she decides
      run.vetoes++;
      ev('no_trade', { mint: c.mint, symbol: c.symbol, score: a.score, reason: 'auto-buy off' }, `○ NO TRADE ${sym(c)} auto-buy is off (would have bought: ${verdict.reason})`);
      notify('pick_ready', `🟡 $${c.symbol} passed every check (score ${a.score}, quality ${q.passedCount}/${q.total}) but auto-buy is off\npaste this to buy it yourself (paper):\n${c.mint}`, { dedupeKey: `ready:${c.mint}`, dedupeMs: 2 * 3.6e6 });
      nearMiss(c, 'head', [{ id: 'auto_buy_off', note: 'auto-buy off: the desk would have bought this' }], nmBase);
      return;
    }
    const vkey = verdict.approved ? 'ok' : verdict.reason.replace(/[\d.-]+/g, '#');
    notify('pick', alert.pickAlert({ symbol: c.symbol, score: a.score, mcap: c.mcap, liq: c.liqUsd, ageMin: c.ageMin, verdict, q }),
      verdict.approved ? {} : { dedupeKey: `pick:${c.mint}:${vkey}` });
    if (!verdict.approved) {
      run.vetoes++;
      if (/falling tape/.test(verdict.reason)) run.fallingTape++;
      ev('no_trade', { mint: c.mint, symbol: c.symbol, score: a.score, reason: verdict.reason }, `○ NO TRADE ${sym(c)} head of desk: ${verdict.reason}`);
      const byGate = /^quality gate/.test(verdict.reason);
      nearMiss(c, byGate ? 'quality' : 'head', byGate ? q.failed : [{ id: 'head', note: verdict.reason }, ...q.failed], nmBase);
      return;
    }
    run.approved++;
    const pos = openPaper(st, c, a, hp, size, config);
    pos.entryLiq = c.liqUsd;
    pos.why = {
      score: a.score, parts: a.parts,
      rules: f.results.map((r) => `${r.n} ${r.id}: ${r.value}`),
      quality: q.checks.map((x) => `${x.id}: ${x.value} (need ${x.need})`),
      sellTest: `$${hp.testUsd} round trip -${hp.roundTripLossPct}%, impact ${hp.impactPct}%, ${hp.route}`,
      head: verdict.reason,
      tape: `5m ${c.change.m5}%, 1h ${c.change.h1}%, 6h ${c.change.h6}%`,
      buys: `1h ${c.txns.h1.buys}/${c.txns.h1.buys + c.txns.h1.sells} · 5m ${c.txns.m5.buys}/${c.txns.m5.buys + c.txns.m5.sells}`,
      holders: `${a.holders}${a.holderGrowthPerHourPct != null ? ` (+${a.holderGrowthPerHourPct}%/h)` : ''}`,
      mcap: c.mcap, liq: c.liqUsd, ageMin: c.ageMin,
    };
    ev('buy', { pos }, `▲ PAPER BUY ${pos.id} ${sym(c)} $${pos.sizeUsd.toFixed(2)} @ $${sp(pos.entryPrice)} · stop $${sp(pos.stopPrice)} (-${config.risk.stopLossPct}%) · WHY: score ${a.score} [${Object.entries(a.parts).map(([k, v]) => `${k} ${v}`).join(', ')}] · quality ${q.passedCount}/${q.total} · ${verdict.reason}`);
    log.trade?.({ time: pos.entryAt, id: pos.id, side: 'BUY', symbol: pos.symbol, mint: pos.mint, price: pos.entryPrice, usd: pos.sizeUsd, qty: pos.tokens, reason: `score ${a.score}; ${pos.why.quality.join('; ')}; ${pos.why.sellTest}` });
    notify('buy', alert.buyAlert(pos, config));
    S.timers.nextWatch = now();
    dirty('desk');
  }

  // ---------- fast exit watch (every watchEverySec while anything is open)
  async function watch() {
    S.timers.nextWatch = now() + config.loop.watchEverySec * 1000;
    const deskPos = st.positions.filter((p) => p.strategy !== 'insider'); // insider positions have their own 1s monitor + E1-E8
    if (!deskPos.length) return 'idle';
    const mints = deskPos.map((p) => p.mint);
    const prices = await fastPrices(mints);
    let liq = null;
    if (now() >= S.timers.nextLiq) { S.timers.nextLiq = now() + (config.exits?.liqCheckEverySec || 10) * 1000; liq = await liquidityNow(mints); }
    for (const pos of [...deskPos]) {
      if (!st.positions.includes(pos)) continue;
      const px = prices.get(pos.mint);
      const lq = liq?.get(pos.mint);
      if (lq) pos.liqNow = lq.liq;
      pos.lastCheckAt = now();
      const emergency = lq ? liquidityAlarm(pos, lq.liq, config.exits) : null;
      const before = pos.stopPrice;
      let acts;
      if (emergency) acts = [{ type: 'exit', fraction: 1, reason: emergency, kind: 'emergency' }];
      else if (px) acts = manage(pos, px.price, config);
      else continue;
      if (px) { pos.lastPrice = px.price; pos.markUsd = pos.tokens * px.price; }
      if (pos.stopPrice !== before) dirty('desk');
      for (const act of acts) {
        if (act.type === 'note') { ev('hold', { id: pos.id, note: act.reason }, `◆ ${pos.id} $${pos.symbol} ${act.reason}`); notify('trail', alert.trailAlert(pos, act.reason)); dirty('desk'); continue; }
        // fill at what we could really get: a Jupiter sell quote for our exact tokens
        const trigger = px?.price ?? pos.lastPrice;
        const m = await markPrice(pos, trigger, config);
        const fillPrice = m?.price || trigger;
        const kind = act.kind || (/trailing/.test(act.reason) ? 'trail' : /stop/.test(act.reason) ? 'stop' : /take profit/.test(act.reason) ? 'take_profit' : 'exit');
        const detail = { kind, trigger, triggerSource: px?.source || 'last', fillPrice, fillSource: m?.source || 'trigger price',
          stop: before, slipVsStopPct: kind === 'stop' || kind === 'trail' ? +(((fillPrice / before) - 1) * 100).toFixed(2) : null,
          peakPct: +(((pos.peakPrice / pos.entryPrice) - 1) * 100).toFixed(1), checkEverySec: config.loop.watchEverySec };
        const { fill, trade } = sellPaper(st, pos, act.fraction, fillPrice, act.reason, config, { ofOriginal: act.ofOriginal });
        log.trade?.({ time: fill.at, id: pos.id, side: 'SELL', symbol: pos.symbol, mint: pos.mint, price: fillPrice, usd: fill.proceeds, qty: fill.qty, reason: act.reason, pnl: trade?.pnlUsd, R: trade?.R });
        if (trade) {
          trade.exit = detail; trade.why = pos.why;
          ev('sell', { trade }, `▼ PAPER SELL ${trade.id} $${pad(trade.symbol, 9)} ${trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(trade.pnlUsd).toFixed(2)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct}%, ${trade.R >= 0 ? '+' : ''}${trade.R}R) · WHY: ${act.reason} · trigger $${sp(trigger)} (${detail.triggerSource}) · fill $${sp(fillPrice)} (${detail.fillSource})${detail.slipVsStopPct != null ? ` · ${detail.slipVsStopPct}% vs stop` : ''} · peak +${detail.peakPct}%`);
          notify(kind === 'emergency' ? 'emergency' : (kind === 'stop' && trade.pnlUsd < 0) ? 'stop_out' : 'sell', alert.sellAlert(trade));
          const ac = afterClose(st, trade, config);
          if (ac.cooldown) { notify('cooldown', alert.cooldownAlert(config)); ev('freeze', {}, `⏸ COOLDOWN ${config.risk.cooldownMin} min: ${config.risk.lossStreakForCooldown} losses in a row, no revenge trades`); }
        } else {
          ev('sell', { fill, detail }, `▼ PAPER SELL ${pos.id} $${pos.symbol} partial: ${act.reason} @ $${sp(fillPrice)}`);
          notify('take_profit', alert.partialAlert(fill));
        }
        dirty('desk');
      }
    }
    const rs = riskStatus(st, config);
    if (rs.frozen && !st.frozenAlerted) { st.frozenAlerted = true; notify('freeze', alert.freezeAlert(rs.frozen, rs.dayPnlPct, config)); ev('freeze', rs.frozen, `■ FROZEN: ${rs.frozen.why}`); dirty('desk'); }
    if (!rs.frozen && st.frozenAlerted) { st.frozenAlerted = false; dirty('desk'); }
    return 'watch';
  }

  // ---------- near-miss re-checks (+15m, +1h, +4h, +24h)
  async function nearMissStep() {
    S.timers.nextNm = now() + 60_000;
    const r = await recheckDue(S.nm, { now: now() });
    if (r.checked) { dirty('nm'); ev('near_miss_check', { checked: r.checked }, `◌ NEAR MISS re-check: ${r.checked} checkpoints filled`); }
    return 'nearmiss';
  }

  // ---------- the 24h test window + report
  function testStep() {
    const t = st.test;
    if (!t?.endsAt || now() < t.endsAt || t.reportSentAt) return null;
    const text = testReportText({ S, config, now: now() });
    notify('report', text, { force: true });
    t.reportSentAt = now();
    st.reports = [...(st.reports || []), { at: now(), n: t.n || 1, text }].slice(-7);
    ev('report', {}, `■ ${t.hours}H REPORT #${t.n || 1} sent`);
    // the upgrades stay on after the test: the desk keeps paper trading and writes the next report 24h later
    st.test = { startedAt: now(), endsAt: now() + t.hours * 3.6e6, hours: t.hours, n: (t.n || 1) + 1, equityAtStart: equity(st), closedAtStart: st.closed.length, reportSentAt: null };
    S.run = newRun(); Object.assign(run, S.run); S.run = run;
    dirty('desk', 'run');
    return 'report';
  }

  function prune() {
    const cut = now() - 26 * 3.6e6;
    for (const [m, v] of Object.entries(S.seen)) if (v[0] < cut) delete S.seen[m];
    const hcut = now() - 2 * 3.6e6;
    for (const [m, h] of Object.entries(S.holders)) if (!h.length || h[h.length - 1].at < hcut) delete S.holders[m];
    for (const [m, t] of Object.entries(st.noReentry)) if (t < now()) delete st.noReentry[m];
  }

  // balance over time for the dashboard: one point every 5 min + one at every trade
  function curvePoint(force = false) {
    const last = S.curve[S.curve.length - 1];
    if (!force && last && now() - last.t < 5 * 60_000) return;
    S.curve.push({ t: now(), eq: +equity(st).toFixed(3), open: st.positions.length });
    if (S.curve.length > 2000) S.curve.splice(0, S.curve.length - 2000);
    dirty('curve');
  }

  // ONE unit of work per call, so a Worker invocation stays small.
  async function tick({ deepPerStep = 4, monitorBurst = 1, pbBudget = 8 } = {}) {
    const T = S.timers;
    const nTrades = st.closed.length + st.positions.length;
    curvePoint(nTrades !== S._lastTradeCount && S._lastTradeCount != null);
    S._lastTradeCount = nTrades;
    const tr = testStep();
    if (tr) return { did: tr, nextAt: now() + 1000 };
    let did = 'none';
    const deskOpen = st.positions.some((p) => p.strategy !== 'insider');
    const pbOn = pb && config.playbook.enabled !== false && !st.paused;
    if (pb && pb.monitorDue()) did = await pb.monitor(monitorBurst); // open insider trades first: exits matter most (paused or not)
    else if (deskOpen && now() >= T.nextWatch) { watching = true; try { did = await watch(); } finally { watching = false; } }
    else if (S.scan.phase === 'deep' && S.scan.queue.length) did = await scanDeep(deepPerStep);
    else if (pbOn && pb.buildDue()) did = await pb.buildStep(pbBudget);
    else if (now() >= T.nextScan) { prune(); did = await scanDiscover(); }
    else if (pbOn && pb.discoverDue()) did = await pb.discover();
    else if (now() >= T.nextNm) did = await nearMissStep();
    else if (pb && pb.labelsDue()) did = await pb.labelsStep();
    else if (S.scan.phase === 'deep') { S.scan.phase = 'idle'; dirty('scan'); }
    const deepPending = S.scan.phase === 'deep' && S.scan.queue.length;
    const nexts = [T.nextScan, T.nextNm, st.test?.endsAt && !st.test.reportSentAt ? st.test.endsAt : Infinity];
    if (deskOpen) nexts.push(T.nextWatch);
    if (pb) nexts.push(pbOn ? pb.nextAt() : Math.min(pb.monitorDue() ? now() : Infinity, S.pb.timers.nextLabels));
    if (deepPending) nexts.push(now() + 500);
    return { did, nextAt: Math.max(now() + 200, Math.min(...nexts)) };
  }

  const todayR = () => st.closed.filter((t) => t.exitAt?.slice(0, 10) === st.day).reduce((a, t) => a + t.R, 0);
  const snapshot = () => ({ st: riskStatus(st, config), state: st, todayR: todayR(), paused: Boolean(st.paused), stats: stats(st), run, config, nm: S.nm, S });

  if (pb) Object.defineProperty(S, 'pbLines', { value: () => pb.reportLines(), enumerable: false, configurable: true });
  return {
    tick, watch, scanDiscover, pb, scanDeep, nearMissStep, snapshot, S,
    event: (type, line) => ev(type, {}, line), // day 4: manual trades from the button menu land in the same live feed
    startTest(hours = 24) {
      st.test = { startedAt: now(), endsAt: now() + hours * 3.6e6, hours, n: 1, equityAtStart: equity(st), closedAtStart: st.closed.length, reportSentAt: null };
      S.run = newRun(); Object.assign(run, S.run); S.run = run;
      dirty('desk', 'run');
      return st.test;
    },
    // her call (Oct 31): stop the running window before its end, keep every trade, write the partial report,
    // and open the next window at once. `text` + `sentAt` = the report already went out (sent just before a deploy);
    // without them the report is written now and queued for telegram. expectN guards against a double call.
    endTestEarly({ hours, reason = 'stopped early at the owner\'s request', stoppedAt, text, sentAt, expectN } = {}) {
      const t = st.test;
      if (!t) return { ok: false, why: 'no test window running' };
      if (expectN != null && (t.n || 1) !== expectN) return { ok: false, why: `window is #${t.n || 1}, not #${expectN}` };
      const at = Math.min(stoppedAt || now(), now());
      const ranH = Math.max(0, (at - t.startedAt) / 3.6e6);
      let body = text;
      if (!body) {
        body = `⏹ stopped early at your request · ${ranH.toFixed(1)}h of ${t.hours}h\n` + testReportText({ S, config, now: at });
        notify('report', body.slice(0, 4000), { force: true });
      }
      t.reportSentAt = sentAt || now(); t.stoppedEarlyAt = at; t.stoppedEarly = reason;
      st.reports = [...(st.reports || []), { at: sentAt || now(), n: t.n || 1, text: body, early: true, hoursRun: +ranH.toFixed(2), stoppedAt: at }].slice(-7);
      ev('report', {}, `■ ${t.hours}H REPORT #${t.n || 1} (stopped early after ${ranH.toFixed(1)}h)`);
      const h = hours || t.hours || 24;
      st.test = { startedAt: now(), endsAt: now() + h * 3.6e6, hours: h, n: (t.n || 1) + 1, equityAtStart: equity(st), closedAtStart: st.closed.length, reportSentAt: null };
      S.run = newRun(); Object.assign(run, S.run); S.run = run;
      dirty('desk', 'run');
      return { ok: true, report: st.reports[st.reports.length - 1], test: st.test };
    },
    pause() { st.paused = { at: new Date(now()).toISOString(), by: 'owner' }; dirty('desk'); ev('freeze', {}, '⏸ PAUSED by owner from telegram. stops still run'); },
    resume() { st.paused = null; dirty('desk'); ev('info', {}, '▶ RESUMED by owner from telegram'); },
  };
}
