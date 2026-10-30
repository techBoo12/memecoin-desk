// ============================================================================
// HONEYPOT / SELL TEST
// Job: prove we could get OUT before we ever get in. Asks Jupiter for a buy
//      quote (SOL -> coin) and then a sell quote for exactly what we'd get
//      back (coin -> SOL). No route, a huge round-trip loss, or token-2022
//      traps (transfer fee, transfer hook, permanent delegate, pausable,
//      frozen-by-default) = dead.
// Data: Jupiter free quote API (lite-api.jup.ag) + the rugcheck report.
// HARD STOP: quotes only. No wallet, no signature, no transaction, ever.
// ============================================================================
import { getJSON, SOL_MINT } from '../lib/http.js';

const JUP = 'https://lite-api.jup.ag/swap/v1/quote';
let solCache = { at: 0, usd: 0 };

export async function solPriceUsd() {
  if (Date.now() - solCache.at < 60_000 && solCache.usd) return solCache.usd;
  const r = await getJSON(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const v = Number(r.data?.[SOL_MINT]?.usdPrice);
  if (v) solCache = { at: Date.now(), usd: v };
  return solCache.usd;
}

export async function quote(inputMint, outputMint, amount, slippageBps) {
  const r = await getJSON(`${JUP}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`, { minGapMs: 1100, retries: 3 });
  if (r.ok && r.data?.outAmount) return r.data;
  // 4xx from Jupiter = it looked and found no route. 0/429/5xx = the API itself failed.
  return { failed: r.status >= 400 && r.status < 500 && r.status !== 429 ? 'no_route' : 'api_error' };
}

export async function honeypotCheck(candidate, rc, { config }) {
  const cfg = config.honeypot;
  const ext = rc?.token_extensions || {};
  const traps = [];
  if ((rc?.transferFee?.pct || 0) > 0) traps.push(`transfer fee ${rc.transferFee.pct}%`);
  if (ext.transferHook) traps.push('transfer hook');
  if (ext.permanentDelegate) traps.push('permanent delegate');
  if (ext.pausableConfig) traps.push('pausable');
  if (ext.nonTransferable) traps.push('non-transferable');
  if (ext.defaultAccountState && /frozen/i.test(JSON.stringify(ext.defaultAccountState))) traps.push('frozen by default');
  if (traps.length) return { ok: false, reason: `token trap: ${traps.join(', ')}` };

  const sol = await solPriceUsd();
  if (!sol) return { ok: false, reason: 'no SOL price, cannot size the test', unknown: true };
  const lamports = Math.round((cfg.testSizeUsd / sol) * 1e9);

  const buy = await quote(SOL_MINT, candidate.mint, lamports, cfg.slippageBps);
  if (buy.failed === 'api_error') return { ok: false, unknown: true, reason: 'sell test could not run (quote API busy), skipped' };
  if (buy.failed) return { ok: false, reason: 'no buy route on Jupiter' };
  const sell = await quote(candidate.mint, SOL_MINT, buy.outAmount, cfg.slippageBps);
  if (sell.failed === 'api_error') return { ok: false, unknown: true, reason: 'sell test could not run (quote API busy), skipped' };
  if (sell.failed) return { ok: false, reason: 'CAN\'T SELL: no sell route (honeypot?)' };

  const back = Number(sell.outAmount);
  const roundTripLossPct = (1 - back / lamports) * 100;
  const impactPct = Math.max(Number(buy.priceImpactPct) || 0, Number(sell.priceImpactPct) || 0) * 100;
  const out = {
    testUsd: cfg.testSizeUsd,
    roundTripLossPct: +roundTripLossPct.toFixed(2),
    impactPct: +impactPct.toFixed(2),
    decimals: rc?.token?.decimals ?? 6,
    route: buy.routePlan?.map((r) => r.swapInfo?.label).join(' > '),
    // effective entry price incl. pool fees + impact: what a real fill would look like
    fillPriceUsd: (lamports / 1e9) * sol / (Number(buy.outAmount) / 10 ** (rc?.token?.decimals ?? 6)),
  };
  if (roundTripLossPct > cfg.maxRoundTripLossPct) return { ok: false, reason: `sell tax/loss ${out.roundTripLossPct}% on a $${cfg.testSizeUsd} round trip`, ...out };
  if (impactPct > cfg.maxPriceImpactPct) return { ok: false, reason: `price impact ${out.impactPct}% too high`, ...out };
  return { ok: true, ...out };
}
