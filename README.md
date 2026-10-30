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
| analyst | score 0-100, only 80+ moves on, no buying a falling chart | never sizes or trades |
| quality gate | 9 more checks: buy pressure, trend 5m+1h, rising holders, liq/mcap, not pumped | can only say no |
| near-miss tracker | logs every coin it almost bought + what it did after | never trades |
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

every setting lives in [`config.json`](config.json). the safe ones are editable from telegram.
logs land in `logs/`: `console.log`, `trades.csv`, `events.jsonl`, and the head of desk's daily report.
why each rule exists and where it lives in the code: [`RULES.md`](RULES.md).

## telegram (the desk's phone line)

```bash
TELEGRAM_BOT_TOKEN=... node src/run.js 25   # token from @BotFather, env only, never in a file
node --test test/*.test.js                   # owner lock + commands, telegram faked
```

- **locked to one owner.** first boot prints a one-time code. the first private chat that sends `/start CODE` owns the desk and the code burns. everyone else gets "this desk is private" and nothing else.
- **commands (owner only):** `/status` `/pause` `/resume` `/report` `/settings` `/set <key> <value>` `/help`
- **/set only takes whitelisted keys with safe ranges** (max per trade, risk per trade, stop, trailing, min score, daily loss limit, max open trades, min liq, min volume, scan speed, scan alerts). mode is not on the list: paper stays paper.
- **alerts:** every scan summary, every 70+ pick with the head of desk's call, every paper buy and sell with p/l and R, stop-outs, "no revenge trade" vetoes, cooldowns, the daily loss freeze, the daily report. also written to `logs/alerts.jsonl`.
- locally: long polling. on cloudflare: a webhook with a secret header. commands also: `/trades` `/nearmiss`.

## day 3: quality over quantity, fast exits, near misses, 24/7

- **stricter picks:** score 80+, all 8 rules checked with zero unknowns, buy pressure on 1h and 5m, chart up on 5m and 1h, holders rising between two looks, liquidity 8%+ of mcap, not already pumped, max 4 trades a day, 2 open at once. why: [`RULES.md`](RULES.md)
- **fast exits:** open trades checked every 3 s (was 15 s), fills at a real jupiter sell quote, emergency exit if liquidity gets pulled
- **near-miss tracker:** every coin it almost bought, with the exact reason, re-checked at +15m/+1h/+4h/+24h. are the rules too strict, or saving us?
- **a reason on every trade:** why in (score parts, rules, quality checks, sell test), why out (stop, trail, tp, emergency)
- **24/7 on cloudflare's free plan:** worker + durable object alarm loop + telegram webhook. see [`cloudflare/README.md`](cloudflare/README.md)

```bash
node src/run.js 25 --test 24   # local: run 25 min and start a 24h test window
node --test test/*.test.js     # no network needed
```

## free data only

dexscreener · rugcheck · jupiter quotes · geckoterminal. no paid APIs, no server bill.

## roadmap

- [x] day 1: the brain, paper mode, live coins
- [x] day 2: telegram bot, owner lock, alerts, /status, /pause, /set
- [ ] approve/skip buttons + panic button
- [x] day 3: quality filter, 3 s exits, near-miss tracker, trade reasons, 24/7 on cloudflare (free)
- [ ] dashboard
- [ ] 1-2 weeks of paper trading, judged on 20+ trades
- [ ] live, only with a small burner wallet. never my main keys.
