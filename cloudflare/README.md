# the desk on cloudflare (free plan)

the desk runs 24/7 on a Cloudflare Worker, no server, no bill.

```
telegram ──webhook──▶ worker (/tg) ──▶ Durable Object "Desk"
                                          │  alarm loop: every 3 s while a trade is open,
                                          │  small steps for scans (every 2 min) and near-miss re-checks
cron (every minute) ──▶ watchdog: restarts the alarm loop if it ever stopped
                                          │
                                   DexScreener · RugCheck · Jupiter (free APIs)
```

- **why a Durable Object alarm and not cron:** the free plan's fastest cron is once a minute. exits need seconds. a Durable Object can re-arm its own alarm every few seconds, so the cron is only the watchdog.
- **why small steps:** the free plan allows 50 outbound calls per invocation, so a scan is cut into steps (find coins, then deep-check 1-3 coins per step).
- **state:** all in the Durable Object's own storage (balance, trades, near misses, settings changed from Telegram). writes only happen when something changes, to stay inside the free plan's daily write budget.
- **secrets** (set with `npx wrangler secret put NAME`, never in the repo): `TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`, `TG_WEBHOOK_SECRET` (telegram sends it back on every webhook call, anything without it gets a 401), `ADMIN_KEY`.

## deploy

```bash
npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN      # paste, never echo
# point telegram at the worker (secret_token = TG_WEBHOOK_SECRET)
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d url=https://memecoin-desk.<you>.workers.dev/tg -d secret_token=$TG_WEBHOOK_SECRET
# start a 24h paper test
curl -s -X POST https://memecoin-desk.<you>.workers.dev/admin/init -H "x-admin-key: $ADMIN_KEY" -d '{"startTestHours":24}'
```

`GET /` is the live dashboard (read-only, refreshes itself), `GET /api/dash` its public json, `GET /health` a short status. no secrets, no chat ids, no controls on any of them.

note: while the webhook is set, the local node desk (`node src/run.js`) can't long-poll telegram. run it without `TELEGRAM_BOT_TOKEN` (alerts go to `logs/alerts.jsonl`) or delete the webhook first.
