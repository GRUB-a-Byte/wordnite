'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { HowToPlay } from '@/components/HowToPlay';
import { Logo } from '@/components/Logo';
import { createRoom } from '@/lib/client/claimRoom';
import { isValidRoomCode, normalizeRoomCode } from '@/lib/client/ids';
import { getNickname, getPlayerId, setNickname } from '@/lib/client/identity';
import { NICKNAME_MAX, sanitizeNickname } from '@/lib/client/nickname';

/** Query params forwarded from the home page to the room (dry-run / test hooks, SRS §11.3). */
function forwardedParams(): string {
  const src = new URLSearchParams(window.location.search);
  const out = new URLSearchParams();
  for (const key of ['debug', 'seed', 'early']) {
    const v = src.get(key);
    if (v !== null) out.set(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export default function HomePage() {
  const router = useRouter();
  const [nick, setNick] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    setNick(getNickname());
  }, []);

  const cleanNick = sanitizeNickname(nick);

  function requireNick(): string | null {
    if (!cleanNick) {
      setError('Pick a nickname first');
      return null;
    }
    setNickname(cleanNick);
    return cleanNick;
  }

  async function onCreate() {
    setError(null);
    if (!requireNick()) return;
    setBusy('create');
    try {
      const room = await createRoom(getPlayerId());
      router.push(`/room/${room}${forwardedParams()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a room');
      setBusy(null);
    }
  }

  function onJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) {
      setError('Room codes are 4 letters (no I or O)');
      return;
    }
    if (cleanNick) setNickname(cleanNick);
    setBusy('join');
    router.push(`/room/${normalized}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-5 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo size="lg" />
        <p className="text-muted">Solve your word. Steal theirs. Last one standing wins.</p>
      </div>

      <section className="w-full space-y-5 rounded-2xl border border-line bg-panel/80 p-5 shadow-xl backdrop-blur sm:p-7">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-muted">Nickname</span>
          <input
            value={nick}
            onChange={(e) => setNick(e.target.value.slice(0, NICKNAME_MAX))}
            maxLength={NICKNAME_MAX}
            placeholder="e.g. wordwizard"
            autoComplete="nickname"
            className="w-full rounded-xl border border-line bg-night px-4 py-3 text-lg font-semibold outline-none focus:border-royal"
            data-testid="nickname-input"
          />
        </label>

        <button
          type="button"
          onClick={onCreate}
          disabled={busy !== null}
          className="w-full rounded-xl bg-gradient-to-r from-royal to-fuchsia-500 px-4 py-3.5 text-lg font-black tracking-wide text-white shadow-lg transition hover:brightness-110 disabled:opacity-60"
          data-testid="create-room"
        >
          {busy === 'create' ? 'Creating…' : 'Create room'}
        </button>

        <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted">
          <span className="h-px flex-1 bg-line" /> or join a friend <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={onJoin} className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
            placeholder="CODE"
            inputMode="text"
            autoCapitalize="characters"
            aria-label="Room code"
            className="w-0 flex-1 rounded-xl border border-line bg-night px-4 py-3 text-center text-2xl font-black tracking-[0.4em] uppercase outline-none focus:border-royal-2"
            data-testid="join-code"
          />
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-xl border border-royal-2/60 bg-royal-2/10 px-5 py-3 font-bold text-royal-2 transition hover:bg-royal-2/20 disabled:opacity-60"
            data-testid="join-room"
          >
            Join
          </button>
        </form>

        {error && (
          <p role="alert" className="text-center text-sm font-semibold text-steal">
            {error}
          </p>
        )}
      </section>

      <section className="w-full rounded-2xl border border-line/60 bg-panel/40 p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted">How to play</h2>
        <HowToPlay compact />
      </section>
    </main>
  );
}
