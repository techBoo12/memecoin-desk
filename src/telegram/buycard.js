// ============================================================================
// BUY CARD (her ask, Oct 31 2026 9:23 AM Lagos): "only alert me when it actually BUYS, and then tell me
// all the details: dev crew, dev history, why it bought". One phone-sized card, every lane.
// Formatting only: the card never decides anything.
// ============================================================================
import { devHistLine, devHistEvidence } from '../playbook/devhist.js';

const sp = (x) => (x == null || !Number.isFinite(Number(x)) ? 'n/a' : x >= 1 ? Number(x).toFixed(4) : Number(x).toPrecision(4));
const usd = (x) => (x == null || !Number.isFinite(Number(x)) ? 'n/a' : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}m` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Number(x).toFixed(0)}`);
export const shortMint = (m) => (m ? `${m.slice(0, 4)}…${m.slice(-4)}` : 'n/a');

const LANE_HEAD = {
  insider: '🟢 PAPER BUY · insider lane (counts in your 14-day test)',
  trusted_dev: '🤝 PAPER BUY · TRUSTED-DEV EXCEPTION · quarter size (counts in your 14-day test, tagged trusted_dev)',
  desk: '🟢 PAPER BUY · main desk (counts in your 14-day test)',
  copy: '🧠 PAPER BUY · copy lane (own $100 book, not in the 14-day numbers)',
  hype: '🔥 PAPER BUY · hype lane (own $100 book, not in the 14-day numbers)',
};

// x = { lane, symbol, mint, pool, sizeUsd, entryPrice, liqUsd, mcapUsd, crew: { wallets, pct, cap, source }, devPct,
//       devHist, passed: ['R1 mint revoked', ...], why: 'one line', extra: [lines] }
export function buyCard(x) {
  const crew = x.crew || {};
  const crewLine = crew.pct == null ? 'dev crew: not measured on this lane'
    : `dev crew: ${crew.wallets != null ? `${crew.wallets} linked wallets` : 'linked wallets'} hold ${Number(crew.pct).toFixed(1)}%${crew.cap != null ? ` (cap ${crew.cap}%)` : ''}${crew.source ? ` · ${crew.source}` : ''}`;
  const L = [
    LANE_HEAD[x.lane] || `🟢 PAPER BUY · ${x.lane}`,
    `$${x.symbol} · mint ${shortMint(x.mint)}`,
    `https://dexscreener.com/solana/${x.pool || x.mint}`,
    `size $${Number(x.sizeUsd || 0).toFixed(2)} · entry $${sp(x.entryPrice)}${x.liqUsd != null ? ` · liq ${usd(x.liqUsd)}` : ''}${x.mcapUsd != null ? ` · mcap ${usd(x.mcapUsd)}` : ''}`,
    crewLine + (x.devPct != null ? ` · dev wallet ${Number(x.devPct).toFixed(1)}%` : ''),
    devHistLine(x.devHist),
    ...devHistEvidence(x.devHist, 3),
    `rules passed: ${(x.passed || []).join(' · ') || 'n/a'}`,
    `why: ${x.why || 'every rule passed'}`,
    ...(x.extra || []),
    'linked wallets + dev history = on-chain evidence, not proof · paper only',
  ];
  return L.filter((l) => l != null && l !== '').join('\n');
}

// rule checks (rules.js shape) -> short "passed" list
export function passedList(checks = []) {
  return checks.filter((c) => c.status === 'pass' || c.status === 'warn').map((c) => `${c.code}${c.value != null && String(c.value).length <= 24 ? ` ${c.value}` : ''}${c.status === 'warn' ? ' (warn)' : ''}`);
}
