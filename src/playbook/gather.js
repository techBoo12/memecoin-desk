// ============================================================================
// GATHER: read one fresh pump.fun graduate from the chain, a few calls at a time
// (training pack 9.1 A inputs 1-9, built incrementally so a Cloudflare free-plan
// invocation never needs more than ~8 sub-requests and a few ms of CPU).
//   pool       PumpSwap pool -> base/quote, LP mint, vaults, coin_creator (= deployer)
//   migration  the pool's first tx must be a pump.fun migration (R14) + minutes since it
//   sigs       page the mint's history back from the migration to its creation
//   creation   creation tx, its slot, its Jito bundle (public bundle API)
//   early      every tx within early_buyer_slots of creation -> early buyers
//   funders    first incoming SOL + first-tx time of deployer + early buyers (hop 1), then their funders (hop 2)
//   links      the deployer's direct SOL/token transfers (around creation + latest)
//   state      mint authorities + Token-2022 extensions, LP burn, reserves, top holders, cluster balances
// Free-RPC caps (free_data_caps) are stated in every skip reason when they bite.
// ============================================================================
import { WSOL, PUMP_PROGRAM, PUMPSWAP_PROGRAM, SYSTEM, BURN_OWNERS, isOnCurve, decodePumpSwapPool, keysOf, signerOf, tokenDeltas, funderFromFirstTx, directTransfers } from './solana.js';
import { buildCluster, clusterShare, top10Share } from './cluster.js';

// Jito's 8 tip accounts: a top-level transfer to one of these is a tip, not a "link"
export const JITO_TIP_ACCOUNTS = new Set(['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']);
const TXO = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 };

export function newBuild({ mint, pool, symbol = '?', t0 = Date.now(), migrationSig = null, migratedAt = null, historical = false }) {
  return { mint, pool, symbol, t0, historical, migratedAt, stage: historical ? 'sigs' : 'pool', cursor: migrationSig, migrationSig, calls: 0,
    sigPages: 0, prevTail: [], earlyQueue: [], buys: [], sells: [], wallets: {}, walletQueue: [], hop2Queue: [], hop2Started: false,
    links: [], linkTas: {}, linkQueue: null, deployerSigs: null, notes: [], fail: null };
}

const caps = (cfg) => ({ sigPages: 10, earlyTx: 40, wallets: 30, hop2: 12, links: 16, ownerLookups: 10, ...(cfg.free_data_caps || {}) });
const fail = (b, code, note, unknown = false) => { b.fail = { code, note, unknown }; b.stage = 'fail'; return b; };

export async function stepBuild(b, io, cfg, budget = 8) {
  const cap = caps(cfg);
  let used = 0;
  const call = async (m, p) => { used++; b.calls++; return io.rpc(m, p); };
  const exchanges = new Set(cfg.exchange_wallets || []);
  try {
    while (used < budget && b.stage !== 'done' && b.stage !== 'fail') {
      if (b.stage === 'pool') {
        const a = await call('getAccountInfo', [b.pool, { encoding: 'base64' }]);
        if (!a?.value) return fail(b, 'R14', 'pool account not found');
        if (a.value.owner !== PUMPSWAP_PROGRAM) return fail(b, 'R14', 'not a PumpSwap pool');
        const p = decodePumpSwapPool(a.value.data[0]);
        if (!p || p.baseMint !== b.mint || p.quoteMint !== WSOL) return fail(b, 'R14', 'pool is not <token>/SOL');
        if (!p.coinCreator || p.coinCreator === SYSTEM) return fail(b, 'R14', 'no coin creator on the pool: not a pump.fun graduate');
        b.poolInfo = p; b.deployer = p.coinCreator; b.stage = 'migration'; b.migPages = 0; b.migCursor = null;
        if (b.migratedAt && b.migrationSig) { // found on-chain from the migration tx itself: no need to page the pool
          b.cursor = b.migrationSig; b.minutesSinceMigration = +((b.t0 - b.migratedAt) / 60000).toFixed(2);
          if (b.minutesSinceMigration > cfg.max_minutes_since_migration) return fail(b, 'R14', `migrated ${b.minutesSinceMigration} min ago (> ${cfg.max_minutes_since_migration})`);
          b.stage = 'sigs';
        }
      } else if (b.stage === 'migration') {
        const page = await call('getSignaturesForAddress', [b.pool, { limit: 1000, ...(b.migCursor ? { before: b.migCursor } : {}) }]);
        if (page.length === 1000) { if (++b.migPages >= 3) return fail(b, 'R14', 'pool already has 3000+ txs: not fresh'); b.migCursor = page.at(-1).signature; continue; }
        const first = page.at(-1);
        if (!first) return fail(b, 'R14', 'pool has no history');
        const tx = await call('getTransaction', [first.signature, TXO]);
        if (!tx) return fail(b, 'R14', 'migration tx not readable yet', true);
        if (!keysOf(tx).includes(PUMP_PROGRAM)) return fail(b, 'R14', 'pool was not created by a pump.fun migration');
        b.migratedAt = (tx.blockTime || first.blockTime) * 1000; b.migrationSig = first.signature; b.cursor = first.signature;
        b.minutesSinceMigration = +((b.t0 - b.migratedAt) / 60000).toFixed(2);
        if (b.minutesSinceMigration > cfg.max_minutes_since_migration) return fail(b, 'R14', `migrated ${b.minutesSinceMigration} min ago (> ${cfg.max_minutes_since_migration})`);
        b.stage = 'sigs';
      } else if (b.stage === 'sigs') {
        const page = await call('getSignaturesForAddress', [b.mint, { limit: 1000, ...(b.cursor ? { before: b.cursor } : {}) }]);
        b.sigPages++;
        const tail = [...b.prevTail, ...page];
        if (page.length < 1000) {
          const oldest = tail.at(-1);
          if (!oldest) return fail(b, 'R5', 'no pre-migration history found', true);
          b.creationSig = oldest.signature;
          b.earlyQueue = tail.filter((s) => !s.err && s.slot <= oldest.slot + cfg.early_buyer_slots && s.signature !== oldest.signature)
            .sort((x, y) => x.slot - y.slot).slice(0, cap.earlyTx).map((s) => s.signature);
          b.earlyTotal = tail.filter((s) => !s.err && s.slot <= oldest.slot + cfg.early_buyer_slots).length - 1;
          b.preMigrationTxs = (b.sigPages - 1) * 1000 + page.length;
          b.prevTail = []; b.stage = 'creation';
        } else {
          if (b.sigPages >= cap.sigPages) return fail(b, 'R5', `pre-migration history > ${cap.sigPages * 1000} txs: too long to trace the cluster on free RPC`, true);
          b.cursor = page.at(-1).signature; b.prevTail = page.slice(-200);
        }
      } else if (b.stage === 'creation') {
        const tx = await call('getTransaction', [b.creationSig, TXO]);
        if (!tx) return fail(b, 'R5', 'creation tx not readable', true);
        const signer = signerOf(tx);
        b.creation = { sig: b.creationSig, slot: tx.slot, at: (tx.blockTime || 0) * 1000, bundleId: null, pumpCreate: keysOf(tx).includes(PUMP_PROGRAM) };
        if (!b.deployer) b.deployer = signer;
        else if (signer !== b.deployer) { b.notes.push('creation signer differs from pool coin_creator: both treated as cluster'); b.links.push(signer); }
        const cd = Object.entries(tokenDeltas(tx, b.mint)).sort((x, y) => (y[1].delta > x[1].delta ? 1 : -1));
        // the creation tx mints the whole supply into the bonding curve's account: that owner is the curve, not a buyer
        if (cd[0] && cd[0][1].delta > 0n) b.curve = cd[0][0];
        for (const [owner, d] of cd) if (d.delta > 0n && owner !== b.curve) b.buys.push({ wallet: owner, ta: d.ta, slot: tx.slot, amount: d.delta.toString(), sig: b.creationSig });
        used++; b.calls++;
        b.creation.bundleId = await io.jitoBundleOf(b.creationSig);
        if (b.creation.bundleId) { used++; b.calls++; b.bundleSigs = (await io.jitoBundleTxs(b.creation.bundleId)) || [b.creationSig]; } else b.bundleSigs = [];
        b.stage = 'early';
      } else if (b.stage === 'early') {
        const sig = b.earlyQueue.shift();
        if (!sig) {
          const amt = {};
          for (const x of b.buys) amt[x.wallet] = (amt[x.wallet] || 0n) + BigInt(x.amount);
          b.walletQueue = [b.deployer, ...Object.keys(amt).filter((w) => w !== b.deployer).sort((x, y) => (amt[y] > amt[x] ? 1 : -1))].slice(0, cap.wallets);
          b.stage = 'funders'; continue;
        }
        const tx = await call('getTransaction', [sig, TXO]);
        if (!tx || tx.meta?.err) continue;
        const inBundle = b.bundleSigs?.includes(sig) ? b.creation.bundleId : null;
        for (const [owner, d] of Object.entries(tokenDeltas(tx, b.mint))) {
          if (owner === b.curve || owner === b.pool) continue;
          if (d.delta > 0n) b.buys.push({ wallet: owner, ta: d.ta, slot: tx.slot, amount: d.delta.toString(), sig, bundleId: inBundle, payer: signerOf(tx) });
          else if (d.delta < 0n) b.sells.push({ wallet: owner, amount: (-d.delta).toString(), slot: tx.slot });
        }
      } else if (b.stage === 'funders') {
        let w = b.walletQueue.shift();
        if (!w) {
          if (!b.hop2Started && cfg.funding_trace_hops >= 2) {
            b.hop2Started = true;
            const fs = new Set(Object.values(b.wallets).map((x) => x.funder).filter((f) => f && !b.wallets[f] && !exchanges.has(f)));
            b.walletQueue = [...fs].slice(0, cap.hop2); continue;
          }
          b.stage = 'links'; continue;
        }
        const page = await call('getSignaturesForAddress', [w, { limit: 1000 }]);
        const info = (b.wallets[w] ||= {});
        if (w === b.deployer) b.deployerSigs = page.map((s) => ({ signature: s.signature, slot: s.slot }));
        if (page.length < 1000) {
          const first = page.at(-1);
          if (first) {
            info.firstTxAt = (first.blockTime || 0) * 1000;
            const tx = await call('getTransaction', [first.signature, TXO]);
            const f = tx && funderFromFirstTx(tx, w);
            if (f) { info.funder = f.funder; info.funderLamports = f.lamports; info.funderAt = f.at; }
          }
        } else {
          info.old = true; // 1000+ txs: first tx not reachable in one page, age unknown (treated as NOT fresh)
          const spanH = ((page[0].blockTime || 0) - (page.at(-1).blockTime || 0)) / 3600;
          if (spanH < (cfg.hub_span_hours ?? 6)) info.hub = true; // 1000 txs in a few hours = exchange/bot hub, never a link on its own
        }
      } else if (b.stage === 'links') {
        if (!b.linkQueue) {
          const skip = new Set([b.creationSig, ...b.buys.map((x) => x.sig)]);
          let sigs = b.deployerSigs || [];
          const before = sigs.filter((s) => s.slot < b.creation.slot && !skip.has(s.signature));
          const after = sigs.filter((s) => s.slot > b.creation.slot && !skip.has(s.signature));
          if (sigs.length >= 1000 || !before.length) {
            const pre = await call('getSignaturesForAddress', [b.deployer, { limit: 10, before: b.creationSig }]);
            before.splice(0, before.length, ...pre.map((s) => ({ signature: s.signature, slot: s.slot })));
          }
          const half = Math.ceil(cap.links / 2);
          b.linkQueue = [...before.slice(0, half), ...(b.historical ? [] : after.slice(0, cap.links - half))].map((s) => s.signature);
          continue;
        }
        const sig = b.linkQueue.shift();
        if (!sig) { b.stage = b.historical ? 'done' : 'state'; if (b.historical) finishHistorical(b, cfg, exchanges); continue; }
        const tx = await call('getTransaction', [sig, TXO]);
        if (!tx) continue;
        for (const t of directTransfers(tx, b.deployer, b.mint)) {
          if (JITO_TIP_ACCOUNTS.has(t.other) || BURN_OWNERS.has(t.other) || t.other === b.pool) continue;
          b.links.push(t.other);
          if (t.kind === 'token' && t.dir === 'out') b.linkTas[t.ta] = t.other;
        }
      } else if (b.stage === 'state') {
        await readState(b, io, cfg, exchanges, call, cap);
        b.stage = 'done';
      }
    }
  } catch (e) {
    b.errors = (b.errors || 0) + 1; b.lastError = String(e.message || e).slice(0, 160);
    if (b.errors >= 4) fail(b, 'DATA', `free RPC kept failing: ${b.lastError}`, true);
  }
  return b;
}

function clusterInput(b) {
  const first = {};
  for (const x of b.buys) if (!first[x.wallet] || x.slot < first[x.wallet].slot) first[x.wallet] = x;
  return {
    deployer: b.deployer, creation: b.creation,
    earlyBuyers: Object.values(first).filter((x) => x.wallet !== b.deployer).map((x) => ({ wallet: x.wallet, slot: x.slot, bundleId: x.bundleId || (x.sig === b.creationSig ? b.creation.bundleId : null) })),
    wallets: b.wallets, deployerLinks: [...new Set(b.links)],
  };
}

// backtest mode: cluster share at the end of the early window, from the early txs only (no look-ahead)
function finishHistorical(b, cfg, exchanges) {
  const inp = clusterInput(b);
  const C = buildCluster(inp, cfg, exchanges);
  const net = {};
  for (const x of b.buys) net[x.wallet] = (net[x.wallet] || 0) + Number(x.amount);
  for (const x of b.sells) net[x.wallet] = (net[x.wallet] || 0) - Number(x.amount);
  const supply = Number(cfg.pump_total_supply_raw ?? 1e15);
  b.result = { cluster: C, inp, earlyNet: net, supply, clusterShareEarly: clusterShare(net, C.members, supply) };
}

async function readState(b, io, cfg, exchanges, call, cap) {
  const p = b.poolInfo;
  const r = await call('getMultipleAccounts', [[b.mint, p.lpMint, p.baseVault, p.quoteVault], { encoding: 'jsonParsed' }]);
  const [mintA, lpA, baseA, quoteA] = r.value;
  const mi = mintA?.data?.parsed?.info || {};
  const mintInfo = { mintAuthority: mi.mintAuthority ?? null, freezeAuthority: mi.freezeAuthority ?? null, supply: mi.supply, decimals: mi.decimals,
    program: mintA?.owner, extensions: (mi.extensions || []).map((e) => ({ name: e.extension, state: e.state })) };
  const lpMintSupply = Number(lpA?.data?.parsed?.info?.supply ?? NaN);
  const lpBurnedPct = Number(p.lpSupply) > 0 && Number.isFinite(lpMintSupply) ? Math.max(0, (1 - lpMintSupply / Number(p.lpSupply)) * 100) : null;
  const reserves = { token: Number(baseA?.data?.parsed?.info?.tokenAmount?.amount ?? NaN), sol: Number(quoteA?.data?.parsed?.info?.tokenAmount?.amount ?? NaN) / 1e9 };
  const exclude = new Set([b.pool, p.baseVault, ...BURN_OWNERS]);

  // top holders (aggregated by owner)
  let holders = null, holdersSource = 'rpc';
  try {
    const la = await call('getTokenLargestAccounts', [b.mint]);
    const own = await call('getMultipleAccounts', [la.value.map((x) => x.address), { encoding: 'jsonParsed' }]);
    holders = la.value.map((x, i) => ({ address: x.address, owner: own.value[i]?.data?.parsed?.info?.owner, amount: Number(x.amount) }));
  } catch (e) {
    holdersSource = 'rugcheck (rpc refused: ' + String(e.message).slice(0, 40) + ')';
    const rc = io.rugcheck ? await io.rugcheck(b.mint) : null;
    holders = rc?.topHolders?.map((h) => ({ address: h.address, owner: h.owner, amount: Number(h.amount) })) || null;
  }
  const byOwner = {};
  for (const h of holders || []) if (h.owner) byOwner[h.owner] = (byOwner[h.owner] || 0) + h.amount;
  // program-held (off-curve owner: other pools, lockers, vesting): nobody signs for it, so not counted in R4, shown apart
  const onCurve = io.isOnCurve || isOnCurve;
  const programHeld = Object.entries(byOwner).filter(([o]) => !exclude.has(o) && !onCurve(o));
  const top10Exclude = new Set([...exclude, ...programHeld.map(([o]) => o)]);

  // cluster + its token accounts
  const inp = clusterInput(b);
  const C = buildCluster(inp, cfg, exchanges);
  const tas = {};
  for (const x of b.buys) if (C.members.has(x.wallet)) tas[x.ta] = x.wallet;
  for (const [ta, o] of Object.entries(b.linkTas)) if (C.members.has(o)) tas[ta] = o;
  for (const h of holders || []) if (h.owner && C.members.has(h.owner)) tas[h.address] = h.owner;
  // members with no known token account (e.g. linked only by SOL): look them up, capped
  const known = new Set(Object.values(tas));
  const missing = [...C.members.keys()].filter((w) => !known.has(w)).slice(0, cap.ownerLookups);
  for (const w of missing) {
    try {
      const ta = await call('getTokenAccountsByOwner', [w, { mint: b.mint }, { encoding: 'jsonParsed' }]);
      for (const a of ta.value || []) tas[a.pubkey] = w;
    } catch { /* stays unknown */ }
  }
  const balances = {}; const taBal = {}; const taList = Object.keys(tas);
  for (let i = 0; i < taList.length; i += 100) {
    const chunk = taList.slice(i, i + 100);
    const got = await call('getMultipleAccounts', [chunk, { encoding: 'jsonParsed' }]);
    got.value.forEach((a, k) => { const amt = Number(a?.data?.parsed?.info?.tokenAmount?.amount || 0); const o = tas[chunk[k]]; taBal[chunk[k]] = amt; balances[o] = (balances[o] || 0) + amt; });
  }
  const supply = Number(mintInfo.supply);
  const meta = mintInfo.extensions.find((e) => e.name === 'tokenMetadata')?.state;
  if (meta?.symbol && (b.symbol === '?' || b.symbol === b.mint.slice(0, 4))) b.symbol = meta.symbol;
  b.result = {
    mintInfo, lpBurnedPct, reserves, priceSol: reserves.sol / (reserves.token / 10 ** (mintInfo.decimals ?? 6)),
    holders, holdersSource, top10Pct: holders ? top10Share(Object.entries(byOwner).map(([owner, amount]) => ({ owner, amount })), supply, top10Exclude) : null,
    // top 10 with the dev crew taken out: the trusted-dev exception judges the crew by its history, the rest of the holders still face R4
    top10ExCrewPct: holders ? top10Share(Object.entries(byOwner).map(([owner, amount]) => ({ owner, amount })), supply, new Set([...top10Exclude, ...C.members.keys()])) : null,
    programHeldPct: holders ? programHeld.reduce((s2, [, a]) => s2 + a, 0) / Number(mintInfo.supply) * 100 : null,
    cluster: C, inp, tokenAccounts: tas, taBal, balances, entryHoldings: balances, clusterBal: Object.values(balances).reduce((s, x) => s + x, 0),
    deployerBal: balances[b.deployer] || 0, clusterPct: clusterShare(balances, C.members, supply, exclude), supply, exclude: [...exclude],
  };
}
