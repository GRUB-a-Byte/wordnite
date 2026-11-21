import { describe, expect, it } from 'vitest';
import { shareableRoomUrl } from '../shareUrl';

const loc = (origin: string) => {
  const u = new URL(origin);
  return { protocol: u.protocol, hostname: u.hostname, port: u.port, origin: u.origin };
};

describe('shareableRoomUrl (lobby QR / link)', () => {
  it('uses the current origin on a real host (deployed site or LAN address)', () => {
    expect(shareableRoomUrl(loc('https://word-royale.vercel.app'), 'KXQT')).toEqual({
      url: 'https://word-royale.vercel.app/room/KXQT',
      localOnly: false,
    });
    expect(shareableRoomUrl(loc('http://10.184.79.119:3000'), 'KXQT', '10.0.0.9').url).toBe(
      'http://10.184.79.119:3000/room/KXQT',
    );
  });

  it('swaps localhost for the LAN address when dev:local provides one', () => {
    expect(shareableRoomUrl(loc('http://localhost:3000'), 'KXQT', '10.184.79.119')).toEqual({
      url: 'http://10.184.79.119:3000/room/KXQT',
      localOnly: false,
    });
    expect(shareableRoomUrl(loc('http://127.0.0.1:3000'), 'ABCD', '192.168.1.5').url).toBe(
      'http://192.168.1.5:3000/room/ABCD',
    );
  });

  it('flags localhost links as local-only when no LAN address is known', () => {
    expect(shareableRoomUrl(loc('http://localhost:3000'), 'KXQT')).toEqual({
      url: 'http://localhost:3000/room/KXQT',
      localOnly: true,
    });
  });
});
