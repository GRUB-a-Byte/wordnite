const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface ShareLocation {
  protocol: string; // "http:"
  hostname: string;
  port: string;
  origin: string;
}

/**
 * The room link / QR code shown in the lobby. If the host opened the game as `localhost`, that link
 * is useless on other devices (their "localhost" is themselves), so in local-network dev mode we
 * swap in this machine's LAN address (provided by `npm run dev:local` as NEXT_PUBLIC_LAN_HOST).
 */
export function shareableRoomUrl(loc: ShareLocation, code: string, lanHost?: string): { url: string; localOnly: boolean } {
  const path = `/room/${code}`;
  if (!LOOPBACK.has(loc.hostname)) return { url: `${loc.origin}${path}`, localOnly: false };
  if (lanHost) {
    const port = loc.port ? `:${loc.port}` : '';
    return { url: `${loc.protocol}//${lanHost}${port}${path}`, localOnly: false };
  }
  return { url: `${loc.origin}${path}`, localOnly: true };
}
