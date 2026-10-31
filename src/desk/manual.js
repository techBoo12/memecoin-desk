// ============================================================================
// MANUAL TRADES (day 4, the button menu)
// Job: what happens when techBoo pastes a coin address in Telegram:
//      1) checkToken: the SAME checks the bot runs on its own picks: the 8 kill
//         rules, the Jupiter sell test, the analyst score, the quality gate
//      2) manualBuy: paper fill at a real Jupiter quote for the exact $ amount
//      3) manualSell: 25 / 50 / 100% of what's left, filled at a real Jupiter
//         sell quote for exactly those tokens (partial sells supported)
//      Every manual position + trade is tagged source:'manual' and kept out
//      of the bot's own stats. The desk's stop / trail / take profit still
//      protect manual positions (balance first).
// HARD STOP: paper only. No wallet, no keys, no signer, no swap. Quotes only.
// ============================================================================
import { guardTradeRecord } from '../playbook/guard.js';
import { filter, usd } from './filter.js';
import { honeypotCheck, quote, solPriceUsd, mintDecimals } from './honeypot.js';
import { analyze } from './analyst.js';
import { qualityGate } from './quality.js';
import { refreshPairs } from './scout.js';
import { openPaper, sellPaper } from './executor.js';
import { riskStatus, afterClose } from './risk.js';
import { SOL_MINT } from '../lib/http.js';

export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMint = (s) => MINT_RE.test(String(s || '').trim());

const NET = { refreshPairs, filter, honeypotCheck, analyze, qualityGate, quote, solPriceUsd };
const sp = (x) => (x >= 1 ? x.toFixed(4) : Number(x).toPrecision(4));

// ---------- 1) the safety check + score card for a pasted address
export async function checkToken(mint, { config, S, net = NET, now = Date.now() }) {
  mint = String(mint).trim();
  if (!isMint(mint)) return { ok: false, mint, error: "that doesn't look like a Solana token address" };
  if (mint === SOL_MINT) return { ok: false, mint, error: "that's SOL itself, paste a memecoin's address" };
  const pairs = await net.refreshPairs([mint]);
  const c = pairs.get(mint);
  if (!c) return { ok: false, mint, error: 'no Solana trading pair found for that address (DexScreener)' };
  const f = await net.filter(c, { config });
  const bad = f.results.filter((r) => r.status === 'kill' || (r.status === 'unknown' && config.filter.unknownIsKill.includes(r.id)));
  const hp = await net.honeypotCheck(c, f.rc, { config });
  const a = net.analyze(c, f.rc, { config, holderHistory: S.holders || (S.holders = {}), now });
  const q = net.qualityGate(c, f, a, config);
  const st = S.desk;
  const safety = [
    ...bad.map((r) => `rule ${r.n} ${r.id}: ${r.status === 'unknown' ? `can't check (${r.note})` : r.note}`),
    ...(hp.ok ? [] : [`sell test: ${hp.reason}`]),
  ];
  const taste = [
    ...(a.passes ? [] : [`score ${a.score} (desk buys at ${config.analyst.passScore}+)`]),
    ...(a.tapeOk ? [] : [`falling tape (5m ${a.tape.m5}%, 1h ${a.tape.h1}%)`]),
    ...q.failed.map((x) => x.note),
  ];
  const rs = riskStatus(st, config);
  return {
    ok: true, at: now, mint, symbol: c.symbol, name: c.name, url: c.url, priceUsd: c.priceUsd,
    mcap: c.mcap, liq: c.liqUsd, ageMin: c.ageMin, change: c.change,
    decimals: hp.decimals ?? (await mintDecimals(mint, f.rc)) ?? 6, // day 5: from the chain when rugcheck is silent
    rulesPassed: 8 - bad.length,
    sellTest: hp.ok ? `ok: $${hp.testUsd} round trip -${hp.roundTripLossPct}%, impact ${hp.impactPct}%` : hp.reason,
    sellOk: Boolean(hp.ok),
    score: a.score, quality: `${q.passedCount}/${q.total}`,
    safe: safety.length === 0,         // the things that can rug you: 8 rules + sell test
    deskPick: safety.length === 0 && taste.length === 0, // would the bot itself buy it?
    safety, taste,
    frozen: rs.frozen ? rs.frozen.why : null,
    holding: st.positions.some((p) => p.mint === mint),
  };
}

// ---------- 2) paper buy for an exact $ amount at a live Jupiter quote
export async function manualBuy(S, check, usdAmt, config, { net = NET, force = false, now = Date.now() } = {}) {
  const st = S.desk;
  if (config.mode !== 'paper') throw new Error('manual buys are paper-only');
  usdAmt = Math.round(Number(usdAmt) * 100) / 100;
  if (!(usdAmt >= 1)) return { ok: false, error: 'minimum is $1' };
  if (usdAmt > st.cash) return { ok: false, error: `only $${st.cash.toFixed(2)} paper cash free` };
  if (st.positions.some((p) => p.mint === check.mint)) return { ok: false, error: `already holding $${check.symbol}. sell it first or open its card` };
  if ((!check.safe || check.frozen) && !force) return { ok: false, needConfirm: true };
  const sol = await net.solPriceUsd();
  if (!sol) return { ok: false, error: "no SOL price right now, can't size the fill. try again in a moment" };
  const lamports = Math.round((usdAmt / sol) * 1e9);
  const q = await net.quote(SOL_MINT, check.mint, lamports, config.honeypot.slippageBps);
  if (!q || q.failed) return { ok: false, error: q?.failed === 'no_route' ? 'no buy route on Jupiter, no fill (even on paper)' : 'Jupiter quote API busy, try again in a moment' };
  const tokensOut = Number(q.outAmount) / 10 ** check.decimals;
  if (!(tokensOut > 0)) return { ok: false, error: 'Jupiter returned an empty quote, no fill' };
  const impactPct = +((Number(q.priceImpactPct) || 0) * 100).toFixed(2);
  const maxSlip = config.honeypot.slippageBps / 100;
  if (impactPct > maxSlip && !force) return { ok: false, error: `price impact ${impactPct}% is over your ${maxSlip}% slippage. try a smaller size or raise slippage in ⚙️` };
  if (st.positions.some((p) => p.mint === check.mint)) return { ok: false, error: `already holding $${check.symbol}` }; // re-check after the await
  if (usdAmt > st.cash) return { ok: false, error: `only $${st.cash.toFixed(2)} paper cash free` };
  const fillPriceUsd = usdAmt / tokensOut; // incl. pool fees + price impact, what a real fill would get
  const size = { sizeUsd: usdAmt, riskUsd: +(usdAmt * config.risk.stopLossPct / 100).toFixed(4) };
  const pos = openPaper(st, { mint: check.mint, symbol: check.symbol, url: check.url }, { score: check.score }, { fillPriceUsd, decimals: check.decimals }, size, config);
  pos.source = 'manual';
  pos.entryLiq = check.liq;
  pos.why = {
    manual: true, score: check.score, quality: check.quality, rulesPassed: check.rulesPassed, sellTest: check.sellTest,
    safety: check.safe ? '8/8 rules + sell test ok' : `bought anyway: ${check.safety.join('; ')}`,
    buys: 'manual buy (you)', holders: '-', tape: check.change ? `5m ${check.change.m5}%, 1h ${check.change.h1}%, 6h ${check.change.h6}%` : '-',
    fill: `jupiter quote $${usdAmt} -> ${tokensOut.toPrecision(6)} tokens, impact ${impactPct}%`,
    mcap: check.mcap, liq: check.liq, ageMin: check.ageMin,
  };
  return { ok: true, pos, impactPct, route: q.routePlan?.map((r) => r.swapInfo?.label).filter(Boolean).join(' > ') || 'jupiter' };
}

// ---------- 3) paper sell 25 / 50 / 100% of what's left, at a live Jupiter sell quote
export async function sellQuotePrice(pos, qty, config, net = NET) {
  try {
    const raw = BigInt(Math.floor(qty * 10 ** pos.decimals));
    if (raw > 0n) {
      const q = await net.quote(pos.mint, SOL_MINT, raw.toString(), config.honeypot.slippageBps);
      const sol = await net.solPriceUsd();
      if (q && !q.failed && sol) return { price: (Number(q.outAmount) / 1e9) * sol / qty, source: 'jupiter sell quote' };
    }
  } catch { /* fall through */ }
  return pos.lastPrice ? { price: pos.lastPrice, source: 'last price (no live sell quote)' } : null;
}

export async function manualSell(S, posId, pct, config, { net = NET } = {}) {
  const st = S.desk;
  pct = Number(pct);
  if (![25, 50, 100].includes(pct)) return { ok: false, error: 'sell 25, 50 or 100%' };
  let pos = st.positions.find((p) => p.id === posId);
  if (!pos) return { ok: false, gone: true, error: 'that position is already closed' };
  const fraction = pct / 100;
  const px = await sellQuotePrice(pos, pos.tokens * fraction, config, net);
  pos = st.positions.find((p) => p.id === posId); // the 3s watcher may have closed it while we waited
  if (!pos) return { ok: false, gone: true, error: 'that position closed while quoting (stop or take profit hit)' };
  if (!px) return { ok: false, error: 'no price for it right now, try again' };
  const before = { tokens: pos.tokens, realized: pos.realizedUsd };
  const { fill, trade } = sellPaper(st, pos, fraction, px.price, `manual sell ${pct}% (you)`, config);
  if (!trade) pos.lastPrice = px.price; // the card shows what she just got, until the 3s watcher's next price
  if (trade) {
    trade.exit = { kind: 'manual', fillPrice: px.price, fillSource: px.source, peakPct: +(((pos.peakPrice / pos.entryPrice) - 1) * 100).toFixed(1) };
    trade.why = pos.why;
    if (pos.guard?.firstSignalAt) trade.guard = guardTradeRecord(pos.guard, trade); // Oct 31: early-exit guard cost/benefit
    afterClose(st, trade, config);
  }
  return { ok: true, fill, trade, pos: trade ? null : pos, price: px.price, source: px.source, soldTokens: before.tokens - (trade ? 0 : pos.tokens) };
}

// ---------- the numbers on a position card. P/L counts what was already sold (realized) + what's left at the mark
export function positionView(pos, config) {
  const now = pos.lastPrice || pos.entryPrice;
  const worth = pos.tokens * now;
  const pnlUsd = pos.realizedUsd + worth - pos.sizeUsd;
  const ladder = config.risk.takeProfitLadder || [];
  const nextTp = ladder.find((s) => !(pos.tpDone || []).includes(s.atMultiple));
  return {
    id: pos.id, symbol: pos.symbol, manual: pos.source === 'manual', entry: pos.entryPrice, now, worth,
    realized: pos.realizedUsd, pnlUsd, pnlPct: (pnlUsd / pos.sizeUsd) * 100, R: pos.riskUsd ? pnlUsd / pos.riskUsd : 0,
    soldPct: (1 - pos.tokens / pos.tokensOriginal) * 100, stop: pos.stopPrice, stopPct: (pos.stopPrice / pos.entryPrice - 1) * 100,
    trailing: pos.trailing, trailAt: config.risk.trailActivatePct, trail: config.risk.trailDistancePct,
    nextTp: nextTp ? { at: nextTp.atMultiple, price: pos.entryPrice * nextTp.atMultiple, sellPct: nextTp.sellPct } : null,
    sizeUsd: pos.sizeUsd, ageMin: Math.round((Date.now() - Date.parse(pos.entryAt)) / 60000),
  };
}
export { sp, usd };
