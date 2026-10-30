// ============================================================================
// ANALYST
// Job: score every survivor 0-100. Only 80+ moves on (was 70 until day 3). Also reads the tape:
//      no buying into a falling 5m/1h chart (wait for confirmation).
// Data: DexScreener pair stats + rugcheck holder count (+ holder growth seen
//       across scans; the history lives in the desk state so it survives
//       restarts and works on Cloudflare too).
// HARD STOP: the analyst never sizes, never trades, never overrides the
//            filter. A high score on a killed coin does not exist.
// NOT SCORED (honest): true unique buyers (DexScreener gives txn counts, not
//            wallets) and smart-wallet tracking (needs wallet data, later).
// ============================================================================
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const localHistory = {}; // fallback when no desk state is passed in

export function analyze(c, rc, { config, holderHistory = localHistory, now = Date.now() }) {
  const parts = {};
  // 1. momentum (25): healthy climb, not a vertical candle
  parts.momentum = c.change.h1 <= 0 ? 0 : clamp(c.change.h1 / 40) * 15 + (c.change.m5 > 0 ? clamp(c.change.m5 / 5) * 10 : 0);
  // 2. buy pressure (20): share of 1h txns that are buys
  const b = c.txns.h1.buys, s = c.txns.h1.sells;
  const buyShare = b + s ? b / (b + s) : 0;
  parts.buyPressure = clamp((buyShare - 0.5) / 0.15) * 20;
  // 3. activity (15): 1h txn count (proxy for unique buyers), log scale 200..3000
  parts.activity = clamp(Math.log(Math.max(b + s, 1) / 200) / Math.log(15)) * 15;
  // 4. turnover (15): 1h volume vs liquidity
  const turnover = c.liqUsd ? c.vol.h1 / c.liqUsd : 0;
  parts.turnover = clamp((turnover - 0.5) / 2.5) * 15;
  // 5. liq/mcap (15): enough liquidity behind the price to actually exit
  const lm = c.mcap ? c.liqUsd / c.mcap : 0;
  parts.liqMcap = lm < 0.03 ? 0 : lm < 0.06 ? ((lm - 0.03) / 0.03) * 15 : lm <= 0.3 ? 15 : 10;
  // 6. holders (10): base size + growth between our own scans
  const holders = Number(rc?.totalHolders) || 0;
  parts.holders = clamp(Math.log(Math.max(holders, 1) / 500) / Math.log(10)) * 6;
  const hist = holderHistory[c.mint] || [];
  const last = hist[hist.length - 1];
  if (holders && (!last || last.holders !== holders || now - last.at > 60_000)) hist.push({ at: now, holders });
  holderHistory[c.mint] = hist.slice(-12);
  // growth between the oldest look in the last hour and now (needs 2 looks, gap >= minHolderLookGapSec)
  let growthPerHour = null;
  const gapMs = (config.quality?.minHolderLookGapSec ?? 108) * 1000;
  const recent = hist.filter((h) => now - h.at < 3.6e6);
  if (recent.length >= 2) {
    const a = recent[0], z = recent[recent.length - 1];
    if (z.at - a.at >= gapMs) growthPerHour = ((z.holders - a.holders) / Math.max(a.holders, 1)) * 100 / ((z.at - a.at) / 3.6e6);
  }
  parts.holders += growthPerHour == null ? 2 : clamp(growthPerHour / 10) * 4;

  const score = Math.round(Object.values(parts).reduce((x, y) => x + y, 0));
  const tape = { m5: c.change.m5, h1: c.change.h1 };
  const falling = c.change.m5 < 0 || c.change.h1 < 0;
  return {
    score,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(1)])),
    buyShare: +buyShare.toFixed(2), turnover: +turnover.toFixed(2), liqMcap: +lm.toFixed(3), holders,
    holderGrowthPerHourPct: growthPerHour == null ? null : +growthPerHour.toFixed(2),
    passes: score >= config.analyst.passScore,
    tapeOk: !(config.analyst.requireUptrend && falling),
    tape,
  };
}
