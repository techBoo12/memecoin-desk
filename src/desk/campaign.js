// the 14-day paper run (training pack 9.4, her call Oct 31): a report every 24h says "day N of 14",
// and the day-14 report adds the pack's go/no-go check over the whole run. after day 14 the desk keeps paper trading.
import { evaluate } from '../playbook/labels.js';

const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// which day of the run the window that just ended (or is running) is
export function campaignDay(st) {
  const c = st.campaign, t = st.test;
  if (!c || !t) return null;
  return (t.n || 1) - c.firstN + 1;
}

export function campaignHead(st) {
  const c = st.campaign, day = campaignDay(st);
  if (day == null) return '';
  return day <= c.days ? `📅 day ${day} of ${c.days} · paper run (training pack go/no-go at day ${c.days})`
    : `📅 day ${day} · past the ${c.days}-day run, still paper until you say otherwise`;
}

export function campaignMetrics({ S, config, now = Date.now() }) {
  const st = S.desk, c = st.campaign;
  const trades = st.closed.filter((t) => t.source !== 'manual' && Date.parse(t.entryAt) >= c.startedAt)
    .map((t) => ({ ...t, pnlPct: t.pnlPct ?? (t.sizeUsd ? (t.pnlUsd / t.sizeUsd) * 100 : 0) }));
  const curve = (S.curve || []).filter((p) => p.t >= c.startedAt);
  const P = S.pb || {};
  const kd = Object.entries(P.killDays || {}).filter(([day]) => day >= new Date(c.startedAt).toISOString().slice(0, 10)).map(([, v]) => v);
  const days = Math.floor((now - c.startedAt) / 86.4e6 + 1e-6);
  return evaluate({ trades, curve, book: S.labels, latenciesMs: P.latency || [], killSwitchDays: { hit: kd.filter((x) => x.hit).length, fired: kd.filter((x) => x.fired).length }, days }, config.playbook || { max_latency_ms: 1500 });
}

export function finalSummaryText({ S, config, now = Date.now() }) {
  const c = S.desk.campaign;
  const m = campaignMetrics({ S, config, now });
  const passed = m.goNoGo.filter((x) => x.pass).length;
  return [
    `🏁 ${c.days}-day paper run · final check (training pack go/no-go)`,
    `${iso(c.startedAt)} → ${iso(now)} utc · ${m.trades} closed trades (bot + insider lane; your manual trades not counted)`,
    '',
    ...m.goNoGo.map((x) => `${x.pass ? '✅' : '❌'} ${x.bar} · ${x.value}`),
    '',
    m.go ? `verdict: GO (${passed}/${m.goNoGo.length} bars). real money is still only a small fresh wallet and only with your yes`
      : `verdict: NO-GO (${passed}/${m.goNoGo.length} bars). stays on paper: tune and run again`,
    'the desk keeps paper trading and reporting every 24h until you say otherwise',
  ].join('\n').slice(0, 4000);
}
