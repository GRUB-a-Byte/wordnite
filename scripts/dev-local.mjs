#!/usr/bin/env node
/**
 * DEV ONLY: runs the local WebSocket relay + `next dev` with the local transport, so you can play
 * without a Supabase project — in two browser windows, or on phones on the same Wi-Fi
 * (open http://<your-LAN-IP>:3000; the relay is reached on port 8787 of the same host).
 *
 *   npm run dev:local
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

const APP_PORT = Number(process.env.PORT ?? 3000);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8787);

/** Resolves false only if `host:port` is already taken (EADDRINUSE). */
function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** Next listens on IPv4 0.0.0.0 and the relay on IPv6 ::, and Windows treats those separately — check both. */
async function portFree(port) {
  return (await canBind(port, '0.0.0.0')) && (await canBind(port, '::'));
}

const busy = [];
for (const port of [APP_PORT, RELAY_PORT]) if (!(await portFree(port))) busy.push(port);
if (busy.length) {
  const killCmd =
    process.platform === 'win32'
      ? `Get-NetTCPConnection -LocalPort ${busy.join(',')} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
      : `kill $(lsof -t -i :${busy.join(' -i :')})`;
  console.error(
    [
      '',
      `  Word Royale can't start: port ${busy.join(' and ')} ${busy.length > 1 ? 'are' : 'is'} already in use.`,
      '',
      '  Most likely the game is already running in another terminal:',
      `    • just use it → http://localhost:${APP_PORT}`,
      '    • or press Ctrl+C in that terminal, then run `npm run dev:local` again.',
      '',
      `  If that terminal is gone, stop whatever holds the port${busy.length > 1 ? 's' : ''}:`,
      `    ${killCmd}`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/** This machine's Wi-Fi / Ethernet IPv4 addresses (skips loopback and virtual adapters). */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|docker|utun|tailscale|zerotier/i.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

const lan = lanAddresses();
console.log(
  [
    '',
    '  Word Royale (local network mode)',
    `    on this computer:        http://localhost:${APP_PORT}`,
    ...(lan.length
      ? lan.map((ip, i) => `    ${i === 0 ? 'share with other devices:' : '                         '} http://${ip}:${APP_PORT}`)
      : ['    (no Wi-Fi / Ethernet address found — other devices cannot join)']),
    '',
    '  Other devices must be on the same Wi-Fi, and this computer\'s network must be set to "Private".',
    '  The relay below logs each device that connects — if a friend never shows up there, their',
    '  traffic is not reaching this computer (firewall or network).',
    '',
  ].join('\n'),
);

const env = {
  ...process.env,
  NEXT_PUBLIC_REALTIME_TRANSPORT: 'local',
  RELAY_PORT: String(RELAY_PORT),
  // Lets the lobby's QR code / link use the LAN address even when the host opened `localhost`.
  ...(lan[0] ? { NEXT_PUBLIC_LAN_HOST: lan[0] } : {}),
};
const children = [
  spawn(process.execPath, ['scripts/relay.mjs'], { stdio: 'inherit', env }),
  // Fixed command string (no user input) — avoids Node's DEP0190 warning about shell + args.
  spawn(`npx next dev -H 0.0.0.0 -p ${APP_PORT}`, { stdio: 'inherit', env, shell: true }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    // On Windows, killing the shell wrapper would leave `next dev` running in the background,
    // so kill the whole process tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill();
  }
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const c of children) c.on('exit', (code) => code && stop(code));
