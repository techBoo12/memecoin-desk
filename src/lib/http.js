// Tiny fetch helper: timeout, retry, and a polite per-host pace.
// Plain fetch only, so the same code runs in Node and on Cloudflare Workers.
const lastHit = new Map();

export async function getJSON(url, { timeoutMs = 15000, retries = 2, minGapMs = 250 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastHit.get(host) || 0) + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, status: res.status, data: null };
      return { ok: true, status: res.status, data: await res.json() };
    } catch (err) {
      if (attempt >= retries) return { ok: false, status: 0, error: String(err.message || err), data: null };
      await sleep(800 * (attempt + 1));
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
