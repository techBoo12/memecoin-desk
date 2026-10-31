# hype lane (day 6, paper)

Her ask (voice note Oct 31 2026 8:03 AM Lagos): catch "popularity coins" early ($TRUMP, a viral giraffe coin, an NBA
meme coin), watch Meteora launches too, scan meme/crypto social every day, and don't auto-miss a real big coin
just because its team holds a lot.

## how it works

1. `hype/hype_scanner.py` runs on any box (python3 + requests), NOT on Cloudflare. Every few minutes it:
   - reads culture trends: Google Trends (6 countries), Wikipedia top pages, Reddit (1 sub per scan), 4chan /biz/, Bluesky;
   - reads crypto attention: DexScreener boosts/profiles/takeovers, Jupiter trending + organic + brand-new tokens,
     GeckoTerminal trending/new pools (best effort), CoinGecko + CMC most-searched;
   - reads fresh coins: pump.fun (via Jupiter/DexScreener/GeckoTerminal), Meteora DAMM v2 + DLMM newest pools (Meteora's own API),
     Meteora bonding-curve launches (Jupiter `recent`, launchpad met-dbc);
   - matches coin name/ticker to trending phrases + cashtag mentions; reads the coin's own tweet when its X link is a tweet;
   - scores 0-100: trend (30) + social (15) + attention (20) + tweet (20) + market (15). Flags `early` (talked about off-crypto,
     not yet on crypto lists) and `bigName` (a Government/Business-badge or 20k-like tweet that names THIS coin's cashtag,
     or huge trading: 1h vol >= $1M and liq >= $500k with score >= 40);
   - POSTs the top 20 to the worker: `POST /admin/hype` (header x-admin-key).
2. The worker's hype lane (`src/hype/lane.js`) takes `high` (score >= 45) or `bigName` coins, at most one check a minute,
   re-checks LIVE: DexScreener pair, liquidity >= $30k, 1h volume >= $20k, mint + freeze revoked, no rug flag, top10 <= 35%,
   insiders <= 20%, dev <= 5%, LP locked >= 90% (pump.fun graduations: burned by protocol), Jupiter buy+sell quote round trip
   <= 10% (can sell = not a honeypot). Safety data from RugCheck, else Jupiter's token audit.
3. BIG-NAME EXCEPTION: when only the holder/LP caps fail, a coin with bigName (or score >= 60) AND 1h vol >= $1M AND
   liq >= $500k may pass with caps of 90% at a QUARTER size. Logged `BIG-NAME EXCEPTION` with the numbers, counted in /hype.
   Mint/freeze authority, rug flags, can't-sell and the liquidity floor are never waived.
4. Paper buy: $5 (quarter = $1.25) from its OWN $100 book (`S.hype.book`, trades `lane: 'hype'`, ids H001...).
   Exits: stop -25%, trail on at +40% (25% under the peak), TP 30% at 2x and 30% at 5x, liquidity pulled 50% -> out,
   max hold 48 h. All starting guesses, in `config.json` -> `hype`.
5. Never in the 14-day test numbers (the desk balance is not touched). /hype in Telegram, and its own block in the daily report.

Settings (Telegram /set): `hypeon`, `hypebig` (big-name exception), `hypesize`, `meteora` (desk A also scans Meteora pairs;
OFF by default so the running 14-day test keeps the same coin universe).

## run

    cd memecoin-desk
    python3 hype/hype_scanner.py                    # one scan, prints the list, no push
    python3 hype/hype_scanner.py --push             # one scan + push to the worker
    python3 hype/hype_scanner.py --loop 5 --push    # every 5 min, foreground
    python3 hype/backtest_viral.py                  # the $TRUMP + $MELANIA backtest (hype/BACKTEST.md)

Suggested interval: 5 min (the worker ignores a watchlist older than 30 min, so the lane simply waits if the scanner stops).
Admin key: env HYPE_ADMIN_KEY, else `state/cloudflare.json` (gitignored). Never printed.

## cost

- Helius: 0 calls. Nothing in the scanner or the hype lane uses her Helius key.
- Scanner per scan: ~35-50 HTTP calls (15 of them single-tweet reads), ~17 s wall, ~1-2 s CPU on this box.
  Every 5 min = 288 scans/day, ~12k free calls/day spread over ~12 hosts.
- Worker: 288 small admin POSTs/day; at most 1 hype check a minute while the watchlist is fresh (DexScreener 1, RugCheck 1,
  Jupiter 1-3 calls); while a hype trade is open, one DexScreener call every 10 s. CPU not yet measured on Cloudflare:
  check with cf_tail.sh after deploy (the biggest cost is parsing one RugCheck report, ~100 KB, when RugCheck answers).
