// ============================================================================
// ENTRY RULES (training pack 9.2: R1-R7 rug filter, R11/R13 execution, R14 niche,
// R15/R16 risk; plus section 2 second opinions and section 5/8 manipulation flags)
// Pure: each check returns { code, status: pass|fail|unknown, value, note }.
// Pack tip 4: hard filters are RULES, not model outputs. Unknown = skip.
// ============================================================================
const out = (code, status, value, note) => ({ code, status, value, note });
const f1 = (x) => (x == null || !Number.isFinite(Number(x)) ? 'n/a' : Number(x).toFixed(1));

// Token-2022 extensions that turn a memecoin into a trap (pack section 2 + R2)
export const TRAPS = { transferFeeConfig: 'transfer fee', transferHook: 'transfer hook', permanentDelegate: 'permanent delegate',
  nonTransferable: 'non-transferable', pausableConfig: 'pausable' };
export function trapExtensions(exts = []) {
  const hit = [];
  for (const e of exts) {
    if (TRAPS[e.name]) hit.push(TRAPS[e.name]);
    if (e.name === 'defaultAccountState' && /frozen/i.test(JSON.stringify(e.state || ''))) hit.push('default-frozen accounts');
  }
  return hit;
}

export function niche(build) { // R14 (gather decides it from the chain: PumpSwap pool, pump.fun migration, minutes since)
  if (build.fail?.code === 'R14') return out('R14', 'fail', build.fail.note, build.fail.note);
  return out('R14', 'pass', `${build.minutesSinceMigration} min since migration`, 'fresh pump.fun graduate');
}

export function riskChecks({ killSwitch, openInsider, holdingMint }, cfg) {
  return [
    killSwitch ? out('R15', 'fail', killSwitch, `kill switch on: ${killSwitch}`) : out('R15', 'pass', 'off'),
    holdingMint ? out('R16', 'fail', 'holding', 'never two positions in one token')
      : openInsider >= cfg.max_open_positions ? out('R16', 'fail', openInsider, `max ${cfg.max_open_positions} open positions`) : out('R16', 'pass', `${openInsider}/${cfg.max_open_positions}`),
  ];
}

// res = gather result; sim = { ok, roundTripLossPct, reason, unknown }; lp2 = rugcheck LP locked % (second source); solUsd
export function rugChecks({ res, sim, lp2 = null, solUsd }, cfg) {
  const r = [];
  const mi = res.mintInfo || {};
  r.push(mi.mintAuthority === undefined ? out('R1', 'unknown', null, 'mint not readable') : mi.mintAuthority ? out('R1', 'fail', mi.mintAuthority, 'mint authority not revoked') : out('R1', 'pass', 'revoked'));
  const traps = trapExtensions(mi.extensions);
  r.push(mi.freezeAuthority ? out('R2', 'fail', mi.freezeAuthority, 'freeze authority not revoked')
    : traps.length ? out('R2', 'fail', traps.join('+'), `Token-2022 trap: ${traps.join(', ')}`) : out('R2', 'pass', 'revoked, no trap extensions'));
  const lp = Math.max(res.lpBurnedPct ?? -1, lp2 ?? -1);
  r.push(lp < 0 ? out('R3', 'unknown', null, 'LP state unreadable')
    : lp >= cfg.min_lp_burned_or_locked_pct ? out('R3', 'pass', `${f1(lp)}%`, res.lpBurnedPct >= cfg.min_lp_burned_or_locked_pct ? 'burned on-chain' : 'locked (rugcheck)')
      : out('R3', 'fail', `${f1(lp)}%`, `only ${f1(lp)}% of LP burned/locked (< ${cfg.min_lp_burned_or_locked_pct}%)`));
  r.push(res.top10Pct == null ? out('R4', 'unknown', null, 'no holder list from free sources')
    : res.top10Pct <= cfg.max_top10_pct ? out('R4', 'pass', `${f1(res.top10Pct)}%`) : out('R4', 'fail', `${f1(res.top10Pct)}%`, `top10 hold ${f1(res.top10Pct)}% (> ${cfg.max_top10_pct}%)`));
  r.push(res.clusterPct == null ? out('R5', 'unknown', null, 'cluster share unknown')
    : res.clusterPct <= cfg.max_cluster_share_pct ? out('R5', 'pass', `${f1(res.clusterPct)}% (${res.cluster.size} wallets)`)
      : out('R5', 'fail', `${f1(res.clusterPct)}%`, `dev cluster (${res.cluster.size} wallets) holds ${f1(res.clusterPct)}% (> ${cfg.max_cluster_share_pct}%)`));
  const liq = liquidityUsd(res.reserves, solUsd);
  r.push(liq == null ? out('R6', 'unknown', null, 'no reserves / SOL price')
    : liq >= cfg.min_liquidity_usd ? out('R6', 'pass', `$${Math.round(liq)}`) : out('R6', 'fail', `$${Math.round(liq)}`, `pool liquidity $${Math.round(liq)} < $${cfg.min_liquidity_usd}`));
  r.push(!sim ? out('R7', 'unknown', null, 'sell simulation not run')
    : sim.unknown ? out('R7', 'unknown', null, sim.reason)
      : !sim.ok ? out('R7', 'fail', sim.reason, sim.reason)
        : sim.roundTripLossPct > cfg.max_sim_roundtrip_loss_pct ? out('R7', 'fail', `${sim.roundTripLossPct}%`, `round trip lost ${sim.roundTripLossPct}% (> ${cfg.max_sim_roundtrip_loss_pct}%)`)
          : out('R7', 'pass', `-${sim.roundTripLossPct}%`));
  return r;
}

// constant-product pool (x*y=k, pack section 1): both sides hold equal value, so liquidity = 2 x SOL side
export const liquidityUsd = (reserves, solUsd) => (reserves?.sol > 0 && solUsd ? reserves.sol * 2 * solUsd : null);

// second opinion (pack section 2: "compute the checks yourself, use checker APIs as a second opinion")
export function secondOpinion({ goplus, rugcheck }) {
  const hard = [];
  const warn = [];
  if (goplus) {
    for (const k of ['mintable', 'freezable', 'closable', 'balance_mutable_authority']) if (String(goplus[k]?.status) === '1') hard.push(`goplus: ${k}`);
    if (Array.isArray(goplus.transfer_hook) && goplus.transfer_hook.length) hard.push('goplus: transfer_hook');
    const fee = goplus.transfer_fee; if (fee && Object.keys(fee).length && Number(fee.current_fee_rate?.fee_rate || fee.fee_rate || 0) > 0) hard.push('goplus: transfer_fee');
    if (String(goplus.metadata_mutable?.status) === '1') warn.push('goplus: metadata mutable');
  }
  if (rugcheck) {
    for (const r of rugcheck.risks || []) {
      const n = String(r.name || '');
      if (r.level === 'danger' && /mint|freeze|transfer fee|rugged|liquidity unlocked|LP Unlocked|creator history/i.test(n)) hard.push(`rugcheck: ${n}`);
      else if (r.level === 'danger' || r.level === 'warn') warn.push(`rugcheck: ${n}`);
    }
  }
  return { check: hard.length ? out('R2b', 'fail', hard.join('; '), `second opinion: ${hard.join('; ')}`) : out('R2b', 'pass', goplus || rugcheck ? 'clean' : 'no second opinion reachable (not blocking)'), warn };
}

// manipulation flags (pack section 5 "Meme Coin Factories" + section 8 "build your own labelled data")
export function manipulationChecks({ symbol, recentSymbols = {}, deployer, deployerFunder, rugDeployers = new Set(), earlyWash = 0, now = Date.now() }, cfg) {
  const r = [];
  const key = String(symbol || '').toLowerCase();
  const seenAt = recentSymbols[key];
  r.push(seenAt && now - seenAt < cfg.copycat_block_minutes * 60_000 ? out('M1', 'fail', symbol, `copycat: $${symbol} also launched ${Math.round((now - seenAt) / 60000)} min ago`) : out('M1', 'pass', 'no copy in window'));
  const rugger = cfg.known_rugger_block && (rugDeployers.has(deployer) || (deployerFunder && rugDeployers.has(deployerFunder)));
  r.push(rugger ? out('M5', 'fail', deployer, 'deployer or its funder made a coin we labelled RUG') : out('M5', 'pass', 'no RUG history in our labels'));
  r.push(out('M2', earlyWash ? 'warn' : 'pass', earlyWash, earlyWash ? `${earlyWash} early wallets bought and sold inside the first slots (wash pattern)` : 'no early wash pattern'));
  return r;
}

export function execChecks({ impactBps, feeSol }, cfg) {
  return [
    impactBps == null ? out('R11', 'unknown', null, 'no entry quote')
      : impactBps <= cfg.max_slippage_bps ? out('R11', 'pass', `${impactBps} bps`) : out('R11', 'fail', `${impactBps} bps`, `entry needs ${impactBps} bps > cap ${cfg.max_slippage_bps}: never raise the cap to get in`),
    feeSol == null ? out('R13', 'unknown', null, 'fee estimate unavailable')
      : feeSol <= cfg.max_priority_fee ? out('R13', 'pass', `${feeSol.toFixed(5)} SOL`) : out('R13', 'fail', `${feeSol.toFixed(5)} SOL`, `priority fee + tip ${feeSol.toFixed(5)} SOL > ${cfg.max_priority_fee}`),
  ];
}

// first failing (or unknown) check, in the order given; 'warn' never blocks
export function decide(checks) {
  const bad = checks.find((c) => c.status === 'fail' || c.status === 'unknown');
  return { ok: !bad, failed: bad || null };
}
