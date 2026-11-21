#!/usr/bin/env node
/**
 * DEV ONLY: runs the local WebSocket relay + `next dev` with the local transport, so you can play
 * without a Supabase project — in two browser windows, or on phones on the same Wi-Fi
 * (open http://<your-LAN-IP>:3000; the relay is reached on port 8787 of the same host).
 *
 *   npm run dev:local
 */
import { spawn } from 'node:child_process';

const env = { ...process.env, NEXT_PUBLIC_REALTIME_TRANSPORT: 'local' };
const children = [
  spawn(process.execPath, ['scripts/relay.mjs'], { stdio: 'inherit', env }),
  // Fixed command string (no user input) — avoids Node's DEP0190 warning about shell + args.
  spawn('npx next dev -H 0.0.0.0', { stdio: 'inherit', env, shell: true }),
];

const stop = () => {
  for (const c of children) if (!c.killed) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && stop());
