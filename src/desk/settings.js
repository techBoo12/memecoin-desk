// ============================================================================
// SETTINGS (editable from Telegram)
// Job: the ONLY config keys the owner can change from her phone, each with a
//      safe range. config.json stays the defaults; changes from Telegram are
//      saved as overrides (state/settings.json locally, Durable Object storage on Cloudflare) and laid on
//      top at boot and on every /set.
// HARD STOP: mode is not on this list. Paper stays paper until a separate,
//            human-signed step. Values outside the range are refused.
// ============================================================================
export const SETTINGS = {
  maxpertrade: { path: 'risk.maxPositionPct', min: 1, max: 20, unit: '%', label: 'max per trade (% of balance)' },
  risk:        { path: 'risk.riskPerTradePct', min: 0.1, max: 2, unit: '%', label: 'risk per trade = 1R (% of balance)' },
  stop:        { path: 'risk.stopLossPct', min: 2, max: 25, unit: '%', label: 'stop loss below entry' },
  trailat:     { path: 'risk.trailActivatePct', min: 5, max: 200, unit: '%', label: 'trailing stop turns on at +' },
  trail:       { path: 'risk.trailDistancePct', min: 3, max: 40, unit: '%', label: 'trailing stop distance' },
  minscore:    { path: 'analyst.passScore', min: 50, max: 95, int: true, label: 'min analyst score to trade' },
  dailyloss:   { path: 'account.dailyLossLimitPct', min: 1, max: 20, unit: '%', label: 'daily loss limit (freezes the desk)' },
  maxopen:     { path: 'risk.maxOpenPositions', min: 1, max: 5, int: true, label: 'max open trades' },
  minliq:      { path: 'filter.minLiquidityUsd', min: 10_000, max: 1_000_000, int: true, unit: '$', label: 'kill rule 3: min liquidity' },
  minvol:      { path: 'filter.minVolume1hUsd', min: 10_000, max: 1_000_000, int: true, unit: '$', label: 'kill rule 4: min 1h volume' },
  scanevery:   { path: 'loop.scanEverySec', min: 60, max: 1800, int: true, unit: 's', label: 'scan every (seconds)' },
  scanalerts:  { path: 'telegram.scanAlerts', bool: true, label: 'scan summary alerts on/off' },
  maxtrades:   { path: 'quality.maxTradesPerDay', min: 1, max: 20, int: true, label: 'max new trades per day' },
  minbuys:     { path: 'quality.minBuyShare1h', min: 0.5, max: 0.8, label: 'min share of 1h txns that are buys (0.55 = 55%)' },
  minliqmcap:  { path: 'quality.minLiqToMcap', min: 0.02, max: 0.5, label: 'min liquidity / market cap (0.08 = 8%)' },
  watchevery:  { path: 'loop.watchEverySec', min: 2, max: 30, int: true, unit: 's', label: 'check open trades every (seconds)' },
};

export const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z]/g, '');

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, p, v) {
  const ks = p.split('.'); let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k] ??= {};
  o[ks.at(-1)] = v;
}

export function applyOverrides(config, overrides = {}) {
  for (const [key, v] of Object.entries(overrides)) if (SETTINGS[key]) setPath(config, SETTINGS[key].path, v);
  return config;
}

export function showValue(spec, v) {
  if (spec.bool) return v ? 'on' : 'off';
  if (spec.unit === '$') return `$${Number(v).toLocaleString('en-US')}`;
  return `${v}${spec.unit === '%' ? '%' : spec.unit === 's' ? 's' : ''}`;
}

export function parseValue(spec, raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (spec.bool) {
    if (['on', 'true', 'yes', '1'].includes(s)) return { ok: true, value: true };
    if (['off', 'false', 'no', '0'].includes(s)) return { ok: true, value: false };
    return { ok: false, error: 'use on or off' };
  }
  const m = s.replace(/[$,%\s]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return { ok: false, error: 'that is not a number' };
  let v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
  if (spec.int) v = Math.round(v);
  if (v < spec.min || v > spec.max) return { ok: false, error: `must be between ${showValue(spec, spec.min)} and ${showValue(spec, spec.max)}` };
  return { ok: true, value: v };
}

// returns { ok, key, old, value } or { ok:false, error }
export function changeSetting(config, overrides, rawKey, rawValue) {
  const key = normKey(rawKey);
  const spec = SETTINGS[key];
  if (!spec) return { ok: false, error: `"${rawKey}" can't be changed from here. /settings shows what can` };
  const p = parseValue(spec, rawValue);
  if (!p.ok) return { ok: false, error: `${key} ${p.error}` };
  const old = getPath(config, spec.path);
  setPath(config, spec.path, p.value);
  overrides[key] = p.value;
  return { ok: true, key, spec, old, value: p.value };
}

export function listSettings(config) {
  return Object.entries(SETTINGS).map(([key, spec]) => ({ key, spec, value: getPath(config, spec.path) }));
}
