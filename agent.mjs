#!/usr/bin/env node
// macOS LaunchAgent for the watcher: runs it now, at every login, and restarts it if it crashes.
//   node agent.mjs install | uninstall | status
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigFile, resolveConfig } from './lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plistPath = label => path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const domain = () => `gui/${process.getuid()}`;

export function plist(cfg, nodePath = process.execPath, root = ROOT) {
  const log = path.join(cfg.stateDir, 'launchd.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(cfg.launchAgentLabel)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(path.join(root, 'duo-watch.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const launchctl = (...args) => {
  try { return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
};

export function installAgent(cfg) {
  const file = plistPath(cfg.launchAgentLabel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  launchctl('bootout', `${domain()}/${cfg.launchAgentLabel}`);
  fs.writeFileSync(file, plist(cfg));
  if (launchctl('bootstrap', domain(), file) === null) return `Wrote ${file} but launchctl couldn't load it; try: launchctl bootstrap ${domain()} "${file}"`;
  return `Started ${cfg.launchAgentLabel}. Log: ${path.join(cfg.stateDir, 'watch.log')}. Stop with: npm run uninstall-agent`;
}

export function uninstallAgent(cfg) {
  const file = plistPath(cfg.launchAgentLabel);
  launchctl('bootout', `${domain()}/${cfg.launchAgentLabel}`);
  try { fs.unlinkSync(file); } catch {}
  return `Stopped and removed ${cfg.launchAgentLabel}.`;
}

function status(cfg) {
  const out = launchctl('print', `${domain()}/${cfg.launchAgentLabel}`);
  const lines = [out ? `LaunchAgent ${cfg.launchAgentLabel}: ${out.match(/state = (\S+)/)?.[1] ?? 'loaded'}` : `LaunchAgent ${cfg.launchAgentLabel}: not loaded`];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'status.json'), 'utf8'));
    lines.push(`Last check ${s.checkedAt}: ${s.ok ? `${s.storesChecked} stores, ${s.available?.length ?? 0} in stock` : `error: ${s.error}`}`);
    for (const a of s.available ?? []) lines.push(`  ${a.name} · ${a.storeName} · ${a.quote}`);
    if (s.nextCheckAt) lines.push(`Next check ${s.nextCheckAt}`);
  } catch { lines.push('No status yet.'); }
  return lines.join('\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  try {
    if (process.platform !== 'darwin' && cmd !== 'status') throw new Error('LaunchAgents are macOS-only. On Linux, run "npm start" under systemd, tmux, or similar.');
    const cfg = resolveConfig(readConfigFile(path.join(ROOT, 'config.json')), ROOT);
    const fn = { install: installAgent, uninstall: uninstallAgent, status }[cmd];
    if (!fn) throw new Error('usage: node agent.mjs install | uninstall | status');
    console.log(fn(cfg));
  } catch (e) { console.error(e.message); process.exit(1); }
}
