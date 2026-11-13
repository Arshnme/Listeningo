'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Crown, TrendingDown, TrendingUp, X } from 'lucide-react';
import { getLevel } from '@/lib/levels';
import type { LevelShift } from '@/lib/types';

/**
 * Slide-down banner announcing an automatic tier change mid-session.
 *
 * Promotion and demotion get distinct copy: one is celebratory, the other is
 * deliberately reassuring, because a step-down should read as support rather
 * than failure.
 *
 * Rendered by a plain conditional rather than AnimatePresence, and animated on
 * the transform axis only: a promotion notice must never be invisible or stay
 * stuck on screen because the browser stopped producing animation frames.
 */
export function LevelShiftBanner({
  shift,
  fastTrack,
  onDismiss,
}: {
  shift: LevelShift | null;
  /** Section newly unlocked on the progression path, if any. */
  fastTrack?: { tier: number; title: string } | null;
  onDismiss: () => void;
}) {
  if (!shift) return null;
  const isUp = shift.direction === 'up';
  const toLevel = getLevel(shift.to);

  return (
    <motion.div
      key={`${shift.direction}-${shift.to}-${shift.reason}`}
      initial={{ y: -28 }}
      animate={{ y: 0 }}
      transition={{ type: 'spring', stiffness: 280, damping: 28 }}
      className="pointer-events-auto relative w-full"
      role="status"
      aria-live="polite"
    >
      <div
        className={`glass-strong relative overflow-hidden p-4 ${
          isUp ? 'border-white/40' : 'border-white/20'
        }`}
      >
        {/* Specular sweep, only on promotion. */}
        {isUp ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 animate-sheen-sweep bg-gradient-to-r from-transparent via-white/25 to-transparent"
          />
        ) : null}

        <div className="relative flex items-start gap-3.5">
          <span
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
              isUp ? 'border-white/50 bg-white text-black' : 'border-white/20 bg-white/[0.06] text-white'
            }`}
          >
            {isUp ? <TrendingUp size={17} /> : <TrendingDown size={17} />}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-white">
                {isUp ? 'Mastery detected' : 'Stepping down a tier'}
              </span>
              <span className="pill border-white/30 text-white">
                {isUp ? 'auto-level up' : 'auto-level down'}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-tight text-neutral-400">
              <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5">
                L{shift.from} {getLevel(shift.from).name}
              </span>
              <ArrowRight size={12} className="text-neutral-600" />
              <span className="rounded-md bg-white px-1.5 py-0.5 font-semibold text-black">
                L{shift.to} {toLevel.name}
              </span>
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
              {shift.reason}. Next voice draws from{' '}
              <span className="text-neutral-200">
                {toLevel.config === 'other' ? 'LibriSpeech OTHER' : 'LibriSpeech CLEAN'}
              </span>
              {toLevel.noise.snrDb !== null ? (
                <>
                  {' '}
                  with a noise bed at{' '}
                  <span className="text-neutral-200">{toLevel.noise.snrDb} dB SNR</span>
                </>
              ) : (
                <> with no injected noise</>
              )}
              .
            </p>

            {fastTrack ? (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-medium leading-relaxed text-white">
                <Crown size={11} />
                Fast-tracked to Section {fastTrack.tier}: {fastTrack.title} unlocked on your path.
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss level change notice"
            className="icon-btn h-7 w-7 shrink-0 border-white/10"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
