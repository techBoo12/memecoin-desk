// ============================================================================
// INSIDER CLUSTER (training pack 9.1 B step b, step c, 9.1 E)
// Pure functions: given what was read from the chain, decide who is "the dev's
// cluster" and how much of the supply it holds. No network here, so every rule
// is unit-tested.
//   (1) early buyer funded (within funding_trace_hops) by the deployer, the
//       deployer's funder, a cluster wallet, or the funder of a cluster wallet
//   (2) bought in the creation slot or in the creation tx's Jito bundle
//   (3) sent SOL/tokens to, or got them from, the deployer
//   (4) early buyer that is a fresh wallet (< fresh_wallet_max_age_min old at creation)
//   (5) 3+ early buyers sharing one funder
//   then (1)-(3) once more with the new members, then stop.
//   Never link on a known exchange/bridge (or busy hub) funder alone; link them only
//   when withdrawals of near-equal size (within 5%) land within 10 min and all buy early (9.1 E).
// ============================================================================

// inp = {
//   deployer, creation: { slot, at, bundleId },
//   earlyBuyers: [{ wallet, slot, bundleId }],
//   wallets: { [addr]: { funder, funderAt, funderLamports, firstTxAt, hub } },   // funding trail + age
//   deployerLinks: [addr],
// }
export function effectiveFunder(w, inp, cfg, isExchange) {
  const info = inp.wallets[w];
  const f = info?.funder;
  if (!f) return null;
  if (!isExchange(f)) return f;
  // exchange/bridge/hub funder: only a near-equal, near-simultaneous batch of early buyers counts as a link
  const peers = inp.earlyBuyers.map((b) => b.wallet).filter((x) => x !== w && inp.wallets[x]?.funder === f).filter((x) => {
    const o = inp.wallets[x];
    const a = Number(info.funderLamports), b = Number(o.funderLamports);
    return a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= (cfg.exchange_link_amount_tol_pct ?? 5) / 100
      && Math.abs((info.funderAt || 0) - (o.funderAt || 0)) <= (cfg.exchange_link_window_min ?? 10) * 60_000;
  });
  return peers.length ? `${f}#batch` : null;
}

export function buildCluster(inp, cfg, exchangeSet = new Set()) {
  const isExchange = (a) => exchangeSet.has(a) || Boolean(inp.wallets[a]?.hub);
  const C = new Map(); // wallet -> [reasons]
  const add = (w, why) => { if (!w) return false; const had = C.has(w); if (!had) C.set(w, []); if (!C.get(w).includes(why)) C.get(w).push(why); return !had; };
  const early = inp.earlyBuyers || [];
  const earlySet = new Set(early.map((b) => b.wallet));
  const hops = Math.max(1, Math.min(2, cfg.funding_trace_hops ?? 2));
  const fundersOf = (w) => {
    const f1 = effectiveFunder(w, inp, cfg, isExchange);
    const out = f1 ? [f1] : [];
    if (hops >= 2 && f1 && !f1.endsWith('#batch')) { const f2 = effectiveFunder(f1, inp, cfg, isExchange); if (f2) out.push(f2); }
    return out;
  };
  add(inp.deployer, 'deployer');
  const deployerFunder = effectiveFunder(inp.deployer, inp, cfg, isExchange);

  const rule1 = () => {
    let grew = false;
    const linked = new Set([inp.deployer, deployerFunder].filter(Boolean));
    for (const m of C.keys()) { linked.add(m); const f = effectiveFunder(m, inp, cfg, isExchange); if (f) linked.add(f); }
    for (const b of early) if (!C.has(b.wallet) && fundersOf(b.wallet).some((f) => linked.has(f))) grew = add(b.wallet, 'funded by deployer/cluster funding trail') || grew;
    return grew;
  };
  const rule2 = () => {
    let grew = false;
    for (const b of early) {
      if (inp.creation && b.slot === inp.creation.slot) grew = add(b.wallet, 'bought in the creation slot') || grew;
      if (inp.creation?.bundleId && b.bundleId === inp.creation.bundleId) grew = add(b.wallet, 'same Jito bundle as the creation tx') || grew;
    }
    return grew;
  };
  const rule3 = () => { let grew = false; for (const w of inp.deployerLinks || []) if (!isExchange(w)) grew = add(w, 'direct transfer with the deployer') || grew; return grew; };

  // pass 1
  rule1(); rule2(); rule3();
  const freshMs = (cfg.fresh_wallet_max_age_min ?? 60) * 60_000;
  for (const b of early) {
    const at = inp.wallets[b.wallet]?.firstTxAt;
    if (at != null && inp.creation?.at != null && inp.creation.at - at < freshMs) add(b.wallet, 'fresh wallet (first tx < fresh_wallet_max_age_min before creation)');
  }
  const groups = {};
  for (const b of early) { const f = effectiveFunder(b.wallet, inp, cfg, isExchange); if (f) (groups[f] ||= new Set()).add(b.wallet); }
  for (const [f, ws] of Object.entries(groups)) if (ws.size >= (cfg.shared_funder_min_group ?? 3)) for (const w of ws) add(w, `3+ early buyers share funder ${f.slice(0, 6)}`);
  // pass 2: (1)-(3) once more with the new members, then stop
  rule1(); rule2(); rule3();
  return { members: C, size: C.size, earlyInCluster: [...C.keys()].filter((w) => earlySet.has(w)).length, deployerFunder };
}

// supply share, always excluding the pool account(s) and burn addresses (pack: Terms)
export function clusterShare(balances, members, supply, exclude = new Set()) {
  const S = Number(supply); if (!S) return null;
  let sum = 0;
  for (const [owner, amt] of Object.entries(balances)) if (members.has(owner) && !exclude.has(owner)) sum += Number(amt);
  return (sum / S) * 100;
}
export function clusterHoldings(balances, members, exclude = new Set()) {
  let sum = 0; const per = {};
  for (const [owner, amt] of Object.entries(balances)) if (members.has(owner) && !exclude.has(owner)) { sum += Number(amt); per[owner] = Number(amt); }
  return { sum, per };
}
export function top10Share(holders, supply, exclude = new Set()) {
  const S = Number(supply); if (!S) return null;
  const real = holders.filter((h) => !exclude.has(h.owner) && !exclude.has(h.address)).sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 10);
  return (real.reduce((s, h) => s + Number(h.amount), 0) / S) * 100;
}
