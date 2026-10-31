#!/usr/bin/env python3
"""
HYPE LANE BACKTEST: $TRUMP (Jan 18 2025) and $MELANIA (Jan 19-20 2025), the viral coins we could identify with free price history.
Prices: DefiLlama coins API (free), hourly. First point it has: 2025-01-18 04:00 UTC (the Meteora DLMM pools
were created 02:01 UTC per DexScreener; Trump's tweet 02:44 UTC per X's own tweet record).
Exits: the hype lane's own numbers from config.json (stop, trail, TP ladder, max hold), quarter size (big-name exception).
LIMITS (said out loud): hourly closes only, so intra-hour wicks are invisible (a real stop could fill worse or better);
no historical volume/liquidity/holder data for the entry gate; no archive of trending lists, so WHEN the scanner
would have flagged it is an assumption (entries tried at several delays).
Run: python3 hype/backtest_viral.py [TRUMP|MELANIA]
"""
import json, os, sys, requests
from datetime import datetime, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(HERE, "..", "config.json")))["hype"]
COINS = {"TRUMP": ("6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", datetime(2025, 1, 18, 2, tzinfo=timezone.utc)),
         "MELANIA": ("FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P", datetime(2025, 1, 19, 21, tzinfo=timezone.utc))}
pts = []

def sim(entry_i):
    t0, e = pts[entry_i]; size = cfg["position_usd"] * cfg["big_name"]["size_frac"]
    tokens = size / e; orig = tokens; cash = 0.0; stop = e * (1 - cfg["stop_loss_pct"] / 100); peak = e; trailing = False; done = set(); log = []
    for t, p in pts[entry_i + 1:]:
        if t - t0 > cfg["max_hold_hours"] * 3600:
            cash += tokens * p; log.append((t, p, "max hold", tokens)); tokens = 0; break
        peak = max(peak, p)
        if p <= stop:
            cash += tokens * p; log.append((t, p, "trailing stop" if trailing else "stop", tokens)); tokens = 0; break
        if not trailing and p >= e * (1 + cfg["trail_activate_pct"] / 100): trailing = True
        if trailing: stop = max(stop, peak * (1 - cfg["trail_distance_pct"] / 100))
        for st in cfg["tp_ladder"]:
            if st["atMultiple"] not in done and p >= e * st["atMultiple"]:
                done.add(st["atMultiple"]); q = min(tokens, orig * st["sellPct"] / 100); cash += q * p; tokens -= q; log.append((t, p, f"TP {st['atMultiple']}x", q))
    if tokens: cash += tokens * pts[-1][1]; log.append((pts[-1][0], pts[-1][1], "still open at end of data", tokens))
    return size, cash, log

def load(sym):
    mint, start = COINS[sym]
    r = requests.get(f"https://coins.llama.fi/chart/solana:{mint}?start={int(start.timestamp())}&span=96&period=1h&searchWidth=600", timeout=30)
    return [(p["timestamp"], p["price"]) for p in r.json()["coins"][f"solana:{mint}"]["prices"]]

fmt = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%b %d %H:%M")
for sym in (sys.argv[1:] or COINS):
  pts[:] = load(sym)
  print(f"\n===== ${sym} =====")
  print(f"${sym} hourly prices {fmt(pts[0][0])} .. {fmt(pts[-1][0])} utc: first ${pts[0][1]}, peak ${max(p for _, p in pts)} ({max(p for _, p in pts)/pts[0][1]:.1f}x the first price)")
  for delay_h in (0, 2, 6, 12, 24):
    i = min(range(len(pts)), key=lambda k: abs(pts[k][0] - (pts[0][0] + delay_h * 3600)))
    size, cash, log = sim(i)
    print(f"\nentry {fmt(pts[i][0])} utc @ ${pts[i][1]} (first price +{delay_h}h): ${size:.2f} paper -> ${cash:.2f} ({(cash/size-1)*100:+.0f}%)")
    for t, p, why, q in log: print(f"   {fmt(t)}  ${p:<7} {why}  ({q/ (size/pts[i][1]) * 100:.0f}% of the bag)")
