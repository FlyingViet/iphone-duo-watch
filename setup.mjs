#!/usr/bin/env node
// Interactive setup: writes config.json (what to watch) and .env (where to send alerts), then
// optionally installs the macOS LaunchAgent. Safe to re-run; current values are offered as defaults.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CARRIERS, COLORS, DEFAULTS, STORAGES, parseEnv, resolveConfig, selectParts } from './lib.mjs';
import { haNotifyServices, haRequest, push } from './notify.mjs';
import { installAgent } from './agent.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const ENV_FILE = path.join(ROOT, '.env');

// Echo goes through this stream so secret answers (tokens) aren't shown while typed.
let muted = false;
const output = new Writable({
  write(chunk, enc, cb) {
    const s = chunk.toString();
    if (!muted) process.stdout.write(s); else if (s.includes('\n')) process.stdout.write('\n');
    cb();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });

async function ask(q, def = '', { secret = false } = {}) {
  const shown = def ? (secret ? ' [keep current]' : ` [${def}]`) : '';
  muted = false;
  const p = rl.question(`${q}${shown}: `);
  muted = secret;
  const a = (await p).trim();
  muted = false;
  return a || def;
}

async function askYes(q, def = true) {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

// Comma-separated picks by number or name, e.g. "2,3" or "512GB, 1TB".
async function askMany(q, options, current) {
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const a = await ask(`${q} — numbers or names, comma-separated`, current.join(', '));
    const picks = a.split(',').map(s => s.trim()).filter(Boolean).map(s =>
      /^\d+$/.test(s) ? options[Number(s) - 1] : options.find(o => o.toLowerCase() === s.toLowerCase()));
    if (picks.length && picks.every(Boolean)) return [...new Set(picks)];
    console.log('  Not recognized, try again.');
  }
}

async function askOne(q, options, current) {
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const a = await ask(q, current);
    const pick = /^\d+$/.test(a) ? options[Number(a) - 1] : options.find(o => o.toLowerCase() === a.toLowerCase());
    if (pick) return pick;
    console.log('  Not recognized, try again.');
  }
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const plusDays = d => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function writeEnv(env) {
  const line = (k, v) => `${k}=${v ?? ''}`;
  const text = [
    '# Written by "npm run setup". Keep this file private: it holds your tokens.',
    '',
    '# Home Assistant (companion app push)',
    line('HA_URL', env.HA_URL), line('HA_TOKEN', env.HA_TOKEN), line('HA_NOTIFY_SERVICE', env.HA_NOTIFY_SERVICE),
    '',
    '# Optional: ntfy (https://ntfy.sh): subscribe to the topic in the ntfy app',
    line('NTFY_TOPIC', env.NTFY_TOPIC), line('NTFY_SERVER', env.NTFY_SERVER), line('NTFY_TOKEN', env.NTFY_TOKEN),
    '',
    '# Optional: Telegram bot',
    line('TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN), line('TELEGRAM_CHAT_ID', env.TELEGRAM_CHAT_ID),
    '',
  ].join('\n');
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
}

async function setupHomeAssistant(env) {
  console.log('\nHome Assistant: alerts go to your phone through the HA companion app.');
  console.log('  Token: in HA, click your profile (bottom left) → Security → Long-lived access tokens → Create token.');
  if (!(await askYes('Use Home Assistant for alerts?', Boolean(env.HA_URL) || !env.NTFY_TOPIC))) {
    return { ...env, HA_URL: '', HA_TOKEN: '', HA_NOTIFY_SERVICE: '' };
  }
  for (;;) {
    const url = (await ask('Home Assistant URL', env.HA_URL || 'http://homeassistant.local:8123')).replace(/\/$/, '');
    const token = await ask('Long-lived access token (input hidden)', env.HA_TOKEN, { secret: true });
    const next = { ...env, HA_URL: url, HA_TOKEN: token };
    process.stdout.write('  Checking Home Assistant… ');
    const ping = await haRequest(next, 'GET', '/api/');
    if (ping.status !== 200) {
      console.log(ping.status === 401 ? 'token rejected (401).' : `couldn't connect (${ping.status || ping.text}).`);
      if (await askYes('Try again?')) continue;
      return { ...next, HA_NOTIFY_SERVICE: await ask('Notify service (e.g. mobile_app_your_iphone)', env.HA_NOTIFY_SERVICE) };
    }
    console.log('connected.');
    let services = [];
    try { services = await haNotifyServices(next); } catch (e) { console.log(`  Couldn't list notify services: ${e.message}`); }
    const phones = services.filter(s => s.startsWith('mobile_app_'));
    let service;
    if (phones.length) {
      console.log('  Phones with the Home Assistant app:');
      service = await askOne('Send alerts to', phones, phones.includes(env.HA_NOTIFY_SERVICE) ? env.HA_NOTIFY_SERVICE : phones[0]);
    } else {
      console.log('  No mobile_app_* notify services found. Install the Home Assistant app on your iPhone and sign in, or type a service name.');
      service = await ask('Notify service', env.HA_NOTIFY_SERVICE || (services[0] ?? ''));
    }
    return { ...next, HA_NOTIFY_SERVICE: service };
  }
}

async function setupOptional(env) {
  const next = { ...env };
  if (await askYes('\nAlso (or instead) send alerts with ntfy? No Home Assistant needed.', Boolean(env.NTFY_TOPIC))) {
    console.log('  Install the ntfy app, subscribe to a hard-to-guess topic name, and enter the same name here.');
    next.NTFY_TOPIC = await ask('ntfy topic', env.NTFY_TOPIC || `duo-watch-${Math.random().toString(36).slice(2, 10)}`);
    next.NTFY_SERVER = await ask('ntfy server', env.NTFY_SERVER || 'https://ntfy.sh');
  } else Object.assign(next, { NTFY_TOPIC: '', NTFY_SERVER: '', NTFY_TOKEN: '' });
  if (await askYes('Also send alerts to Telegram?', Boolean(env.TELEGRAM_BOT_TOKEN))) {
    next.TELEGRAM_BOT_TOKEN = await ask('Bot token from @BotFather (input hidden)', env.TELEGRAM_BOT_TOKEN, { secret: true });
    next.TELEGRAM_CHAT_ID = await ask('Your chat ID', env.TELEGRAM_CHAT_ID);
  } else Object.assign(next, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
  return next;
}

async function main() {
  console.log('iPhone Duo stock watch: setup\n');
  const cur = { ...DEFAULTS, ...readJson(CONFIG_FILE) };
  const env = fs.existsSync(ENV_FILE) ? parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) : {};

  console.log('What to watch');
  const location = await ask('Your ZIP code', cur.location);
  const maxMiles = Number(await ask('Only stores within how many miles', String(cur.maxMiles))) || DEFAULTS.maxMiles;
  console.log('Storage:');
  const storage = await askMany('Storage sizes', STORAGES, cur.storage);
  console.log('Colors:');
  const colors = await askMany('Colors', COLORS, cur.colors);
  console.log('Carrier (only changes which Apple buy page the alert opens):');
  const carrier = await askOne('Carrier', CARRIERS, cur.carrier);
  const every = await ask('Check every N minutes (min-max)', [].concat(cur.checkEveryMinutes).join('-'));
  const checkEveryMinutes = every.split('-').map(Number).filter(n => n > 0);
  const endDate = (await ask('Stop watching on (YYYY-MM-DD, "none" for never)', cur.endDate || plusDays(30))).replace(/^none$/i, '');

  const config = { ...cur, location, maxMiles, storage, colors, carrier, checkEveryMinutes: checkEveryMinutes.length ? checkEveryMinutes : DEFAULTS.checkEveryMinutes, endDate };
  const resolved = resolveConfig(config, ROOT); // throws with a readable list if anything is off
  console.log(`  Watching ${Object.values(selectParts(storage, colors)).map(p => p.name).join(', ')}.`);

  let nextEnv = await setupHomeAssistant(env);
  nextEnv = await setupOptional(nextEnv);

  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  writeEnv(nextEnv);
  console.log(`\nSaved config.json and .env (private, mode 600).`);

  if (await askYes('Send a test push now?')) {
    const ok = await push(nextEnv, { title: 'iPhone Duo watch test', message: 'Setup works. You will get alerts like this one.', level: 'passive', tag: 'iphone-duo-status' }, m => console.log(`  ${m}`));
    console.log(ok ? '  Check your phone.' : '  Nothing delivered; re-run setup to fix the alert settings.');
  }
  if (process.platform === 'darwin' && await askYes('Run the watcher in the background now and at every login (LaunchAgent)?')) {
    console.log(`  ${installAgent(resolved)}`);
  } else {
    console.log('  Start it yourself with: npm start');
  }
  rl.close();
}

main().catch(e => { console.error(`\n${e.message}`); rl.close(); process.exit(1); });
