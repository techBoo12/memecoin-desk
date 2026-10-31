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
import { setKeyedRpc, chargeKeyed } from '../playbook/solana.js';
import { hookToken } from '../playbook/smart.js';
import { equity, riskStatus } from '../desk/risk.js';
import { applyOverrides, changeSetting, stepSetting } from '../desk/settings.js';
import { checkToken, manualBuy, manualSell } from '../desk/manual.js';
import { markPrice } from '../desk/executor.js';
import { createMenu } from '../telegram/menu.js';
import { createTelegramClient } from '../telegram/client.js';
import { classify, PRIVATE_TEXT, SUBSCRIBER_TEXT } from '../telegram/lock.js';
import { runCommand } from '../telegram/commands.js';
import * as alert from '../telegram/alerts.js';
import { dashData, dashPage } from './dashboard.js';

const PARTS = ['desk', 'run', 'seen', 'holders', 'nm', 'scan', 'events', 'curve', 'pb', 'labels', 'copy', 'smart']; // day 5: + insider lane + label book; Oct 31: + copy lane book + smart-wallet list
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
    const got = await this.ctx.storage.get([...PARTS, 'settings', 'outbox', 'timers', 'ui']);
    this.ui = got.get('ui') || {}; // the button menu's own small state: panel message id, pending checks
    this.S = {};
    for (const k of PARTS) if (got.get(k)) this.S[k] = got.get(k);
    this.S.timers = got.get('timers') || undefined;
    this.overrides = got.get('settings') || {};
    this.outbox = got.get('outbox') || [];
    this.config = structuredClone(CONFIG);
    applyOverrides(this.config, this.overrides);
    const kr = this.config.playbook?.keyed_rpc || {};
    setKeyedRpc(this.env.HELIUS_RPC_URL, { dailyCap: kr.daily_cap, softPct: kr.soft_pct }); // secret; the lane's free list stays as fallback
    this.engine = createEngine({ config: this.config, S: this.S, log, notify: (k, t, o) => this.notify(k, t, o) });
    this.client = this.env.TELEGRAM_BOT_TOKEN ? createTelegramClient({ token: this.env.TELEGRAM_BOT_TOKEN, timeoutMs: 8000, apiBase: this.env.TG_API_BASE }) : null;
    this.lock = { ownerChatId: this.env.OWNER_CHAT_ID ? Number(this.env.OWNER_CHAT_ID) : null };
    this.lastTimersSave = 0;
  }

  notify(kind, text, { dedupeKey, dedupeMs = 30 * 60_000 } = {}) {
    if (dedupeKey) {
      const last = this.dedupe.get(dedupeKey);
      if (last && Date.now() - last < dedupeMs) return false;
      this.dedupe.set(dedupeKey, Date.now());
    }
    if (!alert.alertAllowed(kind, this.config)) return false;
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
      // insider trades: 3 looks 1 s apart inside one alarm (pack: monitor >= 1/s) so the free plan sees ~1 request per 3 s, not 1 per s
      r = await this.engine.tick({ deepPerStep: this.S.desk.positions.length ? 1 : 3, monitorBurst: 3, pbBudget: 8 });
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
    if (url.pathname === '/admin/endtest' && req.method === 'POST') return this.endTest(await req.json());
    if (url.pathname === '/admin/campaign' && req.method === 'POST') { const b = await req.json(); const r = this.engine.startCampaign(b); if (r.ok) await this.save(true); return json(r, r.ok ? 200 : 409); }
    if (url.pathname === '/admin/smart' && req.method === 'POST') { const r = this.engine.pb ? this.engine.pb.setSmartList(await req.json()) : { ok: false, why: 'lane off' }; await this.save(); return json(r, r.ok ? 200 : 409); }
    if (url.pathname === '/smart-hook' && req.method === 'POST') return this.onSmartHook(await req.json().catch(() => null));
    if (url.pathname === '/dash') return json(dashData(this.S, this.config, this.health()));
    if (url.pathname === '/admin/state') return json({ S: { ...this.S, _dirty: undefined }, outbox: this.outbox.length, sent: this.sentLog || [], config: this.config });
    return json(this.health());
  }

  // Helius webhook push: the smart wallets' txs, raw. 1 Helius credit per tx, charged whatever we answer, so every
  // push goes on today's shared ledger and the webhook is paused for the rest of the day once the budget is spent.
  async onSmartHook(body) {
    const txs = Array.isArray(body) ? body : body ? [body] : [];
    const sm = (this.S.smart ||= { list: [], hook: { day: '', events: 0, disabled: null } });
    const H = (sm.hook ||= { day: '', events: 0, disabled: null });
    const day = new Date().toISOString().slice(0, 10);
    if (H.day !== day) { H.day = day; H.events = 0; }
    H.events += txs.length; H.lastAt = Date.now();
    chargeKeyed(txs.length);
    if (this.S.copy?.stats) this.S.copy.stats.events = (this.S.copy.stats.events || 0) + txs.length;
    let queued = 0;
    for (const tx of txs.slice(0, 50)) { try { if (this.engine.pb?.onSmartTx(tx)) queued++; } catch (e) { console.log('smart hook tx: ' + String(e?.message || e).slice(0, 120)); } }
    const budget = this.config.playbook?.copy?.hook_budget_day ?? 2500;
    if (H.events > budget && !H.disabled) await this.pauseSmartHook(`daily push budget ${budget} spent`);
    this.S._dirty.add('smart'); this.S._dirty.add('copy'); this.S._dirty.add('pb');
    await this.save();
    if (queued) { const a = await this.ctx.storage.getAlarm(); if (a == null || a > Date.now() + 1500) await this.ctx.storage.setAlarm(Date.now() + 500); }
    return json({ ok: true, txs: txs.length, queued });
  }

  // delete her one webhook (100 credits) so nothing more is charged today; the next daily build re-creates it
  async pauseSmartHook(why) {
    const H = this.S.smart.hook;
    H.disabled = { at: Date.now(), why };
    const key = this.env.HELIUS_RPC_URL ? new URL(this.env.HELIUS_RPC_URL).searchParams.get('api-key') : null;
    const id = this.S.smart.hookId;
    if (!key || !id) { console.log(`smart hook over budget (${why}); no key/id to pause it`); return; }
    try {
      const r = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks/${id}?api-key=${key}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
      chargeKeyed(100);
      H.disabled.deleted = r.ok; if (r.ok) this.S.smart.hookId = null;
      console.log(`smart hook paused: ${why} (delete ${r.status})`);
    } catch (e) { console.log('smart hook pause failed: ' + String(e?.message || e).slice(0, 80)); }
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

  // her call: end the running window early (report kept), start the next one now, one telegram note
  async endTest({ hours = 24, stoppedAt, text, sentAt, expectN, announce, campaignDays, where = 'cloudflare' }) {
    const r = this.engine.endTestEarly({ hours, stoppedAt, text, sentAt, expectN, campaignDays });
    if (!r.ok) return json(r, 409);
    const t = r.test, c = this.S.desk.campaign;
    const start = alert.testStartAlert({ equity: equity(this.S.desk), config: this.config, hours: t.hours, where, endsAt: t.endsAt }).split('\n');
    if (campaignDays && c) start.splice(0, 2, `🚀 ${c.days}-day paper run started on ${where}`, `balance $${equity(this.S.desk).toFixed(2)} · report every ${t.hours}h (day 1 report ${new Date(t.endsAt).toISOString().slice(0, 16).replace('T', ' ')} utc) · day ${c.days} go/no-go ${new Date(c.finalAt).toISOString().slice(0, 16).replace('T', ' ')} utc`);
    this.notify('test', [announce, start.join('\n')].filter(Boolean).join('\n\n').slice(0, 4000));
    this.S.timers.nextScan = 0; this.S.timers.nextWatch = 0;
    await this.save(true);
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return json({ ok: true, report: { n: r.report.n, at: new Date(r.report.at).toISOString(), early: true, hoursRun: r.report.hoursRun }, test: { ...t, startedAt: new Date(t.startedAt).toISOString(), endsAt: new Date(t.endsAt).toISOString() }, campaign: c ? { ...c, startedAt: new Date(c.startedAt).toISOString(), finalAt: new Date(c.finalAt).toISOString() } : null });
  }

  async reply(chatId, text) {
    if (!this.client) return;
    try { await this.client.sendMessage(chatId, text); } catch (e) { console.log('telegram reply failed: ' + this.client.redact(e.message)); }
  }

  // ---------- day 4: the button menu
  getMenu() {
    if (this.menu) return this.menu;
    const owner = this.lock.ownerChatId;
    const markup = (kb) => (kb && kb.length ? { reply_markup: { inline_keyboard: kb } } : {});
    const io = {
      send: async (text, kb) => {
        if (!this.client) return null;
        try { return (await this.client.sendMessage(owner, text, { parse_mode: 'HTML', ...markup(kb) }))?.message_id ?? null; }
        catch (e) { console.log('telegram send failed: ' + this.client.redact(e.message)); return null; }
      },
      edit: async (id, text, kb) => {
        if (!this.client) return false;
        try { await this.client.editMessageText(owner, id, text, { parse_mode: 'HTML', ...markup(kb) }); return true; }
        catch (e) {
          if (/not modified/i.test(e.description || e.message)) return true; // same text: nothing to do
          console.log('telegram edit failed: ' + this.client.redact(e.message)); return false; // old/deleted message: menu sends a fresh one
        }
      },
      answer: async (id, text, alert) => {
        if (!this.client) return;
        try { await this.client.answerCallbackQuery(id, text, alert); } catch (e) { console.log('telegram answer failed: ' + this.client.redact(e.message)); }
      },
    };
    const desk = {
      snapshot: () => this.engine.snapshot(),
      pause: async () => { this.engine.pause(); await this.save(); },
      resume: async () => { this.engine.resume(); await this.save(); },
      step: async (key, dir) => {
        const r = stepSetting(this.config, this.overrides, key, dir);
        if (r.ok) await this.ctx.storage.put('settings', this.overrides);
        return r;
      },
      check: (mint) => checkToken(mint, { config: this.config, S: this.S }),
      buy: async (c, usd, force) => {
        const r = await manualBuy(this.S, c, usd, this.config, { force });
        if (r.ok) {
          this.S._dirty.add('desk');
          this.engine.event?.('buy', `▲ PAPER BUY ${r.pos.id} $${r.pos.symbol} $${r.pos.sizeUsd.toFixed(2)} MANUAL (you, from the button menu)${force ? ' · bought anyway' : ''}`);
          this.S.timers.nextWatch = Date.now();
          const a = await this.ctx.storage.getAlarm();
          if (a == null || a > Date.now() + 2000) await this.ctx.storage.setAlarm(Date.now() + 1000); // start the 3s exit watch now
        }
        return r;
      },
      sell: async (id, pct) => {
        const r = await manualSell(this.S, id, pct, this.config);
        if (r.ok) { this.S._dirty.add('desk'); this.engine.event?.('sell', `▼ PAPER SELL ${id} ${pct}% MANUAL (you)${r.trade ? ` · closed ${r.trade.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(r.trade.pnlUsd).toFixed(2)}` : ''}`); }
        return r;
      },
      refresh: async (id) => {
        const pos = this.S.desk.positions.find((p) => p.id === id);
        if (!pos) return;
        const m = await markPrice(pos, pos.lastPrice, this.config);
        const p2 = this.S.desk.positions.find((p) => p.id === id);
        if (m && p2) { p2.lastPrice = m.price; p2.markUsd = p2.tokens * m.price; this.S._dirty.add('desk'); }
      },
      save: async () => {
        await this.save();
        const u = JSON.stringify(this.ui);
        if (u !== this.uiSaved) { this.uiSaved = u; await this.ctx.storage.put('ui', this.ui); }
      },
    };
    this.menu = createMenu({ io, desk, ui: this.ui, ownerId: owner });
    return this.menu;
  }

  async onTelegram(update) {
    const cq = update?.callback_query;
    if (cq) {
      if (this.lock.ownerChatId && cq.from?.id === this.lock.ownerChatId) { await this.getMenu().onCallback(cq); return; }
      // not the owner: one short "private" toast, nothing else runs
      if (this.client) try { await this.client.answerCallbackQuery(cq.id, 'this desk is private 🔒', true); } catch { /* ignore */ }
      return;
    }
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
      const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
      if (cmd === '/start' || cmd === '/menu') { await this.getMenu().sendHome(); return; }
      if (!msg.text.startsWith('/')) { await this.getMenu().onText(msg.text); return; }
      await this.reply(msg.chat.id, await runCommand(msg.text, desk));
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
    if (url.pathname === '/hook/smart' && req.method === 'POST') { // her Helius webhook (smart-wallet txs), auth = token derived from the admin key
      if (!env.ADMIN_KEY || !same(req.headers.get('authorization'), await hookToken(env.ADMIN_KEY))) return new Response('no', { status: 401 });
      return stub.fetch('https://desk/smart-hook', { method: 'POST', body: await req.text() });
    }
    if (url.pathname === '/health') return json(await (await stub.fetch('https://desk/health')).json());
    if (url.pathname === '/api/dash') {
      const r = await stub.fetch('https://desk/dash');
      return new Response(r.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/' || url.pathname === '/dashboard') return new Response(dashPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    return new Response('not found', { status: 404 });
  },
  // free plan watchdog: once a minute, make sure the desk's own alarm loop is alive
  async scheduled(event, env, ctx) {
    const stub = env.DESK.get(env.DESK.idFromName('desk'));
    ctx.waitUntil(stub.fetch('https://desk/kick'));
  },
};
