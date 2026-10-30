// ============================================================================
// FILTER: the 8 kill rules
// Job: kill anything that can rug us. ONE hit = dead. Every kill is logged
//      with the rule and the number that broke it.
// Data: DexScreener pair data + RugCheck free API (api.rugcheck.xyz).
// HARD STOP: the filter never scores and never trades. It cannot "rescue" a
//            coin. If a rule cannot be checked with free data it says
//            "unknown" out loud, and config decides if unknown = dead.
// ============================================================================
import { getJSON } from '../lib/http.js';

const rcCache = new Map(); // mint -> { at, data }

export async function rugcheckReport(mint) {
  const hit = rcCache.get(mint);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const r = await getJSON(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { minGapMs: 700, timeoutMs: 20000 });
  const data = r.ok ? r.data : null;
  rcCache.set(mint, { at: Date.now(), data });
  return data;
}

const pct = (raw, supply) => (supply ? (Number(raw) / Number(supply)) * 100 : null);
const pass = (value, note) => ({ status: 'pass', value, note });
const kill = (value, note) => ({ status: 'kill', value, note });
const unknown = (note) => ({ status: 'unknown', value: null, note });

export const KILL_RULES = [
  {
    id: 'mint_freeze', n: 1, name: 'mint/freeze authority not revoked',
    check: (c, rc) => {
      if (!rc) return unknown('rugcheck report unavailable');
      const live = [rc.token?.mintAuthority && 'mint', rc.token?.freezeAuthority && 'freeze'].filter(Boolean);
      return live.length ? kill(live.join('+'), `${live.join(' + ')} authority still live`) : pass('revoked');
    },
  },
  {
    id: 'lp_locked', n: 2, name: 'LP not burned/locked',
    check: (c, rc, cfg) => {
      if (!rc?.markets?.length) return unknown('no LP data from rugcheck');
      const m = rc.markets.find((x) => x.pubkey === c.pairAddress)
        || [...rc.markets].sort((a, b) => (b.lp?.lpLockedUSD || 0) - (a.lp?.lpLockedUSD || 0))[0];
      const locked = Number(m?.lp?.lpLockedPct);
      if (!Number.isFinite(locked)) return unknown('LP lock % missing');
      return locked < cfg.minLpLockedPct ? kill(`${locked.toFixed(1)}%`, `only ${locked.toFixed(1)}% of LP burned/locked`) : pass(`${locked.toFixed(1)}%`);
    },
  },
  {
    id: 'liquidity', n: 3, name: 'liquidity < $40k',
    check: (c, rc, cfg) => c.liqUsd < cfg.minLiquidityUsd ? kill(usd(c.liqUsd), `liq ${usd(c.liqUsd)} < ${usd(cfg.minLiquidityUsd)}`) : pass(usd(c.liqUsd)),
  },
  {
    id: 'volume_1h', n: 4, name: '1h volume < $50k',
    check: (c, rc, cfg) => c.vol.h1 < cfg.minVolume1hUsd ? kill(usd(c.vol.h1), `1h vol ${usd(c.vol.h1)} < ${usd(cfg.minVolume1hUsd)}`) : pass(usd(c.vol.h1)),
  },
  {
    id: 'top10', n: 5, name: 'top 10 holders > 25%',
    check: (c, rc, cfg) => {
      if (!rc?.topHolders?.length) return unknown('no holder list from rugcheck');
      // pool + locker accounts are not "holders": skip anything owned by a market or known AMM/locker
      const skip = new Set((rc.markets || []).flatMap((m) => [m.pubkey, m.liquidityA, m.liquidityB]));
      for (const [addr, k] of Object.entries(rc.knownAccounts || {})) if (/AMM|LOCKER/i.test(k.type)) skip.add(addr);
      const real = rc.topHolders.filter((h) => !skip.has(h.owner) && !skip.has(h.address)).slice(0, 10);
      const sum = real.reduce((s, h) => s + (Number(h.pct) || 0), 0);
      return sum > cfg.maxTop10Pct ? kill(`${sum.toFixed(1)}%`, `top10 wallets hold ${sum.toFixed(1)}%`) : pass(`${sum.toFixed(1)}%`);
    },
  },
  {
    id: 'dev', n: 6, name: 'dev > 3% or past rugs',
    check: (c, rc, cfg) => {
      if (!rc) return unknown('rugcheck report unavailable');
      const devPct = pct(rc.creatorBalance || 0, rc.token?.supply);
      const rugFlag = (rc.risks || []).find((r) => /rug|creator history/i.test(r.name || ''));
      if (rugFlag) return kill(rugFlag.name, `dev flagged: ${rugFlag.name}`);
      if (devPct == null) return unknown('supply missing');
      if (devPct > cfg.maxDevPct) return kill(`${devPct.toFixed(1)}%`, `dev wallet holds ${devPct.toFixed(1)}%`);
      // honest: "past rugs" = only rugcheck's own creator-history flag, not a full dev history
      return pass(`${devPct.toFixed(2)}%`, 'past rugs: rugcheck flag only');
    },
  },
  {
    id: 'bundled', n: 7, name: 'bundled launch > 10%',
    check: (c, rc, cfg) => {
      if (!rc) return unknown('rugcheck report unavailable');
      // PROXY: rugcheck's linked-wallet clusters (wallets funded from the same source)
      // and holders it tags "insider". True launch-block bundle detection needs
      // paid/RPC tx history, so this is labelled a proxy in every log line.
      const nets = (rc.insiderNetworks || []).reduce((s, n) => s + (Number(n.currentHolding ?? n.tokenAmount) || 0), 0);
      const netPct = pct(nets, rc.token?.supply) || 0;
      const tagged = (rc.topHolders || []).filter((h) => h.insider).reduce((s, h) => s + (Number(h.pct) || 0), 0);
      const v = Math.max(netPct, tagged);
      return v > cfg.maxBundledPct ? kill(`${v.toFixed(1)}%`, `linked/insider wallets hold ${v.toFixed(1)}% (proxy)`) : pass(`${v.toFixed(1)}%`, 'proxy');
    },
  },
  {
    id: 'pumped_1h', n: 8, name: 'already +80% in 1h',
    check: (c, rc, cfg) => c.change.h1 > cfg.maxPump1hPct ? kill(`+${c.change.h1}%`, `already +${c.change.h1}% in 1h, late`) : pass(`${c.change.h1 >= 0 ? '+' : ''}${c.change.h1}%`),
  },
];

export async function filter(candidate, { config }) {
  const cfg = config.filter;
  const rc = await rugcheckReport(candidate.mint);
  const results = KILL_RULES.map((r) => ({ id: r.id, n: r.n, name: r.name, ...r.check(candidate, rc, cfg) }));
  const killedBy = results.find((r) => r.status === 'kill')
    || results.find((r) => r.status === 'unknown' && cfg.unknownIsKill.includes(r.id));
  return {
    alive: !killedBy,
    killedBy: killedBy ? { ...killedBy, note: killedBy.status === 'unknown' ? `unknown = dead (${killedBy.note})` : killedBy.note } : null,
    unknowns: results.filter((r) => r.status === 'unknown').map((r) => r.id),
    results,
    rc,
  };
}

export const usd = (x) => x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Number(x).toFixed(2)}`;
