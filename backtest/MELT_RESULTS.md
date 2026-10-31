# MELT backtest of the insider-cluster rule (R5)

- sample: 60 MELT launches picked evenly over Dec 9 2024 to Feb 28 2025 (of 41,470 labelled); traced on-chain: 49; failed to trace: 11
- the 11 untraced ones timed out on the free archive RPC (labels: high 8, medium 3); left out, not guessed
- base rate in the traced sample: 77.6% labelled high-risk (MELT overall: 84.1%)
- features use only what was on-chain by the migration (the moment the lane decides): the first 3 slots after creation, wallet funding history, and the count/timing of pre-migration txs. no price data after migration (no look-ahead)
- MELT labels come from the dataset authors (CC BY-NC 4.0); not re-checked by hand here

## rule R5 as the pack sets it: skip if cluster share > 20%

| cluster share cap | skipped | precision (skips that were high-risk) | recall (high-risk caught) | tp | fp | fn | tn |
|---|---|---|---|---|---|---|---|
| 5% | 35 | 85.7% | 78.9% | 30 | 5 | 8 | 6 |
| 10% | 22 | 95.5% | 55.3% | 21 | 1 | 17 | 10 |
| 15% | 18 | 100.0% | 47.4% | 18 | 0 | 20 | 11 |
| 20% (pack) | 15 | 100.0% | 39.5% | 15 | 0 | 23 | 11 |
| 30% | 9 | 100.0% | 23.7% | 9 | 0 | 29 | 11 |
| 40% | 5 | 100.0% | 13.2% | 5 | 0 | 33 | 11 |

## each early-window feature on its own (mean, high-risk vs not)

| feature | high-risk mean | not-high mean | AUC alone |
|---|---|---|---|
| clusterShareEarly | 19.30 | 4.94 | 0.781 |
| earlyBoughtPct | 23.70 | 9.76 | 0.754 |
| devBuyPct | 4.78 | 3.54 | 0.499 |
| earlyBuyers | 5.05 | 1.91 | 0.609 |
| sameSlot | 2.92 | 0.55 | 0.632 |
| fresh | 1.45 | 0.00 | 0.671 |
| clusterSize | 6.13 | 3.73 | 0.548 |
| links | 2.21 | 2.27 | 0.423 |
| bundleTxs | 0.76 | 0.00 | 0.618 |
| preMigTxs | 382.68 | 1791.09 | 0.089 |
| creationToMigrationMin | 64.64 | 143.15 | 0.251 |

## a tiny model, split by DATE (train 34 oldest, test 15 newest)

- logistic regression on the 11 features above, L2 0.01, standardised on the train part only
- test AUC (high-risk vs not): 1.000
- WARNING: the test part has only 2 not-high coins, so these test numbers mean very little. read the R5 table above instead
- threshold 0.5: precision 100.0%, recall 92.3% (tp 12, fp 0, fn 1, tn 2)
- threshold 0.7: precision 100.0%, recall 84.6% (tp 11, fp 0, fn 2, tn 2)
- threshold 0.85: precision 100.0%, recall 76.9% (tp 10, fp 0, fn 3, tn 2)

## for scale: MELT authors' own best models (their numbers, not re-run here)

- AUPRC for the low/medium-risk class: mlp 0.574, xgb 0.567, gbdt 0.562, rf 0.557, lgbm 0.555, lr 0.546 (from results/*_pred_<auprc>.csv in the repo); their features need 200M+ txs, ours need ~15 public-RPC calls per coin
- ours on the same footing (AUPRC for the not-high class, our test part, n=15): 1.000  (base rate 0.133)

## honest limits

- small sample (public archive RPC throttles hard: ~1-2 launches a minute); every number here has wide error bars
- MELT is Raydium-era (Dec 2024 to Feb 2025). today graduates go to PumpSwap and bundling habits changed; recalibrate on the bot's own labels (RUG/PUMP/DIED/FLAT) as they pile up
- wallets with 1000+ txs: first tx not reached on one page, so age/funder unknown (treated as NOT fresh, NOT linked): the cluster is a LOWER bound
- "high-risk" in MELT is about post-migration price behaviour, not only rugs; R5 targets insider dumping specifically
