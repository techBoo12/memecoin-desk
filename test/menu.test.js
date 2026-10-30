// node --test   day 4: the button menu. no network: Telegram, DexScreener, RugCheck and Jupiter are all faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../src/desk/engine.js';
import { createMenu, PRIVATE_TAP, CHECK_TTL_MS } from '../src/telegram/menu.js';
import { checkToken, manualBuy, manualSell, positionView } from '../src/desk/manual.js';
import { sellPaper } from '../src/desk/executor.js';
import { stats } from '../src/desk/head.js';
import { applyOverrides, changeSetting, stepSetting, getSetting, listSettings } from '../src/desk/settings.js';
import { alertAllowed } from '../src/telegram/alerts.js';

const CONFIG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const OWNER = 1001, STRANGER = 2002;
const MINT = 'FakeMint1111111111111111111111111111111pump';
const BAD = 'BadMint22222222222222222222222222222222pump';

// a fake market: price $0.001, sell quotes give back what you put in minus 1%
function fakeNet({ price = 0.001, sol = 200 } = {}) {
  const coin = (mint, symbol) => ({ mint, symbol, name: symbol + ' coin', url: 'https://dexscreener.com/solana/x', priceUsd: price, liqUsd: 120_000, mcap: 900_000, ageMin: 600,
    vol: { m5: 9000, h1: 90_000, h6: 0, h24: 0 }, txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 700, sells: 300 }, h6: { buys: 0, sells: 0 } }, change: { m5: 2, h1: 15, h6: 40, h24: 0 } });
  const net = {
    calls: [],
    refreshPairs: async (ms) => new Map(ms.filter((m) => m === MINT || m === BAD).map((m) => [m, coin(m, m === MINT ? 'GOOD' : 'RUGGY')])),
    filter: async (c) => ({ alive: c.mint === MINT, unknowns: [], rc: { token: { decimals: 6 } },
      results: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ n, id: n === 5 ? 'top10' : `r${n}`, status: c.mint === BAD && n === 5 ? 'kill' : 'pass', note: c.mint === BAD && n === 5 ? 'top 10 hold 61%' : 'ok', value: 1 })) }),
    honeypotCheck: async (c) => (c.mint === MINT ? { ok: true, testUsd: 8, roundTripLossPct: 1.1, impactPct: 0.4, decimals: 6, route: 'Raydium', fillPriceUsd: price } : { ok: false, reason: "CAN'T SELL: no sell route (honeypot?)" }),
    analyze: () => ({ score: 86, passes: true, tapeOk: true, tape: { m5: 2, h1: 15 }, parts: {}, holders: 3000 }),
    qualityGate: () => ({ ok: true, failed: [], checks: [], passedCount: 9, total: 9 }),
    solPriceUsd: async () => sol,
    quote: async (inMint, outMint, amount) => {
      net.calls.push({ inMint, outMint, amount });
      const a = Number(amount);
      if (inMint.startsWith('So111')) return { outAmount: String(Math.floor(((a / 1e9) * sol / net.price) * 1e6)), priceImpactPct: '0.004', routePlan: [{ swapInfo: { label: 'Raydium' } }] };
      return { outAmount: String(Math.floor((a / 1e6) * net.price / sol * 1e9 * 0.99)), priceImpactPct: '0.004' };
    },
    price,
  };
  return net;
}

function fakeTelegram() {
  const log = []; let id = 100; let editFails = false;
  const io = {
    send: async (text, kb) => { log.push({ m: 'send', id: ++id, text, kb }); return id; },
    edit: async (msgId, text, kb) => { log.push({ m: 'edit', id: msgId, text, kb }); return !editFails; },
    answer: async (cbId, text, alert) => { log.push({ m: 'answer', cbId, text, alert }); },
  };
  return { io, log, failEdits: (v) => { editFails = v; } };
}

function setup({ net = fakeNet(), clock } = {}) {
  const config = structuredClone(CONFIG); const overrides = {};
  const S = {};
  const engine = createEngine({ config, S, log: { event() {}, warn() {}, info() {} }, notify: () => true });
  const tg = fakeTelegram();
  let saves = 0;
  const desk = {
    snapshot: () => engine.snapshot(),
    pause: async () => engine.pause(), resume: async () => engine.resume(),
    step: async (k, dir) => stepSetting(config, overrides, k, dir),
    check: (mint) => checkToken(mint, { config, S, net }),
    buy: (c, usd, force) => manualBuy(S, c, usd, config, { net, force }),
    sell: (id, pct) => manualSell(S, id, pct, config, { net }),
    refresh: async () => {},
    save: async () => { saves++; },
  };
  const ui = {};
  const menu = createMenu({ io: tg.io, desk, ui, ownerId: OWNER, ...(clock ? { now: clock } : {}) });
  let n = 0;
  const tap = (data, { from = OWNER, msg = 500 } = {}) => menu.onCallback({ id: `cb${++n}`, from: { id: from }, message: { message_id: msg, chat: { id: from } }, data });
  return { config, overrides, S, engine, tg, menu, ui, tap, net, saves: () => saves };
}
const lastOf = (log, m) => [...log].reverse().find((x) => x.m === m);
const allData = (kb) => (kb || []).flat().map((x) => x.callback_data);

test('owner lock: a stranger tapping any button gets "private" and nothing runs', async () => {
  const { tap, tg, engine } = setup();
  for (const d of ['h', 'pz', 'b', 'ps:T001:100', 's+:stop', 'sg:autobuy']) assert.equal(await tap(d, { from: STRANGER }), 'private');
  assert.equal(tg.log.filter((x) => x.m === 'answer').length, 6);
  assert.ok(tg.log.every((x) => x.m === 'answer' && x.text === PRIVATE_TAP && x.alert === true));
  assert.equal(engine.snapshot().paused, false); // pause tap from a stranger did nothing
});

test('every tap is answered exactly once, stale + unknown buttons get a fresh panel', async () => {
  const { tap, tg } = setup();
  const datas = ['h', 'b', 'sl', 'p', 'nm', 'rp', 'st', 'si:stop', 's+:stop', 's-:stop', 'sg:alerts', 'pz', 'pz', 'pc:T999', 'ps:T999:50', 'pr:T999', 'ba:zz:5', 'bf:zz:5', 'old-v1-button', ''];
  for (const d of datas) {
    const before = tg.log.filter((x) => x.m === 'answer').length;
    await tap(d);
    assert.equal(tg.log.filter((x) => x.m === 'answer').length, before + 1, `tap "${d}" answered once`);
  }
  await tap('old-v1-button');
  assert.match(lastOf(tg.log, 'answer').text, /older menu/);
  assert.match(lastOf(tg.log, 'edit').text, /memecoin desk/);
});

test('home panel edits in place, shows balance / today / open / status / auto-buy, all callback data <= 64 bytes', async () => {
  const { tap, tg, menu } = setup();
  const id = await menu.sendHome();
  const home = lastOf(tg.log, 'send');
  assert.match(home.text, /balance\s+<b>\$100\.00<\/b>/); assert.match(home.text, /today/); assert.match(home.text, /open\s+<b>0<\/b>/); assert.match(home.text, /auto-buy\s+<b>on<\/b>/);
  assert.deepEqual(allData(home.kb), ['b', 'sl', 'p', 'nm', 'rp', 'st', 'pz', 'h']);
  await tap('h', { msg: id });
  assert.equal(lastOf(tg.log, 'edit').id, id); // edited, not a new message
  assert.equal(tg.log.filter((x) => x.m === 'send').length, 1);
  await tap('pz', { msg: id });
  assert.match(lastOf(tg.log, 'edit').text, /paused/);
  assert.ok(allData(lastOf(tg.log, 'edit').kb).includes('pz'));
  for (const x of tg.log) for (const d of allData(x.kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
});

test('if Telegram refuses the edit (old message), the menu sends a fresh one', async () => {
  const { tap, tg } = setup();
  tg.failEdits(true);
  await tap('h', { msg: 1 });
  assert.equal(lastOf(tg.log, 'send').text.includes('memecoin desk'), true);
});

test('buy: paste address -> safety card -> $10 -> manual paper position at the Jupiter quote', async () => {
  const { menu, tg, tap, S, net } = setup();
  assert.equal(await menu.onText(MINT), 'check');
  const card = lastOf(tg.log, 'edit');
  assert.match(card.text, /\$GOOD/); assert.match(card.text, /8\/8/); assert.match(card.text, /passes everything/);
  const datas = allData(card.kb);
  assert.ok(datas.some((d) => /^ba:\w+:10$/.test(d)), datas.join(','));
  const buy10 = datas.find((d) => /^ba:\w+:10$/.test(d));
  await tap(buy10, { msg: card.id });
  const pos = S.desk.positions[0];
  assert.equal(pos.source, 'manual'); assert.equal(pos.sizeUsd, 10); assert.equal(S.desk.cash, 90);
  assert.ok(Math.abs(pos.entryPrice - net.price) / net.price < 0.01, 'filled at the quote price');
  assert.ok(Math.abs(pos.tokens - (10 * (1 - CONFIG.risk.paperFeePct / 100)) / pos.entryPrice) < 1e-6);
  assert.match(lastOf(tg.log, 'edit').text, /paper buy filled/);
  assert.equal(net.calls.at(-1).inMint.startsWith('So111'), true);
});

test('buy: a coin that FAILS safety needs a second "buy anyway (paper)" tap', async () => {
  const { menu, tg, tap, S } = setup();
  await menu.onText(BAD);
  const card = lastOf(tg.log, 'edit');
  assert.match(card.text, /FAILED the safety check/); assert.match(card.text, /top 10 hold 61%/); assert.match(card.text, /no sell route/);
  const warn = allData(card.kb).find((d) => /^bw:\w+:5$/.test(d));
  assert.ok(warn, 'amount buttons go to a warning, not a buy');
  await tap(warn);
  assert.equal(S.desk.positions.length, 0);
  const confirm = lastOf(tg.log, 'edit');
  assert.match(confirm.text, /buy anyway/);
  const ck = warn.split(':')[1];
  await tap(`ba:${ck}:5`); // a forged direct buy on an unsafe check still asks to confirm
  assert.equal(S.desk.positions.length, 0);
  await tap(`bf:${ck}:5`);
  assert.equal(S.desk.positions.length, 1);
  assert.match(S.desk.positions[0].why.safety, /bought anyway/);
});

test('buy: custom amount typed in chat, cash limit respected, expired check re-checks', async () => {
  let t = Date.now();
  const { menu, tg, tap, S, ui } = setup({ clock: () => t });
  await menu.onText(MINT);
  const ck = allData(lastOf(tg.log, 'edit').kb).find((d) => d.startsWith('bx:')).split(':')[1];
  await tap(`bx:${ck}`);
  assert.equal(ui.await.kind, 'amount');
  assert.equal(await menu.onText('500'), 'amount');
  assert.match(lastOf(tg.log, 'edit').text, /only \$100\.00 paper cash free/);
  assert.equal(S.desk.positions.length, 0);
  await tap(`bx:${ck}`);
  await menu.onText('7.5');
  assert.equal(S.desk.positions[0].sizeUsd, 7.5);
  // an old card: prices moved, so the tap re-runs the check instead of buying
  await menu.onText(MINT); // already holding -> card says so
  const ck2 = allData(lastOf(tg.log, 'edit').kb).find((d) => d.startsWith('ba:')).split(':')[1];
  t += CHECK_TTL_MS + 1000;
  await tap(`ba:${ck2}:5`);
  assert.match(lastOf(tg.log, 'answer').text, /re-checking/);
  assert.equal(S.desk.positions.length, 1);
  await tap('ba:gone:5');
  assert.match(lastOf(tg.log, 'answer').text, /expired/);
});

test('partial sells: 25% then 50% of the rest then 100%, P/L and R add up', async () => {
  const { menu, tg, tap, S, net } = setup();
  await menu.onText(MINT);
  await tap(allData(lastOf(tg.log, 'edit').kb).find((d) => /^ba:\w+:25$/.test(d)));
  const pos = S.desk.positions[0];
  const t0 = pos.tokens;
  net.price = 0.0015; // +50%
  await tap(`ps:${pos.id}:25`);
  assert.ok(Math.abs(pos.tokens - t0 * 0.75) < 1e-6);
  assert.match(lastOf(tg.log, 'edit').text, /sold 25%/);
  assert.ok(Math.abs(positionView(pos, CONFIG).now - 0.0015 * 0.99) / 0.0015 < 0.01, 'card shows the price she just sold at');
  await tap(`ps:${pos.id}:50`);
  assert.ok(Math.abs(pos.tokens - t0 * 0.375) < 1e-6);
  const v = positionView(pos, CONFIG);
  assert.ok(Math.abs(v.soldPct - 62.5) < 1e-6);
  await tap(`ps:${pos.id}:100`);
  assert.equal(S.desk.positions.length, 0);
  const tr = S.desk.closed.at(-1);
  assert.equal(tr.source, 'manual');
  assert.ok(Math.abs(tr.pnlUsd - (pos.realizedUsd - 25)) < 1e-3);
  assert.ok(Math.abs(S.desk.cash - (75 + pos.realizedUsd)) < 1e-6);
  assert.ok(Math.abs(tr.R - tr.pnlUsd / pos.riskUsd) < 0.01);
  assert.ok(tr.pnlUsd > 0);
  assert.match(lastOf(tg.log, 'edit').text, /closed/);
  await tap(`ps:${pos.id}:100`); // stale sell button on a closed position
  assert.match(lastOf(tg.log, 'answer').text, /closed/);
});

test('partial sell math on the executor: fees, realized, cash', () => {
  const st = { cash: 90, positions: [], closed: [] };
  const pos = { id: 'T001', symbol: 'X', mint: 'm', entryPrice: 1, sizeUsd: 10, riskUsd: 0.6, tokens: 9.95, tokensOriginal: 9.95, realizedUsd: 0, markUsd: 9.95, source: 'manual' };
  st.positions.push(pos);
  const cfg = { risk: { paperFeePct: 0.5 } };
  const a = sellPaper(st, pos, 0.5, 2, 'manual sell 50%', cfg);
  assert.equal(a.trade, null);
  assert.ok(Math.abs(a.fill.proceeds - 4.975 * 2 * 0.995) < 1e-9);
  assert.ok(Math.abs(pos.tokens - 4.975) < 1e-9);
  const b = sellPaper(st, pos, 1, 1, 'manual sell 100%', cfg);
  assert.ok(b.trade);
  assert.ok(Math.abs(b.trade.pnlUsd - (9.90025 + 4.950125 - 10)) < 1e-3);
  assert.equal(b.trade.source, 'manual');
  assert.ok(Math.abs(st.cash - (90 + 9.90025 + 4.950125)) < 1e-6);
});

test('manual trades are kept apart from the bot stats', () => {
  const st = { closed: [{ pnlUsd: 1, R: 1 }, { pnlUsd: -2, R: -1, source: 'manual' }, { pnlUsd: 3, R: 2, source: 'manual' }] };
  assert.equal(stats(st).trades, 1); assert.equal(stats(st).realizedUsd, 1);
  assert.equal(stats(st, 'manual').trades, 2); assert.equal(stats(st, 'manual').realizedUsd, 1);
});

test('settings: steppers use the same whitelisted ranges as /set, paper mode is locked', async () => {
  const { tap, tg, config, overrides } = setup();
  await tap('st');
  const panel = lastOf(tg.log, 'edit');
  for (const k of ['stop', 'tp', 'trailat', 'trail', 'minscore', 'maxtrades', 'maxopen', 'slippage']) assert.ok(allData(panel.kb).includes(`s+:${k}`), k);
  assert.ok(allData(panel.kb).includes('sg:autobuy') && allData(panel.kb).includes('sg:alerts'));
  assert.match(panel.text, /mode: <b>paper<\/b> \(locked/);
  await tap('s+:stop'); assert.equal(config.risk.stopLossPct, 7); assert.equal(overrides.stop, 7);
  for (let i = 0; i < 40; i++) await tap('s+:stop');
  assert.equal(config.risk.stopLossPct, 25); // capped at the /set max
  assert.match(lastOf(tg.log, 'answer').text, /maximum/);
  await tap('s+:slippage'); assert.equal(config.honeypot.slippageBps, 350); assert.equal(getSetting(config, 'slippage'), 3.5);
  await tap('s-:tp'); assert.equal(config.risk.takeProfitLadder[0].atMultiple, 1.5);
  await tap('sg:autobuy'); assert.equal(config.autoBuy, false);
  await tap('sg:alerts'); assert.equal(config.telegram.alertLevel, 'trades');
  await tap('sg:alerts'); assert.equal(config.telegram.alertLevel, 'all');
  await tap('s+:mode'); assert.equal(config.mode, 'paper');
  assert.equal(changeSetting(config, overrides, 'mode', 'live').ok, false);
  assert.equal(changeSetting(config, overrides, 'slippage', '20').ok, false);
  assert.equal(changeSetting(config, overrides, 'slippage', '2%').ok, true); assert.equal(config.honeypot.slippageBps, 200);
  // overrides survive a restart: same values laid back on a fresh config
  const fresh = applyOverrides(structuredClone(CONFIG), overrides);
  assert.equal(fresh.honeypot.slippageBps, 200); assert.equal(fresh.autoBuy, false); assert.equal(fresh.risk.stopLossPct, 25);
  assert.ok(listSettings(config).every((x) => x.key !== 'mode'));
});

test('alert level "trades only" drops scan digests + picks, keeps buys/sells/stops/reports', () => {
  const c = { telegram: { alertLevel: 'trades' } };
  assert.equal(alertAllowed('scan', c), false); assert.equal(alertAllowed('pick', c), false);
  for (const k of ['buy', 'sell', 'stop_out', 'take_profit', 'emergency', 'freeze', 'report', 'pick_ready']) assert.equal(alertAllowed(k, c), true, k);
  assert.equal(alertAllowed('pick', { telegram: {} }), true);
});
