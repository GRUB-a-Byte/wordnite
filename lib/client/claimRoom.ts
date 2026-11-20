import { createTransport } from '@/lib/realtime/transport';
import { generateRoomCode } from './ids';
import { claimHost } from './identity';

/** Resolves true when somebody already hosts `code` (a member with role "host" is present). */
async function roomHasHost(code: string, playerId: string, timeoutMs = 2500): Promise<boolean> {
  const transport = await createTransport(code, `probe-${playerId}`);
  try {
    return await new Promise<boolean>((resolve) => {
      let connected = false;
      const done = (v: boolean) => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      transport.onStatus((s) => {
        if (s === 'connected') connected = true;
      });
      transport.onPresence((members) => {
        if (members.some((m) => m.role === 'host')) done(true);
        // After connecting, give presence a short moment to deliver the full snapshot.
        else if (connected) setTimeout(() => done(false), 400);
      });
    });
  } finally {
    transport.close();
  }
}

/**
 * FR-1.2 / E-18: generate a random code, check Presence to make sure no host is already on that
 * channel, then claim it (FR-1.3). Throws if realtime is not configured.
 */
export async function createRoom(playerId: string, attempts = 5): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = generateRoomCode();
    if (!(await roomHasHost(code, playerId))) {
      claimHost(code, playerId);
      return code;
    }
  }
  throw new Error('Could not find a free room code — please try again.');
}
