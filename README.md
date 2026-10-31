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
- **live dashboard:** https://memecoin-desk.adaikemmartilda.workers.dev — balance over time, every trade with why in and why out, open trades, near misses with what they did after, the 24h test countdown. read-only, no secrets

```bash
node src/run.js 25 --test 24   # local: run 25 min and start a 24h test window
node --test test/*.test.js     # no network needed
```

## day 4: the button menu (tap instead of type)

trojan-style panel in telegram, own branding, still paper money only.

- **🏠 home panel:** balance, today p/l, open positions, desk running/paused, auto-buy on/off. one message, edited in place, not a new message per tap
- **🟢 buy:** paste a solana token address. the desk runs the same checks it runs on its own picks (8 kill rules, jupiter sell test, score, quality gate) and shows the card. then `$5` `$10` `$25` `custom`. failed safety = an extra "buy anyway (paper)" tap. fills at a live jupiter quote for the exact amount
- **🔴 sell / 📂 positions:** a card per position (entry, now, p/l %, R, stop, next take profit) with `25%` `50%` `100%`. partial sells count what was already sold + what's left
- **manual trades are tagged `manual`** and kept out of the bot's own stats (win rate, R, daily trade cap, loss-streak cooldown). the desk's stop / trail / take profit still protect them
- **⚙️ settings:** tap ➖ ➕ for stop, take profit, trailing, min score, trades/day, max open, slippage; toggles for auto-buy and alerts (all / trades only). same safe ranges as `/set`. mode is not on the list: paper stays paper
- **👀 near misses · 📋 report · ⏸ pause/resume · 🔄 refresh** on buttons too. every old command still works, plus `/menu`
- **owner lock on every tap:** anyone else tapping a button gets "this desk is private", nothing runs. old buttons get a fresh panel, not an error

```bash
node --test test/*.test.js                 # 23 tests, telegram + market faked
npx wrangler dev                           # the worker in cloudflare's runtime, locally
node test/local/menu_run.mjs seed.json     # drives the whole menu against a FAKE telegram (no token)
```

## free data only

dexscreener · rugcheck · jupiter quotes · geckoterminal. no paid APIs, no server bill.

## roadmap

- [x] day 1: the brain, paper mode, live coins
- [x] day 2: telegram bot, owner lock, alerts, /status, /pause, /set
- [x] day 4: button menu: buy / sell / positions / settings / pause, owner lock on every tap
- [x] day 3: quality filter, 3 s exits, near-miss tracker, trade reasons, 24/7 on cloudflare (free)
- [x] live dashboard (public, read-only)
- [ ] 1-2 weeks of paper trading, judged on 20+ trades
- [ ] live, only with a small burner wallet. never my main keys.


## day 5: the training pack (insider-exit lane)

A second lane trained on "Building a DeFi degen bot · training pack": it only looks at fresh pump.fun graduates (≤ 10 min after migration), maps the dev's wallet cluster from the chain (funding trail, same slot / same Jito bundle, direct transfers, fresh wallets, shared funders), skips anything where the cluster or top 10 hold too much, and once in, watches the cluster every second and sells the moment the dev or the cluster starts dumping (exits E1-E8). Every token it sees is labelled RUG / PUMP / DIED / FLAT an hour and a day later, so the bot builds its own training data.

- paper only, reads only, no keys. all numbers are the pack's starting guesses (`config.json → playbook`)
- `/insider` in Telegram: skips by rule, trades, labels, go/no-go for real money
- full map of the pack to the code, and what isn't buildable for free: [TRAINING_PACK.md](TRAINING_PACK.md)
- backtest on MELT launches: `backtest/` (results in `backtest/MELT_RESULTS.md`)
- tests: `npm test` (66)
