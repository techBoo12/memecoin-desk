// ============================================================================
// QUALITY GATE (added day 3, techBoo: "it should not ape just any coin")
// Job: after the 8 kill rules and the analyst, one more desk check that only
//      lets QUALITY through. Every check is recorded with its number and the
//      line it had to clear, so every buy shows exactly why it passed and
//      every skip shows exactly why it was skipped (near-miss tracker).
// Checks: no unknowns on any rule · buy pressure on 1h AND 5m · live 5m
//         activity · price up on 5m AND 1h · holders rising between two of
//         our own looks · liquidity/mcap floor · not already pumped on 6h.
// HARD STOP: the gate never trades and never relaxes a kill rule. It can
//            only say no, with the reason.
// ============================================================================
const pctTxt = (x) => `${Math.round(x * 100)}%`;

export function qualityGate(c, f, a, config) {
  const q = config.quality || {};
  const checks = [];
  const add = (id, pass, value, need, note) => checks.push({ id, pass: Boolean(pass), value, need, note });

  if (q.requireNoUnknowns) add('no_unknowns', f.unknowns.length === 0, f.unknowns.length ? f.unknowns.join(',') : 'none', 'none', f.unknowns.length ? `unknown on ${f.unknowns.join(', ')}` : 'all 8 rules checked');

  const b1 = c.txns.h1.buys, s1 = c.txns.h1.sells, b5 = c.txns.m5.buys, s5 = c.txns.m5.sells;
  const share1h = b1 + s1 ? b1 / (b1 + s1) : 0;
  const share5m = b5 + s5 ? b5 / (b5 + s5) : 0;
  add('buys_1h', share1h >= q.minBuyShare1h, pctTxt(share1h), `>= ${pctTxt(q.minBuyShare1h)}`, `1h buys ${pctTxt(share1h)} of txns`);
  add('buys_5m', share5m >= q.minBuyShare5m, pctTxt(share5m), `>= ${pctTxt(q.minBuyShare5m)}`, `5m buys ${pctTxt(share5m)} of txns`);
  add('active_5m', b5 + s5 >= q.minTxns5m, b5 + s5, `>= ${q.minTxns5m}`, `${b5 + s5} txns in 5m`);

  if (q.requireUp5m) add('up_5m', c.change.m5 > 0, `${c.change.m5}%`, '> 0%', `5m ${c.change.m5 >= 0 ? '+' : ''}${c.change.m5}%`);
  if (q.requireUp1h) add('up_1h', c.change.h1 > 0, `${c.change.h1}%`, '> 0%', `1h ${c.change.h1 >= 0 ? '+' : ''}${c.change.h1}%`);

  if (q.requireHoldersRising) {
    const g = a.holderGrowthPerHourPct;
    add('holders_rising', g != null && g > 0, g == null ? 'first look' : `${g >= 0 ? '+' : ''}${g}%/h`, '> 0 between 2 looks',
      g == null ? `holders ${a.holders || '?'}, need a 2nd look ${q.minHolderLookGapSec}s+ later to prove they're rising` : `holders ${a.holders} (${g >= 0 ? '+' : ''}${g}%/h)`);
  }

  add('liq_mcap', a.liqMcap >= q.minLiqToMcap, pctTxt(a.liqMcap), `>= ${pctTxt(q.minLiqToMcap)}`, `liquidity is ${pctTxt(a.liqMcap)} of mcap`);
  add('not_pumped_6h', c.change.h6 <= q.maxPump6hPct, `${c.change.h6}%`, `<= +${q.maxPump6hPct}%`, `6h ${c.change.h6 >= 0 ? '+' : ''}${c.change.h6}%`);

  const failed = checks.filter((x) => !x.pass);
  return { ok: failed.length === 0, checks, failed, passedCount: checks.length - failed.length, total: checks.length };
}
