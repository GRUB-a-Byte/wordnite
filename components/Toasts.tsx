'use client';

import { AnimatePresence, m } from 'motion/react';
import { useRoom } from '@/lib/client/store';

const TONE = {
  info: 'bg-panel-2 border-line text-ink',
  success: 'bg-correct/90 border-correct text-white',
  warn: 'bg-shield/90 border-shield text-black',
  error: 'bg-steal/90 border-steal text-white',
} as const;

/** FR-5.4: toast queue, max 3 visible. */
export function Toasts() {
  const toasts = useRoom((s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed top-16 left-1/2 z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
      data-testid="toasts"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <m.div
            key={t.id}
            initial={{ opacity: 0, y: -12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            className={`rounded-xl border px-4 py-2 text-sm font-bold shadow-xl ${TONE[t.tone]}`}
          >
            {t.text}
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
