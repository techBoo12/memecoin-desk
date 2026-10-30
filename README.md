# memecoin desk

a solana memecoin trading desk that thinks like a team, not a gambler.
built by techBoo with Tab.

> **PAPER MODE ONLY.** fake $100, real coins, real prices. no wallet, no keys, no real trades.
> not financial advice. memecoins are mostly rugs. this repo is me learning in public.

## the desk

```
scout ─▶ filter (8 kill rules) ─▶ sell test ─▶ analyst (0-100)
                                                    │
        logger ◀── paper executor ◀── HEAD OF DESK ◀┘ (approve / veto)
                         ▲
                     risk desk (stops, trail, take profit, freezes)
```

| role | job | hard stop |
|---|---|---|
| scout | finds solana pairs 30m-72h old, $300k-$20M mcap (pumpswap + raydium) | never judges or trades |
| filter | 8 kill rules, one hit = dead, every kill logged with why | can't rescue a coin |
| sell test | jupiter buy quote + sell quote round trip, token traps | quotes only, no transactions |
| analyst | score 0-100, only 70+ moves on, no buying a falling chart | never sizes or trades |
| risk desk | sizes by risk, -6% stop before entry, trail after +12%, tp ladder | never widens a stop |
| head of desk | approves or vetoes every trade, writes the daily report | **never trades** |
| executor | paper fills at real jupiter quotes | paper only, no keys in the code |
| logger | logs every scan, kill, score, no-trade, buy and sell | never decides |

rule #1: **protect the balance first, profit second.**

## the 8 kill rules

1. mint or freeze authority not revoked
2. LP not burned/locked
3. liquidity under $40k
4. 1h volume under $50k
5. top 10 holders over 25%
6. dev holds over 3%, or flagged for past rugs
7. bundled launch over 10% (proxy: linked-wallet clusters)
8. already +80% in the last hour

if a rule can't be checked with free data, the log says **unknown**. it never pretends.

## run it

```bash
node src/run.js 25     # run the desk for 25 minutes (node 18+, no installs)
```

every setting lives in [`config.json`](config.json) (soon editable from telegram).
logs land in `logs/`: `console.log`, `trades.csv`, `events.jsonl`, and the head of desk's daily report.
why each rule exists and where it lives in the code: [`RULES.md`](RULES.md).

## free data only

dexscreener · rugcheck · jupiter quotes · geckoterminal. no paid APIs, no server bill.

## roadmap

- [x] day 1: the brain, paper mode, live coins
- [ ] telegram bot: alerts, /status, settings, approve/skip buttons
- [ ] cloudflare workers cron (free) + dashboard
- [ ] 1-2 weeks of paper trading, judged on 20+ trades
- [ ] live, only with a small burner wallet. never my main keys.
