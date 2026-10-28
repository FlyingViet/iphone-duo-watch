#!/usr/bin/env node
// iPhone Duo in-store pickup watcher.
// Apple's availability endpoints reject non-browser clients (HTTP 541), so a headless Chrome stays on
// apple.com and runs the same fetch the store page uses. New availability near you is pushed to your phone.
//
//   node duo-watch.mjs                run the watcher loop
//   node duo-watch.mjs --once         one check, print what it sees, no pushes
//   node duo-watch.mjs --test-alert   send a test push through every configured channel
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCES, buyUrl, describeWatch, diffAvailable, formatAlert, parseAvailability, parseEnv,
  readConfigFile, resolveConfig, summarize,
} from './lib.mjs';
import { channels, push } from './notify.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = 'https://www.apple.com/shop/buy-iphone';
const PAGE_REFRESH_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

let cfg;
let env = {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    const f = path.join(cfg.stateDir, 'watch.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 1_000_000) fs.renameSync(f, `${f}.1`);
    fs.appendFileSync(f, line);
  } catch {}
  if (process.stdout.isTTY || process.argv.includes('--once')) process.stdout.write(line);
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

const notify = msg => push(env, msg, log);

function findChrome() {
  const p = cfg.chromePath || CHROME_CANDIDATES.find(c => fs.existsSync(c));
  if (!p || !fs.existsSync(p)) throw new Error('Chrome/Chromium not found. Install Google Chrome or set "chromePath" in config.json.');
  return p;
}

// ------------------------------------------------------------------ headless Chrome via CDP

export class Browser {
  constructor(name = 'chrome-profile') {
    this.profile = path.join(cfg.stateDir, name);
    this.pidFile = `${this.profile}.pid`;
    this.ws = null; this.proc = null;
  }

  get alive() { return this.ws && this.ws.readyState === WebSocket.OPEN && this.proc && this.proc.exitCode === null; }

  killStale() {
    let pid;
    try { pid = Number(fs.readFileSync(this.pidFile, 'utf8')); } catch { return; }
    if (!pid) return;
    try {
      const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (cmd.includes(`--user-data-dir=${this.profile} `)) { process.kill(pid, 'SIGTERM'); log(`stopped stale Chrome ${pid}`); }
    } catch {}
  }

  async start() {
    await this.stop();
    this.killStale();
    fs.mkdirSync(this.profile, { recursive: true });
    const portFile = path.join(this.profile, 'DevToolsActivePort');
    try { fs.unlinkSync(portFile); } catch {}
    const headed = process.env.DUO_HEADED === '1';
    this.proc = spawn(findChrome(), [
      ...(headed ? ['--window-position=-2400,-2400'] : ['--headless=new']),
      '--remote-debugging-port=0', `--user-data-dir=${this.profile}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
    ], { stdio: 'ignore' });
    fs.writeFileSync(this.pidFile, String(this.proc.pid));
    let port;
    for (let i = 0; i < 60 && !port; i++) {
      await sleep(250);
      try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); } catch {}
    }
    if (!port) throw new Error('Chrome did not expose DevTools');
    let page;
    for (let i = 0; i < 40 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('no Chrome page target');
    this.id = 0; this.pending = new Map();
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('CDP connect failed')); });
    const ua = (await this.evaluate('navigator.userAgent')).replace('HeadlessChrome', 'Chrome');
    await this.send('Network.setUserAgentOverride', { userAgent: ua });
    await this.send('Page.enable');
    await this.open();
    log(`Chrome started pid ${this.proc.pid}`);
  }

  send(method, params = {}, timeoutMs = 45_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }

  async open() {
    await this.send('Page.navigate', { url: PAGE_URL });
    await sleep(8000);
    this.openedAt = Date.now();
  }

  async stop() {
    try { this.ws?.close(); } catch {}
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      await sleep(1500);
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    this.ws = null; this.proc = null;
  }

  async getJson(url) {
    const res = await this.evaluate(
      `fetch(${JSON.stringify(url)},{credentials:'include'}).then(async r=>({status:r.status,body:await r.text()}))`);
    if (res.status !== 200) throw new Error(`Apple HTTP ${res.status}`);
    try { return JSON.parse(res.body); } catch { throw new Error('Apple returned non-JSON'); }
  }
}

// ------------------------------------------------------------------ watcher

async function fetchStores(browser) {
  const parts = Object.keys(cfg.parts);
  const errors = [];
  for (const src of SOURCES) {
    try {
      const parsed = parseAvailability(await browser.getJson(`${src.path}?${src.query(parts, cfg.location)}`), cfg.parts, cfg.maxMiles);
      parsed.source = src.name;
      return parsed;
    } catch (e) { errors.push(`${src.name}: ${e.message}`); }
  }
  throw new Error(errors.join('; '));
}

async function checkOnce(browser) {
  if (!browser.alive) await browser.start();
  else if (Date.now() - browser.openedAt > PAGE_REFRESH_MS) await browser.open();
  try {
    return await fetchStores(browser);
  } catch (e) {
    log(`check failed (${e.message}); reloading apple.com and retrying`);
    await browser.open();
    return await fetchStores(browser);
  }
}

async function runLoop() {
  const statePath = path.join(cfg.stateDir, 'state.json');
  const statusPath = path.join(cfg.stateDir, 'status.json');
  const browser = new Browser();
  const firstSlug = Object.values(cfg.parts)[0].slug;
  let failures = 0;
  const shutdown = async sig => { log(`${sig}; stopping`); await browser.stop(); process.exit(0); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  const via = channels(env);
  log(`watcher start pid ${process.pid}; ${describeWatch(cfg)} (${Object.keys(cfg.parts).length} models) near ${cfg.location} ≤${cfg.maxMiles} mi; ` +
    `alerts via ${via.length ? via.join(', ') : 'macOS notifications only'}${cfg.endDate ? `; ends ${cfg.endDate}` : ''}`);

  while (true) {
    const now = Date.now();
    let state = readJson(statePath, {});
    if (cfg.expiresAt && now >= cfg.expiresAt) {
      await notify({ title: 'iPhone Duo watch ended', message: `Stopped at its ${cfg.endDate} end date. Change endDate in config.json and start it again if you still need one.`, level: 'passive', tag: 'iphone-duo-status' });
      await browser.stop();
      // A LaunchAgent would restart us at the next login; remove it so the watch really ends.
      const plist = path.join(process.env.HOME || '', 'Library/LaunchAgents', `${cfg.launchAgentLabel}.plist`);
      try { fs.unlinkSync(plist); log(`removed ${plist}`); } catch {}
      writeJson(statusPath, { ...readJson(statusPath, {}), endedAt: new Date().toISOString(), running: false });
      log('end date reached; exiting');
      process.exit(0);
    }
    let status = { running: true, pid: process.pid, location: cfg.location, maxMiles: cfg.maxMiles, watching: describeWatch(cfg), endDate: cfg.endDate || null, checkedAt: new Date(now).toISOString() };
    try {
      const parsed = await checkOnce(browser);
      failures = 0;
      const { toAlert, next } = diffAvailable(state, parsed.available, now, cfg.realertAfterMs);
      state = next;
      if (state.failAlerted) {
        await notify({ title: 'iPhone Duo watch reconnected', message: 'Checking Apple again.', level: 'passive', tag: 'iphone-duo-status' });
      }
      state.lastSuccessAt = now; state.failingSince = null; state.failAlerted = false;
      if (!state.startNotified) {
        const where = parsed.stores.slice(0, 3).map(s => s.name).join(', ');
        state.startNotified = await notify({
          title: '👀 Watching for iPhone Duo',
          message: `${describeWatch(cfg)} at ${parsed.stores.length} Apple Stores within ${cfg.maxMiles} mi (${where}…). ` +
            `${parsed.available.length ? `${parsed.available.length} in stock right now.` : 'None in stock right now.'} You'll get an alert when one appears.`,
          url: buyUrl(firstSlug, cfg.carrier), level: 'passive', tag: 'iphone-duo-status',
        });
      }
      if (toAlert.length) {
        log(`IN STOCK: ${toAlert.map(i => `${i.name}@${i.storeName}`).join(', ')}`);
        await notify({ ...formatAlert(toAlert, cfg.parts, cfg.carrier), level: 'time-sensitive', tag: 'iphone-duo-stock' });
      }
      status = { ...status, ok: true, source: parsed.source, storesChecked: parsed.stores.length, available: parsed.available, stores: summarize(parsed, cfg.parts) };
      log(`ok via ${parsed.source}: ${parsed.stores.length} stores, ${parsed.available.length} available${toAlert.length ? `, alerted ${toAlert.length}` : ''}`);
    } catch (e) {
      failures += 1;
      state.failingSince = state.failingSince || now;
      log(`error #${failures}: ${e.message}`);
      status = { ...status, ok: false, error: e.message, failingSince: new Date(state.failingSince).toISOString() };
      if (failures >= 2) await browser.stop();
      if (!state.failAlerted && now - state.failingSince >= cfg.failAlertAfterMs) {
        state.failAlerted = await notify({ title: '⚠️ iPhone Duo watch can’t reach Apple', message: `Failing for ${Math.round((now - state.failingSince) / 60000)} min: ${e.message}. It keeps retrying.`, level: 'active', tag: 'iphone-duo-status' });
      }
    }
    const [lo, hi] = cfg.intervalMs;
    const wait = Math.min(MAX_BACKOFF_MS, (lo + Math.random() * (hi - lo)) * 2 ** Math.min(failures, 3));
    status.nextCheckAt = new Date(Date.now() + wait).toISOString();
    writeJson(statePath, state);
    writeJson(statusPath, status);
    await sleep(wait);
  }
}

export function loadAll(root = ROOT) {
  const config = resolveConfig(readConfigFile(path.join(root, 'config.json')), root);
  const envFile = path.join(root, '.env');
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  return { config, env: { ...fileEnv, ...process.env } };
}

async function main() {
  ({ config: cfg, env } = loadAll());
  const args = process.argv.slice(2);
  if (args.includes('--test-alert')) {
    const via = channels(env);
    console.log(`Sending a test push via ${via.length ? via.join(', ') : 'macOS notification (no channel set in .env)'}…`);
    const ok = await notify({ title: 'iPhone Duo watch test', message: `Test push. Watching ${describeWatch(cfg)} near ${cfg.location}.`, url: buyUrl(Object.values(cfg.parts)[0].slug, cfg.carrier), level: 'passive', tag: 'iphone-duo-status' });
    console.log(ok ? 'Delivered.' : 'No channel delivered. Check .env (see watch.log in the state folder).');
    process.exit(ok ? 0 : 1);
  }
  if (args.includes('--once')) {
    const b = new Browser('chrome-profile-once');
    try {
      const parsed = await checkOnce(b);
      console.log(JSON.stringify({ watching: describeWatch(cfg), source: parsed.source, available: parsed.available, stores: summarize(parsed, cfg.parts) }, null, 2));
    } finally { await b.stop(); }
    process.exit(0);
  }
  await runLoop();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    if (cfg) log(`fatal: ${e.stack || e}`);
    console.error(e.message);
    process.exit(1);
  });
}
