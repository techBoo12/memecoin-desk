// ============================================================================
// MELT backtest (training pack sections 3, 5, 7): run the bot's OWN cluster code
// (src/playbook/gather.js + cluster.js, historical mode) on a time-ordered sample of
// MELT launches, using only what was on-chain up to the end of the early window
// (no look-ahead), then compare with MELT's risk labels in analyze_melt.py.
//   node backtest/melt_backtest.mjs <melt_dir> <n> <out.jsonl>
// MELT: github.com/git-disl/MELT (CC BY-NC 4.0, non-commercial: fine for a paper-mode study).
// Its pre-built feature.pkl lives on Google Drive and was quota-blocked on Oct 31 2026,
// so features here come from the chain itself (public archive RPC).
// ============================================================================
import fs from 'node:fs';
import { makeRpc, jitoBundleOf, jitoBundleTxs, rpcStats } from '../src/playbook/solana.js';
import { newBuild, stepBuild } from '../src/playbook/gather.js';

const [dir, nArg, out] = process.argv.slice(2);
const N = Number(nArg || 200);
const cfg = { ...JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url))).playbook,
  free_data_caps: { sigPages: 8, earlyTx: 30, wallets: 15, hop2: 6, links: 8, ownerLookups: 0 } };
const labels = new Map(fs.readFileSync(`${dir}/data__label__label.csv`, 'utf8').trim().split('\n').slice(1).map((l) => { const [m, minr, manip, ret, lab] = l.split(','); return [m, { minRatio: +minr, manip, ret: +ret, label: lab }]; }));
const list = fs.readFileSync(`${dir}/data__memecoin__memecoin_list.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((x) => labels.has(x.token_address)).sort((a, b) => a.timestamp - b.timestamp);
const step = list.length / N;
const evenly = Array.from({ length: N }, (_, i) => list[Math.floor(i * step)]);
// visit in bit-reversed order so ANY prefix of the run covers the whole period (the time split happens at analysis)
const bits = Math.ceil(Math.log2(N));
const rev = (i) => parseInt(i.toString(2).padStart(bits, '0').split('').reverse().join(''), 2);
const sample = Array.from({ length: 2 ** bits }, (_, i) => rev(i)).filter((i) => i < N).map((i) => evenly[i]);
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).mint) : []);
const rpc = makeRpc({ archive: true, minGapMs: 230 });
const io = { rpc, jitoBundleOf, jitoBundleTxs };
console.log(`MELT: ${list.length} labelled launches, sampling ${N} evenly over time, ${done.size} already done`);
let i = 0;
for (const x of sample) {
  i++;
  if (done.has(x.token_address)) continue;
  const b = newBuild({ mint: x.token_address, historical: true, migrationSig: x.signature, t0: x.timestamp * 1000 });
  let guard = 0;
  while (!['done', 'fail'].includes(b.stage) && guard++ < 40) await stepBuild(b, io, cfg, 10);
  const r = b.result; const C = r?.cluster;
  const early = r?.inp?.earlyBuyers || [];
  const reasons = {};
  if (C) for (const why of C.members.values()) for (const w of why) { const k = w.split(' ')[0] + ' ' + (w.split(' ')[1] || ''); reasons[k] = (reasons[k] || 0) + 1; }
  const devBuy = b.buys.filter((y) => y.wallet === b.deployer).reduce((s, y) => s + Number(y.amount), 0);
  const row = { mint: x.token_address, t: x.timestamp, ...labels.get(x.token_address), stage: b.stage, fail: b.fail?.note || null, calls: b.calls,
    preMigTxs: b.preMigrationTxs ?? null, earlyTxs: b.earlyTotal ?? null, earlyBuyers: early.length, bundle: Boolean(b.creation?.bundleId), bundleTxs: b.bundleSigs?.length || 0,
    sameSlot: early.filter((e) => e.slot === b.creation?.slot).length, fresh: early.filter((e) => { const a = b.wallets[e.wallet]?.firstTxAt; return a != null && b.creation.at - a < cfg.fresh_wallet_max_age_min * 60000; }).length,
    clusterSize: C?.size ?? null, earlyInCluster: C?.earlyInCluster ?? null, clusterShareEarly: r?.clusterShareEarly ?? null,
    earlyBoughtPct: r ? Object.values(r.earlyNet).reduce((s, v) => s + Math.max(0, v), 0) / r.supply * 100 : null,
    devBuyPct: devBuy / 1e15 * 100, links: new Set(b.links).size, reasons, creationToMigrationMin: b.creation ? +((x.timestamp * 1000 - b.creation.at) / 60000).toFixed(2) : null };
  fs.appendFileSync(out, JSON.stringify(row) + '\n');
  if (i % 10 === 0) console.log(`${i}/${N} rpc calls ${rpcStats.calls} errors ${rpcStats.errors}`);
}
console.log('done', rpcStats);
