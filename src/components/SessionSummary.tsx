'use client';

import { motion } from 'framer-motion';
import {
  ArrowRight,
  Award,
  BarChart3,
  Clock,
  Crown,
  LayoutDashboard,
  Play,
  TrendingDown,
  TrendingUp,
  Turtle,
} from 'lucide-react';
import { getLevel } from '@/lib/levels';
import { pluralWord } from '@/lib/text';
import { Bar, GlassCard, MetricBlock, Pill, SplitBar } from '@/components/ui/primitives';
import type { HistoryRound, SessionHistoryEntry } from '@/lib/types';

function friendlyTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Post-session report.
 *
 * Shows the full trajectory plus every voice, each with its own replay buttons,
 * because the mistakes are the interesting part: re-listening to a sentence you
 * mis-heard is where the learning actually happens.
 */
/** How the finished run affected its path node. */
export interface NodeOutcome {
  nodeTitle: string;
  tier: number;
  /** True when this run is what cleared the node. */
  cleared: boolean;
  /** True when the node was already cleared before this run. */
  alreadyCleared: boolean;
  stars: number;
  bestAccuracy: number;
  /** Tiers whose section 1 node opened up as a result. */
  unlockedTiers: number[];
  isReview: boolean;
}

export function SessionSummary({
  session,
  nextLevel,
  nodeOutcome,
  onContinue,
  onReviewRound,
  onExit,
  slowRate,
}: {
  session: SessionHistoryEntry;
  nextLevel: number;
  nodeOutcome: NodeOutcome | null;
  onContinue: () => void;
  onReviewRound: (round: HistoryRound, slow: boolean) => void;
  onExit: () => void;
  /** Configured pitch-preserved speed for the replay buttons. */
  slowRate: number;
}) {
  const rounds = session.rounds;
  const cleanRounds = rounds.filter((round) => round.split.includes('clean'));
  const noisyRounds = rounds.filter((round) => !round.split.includes('clean'));
  const mean = (list: HistoryRound[]) =>
    list.length === 0 ? 0 : list.reduce((sum, round) => sum + round.accuracy, 0) / list.length;

  const slowCount = rounds.filter((round) => round.usedSlowMode).length;
  const totalReplays = rounds.reduce((sum, round) => sum + round.replays, 0);
  const promoted = session.endLevel > session.startLevel;
  const demoted = session.endLevel < session.startLevel;
  const best = rounds.reduce<HistoryRound | null>(
    (top, round) => (top === null || round.accuracy > top.accuracy ? round : top),
    null,
  );
  const hardest = rounds.reduce<HistoryRound | null>(
    (low, round) => (low === null || round.accuracy < low.accuracy ? round : low),
    null,
  );

  const nextTier = getLevel(nextLevel);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-7">
      {/* ------------------------------------------------------- hero result -- */}
      <GlassCard variant="strong" sheen className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="solid">
                <Award size={10} /> session complete
              </Pill>
              <Pill>
                <Clock size={10} /> {friendlyTime(session.timestamp)}
              </Pill>
              {promoted ? (
                <Pill tone="outline" className="border-white/45 text-white">
                  <TrendingUp size={10} /> promoted {session.endLevel - session.startLevel}
                </Pill>
              ) : null}
              {demoted ? (
                <Pill tone="outline" className="border-white/20 text-neutral-300">
                  <TrendingDown size={10} /> stepped down
                </Pill>
              ) : null}
              {!promoted && !demoted ? <Pill>level held</Pill> : null}
            </div>

            <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
              {Math.round(session.averageAccuracy * 100)}%
              <span className="ml-3 align-middle text-sm font-normal text-neutral-500">
                average across {rounds.length} {pluralWord(rounds.length, 'voice')}
              </span>
            </h2>

            {/* Trajectory */}
            <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-tight">
              <span className="rounded-lg bg-white/[0.07] px-2 py-1 text-neutral-300">
                L{session.startLevel} {getLevel(session.startLevel).name}
              </span>
              <ArrowRight size={12} className="text-neutral-600" />
              <span className="rounded-lg bg-white px-2 py-1 font-semibold text-black">
                L{session.endLevel} {getLevel(session.endLevel).name}
              </span>
            </div>
          </div>

          {/* Per-round sparkline. Heights are inline styles with a CSS
              transition and a staggered delay: decorative, but always showing
              the true score rather than waiting on an animation frame. */}
          <div className="flex h-24 items-end gap-1.5">
            {rounds.map((round, index) => (
              <div key={`${round.clipId}-${index}`} className="flex w-4 flex-col items-center gap-1">
                <div className="flex h-20 w-full items-end">
                  <div
                    className={`w-full rounded-sm transition-[height] duration-500 ease-out ${
                      round.accuracy >= 0.85
                        ? 'bg-white'
                        : round.accuracy >= 0.55
                          ? 'bg-white/55'
                          : 'bg-white/25'
                    }`}
                    style={{
                      height: `${Math.max(4, round.accuracy * 100)}%`,
                      transitionDelay: `${index * 40}ms`,
                    }}
                    title={`Voice ${index + 1}: ${Math.round(round.accuracy * 100)}%`}
                  />
                </div>
                <span className="font-mono text-[8px] text-neutral-600">{index + 1}</span>
              </div>
            ))}
          </div>
        </div>
      </GlassCard>

      {/* --------------------------------------------------------- analytics -- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricBlock
          label="Clean voices"
          value={cleanRounds.length > 0 ? `${Math.round(mean(cleanRounds) * 100)}%` : '—'}
          sub={`${cleanRounds.length} studio ${pluralWord(cleanRounds.length, 'clip')}`}
          icon={<Play size={14} />}
        />
        <MetricBlock
          label="Noisy / other"
          value={noisyRounds.length > 0 ? `${Math.round(mean(noisyRounds) * 100)}%` : '—'}
          sub={`${noisyRounds.length} challenging ${pluralWord(noisyRounds.length, 'clip')}`}
          icon={<BarChart3 size={14} />}
        />
        <MetricBlock
          label="Slow mode"
          value={`${slowCount}/${rounds.length}`}
          sub={`voices answered at ${slowRate}x`}
          icon={<Turtle size={14} />}
        />
        <MetricBlock
          label="Total replays"
          value={`${totalReplays}`}
          sub={best ? `best ${Math.round(best.accuracy * 100)}% · worst ${Math.round((hardest?.accuracy ?? 0) * 100)}%` : ''}
          icon={<Clock size={14} />}
        />
      </div>

      <GlassCard className="p-5">
        <div className="flex items-center gap-2">
          <BarChart3 size={15} className="text-neutral-500" />
          <h3 className="text-sm font-semibold tracking-tight text-white">Split comparison</h3>
        </div>
        <div className="mt-4">
          <SplitBar clean={mean(cleanRounds)} noisy={mean(noisyRounds)} />
        </div>
        {noisyRounds.length === 0 ? (
          <p className="mt-4 text-[11px] leading-relaxed text-neutral-500">
            Every voice this session came from the studio CLEAN split. Promote once and the OTHER
            split with its accented speakers and injected noise enters the rotation.
          </p>
        ) : null}
      </GlassCard>

      {/* ------------------------------------------------------- round detail -- */}
      <GlassCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-white">Every voice, replayable</h3>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
            replay to review mistakes
          </span>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {rounds.map((round, index) => {
            const tier = getLevel(round.level);
            const quality =
              round.accuracy >= 0.85 ? 'solid' : round.accuracy >= 0.55 ? 'partial' : 'missed';
            return (
              <motion.div
                key={`${round.clipId}-${index}`}
                initial={{ y: 6 }}
                animate={{ y: 0 }}
                transition={{ delay: index * 0.03, duration: 0.2 }}
                className="glass-inset flex flex-col gap-2.5 px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="metric flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.09] text-[10px] text-neutral-300">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill className="border-white/[0.1]">L{round.level} {tier?.name}</Pill>
                      <Pill className="border-white/[0.1]">{round.split}</Pill>
                      {round.noiseDb > 0 ? (
                        <Pill className="border-white/[0.1]">
                          {round.noiseDb.toFixed(0)} dB snr
                        </Pill>
                      ) : null}
                      {round.usedSlowMode ? (
                        <Pill className="border-white/25 text-white">
                          <Clock size={9} /> slow
                        </Pill>
                      ) : null}
                      {round.replays > 0 ? (
                        <Pill className="border-white/[0.1]">
                          {round.replays} {pluralWord(round.replays, 'replay')}
                        </Pill>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`metric text-sm font-semibold ${
                        quality === 'solid'
                          ? 'text-white'
                          : quality === 'partial'
                            ? 'text-neutral-300'
                            : 'text-neutral-500'
                      }`}
                    >
                      {Math.round(round.accuracy * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => onReviewRound(round, false)}
                      className="btn-ghost px-2.5 py-1.5 text-[10px]"
                      title="Replay this voice at 1.0x"
                    >
                      <Play size={11} />
                      1.0x
                    </button>
                    <button
                      type="button"
                      onClick={() => onReviewRound(round, true)}
                      className="btn-ghost px-2.5 py-1.5 text-[10px]"
                      title={`Replay this voice at ${slowRate}x`}
                    >
                      <Turtle size={11} />
                      {slowRate}x
                    </button>
                  </div>
                </div>

                <Bar value={round.accuracy} height={2} />

                <p className="text-[12px] leading-relaxed text-neutral-400">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                    said:
                  </span>{' '}
                  {round.expectedText}
                </p>
                <p className="text-[12px] leading-relaxed text-neutral-500">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                    you:
                  </span>{' '}
                  {round.userText.trim() || <em className="text-neutral-600">(empty)</em>}
                </p>
              </motion.div>
            );
          })}
        </div>
      </GlassCard>

      {/* --------------------------------------------------- node outcome -- */}
      {nodeOutcome ? (
        <GlassCard variant="strong" sheen className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="solid">
                  {nodeOutcome.isReview
                    ? 'review complete'
                    : nodeOutcome.cleared
                      ? 'node completed'
                      : 'completed again'}
                </Pill>
                <Pill>
                  Section {nodeOutcome.tier} · {nodeOutcome.nodeTitle}
                </Pill>
                {!nodeOutcome.isReview ? (
                  <Pill tone="outline" className="border-white/25 text-white">
                    {nodeOutcome.stars}/3 stars
                  </Pill>
                ) : null}
              </div>

              <p className="mt-3 text-sm font-semibold tracking-tight text-white">
                {nodeOutcome.isReview
                  ? 'Review logged — your placement is unchanged'
                  : `Completed at ${Math.round(session.averageAccuracy * 100)}%`}
              </p>

              <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-neutral-400">
                {nodeOutcome.isReview
                  ? 'Replaying an earlier section never moves your current tier.'
                  : nodeOutcome.unlockedTiers.length > 0
                    ? `Section ${nodeOutcome.unlockedTiers[0]} is now unlocked on your path. Finishing a node always opens the next one — your score sets the stars.`
                    : 'The next node on this section is open. Finishing a node always opens the next one — your score sets the stars.'}
              </p>

              <div className="mt-3 flex items-center gap-3">
                <Bar value={nodeOutcome.stars / 3} className="max-w-[12rem]" />
                <span className="metric text-[11px] text-neutral-400">
                  {nodeOutcome.stars}/3 stars · {Math.round(session.averageAccuracy * 100)}%
                </span>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button type="button" onClick={onExit} className="btn-ghost py-3">
                <LayoutDashboard size={15} />
                Back to path
              </button>
              <button type="button" onClick={onContinue} className="btn-primary py-3.5">
                Continue on path
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </GlassCard>
      ) : (
        <GlassCard variant="strong" sheen className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white">
                <Crown size={14} />
                Free practice complete
              </p>
              <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-neutral-400">
                You are placed on {nextTier.tierPill} — {nextTier.description}
                {nextTier.noise.snrDb !== null ? ` Noise bed at ${nextTier.noise.snrDb} dB SNR.` : ''}
              </p>
            </div>
            <button type="button" onClick={onContinue} className="btn-primary py-3.5">
              Continue on path
              <ArrowRight size={16} />
            </button>
          </div>
        </GlassCard>
      )}
    </div>
  );
}
