# RULES.md: every rule, where it came from, where it lives

Sources: the "memecoin desk" article by @A_Pirate_I (the desk roles), Van Tharp (*Trade Your Way to Financial Freedom*), Mark Douglas (*Trading in the Zone*), Jack Schwager (*Market Wizards*), Edwin Lefèvre (*Reminiscences of a Stock Operator*). These are the ideas turned into code, not quotes.

| rule | source | in the code |
|---|---|---|
| protect the balance first, profit second | desk article | `config.json` `topRule`; `src/desk/head.js` header |
| desk is split into roles, each with a job and a hard stop line | desk article | header comment of every file in `src/desk/` |
| head of desk approves/vetoes and never trades | desk article | `src/desk/head.js` `review()` (imports no executor) |
| one daily report | desk article | `src/desk/head.js` `dailyReport()` → `logs/report-<day>.md` |
| "no trade" is a real decision and is logged | desk article | `src/run.js` `no_trade` events |
| weekly goal + weekly max drawdown + daily loss limit | desk article | `config.json` `account`; `src/desk/risk.js` `riskStatus()` |
| paper first, human signs before live, no keys | desk article | `config.json` `mode`; `src/desk/executor.js` throws if not paper |
| 8 kill rules, one hit = dead | desk article | `src/desk/filter.js` `KILL_RULES` |
| unknown is said out loud, never faked | desk article (honesty) | `src/desk/filter.js` `unknown()`; `config.json` `filter.unknownIsKill` |
| prove the exit before the entry (sell test) | desk article | `src/desk/honeypot.js` `honeypotCheck()` |
| size by risk: risk 0.5% of equity, size = risk / stop distance, cap 8% | Van Tharp | `src/desk/risk.js` `sizeTrade()` |
| every trade logs its R-multiple | Van Tharp | `src/desk/executor.js` `sellPaper()` (`R`) |
| expectancy = average R per trade, in the report | Van Tharp | `src/desk/head.js` `stats()` |
| think in probabilities: judge the system on 20+ trades, not one | Trading in the Zone | `src/desk/head.js` `dailyReport()` sample-size line |
| no revenge trades: cooldown after 2 losses in a row | Trading in the Zone | `src/desk/risk.js` `afterClose()`; `config.json` `risk.cooldownMin` |
| no re-entry on a coin that just stopped you out | Trading in the Zone | `src/desk/risk.js` `afterClose()` `noReentry`; `head.js` |
| cut losers fast: -6% stop set before entry | Market Wizards | `src/desk/executor.js` `openPaper()` `stopPrice` |
| never widen a stop (code throws if you try) | Market Wizards | `src/desk/risk.js` `raiseStop()` |
| let winners run: trail after +12%, ladder 30% at 2x, 30% at 5x, rest rides | Market Wizards | `src/desk/risk.js` `manage()` |
| trade with the tape: no buys into a falling 5m or 1h | Reminiscences | `src/desk/analyst.js` `tapeOk`; `head.js` veto |
| don't chase: already +80% in 1h is dead | Reminiscences | `src/desk/filter.js` rule 8 |

## honest limits (free data)

- **rule 6, past rugs:** only RugCheck's own creator-history flag. A full dev wallet history needs paid/RPC data.
- **rule 7, bundled launch:** a proxy. RugCheck's linked-wallet clusters + insider-tagged holders. Real launch-block bundle detection needs transaction history.
- **unique buyers:** DexScreener gives transaction counts, not wallets. The analyst uses txn counts as a proxy.
- **holder growth:** measured between our own scans only (needs the desk to have seen the coin before).
- **smart wallets:** not scored yet.
- **sell test:** a quote round trip proves a route exists and shows the tax/impact. It can't catch a contract that changes after we buy.
- **exits are checked every 15 s**, not tick by tick. A real stop can fill worse in a fast dump.

## ideas worth adding later

1. **rug dev blacklist:** remember the creator wallet of every coin that rugs and auto-kill their next launch.
2. **fake volume detector:** flag pairs where a few wallets ping-pong most of the volume (needs trade-level data, e.g. Birdeye free tier).
3. **"why I lost" review:** after each losing trade, the head of desk writes which rule or score part failed, and a weekly tune-up from the logs.
4. **sell test re-run before every exit**, and a second check 60 s after entry (catches tax switched on after launch).
5. **narrative tags** (AI, cats, politics, Nigeria memes) on every pick, so the stats show which narratives actually pay.
