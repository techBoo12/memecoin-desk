// ============================================================================
// SCOUT
// Job: find fresh Solana memecoin pairs (Pump.fun graduates on PumpSwap, and
//      Raydium pairs) that are 30 min to 72 h old with a $300k-$20M market cap.
// Data: DexScreener free API (no key).
// HARD STOP: the scout never judges, scores or trades. It only hands a list
//            of candidates to the filter. Anything outside the window is ignored.
// ============================================================================
import { getJSON } from '../lib/http.js';

const DS = 'https://api.dexscreener.com';
let geckoPage = 0;

export async function scout({ config, log, scanNo = 0, between = async () => {} }) {
  // `between` runs after every network call: the engine uses it to keep
  // watching open trades every few seconds while a scan is running
  const cfg = config.scout;
  const mints = new Set();
  const directPairs = [];

  // 1) where new coins show up first: fresh profiles, boosts, takeovers
  const feeds = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1', '/community-takeovers/latest/v1'];
  for (const path of feeds) {
    const r = await getJSON(DS + path, { minGapMs: 1100 }); await between();
    if (!r.ok || !Array.isArray(r.data)) { log.warn(`scout: feed ${path} failed (${r.status || r.error})`); continue; }
    if (r.data.length > 60) r.data.length = 60;
    for (const t of r.data) if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress);
  }

  // 2) live pair search on the dexes we care about. A rotating slice of the
  //    query list per scan keeps each scan small (Cloudflare free plan: 50
  //    outbound calls per step); every query still comes round every few scans.
  const per = cfg.searchQueriesPerScan || cfg.searchQueries.length;
  const start = (scanNo * per) % cfg.searchQueries.length;
  const queries = [...cfg.searchQueries, ...cfg.searchQueries].slice(start, start + per);
  if (cfg.meteora) queries.unshift('meteora'); // day 6: Meteora pairs (DLMM / DAMM v2) every scan, one extra free DexScreener call
  for (const q of queries) {
    const r = await getJSON(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`, { minGapMs: 300 }); await between();
    for (const p of r.data?.pairs || []) if (p.chainId === 'solana') { directPairs.push(p); mints.add(p.baseToken.address); }
  }

  // 2b) GeckoTerminal (free, tight rate limit): trending + busiest PumpSwap pools
  if (cfg.geckoTerminal) {
    geckoPage = (geckoPage % 3) + 1; // rotate pages across scans to stay under the free limit
    for (const path of [`/networks/solana/trending_pools?page=${geckoPage}`, `/networks/solana/dexes/pumpswap/pools?page=${geckoPage}`]) {
      const r = await getJSON(`https://api.geckoterminal.com/api/v2${path}`, { minGapMs: 4000, retries: 1 }); await between();
      if (!r.ok) { log.event('warn', { source: 'geckoterminal', path, status: r.status || r.error }); continue; }
      for (const pool of r.data?.data || []) {
        const id = pool.relationships?.base_token?.data?.id || '';
        if (id.startsWith('solana_')) mints.add(id.slice(7));
      }
    }
  }

  // 3) full pair data for every mint, 30 per call
  const list = [...mints];
  const pairs = [...directPairs];
  const maxBatches = cfg.maxTokenBatches || 8;
  for (let i = 0; i < list.length && i / 30 < maxBatches; i += 30) {
    const r = await getJSON(`${DS}/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`, { minGapMs: 300 }); await between();
    if (Array.isArray(r.data)) pairs.push(...r.data);
  }

  // best pair per token, on an allowed dex
  const best = new Map();
  for (const p of pairs) {
    if (p.chainId !== 'solana' || !(cfg.dexes.includes(p.dexId) || (cfg.meteora && p.dexId === 'meteora'))) continue;
    const mint = p.baseToken?.address;
    if (!mint || mint.endsWith('11111111111111111111111111111112')) continue;
    const prev = best.get(mint);
    if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) best.set(mint, p);
  }

  const now = Date.now();
  const candidates = [];
  for (const p of best.values()) {
    const c = normalize(p, now);
    if (c.ageMin == null || c.ageMin < cfg.minAgeMin || c.ageMin > cfg.maxAgeMin) continue;
    if (c.mcap < cfg.minMcapUsd || c.mcap > cfg.maxMcapUsd) continue;
    candidates.push(c);
  }
  candidates.sort((a, b) => b.vol.h1 - a.vol.h1);
  return { tokensSeen: mints.size, pairsInWindow: candidates.length, candidates: candidates.slice(0, cfg.maxCandidatesPerScan) };
}

export function normalize(p, now = Date.now()) {
  const n = (x) => Number(x) || 0;
  return {
    mint: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    priceUsd: n(p.priceUsd),
    liqUsd: n(p.liquidity?.usd),
    mcap: n(p.marketCap || p.fdv),
    ageMin: p.pairCreatedAt ? Math.round((now - p.pairCreatedAt) / 60000) : null,
    vol: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
    txns: {
      m5: { buys: n(p.txns?.m5?.buys), sells: n(p.txns?.m5?.sells) },
      h1: { buys: n(p.txns?.h1?.buys), sells: n(p.txns?.h1?.sells) },
      h6: { buys: n(p.txns?.h6?.buys), sells: n(p.txns?.h6?.sells) },
    },
    change: { m5: n(p.priceChange?.m5), h1: n(p.priceChange?.h1), h6: n(p.priceChange?.h6), h24: n(p.priceChange?.h24) },
  };
}

// price refresh for open positions (used by the risk desk every few seconds)
export async function refreshPairs(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const r = await getJSON(`${DS}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { minGapMs: 300 });
    for (const p of r.data || []) {
      const prev = out.get(p.baseToken.address);
      if (!prev || (p.liquidity?.usd || 0) > prev.liqUsd) out.set(p.baseToken.address, normalize(p));
    }
  }
  return out;
}
