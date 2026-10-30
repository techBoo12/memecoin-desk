// ============================================================================
// STORE
// Job: keep small bits of desk state (who the owner is, settings changed from
//      Telegram) behind an async get/put. Today: JSON files in state/.
//      Later: Cloudflare KV with the same two calls.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

export function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, `${key.replace(/[^a-z0-9_-]/gi, '')}.json`);
  return {
    async get(key, fallback = null) {
      try { return JSON.parse(fs.readFileSync(file(key), 'utf8')); } catch { return fallback; }
    },
    async put(key, value) {
      const f = file(key);
      fs.writeFileSync(f + '.tmp', JSON.stringify(value, null, 1));
      fs.renameSync(f + '.tmp', f);
    },
  };
}
