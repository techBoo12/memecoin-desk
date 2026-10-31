// ============================================================================
// SMART WALLETS + COPY LANE helpers (her ask, Oct 31 2026: "copy smart wallets", PAPER ONLY)
// Pure functions shared by the daily list builder (tools/smart_wallets.mjs, runs on Tab's box)
// and the worker (copy signal from Helius webhook pushes).
//
// HONEST LABEL: a "smart wallet" here is a STATISTICAL label read from public on-chain
// trades: it bought early into several recent pump.fun graduates that later went 5x+,
// and its own realized PnL / win rate over the last days is positive. That is past
// performance on a small sample, not proof of skill, not proof of insider knowledge,
// and it says nothing about its next trade. Wallets can be bots, can rotate, can be
// the same person as a dev crew, and can stop being good tomorrow.
// Paper only: nothing here signs, sends or holds keys.
// ============================================================================
export const WSOL = 'So11111111111111111111111111111111111111112';
export const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export function keysOf(tx) {
  const m = tx?.transaction?.message || {};
  const ks = (m.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const la = tx?.meta?.loadedAddresses || {};
  return [...ks, ...(la.writable || []), ...(la.readonly || [])];
}
const amt = (b) => Number(b?.uiTokenAmount?.amount || 0);

// the wallet's SOL change in this tx: native lamports (fee + rent included, so PnL is net) + its wSOL token accounts
export function solDelta(tx, wallet) {
  const ks = keysOf(tx), i = ks.indexOf(wallet), meta = tx.meta || {};
  let lam = i >= 0 ? Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0) : 0;
  const w = tokenDeltasOf(tx, wallet)[WSOL];
  if (w) lam += w.delta;
  return lam / 1e9;
}

// token balance changes of every token account OWNED by wallet, summed per mint (raw units)
export function tokenDeltasOf(tx, wallet) {
  const out = {}, meta = tx?.meta || {};
  const add = (b, sign) => {
    if (b.owner !== wallet) return;
    const o = (out[b.mint] ||= { delta: 0, dec: b.uiTokenAmount?.decimals ?? 6, post: 0 });
    o.delta += sign * amt(b);
    if (sign > 0) o.post += amt(b);
  };
  for (const b of meta.preTokenBalances || []) add(b, -1);
  for (const b of meta.postTokenBalances || []) add(b, +1);
  return out;
}

// what this wallet did in this tx: one SOL-quoted buy or sell of one token, or 'other'
export function tradeOf(tx, wallet, { minSol = 0.01 } = {}) {
  if (!tx || tx.meta?.err) return { side: 'other' };
  const td = Object.entries(tokenDeltasOf(tx, wallet)).filter(([m, d]) => m !== WSOL && !STABLES.has(m) && d.delta !== 0);
  const at = (tx.blockTime || 0) * 1000;
  if (td.length !== 1) return { side: 'other', at };
  const [mint, d] = td[0];
  const sol = solDelta(tx, wallet);
  const ks = keysOf(tx);
  const pumpswap = ks.includes(PUMPSWAP);
  const base = { mint, tokens: d.delta / 10 ** d.dec, raw: d.delta, dec: d.dec, sol, at, pumpswap, pool: pumpswap ? poolOf(tx, mint) : null, sig: tx.transaction?.signatures?.[0] };
  if (d.delta > 0 && sol <= -minSol) return { side: 'buy', ...base };
  if (d.delta < 0 && sol >= minSol) return { side: 'sell', ...base };
  return { side: d.delta < 0 ? 'out' : 'in', ...base }; // a transfer: tokens moved without SOL coming back (PnL can't be read)
}

// the PumpSwap pool in a swap = the owner holding both this mint and wSOL after the tx
export function poolOf(tx, mint) {
  const post = tx?.meta?.postTokenBalances || [];
  const ws = new Map(post.filter((b) => b.mint === WSOL).map((b) => [b.owner, amt(b)]));
  let best = null;
  for (const b of post) if (b.mint === mint && ws.has(b.owner) && (!best || ws.get(b.owner) > best.sol)) best = { pool: b.owner, sol: ws.get(b.owner), tok: amt(b) };
  return best?.pool || null;
}

// a pump.fun migration tx (pump.fun's migration account joins every graduation) -> pool, mint, start reserves
export function parseMigration(tx) {
  if (!tx || tx.meta?.err) return null;
  if (!(tx.meta?.logMessages || []).some((l) => /Instruction: Migrate/.test(l))) return null;
  const post = tx.meta.postTokenBalances || [];
  const ws = new Map(post.filter((b) => b.mint === WSOL).map((b) => [b.owner, amt(b)]));
  let best = null;
  for (const b of post) {
    if (b.mint === WSOL || !ws.has(b.owner) || amt(b) <= 0) continue;
    const solRes = ws.get(b.owner) / 1e9, tokRes = amt(b) / 10 ** (b.uiTokenAmount?.decimals ?? 6);
    if (!best || solRes > best.solRes) best = { mint: b.mint, pool: b.owner, solRes, tokRes };
  }
  if (!best) return null;
  return { ...best, priceSol: best.solRes / best.tokRes, at: (tx.blockTime || 0) * 1000, sig: tx.transaction?.signatures?.[0] };
}

// early buyers of one graduate: wallets whose buy landed within windowMin of the migration (the bot's own niche, R14)
export function earlyBuyers(txs, { mint, migratedAt, windowMin = 10, minSol = 0.05, skip = [] } = {}) {
  const out = new Map(), sk = new Set(skip);
  for (const tx of txs) {
    const at = (tx.blockTime || 0) * 1000;
    if (at < migratedAt || at > migratedAt + windowMin * 60_000) continue;
    const signer = keysOf(tx)[0];
    if (!signer || sk.has(signer)) continue;
    const t = tradeOf(tx, signer, { minSol });
    if (t.side !== 'buy' || t.mint !== mint) continue;
    const o = out.get(signer) || { wallet: signer, sol: 0, firstAt: at, n: 0 };
    o.sol += -t.sol; o.n++; o.firstAt = Math.min(o.firstAt, at);
    out.set(signer, o);
  }
  return [...out.values()];
}

// realized PnL per token from one wallet's own recent txs. A position counts as CLOSED when the
// wallet sold >= closedPct of what it bought inside the window; tokens bought before the window or
// moved out without SOL coming back are not scored (we can't read their PnL honestly).
export function walletStats(txs, wallet, { closedPct = 90 } = {}) {
  const per = {};
  let first = Infinity, last = 0, n = 0;
  for (const tx of [...txs].sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0))) {
    const at = (tx.blockTime || 0) * 1000; n++;
    first = Math.min(first, at); last = Math.max(last, at);
    const t = tradeOf(tx, wallet);
    if (t.side === 'other') continue;
    const p = (per[t.mint] ||= { mint: t.mint, bought: 0, sold: 0, spent: 0, got: 0, moved: 0, firstBuyAt: null, lastSellAt: null, preWindowSell: false });
    if (t.side === 'buy') { p.bought += t.tokens; p.spent += -t.sol; p.firstBuyAt = Math.min(p.firstBuyAt ?? at, at); }
    else if (t.side === 'sell') { if (!p.bought && p.firstBuyAt == null) p.preWindowSell = true; p.sold += -t.tokens; p.got += t.sol; p.lastSellAt = Math.max(p.lastSellAt ?? 0, at); }
    else if (t.side === 'out') p.moved += -t.tokens;
  }
  const closed = [], open = [];
  for (const p of Object.values(per)) {
    if (!p.bought || p.preWindowSell && p.sold > p.bought * 1.05) continue; // bought before our window: not scorable
    if (p.moved > p.bought * 0.1) continue; // moved tokens out without selling: PnL unreadable
    if (p.sold >= p.bought * (closedPct / 100)) closed.push({ ...p, pnlSol: p.got - p.spent, holdMin: p.lastSellAt && p.firstBuyAt ? (p.lastSellAt - p.firstBuyAt) / 60000 : null });
    else open.push(p);
  }
  const wins = closed.filter((c) => c.pnlSol > 0);
  const pnlSol = closed.reduce((s, c) => s + c.pnlSol, 0);
  const spanDays = n ? Math.max((last - first) / 86_400_000, 1 / 24) : 0;
  const holds = closed.map((c) => c.holdMin).filter((x) => x != null).sort((a, b) => a - b);
  return {
    wallet, txs: n, spanDays: +spanDays.toFixed(2), txPerDay: n ? +(n / spanDays).toFixed(1) : 0,
    closed: closed.length, wins: wins.length, winRate: closed.length ? +(wins.length / closed.length).toFixed(3) : null,
    pnlSol: +pnlSol.toFixed(3), spentSol: +closed.reduce((s, c) => s + c.spent, 0).toFixed(3), open: open.length,
    roiPct: closed.length ? +((pnlSol / Math.max(1e-9, closed.reduce((s, c) => s + c.spent, 0))) * 100).toFixed(2) : null,
    medianHoldMin: holds.length ? +holds[Math.floor(holds.length / 2)].toFixed(1) : null,
    best: closed.sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 3).map((c) => ({ mint: c.mint, pnlSol: +c.pnlSol.toFixed(3) })),
  };
}

// the gate + score. Every threshold is a guess (config.playbook.copy.list), tune by results.
export function scoreWallet(s, c = {}) {
  // first real build (Oct 31 07:20 UTC): 2 of 60 early buyers passed with minPnlSol 0.5; several 85-90% win-rate wallets
  // made 0.3 SOL in under a day. 0.25 SOL keeps those, still refuses losers and tiny samples.
  const g = { minClosed: 5, minWinRate: 0.4, minPnlSol: 0.25, maxTxPerDay: 300, minMedianHoldMin: 0.5, ...c };
  if (s.closed < g.minClosed) return { ok: false, why: `only ${s.closed} closed trades (< ${g.minClosed})` };
  if (s.winRate < g.minWinRate) return { ok: false, why: `win rate ${(s.winRate * 100).toFixed(0)}% (< ${g.minWinRate * 100}%)` };
  if (s.pnlSol < g.minPnlSol) return { ok: false, why: `realized ${s.pnlSol} SOL (< ${g.minPnlSol})` };
  if (s.txPerDay > g.maxTxPerDay) return { ok: false, why: `${s.txPerDay} txs/day: bot-like, and too costly to watch` };
  if (s.medianHoldMin != null && s.medianHoldMin < g.minMedianHoldMin) return { ok: false, why: `median hold ${s.medianHoldMin} min: same-block flipper / MEV, not copyable` };
  // pnl, weighted by win rate, damped while the sample is small
  const score = s.pnlSol * (0.5 + s.winRate) * Math.min(1, s.closed / 10);
  return { ok: true, score: +score.toFixed(3) };
}

// keep the best ones that fit the daily webhook budget (Helius charges 1 credit per pushed tx)
export function pickList(scored, { max = 30, hookBudgetDay = 2500 } = {}) {
  const out = []; let load = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (out.length >= max) break;
    if (load + s.txPerDay > hookBudgetDay) continue;
    out.push(s); load += s.txPerDay;
  }
  return { list: out, expectedEventsDay: Math.round(load) };
}

// ---------- runtime (worker): the copy signal
// C = S.copy: { buys: { mint: [{w, at, sol, pool}] }, sells: { mint: { w: tokensSold } }, fired: { mint: at } }
export function recordSmartTrade(C, t, wallet, now = Date.now()) {
  C.buys ||= {}; C.sells ||= {};
  if (t.side === 'buy') {
    const arr = (C.buys[t.mint] ||= []);
    if (!arr.some((x) => x.sig && x.sig === t.sig)) arr.push({ w: wallet, at: t.at || now, sol: +(-t.sol).toFixed(4), tokens: t.tokens, pool: t.pool, pumpswap: t.pumpswap, sig: t.sig });
  } else if (t.side === 'sell' || t.side === 'out') {
    const m = (C.sells[t.mint] ||= {});
    m[wallet] = (m[wallet] || 0) + -t.tokens;
  }
}
export function pruneSmartTrades(C, now = Date.now(), keepMin = 120) {
  for (const [m, arr] of Object.entries(C.buys || {})) { const k = arr.filter((x) => now - x.at < keepMin * 60_000); if (k.length) C.buys[m] = k; else { delete C.buys[m]; delete (C.sells || {})[m]; } }
  for (const [m, t] of Object.entries(C.fired || {})) if (now - t > 24 * 3.6e6) delete C.fired[m];
}
// >= minWallets DISTINCT smart wallets bought this coin on PumpSwap inside windowMin -> a copy candidate
export function copyTrigger(C, mint, now, { minWallets = 2, windowMin = 15 } = {}) {
  if (C.fired?.[mint]) return null;
  const recent = (C.buys?.[mint] || []).filter((x) => x.pumpswap && now - x.at <= windowMin * 60_000);
  const ws = [...new Set(recent.map((x) => x.w))];
  if (ws.length < minWallets) return null;
  return { mint, wallets: ws, pool: recent.find((x) => x.pool)?.pool || null, sol: +recent.reduce((s, x) => s + x.sol, 0).toFixed(3), firstAt: Math.min(...recent.map((x) => x.at)) };
}
// how many of the wallets we copied have sold >= half of what they bought (the copy exit, C1)
export function smartExited(C, mint, wallets) {
  const bought = {};
  for (const x of C.buys?.[mint] || []) bought[x.w] = (bought[x.w] || 0) + (x.tokens || 0);
  const sold = C.sells?.[mint] || {};
  return wallets.filter((w) => bought[w] > 0 && (sold[w] || 0) >= bought[w] * 0.5).length;
}

// webhook auth: Helius sends this back in the Authorization header. Derived from the admin key so no new secret is
// needed and Helius never sees the admin key itself.
export async function hookToken(adminKey) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`memecoin-desk smart-hook v1:${adminKey}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '?');
