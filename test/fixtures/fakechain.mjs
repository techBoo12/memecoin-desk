// A tiny scripted Solana for tests: one fresh pump.fun graduate with a known insider cluster.
// Shapes copy the real jsonParsed RPC answers read on Oct 31 2026. No network.
import { b58encode, PUMP_PROGRAM, PUMPSWAP_PROGRAM, WSOL } from '../../src/playbook/solana.js';

export const addr = (n) => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 7 : (n * 31 + i) % 256)));
export const A = Object.fromEntries(['MINT', 'POOL', 'CURVE', 'DEP', 'F0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'F9', 'F6', 'F7', 'L1', 'LP', 'BV', 'QV', 'PCREATOR', 'NEW', 'EXCH', 'X1', 'X2']
  .map((k, i) => [k, addr(i + 1)]));
export const ta = (owner) => addr(200 + Object.values(A).indexOf(owner));
export const TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const SUPPLY = 1e15;
const CREATED = Date.parse('2026-10-31T04:00:00Z');
const MIGRATED = CREATED + 6 * 60_000;

function poolB64(lpSupply = 4_000_000_000_000n) {
  const d = new Uint8Array(301);
  const put = (o, a) => { const s = a; let n = 0n; for (const c of s) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c)); for (let i = 31; i >= 0; i--) { d[o + i] = Number(n & 255n); n >>= 8n; } };
  put(11, A.PCREATOR); put(43, A.MINT); put(75, WSOL); put(107, A.LP); put(139, A.BV); put(171, A.QV);
  let v = lpSupply; for (let i = 0; i < 8; i++) { d[203 + i] = Number(v & 255n); v >>= 8n; }
  put(211, A.DEP);
  return btoa(String.fromCharCode(...d));
}

const tb = (i, owner, amount, mint = A.MINT) => ({ accountIndex: i, mint, owner, uiTokenAmount: { amount: String(amount) } });
function tx({ slot, at, keys, signer, pre = [], post = [], preB, postB, ins = [] }) {
  return { slot, blockTime: Math.floor(at / 1000), meta: { err: null, preBalances: preB || keys.map(() => 0), postBalances: postB || keys.map(() => 0), preTokenBalances: pre, postTokenBalances: post, innerInstructions: [] },
    transaction: { message: { accountKeys: keys.map((k, i) => ({ pubkey: k, signer: k === signer || i === 0 })), instructions: ins } } };
}
const sys = (source, destination, lamports) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports } } });
// a buy: wallet gets `amt` from the curve
const buy = (wallet, amt, slot, payer = wallet) => tx({ slot, at: CREATED + (slot - 100) * 400, signer: payer, keys: [payer, A.MINT, ta(wallet), ta(A.CURVE), PUMP_PROGRAM],
  pre: [tb(2, wallet, 0), tb(3, A.CURVE, 1e15)], post: [tb(2, wallet, amt), tb(3, A.CURVE, 1e15 - amt)] });
// a wallet's first tx: funder sends it SOL
const fund = (wallet, funder, lamports, at) => tx({ slot: 50, at, signer: funder, keys: [funder, wallet, '11111111111111111111111111111111'], preB: [1e12, 0, 1], postB: [1e12 - lamports - 5000, lamports, 1], ins: [sys(funder, wallet, lamports)] });

export function makeChain() {
  const S = {
    bal: { [ta(A.DEP)]: 5e13, [ta(A.B1)]: 4e13, [ta(A.B2)]: 3e13, [ta(A.B3)]: 1e13, [ta(A.B4)]: 1e13, [ta(A.B5)]: 1e13, [ta(A.B6)]: 2e13, [ta(A.B7)]: 1e13, [A.BV]: 7e14 },
    owners: { [ta(A.DEP)]: A.DEP, [ta(A.B1)]: A.B1, [ta(A.B2)]: A.B2, [ta(A.B3)]: A.B3, [ta(A.B4)]: A.B4, [ta(A.B5)]: A.B5, [ta(A.B6)]: A.B6, [ta(A.B7)]: A.B7, [A.BV]: A.POOL },
    solReserve: 100e9, lpSupply: 4_000_000_000_000n, mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'metadataPointer', state: {} }],
    splitTx: null, calls: [],
  };
  const sigs = {
    creation: { signature: 'c', slot: 100, err: null }, e1: { signature: 'e1', slot: 100 }, e2: { signature: 'e2', slot: 101 }, e3: { signature: 'e3', slot: 102 }, e4: { signature: 'e4', slot: 102 },
    e5: { signature: 'e5', slot: 102 }, e6: { signature: 'e6', slot: 103 }, e7: { signature: 'e7', slot: 103 }, late: { signature: 'late', slot: 400 },
  };
  const TX = {
    c: tx({ slot: 100, at: CREATED, signer: A.DEP, keys: [A.DEP, A.MINT, ta(A.CURVE), ta(A.DEP), PUMP_PROGRAM], pre: [], post: [tb(2, A.CURVE, 1e15 - 5e13), tb(3, A.DEP, 5e13)] }),
    e1: buy(A.B1, 4e13, 100), e2: buy(A.B2, 3e13, 101), e3: buy(A.B3, 1e13, 102), e4: buy(A.B4, 1e13, 102), e5: buy(A.B5, 1e13, 102), e6: buy(A.B6, 2e13, 103), e7: buy(A.B7, 1e13, 103),
    late: buy(A.X1, 1e12, 400),
    mig: tx({ slot: 900, at: MIGRATED, signer: A.X2, keys: [A.X2, A.POOL, PUMP_PROGRAM, PUMPSWAP_PROGRAM] }),
    // first txs (funding) of each wallet
    fD: fund(A.DEP, A.F0, 2e9, CREATED - 3 * 86400_000), fB2: fund(A.B2, A.DEP, 1e9, CREATED - 5 * 60_000),
    fB3: fund(A.B3, A.F9, 5e8, CREATED - 86400_000), fB4: fund(A.B4, A.F9, 5e8, CREATED - 86400_000), fB5: fund(A.B5, A.F9, 5e8, CREATED - 86400_000),
    fB7: fund(A.B7, A.F7, 5e8, CREATED - 10 * 60_000), fB1: fund(A.B1, A.F6, 5e8, CREATED - 30 * 86400_000), fF0: fund(A.F0, A.EXCH, 9e9, CREATED - 90 * 86400_000),
    // deployer -> L1 (a link) + a jito tip (not a link), before creation
    pre1: tx({ slot: 90, at: CREATED - 60_000, signer: A.DEP, keys: [A.DEP, A.L1, TIP], ins: [sys(A.DEP, A.L1, 1e9), sys(A.DEP, TIP, 1e5)] }),
  };
  const firstOf = { [A.DEP]: 'fD', [A.B2]: 'fB2', [A.B3]: 'fB3', [A.B4]: 'fB4', [A.B5]: 'fB5', [A.B7]: 'fB7', [A.B1]: 'fB1', [A.F0]: 'fF0' };
  const tokAcct = (k) => ({ owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { parsed: { type: 'account', info: { owner: S.owners[k], mint: A.MINT, tokenAmount: { amount: String(S.bal[k] ?? 0) } } } } });
  async function rpc(method, params) {
    S.calls.push(method);
    const [p0, p1] = params;
    switch (method) {
      case 'getAccountInfo': return p0 === A.POOL ? { value: { owner: PUMPSWAP_PROGRAM, data: [poolB64(S.lpSupply), 'base64'] } } : { value: null };
      case 'getSignaturesForAddress': {
        if (p0 === A.POOL) return [{ signature: 'mig', slot: 900, blockTime: Math.floor(MIGRATED / 1000) }];
        if (p0 === A.MINT) return [sigs.late, sigs.e7, sigs.e6, sigs.e5, sigs.e4, sigs.e3, sigs.e2, sigs.e1, sigs.creation];
        if (p0 === A.B6) return Array.from({ length: 1000 }, (_, i) => ({ signature: `b6_${i}`, slot: 1000 - i, blockTime: Math.floor((CREATED - i * 600_000) / 1000) }));
        if (p0 === A.DEP) return [{ signature: 'c', slot: 100 }, { signature: 'pre1', slot: 90 }, { signature: 'fD', slot: 50, blockTime: Math.floor((CREATED - 3 * 86400_000) / 1000) }];
        if (firstOf[p0]) return [{ signature: firstOf[p0], slot: 50, blockTime: TX[firstOf[p0]].blockTime }];
        if (S.splitTx && p0 === S.splitTx.from) return [{ signature: 'split', slot: 950 }];
        return [];
      }
      case 'getTransaction': return p0 === 'split' ? S.splitTx.tx : TX[p0] || null;
      case 'getMultipleAccounts': return { value: p0.map((k) => {
        if (k === A.MINT) return { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { parsed: { type: 'mint', info: { mintAuthority: S.mintAuthority, freezeAuthority: S.freezeAuthority, supply: String(SUPPLY), decimals: 6, extensions: S.extensions } } } };
        if (k === A.LP) return { data: { parsed: { info: { supply: '0' } } } };
        if (k === A.QV) return { data: { parsed: { info: { tokenAmount: { amount: String(S.solReserve) } } } } };
        if (k === A.POOL) return { owner: PUMPSWAP_PROGRAM, data: [poolB64(S.lpSupply), 'base64'] };
        if (k in S.bal) return tokAcct(k);
        return null;
      }) };
      case 'getTokenLargestAccounts': return { value: Object.entries(S.bal).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([address, amount]) => ({ address, amount: String(amount) })) };
      case 'getTokenAccountsByOwner': return { value: Object.keys(S.bal).filter((k) => S.owners[k] === p0).map((pubkey) => ({ pubkey })) };
      case 'getRecentPrioritizationFees': return [{ prioritizationFee: 1000 }, { prioritizationFee: 2000 }];
      default: throw new Error('fake rpc: ' + method);
    }
  }
  // B1 moves tokens to NEW (wallet splitting): a transfer, not a sell
  S.split = (amt) => {
    S.bal[ta(A.B1)] -= amt; S.bal[ta(A.NEW)] = amt; S.owners[ta(A.NEW)] = A.NEW;
    S.splitTx = { from: ta(A.B1), tx: tx({ slot: 950, at: Date.now(), signer: A.B1, keys: [A.B1, ta(A.B1), ta(A.NEW)], pre: [tb(1, A.B1, S.bal[ta(A.B1)] + amt), tb(2, A.NEW, 0)], post: [tb(1, A.B1, S.bal[ta(A.B1)]), tb(2, A.NEW, amt)] }) };
  };
  const io = {
    isOnCurve: () => true, // scripted names are not real keys; real pools are off-curve (tested apart)
    rpc, jitoBundleOf: async (sig) => (sig === 'c' ? 'bundle-1' : null), jitoBundleTxs: async () => ['c', 'e1'], jitoTipFloor: async () => 0.00001,
    rugcheck: async () => ({ risks: [], markets: [] }), goplus: async () => ({ mintable: { status: '0' }, freezable: { status: '0' }, closable: { status: '0' }, balance_mutable_authority: { status: '0' } }),
    solPriceUsd: async () => 200,
    quote: async (inM, outM, amount) => { const price = (S.solReserve / 1e9) / (S.bal[A.BV] / 1e6); // SOL per token
      return inM === WSOL ? { outAmount: String(Math.floor((Number(amount) / 1e9 / price) * 1e6 * 0.99)), priceImpactPct: '0.001' } : { outAmount: String(Math.floor((Number(amount) / 1e6) * price * 1e9 * 0.99)), priceImpactPct: '0.001' }; },
    getJSON: async (url) => (url.includes('geckoterminal') ? { ok: true, data: { data: url.includes('page=1') ? [{ relationships: { dex: { data: { id: 'pumpswap' } }, base_token: { data: { id: 'solana_' + A.MINT } } }, attributes: { address: A.POOL, name: 'TEST / SOL', pool_created_at: new Date(MIGRATED).toISOString() } }] : [] } }
      : url.includes('search') ? { ok: true, data: { pairs: [] } } : { ok: true, data: [] }),
  };
  return { S, io, CREATED, MIGRATED, SUPPLY };
}
