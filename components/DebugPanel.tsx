'use client';

import { useShallow } from 'zustand/react/shallow';
import { useRoom } from '@/lib/client/store';
import { useNow } from './hooks';

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

/**
 * `?debug=1` overlay. FIX 4: submission → authoritative-confirmation latency is MEASURED here
 * (p50 / p95 / max over the last 50 actions), separately from animation timing.
 * FIX 5: match duration is observable while testing.
 */
export function DebugPanel() {
  const s = useRoom(
    useShallow((st) => ({
      debug: st.debug,
      game: st.game,
      session: st.session,
      view: st.view,
      latencies: st.latencies,
      offset: st.clockOffset,
      transport: st.transportKind,
      role: st.role,
    })),
  );
  const now = useNow(500);
  if (!s.debug || !s.session) return null;
  const sorted = [...s.latencies].sort((a, b) => a - b);
  const g = s.game;
  const hostNow = now + s.offset;
  const duration = g?.playStartedAt ? ((g.finishedAt ?? hostNow) - g.playStartedAt) / 1000 : 0;
  return (
    <aside
      className="fixed bottom-2 left-2 z-50 rounded-lg border border-shield/40 bg-night/90 px-3 py-2 font-mono text-[10px] leading-4 text-shield"
      data-testid="debug-panel"
    >
      <div>
        {s.role} · {s.transport} · v{s.session.version} · s{s.session.sessionNumber} {s.session.phase} · view {s.view}
        {g ? ` · d${g.matchNumber} ${g.phase}` : ''} · duels {s.session.duels.length}
      </div>
      <div>
        ack latency n={sorted.length} p50={pct(sorted, 50)}ms p95={pct(sorted, 95)}ms max={sorted.at(-1) ?? 0}ms
      </div>
      <div>
        clock offset {s.offset}ms · match {duration.toFixed(1)}s · early-finish{' '}
        {s.session.settings.enableUnbeatableEarlyFinish ? 'on' : 'off'} · cap {s.session.settings.maxPlayers}
      </div>
    </aside>
  );
}
