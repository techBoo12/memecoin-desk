// ============================================================================
// THE DESK, Node runner (local). Same engine as the Cloudflare desk:
//   scout -> filter (8 kill rules) -> sell test -> analyst -> quality gate
//   -> HEAD OF DESK approve/veto -> paper executor -> fast exit watcher
//   + near-miss tracker.
// Usage: node src/run.js <minutes>          run the desk for N minutes
//        node src/run.js <minutes> --test 24  also start a 24h test window
// Everything is logged to logs/. State lives in state/ (gitignored).
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './desk/engine.js';
import { equity } from './desk/risk.js';
import { createLogger } from './desk/logger.js';
import { sleep } from './lib/http.js';
import { createFileStore } from './lib/store.js';
import { applyOverrides, changeSetting } from './desk/settings.js';
import { createTelegramBot } from './telegram.js';
import * as alert from './telegram/alerts.js';
import { testReportText } from './desk/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const runMin = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) || config.loop.runMinutes);
const testHours = args.includes('--test') ? Number(args[args.indexOf('--test') + 1] || config.loop.testHours) : 0;
const log = createLogger(path.join(ROOT, 'logs'));
const store = createFileStore(path.join(ROOT, 'state'));

// state parts (the same parts the Cloudflare desk keeps in Durable Object storage)
const PARTS = { desk: 'desk', run: 'run', seen: 'seen', holders: 'holders', nm: 'nearmiss', scan: 'scan', timers: 'timers', events: 'events' };
const S = {};
for (const [k, file] of Object.entries(PARTS)) { const v = await store.get(file, null); if (v) S[k] = v; }
const overrides = await store.get('settings', {});
applyOverrides(config, overrides);

let bot;
const engine = createEngine({ config, S, log, notify: (...a) => bot.notify(...a) });
async function save(all = false) {
  for (const [k, file] of Object.entries(PARTS)) if (all || S._dirty.has(k)) await store.put(file, S[k]);
  S._dirty.clear();
}

const desk = {
  snapshot: engine.snapshot,
  pause: async () => { engine.pause(); await save(); },
  resume: async () => { engine.resume(); await save(); },
  set: async (key, value) => {
    const r = changeSetting(config, overrides, key, value);
    if (r.ok) { await store.put('settings', overrides); log.event('info', { setting: r.key, old: r.old, value: r.value }, `⚙ SETTING ${r.key}: ${r.old} -> ${r.value} (from telegram)`); }
    return r;
  },
};

async function main() {
  bot = await createTelegramBot({ store, desk, config, log, logDir: path.join(ROOT, 'logs') });
  if (bot.online) {
    log.event('info', { bot: bot.username }, `telegram: @${bot.username} online · ${bot.paired() ? 'owner paired' : 'waiting for the owner to pair'}`);
    if (!bot.paired()) process.stderr.write(`\n  pair the owner: send  /start ${bot.pairingCode()}  to @${bot.username}\n\n`);
    bot.start();
  } else {
    log.event('info', {}, 'telegram: no TELEGRAM_BOT_TOKEN in env, alerts go to logs/alerts.jsonl only');
  }
  bot.notify('online', alert.onlineAlert({ equity: equity(S.desk), config, open: S.desk.positions.length }));
  if (testHours) {
    const t = engine.startTest(testHours);
    bot.notify('test', alert.testStartAlert({ equity: equity(S.desk), config, hours: testHours, where: 'this machine', endsAt: t.endsAt }));
  }
  log.event('info', {}, `memecoin desk · PAPER MODE · $${equity(S.desk).toFixed(2)} virtual · run ${runMin} min · exits every ${config.loop.watchEverySec}s · rule #1: ${config.topRule}`);
  const end = Date.now() + runMin * 60_000;
  let lastSave = 0;
  while (Date.now() < end) {
    let r = { nextAt: Date.now() + 1000 };
    try { r = await engine.tick(); } catch (e) { log.warn(`tick error: ${e.message}`); }
    if (S._dirty.size && (Date.now() - lastSave > 5000 || S._dirty.has('desk'))) { await save(); lastSave = Date.now(); }
    const wait = Math.min(Math.max(r.nextAt - Date.now(), 100), 5000);
    await sleep(Math.min(wait, end - Date.now()));
  }
  await save(true);
  const report = testReportText({ S, config });
  fs.writeFileSync(path.join(ROOT, 'logs', `report-${S.desk.day}.md`), report);
  fs.writeFileSync(path.join(ROOT, 'logs', 'run-summary.json'), JSON.stringify({ run: S.run, equity: equity(S.desk), cash: S.desk.cash, open: S.desk.positions, closed: S.desk.closed, nearMisses: S.nm.items }, null, 1));
  log.event('report', {}, `■ DONE  ${S.run.scans} scans · ${S.run.uniqueCoins} coins · ${S.run.killedCoins} killed · ${S.run.approved} paper buys · ${S.run.nearMisses} near misses · equity $${equity(S.desk).toFixed(2)}`);
  bot.notify('offline', alert.offlineAlert(S.desk.positions.length));
  await bot.stop();
  process.exit(0);
}

main();
