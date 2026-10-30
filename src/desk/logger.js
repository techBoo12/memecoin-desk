// ============================================================================
// LOGGER
// Job: write down EVERYTHING. Every scan, every kill (+ the rule and the
//      number), every score, every veto, every "no trade", every paper buy
//      and sell. JSON lines for machines, CSV for spreadsheets, and a clean
//      colored console for humans.
// HARD STOP: the logger never decides anything, and never writes a secret.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[97m', bold: '\x1b[1m' };
const COLORS = { scan: 'cyan', kill: 'red', alive: 'green', sell_test: 'blue', score: 'magenta', veto: 'yellow', no_trade: 'yellow', buy: 'green', sell: 'red', hold: 'white', info: 'dim', warn: 'yellow', report: 'cyan', freeze: 'red' };

export function createLogger(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ev = path.join(dir, 'events.jsonl');
  const con = path.join(dir, 'console.log');
  const csv = path.join(dir, 'trades.csv');
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'time,trade_id,side,symbol,mint,price_usd,usd,qty,reason,pnl_usd,R\n');

  const hhmmss = () => new Date().toISOString().slice(11, 19);
  function event(type, data = {}, text = '') {
    const ts = new Date().toISOString();
    fs.appendFileSync(ev, JSON.stringify({ ts, type, ...data }) + '\n');
    if (text) {
      const line = `${hhmmss()}  ${text}`;
      fs.appendFileSync(con, JSON.stringify({ ts, type, line }) + '\n');
      const col = C[COLORS[type] || 'white'];
      process.stdout.write(`${C.dim}${hhmmss()}${C.reset}  ${col}${text}${C.reset}\n`);
    }
  }
  function trade(row) {
    const cells = [row.time, row.id, row.side, row.symbol, row.mint, row.price, row.usd, row.qty, row.reason, row.pnl ?? '', row.R ?? ''];
    fs.appendFileSync(csv, cells.map((x) => `"${String(x).replace(/"/g, "'")}"`).join(',') + '\n');
  }
  return {
    event, trade,
    info: (t, d) => event('info', d, t),
    warn: (t, d) => event('warn', d, t),
  };
}
