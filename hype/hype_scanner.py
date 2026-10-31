#!/usr/bin/env python3
"""
HYPE SCANNER (runs OFF the worker, on any box with python3 + requests)

Job: every few minutes, pull FREE trend sources (culture side + crypto side),
pull FRESH Solana coins (pump.fun, Meteora DBC / DAMM v2 / DLMM, other launchpads),
match "what the internet is talking about" to "coins that just launched",
score them, and push a short hype watchlist into the bot (POST /admin/hype).

Honest limits (tested from this box on Oct 31 2026, see hype/SOURCES.md):
  - X/Twitter search is NOT free: official API is paid, nitter is dead (C&D),
    the syndication timeline answers 429. What DOES work: reading ONE tweet by
    id (cdn.syndication.twimg.com/tweet-result). So for coins whose own X link is
    a tweet, we read that tweet's likes, age and author badge (that is how a
    $TRUMP-style launch shows up: the tweet came from a Government-badge account).
  - TikTok trends: Creative Center API answers "no permission" without a login. Not used.
  - Reddit JSON is blocked (403); Reddit RSS works but rate-limits hard (429). Best effort.
  - "Before it goes viral" is not promised: the earliest real signal we have is
    a coin named after something trending on Google / Wikipedia / Reddit /
    Bluesky / 4chan while crypto sites have not picked it up yet ("early" flag).
Paper only. This script never trades, never signs, never posts.

Run:  python3 hype/hype_scanner.py            # one scan, prints the watchlist, writes state/hype_last.json
      python3 hype/hype_scanner.py --push     # same, then POSTs it to the worker (/admin/hype)
      python3 hype/hype_scanner.py --loop 5 --push   # every 5 min (foreground; you decide where it runs)
Admin key: env HYPE_ADMIN_KEY, else state/cloudflare.json (adminKey, gitignored). Never printed.
"""
import argparse, json, math, os, re, sys, time, html
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("needs python3 requests")

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SOL = "So11111111111111111111111111111111111111112"
STABLES = {SOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}
MINT_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")

# words that match everything and mean nothing
STOP = set("""the a an and or of to in on for with by at from is are was be this that it its new
coin token sol solana meme memes pump fun official real first best top crypto inu ai agent baby
day news live video game games world usa us uk man woman city love time year one two dog cat
vs com app official token the""".split())

def now_ms():
    return int(time.time() * 1000)

def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())

def words(s):
    return [w for w in re.findall(r"[a-z0-9]+", str(s or "").lower()) if len(w) >= 4 and w not in STOP]

class Src:
    """one HTTP session; records per-source ok/count/latency for the report"""
    def __init__(self, timeout=12):
        self.s = requests.Session(); self.s.headers["User-Agent"] = UA
        self.timeout = timeout; self.health = {}
    def get(self, name, url, kind="json", **kw):
        t = time.time(); ok = False; out = None; code = None
        try:
            r = self.s.get(url, timeout=self.timeout, **kw); code = r.status_code
            if r.status_code == 200:
                out = r.json() if kind == "json" else r.text; ok = True
        except Exception as e:
            code = type(e).__name__
        self.health[name] = {"ok": ok, "status": code, "ms": int((time.time() - t) * 1000)}
        return out

# ---------------------------------------------------------------- culture side
def culture(src):
    """what people talk about OUTSIDE crypto sites. returns list of {phrase, src, weight}"""
    trends = []
    for geo in ("US", "GB", "NG", "CA", "AU", "IN"):
        x = src.get(f"google_trends_{geo}", f"https://trends.google.com/trending/rss?geo={geo}", kind="text")
        if not x: continue
        for item in re.findall(r"<item>(.*?)</item>", x, re.S):
            t = re.search(r"<title>(.*?)</title>", item); a = re.search(r"<ht:approx_traffic>([\d,]+)", item)
            if not t: continue
            traffic = int(a.group(1).replace(",", "")) if a else 100
            trends.append({"phrase": html.unescape(t.group(1)), "src": f"google:{geo}", "weight": min(1.0, 0.3 + math.log10(max(traffic, 100)) / 8)})
    y = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y/%m/%d")
    w = src.get("wikipedia_top", f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/{y}")
    if w:
        arts = w.get("items", [{}])[0].get("articles", [])
        for a in arts[:80]:
            t = a.get("article", "")
            if ":" in t or t in ("Main_Page",): continue
            trends.append({"phrase": t.replace("_", " "), "src": "wikipedia", "weight": min(1.0, a.get("views", 0) / 1_000_000 + 0.2)})
    return trends

def social(src):
    """crypto-adjacent chatter: reddit RSS, 4chan /biz/, bluesky. returns list of texts with source"""
    texts = []
    subs = ("memecoins", "SolanaMemeCoins", "CryptoMoonShots", "solana", "pumpfun")
    for sub in (subs[int(time.time() // 300) % len(subs)],):  # reddit RSS 429s a 2nd call within seconds: one sub per scan, rotating
        x = src.get(f"reddit_{sub}", f"https://www.reddit.com/r/{sub}/new/.rss?limit=50", kind="text")
        for t in re.findall(r"<title>(.*?)</title>", x or "")[1:]:
            texts.append(("reddit", html.unescape(t)))
    c = src.get("4chan_biz", "https://a.4cdn.org/biz/catalog.json")
    for page in c or []:
        for th in page.get("threads", []):
            texts.append(("4chan", html.unescape(re.sub("<[^>]+>", " ", f"{th.get('sub','')} {th.get('com','')}"))[:400]))
    for q in ("memecoin", "solana memecoin", "pump.fun"):
        b = src.get(f"bluesky_{norm(q)}", f"https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q={requests.utils.quote(q)}&limit=50&sort=latest")
        for p in (b or {}).get("posts", []):
            texts.append(("bluesky", p.get("record", {}).get("text", "")[:400]))
    return texts

# ---------------------------------------------------------------- crypto side
def coin_feeds(src):
    """fresh + trending Solana coins from free crypto feeds. returns {mint: info} and per-mint list membership"""
    coins, lists = {}, {}
    def add(mint, listname, **info):
        if not mint or mint in STABLES or not MINT_RE.match(mint): return
        c = coins.setdefault(mint, {"mint": mint})
        for k, v in info.items():
            if v not in (None, "", []) and not c.get(k): c[k] = v
        lists.setdefault(mint, set()).add(listname)
    DS = "https://api.dexscreener.com"
    for name, path in (("dex_boosts_latest", "/token-boosts/latest/v1"), ("dex_boosts_top", "/token-boosts/top/v1"),
                       ("dex_profiles", "/token-profiles/latest/v1"), ("dex_cto", "/community-takeovers/latest/v1")):
        for t in src.get(name, DS + path) or []:
            if t.get("chainId") != "solana": continue
            links = [l.get("url", "") for l in t.get("links") or []]
            add(t.get("tokenAddress"), name, description=(t.get("description") or "")[:200], links=links)
    for name, path in (("jup_trending_5m", "toptrending/5m"), ("jup_trending_1h", "toptrending/1h"),
                       ("jup_organic_1h", "toporganicscore/1h"), ("jup_recent", "recent")):
        time.sleep(1.3)  # lite-api answers 429 after ~5 quick calls
        for t in src.get(name, f"https://lite-api.jup.ag/tokens/v2/{path}?limit=100") or []:
            add(t.get("id"), name, symbol=t.get("symbol"), name=t.get("name"), twitter=t.get("twitter"), website=t.get("website"),
                launchpad=t.get("launchpad"), holders=t.get("holderCount"), organic=t.get("organicScore"),
                createdAt=t.get("createdAt") or (t.get("firstPool") or {}).get("createdAt"), mcap=t.get("mcap"), liq=t.get("liquidity"))
    for name, path in (("gt_trending", "/networks/solana/trending_pools?include=base_token"),
                       ("gt_new_1", "/networks/solana/new_pools?page=1&include=base_token,dex"),
                       ("gt_new_2", "/networks/solana/new_pools?page=2&include=base_token,dex")):
        time.sleep(2.1)  # 30 calls/min public limit
        d = src.get(name, "https://api.geckoterminal.com/api/v2" + path) or {}
        toks = {i["id"]: i.get("attributes", {}) for i in d.get("included", []) if i.get("type") == "token"}
        for p in d.get("data", []):
            bid = (p.get("relationships", {}).get("base_token", {}).get("data") or {}).get("id", "")
            dex = (p.get("relationships", {}).get("dex", {}).get("data") or {}).get("id")
            ta = toks.get(bid, {})
            add(bid.replace("solana_", ""), "gt_trending" if name == "gt_trending" else "gt_new", symbol=ta.get("symbol"), name=ta.get("name"),
                dex=dex, createdAt=p.get("attributes", {}).get("pool_created_at"))
    # Meteora's own data API (free, no key): newest DAMM v2 and DLMM pools. DBC launches graduate into DAMM v2;
    # brand-new DBC curves are covered by jup_recent (launchpad "met-dbc").
    for name, host in (("meteora_damm_v2", "damm-v2"), ("meteora_dlmm", "dlmm")):
        d = src.get(name, f"https://{host}.datapi.meteora.ag/pools?page=1&page_size=100&sort_by=pool_created_at:desc") or {}
        for p in d.get("data", []):
            tx, ty = p.get("token_x", {}), p.get("token_y", {})
            base = tx if ty.get("address") in STABLES else ty if tx.get("address") in STABLES else None
            if not base: continue
            add(base.get("address"), name, symbol=base.get("symbol"), name=base.get("name"), holders=base.get("holders"),
                dex=name, createdAt=p.get("created_at"), pool=p.get("address"))
    cg = src.get("coingecko_trending", "https://api.coingecko.com/api/v3/search/trending") or {}
    cg_terms = [{"phrase": c["item"].get("name", ""), "sym": c["item"].get("symbol", ""), "src": "coingecko"} for c in cg.get("coins", [])]
    cmc = src.get("cmc_top_search", "https://api.coinmarketcap.com/data-api/v3/topsearch/rank") or {}
    cg_terms += [{"phrase": c.get("name", ""), "sym": c.get("symbol", ""), "src": "cmc"} for c in (cmc.get("data") or {}).get("cryptoTopSearchRanks", [])]
    return coins, lists, cg_terms

def dex_pairs(src, mints):
    """live market data for a set of mints (DexScreener, 30 per call, free 300/min)"""
    out = {}
    mints = list(mints)
    for i in range(0, len(mints), 30):
        for p in src.get(f"dex_tokens_{i//30}", "https://api.dexscreener.com/tokens/v1/solana/" + ",".join(mints[i:i+30])) or []:
            m = p.get("baseToken", {}).get("address")
            if not m or m in STABLES: continue  # any quote (SOL, USDC, even tokenized-stock pairs like AAPLx): best liquidity wins
            if m not in out or (p.get("liquidity") or {}).get("usd", 0) > (out[m].get("liquidity") or {}).get("usd", 0):
                out[m] = p
    return out

TWEET_RE = re.compile(r"(?:x|twitter)\.com/([A-Za-z0-9_]{1,20})/status/(\d{6,25})")

def tweet(src, tid):
    """ONE tweet by id. free, no login. likes, age, author badge. (no follower counts, no search)"""
    d = src.get(f"tweet_{tid}", f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&token=a")
    if not d or d.get("__typename") != "Tweet": return None
    u = d.get("user", {})
    try:
        age_h = max(0.05, (datetime.now(timezone.utc) - datetime.fromisoformat(d["created_at"].replace("Z", "+00:00"))).total_seconds() / 3600)
    except Exception:
        age_h = None
    return {"id": tid, "likes": d.get("favorite_count", 0), "ageH": round(age_h, 2) if age_h else None, "author": u.get("screen_name"),
            "badge": u.get("verified_type") or ("blue" if u.get("is_blue_verified") else None), "cashtags": [s.get("text") for s in d.get("entities", {}).get("symbols", [])], "text": (d.get("text") or "")[:280]}

# ---------------------------------------------------------------- matching + scoring
def match_trends(coin, trends):
    """culture phrases this coin is named after. exact-ish only: a 4-letter ticker matching a random word is noise"""
    sym, nm = norm(coin.get("symbol")), norm(coin.get("name"))
    cw = set(words(coin.get("name"))) | ({sym} if len(sym) >= 4 and sym not in STOP else set())
    hits = []
    for t in trends:
        p = norm(t["phrase"])
        if len(p) < 4: continue
        exact = p in (sym, nm) or (len(p) >= 6 and (p in nm or (len(nm) >= 6 and nm in p)))
        tw = set(words(t["phrase"]))
        overlap = cw & tw if len(tw) <= 3 else set()   # long phrases: words are too common to count
        strong = {w for w in overlap if len(w) >= 5}
        if exact or strong:
            hits.append({"phrase": t["phrase"][:60], "src": t["src"], "w": t.get("weight", 0.5) * (1.0 if exact else 0.6)})
    return hits

def mentions(coin, texts):
    sym = str(coin.get("symbol") or "")
    if len(sym) < 3 or norm(sym) in STOP: return {}
    tag = re.compile(r"\$" + re.escape(sym) + r"\b", re.I)
    word = re.compile(r"\b" + re.escape(sym) + r"\b", re.I) if len(sym) >= 5 else None
    by = {}
    for s, t in texts:
        if tag.search(t) or (word and word.search(t)): by[s] = by.get(s, 0) + 1
    return by

def age_min(coin, pair):
    t = (pair or {}).get("pairCreatedAt")
    if not t:
        c = coin.get("createdAt")
        if isinstance(c, (int, float)): t = c
        elif isinstance(c, str):
            try: t = datetime.fromisoformat(c.replace("Z", "+00:00")).timestamp() * 1000
            except Exception: t = None
    return round((now_ms() - t) / 60000) if t else None

def score(coin, pair, lists, trend_hits, ment, tw, prev):
    n = lambda x: float(x or 0)
    liq = n((pair or {}).get("liquidity", {}).get("usd")); vol1h = n((pair or {}).get("volume", {}).get("h1")); vol5 = n((pair or {}).get("volume", {}).get("m5"))
    parts, why = {}, []
    # 1) culture: named after something trending off-crypto (the "early" part)
    tscore = sum(h["w"] for h in trend_hits)
    parts["trend"] = round(min(30, 18 * tscore), 1)
    if trend_hits: why.append("trending: " + ", ".join(sorted({f"{h['phrase']} ({h['src']})" for h in trend_hits}))[:120])
    # 2) social chatter: cashtag / name in reddit, 4chan, bluesky
    parts["social"] = round(min(15, 5 * len(ment) + 1.5 * sum(ment.values())), 1)
    if ment: why.append("talked about: " + ", ".join(f"{k} x{v}" for k, v in ment.items()))
    # 3) crypto attention: how many crypto lists it sits on (boosts, trending, organic, new-pool feeds don't count)
    att = {l for l in lists if l not in ("gt_new", "jup_recent", "meteora_damm_v2", "meteora_dlmm", "dex_profiles")}
    parts["attention"] = min(20, 5 * len(att))
    if att: why.append("on " + ", ".join(sorted(att)))
    # 4) the coin's own tweet (the only free X read): likes per hour + author badge
    big = False
    if tw:
        lph = tw["likes"] / (tw["ageH"] or 1)
        parts["tweet"] = round(min(20, 4 * math.log10(1 + lph) + (6 if tw["badge"] in ("Government", "Business") else 0)), 1)
        why.append(f"own tweet @{tw['author']}: {tw['likes']} likes in {tw['ageH']}h" + (f" [{tw['badge']} badge]" if tw["badge"] else ""))
        # a famous account only counts as "big name" when the tweet itself names THIS coin (cashtag or mint), like
        # Trump's "$TRUMP" post. Coins love to link a famous news tweet (WatcherGuru etc.) they have nothing to do with.
        names_coin = norm(coin.get("symbol")) in [norm(x) for x in tw.get("cashtags") or []] or coin["mint"] in (tw.get("text") or "")
        tw["namesCoin"] = names_coin
        big = names_coin and (tw["badge"] in ("Government", "Business") or tw["likes"] >= 20000)
    else:
        parts["tweet"] = 0
    # 5) market: volume, holders growing, socials present
    holders = coin.get("holders")
    growth = None
    if holders and prev and prev.get("holders") and prev.get("at"):
        dt_h = max(0.05, (now_ms() - prev["at"]) / 3.6e6)
        growth = round(((holders / prev["holders"]) - 1) * 100 / dt_h, 1)
    soc = (pair or {}).get("info", {}) or {}
    has_social = bool(soc.get("socials") or soc.get("websites") or coin.get("twitter") or coin.get("links"))
    parts["market"] = round(min(15, 2.5 * math.log10(1 + vol1h / 1000) + (3 if (growth or 0) > 20 else 0) + (2 if has_social else 0)), 1)
    total = round(sum(parts.values()), 1)
    huge = vol1h >= 1_000_000 and liq >= 500_000
    if huge: why.append(f"huge: 1h vol ${vol1h/1e6:.1f}M, liq ${liq/1e6:.2f}M")
    early = bool(trend_hits or ment) and len(att) <= 1
    return {"score": total, "parts": parts, "why": why, "bigName": big or (huge and total >= 40), "huge": huge, "early": early,
            "liqUsd": round(liq), "vol1hUsd": round(vol1h), "vol5mUsd": round(vol5), "holders": holders, "holderGrowthPctH": growth, "hasSocial": has_social}

# ---------------------------------------------------------------- main scan
def scan(args):
    src = Src()
    with ThreadPoolExecutor(3) as ex:
        f_cult, f_soc, f_coins = ex.submit(culture, src), ex.submit(social, src), ex.submit(coin_feeds, src)
        trends, texts, (coins, lists, cg_terms) = f_cult.result(), f_soc.result(), f_coins.result()
    trends = trends + [{"phrase": t["phrase"], "src": t["src"], "weight": 0.5} for t in cg_terms if t["phrase"]]
    # trend velocity: a phrase we first saw in the last 2 h is rising, one we've seen for days is old news
    tpath = os.path.join(args.state_dir, "hype_trends.json")
    try: first = json.load(open(tpath))
    except Exception: first = {}
    for t in trends:
        k = norm(t["phrase"]); first.setdefault(k, now_ms())
        age_h = (now_ms() - first[k]) / 3.6e6
        t["rising"] = age_h < 2
        t["weight"] = t.get("weight", 0.5) * (1.3 if age_h < 2 else 1.0 if age_h < 24 else 0.6)
    first = {k: v for k, v in first.items() if now_ms() - v < 7 * 86400_000}
    os.makedirs(args.state_dir, exist_ok=True); json.dump(first, open(tpath, "w"))
    # fresh only: drop anything we know is older than max age before spending market calls
    fresh = [m for m, c in coins.items() if (age_min(c, None) is None or age_min(c, None) <= args.max_age_h * 60)]
    # cheap pre-rank so the market-data calls go to the interesting ones
    pre = []
    for m in fresh:
        c = coins[m]; th = match_trends(c, trends); me = mentions(c, texts)
        pre.append((len(th) * 3 + len(me) * 2 + len(lists[m]), m, th, me))
    pre.sort(reverse=True)
    pick = [p for p in pre if p[0] >= 1][: args.max_market]
    pairs = dex_pairs(src, [p[1] for p in pick])
    state_path = os.path.join(args.state_dir, "hype_holders.json")
    try: prevs = json.load(open(state_path))
    except Exception: prevs = {}
    tweets_left = args.max_tweets
    rows = []
    for _, m, th, me in pick:
        c, pair = coins[m], pairs.get(m)
        if pair:
            c.setdefault("symbol", pair["baseToken"].get("symbol")); c.setdefault("name", pair["baseToken"].get("name"))
            if not th: th = match_trends(c, trends)
            if not me: me = mentions(c, texts)
        if not pair: continue  # no live market data = nothing the bot could check or buy
        am = age_min(c, pair)
        if am is not None and am > args.max_age_h * 60: continue
        links = list(c.get("links") or []) + [c.get("twitter") or ""] + [s.get("url", "") for s in ((pair or {}).get("info") or {}).get("socials", [])] + [w.get("url", "") for w in ((pair or {}).get("info") or {}).get("websites", [])]  # $TRUMP's DexScreener "website" IS Trump's tweet
        tw = None
        for l in links:
            mm = TWEET_RE.search(l or "")
            if mm and tweets_left > 0:
                tweets_left -= 1; tw = tweet(src, mm.group(2)); break
        s = score(c, pair, lists[m], th, me, tw, prevs.get(m))
        rows.append({"mint": m, "symbol": (c.get("symbol") or "?")[:16], "name": (c.get("name") or "")[:40],
                     "dex": (pair or {}).get("dexId") or c.get("dex") or c.get("launchpad"), "ageMin": am,
                     "mcapUsd": round(float((pair or {}).get("marketCap") or c.get("mcap") or 0)),
                     "url": (pair or {}).get("url") or f"https://dexscreener.com/solana/{m}", "lists": sorted(lists[m]),
                     "tweet": tw, **s})
        if c.get("holders"): prevs[m] = {"holders": c["holders"], "at": now_ms()}
    # forget holder snapshots older than 3 days
    prevs = {k: v for k, v in prevs.items() if now_ms() - v.get("at", 0) < 3 * 86400_000}
    os.makedirs(args.state_dir, exist_ok=True)
    json.dump(prevs, open(state_path, "w"))
    rows.sort(key=lambda r: r["score"], reverse=True)
    for r in rows:
        r["tier"] = "high" if r["score"] >= args.high else "watch" if r["score"] >= args.watch else "low"
    watch = [r for r in rows if r["tier"] != "low"][: args.top]
    return {"at": now_ms(), "v": 1, "items": watch, "seen": {"coins": len(coins), "fresh": len(fresh), "scored": len(rows), "trends": len(trends), "texts": len(texts)},
            "sources": src.health}

def admin_key(args):
    k = os.environ.get("HYPE_ADMIN_KEY") or os.environ.get("DESK_ADMIN_KEY")
    if k: return k
    for p in (os.path.join(REPO, "state", "cloudflare.json"), os.path.join(REPO, "..", "memecoin-desk", "state", "cloudflare.json")):
        try: return json.load(open(p))["adminKey"]
        except Exception: pass
    return None

def worker_url(args):
    if args.url: return args.url
    if os.environ.get("DESK_URL"): return os.environ["DESK_URL"]
    for p in (os.path.join(REPO, "state", "cloudflare.json"), os.path.join(REPO, "..", "memecoin-desk", "state", "cloudflare.json")):
        try: return json.load(open(p))["url"]
        except Exception: pass
    return None

def push(args, out):
    key, url = admin_key(args), worker_url(args)
    if not key or not url: return "push skipped: no admin key / worker url"
    slim = {"at": out["at"], "v": out["v"], "items": [{k: r[k] for k in ("mint", "symbol", "name", "dex", "ageMin", "score", "tier", "bigName", "huge", "early", "why", "liqUsd", "vol1hUsd", "url")} for r in out["items"]],
            "sources": {k: v["ok"] for k, v in out["sources"].items()}}
    r = requests.post(url.rstrip("/") + "/admin/hype", data=json.dumps(slim), headers={"x-admin-key": key, "content-type": "application/json"}, timeout=20)
    return f"push {r.status_code} {r.text[:120]}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--push", action="store_true"); ap.add_argument("--url")
    ap.add_argument("--loop", type=float, default=0, help="minutes between scans (0 = once)")
    ap.add_argument("--top", type=int, default=20); ap.add_argument("--high", type=float, default=45); ap.add_argument("--watch", type=float, default=25)
    ap.add_argument("--max-age-h", type=float, default=72); ap.add_argument("--max-market", type=int, default=120); ap.add_argument("--max-tweets", type=int, default=15)
    ap.add_argument("--state-dir", default=os.path.join(REPO, "state")); ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    while True:
        t = time.time(); out = scan(args)
        json.dump(out, open(os.path.join(args.state_dir, "hype_last.json"), "w"), indent=1)
        if args.json: print(json.dumps(out, indent=1))
        else:
            bad = [k for k, v in out["sources"].items() if not v["ok"]]
            print(f"{datetime.now(timezone.utc):%H:%M:%S}Z scan {time.time()-t:.0f}s · coins {out['seen']['coins']} fresh {out['seen']['fresh']} scored {out['seen']['scored']} · trends {out['seen']['trends']} posts {out['seen']['texts']} · sources down: {', '.join(bad) or 'none'}")
            for r in out["items"]:
                print(f"  {r['tier']:5} {r['score']:5.1f} ${r['symbol']:<10} {r['dex'] or '?':<16} age {r['ageMin']}m liq ${r['liqUsd']:,} vol1h ${r['vol1hUsd']:,}{' BIG' if r['bigName'] else ''}{' EARLY' if r['early'] else ''} · {' | '.join(r['why'])[:150]}")
        if args.push: print(push(args, out))
        if not args.loop: break
        time.sleep(max(30, args.loop * 60 - (time.time() - t)))

if __name__ == "__main__":
    main()
