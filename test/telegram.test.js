// node --test   (no installs, no network: Telegram is faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelegramBot } from '../src/telegram.js';
import { createTelegramClient } from '../src/telegram/client.js';
import { createFileStore } from '../src/lib/store.js';
import { changeSetting } from '../src/desk/settings.js';

const FAKE = '1234567:FAKE_TOKEN_FOR_TESTS_ONLY_not_a_real_one';

function fakeTelegram() {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { username: 'test_desk_bot', first_name: 'test desk' } }) };
    if (method === 'sendMessage') { sent.push(body); return { json: async () => ({ ok: true, result: {} }) }; }
    return { json: async () => ({ ok: true, result: [] }) };
  };
  return { sent, fetchImpl };
}

const msg = (chatId, text, type = 'private') => ({ update_id: 1, message: { chat: { id: chatId, type }, from: { first_name: 'Boo' }, date: Math.floor(Date.now() / 1000), text } });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const store = createFileStore(dir);
  const config = { topRule: 'protect the balance first, profit second', telegram: { alertSubscribers: [] }, risk: { stopLossPct: 6 }, loop: { scanEverySec: 120 } };
  const calls = [];
  const desk = {
    snapshot: () => ({ paused: calls.includes('pause') && !calls.includes('resume'), config, st: { equity: 99.49, dayPnlPct: -0.51, frozen: null, cooldown: false }, state: { cash: 91.5, positions: [], closed: [], day: '2026-10-30', startBalance: 100 }, todayR: -1.21, stats: { trades: 1, wins: 0, losses: 1, realizedUsd: -0.58, expectancyR: -1.21 }, run: { scans: 1, uniqueCoins: new Set(), killedCoins: new Set(), alive: new Set(), killsByRule: {} } }),
    pause: async () => calls.push('pause'), resume: async () => calls.push('resume'),
    set: async (k, v) => changeSetting(config, {}, k, v),
  };
  const log = { info() {}, warn() {}, event() {} };
  const tg = fakeTelegram();
  const bot = await createTelegramBot({ store, desk, config, log, logDir: dir, token: FAKE, fetchImpl: tg.fetchImpl });
  return { bot, tg, calls, dir };
}

test('token never leaks into errors', async () => {
  const client = createTelegramClient({ token: FAKE, fetchImpl: async (url) => { throw new Error(`boom at ${url}`); } });
  await assert.rejects(client.getMe(), (e) => !e.message.includes(FAKE) && e.message.includes('[token]'));
});

test('strangers get one polite line, and nothing else', async () => {
  const { bot, tg, calls } = await setup();
  await bot.handleUpdate(msg(111, '/status'));
  await bot.handleUpdate(msg(111, '/pause'));
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /private/);
  assert.deepEqual(calls, []);
});

test('wrong code does not pair, right code pairs once and burns', async () => {
  const { bot, tg } = await setup();
  const code = bot.pairingCode();
  await bot.handleUpdate(msg(222, '/start WRONG1'));
  assert.equal(bot.paired(), false);
  await bot.handleUpdate(msg(333, `/start ${code.toLowerCase()}`));
  assert.equal(bot.paired(), true);
  assert.equal(bot.pairingCode(), null);
  await bot.handleUpdate(msg(444, `/start ${code}`)); // code is burned
  await bot.handleUpdate(msg(444, '/status'));
  assert.ok(tg.sent.filter((m) => m.chat_id === 444).every((m) => /private/.test(m.text)));
});

test('owner commands work, /set validates', async () => {
  const { bot, tg, calls } = await setup();
  await bot.handleUpdate(msg(555, `/start ${bot.pairingCode()}`));
  await bot.handleUpdate(msg(555, '/status'));
  assert.match(tg.sent.at(-1).text, /balance \$99\.49/);
  await bot.handleUpdate(msg(555, '/pause'));
  assert.deepEqual(calls, ['pause']);
  await bot.handleUpdate(msg(555, '/set stop 99'));
  assert.match(tg.sent.at(-1).text, /between/);
  await bot.handleUpdate(msg(555, '/set stop 7'));
  assert.match(tg.sent.at(-1).text, /6% → 7%/);
  await bot.handleUpdate(msg(555, '/set mode live'));
  assert.match(tg.sent.at(-1).text, /can't be changed/);
});

test('alerts are logged before pairing and sent after', async () => {
  const { bot, tg, dir } = await setup();
  bot.notify('scan', 'scan text');
  const lines = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].delivery, 'queued: owner not paired yet');
  await bot.handleUpdate(msg(666, `/start ${bot.pairingCode()}`));
  bot.notify('buy', 'buy text');
  await bot.stop();
  assert.ok(tg.sent.some((m) => m.chat_id === 666 && m.text === 'buy text'));
});
