// ============================================================================
// THE DESK ON CLOUDFLARE (free plan), 24/7.
// - One Durable Object ("Desk") holds the whole desk and runs it with its own
//   ALARM: every few seconds while a trade is open (fast exits), and in small
//   steps for scans and near-miss re-checks. State lives in the object's own
//   storage, so a restart picks up exactly where it was.
// - A cron trigger (every minute, the free plan's fastest) only kicks the
//   alarm back on if it ever stopped. It's the watchdog, not the loop.
// - Telegram talks to it by WEBHOOK (POST /tg), checked with a secret header.
// Secrets (set with the Cloudflare API, never in this repo):
//   TELEGRAM_BOT_TOKEN, OWNER_CHAT_ID, TG_WEBHOOK_SECRET, ADMIN_KEY
// HARD STOP: paper mode only. No wallet, no keys, no swap, anywhere.
// ============================================================================
import { DurableObject } from 'cloudflare:workers';
import CONFIG from '../../config.json'; // the same config.json as the Node desk (bundled by wrangler)
import { createEngine } from '../desk/engine.js';
import { equity, riskStatus } from '../desk/risk.js';
import { applyOverrides, changeSetting } from '../desk/settings.js';
import { createTelegramClient } from '../telegram/client.js';
import { classify, PRIVATE_TEXT, SUBSCRIBER_TEXT } from '../telegram/lock.js';
import { runCommand } from '../telegram/commands.js';
import * as alert from '../telegram/alerts.js';

const PARTS = ['desk', 'run', 'seen', 'holders', 'nm', 'scan', 'events'];
const json = (x, status = 200) => new Response(JSON.stringify(x, null, 1), { status, headers: { 'content-type': 'application/json' } });
const log = {
  event: (type, data, line) => { if (line && type !== 'kill' && type !== 'alive') console.log(line); },
  warn: (m) => console.log('warn: ' + m), info: (m) => console.log(m),
};

export class Desk extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.S = null;
    this.dedupe = new Map();
    this.strangers = new Map();
  }

  async load() {
    if (this.S) return;
    const got = await this.ctx.storage.get([...PARTS, 'settings', 'outbox', 'timers']);
    this.S = {};
    for (const k of PARTS) if (got.get(k)) this.S[k] = got.get(k);
    this.S.timers = got.get('timers') || undefined;
    this.overrides = got.get('settings') || {};
    this.outbox = got.get('outbox') || [];
    this.config = structuredClone(CONFIG);
    applyOverrides(this.config, this.overrides);
    this.engine = createEngine({ config: this.config, S: this.S, log, notify: (k, t, o) => this.notify(k, t, o) });
    this.client = this.env.TELEGRAM_BOT_TOKEN ? createTelegramClient({ token: this.env.TELEGRAM_BOT_TOKEN, timeoutMs: 8000 }) : null;
    this.lock = { ownerChatId: this.env.OWNER_CHAT_ID ? Number(this.env.OWNER_CHAT_ID) : null };
    this.lastTimersSave = 0;
  }

  notify(kind, text, { dedupeKey, dedupeMs = 30 * 60_000 } = {}) {
    if (dedupeKey) {
      const last = this.dedupe.get(dedupeKey);
      if (last && Date.now() - last < dedupeMs) return false;
      this.dedupe.set(dedupeKey, Date.now());
    }
    if (kind === 'scan' && this.config.telegram?.scanAlerts === false) return false;
    this.outbox.push({ kind, text, at: Date.now() });
    if (this.outbox.length > 60) this.outbox.splice(0, this.outbox.length - 60); // never let a backlog grow
    this.outboxDirty = true;
    return true;
  }

  async flush(max = 4) {
    if (!this.client || !this.lock.ownerChatId) return;
    const to = [this.lock.ownerChatId, ...(this.config.telegram?.alertSubscribers || [])];
    let sent = 0;
    while (this.outbox.length && sent < max) {
      const m = this.outbox[0];
      try {
        for (const chat of to) await this.client.sendMessage(chat, m.text);
      } catch (e) {
        if (e.retryAfter) break; // telegram asked us to slow down: try next tick
        console.log('telegram send failed: ' + this.client.redact(e.message));
      }
      this.outbox.shift(); sent++; this.outboxDirty = true;
      (this.sentLog ||= []).push({ at: Date.now(), kind: m.kind, text: m.text }); if (this.sentLog.length > 40) this.sentLog.shift();
      if (this.outbox.length && sent < max) await new Promise((r) => setTimeout(r, 1050));
    }
  }

  async save(force = false) {
    const put = {};
    for (const k of this.S._dirty) if (PARTS.includes(k)) put[k] = this.S[k];
    this.S._dirty.clear();
    if (this.outboxDirty) { put.outbox = this.outbox; this.outboxDirty = false; }
    if (force || Object.keys(put).length || Date.now() - this.lastTimersSave > 60_000) { put.timers = this.S.timers; this.lastTimersSave = Date.now(); }
    if (force) for (const k of PARTS) put[k] = this.S[k];
    if (Object.keys(put).length) await this.ctx.storage.put(put);
  }

  async alarm() {
    await this.load();
    let r;
    const t0 = Date.now();
    try {
      r = await this.engine.tick({ deepPerStep: this.S.desk.positions.length ? 1 : 3 });
    } catch (e) {
      console.log('tick error: ' + (e?.message || e));
      r = { did: 'error', nextAt: Date.now() + 5000 };
    }
    this.S.timers.lastTickAt = Date.now();
    this.S.timers.lastDid = r.did;
    this.S.timers.lastTickMs = Date.now() - t0;
    this.S.timers.ticks = (this.S.timers.ticks || 0) + 1;
    await this.flush(this.S.desk.positions.length ? 2 : 4);
    await this.save();
    const next = Math.min(Math.max(r.nextAt, Date.now() + 1000), Date.now() + 60_000);
    await this.ctx.storage.setAlarm(next);
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    if (url.pathname === '/kick') {
      const a = await this.ctx.storage.getAlarm();
      if (this.S.desk?.test && (a == null || a < Date.now() - 30_000)) { await this.ctx.storage.setAlarm(Date.now() + 500); return json({ kicked: true, alarm: a }); }
      return json({ kicked: false, alarm: a });
    }
    if (url.pathname === '/tg') { await this.onTelegram(await req.json()); return new Response('ok'); }
    if (url.pathname === '/admin/init' && req.method === 'POST') return this.init(await req.json());
    if (url.pathname === '/admin/state') return json({ S: { ...this.S, _dirty: undefined }, outbox: this.outbox.length, sent: this.sentLog || [], config: this.config });
    return json(this.health());
  }

  health() {
    const st = this.S.desk;
    const rs = riskStatus(st, this.config);
    const T = this.S.timers || {};
    return {
      desk: 'memecoin desk', mode: 'paper', live: Boolean(T.lastTickAt && Date.now() - T.lastTickAt < 120_000),
      lastTickAt: T.lastTickAt ? new Date(T.lastTickAt).toISOString() : null, lastStep: T.lastDid, ticks: T.ticks || 0,
      balanceUsd: +rs.equity.toFixed(2), openTrades: st.positions.map((p) => ({ symbol: p.symbol, chgPct: +(((p.lastPrice / p.entryPrice) - 1) * 100).toFixed(1), lastCheckAt: p.lastCheckAt ? new Date(p.lastCheckAt).toISOString() : null })),
      closedTrades: st.closed.length, scans: this.S.run.scans, nearMisses: this.S.run.nearMisses, paused: Boolean(st.paused), frozen: rs.frozen?.why || null,
      test: st.test ? { n: st.test.n, hours: st.test.hours, startedAt: new Date(st.test.startedAt).toISOString(), endsAt: new Date(st.test.endsAt).toISOString() } : null,
      exitsCheckedEverySec: this.config.loop.watchEverySec,
    };
  }

  async init({ desk, startTestHours = 24, where = 'cloudflare' }) {
    if (desk) { this.S = { desk }; this.engine = createEngine({ config: this.config, S: this.S, log, notify: (k, t, o) => this.notify(k, t, o) }); }
    const t = this.engine.startTest(startTestHours);
    this.S.timers.nextScan = 0; this.S.timers.nextWatch = 0;
    this.notify('test', alert.testStartAlert({ equity: equity(this.S.desk), config: this.config, hours: startTestHours, where, endsAt: t.endsAt }));
    await this.save(true);
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return json({ ok: true, test: t, equity: equity(this.S.desk), open: this.S.desk.positions.map((p) => p.symbol) });
  }

  async reply(chatId, text) {
    if (!this.client) return;
    try { await this.client.sendMessage(chatId, text); } catch (e) { console.log('telegram reply failed: ' + this.client.redact(e.message)); }
  }

  async onTelegram(update) {
    const msg = update?.message;
    if (!msg?.chat || typeof msg.text !== 'string') return;
    if (Date.now() - msg.date * 1000 > 10 * 60_000) return; // stale retry from telegram: ignore
    const role = classify(msg, this.lock, this.config);
    if (role === 'owner') {
      const desk = {
        snapshot: () => this.engine.snapshot(),
        pause: async () => { this.engine.pause(); await this.save(); },
        resume: async () => { this.engine.resume(); await this.save(); },
        set: async (key, value) => {
          const r = changeSetting(this.config, this.overrides, key, value);
          if (r.ok) await this.ctx.storage.put('settings', this.overrides);
          return r;
        },
      };
      const text = msg.text.startsWith('/') ? await runCommand(msg.text, desk) : 'i only speak commands for now 🙂 /help';
      await this.reply(msg.chat.id, text);
      return;
    }
    const last = this.strangers.get(msg.chat.id) || 0;
    if (Date.now() - last < 10 * 60_000) return; // polite once, not a chat partner
    this.strangers.set(msg.chat.id, Date.now());
    await this.reply(msg.chat.id, role === 'subscriber' ? SUBSCRIBER_TEXT : PRIVATE_TEXT);
  }
}

const same = (a, b) => { a = String(a || ''); b = String(b || ''); if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.DESK.get(env.DESK.idFromName('desk'));
    if (url.pathname === '/tg' && req.method === 'POST') {
      if (!same(req.headers.get('x-telegram-bot-api-secret-token'), env.TG_WEBHOOK_SECRET)) return new Response('no', { status: 401 });
      return stub.fetch('https://desk/tg', { method: 'POST', body: await req.text() });
    }
    if (url.pathname.startsWith('/admin/')) {
      if (!same(req.headers.get('x-admin-key'), env.ADMIN_KEY)) return new Response('no', { status: 401 });
      return stub.fetch('https://desk' + url.pathname, { method: req.method, body: req.method === 'POST' ? await req.text() : undefined });
    }
    if (url.pathname === '/health' || url.pathname === '/') {
      const h = await (await stub.fetch('https://desk/health')).json();
      if (url.pathname === '/health') return json(h);
      return new Response(page(h), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  },
  // free plan watchdog: once a minute, make sure the desk's own alarm loop is alive
  async scheduled(event, env, ctx) {
    const stub = env.DESK.get(env.DESK.idFromName('desk'));
    ctx.waitUntil(stub.fetch('https://desk/kick'));
  },
};

function page(h) {
  const ago = h.lastTickAt ? Math.round((Date.now() - Date.parse(h.lastTickAt)) / 1000) : null;
  const rows = h.openTrades.map((t) => `<li>$${esc(t.symbol)} <b class="${t.chgPct >= 0 ? 'g' : 'r'}">${t.chgPct >= 0 ? '+' : ''}${t.chgPct}%</b></li>`).join('') || '<li>none</li>';
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>memecoin desk · live</title>
<style>body{font:16px/1.5 ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e0ea;max-width:560px;margin:40px auto;padding:0 20px}h1{font-size:20px}.g{color:#3ddc84}.r{color:#ff5c5c}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${h.live ? '#3ddc84' : '#ff5c5c'};margin-right:8px}small{color:#7a8899}</style>
<h1><span class=dot></span>memecoin desk · ${h.live ? 'live' : 'offline'} · paper</h1>
<p>balance <b>$${h.balanceUsd.toFixed(2)}</b> (fake money)<br>last check ${ago == null ? 'never' : ago + 's ago'} · ${h.ticks} ticks<br>scans ${h.scans} · near misses ${h.nearMisses} · closed trades ${h.closedTrades}<br>open trades checked every ${h.exitsCheckedEverySec}s</p>
<p>open:</p><ul>${rows}</ul>
${h.test ? `<p>${h.test.hours}h test #${h.test.n}: ${esc(h.test.startedAt.slice(0, 16).replace('T', ' '))} → ${esc(h.test.endsAt.slice(0, 16).replace('T', ' '))} utc</p>` : ''}
<small>runs on cloudflare workers (free) · durable object alarm loop · not financial advice</small>`;
}
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
