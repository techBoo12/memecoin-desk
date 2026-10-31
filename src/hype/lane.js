// ============================================================================
// THE HYPE LANE (paper): "popularity coins" like $TRUMP, a viral-animal coin, a sports-meme coin.
//   An OFF-WORKER scanner (hype/hype_scanner.py) reads free trend sources (Google Trends, Wikipedia,
//   Reddit, 4chan, Bluesky, DexScreener boosts, Jupiter/GeckoTerminal trending, Meteora's new pools,
//   the coin's own tweet) and pushes a short watchlist here (POST /admin/hype, admin key).
//   This lane re-checks each high-hype coin LIVE (liquidity floor, mint/freeze revoked, can sell
//   = Jupiter round trip, holder concentration) and paper-buys a small fixed size.
// BIG-NAME EXCEPTION: a coin that is high-hype AND trading huge (1h volume + liquidity floors) may pass
//   with a much higher holder-concentration cap ($TRUMP: the team held ~80%) at a QUARTER size.
//   Every use is logged "BIG-NAME EXCEPTION" with the numbers.
// Own book, own stats (lane=hype): NEVER touches the desk balance or the 14-day test numbers.
// No Helius calls: DexScreener + RugCheck + Jupiter quotes only. Paper only. No wallet, no keys.
// All numbers in config.hype are STARTING GUESSES to tune by paper trading.
// ============================================================================
import { refreshPairs } from '../desk/scout.js';
import { rugcheckReport } from '../desk/filter.js';
import { honeypotCheck } from '../desk/honeypot.js';
import { openPaper, sellPaper, markPrice } from '../desk/executor.js';
import { manage } from '../desk/risk.js';
import { getJSON } from '../lib/http.js';
import { buyCard } from '../telegram/buycard.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${n(x).toFixed(2)}`);

export function newHypeState(cfg = {}) {
  const start = cfg.starting_balance_usd ?? 100;
  return { watch: { at: 0, items: [], sources: {}, pushes: 0 }, book: { cash: start, startCash: start, positions: [], closed: [] },
    checked: {}, recent: [], skips: {}, stats: { checked: 0, entered: 0, skipped: 0, bigName: 0 }, timers: { nextCheck: 0, nextMonitor: 0 } };
}

// the watchlist the scanner pushes: validated hard, it comes from outside the worker
export function cleanWatch(body, now = Date.now()) {
  if (!body || !Array.isArray(body.items)) return { ok: false, error: 'items[] missing' };
  const items = [];
  for (const r of body.items.slice(0, 30)) {
    if (!r || !MINT_RE.test(String(r.mint || ''))) continue;
    items.push({
      mint: r.mint, symbol: String(r.symbol || '?').replace(/[^\w$.\- ]/g, '').slice(0, 16), name: String(r.name || '').slice(0, 40),
      dex: String(r.dex || '').slice(0, 24), score: n(r.score), tier: ['high', 'watch', 'low'].includes(r.tier) ? r.tier : 'low',
      bigName: r.bigName === true, early: r.early === true, huge: r.huge === true,
      why: (Array.isArray(r.why) ? r.why : []).map((w) => String(w).slice(0, 160)).slice(0, 5),
      liqUsd: n(r.liqUsd), vol1hUsd: n(r.vol1hUsd), ageMin: r.ageMin == null ? null : n(r.ageMin),
    });
  }
  const sources = {};
  for (const [k, v] of Object.entries(body.sources || {}).slice(0, 60)) sources[String(k).slice(0, 40)] = v === true;
  return { ok: true, watch: { at: now, scannedAt: n(body.at) || now, items, sources } };
}

// the desk's executor/risk code reads config.risk + config.honeypot; give it the hype lane's own numbers
export function hypeDeskConfig(config) {
  const h = config.hype;
  return { ...config, mode: 'paper', risk: { ...config.risk, stopLossPct: h.stop_loss_pct, trailActivatePct: h.trail_activate_pct, trailDistancePct: h.trail_distance_pct,
    takeProfitLadder: h.tp_ladder, paperFeePct: config.risk.paperFeePct }, honeypot: { ...config.honeypot, testSizeUsd: Math.max(1, h.position_usd), maxRoundTripLossPct: h.max_round_trip_loss_pct } };
}

// holder concentration from the rugcheck report (pools + lockers are not holders), same reading as the desk's filter
export function concentration(rc) {
  if (!rc?.topHolders?.length) return { top10: null, insider: null, dev: null };
  const skip = new Set((rc.markets || []).flatMap((m) => [m.pubkey, m.liquidityA, m.liquidityB]));
  for (const [addr, k] of Object.entries(rc.knownAccounts || {})) if (/AMM|LOCKER/i.test(k.type)) skip.add(addr);
  const real = rc.topHolders.filter((h) => !skip.has(h.owner) && !skip.has(h.address)).slice(0, 10);
  const top10 = real.reduce((s, h) => s + n(h.pct), 0);
  const supply = n(rc.token?.supply);
  const nets = (rc.insiderNetworks || []).reduce((s, x) => s + n(x.currentHolding ?? x.tokenAmount), 0);
  const insider = Math.max(supply ? (nets / supply) * 100 : 0, (rc.topHolders || []).filter((h) => h.insider).reduce((s, h) => s + n(h.pct), 0));
  const dev = supply ? (n(rc.creatorBalance) / supply) * 100 : null;
  return { top10: +top10.toFixed(1), insider: +insider.toFixed(1), dev: dev == null ? null : +dev.toFixed(2) };
}

// one safety reading, from RugCheck when it answers, else from Jupiter's token audit (free; mint/freeze
// revoked + top-holder share). On Oct 31 2026 07:17 UTC RugCheck answered 400 "unable to generate report"
// for every coin we asked, $TRUMP included, so a fallback is not optional.
export function safety(rc, jup, c, cfg) {
  if (rc) {
    const conc = concentration(rc);
    const m = rc.markets?.length ? [...rc.markets].sort((x, y) => n(y.lp?.lpLockedUSD) - n(x.lp?.lpLockedUSD))[0] : null;
    const lp = m ? Number(m.lp?.lpLockedPct) : NaN;
    return { src: 'rugcheck', mintAuth: !!rc.token?.mintAuthority, freezeAuth: !!rc.token?.freezeAuthority,
      creatorFlag: (rc.risks || []).some((r) => /rug|creator history/i.test(r.name || '')), ...conc, lp: Number.isFinite(lp) ? lp : null };
  }
  const a = jup?.audit;
  if (!a) return null;
  // pump.fun graduations burn their LP by protocol; anything else with no LP reading stays "unknown"
  const lp = (cfg.lp_burned_by_protocol_dexes || []).includes(c?.dexId) ? 100 : null;
  return { src: 'jupiter audit', mintAuth: a.mintAuthorityDisabled === false, freezeAuth: a.freezeAuthorityDisabled === false, creatorFlag: false,
    top10: Number.isFinite(Number(a.topHoldersPercentage)) ? +Number(a.topHoldersPercentage).toFixed(1) : null, insider: 0,
    dev: Number.isFinite(Number(a.devBalancePercentage)) ? +Number(a.devBalancePercentage).toFixed(2) : null, lp, decimals: jup.decimals };
}

// pure decision: what the rules say about this coin. returns { ok, code, note, bigName, sizeFrac }
export function judge(item, c, sf, cfg) {
  const b = cfg.big_name || {};
  if (!c) return { ok: false, code: 'H0', note: 'no live pair on DexScreener' };
  if (!sf) return { ok: false, code: 'H1', note: 'no safety data (rugcheck + jupiter audit both silent): unknown = skip' };
  if (sf.mintAuth || sf.freezeAuth) return { ok: false, code: 'H2', note: `${[sf.mintAuth && 'mint', sf.freezeAuth && 'freeze'].filter(Boolean).join(' + ')} authority still live` };
  if (sf.creatorFlag) return { ok: false, code: 'H3', note: 'rugcheck flags the creator' };
  if (c.liqUsd < cfg.min_liquidity_usd) return { ok: false, code: 'H4', note: `liq ${usd(c.liqUsd)} < ${usd(cfg.min_liquidity_usd)}` };
  if (c.vol.h1 < cfg.min_volume_1h_usd) return { ok: false, code: 'H5', note: `1h vol ${usd(c.vol.h1)} < ${usd(cfg.min_volume_1h_usd)}` };
  if (sf.top10 == null) return { ok: false, code: 'H6', note: 'no holder share (unknown = skip)' };
  const conc = { top10: sf.top10, insider: sf.insider || 0, dev: sf.dev };
  const fails = [];
  if (conc.top10 > cfg.max_top10_pct) fails.push(`top10 ${conc.top10}% > ${cfg.max_top10_pct}%`);
  if (conc.insider > cfg.max_insider_pct) fails.push(`insiders ${conc.insider}% > ${cfg.max_insider_pct}%`);
  if (conc.dev != null && conc.dev > cfg.max_dev_pct) fails.push(`dev ${conc.dev}% > ${cfg.max_dev_pct}%`);
  if (!(sf.lp >= cfg.min_lp_locked_pct)) fails.push(sf.lp != null ? `LP locked ${sf.lp.toFixed(0)}% < ${cfg.min_lp_locked_pct}%` : 'LP lock unknown');
  const src = ` [${sf.src}]`;
  if (!fails.length) return { ok: true, code: 'OK', note: `top10 ${conc.top10}% · insiders ${conc.insider}% · LP ${sf.lp ?? '?'}%${src}`, sizeFrac: 1, conc };
  // BIG-NAME EXCEPTION: high hype AND huge real trading. still capped, still quarter size, always logged.
  const hype = item.bigName || item.score >= (b.min_score ?? 60);
  const huge = c.vol.h1 >= b.min_volume_1h_usd && c.liqUsd >= b.min_liquidity_usd;
  const within = conc.top10 <= b.max_top10_pct && conc.insider <= b.max_insider_pct && (conc.dev == null || conc.dev <= b.max_dev_pct);
  if (b.enabled && hype && huge && within) {
    return { ok: true, code: 'BIG', bigName: true, sizeFrac: b.size_frac ?? 0.25, conc,
      note: `BIG-NAME EXCEPTION: ${fails.join(', ')} would skip it, but hype ${item.score}${item.bigName ? ' (big name)' : ''} + 1h vol ${usd(c.vol.h1)} + liq ${usd(c.liqUsd)} pass the big-name floors (top10 cap ${b.max_top10_pct}%) -> ${Math.round((b.size_frac ?? 0.25) * 100)}% size${src}` };
  }
  const whyNot = !b.enabled ? 'big-name exception off' : !hype ? `hype ${item.score} below big-name bar` : !huge ? `not huge (1h vol ${usd(c.vol.h1)}/${usd(b.min_volume_1h_usd)}, liq ${usd(c.liqUsd)}/${usd(b.min_liquidity_usd)})` : `even past big-name caps (top10 ${conc.top10}%/${b.max_top10_pct}%)`;
  return { ok: false, code: 'H7', note: `${fails.join(', ')} · ${whyNot}${src}`, conc };
}

const jupToken = async (mint) => {
  const r = await getJSON(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { retries: 1, timeoutMs: 8000, minGapMs: 1100 });
  return Array.isArray(r.data) ? r.data.find((t) => t.id === mint) || null : null;
};

export function createHypeLane({ config, S, now = () => Date.now(), log = console.log, notify = () => {}, dirty = () => {}, io = {} }) {
  const cfg = config.hype;
  S.hype ||= newHypeState(cfg);
  const H = S.hype;
  const D = hypeDeskConfig(config);
  const devHistory = io.devHistory || null; // Oct 31: the insider lane's dev-history check (cached, budgeted), when the worker wires it
  const pairs = io.pairs || refreshPairs, rugcheck = io.rugcheck || ((m) => rugcheckReport(m, 60_000)), jup = io.jupToken || jupToken, honeypot = io.honeypot || honeypotCheck, mark = io.markPrice || markPrice;
  const ev = (line) => log(line);
  const remember = (x) => { H.recent.unshift({ at: now(), ...x }); H.recent.length = Math.min(H.recent.length, 40); };
  const skip = (it, code, note) => {
    H.skips[code] = (H.skips[code] || 0) + 1; H.stats.skipped++;
    remember({ sym: it.symbol, mint: it.mint, d: 'skip', code, note: String(note).slice(0, 200) });
    ev(`◇ HYPE SKIP $${it.symbol} ${code}: ${String(note).slice(0, 160)}`);
  };

  function setWatch(body) {
    const r = cleanWatch(body, now());
    if (!r.ok) return r;
    H.watch = { ...r.watch, pushes: (H.watch?.pushes || 0) + 1 };
    dirty('hype');
    return { ok: true, items: r.watch.items.length, high: r.watch.items.filter((x) => x.tier === 'high' || x.bigName).length };
  }

  const fresh = () => now() - (H.watch?.at || 0) <= cfg.watch_max_age_min * 60_000;
  function nextItem() {
    if (!fresh()) return null;
    const held = new Set(H.book.positions.map((p) => p.mint));
    return (H.watch.items || []).find((it) => (it.tier === 'high' || it.bigName) && it.score >= cfg.min_score && !held.has(it.mint)
      && now() - (H.checked[it.mint] || 0) > cfg.recheck_after_min * 60_000) || null;
  }

  async function checkOne() {
    H.timers.nextCheck = now() + cfg.check_every_s * 1000;
    const it = nextItem();
    if (!it) return 'hype_idle';
    H.checked[it.mint] = now(); H.stats.checked++;
    for (const [k, t] of Object.entries(H.checked)) if (now() - t > 24 * 3.6e6) delete H.checked[k];
    dirty('hype');
    if (H.book.positions.length >= cfg.max_open) { skip(it, 'H8', `already ${H.book.positions.length} hype trades open (max ${cfg.max_open})`); return 'hype_skip'; }
    const c = (await pairs([it.mint])).get(it.mint);
    const rc = c ? await rugcheck(it.mint) : null;
    const jt = c && !rc ? await jup(it.mint) : null;
    const sf = safety(rc, jt, c, cfg);
    const v = judge(it, c, sf, cfg);
    if (!v.ok) { skip(it, v.code, v.note); return 'hype_skip'; }
    // sell test: Jupiter buy + sell quote. without rugcheck, decimals come from Jupiter's token record (no RPC call)
    const hp = await honeypot(c, rc || { token: { decimals: jt?.decimals } }, { config: D });
    if (!hp.ok) { skip(it, hp.unknown ? 'H9' : 'H10', hp.reason); return 'hype_skip'; }
    const sizeUsd = +Math.min(cfg.position_usd * v.sizeFrac, H.book.cash).toFixed(2);
    if (sizeUsd < 0.5) { skip(it, 'H11', `hype book cash ${usd(H.book.cash)} too low`); return 'hype_skip'; }
    // Oct 31: dev history (creator from the rugcheck report): a serial rugger is skipped; the verdict rides the buy card
    let devHist = null;
    if (devHistory && rc?.creator) {
      try { devHist = await devHistory({ mint: it.mint, dev: rc.creator, funder: null, symbol: it.symbol }); } catch { devHist = null; }
      if (devHist?.verdict === 'serial_rugger') { skip(it, 'H12', `dev history: serial rugger (${devHist.why}) · evidence, not proof`); return 'hype_skip'; }
    }
    const pos = openPaper(H.book, c, { score: it.score }, hp, { sizeUsd, riskUsd: +(sizeUsd * cfg.stop_loss_pct / 100).toFixed(4) }, D);
    pos.id = `H${String(H.book.closed.length + H.book.positions.length).padStart(3, '0')}`;
    Object.assign(pos, { lane: 'hype', strategy: 'hype', bigName: !!v.bigName, why: it.why.slice(0, 3), entryLiq: c.liqUsd, rule: v.note });
    H.stats.entered++; if (v.bigName) H.stats.bigName++;
    remember({ sym: it.symbol, mint: it.mint, d: v.bigName ? 'BUY (big-name exception)' : 'BUY', note: `${usd(sizeUsd)} · hype ${it.score} · ${v.note}`.slice(0, 200) });
    ev(`▲ HYPE PAPER BUY ${pos.id} $${it.symbol} ${usd(sizeUsd)} @ ${hp.fillPriceUsd} · hype ${it.score} · ${v.note} · why: ${it.why.join(' | ').slice(0, 200)}`);
    if (devHist) pos.devHist = { verdict: devHist.verdict, why: devHist.why, counts: devHist.counts };
    const cc = concentration(rc);
    notify('buy', buyCard({ lane: 'hype', symbol: it.symbol, mint: it.mint, pool: c.pairAddress || null, sizeUsd: pos.sizeUsd, entryPrice: pos.entryPrice, liqUsd: c.liqUsd, mcapUsd: c.mcap,
      crew: { pct: cc.insider, source: 'linked/insider wallets, rugcheck proxy' }, devPct: cc.dev, devHist,
      passed: [`liq ${usd(c.liqUsd)}`, 'mint/freeze revoked', `sell test ok${hp.roundTripLossPct != null ? ` -${hp.roundTripLossPct}%` : ''}`, ...(cc.top10 != null ? [`top10 ${cc.top10}%`] : [])],
      why: `${v.bigName ? 'big-name exception, quarter size (logged BIG-NAME EXCEPTION) · ' : ''}hype score ${it.score}: ${it.why.slice(0, 2).join(' · ').slice(0, 200)}` }));
    dirty('hype');
    return v.bigName ? 'hype_buy_big' : 'hype_buy';
  }

  async function close(pos, fraction, reason, fallback, opts) {
    const px = (await mark(pos, fallback, D))?.price || fallback;
    const { trade } = sellPaper(H.book, pos, fraction, px, reason, D, opts);
    if (trade) {
      Object.assign(trade, { lane: 'hype', bigName: !!pos.bigName });
      ev(`▼ HYPE PAPER SELL ${trade.id} $${trade.symbol} ${trade.pnlUsd >= 0 ? '+' : ''}${trade.pnlUsd.toFixed(2)} (${trade.pnlPct}%) · ${reason}`);
      notify('sell', `${trade.pnlUsd >= 0 ? '✅' : '🔻'} hype lane closed $${trade.symbol} ${trade.pnlUsd >= 0 ? '+' : ''}$${trade.pnlUsd.toFixed(2)} (${trade.pnlPct}%) · ${reason}`);
    }
  }

  async function monitor() {
    H.timers.nextMonitor = now() + cfg.monitor_every_s * 1000;
    const open = H.book.positions;
    if (!open.length) return 'hype_watch_idle';
    const live = await pairs(open.map((p) => p.mint));
    for (const pos of [...open]) {
      const c = live.get(pos.mint);
      if (!c) continue;
      if (pos.entryLiq && c.liqUsd < pos.entryLiq * (1 - cfg.liq_drop_exit_pct / 100)) { await close(pos, 1, `liquidity pulled ${usd(pos.entryLiq)} -> ${usd(c.liqUsd)}`, c.priceUsd); continue; }
      if (now() - Date.parse(pos.entryAt) > cfg.max_hold_hours * 3.6e6) { await close(pos, 1, `max hold ${cfg.max_hold_hours}h`, c.priceUsd); continue; }
      for (const a of manage(pos, c.priceUsd, D)) {
        if (a.type === 'note') { ev(`◆ HYPE ${pos.id} $${pos.symbol} ${a.reason}`); continue; }
        await close(pos, a.fraction, a.reason, c.priceUsd, { ofOriginal: !!a.ofOriginal });
        if (a.type === 'exit') break;
      }
      if (H.book.positions.includes(pos)) pos.markUsd = pos.tokens * c.priceUsd;
    }
    dirty('hype');
    return 'hype_watch';
  }

  const monitorDue = () => H.book.positions.length > 0 && now() >= H.timers.nextMonitor;
  const checkDue = () => cfg.enabled && now() >= H.timers.nextCheck && !!nextItem();
  return {
    setWatch, checkOne, monitor, monitorDue, checkDue,
    due: () => monitorDue() || checkDue(),
    async step() { return monitorDue() ? monitor() : checkDue() ? checkOne() : 'hype_idle'; },
    nextAt: () => Math.min(H.book.positions.length ? H.timers.nextMonitor : Infinity, cfg.enabled && fresh() ? Math.max(H.timers.nextCheck, now() + 1000) : Infinity),
    lines: () => hypeLines(S, config, now()),
  };
}

export function hypeStats(H) {
  const c = H.book.closed;
  const pnl = c.reduce((s, t) => s + t.pnlUsd, 0);
  const wins = c.filter((t) => t.pnlUsd > 0).length;
  const eq = H.book.cash + H.book.positions.reduce((s, p) => s + n(p.markUsd), 0);
  return { trades: c.length, wins, winRate: c.length ? Math.round((wins / c.length) * 100) : null, pnlUsd: +pnl.toFixed(2), equity: +eq.toFixed(2), start: H.book.startCash, open: H.book.positions.length };
}

export function hypeLines(S, config, now = Date.now()) {
  const H = S.hype; if (!H) return [];
  const s = hypeStats(H);
  const ageMin = H.watch?.at ? Math.round((now - H.watch.at) / 60000) : null;
  const top = (H.watch?.items || []).filter((x) => x.tier === 'high' || x.bigName).slice(0, 3).map((x) => `$${x.symbol} ${x.score}`).join(', ');
  return [
    `🔥 hype lane (paper, own $${s.start} book, not in the 14-day numbers)`,
    `balance $${s.equity.toFixed(2)} · ${s.trades} closed${s.trades ? ` · ${s.winRate}% wins · ${s.pnlUsd >= 0 ? '+' : ''}$${s.pnlUsd.toFixed(2)}` : ''} · ${s.open} open · big-name exceptions used ${H.stats.bigName}`,
    ageMin == null ? 'watchlist: no scan pushed yet' : `watchlist: ${(H.watch.items || []).length} coins, scan ${ageMin} min ago${ageMin > (config.hype?.watch_max_age_min ?? 30) ? ' (STALE, lane waits)' : ''}${top ? ` · hot: ${top}` : ''}`,
    `checked ${H.stats.checked} · bought ${H.stats.entered} · skipped ${H.stats.skipped}`,
  ];
}
