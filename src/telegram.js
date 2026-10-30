// ============================================================================
// TELEGRAM BOT
// Job: the desk's phone line. Pushes alerts to the owner and takes her
//      commands. Long-polling getUpdates for now (no server needed); the
//      same handleUpdate() can sit behind a Cloudflare Worker webhook later.
// HARD STOP: token from env only (see telegram/client.js). Only the paired
//            owner can control the desk (see telegram/lock.js). Alerts go to
//            the owner and to read-only subscribers listed in config, nobody
//            else. Every alert is also written to logs/alerts.jsonl.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createTelegramClient } from './telegram/client.js';
import { loadLock, classify, pairOwner, PRIVATE_TEXT, SUBSCRIBER_TEXT } from './telegram/lock.js';
import { runCommand, HELP } from './telegram/commands.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createTelegramBot({ store, desk, config, log, logDir, token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl }) {
  const client = token ? createTelegramClient({ token, fetchImpl }) : null;
  const lock = await loadLock(store);
  const bootAt = Date.now();
  const sink = path.join(logDir, 'alerts.jsonl');
  const strangerReplied = new Map();
  const dedupe = new Map();
  let me = null, stopped = false;
  const queue = [];
  let draining = false;

  if (client) me = await client.getMe();

  async function reply(chatId, text) {
    if (!client) return;
    try { await client.sendMessage(chatId, text); }
    catch (e) {
      if (e.retryAfter) { await sleep(e.retryAfter * 1000); return reply(chatId, text); }
      log.warn(`telegram send failed: ${client.redact(e.message)}`);
    }
  }

  async function drain() {
    if (draining) return; draining = true;
    while (queue.length) {
      const { text, to } = queue.shift();
      for (const chat of to) { await reply(chat, text); await sleep(1100); } // telegram: ~1 msg/s per chat
    }
    draining = false;
  }

  // push an alert: always logged in the exact message format; sent if paired
  function notify(kind, text, { dedupeKey, dedupeMs = 30 * 60_000 } = {}) {
    if (dedupeKey) {
      const last = dedupe.get(dedupeKey);
      if (last && Date.now() - last < dedupeMs) return false;
      dedupe.set(dedupeKey, Date.now());
    }
    if (kind === 'scan' && config.telegram?.scanAlerts === false) return false;
    const to = [lock.ownerChatId, ...(config.telegram?.alertSubscribers || [])].filter(Boolean);
    const sent = Boolean(client && to.length);
    fs.appendFileSync(sink, JSON.stringify({ ts: new Date().toISOString(), kind, text, delivery: sent ? 'sent to owner' : 'queued: owner not paired yet' }) + '\n');
    if (sent) { queue.push({ text, to }); drain(); }
    return true;
  }

  // one incoming update. Platform-agnostic: Node polling today, Worker webhook later.
  async function handleUpdate(update) {
    const msg = update?.message;
    if (!msg?.chat || typeof msg.text !== 'string') return;
    const role = classify(msg, lock, config);
    const stale = msg.date * 1000 < bootAt - 120_000;
    if (role === 'pair') {
      await pairOwner(store, lock, msg);
      log.info('telegram: owner paired, desk locked to her chat');
      await reply(msg.chat.id, `🔒 paired. this desk now answers only you${msg.from?.first_name ? ', ' + msg.from.first_name.toLowerCase() : ''}.\nalerts for every scan, pick and paper trade land here.\n\n${HELP}`);
      return;
    }
    if (role === 'owner') {
      if (stale && !msg.text.startsWith('/')) return;
      const text = msg.text.startsWith('/') ? await runCommand(msg.text, desk) : 'i only speak commands for now 🙂 /help';
      await reply(msg.chat.id, text);
      return;
    }
    if (stale) return; // old backlog from before boot: ignore quietly
    const last = strangerReplied.get(msg.chat.id) || 0;
    if (Date.now() - last < 10 * 60_000) return; // polite once, not a chat partner
    strangerReplied.set(msg.chat.id, Date.now());
    await reply(msg.chat.id, role === 'subscriber' ? SUBSCRIBER_TEXT : PRIVATE_TEXT);
  }

  async function poll() {
    if (!client) return;
    while (!stopped) {
      try {
        const updates = await client.getUpdates(lock.offset, 25);
        for (const u of updates) {
          lock.offset = u.update_id + 1;
          await store.put('telegram', lock);
          try { await handleUpdate(u); } catch (e) { log.warn(`telegram update error: ${client.redact(e.message)}`); }
        }
      } catch (e) {
        if (stopped) break;
        log.warn(`telegram poll: ${client.redact(e.message)}`);
        await sleep(e.code === 409 ? 30_000 : 5_000);
      }
    }
  }

  return {
    username: me?.username || null,
    botName: me?.first_name || null,
    online: Boolean(client),
    paired: () => Boolean(lock.ownerChatId),
    pairingCode: () => lock.pairingCode || null,
    notify, handleUpdate,
    start() { poll(); },
    async stop() { stopped = true; while (queue.length || draining) await sleep(200); },
  };
}
