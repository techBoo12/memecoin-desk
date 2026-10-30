// ============================================================================
// TELEGRAM CLIENT
// Job: talk to the Telegram Bot API with plain fetch. getMe, long-polling
//      getUpdates, sendMessage. No library, no webhook server, so the same
//      code runs in Node today and in a Cloudflare Worker later.
// HARD STOP: the bot token comes from process.env.TELEGRAM_BOT_TOKEN (or is
//            passed in by the platform) and goes ONLY to api.telegram.org.
//            It is never logged, printed, saved or returned. Every error
//            that leaves this file has the token scrubbed out of it.
// ============================================================================
const API = 'https://api.telegram.org';
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`telegram ${method}: ${code} ${description}`);
    this.method = method; this.code = code; this.description = description;
  }
}

export function createTelegramClient({ token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = globalThis.fetch, timeoutMs = 40_000 } = {}) {
  const t = String(token ?? '').trim();
  if (!TOKEN_SHAPE.test(t)) throw new Error('TELEGRAM_BOT_TOKEN is missing or is not a bot token (value not shown)');
  const redact = (s) => String(s ?? '').split(t).join('[token]');

  async function call(method, params = {}, { timeout = timeoutMs } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res, body;
    try {
      res = await fetchImpl(`${API}/bot${t}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params), signal: ctl.signal,
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      throw new TelegramError(method, 0, redact(e?.name === 'AbortError' ? 'timed out' : e?.message));
    } finally { clearTimeout(timer); }
    if (!body?.ok) {
      const err = new TelegramError(method, body?.error_code ?? res.status, redact(body?.description ?? `http ${res.status}`));
      err.retryAfter = body?.parameters?.retry_after;
      throw err;
    }
    return body.result;
  }

  return {
    call, redact,
    getMe: () => call('getMe'),
    // long polling: Telegram holds the request open up to `timeout` s until a message arrives
    getUpdates: (offset, timeout = 25) =>
      call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, { timeout: (timeout + 15) * 1000 }),
    sendMessage: (chatId, text, extra = {}) =>
      call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }),
  };
}
