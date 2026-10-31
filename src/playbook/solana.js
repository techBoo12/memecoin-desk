// ============================================================================
// SOLANA READ-ONLY CLIENT (training pack sections 3 + 9.1 A)
// Job: the free substitutes for the paid feeds the pack names.
//   - Helius / Yellowstone gRPC stream (paid key)  -> public JSON-RPC, polled
//   - Helius DAS getAsset (key)                     -> getMultipleAccounts jsonParsed (mint, authorities, Token-2022 extensions)
//   - Bitquery launches / bundles (key)             -> GeckoTerminal new_pools + getSignaturesForAddress + Jito's PUBLIC bundle explorer API
// Every call is a READ. No keys, no signing, no sending, ever.
// Plain fetch so the same code runs in Node and on Cloudflare Workers.
// ============================================================================
export const WSOL = 'So11111111111111111111111111111111111111112';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';      // pump.fun bonding curve
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';  // pump.fun's AMM (graduates migrate here)
export const SYSTEM = '11111111111111111111111111111111';
export const BURN_OWNERS = new Set(['1nc1nerator11111111111111111111111111111111', SYSTEM]);

// publicnode answers history fast but refuses "indexed" calls without a key and has no deep archive;
// api.mainnet-beta has the archive + parsed account reads but rate-limits hard (≈100 req / 10 s per IP).
const HISTORY = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const STATE = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const ARCHIVE = ['https://api.mainnet-beta.solana.com']; // only this one has the deep archive; a fallback would answer 'not found' for old txs
const HISTORY_METHODS = new Set(['getSignaturesForAddress', 'getTransaction', 'getAccountInfo', 'getSlot']);

export const rpcStats = { calls: 0, errors: 0, byMethod: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeRpc({ archive = false, minGapMs = 0, fetchImpl = fetch } = {}) {
  let last = 0;
  return async function rpc(method, params, { timeoutMs = 12000 } = {}) {
    const list = archive ? ARCHIVE : HISTORY_METHODS.has(method) ? HISTORY : STATE;
    let err;
    for (let attempt = 0; attempt < (archive ? 6 : 2); attempt++) {
      for (const url of list) {
        if (minGapMs) { const w = last + minGapMs - Date.now(); last = Math.max(Date.now(), last + minGapMs); if (w > 0) await sleep(w); }
        rpcStats.calls++; rpcStats.byMethod[method] = (rpcStats.byMethod[method] || 0) + 1;
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) { err = `HTTP ${res.status}`; continue; }
          const j = await res.json();
          if (j.error) { err = `${j.error.code} ${j.error.message}`; if (/not found|invalid/i.test(j.error.message) && !/personal token/.test(j.error.message)) continue; continue; }
          return j.result;
        } catch (e) { err = String(e?.message || e); }
      }
      if (/429|Too many|HTTP 5/i.test(err || '') && attempt < (archive ? 5 : 1)) await sleep(1500 * (attempt + 1));
      else break;
    }
    rpcStats.errors++;
    throw new Error(`rpc ${method}: ${err}`);
  };
}
export const rpc = makeRpc();

// Jito's public block-explorer API (no key): which bundle a tx landed in, and a bundle's txs
export async function jitoBundleOf(sig, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://bundles.jito.wtf/api/v1/bundles/transaction/${sig}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.[0]?.bundle_id || null;
  } catch { return null; }
}
export async function jitoBundleTxs(bundleId, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://bundles.jito.wtf/api/v1/bundles/bundle/${bundleId}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.[0]?.txSignatures || null;
  } catch { return null; }
}
export async function jitoTipFloorSol(fetchImpl = fetch) {
  try {
    const r = await fetchImpl('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return Number(j?.[0]?.landed_tips_50th_percentile) || null; // in SOL
  } catch { return null; }
}

// ---------- base58 + PumpSwap pool decode (layout checked on-chain Oct 31 2026: 301-byte account)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const u64 = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(d[o + i]); return v; };

export function decodePumpSwapPool(b64) {
  const d = b64bytes(b64);
  if (d.length < 243) return null;
  let o = 11; const key = () => { const k = b58encode(d.slice(o, o + 32)); o += 32; return k; };
  const pool = { index: d[9] | (d[10] << 8), creator: key(), baseMint: key(), quoteMint: key(), lpMint: key(), baseVault: key(), quoteVault: key() };
  pool.lpSupply = u64(d, o).toString(); o += 8;
  pool.coinCreator = d.length >= o + 32 ? b58encode(d.slice(o, o + 32)) : null;
  return pool;
}

// ---------- parsed-transaction helpers
export const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
export const signerOf = (tx) => { const k = tx.transaction.message.accountKeys[0]; return typeof k === 'string' ? k : k.pubkey; };

// owner -> { delta (raw), ta (token account), post } for one mint
export function tokenDeltas(tx, mint) {
  const keys = keysOf(tx); const out = {};
  const add = (b, sign) => {
    if (b.mint !== mint || !b.owner) return;
    const o = (out[b.owner] ||= { delta: 0n, ta: keys[b.accountIndex], post: 0n });
    o.delta += sign * BigInt(b.uiTokenAmount.amount);
    if (sign > 0n) o.post = BigInt(b.uiTokenAmount.amount);
  };
  for (const b of tx.meta?.preTokenBalances || []) add(b, -1n);
  for (const b of tx.meta?.postTokenBalances || []) add(b, 1n);
  return out;
}

// the wallet's first incoming SOL: in a wallet's first transaction, the account whose SOL dropped the most funded it
export function funderFromFirstTx(tx, wallet) {
  const keys = keysOf(tx); const i = keys.indexOf(wallet);
  if (i < 0) return null;
  const pre = tx.meta.preBalances, post = tx.meta.postBalances;
  const got = post[i] - pre[i];
  let best = null, drop = 0;
  for (let k = 0; k < keys.length; k++) { if (k === i) continue; const d = pre[k] - post[k]; if (d > drop) { drop = d; best = keys[k]; } }
  return got > 0 && best ? { funder: best, lamports: got, at: (tx.blockTime || 0) * 1000 } : null;
}

// direct (top-level) SOL and token transfers touching `wallet`. Inner CPI transfers (swap fees,
// pool moves) are ignored on purpose: they would "link" everyone to the fee account.
export function directTransfers(tx, wallet, mint) {
  const out = [];
  const keys = keysOf(tx);
  const owners = {};
  for (const b of [...(tx.meta?.preTokenBalances || []), ...(tx.meta?.postTokenBalances || [])]) owners[keys[b.accountIndex]] = { owner: b.owner, mint: b.mint };
  for (const ins of tx.transaction.message.instructions || []) {
    const p = ins.parsed; if (!p || typeof p !== 'object') continue;
    const i = p.info || {};
    if (ins.program === 'system' && p.type === 'transfer') {
      if (i.source === wallet && i.destination !== wallet) out.push({ kind: 'sol', dir: 'out', other: i.destination, lamports: i.lamports });
      if (i.destination === wallet && i.source !== wallet) out.push({ kind: 'sol', dir: 'in', other: i.source, lamports: i.lamports });
    }
    if ((ins.program === 'spl-token' || ins.program === 'spl-token-2022') && /^transfer/.test(p.type)) {
      const src = owners[i.source], dst = owners[i.destination];
      const m = i.mint || src?.mint || dst?.mint;
      if (mint && m !== mint) continue;
      const from = i.authority || i.multisigAuthority || src?.owner, to = dst?.owner;
      if (from === wallet && to && to !== wallet) out.push({ kind: 'token', dir: 'out', other: to, ta: i.destination });
      if (to === wallet && from && from !== wallet) out.push({ kind: 'token', dir: 'in', other: from, ta: i.source });
    }
  }
  return out;
}
