'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Award,
  BarChart3,
  ChevronRight,
  Clock,
  Database,
  Gauge,
  HardDrive,
  Headphones,
  ListMusic,
  Play,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Turtle,
} from 'lucide-react';
import { LEVELS, LEVEL_NUMBERS, getLevel } from '@/lib/levels';
import { pluralWord } from '@/lib/text';
import { Bar, EmptyState, GlassCard, MetricBlock, Pill, SplitBar } from '@/components/ui/primitives';
import type { CachedUserState, DifficultyLevel, HistoryRound } from '@/lib/types';

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Pre-session view: the single call to action plus everything the learner has
 * accumulated so far.
 */
export function Dashboard({
  state,
  manifestSize,
  cachedClips,
  onStart,
  onClearHistory,
  starting,
  onReviewRound,
  slowRate,
}: {
  state: CachedUserState;
  manifestSize: number;
  cachedClips: number;
  onStart: () => void;
  /** Clears the session history list, keeping path progress and XP. */
  onClearHistory: () => void;
  starting: boolean;
  /** Replays one voice from a past session. */
  onReviewRound: (round: HistoryRound, slow: boolean) => void;
  /** Configured pitch-preserved speed for the replay buttons. */
  slowRate: number;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const tier = getLevel(state.currentLevel);
  const recent = [...state.sessionHistory].reverse().slice(0, 6);
  const bestAccuracy = state.sessionHistory.reduce(
    (best, session) => Math.max(best, session.averageAccuracy),
    0,
  );
  const slowModeShare =
    state.totalVoicesCompleted > 0 ? state.slowModeUsageCount / state.totalVoicesCompleted : 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-5 pb-32 sm:px-6 sm:py-7">
      {/* ------------------------------------------------------------- hero -- */}
      <GlassCard variant="strong" sheen className="p-5 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="solid">
                <Sparkles size={10} /> librispeech · clean + other
              </Pill>
              <Pill>
                <Database size={10} /> {manifestSize} verified clips offline
              </Pill>
              <Pill tone="outline" className="border-white/20 text-neutral-400">
                <HardDrive size={10} /> {cachedClips} cached in browser
              </Pill>
            </div>

            <h2 className="mt-4 text-balance text-3xl font-semibold leading-[1.08] tracking-tight text-white sm:text-[2.6rem]">
              Train your ear against real speech, then let it get harder on its own.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400">
              You start on short studio-clean sentences. The moment you transcribe two voices in a row
              at 90% or better — at normal speed, without leaning on Slow Mode — the engine promotes
              you mid-session: longer sentences, the accented <span className="text-neutral-200">OTHER</span>{' '}
              split, then synthesised room noise at 16 dB and 10 dB SNR.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" onClick={onStart} disabled={starting} className="btn-primary px-6 py-3.5">
                {starting ? 'Preparing voice…' : `Start ${state.voicesPerSession}-Voice Adaptive Test`}
                <ArrowRight size={16} />
              </button>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                begins at {tier.tierPill}
              </span>
            </div>
          </div>

          {/* Tier ladder preview */}
          <div className="w-full shrink-0 lg:max-w-[22rem]">
            <div className="glass-inset p-3">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                  difficulty ladder
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                  now: L{state.currentLevel}
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {LEVEL_NUMBERS.map((levelNumber) => {
                  const config = LEVELS[levelNumber];
                  const active = levelNumber === state.currentLevel;
                  const cleared = levelNumber < state.currentLevel;
                  return (
                    <li
                      key={levelNumber}
                      className={`flex items-center gap-3 rounded-xl px-2.5 py-2 ${
                        active ? 'bg-white text-black' : 'text-neutral-400'
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-semibold ${
                          active
                            ? 'bg-black text-white'
                            : cleared
                              ? 'bg-white/15 text-white'
                              : 'bg-white/[0.06] text-neutral-500'
                        }`}
                      >
                        {levelNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-tight">
                        {config.name}
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] ${
                          active ? 'text-black/55' : 'text-neutral-600'
                        }`}
                        title={
                          config.noise.snrDb !== null
                            ? `Injected noise bed at ${config.noise.snrDb} dB SNR`
                            : 'No injected noise — the challenge comes from the corpus split'
                        }
                      >
                        {/* Tier 3 has no added noise but is still the OTHER split, so
                            labelling it "clean" would contradict its own description. */}
                        {config.noise.snrDb !== null ? `${config.noise.snrDb}dB` : 'no noise'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* --------------------------------------------------------- analytics -- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricBlock
          label="Overall accuracy"
          value={`${Math.round(state.overallAccuracy * 100)}%`}
          sub={`${state.totalVoicesCompleted} ${pluralWord(state.totalVoicesCompleted, 'voice')} graded`}
          icon={<Target size={14} />}
          emphasis
        />
        <MetricBlock
          label="Adaptive level"
          value={`L${state.currentLevel}`}
          sub={`${tier.name} · ${state.autoLevelEnabled ? 'auto-level on' : 'manual'}`}
          icon={<Gauge size={14} />}
        />
        <MetricBlock
          label="Best session"
          value={state.sessionHistory.length ? `${Math.round(bestAccuracy * 100)}%` : '—'}
          sub={`${state.sessionHistory.length} of last ${50} sessions kept`}
          icon={<Award size={14} />}
        />
        <MetricBlock
          label="Slow mode reliance"
          value={`${Math.round(slowModeShare * 100)}%`}
          sub={`${state.slowModeUsageCount} assisted voices`}
          icon={<Clock size={14} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* ------------------------------------------------- split accuracy -- */}
        <GlassCard className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold tracking-tight text-white">Clean vs noisy</h3>
            <BarChart3 size={15} className="text-neutral-500" />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
            A voice counts as noisy whenever the OTHER split or an injected noise bed was in play.
          </p>
          <div className="mt-5">
            <SplitBar clean={state.cleanAccuracy} noisy={state.noisyAccuracy} />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <div className="glass-inset px-3 py-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                clean voices
              </div>
              <div className="metric mt-1 text-lg font-semibold text-white">
                {state.cleanVoicesCompleted}
              </div>
            </div>
            <div className="glass-inset px-3 py-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                noisy voices
              </div>
              <div className="metric mt-1 text-lg font-semibold text-white">
                {state.noisyVoicesCompleted}
              </div>
            </div>
          </div>
          {state.cleanVoicesCompleted === 0 && state.noisyVoicesCompleted === 0 ? (
            <p className="mt-4 text-[11px] leading-relaxed text-neutral-500">
              Complete your first session and the comparison appears here. Climb two tiers and it
              starts contrasting studio audio against accented, noisy speech.
            </p>
          ) : null}
        </GlassCard>

        {/* --------------------------------------------------------- history -- */}
        <GlassCard className="p-5 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ListMusic size={15} className="text-neutral-500" />
              <h3 className="text-sm font-semibold tracking-tight text-white">Recent sessions</h3>
            </div>

            <div className="flex items-center gap-2">
              {confirmClear ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onClearHistory();
                      setConfirmClear(false);
                    }}
                    className="btn-ghost border-white/40 py-1.5 text-[11px] text-white"
                  >
                    Confirm clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="rounded-xl px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 hover:text-white"
                  >
                    cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="icon-btn h-8 w-8"
                  aria-label="Clear session history"
                  title="Remove the session history list. Path progress, badges and XP are kept — use Settings to reset everything."
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {recent.length === 0 ? (
              <EmptyState
                icon={<Headphones size={20} />}
                title="No sessions recorded yet"
                body={`Every ${state.voicesPerSession}-voice session is stored locally — trajectory, per-round accuracy and even the exact text you typed — so you can replay your mistakes.`}
              />
            ) : (
              recent.map((session, index) => {
                const slowCount = session.rounds.filter((round) => round.usedSlowMode).length;
                const expanded = expandedSession === session.id;
                // Weakest voices first once expanded: the mistakes are the part
                // worth re-hearing, and the list is long enough that order matters.
                const rounds = expanded
                  ? [...session.rounds].sort((a, b) => a.accuracy - b.accuracy)
                  : [];
                return (
                  <motion.div
                    key={session.id}
                    initial={{ y: 6 }}
                    animate={{ y: 0 }}
                    transition={{ delay: index * 0.035, duration: 0.22 }}
                    className="glass-inset flex flex-col gap-2.5 px-3.5 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                        <span className="text-neutral-300">{formatTimestamp(session.timestamp)}</span>
                        <span className="text-neutral-700">|</span>
                        <span>
                          L{session.startLevel} → L{session.endLevel}
                        </span>
                        {session.endLevel > session.startLevel ? (
                          <TrendingUp size={11} className="text-white" />
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Pill className="border-white/[0.1]">
                          <span className="metric">{session.rounds.length}</span>{' '}
                          {pluralWord(session.rounds.length, 'voice')}
                        </Pill>
                        {slowCount > 0 ? (
                          <Pill className="border-white/[0.1]">
                            <Clock size={9} /> <span className="metric">{slowCount}</span> slow
                          </Pill>
                        ) : null}
                        <span className="metric text-sm font-semibold text-white">
                          {Math.round(session.averageAccuracy * 100)}%
                        </span>
                        {session.rounds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setExpandedSession(expanded ? null : session.id)}
                            aria-expanded={expanded}
                            className="icon-btn h-7 w-7"
                            title={expanded ? 'Hide this session\u2019s voices' : 'Replay mistakes from this session'}
                          >
                            <ChevronRight
                              size={13}
                              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
                            />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <Bar value={session.averageAccuracy} height={3} />

                    {expanded ? (
                      <ul className="mt-1 flex flex-col gap-1.5 border-t border-white/[0.07] pt-2.5">
                        {rounds.map((round, roundIndex) => (
                          <li
                            key={`${round.clipId}-${roundIndex}`}
                            className="flex flex-wrap items-center justify-between gap-2"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="metric flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white/[0.09] text-[9px] text-neutral-300">
                                {String(roundIndex + 1).padStart(2, '0')}
                              </span>
                              <span className="metric w-9 shrink-0 text-[11px] text-neutral-300">
                                {Math.round(round.accuracy * 100)}%
                              </span>
                              <span
                                className="truncate text-[11px] text-neutral-500"
                                title={round.expectedText}
                              >
                                {round.expectedText}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => onReviewRound(round, false)}
                                className="btn-ghost px-2 py-1 text-[10px]"
                                title="Replay this voice at 1.0x"
                              >
                                <Play size={10} />
                                1.0x
                              </button>
                              <button
                                type="button"
                                onClick={() => onReviewRound(round, true)}
                                className="btn-ghost px-2 py-1 text-[10px]"
                                title={`Replay this voice at ${slowRate}x`}
                              >
                                <Turtle size={10} />
                                slow
                              </button>
                            </div>
                          </li>
                        ))}
                        <li className="pt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-600">
                          re-hearing a voice never changes a stored score
                        </li>
                      </ul>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setExpandedSession(session.id)}
                        className="self-start font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-600 transition-colors hover:text-white"
                      >
                        replay mistakes →
                      </button>
                    )}
                  </motion.div>
                );
              })
            )}
          </div>
        </GlassCard>
      </div>

      {/* ------------------------------------------------------- acoustic map -- */}
      <GlassCard className="p-5">
        <div className="flex items-center gap-2">
          <Gauge size={15} className="text-neutral-500" />
          <h3 className="text-sm font-semibold tracking-tight text-white">How each tier sounds</h3>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {LEVEL_NUMBERS.map((levelNumber: DifficultyLevel) => {
            const config = LEVELS[levelNumber];
            const active = levelNumber === state.currentLevel;
            return (
              <div
                key={levelNumber}
                className={`glass-inset flex flex-col gap-2 p-3.5 ${
                  active ? 'border-white/30 bg-white/[0.055]' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                    tier {levelNumber}
                  </span>
                  {active ? <Pill tone="solid">current</Pill> : null}
                </div>
                <span className="text-xs font-semibold tracking-tight text-white">{config.name}</span>
                <div className="flex flex-wrap gap-1">
                  <Pill className="border-white/[0.1]">
                    {config.config === 'other' ? 'OTHER' : 'CLEAN'}
                  </Pill>
                  <Pill className="border-white/[0.1]">
                    {config.noise.snrDb !== null ? `${config.noise.snrDb} dB snr` : 'no noise'}
                  </Pill>
                </div>
                <span className="font-mono text-[10px] tracking-tight text-neutral-500">
                  {config.wordRange[0]}–{config.wordRange[1]} words
                </span>
                <p className="text-[11px] leading-relaxed text-neutral-500">{config.description}</p>
              </div>
            );
          })}
        </div>
      </GlassCard>

      <p className="px-1 pb-2 text-[11px] leading-relaxed text-neutral-600">
        Audio streams straight from the Hugging Face LibriSpeech CDN to your browser and is cached in
        IndexedDB, so replays cost nothing. No account, no server, no audio bundled with the app —
        clearing your browser data resets everything.
      </p>
    </div>
  );
}
