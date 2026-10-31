# training pack → code (day 5)

Source: "Building a DeFi degen bot · training pack" (11 pages, checked 31 Oct 2026). Everything below runs in **paper mode**. Every number from 9.3 lives in `config.json → playbook` word for word, labelled as the pack labels it: *starting guesses, tune by paper trading*.

## section 9: the playbook (built line by line)

| pack | what it says | code |
|---|---|---|
| 9.1 A 1 | token, creation slot/tx, launchpad, migration time | `src/playbook/gather.js` stages `pool`, `migration`, `sigs`, `creation` |
| 9.1 A 2 | deployer | PumpSwap pool `coin_creator` field (decoded on-chain, `solana.js decodePumpSwapPool`), checked against the creation tx signer |
| 9.1 A 3 | early buyers (creation slot, +early_buyer_slots, same Jito bundle) | `gather.js` stage `early` + Jito's public bundle API (`solana.js jitoBundleOf/jitoBundleTxs`) |
| 9.1 A 4 | funding trail 1-2 hops + wallet age | `gather.js` stage `funders` (first tx of each wallet = first incoming SOL → funder; then the funders' funders) |
| 9.1 A 5 | deployer links (SOL/token transfers either way) | `gather.js` stage `links`, `solana.js directTransfers` (top-level only; Jito tip accounts excluded) |
| 9.1 A 6 | holder balances over time | at entry: `gather.js readState`; while holding: `lane.js observe` (one `getMultipleAccounts` read of every cluster token account) |
| 9.1 A 7 | pool / LP state | pool account (LP supply), LP mint supply (burned %), both vaults (reserves) in the same read |
| 9.1 A 8 | mint/freeze authority + Token-2022 extensions | mint account, jsonParsed |
| 9.1 A 9 | sell simulation | live Jupiter buy→sell quote (`lane.js decideToken`) |
| 9.1 B a | detect new pools/migrations, niche only | `lane.js discover`: pump.fun's migration account on-chain (exact), GeckoTerminal new pools, DexScreener |
| 9.1 B b | build cluster C: rules (1)-(5), repeat (1)-(3) once | `src/playbook/cluster.js buildCluster` |
| 9.1 B c | cluster_share, top10_share (pool + burn excluded), entry holdings | `cluster.js clusterShare/top10Share`, `gather.js readState` |
| 9.1 B d | entry filters, record the failed check | `src/playbook/rules.js` + `lane.js skip()` (every skip logged with the rule code, the number and a source) |
| 9.1 B e | size = min(max_position_pct equity, max_pool_impact_pct pool SOL); quote + fee caps | `src/playbook/fees.js sizeInsider`, `rules.js execChecks` |
| 9.1 B f | monitor ≥ 1/s on price, peak, cluster_share, sold fraction; follow transfers out of the cluster | `lane.js monitor/observe/followSplits` (Node: every 1 s; Worker: 3 looks 1 s apart per alarm) |
| 9.1 B g | E1-E8 in order, exits use max_exit_slippage_bps | `src/playbook/exits.js firstTrigger`, `lane.js act/exitFill` |
| 9.1 B h | log + label every token at t0+1h / t0+24h: RUG / PUMP / DIED / FLAT | `src/playbook/labels.js` (+5m/15m/30m samples to find the 1h peak), `lane.js labelsStep` |
| 9.1 C | main loop + manage() pseudocode | `lane.js` (discover → buildStep → decideToken → monitor), run one unit per `engine.tick` |
| 9.1 D | decision table (incl. "cluster sold something, under the trigger → HOLD + warning", "a sell fails twice → sell at max exit slippage, alert a human") | `exits.js` warn path, `lane.js exitFill` |
| 9.1 E | fresh wallets, exchange-funded clusters (link only on ±5% / 10 min batches), wallet splitting, latency logging | `cluster.js effectiveFunder`, hub detection in `gather.js`, `lane.js followSplits`, `P.latency` |
| R1-R2 | mint + freeze revoked, Token-2022 traps (transfer fee / hook / permanent delegate, + non-transferable, pausable, default-frozen from section 2) | `rules.js rugChecks`, `trapExtensions` |
| R3 | LP ≥ 95% burned/locked, read on-chain | burned % from the pool's LP supply vs the LP mint's supply; RugCheck's lock % as the second source |
| R4-R7 | top10 ≤ 30%, cluster ≤ 20%, liquidity ≥ $15k, sell sim loss ≤ 15% | `rules.js rugChecks`; top 10 skips the pool, burn addresses and program-held accounts (off-curve owners: other pools, lockers), which are reported apart as `programHeldPct` |
| R8-R10 | TP ladder 2x/3x 30% each of the original, trailing 25% from entry, max hold 60 min | `exits.js` E7, E6, E8 |
| R11-R13 | entry slippage ≤ 300 bps (never raise it), exit ≤ 1500 bps, priority fee + tip ≤ 0.002 SOL | `rules.js execChecks`, `fees.js estimateFeeSol` (recent fees on that pool, p75 × CU + Jito tip floor) |
| R14 | only pump.fun graduates ≤ 10 min after migration | `gather.js` (PumpSwap pool, pump.fun program in the migration tx, minutes since) |
| R15 | daily loss → E1 kill switch, stop until tomorrow | `lane.js killSwitchOn/killAll` (sells every open position, both lanes) |
| R16 | ≤ 3 open, never two in one token | `rules.js riskChecks` |
| R17 | hot wallet holds only what's needed | not applicable in paper mode (there is no wallet). stays a rule for the live step |
| R18 | signal format, exit quotes the entry alert_id, risk line | `src/playbook/signals.js signalText` (every insider alert to her Telegram uses it) |
| 9.3 | one config block | `config.json → playbook` (+ 6 `/set` keys: pbon, pbcluster, pbsell, pbtrail, pbhold, pbsize) |
| 9.4 | pessimistic fills, win rate, avg/median PnL, max DD, rug-exit rate, filter value, latency, go/no-go bar | fills: quote − fee − tip − sandwich haircut (`fees.js paperCostUsd`); metrics + 6 go/no-go bars: `labels.js evaluate`; shown in `/insider` and the 24h report |

## sections 1-8

| pack | built as |
|---|---|
| 1 bonding curve, PumpSwap migration, fees, x*y=k | migration detection + pool decode; constant-product price from reserves and impact (`fees.js cpImpactPct`); fees come from the live Jupiter quote (not hard-coded: the fee schedule changes) |
| 2 rug signals | R1-R7 above; GoPlus + RugCheck as second opinions (`rules.js secondOpinion`, hard flags block, the rest warn); honeypot = Jupiter round trip (honeypot.is is EVM-only) |
| 2 also | token decimals now read from the mint when RugCheck is silent (bug found while testing: a 5-decimal coin was booked 10x off and hit a false stop) |
| 3 data sources | public RPC + Jito public API + GeckoTerminal + DexScreener + Jupiter + RugCheck + GoPlus (all keyless); MELT used for the backtest |
| 4 strategy + risk | Kelly: quarter-Kelly cap only after 30 insider trades (`fees.js kellyCapPct`); sandwich risk: slippage caps + haircut in paper fills; freqtrade-style trailing stop |
| 4 bot-loss post-mortems | no keys anywhere in the lane; a test fails if the lane ever contains signing/sending code |
| 5 papers | Catching the Rug / MELT: early-window features + a time-split model in `backtest/`; Meme Coin Factories: copycat block (M1), coordinated sells (E4/E5), creator obfuscation (the cluster), wash pattern flag (M2) |
| 6 repos + red flags | studied, nothing installed; a test asserts no dependencies and no install scripts |
| 7 RAG / fine-tune / features | RAG-lite: every rule code carries a why + its source link (`src/playbook/kb.js`), no model needed; fine-tuning: not done (the pack itself says it isn't worth it here); features: the backtest |
| 8 own labelled data | every token seen is labelled; RUG-labelled deployers (and their funders) are blocked next time (M5) |
| 8 paper 2 weeks | the go/no-go bar needs 14 days + 100 trades |
| 8 speed | not buildable for free (see below); latency is logged per trade and is part of go/no-go |
| 8 sell the signal | R18 format is ready; selling it is her call |

## not buildable on free data (and the nearest free substitute in use)

| pack wants | why not | substitute |
|---|---|---|
| Yellowstone gRPC / Geyser stream, Helius streams | paid / API key; a Worker can't hold a gRPC stream | polling: 1 read per second per position; graduations polled every 30 s from the migration account |
| Jito bundles + private RPC for exits | needs a wallet and a paid RPC; paper mode anyway | paper fills priced at the live quote minus fee + tip + haircut |
| Bitquery launches/bundles | API key | Jito's public bundle explorer API + our own tx parsing |
| Helius DAS getAsset | API key | mint account jsonParsed (authorities, extensions, metadata) |
| Birdeye, Nansen smart money | API key / paid | DexScreener + GeckoTerminal; smart-money copy trading not built (the pack warns it bleeds) |
| Dune, Kaggle | login / API key | MELT (public GitHub) for history |
| MELT's ready-made feature.pkl (122 features) | Google Drive said "quota exceeded" on Oct 31 | the bot's own cluster code run on MELT launches through the public archive RPC |
| SolRPDS (62,895 pools), RugPull1K | SolRPDS is liquidity-inactivity on old Raydium pools (different question); RugPull1K is mostly EVM | not used; listed as next steps |
| median detection-to-landed < 1500 ms | free polling is slower | logged; the go/no-go bar keeps the lane in paper until it is met |
