'use client';

import { LazyMotion, MotionConfig } from 'motion/react';

const loadFeatures = () => import('./motionFeatures').then((mod) => mod.default);

/**
 * UI-10: Motion animations follow the OS "reduce motion" setting everywhere.
 * NFR-4: LazyMotion + `m.*` components keep the animation engine out of the initial JS.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
