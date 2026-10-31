# Compare the bot's own cluster features (melt_backtest.mjs) with MELT's risk labels.
#   python3 backtest/analyze_melt.py backtest/melt_features.jsonl > backtest/MELT_RESULTS.md
# MELT label: high / medium / low risk. "high" = the paper's high-risk launch class.
import json, sys, math
import numpy as np, pandas as pd
rows = [json.loads(l) for l in open(sys.argv[1])]
df = pd.DataFrame(rows)
ok = df[df.stage == 'done'].copy()
ok['y'] = (ok.label == 'high').astype(int)
ok = ok.sort_values('t')
out = []
P = lambda *a: out.append(' '.join(str(x) for x in a))
P('# MELT backtest of the insider-cluster rule (R5)\n')
P(f'- sample: {len(df)} MELT launches picked evenly over Dec 9 2024 to Feb 28 2025 (of 41,470 labelled); traced on-chain: {len(ok)}; failed to trace: {len(df) - len(ok)}')
fails = ', '.join(f'{k} {int(v)}' for k, v in df[df.stage != 'done'].label.value_counts().items())
P(f'- the {len(df) - len(ok)} untraced ones timed out on the free archive RPC (labels: {fails}); left out, not guessed')
P(f'- base rate in the traced sample: {ok.y.mean()*100:.1f}% labelled high-risk (MELT overall: 84.1%)')
P('- features use only what was on-chain by the migration (the moment the lane decides): the first 3 slots after creation, wallet funding history, and the count/timing of pre-migration txs. no price data after migration (no look-ahead)')
P('- MELT labels come from the dataset authors (CC BY-NC 4.0); not re-checked by hand here\n')
def prf(pred, y):
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum()); fn = int(((pred == 0) & (y == 1)).sum()); tn = int(((pred == 0) & (y == 0)).sum())
    p = tp / (tp + fp) if tp + fp else float('nan'); r = tp / (tp + fn) if tp + fn else float('nan')
    return p, r, tp, fp, fn, tn
P('## rule R5 as the pack sets it: skip if cluster share > 20%\n')
P('| cluster share cap | skipped | precision (skips that were high-risk) | recall (high-risk caught) | tp | fp | fn | tn |')
P('|---|---|---|---|---|---|---|---|')
for cap in [5, 10, 15, 20, 30, 40]:
    pred = (ok.clusterShareEarly > cap).astype(int)
    p, r, tp, fp, fn, tn = prf(pred, ok.y)
    P(f'| {cap}%{" (pack)" if cap == 20 else ""} | {int(pred.sum())} | {p*100:.1f}% | {r*100:.1f}% | {tp} | {fp} | {fn} | {tn} |')
P('\n## each early-window feature on its own (mean, high-risk vs not)\n')
feats = ['clusterShareEarly', 'earlyBoughtPct', 'devBuyPct', 'earlyBuyers', 'sameSlot', 'fresh', 'clusterSize', 'links', 'bundleTxs', 'preMigTxs', 'creationToMigrationMin']
P('| feature | high-risk mean | not-high mean | AUC alone |')
P('|---|---|---|---|')
def auc(score, y):
    s = pd.Series(score).rank(); n1 = int(y.sum()); n0 = len(y) - n1
    return (s[y.values == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0) if n1 and n0 else float('nan')
for f in feats:
    x = ok[f].astype(float).fillna(0)
    P(f'| {f} | {x[ok.y == 1].mean():.2f} | {x[ok.y == 0].mean():.2f} | {auc(x.values, ok.y):.3f} |')
# time split: train on the first 70% by launch time, test on the last 30% (pack section 7 tip 1)
n = len(ok); cut = int(n * 0.7)
tr, te = ok.iloc[:cut], ok.iloc[cut:]
P(f'\n## a tiny model, split by DATE (train {len(tr)} oldest, test {len(te)} newest)\n')
X = lambda d: np.c_[np.ones(len(d)), *[np.log1p(d[f].astype(float).fillna(0).clip(lower=0)) for f in feats]]
Xtr, Xte = X(tr), X(te); mu = Xtr[:, 1:].mean(0); sd = Xtr[:, 1:].std(0) + 1e-9
Xtr[:, 1:] = (Xtr[:, 1:] - mu) / sd; Xte[:, 1:] = (Xte[:, 1:] - mu) / sd
w = np.zeros(Xtr.shape[1])
for _ in range(3000):
    p = 1 / (1 + np.exp(-Xtr @ w)); w -= 0.1 * (Xtr.T @ (p - tr.y.values) / len(tr) + 0.01 * np.r_[0, w[1:]])
pt = 1 / (1 + np.exp(-Xte @ w))
P(f'- logistic regression on the {len(feats)} features above, L2 0.01, standardised on the train part only')
P(f'- test AUC (high-risk vs not): {auc(pt, te.y):.3f}' if te.y.nunique() > 1 else '- test AUC: n/a (one class only in the test part)')
P(f'- WARNING: the test part has only {int((te.y == 0).sum())} not-high coins, so these test numbers mean very little. read the R5 table above instead')
for th in [0.5, 0.7, 0.85]:
    pp, rr, tp, fp, fn, tn = prf((pt > th).astype(int), te.y)
    P(f'- threshold {th}: precision {pp*100:.1f}%, recall {rr*100:.1f}% (tp {tp}, fp {fp}, fn {fn}, tn {tn})')
# MELT's own models (their prediction files), for scale: they predict the NOT-high class; AUPRC from their file names
P('\n## for scale: MELT authors\' own best models (their numbers, not re-run here)\n')
P('- AUPRC for the low/medium-risk class: mlp 0.574, xgb 0.567, gbdt 0.562, rf 0.557, lgbm 0.555, lr 0.546 (from results/*_pred_<auprc>.csv in the repo); their features need 200M+ txs, ours need ~15 public-RPC calls per coin')
not_high = 1 - te.y
if not_high.sum() and te.y.sum():
    order = np.argsort(pt)  # most likely NOT high first
    hits = not_high.values[order]; prec = np.cumsum(hits) / np.arange(1, len(hits) + 1)
    auprc = float((prec * hits).sum() / hits.sum())
    P(f'- ours on the same footing (AUPRC for the not-high class, our test part, n={len(te)}): {auprc:.3f}  (base rate {not_high.mean():.3f})')
P('\n## honest limits\n')
P('- small sample (public archive RPC throttles hard: ~1-2 launches a minute); every number here has wide error bars')
P('- MELT is Raydium-era (Dec 2024 to Feb 2025). today graduates go to PumpSwap and bundling habits changed; recalibrate on the bot\'s own labels (RUG/PUMP/DIED/FLAT) as they pile up')
P('- wallets with 1000+ txs: first tx not reached on one page, so age/funder unknown (treated as NOT fresh, NOT linked): the cluster is a LOWER bound')
P('- "high-risk" in MELT is about post-migration price behaviour, not only rugs; R5 targets insider dumping specifically')
print('\n'.join(out))
