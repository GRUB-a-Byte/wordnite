'use client';

import { AnimatePresence, m } from 'motion/react';
import { useRoom } from '@/lib/client/store';

const TONE = {
  info: 'bg-blue border-blue text-on-accent',
  success: 'bg-correct border-correct text-on-accent',
  warn: 'bg-shield border-shield text-on-accent',
  error: 'bg-steal border-steal text-on-accent',
} as const;

/**
 * FR-5.4: toast queue, max 3 visible.
 *  - 'top'  : under the header (lobby / end screen).
 *  - 'dock' : just above the keyboard dock during play, so toasts never cover the boards' headers.
 *             Must be rendered inside a `relative` dock container.
 */
export function Toasts({ placement = 'top' }: { placement?: 'top' | 'dock' }) {
  const toasts = useRoom((s) => s.toasts);
  const position =
    placement === 'dock'
      ? 'absolute bottom-full left-1/2 mb-2 flex-col-reverse'
      : 'fixed top-16 left-1/2 flex-col';
  return (
    <div
      className={`pointer-events-none z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 items-center gap-2 ${position}`}
      aria-live="polite"
      data-testid="toasts"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <m.div
            key={t.id}
            initial={{ opacity: 0, y: placement === 'dock' ? 10 : -12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            className={`max-w-full rounded-xl border px-4 py-2 text-center text-[clamp(12px,1.8vmin,15px)] font-bold shadow-xl ${TONE[t.tone]}`}
          >
            {t.text}
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
