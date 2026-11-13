'use client';

import { Radio, Waves, X } from 'lucide-react';
import { getLevel } from '@/lib/levels';
import { ratioToSnrDb } from '@/lib/audio/noise';
import { SLOW_MODE_NOISE_SCALE } from '@/lib/levels';
import { Pill } from '@/components/ui/primitives';
import type { AudioSourceKind, RoundClip } from '@/lib/types';

/**
 * Round header: where you are in the session, what the corpus split is, and how
 * much noise is currently being injected.
 */
export function RoundHeader({
  clip,
  roundNumber,
  totalRounds,
  replays,
  slowMode,
  sourceKind,
  nodeLabel,
  reviewMode,
  highStreak,
  promotionNeed,
  onQuit,
}: {
  clip: RoundClip;
  roundNumber: number;
  totalRounds: number;
  replays: number;
  slowMode: boolean;
  sourceKind: AudioSourceKind | null;
  /** Which path node this session belongs to, e.g. `Mastery Workout`. */
  nodeLabel: string | null;
  /** True when replaying an earlier tier, where adaptation is paused. */
  reviewMode: boolean;
  highStreak: number;
  promotionNeed: number;
  onQuit: () => void;
}) {
  const tier = getLevel(clip.level);
  const isOther = clip.config === 'other';

  // Slow Mode halves the noise amplitude, which is worth ~6 dB of extra SNR.
  const effectiveSnr =
    clip.noiseDb === null
      ? null
      : ratioToSnrDb(10 ** (clip.noiseDb / 20) / (slowMode ? SLOW_MODE_NOISE_SCALE : 1));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="metric text-sm font-semibold text-white">
            Voice {String(roundNumber).padStart(2, '0')}
            <span className="text-neutral-600"> / {totalRounds}</span>
          </span>
          <div className="hidden h-4 w-px bg-white/10 sm:block" />
          <Pill
            tone={isOther ? 'solid' : 'ghost'}
            title={
              isOther
                ? 'LibriSpeech OTHER split — accented, non-studio speech'
                : 'LibriSpeech CLEAN split — studio quality read speech'
            }
          >
            {isOther ? <Waves size={10} /> : <Radio size={10} />}
            {isOther ? 'librispeech other · noisy' : 'librispeech clean'}
          </Pill>
          <Pill className="hidden border-white/[0.1] sm:inline-flex" title="LibriSpeech folder this clip lives in">
            {clip.splitLabel}
          </Pill>
        </div>

        <button
          type="button"
          onClick={onQuit}
          // `ml-auto` keeps the quit control at the far right even when the pills
          // above wrap it onto its own line on a phone; `justify-between` alone
          // left it stranded at the left edge there.
          className="icon-btn ml-auto h-8 w-8"
          aria-label="End session and return to dashboard"
          title="End this session"
        >
          <X size={14} />
        </button>
      </div>

      {/* Progress rail: one segment per voice, filled as rounds complete.
          Colours are computed inline with a CSS transition rather than driven by
          a JS animation loop, so the rail is always accurate. */}
      <div className="flex items-center gap-[3px]">
        {Array.from({ length: totalRounds }, (_, index) => {
          const state =
            index < roundNumber - 1 ? 'done' : index === roundNumber - 1 ? 'current' : 'pending';
          return (
            <span
              key={index}
              className="h-[3px] flex-1 rounded-full transition-colors duration-300"
              style={{
                backgroundColor:
                  state === 'done'
                    ? 'rgba(255,255,255,0.85)'
                    : state === 'current'
                      ? 'rgba(255,255,255,1)'
                      : 'rgba(255,255,255,0.12)',
              }}
            />
          );
        })}
      </div>

      {/* Node context, auto-level streak dots, and the review notice. */}
      <div className="flex flex-wrap items-center gap-2">
        {nodeLabel ? (
          <Pill tone="outline" className="border-white/25 text-white" title="Path node being played">
            {nodeLabel}
          </Pill>
        ) : null}

        {reviewMode ? (
          <Pill className="border-white/[0.1]" title="Replaying an earlier tier, so the adaptive engine is paused">
            review · auto-level paused
          </Pill>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500"
            title={`${highStreak} of ${promotionNeed} consecutive clean voices at 90%+ toward promoting`}
          >
            auto-level
            <span className="flex items-center gap-1">
              {Array.from({ length: promotionNeed }, (_, index) => (
                <span
                  key={index}
                  className={`h-1.5 w-1.5 rounded-full ${
                    index < highStreak ? 'bg-white' : 'bg-white/20'
                  }`}
                />
              ))}
            </span>
            <span className="metric">
              {Math.min(highStreak, promotionNeed)}/{promotionNeed}
            </span>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
        <span className="inline-flex items-center gap-1.5">
          tier <span className="text-neutral-200">{clip.level}</span> · {tier.name}
        </span>
        <span className="text-neutral-700">|</span>
        <span className="inline-flex items-center gap-1.5">
          speaker <span className="text-neutral-200">{clip.speakerId}</span>
        </span>
        <span className="text-neutral-700">|</span>
        <span className="inline-flex items-center gap-1.5">
          words <span className="text-neutral-200">{clip.wordCount}</span>
        </span>
        <span className="text-neutral-700">|</span>
        <span
          className="inline-flex items-center gap-1.5"
          title={
            effectiveSnr === null
              ? 'No synthesised noise is layered over this clip'
              : `Synthesised ${clip.noiseKind} bed calibrated to ${effectiveSnr.toFixed(1)} dB SNR against the measured speech level`
          }
        >
          noise floor{' '}
          <span className={clip.noiseDb === null ? 'text-neutral-200' : 'text-white'}>
            {effectiveSnr === null ? '0 dB' : `${effectiveSnr.toFixed(1)} dB SNR`}
          </span>
        </span>
        {clip.shaped ? (
          <>
            <span className="text-neutral-700">|</span>
            <span className="inline-flex items-center gap-1.5 text-neutral-300" title="Lowpass shaping simulates a muffled room">
              shaped
            </span>
          </>
        ) : null}
        {sourceKind === 'bundled' ? (
          <>
            <span className="text-neutral-700">|</span>
            <span className="text-neutral-400" title="Ships with the app as compact Opus — plays with no network at all">
              local audio
            </span>
          </>
        ) : null}
        {sourceKind === 'cache' ? (
          <>
            <span className="text-neutral-700">|</span>
            <span className="text-neutral-400" title="Served from the IndexedDB audio cache — no network used">
              offline cache
            </span>
          </>
        ) : null}
        {replays > 0 ? (
          <>
            <span className="text-neutral-700">|</span>
            <span className="text-neutral-300">
              {replays} replay{replays === 1 ? '' : 's'}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
