// ============================================================================
// FAST EXIT WATCHER (added day 3, after $CTO gapped from the -6% stop to
// -13.9% between two 15 s checks)
// Job: price every open trade every few seconds (default 3 s) from ONE cheap
//      batched call, so stops trigger close to where they sit. When a stop,
//      trail, take-profit or emergency fires, the FILL is priced at a real
//      Jupiter sell quote for the exact tokens we hold (what we'd actually
//      get), not at the pretty trigger price.
// Emergency exits: liquidity pulled (down X% from entry, or under a floor).
// Data: Jupiter price API (lite-api, free, one call for all open coins),
//       DexScreener for liquidity, Jupiter quote for the fill.
// HARD STOP: watches and reports prices only. The risk desk decides exits.
// ============================================================================
import { getJSON } from '../lib/http.js';

const JUP_PRICE = 'https://lite-api.jup.ag/price/v3';
const DS = 'https://api.dexscreener.com';

// mint -> usd price, one call for up to 50 coins. Falls back to DexScreener.
export async function fastPrices(mints) {
  const out = new Map();
  if (!mints.length) return out;
  const r = await getJSON(`${JUP_PRICE}?ids=${mints.join(',')}`, { minGapMs: 0, retries: 0, timeoutMs: 4000 });
  if (r.ok && r.data) for (const m of mints) { const v = Number(r.data[m]?.usdPrice); if (v > 0) out.set(m, { price: v, source: 'jupiter price' }); }
  const missing = mints.filter((m) => !out.has(m));
  if (missing.length) {
    const d = await liquidityNow(missing);
    for (const [m, x] of d) if (x.price > 0) out.set(m, { price: x.price, source: 'dexscreener' });
  }
  return out;
}

// mint -> { liq, price } from the deepest pair
export async function liquidityNow(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const r = await getJSON(`${DS}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { minGapMs: 0, retries: 1, timeoutMs: 5000 });
    for (const p of r.data || []) {
      const m = p.baseToken?.address; const liq = Number(p.liquidity?.usd) || 0;
      if (!out.has(m) || liq > out.get(m).liq) out.set(m, { liq, price: Number(p.priceUsd) || 0 });
    }
  }
  return out;
}

// emergency check: did someone pull the liquidity?
export function liquidityAlarm(pos, liqNow, cfg) {
  if (!cfg?.liqDropExitPct || !pos.entryLiq || liqNow == null) return null;
  const dropPct = (1 - liqNow / pos.entryLiq) * 100;
  if (dropPct >= cfg.liqDropExitPct) return `emergency: liquidity down ${dropPct.toFixed(0)}% since entry ($${Math.round(pos.entryLiq / 1000)}k -> $${Math.round(liqNow / 1000)}k)`;
  if (liqNow < cfg.minLiqExitUsd) return `emergency: liquidity $${Math.round(liqNow / 1000)}k, under the $${Math.round(cfg.minLiqExitUsd / 1000)}k floor`;
  return null;
}
