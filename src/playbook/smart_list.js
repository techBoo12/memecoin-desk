// ============================================================================
// SMART-WALLET LIST: builder-side sanity filters (Oct 31 2026, fix after the first live list)
// Used ONLY by the off-worker list builder (tools/smart_wallets.mjs) and tests. The worker never
// imports this file, so changing it changes nothing on the live bot.
//
// Why: the first real list picked "winners" like $USOE 42,385x, $USDP 8,533x, $NAFF, $AOTF, $NODF:
// fake fund / fake dollar names ("United States Oil Exchange", "American Oil Trust Fund",
// "United States Dividend Program") whose price sits pinned near its peak with 30-80 buys per sell
// and an FDV 100-300x the pool's liquidity. That is a managed / wash-traded pool (or one only the
// insiders can sell), not a crowd win, and its "early buyers" are most likely the team's own wallets.
// And the 3 wallets kept had not traded for 14-38 h, so the copy lane had nothing to copy.
//
// Every number below is a guess, set from that one day's data (tune by results). Each check is a
// statistical red flag, not proof: a real coin can trip one, a fake can pass all of them.
// ============================================================================
import { tradeOf } from './smart.js';

export const SANITY = {
  maxPeakX: 1000,      // more than 1000x the migration price inside 2 days: price data or pool not believable
  maxFdvLiq: 60,       // FDV over 60x the pool's liquidity: thin, managed pool (real runners seen: 8-40x)
  maxBuySell: 10,      // 10+ buys per sell over 24h (with 1000+ buys): one-sided flow, wash buys or sells blocked
  minBuysForSkew: 1000,
  pinnedMinX: 50,      // 50x+ and still within 2% of the peak after 12h+: price pinned, not traded
  pinnedRatio: 0.98,
  pinnedMinAgeH: 12,
};

// stablecoin / fake-fund lookalikes: tickers like USDP, USDF, USOE, NODF, AOTF and names like
// "United States Dividend Fund". Real memes rarely name themselves after a treasury product.
const SYMBOL_RE = /^(W?USD[A-Z0-9]{0,3}|US[A-Z]{2,3}|[A-Z]{2,3}(DF|TF)|[A-Z]{1,3}ETF|DAI|EURC?|PYUSD|FDUSD|TUSD|USDE)$/i;
const NAME_RE = /\b(united states|u\.s\.a?\.?|usa|america|american|national|federal|treasury|reserve|dividend|trust|fund|etf|oil|exchange|stable ?coin|dollar|usd[a-z]*|euro|bond|program|securities)\b/i;

export function lookalike(symbol = '', name = '') {
  const s = String(symbol || '').replace(/^\$/, '').trim();
  if (s && SYMBOL_RE.test(s)) return `ticker $${s} looks like a stablecoin / fund product`;
  const n = String(name || '').replace(/[^\p{L}\p{N} .]/gu, ' ').trim();
  const m = n && n.match(NAME_RE);
  if (m) return `name "${n}" reads like a fund / dollar product ("${m[1]}")`;
  return null;
}

// m: { symbol, name, peakX, nowX, fdv, liq, buys24, sells24, at (migration ms) }
// returns a reason string (drop it) or null (keep)
export function winnerSanity(m, now = Date.now(), o = {}) {
  const c = { ...SANITY, ...o };
  const look = lookalike(m.symbol, m.name);
  if (look) return look;
  const x = Math.max(m.peakX ?? 0, m.nowX ?? 0);
  if (x > c.maxPeakX) return `${Math.round(x)}x the migration price (> ${c.maxPeakX}x): price data not believable`;
  if (m.fdv > 0 && m.liq > 0 && m.fdv / m.liq > c.maxFdvLiq) return `FDV ${Math.round(m.fdv / m.liq)}x its liquidity (> ${c.maxFdvLiq}x): thin, managed pool`;
  if ((m.buys24 || 0) >= c.minBuysForSkew && m.buys24 / Math.max(1, m.sells24 || 0) >= c.maxBuySell) return `${Math.round(m.buys24 / Math.max(1, m.sells24 || 0))} buys per sell in 24h: one-sided flow`;
  const ageH = m.at ? (now - m.at) / 3.6e6 : 0;
  if (m.peakX >= c.pinnedMinX && m.nowX != null && m.nowX / m.peakX >= c.pinnedRatio && ageH >= c.pinnedMinAgeH) return `pinned at ${Math.round(m.peakX)}x for ${Math.round(ageH)}h+: price managed, not traded`;
  return null;
}

// a ticker that was flagged once taints its clones in the same window (copycat launches of the same fake)
export function taintClones(list, flaggedSymbols) {
  const bad = new Set([...flaggedSymbols].map((s) => String(s).toUpperCase()));
  return list.filter((m) => !bad.has(String(m.symbol || '').toUpperCase()));
}

// when did this wallet last BUY or SELL a token (ms), from its own transactions; null if never in the page
export function lastTradeAt(txs, wallet) {
  let last = null;
  for (const tx of txs || []) {
    const t = tradeOf(tx, wallet);
    if (t.side !== 'buy' && t.side !== 'sell') continue;
    const at = (tx.blockTime || 0) * 1000;
    if (at && (last == null || at > last)) last = at;
  }
  return last;
}

// the copy lane copies live buys: a wallet idle for more than maxIdleH is no use to it today
export function recencyGate(lastAt, now = Date.now(), maxIdleH = 12) {
  if (lastAt == null) return { ok: false, why: 'no trade in its recent page' };
  const h = (now - lastAt) / 3.6e6;
  if (h > maxIdleH) return { ok: false, why: `last trade ${h.toFixed(1)}h ago (> ${maxIdleH}h)`, idleH: +h.toFixed(1) };
  return { ok: true, idleH: +h.toFixed(1) };
}

// the newest successful signature from a 1-credit getSignaturesForAddress page (ms), for a cheap pre-check
export function newestOkSig(sigs) {
  const ok = (sigs || []).filter((s) => !s.err && s.blockTime);
  return ok.length ? Math.max(...ok.map((s) => s.blockTime)) * 1000 : null;
}
