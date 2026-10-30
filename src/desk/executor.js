// ============================================================================
// EXECUTOR (PAPER)
// Job: fill the trades the Head of Desk approved, with fake money, at prices
//      a real fill would get (Jupiter quote incl. pool fees + price impact,
//      plus a paper fee for priority fees/slippage). Marks every open
//      position at a live Jupiter SELL quote, so the P/L is what we could
//      actually get out with, not a pretty mid price.
// HARD STOP: paper only. This file has no wallet, no keys, no signer and no
//            send. Going live is a separate, human-signed step.
// ============================================================================
import { quote, solPriceUsd } from './honeypot.js';
import { SOL_MINT } from '../lib/http.js';

export function openPaper(state, c, a, hp, size, config) {
  if (config.mode !== 'paper') throw new Error('executor is paper-only');
  const fee = config.risk.paperFeePct / 100;
  const entryPrice = hp.fillPriceUsd;
  const tokens = (size.sizeUsd * (1 - fee)) / entryPrice;
  const pos = {
    id: `T${String(state.closed.length + state.positions.length + 1).padStart(3, '0')}` /* keeps counting across runs */, mint: c.mint, symbol: c.symbol, url: c.url, decimals: hp.decimals ?? 6,
    entryAt: new Date().toISOString(), entryPrice, sizeUsd: size.sizeUsd, riskUsd: size.riskUsd,
    tokens, tokensOriginal: tokens, realizedUsd: 0, markUsd: size.sizeUsd * (1 - fee), lastPrice: entryPrice,
    stopPrice: entryPrice * (1 - config.risk.stopLossPct / 100), // set BEFORE entry, never lowered
    peakPrice: entryPrice, trailing: false, tpDone: [], score: a.score,
  };
  state.cash -= size.sizeUsd;
  state.positions.push(pos);
  return pos;
}

// live exit price for a position: Jupiter sell quote for the tokens we hold
export async function markPrice(pos, fallbackPriceUsd, config) {
  try {
    const raw = BigInt(Math.floor(pos.tokens * 10 ** pos.decimals));
    if (raw > 0n) {
      const q = await quote(pos.mint, SOL_MINT, raw.toString(), config.honeypot.slippageBps);
      const sol = await solPriceUsd();
      if (q && !q.failed && sol) return { price: (Number(q.outAmount) / 1e9) * sol / pos.tokens, source: 'jupiter sell quote' };
    }
  } catch { /* fall through */ }
  return fallbackPriceUsd ? { price: fallbackPriceUsd, source: 'dexscreener' } : null;
}

export function sellPaper(state, pos, fraction, priceUsd, reason, config, { ofOriginal = false } = {}) {
  const fee = config.risk.paperFeePct / 100;
  const qty = Math.min(pos.tokens, ofOriginal ? pos.tokensOriginal * fraction : pos.tokens * fraction);
  const proceeds = qty * priceUsd * (1 - fee);
  pos.tokens -= qty;
  pos.realizedUsd += proceeds;
  state.cash += proceeds;
  pos.markUsd = pos.tokens * priceUsd;
  const fill = { at: new Date().toISOString(), id: pos.id, symbol: pos.symbol, qty, priceUsd, proceeds, reason };
  if (pos.tokens <= pos.tokensOriginal * 1e-6) {
    state.positions = state.positions.filter((p) => p !== pos);
    const pnlUsd = pos.realizedUsd - pos.sizeUsd;
    const trade = {
      id: pos.id, mint: pos.mint, symbol: pos.symbol, entryAt: pos.entryAt, exitAt: fill.at,
      entryPrice: pos.entryPrice, exitPrice: priceUsd, sizeUsd: pos.sizeUsd, riskUsd: pos.riskUsd,
      pnlUsd: +pnlUsd.toFixed(4), pnlPct: +((pnlUsd / pos.sizeUsd) * 100).toFixed(2),
      R: +(pnlUsd / pos.riskUsd).toFixed(2), exitReason: reason, score: pos.score, url: pos.url,
      ...(pos.source === 'manual' ? { source: 'manual' } : {}), // day 4: her own buys from the button menu, kept out of the bot's stats
    };
    state.closed.push(trade);
    return { fill, trade };
  }
  return { fill, trade: null };
}
