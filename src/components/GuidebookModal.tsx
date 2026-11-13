'use client';

import { useEffect, useRef } from 'react';
import { BookOpen, Info, Lock, X, Zap } from '@/components/ui/icons';
import { NodeIcon } from '@/components/PathNode';
import { GlassCard, Pill } from '@/components/ui/primitives';
import { LEVELS } from '@/lib/levels';
import { BUNDLED_AUDIO, BUNDLED_AUDIO_STATS } from '@/lib/localAudio';
import {
  NODE_SLOTS,
  SECTIONS,
  isNodeUnlocked,
  nodeBlurb,
  nodeStrategy,
  tierLockReason,
} from '@/lib/path';
import { pluralWord } from '@/lib/text';
import type { DifficultyLevel, NoiseIntensity, PathProgress } from '@/lib/types';

/**
 * Guidebook modal explaining how a tier sounds and what its nodes ask of you.
 *
 * Focus is trapped to the dialog for the duration and Escape closes it, so a
 * keyboard user cannot tab into the path behind the overlay.
 */
export function GuidebookModal({
  tier,
  path,
  noiseIntensity,
  voicesPerSession,
  onClose,
}: {
  tier: DifficultyLevel;
  path: PathProgress;
  noiseIntensity: NoiseIntensity;
  /** The learner's configured session length, for the node descriptions. */
  voicesPerSession: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const config = LEVELS[tier];
  const section = SECTIONS[tier - 1];
  const accessible = isNodeUnlocked(path, tier, 1);

  const snrLabel =
    config.noise.snrDb === null
      ? 'No injected noise'
      : noiseIntensity === 'muted'
        ? `${config.noise.snrDb} dB SNR in the tier, currently muted`
        : `${config.noise.snrDb + (noiseIntensity === 'boosted' ? -6 : 0)} dB SNR${noiseIntensity === 'boosted' ? ' (boosted)' : ''}`;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-6 backdrop-blur-md sm:items-center sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-label={`Guidebook: ${section?.title ?? 'Section'}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="w-full max-w-lg">
        <GlassCard variant="strong" sheen className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="solid">
                  <BookOpen size={10} /> guidebook
                </Pill>
                <Pill>
                  tier {tier} · {config.config === 'other' ? 'other split' : 'clean split'}
                </Pill>
                {!accessible ? (
                  <Pill className="border-white/[0.1]" title={tierLockReason(path, tier)}>
                    <Lock size={9} /> locked
                  </Pill>
                ) : null}
              </div>
              <h2 className="mt-3 text-xl font-semibold leading-tight tracking-tight text-white">
                {section?.title}
              </h2>
              <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.14em] text-neutral-500">
                {section?.label}
              </p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close guidebook"
              className="icon-btn h-8 w-8 shrink-0 border-white/10"
            >
              <X size={14} />
            </button>
          </div>

          {/* How it sounds */}
          <div className="glass-inset mt-4 p-3.5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
              <Zap size={10} /> how it sounds
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-neutral-300">{config.description}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <Detail label="corpus" value={config.splitLabel} />
              <Detail label="noise floor" value={snrLabel} />
              <Detail label="sentence length" value={`${config.wordRange[0]}–${config.wordRange[1]} words`} />
              <Detail
                label="clips offline"
                value={
                  BUNDLED_AUDIO
                    ? `${BUNDLED_AUDIO_STATS.clips.toLocaleString()} bundled`
                    : '12 verified + live'
                }
              />
            </dl>
          </div>

          {/* Node by node */}
          <div className="mt-4">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
              <Info size={10} /> the {NODE_SLOTS.length} nodes
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {NODE_SLOTS.map((slot) => {
                const progress = path.nodes[`${tier}-${slot.slot}`];
                const cleared = slot.isReward
                  ? path.chestsOpened.includes(`${tier}-${slot.slot}`)
                  : Boolean(progress);
                return (
                  <li key={slot.slot} className="glass-inset flex gap-3 px-3 py-2.5">
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                        cleared ? 'bg-white text-[#050505]' : 'border border-white/[0.12] text-neutral-400'
                      }`}
                    >
                      <NodeIcon kind={slot.kind} size={14} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-semibold tracking-tight text-white">
                          {slot.slot}. {slot.title}
                        </span>
                        {cleared ? (
                          <Pill tone="solid">
                            {slot.isReward ? 'claimed' : `${progress?.stars ?? 0}★`}
                          </Pill>
                        ) : (
                          <Pill className="border-white/[0.1]">finish to unlock the next</Pill>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                        {nodeBlurb(slot, voicesPerSession)}
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">
                        {nodeStrategy(slot.kind)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-neutral-500">
            <span className="text-neutral-300">Completing a node always opens the next one</span>,
            whatever you scored — sitting through all {voicesPerSession}{' '}
            {pluralWord(voicesPerSession, 'voice')} is the work. Your accuracy sets the stars instead:
            one at 70%, two at 85%, three at 90%. Completing the Mastery Workout opens the next
            section, and the live engine can fast-track you there sooner by demonstrating mastery.
          </p>

          <button type="button" onClick={onClose} className="btn-primary mt-4 w-full py-3">
            Got it
          </button>
        </GlassCard>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-600">{label}</dt>
      <dd className="mt-0.5 text-[11px] text-neutral-300">{value}</dd>
    </div>
  );
}
