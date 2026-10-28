// Push notifications: Home Assistant companion app first, then ntfy / Telegram, then a local macOS banner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Under launchd, Homebrew/nvm node is often denied macOS Local Network access, so a fetch to a LAN
// Home Assistant fails while Apple's /usr/bin/python3 is allowed. The token goes over stdin, not argv.
const PY_REQUEST = `
import json, sys, urllib.request, urllib.error
d = json.load(sys.stdin)
body = json.dumps(d["body"]).encode() if d.get("body") is not None else None
req = urllib.request.Request(d["url"], data=body, method=d["method"],
    headers={"Authorization": "Bearer " + d["token"], "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=15) as r: print(json.dumps({"status": r.status, "text": r.read().decode()}))
except urllib.error.HTTPError as e: print(json.dumps({"status": e.code, "text": ""}))
except Exception as e: print(json.dumps({"status": 0, "text": str(e)}))
`;

function pyRequest(method, url, token, body) {
  return new Promise(resolve => {
    const p = spawn('/usr/bin/python3', ['-c', PY_REQUEST], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', e => resolve({ status: 0, text: e.message }));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ status: 0, text: out.trim() || 'no output' }); } });
    p.stdin.end(JSON.stringify({ method, url, token, body }));
  });
}

// Home Assistant REST call; returns { status, text }.
export async function haRequest(env, method, apiPath, body) {
  const url = `${env.HA_URL.replace(/\/$/, '')}${apiPath}`;
  try {
    const r = await fetch(url, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${env.HA_TOKEN}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/python3')) return pyRequest(method, url, env.HA_TOKEN, body);
    return { status: 0, text: e.message };
  }
}

// notify.mobile_app_* services, i.e. phones with the Home Assistant companion app.
export async function haNotifyServices(env) {
  const r = await haRequest(env, 'GET', '/api/services');
  if (r.status !== 200) throw new Error(r.status === 401 ? 'token rejected (401)' : `HTTP ${r.status || r.text}`);
  const notify = JSON.parse(r.text).find(d => d.domain === 'notify');
  return Object.keys(notify?.services ?? {}).sort((a, b) => b.startsWith('mobile_app_') - a.startsWith('mobile_app_') || a.localeCompare(b));
}

export const channels = env => [
  env.HA_URL && env.HA_TOKEN && env.HA_NOTIFY_SERVICE && 'Home Assistant',
  env.NTFY_TOPIC && 'ntfy',
  env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && 'Telegram',
].filter(Boolean);

// level: time-sensitive | active | passive (iOS interruption levels). Returns true if any channel delivered.
export async function push(env, { title, message, url, level = 'time-sensitive', tag = 'iphone-duo' }, log = () => {}) {
  let sent = false;
  if (env.HA_URL && env.HA_TOKEN && env.HA_NOTIFY_SERVICE) {
    const data = { group: 'iphone-duo', tag, push: { 'interruption-level': level } };
    if (level !== 'passive') data.push.sound = 'default';
    if (url) data.url = data.clickAction = url;
    const service = env.HA_NOTIFY_SERVICE.replace(/^notify\./, '');
    const r = await haRequest(env, 'POST', `/api/services/notify/${service}`, { title, message, data });
    if (r.status >= 200 && r.status < 300) { log(`push sent via Home Assistant (${level}): ${title}`); sent = true; }
    else log(`push via Home Assistant failed (${r.status || r.text})`);
  }
  if (env.NTFY_TOPIC) {
    try {
      const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
      const r = await fetch(`${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
        method: 'POST', body: message, signal: AbortSignal.timeout(15_000),
        headers: {
          // Header values must be ASCII; ntfy decodes RFC 2047 for emoji titles.
          Title: /^[\x20-\x7e]*$/.test(title) ? title : `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
          Priority: { 'time-sensitive': '5', active: '3', passive: '2' }[level] ?? '3',
          ...(url ? { Click: url } : {}),
          ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
        },
      });
      log(`push via ntfy ${r.ok ? 'sent' : `HTTP ${r.status}`}: ${title}`);
      sent ||= r.ok;
    } catch (e) { log(`push via ntfy error ${e.message}`); }
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${title}\n${message}${url ? `\n${url}` : ''}` }),
        signal: AbortSignal.timeout(15_000),
      });
      log(`push via Telegram ${r.ok ? 'sent' : `HTTP ${r.status}`}: ${title}`);
      sent ||= r.ok;
    } catch (e) { log(`push via Telegram error ${e.message}`); }
  }
  if (!sent && process.platform === 'darwin') {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('/usr/bin/osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], { stdio: 'ignore' }).on('error', () => {});
    log(`no push channel delivered; showed a macOS notification: ${title}`);
  }
  return sent;
}
