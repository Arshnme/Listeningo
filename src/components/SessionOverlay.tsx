'use client';

import type { ReactNode } from 'react';

/**
 * Full-screen shell for the listening arena and the session summary.
 *
 * Rendered as an overlay above whichever view launched it, so closing always
 * returns the learner to the exact spot — path node or dashboard — they came
 * from, with no route change to undo.
 *
 * Deliberately no entrance animation and no `AnimatePresence`: this is primary
 * content, and gating it on an animation completing would leave a learner
 * staring at a blank overlay if the browser stopped producing frames. The
 * background scroll is locked instead, which is the part that actually matters.
 */
export function SessionOverlay({
  children,
  totalRounds,
}: {
  children: ReactNode;
  /** Voices this session owes, for the dialog label. */
  totalRounds: number;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-[#050505]/96 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label={`Listening session — ${totalRounds} voices`}
    >
      <div className="min-h-full pb-24">{children}</div>
    </div>
  );
}
