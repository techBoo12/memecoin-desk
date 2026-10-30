// LOCAL ONLY: drive the button menu inside Cloudflare's own runtime (wrangler dev) with a FAKE Telegram.
// No real token, no real chat id, nothing leaves this machine except the desk's free market-data calls
// (DexScreener, RugCheck, Jupiter quotes), so the safety checks + paper fills are real.
//   1) npx wrangler dev --port 8787 --persist-to /tmp/desk-local   (.dev.vars: fake token, TG_API_BASE=http://127.0.0.1:8790)
//   2) node test/local/menu_run.mjs [seed.json] > /tmp/menu_run.json
import http from 'node:http';
import fs from 'node:fs';

const WORKER = process.env.WORKER || 'http://127.0.0.1:8787';
const OWNER = 1001, STRANGER = 2002;
const HOOK = 'local-test-secret', ADMIN = 'local-admin';
const chat = [];            // what the owner's phone would show, in order
const strangerChat = [];
const steps = [];
let nextId = 1000, toast = null;
const calls = [];

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const p = body ? JSON.parse(body) : {};
    calls.push(method);
    let result = true;
    const box = p.chat_id === OWNER ? chat : strangerChat;
    if (method === 'sendMessage') {
      const m = { id: ++nextId, from: 'bot', text: p.text, html: p.parse_mode === 'HTML', kb: p.reply_markup?.inline_keyboard || [], at: Date.now() };
      box.push(m); result = { message_id: m.id, chat: { id: p.chat_id }, date: Math.floor(Date.now() / 1000), text: p.text };
    } else if (method === 'editMessageText') {
      const m = box.find((x) => x.id === p.message_id);
      if (!m) { res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' })); return; }
      if (m.text === p.text && JSON.stringify(m.kb) === JSON.stringify(p.reply_markup?.inline_keyboard || [])) { res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' })); return; }
      Object.assign(m, { text: p.text, html: p.parse_mode === 'HTML', kb: p.reply_markup?.inline_keyboard || [], edited: (m.edited || 0) + 1 });
    } else if (method === 'answerCallbackQuery') {
      toast = { text: p.text || '', alert: Boolean(p.show_alert) };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => srv.listen(8790, '127.0.0.1', r));

let uid = 1;
async function hook(update) {
  const r = await fetch(`${WORKER}/tg`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': HOOK }, body: JSON.stringify({ update_id: uid++, ...update }) });
  return r.status;
}
const owner = { id: OWNER, type: 'private', first_name: 'boo' };
async function say(text, label) {
  chat.push({ id: ++nextId, from: 'user', text, at: Date.now() });
  toast = null;
  const t0 = Date.now(); await hook({ message: { message_id: nextId, chat: owner, from: owner, date: Math.floor(Date.now() / 1000), text } });
  snap(label, { typed: text, ms: Date.now() - t0 });
}
function lastBot() { return [...chat].reverse().find((m) => m.from === 'bot' && m.kb?.length); }
function findBtn(re, m = lastBot()) { for (const row of m?.kb || []) for (const b of row) if (re.test(b.text) || re.test(b.callback_data)) return { m, b }; return null; }
async function tap(re, label, { from = owner } = {}) {
  const f = findBtn(re);
  if (!f) { snap(label + ' (button not found: ' + re + ')', {}); return false; }
  toast = null;
  const t0 = Date.now();
  await hook({ callback_query: { id: 'cq' + uid, from, message: { message_id: f.m.id, chat: { id: from.id, type: 'private' }, date: Math.floor(f.m.at / 1000) }, chat_instance: 'x', data: f.b.callback_data } });
  snap(label, { tapped: f.b.text, msgId: f.m.id, ms: Date.now() - t0 });
  return true;
}
function snap(label, extra) { steps.push({ label, ...extra, toast, chat: structuredClone(chat), stranger: structuredClone(strangerChat), at: Date.now() }); console.error(`· ${label}${toast?.text ? '  [toast: ' + toast.text + ']' : ''}`); }

// ---- seed the local desk with a copy of the paper desk (balance + trades only, no ids) and start its loop
const seed = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
for (let i = 0; i < 60; i++) { try { if ((await fetch(WORKER + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const init = await fetch(WORKER + '/admin/init', { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: JSON.stringify({ desk: seed?.desk, startTestHours: 24, where: 'local test' }) });
console.error('init', init.status);
for (let i = 0; i < 60 && !chat.length; i++) await new Promise((r) => setTimeout(r, 1000)); // the desk's own "test started" alert lands after its first scan
await new Promise((r) => setTimeout(r, 1500));
chat.length = 0; // start the phone screen clean (the init alert isn't part of the menu flow)

const GOOD = process.env.GOOD_MINT, BAD = process.env.BAD_MINT;
await say('/start', 'owner opens the desk: home panel');
await tap(/^🟢 Buy$/, 'tap Buy: paste prompt');
await say(GOOD, 'paste a coin address: full safety check card');
const safe = Boolean(findBtn(/^ba:/));
if (safe) await tap(/^\$10$/, 'tap $10: paper buy at a live Jupiter quote');
else { await tap(/\$10/, 'tap $10 on a coin that failed: warning'); await tap(/buy anyway/, 'confirm buy anyway (paper)'); }
await tap(/open card/, 'open the position card');
await tap(/refresh/, 'refresh: live sell quote');
await tap(/^25%$/, 'sell 25%');
await tap(/^50%$/, 'sell 50% of the rest');
await say(BAD, 'paste a risky coin: safety check fails');
await tap(/\$5/, 'tap $5: needs an extra confirm');
await tap(/cancel/, 'cancel');
await tap(/Positions/, 'positions list');
await tap(/^T\d+/, 'tap through to a position');
await tap(/^100%$/, 'sell 100%: closed');
await tap(/home/, 'home');
await tap(/Settings/, 'settings');
await tap(/s\+:stop/, 'stop loss +1%');
await tap(/s-:stop/, 'stop loss back -1%');
await tap(/alerts/, 'alerts: trades only');
await tap(/alerts/, 'alerts: all');
await tap(/home/, 'home');
await tap(/Near misses/, 'near misses');
await tap(/home/, 'home');
await tap(/Report/, 'report');
await tap(/home/, 'home');
await tap(/Pause/, 'pause');
await tap(/Resume/, 'resume');
// someone else taps her buttons (a forwarded panel): private
const tapsBefore = calls.length;
await tap(/Pause|Resume/, 'stranger taps Pause: private', { from: { id: STRANGER, type: 'private', first_name: 'x' } });
// a button from an old panel (unknown data)
await hook({ callback_query: { id: 'cq-old', from: owner, message: { message_id: lastBot().id, chat: owner, date: 0 }, chat_instance: 'x', data: 'v1:old' } });
snap('an old v1 button: fresh panel', {});
await say('/status', '/status still works');
await say('/help', '/help still works');
process.stdout.write(JSON.stringify({ steps, calls, ranAt: new Date().toISOString() }));
srv.close();
process.exit(0);
