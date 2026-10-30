// ============================================================================
// OWNER LOCK
// Job: make sure only ONE chat can control the desk. On first boot the desk
//      makes a one-time pairing code. The first private chat that sends
//      "/start CODE" becomes the owner and the code is burned. After that the
//      owner's chat id is the only key: every other chat hears "this desk is
//      private" and nothing else. Optional read-only alert subscribers live
//      in config.json (telegram.alertSubscribers) and can't run commands.
// HARD STOP: no command runs for anyone but the owner. Ever.
// ============================================================================
// Web Crypto only (no node:crypto), so this file runs in Node AND on Cloudflare Workers.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export function newPairingCode(n = 6) {
  const r = globalThis.crypto.getRandomValues(new Uint32Array(n)); // 32 letters: no modulo bias
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}

export async function loadLock(store) {
  const lock = await store.get('telegram', {});
  if (!lock.ownerChatId && !lock.pairingCode) {
    lock.pairingCode = newPairingCode();
    lock.pairingCreatedAt = Date.now();
    await store.put('telegram', lock);
  }
  return lock;
}

// constant-time compare: same work whether the first or the last letter is wrong
const sameCode = (a, b) => {
  const x = String(a).toUpperCase(), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
};

// who is talking? 'owner' | 'pair' | 'subscriber' | 'stranger'
export function classify(msg, lock, config) {
  const chatId = msg?.chat?.id;
  if (lock.ownerChatId && chatId === lock.ownerChatId) return 'owner';
  const m = String(msg?.text || '').trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9]{4,12})$/);
  if (!lock.ownerChatId && lock.pairingCode && m && msg.chat.type === 'private'
      && msg.date * 1000 >= (lock.pairingCreatedAt || 0) - 60_000 && sameCode(m[1], lock.pairingCode)) return 'pair';
  if ((config.telegram?.alertSubscribers || []).map(String).includes(String(chatId))) return 'subscriber';
  return 'stranger';
}

export async function pairOwner(store, lock, msg) {
  lock.ownerChatId = msg.chat.id;
  lock.ownerFirstName = msg.from?.first_name || null;
  lock.pairedAt = new Date().toISOString();
  delete lock.pairingCode; delete lock.pairingCreatedAt;
  await store.put('telegram', lock);
  return lock;
}

export const PRIVATE_TEXT = 'hi 👋 this desk is private. it only takes orders from its owner.';
export const SUBSCRIBER_TEXT = 'you get read-only alerts from this desk 👀 only the owner can control it.';
