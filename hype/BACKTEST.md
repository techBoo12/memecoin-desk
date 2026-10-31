# hype lane backtest (honest version, Oct 31 2026)

Run it yourself: `python3 hype/backtest_viral.py` (free DefiLlama hourly prices, exits = config.json -> hype, quarter size).

## what we could test

| coin | launch (DexScreener pool time) | big-name signal the scanner reads today | would the hype lane have flagged it? | paper result, quarter size ($1.25) |
|---|---|---|---|---|
| $TRUMP (Meteora DLMM) | Jan 18 2025 02:01 UTC; Trump's X post 02:44 UTC | tweet by @realDonaldTrump, **Government** badge, names **$TRUMP**, 386k likes; DexScreener lists that tweet as the coin's "website". Wikipedia: "Donald Trump" rank 13-16 on Jan 17-19 (131k-207k views). Jupiter audit today: top holders 80.7% | YES, *if* the tweet link was on the pair at the time (today it is; at launch: not verifiable) -> bigName -> needs 1h vol >= $1M + liq >= $500k (widely reported, not verified by us: no free volume history) -> BIG-NAME EXCEPTION (80.7% <= 90%) | first price we have (04:00 UTC, 2h after launch) $6.54, peak $72.65 (11.1x). Entry at 04:00: **+435%**; 2h later +295%; 6h later +154%; 12h later +68%; 24h later +72% |
| $MELANIA (Meteora DLMM) | Jan 19 2025 21:08 UTC; Melania's X post 21:13 UTC | tweet by @MELANIATRUMP, **Government** badge, names **$MELANIA**, 66k likes; DexScreener's X link is that tweet. Wikipedia "Melania Trump" rank 97 on Jan 19. Jupiter audit: top holders 77.8% | YES, same path as $TRUMP | first price we have (Jan 20 00:00) $8.48, peak in our data $13.01 (1.5x). Entries at +0/+2/+6/+12/+24h: **-8%, -43%, -27%, -41%, -9%** |

So on the two famous "big name" launches we can price: one big winner, one loser. That is why the exception is a quarter size.

## what we could NOT test (no invented numbers)

- **Her giraffe coin and NBA coin ("Kinnikone")**: we could not identify them. Jupiter/DexScreener search today shows only small or
  dead giraffe coins (largest: KIKO "Kiko The Giraffe", 706 holders) and NBA-named coins ("NBA TROLLBOY" 887 holders, "NBA Finals Coin").
  Need the ticker or the mint from her to test them.
- **How early the scanner would have flagged them**: there is no free archive of past DexScreener boosts, Jupiter/GeckoTerminal
  trending, Google Trends RSS, Reddit or Bluesky lists. Only Wikipedia pageviews and the tweets themselves have history.
- **Entry gate numbers at the time** (1h volume, liquidity, holders at launch): no free history. GeckoTerminal only serves the last
  180 days on its free API; CoinGecko/CoinDesk/Binance history is keyed or geo-blocked from here.
- **Prices before 04:00 UTC (TRUMP) / 00:00 UTC (MELANIA)**: DefiLlama has nothing earlier, so the very first hours, where the
  biggest moves were, are missing in both directions.
- **Intra-hour moves**: hourly closes only. The MELANIA "+2h" stop shows -43% with a -25% stop because the price gapped through it
  between two hourly points; a real stop would have filled somewhere in between (better or worse).

## what this says about "catch it 1-2 days before it goes viral"

Not supported by any data we have. The earliest real signal for $TRUMP and $MELANIA was the celebrity's own tweet, which came out
minutes after the pool. Coins like those go viral the moment they exist. What the scanner can realistically do is (a) see them in the
first scan after launch (5 min), (b) flag coins named after something trending off-crypto before crypto lists pick them up (`early`).
Whether (b) finds winners can only be learned forward, in paper.
