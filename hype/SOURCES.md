# hype lane: which free sources work (tested from Tab's box, Oct 31 2026 07:05-07:25 UTC)

Status = what curl / the scanner got back. Latency = one request. "Limit" = what we saw, not a documented promise.

## works, used by hype/hype_scanner.py

| source | what it gives | status | latency | limit seen |
|---|---|---|---|---|
| Google Trends RSS `trends.google.com/trending/rss?geo=XX` (US GB NG CA AU IN) | today's ~10 top searches per country + traffic | 200 | 50-130 ms | none in 4 quick calls |
| Wikipedia top pageviews (yesterday) | top 1000 articles: celebrity / news moments | 200 | 120 ms | none |
| Reddit RSS `reddit.com/r/<sub>/new/.rss` | newest post titles | 200 once, then 429 | 700 ms | ~1 call per few minutes per IP: the scanner reads ONE sub per scan, rotating 5 subs |
| 4chan /biz/ catalog JSON | every live thread subject + opening post | 200 | 70 ms | none |
| Bluesky `api.bsky.app/xrpc/app.bsky.feed.searchPosts` | latest posts for a query | 200 | 70-180 ms | none (public.api.bsky.app answers 403) |
| DexScreener token-boosts latest/top, token-profiles, community-takeovers | coins paying for attention, fresh profiles with links + description | 200 | 20-90 ms | 60/min documented |
| DexScreener `tokens/v1/solana/<30 mints>` | live liquidity, volume, socials | 200 | 110-190 ms | 300/min documented |
| Jupiter lite-api tokens v2 `toptrending/5m,1h`, `toporganicscore/1h`, `recent`, `search` | trending + brand-new tokens (launchpad incl. `met-dbc` = Meteora bonding curve), holders, organic score, AUDIT (mint/freeze, top holders %) | 200 | 30-170 ms | 429 after ~5 quick calls: 1.3 s gaps |
| Meteora data API `damm-v2.datapi.meteora.ag/pools?sort_by=pool_created_at:desc` | newest DAMM v2 pools (where DBC launches graduate) with holders, TVL, volume | 200 | 750-950 ms | 20 quick calls all 200 |
| Meteora data API `dlmm.datapi.meteora.ag/pools?sort_by=pool_created_at:desc` | newest DLMM pools ($TRUMP launched on DLMM) | 200 | 600-750 ms | none |
| Meteora data API `dbc.datapi.meteora.ag/pools` | bonding-curve launches (1.8M), but no symbols/names in the list | 200 | 330 ms | not used: jup `recent` covers them with names |
| CoinGecko `search/trending` | top 15 searched coins + categories (all chains) | 200 | 70 ms | ~5-15/min public |
| CoinMarketCap `data-api/v3/topsearch/rank` | most searched coins | 200 | 60 ms | unknown |
| X: ONE tweet by id `cdn.syndication.twimg.com/tweet-result?id=<id>&token=a` | likes, time, author, badge (Government / Business / blue), cashtags | 200 | 160-240 ms | 8 quick calls all 200 |
| GeckoTerminal trending_pools / new_pools | trending + newest pools by dex (meteora, meteora-dbc, meteora-damm-v2, pump-fun) | 200 at first, then 429 every scan | 100 ms | 30/min documented; the desk itself also uses it. best effort only |
| DefiLlama `coins.llama.fi/chart/solana:<mint>` | hourly price history, old coins included | 200 | <1 s | none seen. used by the backtest |

## does NOT work for free from here

| source | what happened |
|---|---|
| X / Twitter search or timelines | official API is paid. nitter.net: shut down after X's cease-and-desist (its own page says so); other nitter mirrors dead or bot-walled; xcancel 451; syndication timeline `syndication.twitter.com/srv/timeline-profile` 429 on every try; r.jina.ai of x.com lands on the login wall; sotwe / twstalker Cloudflare-walled. Only single tweets by id work (above). Her own X account was NOT used. |
| TikTok trends | Creative Center API answers `{"code":40101,"msg":"no permission"}`; the page itself is JS-only. Not used. |
| pump.fun frontend API (king-of-the-hill, currently-live, metas) | 403 Cloudflare challenge ("Just a moment...") for every endpoint |
| Reddit JSON (`/hot.json`, old.reddit, api.reddit.com) | 403 blocked (RSS works, see above) |
| RugCheck `api.rugcheck.xyz/v1/tokens/<mint>/report` | 400 "unable to generate report" for EVERY coin we asked at 07:17-07:20 UTC, $TRUMP included (also /report/summary). The hype lane falls back to Jupiter's audit. NOTE: the desk's own filter uses RugCheck too; if this lasts, desk A's rules see "unknown" and skip. |
| Birdeye trending, LunarCrush | 401 (key required) |
| GDELT news API | 429 after 12 s ("one every 5 seconds") |
| GeckoTerminal OHLCV older than 180 days | 401 "past 180 days with Public API" (why the backtest uses DefiLlama) |
| CoinDesk/CryptoCompare history | 401 key required |
| Binance klines | 451 restricted location |
| YouTube trending RSS, Know Your Meme trending | 400 / 404 |
| Telegram public channel `t.me/s/pumpfunnews` | works, but the channel stopped posting in 2024 |
