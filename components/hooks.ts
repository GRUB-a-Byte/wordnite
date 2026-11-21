'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { GameEvent, Phase } from '@/lib/engine/types';
import { clockOf } from '@/lib/client/clock';
import { findPlayer } from '@/lib/client/players';
import { useRoom, type FxEntry } from '@/lib/client/store';

/** Re-renders every `intervalMs` and returns the current time (kept in state → pure renders). */
export function useNow(intervalMs = 200): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

/**
 * A flag that turns on when `trigger()` is called and back off after `ms` — for one-shot button
 * guards ("don't send START twice") and short confirmations ("Copied!"). The timer is cleared on
 * unmount.
 */
export function useTemporaryFlag(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const trigger = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, trigger];
}

/** Content-box size of an element, kept up to date with a ResizeObserver. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Milliseconds left in the current phase on the HOST clock (FR-5.1, §8.3 clock sync). */
export function usePhaseRemaining(intervalMs = 200, playerId?: string): number | null {
  return useClock(intervalMs, playerId).remaining;
}

/**
 * The clock a viewer sees (v1.1 FD-7): in a battle royale `playerId`'s own duel clock (no clock
 * while waiting, none for spectators without a player); in a 2-player match the match clock.
 */
export function useClock(intervalMs = 200, playerId?: string): { phase?: Phase; remaining: number | null } {
  const { phase, endsAt, offset } = useRoom(
    useShallow((s) => {
      const c = clockOf(s.game, playerId ? findPlayer(s.game?.players ?? [], playerId) : undefined);
      return { phase: c.phase, endsAt: c.endsAt, offset: s.clockOffset };
    }),
  );
  const now = useNow(intervalMs);
  if (endsAt === undefined || now === 0) return { phase, remaining: null };
  return { phase, remaining: Math.max(0, endsAt - (now + offset)) };
}

/** Duel-scoped events (v1.1: PLAY_STARTED / OVERTIME_START carry `playerIds`) concern only that duel. */
export function concerns(e: { playerIds?: string[] }, viewerId: string | undefined): boolean {
  return !e.playerIds || (!!viewerId && e.playerIds.includes(viewerId));
}

type EventOf<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;

/**
 * Most recent synchronized game event of `type` matching `pred`, while it is still in the store's
 * short-lived fx buffer (RoomClient expires entries after ~4 s). Overlays key their one-shot,
 * self-fading animations on the returned entry id.
 */
export function useLatestFx<T extends GameEvent['type']>(
  type: T,
  pred: (e: EventOf<T>) => boolean = () => true,
): (FxEntry & { event: EventOf<T> }) | null {
  return useRoom((s) => {
    for (let i = s.fx.length - 1; i >= 0; i--) {
      const entry = s.fx[i] as FxEntry;
      if (entry.event.type === type && pred(entry.event as EventOf<T>)) {
        return entry as FxEntry & { event: EventOf<T> };
      }
    }
    return null;
  });
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
