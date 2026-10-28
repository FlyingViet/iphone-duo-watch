// Pure logic for the iPhone Duo pickup watcher: catalog, config, Apple response parsing, alert diffing.
import fs from 'node:fs';
import path from 'node:path';

// US (LL/A) iPhone Duo models from apple.com/shop/buy-iphone/iphone-duo. Carrier models share the
// same part number; only the buy-page URL differs, so stock is tracked per part.
export const CATALOG = [
  { part: 'MK1E4LL/A', storage: '256GB', color: 'Star White' },
  { part: 'MK1F4LL/A', storage: '256GB', color: 'Night Sky' },
  { part: 'MK1G4LL/A', storage: '512GB', color: 'Star White' },
  { part: 'MK1H4LL/A', storage: '512GB', color: 'Night Sky' },
  { part: 'MK1J4LL/A', storage: '1TB', color: 'Star White' },
  { part: 'MK1L4LL/A', storage: '1TB', color: 'Night Sky' },
  { part: 'MK1Q4LL/A', storage: '2TB', color: 'Star White' },
  { part: 'MK1R4LL/A', storage: '2TB', color: 'Night Sky' },
];
export const STORAGES = ['256GB', '512GB', '1TB', '2TB'];
export const COLORS = ['Star White', 'Night Sky'];
export const CARRIERS = ['unlocked', 'att', 't-mobile', 'verizon'];

export const DEFAULTS = {
  location: '',
  maxMiles: 30,
  storage: ['512GB', '1TB'],
  colors: [...COLORS],
  carrier: 'unlocked',
  checkEveryMinutes: [2, 3],
  realertAfterMinutes: 20,
  failAlertAfterMinutes: 30,
  endDate: '',
  chromePath: '',
  stateDir: 'state',
  launchAgentLabel: 'local.iphone-duo-watch',
};

const slugify = s => s.toLowerCase().replace(/\s+/g, '-');

// { 'MK1H4LL/A': { name: '512GB Night Sky', slug: '512gb-night-sky' }, ... }
export function selectParts(storage, colors) {
  const want = new Set(storage.map(s => s.toUpperCase()));
  const hues = new Set(colors.map(c => c.toLowerCase()));
  return Object.fromEntries(CATALOG
    .filter(m => want.has(m.storage.toUpperCase()) && hues.has(m.color.toLowerCase()))
    .map(m => [m.part, { name: `${m.storage} ${m.color}`, slug: slugify(`${m.storage} ${m.color}`) }]));
}

// Merges config.json over DEFAULTS, validates it, and resolves paths and parts. Throws with every problem at once.
export function resolveConfig(raw, baseDir) {
  const c = { ...DEFAULTS, ...raw };
  const errors = [];
  c.location = String(c.location || '').trim();
  if (!c.location) errors.push('location is empty (set your ZIP code, e.g. "10001")');
  c.maxMiles = Number(c.maxMiles);
  if (!(c.maxMiles > 0)) errors.push('maxMiles must be a positive number');
  const badStorage = c.storage.filter(s => !STORAGES.some(x => x.toUpperCase() === String(s).toUpperCase()));
  if (badStorage.length) errors.push(`storage has unknown values ${JSON.stringify(badStorage)} (use ${STORAGES.join(', ')})`);
  const badColors = c.colors.filter(s => !COLORS.some(x => x.toLowerCase() === String(s).toLowerCase()));
  if (badColors.length) errors.push(`colors has unknown values ${JSON.stringify(badColors)} (use ${COLORS.join(', ')})`);
  if (!CARRIERS.includes(c.carrier)) errors.push(`carrier must be one of ${CARRIERS.join(', ')}`);
  const every = [].concat(c.checkEveryMinutes).map(Number);
  const [lo, hi = lo] = every;
  if (!(lo >= 1 && hi >= lo)) errors.push('checkEveryMinutes must be a number ≥ 1 or [min, max]');
  c.intervalMs = [lo * 60_000, hi * 60_000];
  c.realertAfterMs = Number(c.realertAfterMinutes) * 60_000;
  c.failAlertAfterMs = Number(c.failAlertAfterMinutes) * 60_000;
  c.expiresAt = null;
  if (c.endDate) {
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(c.endDate) ? `${c.endDate}T23:59:59` : c.endDate);
    if (Number.isNaN(t)) errors.push('endDate must be YYYY-MM-DD (or empty for no end date)');
    else c.expiresAt = t;
  }
  c.parts = errors.length ? {} : selectParts(c.storage, c.colors);
  if (!errors.length && !Object.keys(c.parts).length) errors.push('storage × colors matches no models');
  if (errors.length) throw new Error(`config.json:\n  - ${errors.join('\n  - ')}`);
  c.stateDir = path.resolve(baseDir, c.stateDir);
  return c;
}

export function readConfigFile(file) {
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} not found. Run "npm run setup" or copy config.example.json to config.json.`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

// KEY=value lines; # comments; optional quotes.
export function parseEnv(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export const buyUrl = (slug, carrier = 'unlocked') =>
  `https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-${slug}-${carrier}`;

export function fulfillmentQuery(partNumbers, location) {
  const q = ['fae=true', 'pl=true', 'mts.0=regular', 'mts.1=compact'];
  partNumbers.forEach((p, i) => q.push(`parts.${i}=${encodeURIComponent(p)}`));
  q.push('searchNearby=true', `location=${encodeURIComponent(location)}`);
  return q.join('&');
}

export function pickupQuery(partNumbers, location) {
  const q = ['pl=true', 'searchNearby=true', `location=${encodeURIComponent(location)}`];
  partNumbers.forEach((p, i) => q.push(`parts.${i}=${encodeURIComponent(p)}`));
  return q.join('&');
}

// Both endpoints return the same store data; when Apple rate-limits one (HTTP 541) the other usually still answers.
export const SOURCES = [
  { name: 'pickup-message', path: '/shop/retail/pickup-message', query: pickupQuery },
  { name: 'fulfillment-messages', path: '/shop/fulfillment-messages', query: fulfillmentQuery },
];

function miles(store) {
  const n = Number(store.storedistance);
  if (Number.isFinite(n)) return n;
  const m = String(store.storeDistanceWithUnit || '').match(/[\d.]+/);
  return m ? Number(m[0]) : Infinity;
}

export function parseAvailability(json, parts, maxMiles) {
  const stores = json?.body?.content?.pickupMessage?.stores ?? json?.body?.stores;
  if (!Array.isArray(stores)) throw new Error('unexpected response: no stores');
  const out = { stores: [], available: [] };
  for (const s of stores) {
    const dist = miles(s);
    if (dist > maxMiles) continue;
    const row = { number: s.storeNumber, name: s.storeName, city: s.city, miles: dist, parts: {} };
    for (const part of Object.keys(parts)) {
      const pa = s.partsAvailability?.[part];
      if (!pa) continue;
      row.parts[part] = { display: pa.pickupDisplay, quote: pa.pickupSearchQuote || '' };
      if (pa.pickupDisplay === 'available') {
        out.available.push({
          key: `${s.storeNumber}|${part}`, store: s.storeNumber, storeName: s.storeName,
          miles: dist, part, name: parts[part].name, quote: pa.pickupSearchQuote || 'Available',
        });
      }
    }
    out.stores.push(row);
  }
  out.available.sort((a, b) => a.miles - b.miles || a.name.localeCompare(b.name));
  return out;
}

// state: { current: {key: sinceMs}, lastAlerted: {key: ms} }. Alerts once per appearance; a model that
// disappears and comes back within realertAfterMs is treated as the same appearance (flap guard).
export function diffAvailable(state, available, now, realertAfterMs) {
  const prev = state.current || {};
  const lastAlerted = { ...(state.lastAlerted || {}) };
  const current = {};
  const toAlert = [];
  for (const item of available) {
    current[item.key] = prev[item.key] ?? now;
    const isNew = !(item.key in prev);
    const last = lastAlerted[item.key];
    if (isNew && (last === undefined || now - last >= realertAfterMs)) {
      toAlert.push(item);
      lastAlerted[item.key] = now;
    }
  }
  for (const [k, t] of Object.entries(lastAlerted)) if (now - t > 86_400_000 && !(k in current)) delete lastAlerted[k];
  return { toAlert, next: { ...state, current, lastAlerted } };
}

export const fmtMiles = m => (Number.isFinite(m) ? `${Math.round(m * 10) / 10} mi` : '?');

export function formatAlert(items, parts, carrier = 'unlocked') {
  const sorted = [...items].sort((a, b) => a.miles - b.miles);
  const first = sorted[0];
  const title = sorted.length === 1
    ? `📱 iPhone Duo ${first.name} at ${first.storeName}`
    : `📱 iPhone Duo in stock · ${sorted.length} options nearby`;
  const lines = sorted.slice(0, 6).map(i => `${i.name} · ${i.storeName} (${fmtMiles(i.miles)}) · ${i.quote}`);
  if (sorted.length > 6) lines.push(`+${sorted.length - 6} more`);
  lines.push('Tap to open Apple and choose in-store pickup.');
  return { title, message: lines.join('\n'), url: buyUrl(parts[first.part].slug, carrier) };
}

export function summarize(parsed, parts) {
  return parsed.stores.slice(0, 12).map(s =>
    `${s.name} (${fmtMiles(s.miles)}): ` +
    Object.entries(s.parts).map(([p, v]) => `${parts[p]?.name ?? p}=${v.display}`).join(', '));
}

// "512GB/1TB · Star White/Night Sky"
export const describeWatch = cfg =>
  `${cfg.storage.join('/')} · ${cfg.colors.length === COLORS.length ? 'either color' : cfg.colors.join('/')}`;
