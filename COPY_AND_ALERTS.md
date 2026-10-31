# insider alerts + smart-wallet copy lane (Oct 31 2026, her "both")

Paper only. No wallet, no keys, no signing, no real money. Everything reads public on-chain data with her free Helius key.

## 1. insider alerts (Telegram)

What the insider lane already reads for every fresh pump.fun graduate (the dev's linked wallets, `cluster.js`) becomes one short alert:

- **loading**: the dev's linked wallets hold `alerts.crew_buy_pct` (20%) or more of the supply when the lane finishes tracing the coin.
- **dumping**: coins whose crew held `watch_min_pct` (10%)+ are re-read every `watch_every_s` (120 s) for `watch_minutes` (60): one `getMultipleAccounts` of the crew's token accounts (1 credit). A drop of `dump_drop_pts` (5 pts) from the peak, or `dump_drop_rel_pct` (30%) of it, fires one alert.
- coin symbol, short mint, what happened, % of supply, minutes after graduation, DexScreener link, and "linked = on-chain pattern, not proof".
- no spam: at most `max_per_hour` (6) an hour, one alert per coin per event (24 h memory). Held-back alerts are counted (`/alerts`).
- `/alerts on|off`, `/set insideralerts on|off`, or the 🚨 button on the home panel. Off also stops the dump re-reads (no credits).
- open insider trades keep their own E3/E4/E5 exit messages (unchanged).

## 2. smart-wallet copy lane (paper, own book)

**What "smart wallet" means here**: a statistical label read from a wallet's own recent trades. Past results on a small sample. Not proof of skill, not proof of inside information, and nothing about its next trade. It can be a bot, can be linked to a dev crew, can stop working tomorrow.

### the list (built OFF the worker, once a day, `tools/smart_wallets.mjs` on Tab's box)
1. every pump.fun migration of the last 2 days (pump.fun's migration account, Helius `getTransactionsForAddress`, full txs: 10 credits per 100). Spam "graduations" seeded with < 40 SOL are dropped.
2. winners: price went 5x+ over the migration price (peak from GeckoTerminal hourly candles, current from DexScreener; both free).
3. early buyers: wallets that bought each winner on PumpSwap in its first 10 minutes after graduation (the bot's own window): first page of the pool's txs (10 credits per winner).
4. candidates: early buyers seen in the most winners (up to 60).
5. score: each candidate's own last 7 days (one page, 200 txs, 20 credits): realized PnL per token (SOL in vs SOL out, fees included; a position counts only when 90%+ of what it bought inside the window was sold; bags bought before the window or moved out without selling are not scored), win rate, txs/day, median hold.
6. gate (guesses, `smart.js scoreWallet`): 5+ closed, win rate 40%+, realized 0.25 SOL+, at most 300 txs/day (bot-like + too costly to watch), median hold 0.5 min+ (same-block flippers are not copyable). score = pnl x (0.5 + win rate) x min(1, closed/10).
7. keep the best (max 30) that fit the daily webhook budget (sum of their txs/day <= 2500), push to the worker (`POST /admin/smart`), and point her ONE free Helius webhook (raw txs, success only) at `/hook/smart`.

### the signal (on the worker)
- every pushed tx is read for the listed wallets: one SOL-quoted buy or sell of one token. Buys under 0.1 SOL don't count.
- `copy.min_wallets` (2) DIFFERENT listed wallets buy the same coin on PumpSwap inside `copy.window_min` (15) -> one candidate per coin.
- the candidate goes through the same safety rules as the insider lane: pump.fun graduate (up to `copy.max_minutes_since_migration` 60 min old), R1 mint / R2 freeze + Token-2022 traps, R3 LP burned, R4 top 10, **R5 dev-crew cap**, **R6 liquidity floor**, R7 sell simulation, second opinions, known rugger, R11/R13 quote + fee caps. Copycat check (M1) is skipped for copy because the insider lane may have seen this very coin.
- paper buy in the copy book: its own $100 balance, ids `C001...`, trades labelled `strategy: copy`, max 3 open. The 14-day run's numbers (`desk.closed`, balance, daily report's main block, day-14 go/no-go) never see them. The daily report has its own copy block, `/smart` shows the list + copy stats.
- exits: the existing E1-E8 engine on the coin (copy book's own day-loss E1), plus **C1** (ours): when half or more of the wallets we copied have sold half their bag, sell. E1-E8 keep priority.

## Helius budget (free plan: 1,000,000 credits a month = ~33,000 a day)
All of it goes on ONE daily ledger in the worker (`S.pb.keyed`, cap 30,000/day, non-priority calls stop using the key at 80%):

| what | credits/day | how it's bounded |
|---|---|---|
| insider lane (existing) | ~24,000 (root's figure) | the ledger cap |
| list build (off-worker, once a day) | ~1,700-2,000 measured | `--budget` 2,500 hard stop; pushed credits are booked on the ledger |
| webhook pushes | = sum of the list's txs/day (first build: see report) | builder keeps the list under 2,500/day; worker deletes the webhook for the day past `copy.hook_budget_day` (2,500) |
| webhook create/update/delete | 100 each, ~100-200 | once a day |
| dump re-reads (alerts) | ~50-300 typical, <= 2,200 worst | max 6 watched coins, 3 reads per 2 min, 60 min each |
| copy candidates (safety trace) | ~30 per candidate, a few a day | needs 2+ listed wallets on one fresh coin |

Because the ledger is shared, copy + alerts spending pushes the insider lane to its 80% soft cap sooner (its non-priority reads then fall back to the free gateways, which refuse Cloudflare). If that bites, lower `copy.hook_budget_day` / the list size, or turn the copy lane off (`/set copyon off`).

## CPU per Worker run
- a webhook push: one raw tx (~5-15 KB JSON) per listed-wallet tx, a few array scans: well under 1 ms.
- dump re-read: one `getMultipleAccounts` (<= 60 accounts) per watched coin, <= 3 per alarm step.
- the heavy part (thousands of full txs, MBs of JSON) runs on Tab's box, never on the worker.

## run it
```
# daily, from Tab's box (key via the vault, never printed):
TAB_TASK_ID=<running task> ../with_helius.sh node tools/smart_wallets.mjs --days 2 --push --hook
```
