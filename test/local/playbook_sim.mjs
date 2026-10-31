// Local paper simulation of the insider-exit lane against LIVE public data.
//   node test/local/playbook_sim.mjs <minutes> <outdir>
// No Telegram, no wallet, no Cloudflare: a fresh in-memory desk ($100 paper), alerts written to a file.
// Desk A's scout is switched off here so the run measures the new lane alone.
import fs from 'node:fs';
import { createEngine } from '../../src/desk/engine.js';
import { rpcStats } from '../../src/playbook/solana.js';

const [minArg, out = '/tmp/pbsim'] = process.argv.slice(2);
const minutes = Number(minArg || 20);
fs.mkdirSync(out, { recursive: true });
const config = JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url)));
config.loop.scanEverySec = 1e9;
const S = {};
const ev = fs.createWriteStream(`${out}/events.jsonl`);
const alerts = fs.createWriteStream(`${out}/alerts.txt`);
const log = { event: (type, data, line) => { if (line) ev.write(JSON.stringify({ t: new Date().toISOString(), type, line }) + '\n'); }, warn: (m) => ev.write(JSON.stringify({ t: new Date().toISOString(), type: 'warn', line: m }) + '\n'), info() {} };
const eng = createEngine({ config, S, log, notify: (k, text) => alerts.write(`---- ${new Date().toISOString()} ${k}\n${text}\n`) });
S.timers.nextScan = Infinity;
const end = Date.now() + minutes * 60_000;
const cpu = []; const did = {};
let ticks = 0;
while (Date.now() < end) {
  const c0 = process.cpuUsage(); let r;
  try { r = await eng.tick({ pbBudget: 8, monitorBurst: 1 }); } catch (e) { r = { did: 'error', nextAt: Date.now() + 3000 }; log.warn('tick error ' + e.message); }
  const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000); ticks++;
  const k = String(r.did).split(':')[0].replace(/ \+\d+$/, ''); did[k] = (did[k] || 0) + 1;
  const wait = Math.max(50, Math.min(r.nextAt - Date.now(), 5000));
  await new Promise((x) => setTimeout(x, wait));
  if (ticks % 200 === 0) fs.writeFileSync(`${out}/progress.json`, JSON.stringify({ at: new Date().toISOString(), ticks, stats: S.pb.stats, skips: S.pb.skips }, null, 1));
}
cpu.sort((a, b) => a - b);
const q = (p) => +cpu[Math.min(cpu.length - 1, Math.floor(cpu.length * p))].toFixed(2);
const summary = { minutes, ticks, did, cpuMsPerTick: { median: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) }, rpc: rpcStats, stats: S.pb.stats, skips: S.pb.skips,
  open: S.desk.positions.map((p) => ({ id: p.id, sym: p.symbol, entry: p.entryPrice, last: p.lastPrice, why: p.why })), closed: S.desk.closed.map((t) => ({ id: t.id, sym: t.symbol, pnlPct: t.pnlPct, code: t.code, reason: t.exitReason })),
  recent: S.pb.recent, labels: Object.values(S.labels.items).map((x) => ({ sym: x.sym, d: x.d, why: x.why, samples: x.samples.length, p0: x.p0, peak: x.peak1h, l: x.label1h })),
  report: eng.pb.reportLines(), equity: S.desk.cash + S.desk.positions.reduce((s, p) => s + p.markUsd, 0) };
fs.writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.stats), JSON.stringify(summary.skips));
process.exit(0);
