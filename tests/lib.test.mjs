import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG, buyUrl, diffAvailable, formatAlert, fulfillmentQuery, parseAvailability, parseEnv,
  pickupQuery, resolveConfig, selectParts,
} from '../lib.mjs';
import { plist } from '../agent.mjs';
import { channels } from '../notify.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = selectParts(['512GB', '1TB'], ['Star White', 'Night Sky']);
const store = (num, name, dist, avail) => ({
  storeNumber: num, storeName: name, city: 'X', storedistance: dist, storeDistanceWithUnit: `${dist} mi`,
  partsAvailability: Object.fromEntries(Object.keys(PARTS).map(p => [p, {
    pickupDisplay: avail[p] ? 'available' : 'unavailable',
    pickupSearchQuote: avail[p] ? 'Available Today' : 'Currently unavailable',
  }])),
});
const apple = stores => ({ body: { content: { pickupMessage: { stores } } } });

test('catalog covers every storage × color once', () => {
  assert.equal(CATALOG.length, 8);
  assert.equal(new Set(CATALOG.map(m => m.part)).size, 8);
  assert.deepEqual(Object.keys(selectParts(['2tb'], ['night sky'])), ['MK1R4LL/A']);
  assert.deepEqual(PARTS['MK1H4LL/A'], { name: '512GB Night Sky', slug: '512gb-night-sky' });
});

test('config: defaults, minutes → ms, end date, relative stateDir', () => {
  const c = resolveConfig({ location: '10001', storage: ['256GB'], colors: ['Night Sky'], checkEveryMinutes: 5, endDate: '2026-12-01' }, '/x');
  assert.deepEqual(Object.keys(c.parts), ['MK1F4LL/A']);
  assert.deepEqual(c.intervalMs, [300_000, 300_000]);
  assert.equal(c.maxMiles, 30);
  assert.equal(c.stateDir, '/x/state');
  assert.equal(new Date(c.expiresAt).getDate(), 1);
  assert.equal(resolveConfig({ location: '10001' }, '/x').expiresAt, null);
});

test('config: reports every problem at once', () => {
  assert.throws(() => resolveConfig({ location: '', storage: ['3TB'], colors: ['Blue'], carrier: 'sprint', endDate: 'soon' }, '/x'),
    e => ['location', 'storage', 'colors', 'carrier', 'endDate'].every(k => e.message.includes(k)));
});

test('config.example.json is valid apart from the blank location', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.throws(() => resolveConfig(raw, ROOT), /location is empty/);
  assert.equal(Object.keys(resolveConfig({ ...raw, location: '10001' }, ROOT).parts).length, 4);
});

test('.env parsing and channel detection', () => {
  const env = parseEnv('# c\nHA_URL="http://ha.local:8123"\nHA_TOKEN=abc=def\nHA_NOTIFY_SERVICE=\nNTFY_TOPIC=t\n');
  assert.equal(env.HA_URL, 'http://ha.local:8123');
  assert.equal(env.HA_TOKEN, 'abc=def');
  assert.deepEqual(channels(env), ['ntfy']);
  assert.deepEqual(channels({ ...env, HA_NOTIFY_SERVICE: 'mobile_app_x' }), ['Home Assistant', 'ntfy']);
  assert.deepEqual(channels(parseEnv(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'))), []);
});

test('queries encode parts and location; buy URL follows carrier', () => {
  assert.equal(fulfillmentQuery(['MK1G4LL/A'], '10001'),
    'fae=true&pl=true&mts.0=regular&mts.1=compact&parts.0=MK1G4LL%2FA&searchNearby=true&location=10001');
  assert.equal(pickupQuery(['MK1G4LL/A', 'MK1L4LL/A'], '10001'),
    'pl=true&searchNearby=true&location=10001&parts.0=MK1G4LL%2FA&parts.1=MK1L4LL%2FA');
  assert.equal(buyUrl('1tb-night-sky', 't-mobile'), 'https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-1tb-night-sky-t-mobile');
});

test('parse keeps stores within radius and lists available parts nearest first', () => {
  const r = parseAvailability(apple([
    store('R1', 'Far', 40, { 'MK1G4LL/A': true }),
    store('R2', 'Mid', 12.5, { 'MK1L4LL/A': true }),
    store('R3', 'Near', 3, { 'MK1G4LL/A': true }),
  ]), PARTS, 30);
  assert.deepEqual(r.stores.map(s => s.number), ['R2', 'R3']);
  assert.deepEqual(r.available.map(a => a.key), ['R3|MK1G4LL/A', 'R2|MK1L4LL/A']);
  assert.equal(r.available[0].quote, 'Available Today');
});

test('parse rejects unexpected payloads and accepts the pickup-message shape', () => {
  assert.throws(() => parseAvailability({}, PARTS, 30), /no stores/);
  const legacy = { body: { stores: [store('R1', 'Downtown', 1.5, { 'MK1L4LL/A': true })] } };
  assert.deepEqual(parseAvailability(legacy, PARTS, 30).available.map(a => a.key), ['R1|MK1L4LL/A']);
});

test('diff alerts once per appearance, not while it stays in stock', () => {
  const item = { key: 'R3|MK1G4LL/A' };
  let { toAlert, next } = diffAvailable({}, [item], 1000, 60_000);
  assert.equal(toAlert.length, 1);
  ({ toAlert, next } = diffAvailable(next, [item], 2000, 60_000));
  assert.equal(toAlert.length, 0);
  // gone, then back quickly: no repeat (flap guard)
  ({ toAlert, next } = diffAvailable(next, [], 3000, 60_000));
  ({ toAlert, next } = diffAvailable(next, [item], 4000, 60_000));
  assert.equal(toAlert.length, 0);
  // gone, then back after the re-alert window: alert again
  ({ toAlert, next } = diffAvailable(next, [], 5000, 60_000));
  ({ toAlert } = diffAvailable(next, [item], 70_000, 60_000));
  assert.equal(toAlert.length, 1);
});

test('format: single and grouped alerts link to the nearest option', () => {
  const a = { name: '1TB Night Sky', storeName: 'Downtown', miles: 3.14, quote: 'Available Today', part: 'MK1L4LL/A' };
  const b = { name: '512GB Star White', storeName: 'Mall', miles: 12, quote: 'Available Tomorrow', part: 'MK1G4LL/A' };
  const one = formatAlert([a], PARTS);
  assert.equal(one.title, '📱 iPhone Duo 1TB Night Sky at Downtown');
  assert.match(one.message, /Downtown \(3\.1 mi\) · Available Today/);
  const two = formatAlert([b, a], PARTS, 'verizon');
  assert.equal(two.title, '📱 iPhone Duo in stock · 2 options nearby');
  assert.equal(two.url, buyUrl('1tb-night-sky', 'verizon'));
  assert.ok(two.message.indexOf('Downtown') < two.message.indexOf('Mall'));
});

test('LaunchAgent plist runs the watcher from the repo and escapes paths', () => {
  const cfg = resolveConfig({ location: '10001', launchAgentLabel: 'local.test' }, '/repo');
  const p = plist(cfg, '/opt/node & co/bin/node', '/repo');
  assert.match(p, /<string>local\.test<\/string>/);
  assert.match(p, /<string>\/opt\/node &amp; co\/bin\/node<\/string><string>\/repo\/duo-watch\.mjs<\/string>/);
  assert.match(p, /<string>\/repo\/state\/launchd\.log<\/string>/);
});
