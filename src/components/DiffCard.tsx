'use client';

import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Repeat,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { getLevel } from '@/lib/levels';
import { pluralWord } from '@/lib/text';
import { Pill } from '@/components/ui/primitives';
import {
  PersianSentence,
  PersianWordPopover,
  type WordAnchor,
} from '@/components/PersianPanel';
import type { DiffToken, RoundResult } from '@/lib/types';

/** Ground-truth words with their original casing, for display only. */
function originalWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function TokenChip({
  token,
  words,
  onWordClick,
  activeWord,
}: {
  token: DiffToken;
  words: string[];
  /** Tapping a word opens its Persian gloss. */
  onWordClick: (word: string, element: HTMLElement) => void;
  activeWord: string | null;
}) {
  const index = token.expectedIndex;
  const display =
    index !== undefined && words.length > 0 && words[index] !== undefined
      ? (words[index] as string)
      : (token.expected ?? token.actual ?? '');
  // Only ground-truth words are tappable: an `extra` token is something the
  // learner typed, and glossing it would be glossing their own mistake.
  const tappable = index !== undefined;
  const isActive = tappable && activeWord === display.toUpperCase();

  const wrap = (children: React.ReactNode) =>
    tappable ? (
      <button
        type="button"
        onClick={(event) => onWordClick(display, event.currentTarget)}
        title={`Persian meaning of “${display}”`}
        className={`cursor-pointer rounded px-1 transition-all ${
          isActive
            ? 'bg-white/[0.16] ring-1 ring-white/40'
            : 'hover:border-b hover:border-white/50 hover:bg-white/[0.12]'
        }`}
      >
        {children}
      </button>
    ) : (
      <span>{children}</span>
    );

  if (token.status === 'correct') {
    return wrap(<span className="diff-correct">{display}</span>);
  }
  if (token.status === 'misspelled') {
    // The word itself is painted amber with a wavy underline, and the learner's
    // spelling rides alongside it. A previous revision coloured the badge but
    // left the word white, which read as "fully correct" at a glance.
    return (
      <span
        className="inline-flex items-baseline gap-1"
        title={`You wrote “${token.actual}” — the right word, counted as correct`}
      >
        {wrap(<span className="diff-misspelled">{display}</span>)}
        <span className="rounded-md bg-amber-300/15 px-1.5 py-px font-mono text-[10px] text-amber-200/90">
          {token.actual}
        </span>
      </span>
    );
  }
  if (token.status === 'missing') {
    return wrap(
      <span className="diff-missing" title="This word was not detected in your answer">
        {display}
      </span>,
    );
  }
  if (token.status === 'wrong') {
    return (
      <span className="inline-flex items-baseline gap-1" title={`You wrote “${token.actual}”`}>
        {wrap(<span className="diff-wrong">{display}</span>)}
        <span className="rounded-md bg-white/[0.12] px-1.5 py-px font-mono text-[10px] not-italic text-neutral-200">
          {token.actual}
        </span>
      </span>
    );
  }
  return (
    <span className="diff-extra" title="This word does not appear in the sentence">
      {token.actual}
    </span>
  );
}

/**
 * Post-round report: the exact word-level comparison, the score, and any tier
 * change the answer triggered.
 */
export function DiffCard({
  result,
  isLastRound,
  currentLevel,
  nextLevel,
  onNext,
  onPrevious,
  onReplayNormal,
  onReplaySlow,
  slowRate,
  /** Position of this round inside the session, 1-based, for the header. */
  roundNumber,
  totalRounds,
  /** True when this card is a past round being reviewed rather than the latest. */
  reviewing,
  /** True when this is the newest graded round, so nothing newer exists yet. */
}: {
  result: RoundResult;
  isLastRound: boolean;
  currentLevel: number;
  nextLevel: number;
  onNext: () => void;
  /** Steps back to the previous round's report; disabled on the first round. */
  onPrevious: () => void;
  onReplayNormal: () => void;
  onReplaySlow: () => void;
  /** Configured pitch-preserved speed, so the button label is truthful. */
  slowRate: number;
  roundNumber: number;
  totalRounds: number;
  reviewing: boolean;
}) {
  const { alignment, accuracy, clip, usedSlowMode, replays, shift, xpGained } = result;
  const isLastRoundEffective = isLastRound && !reviewing;

  // Persian lookups. The anchor is measured against the sentence container so
  // the popover lands under the tapped word at any viewport width.
  const sentenceRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<WordAnchor | null>(null);
  const [boundsWidth, setBoundsWidth] = useState(0);

  const handleWordClick = useCallback((word: string, element: HTMLElement) => {
    const container = sentenceRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const wordRect = element.getBoundingClientRect();
    setBoundsWidth(containerRect.width);
    setAnchor({
      word: word.toUpperCase(),
      x: wordRect.left - containerRect.left + wordRect.width / 2,
      // Sits just below the tapped word, leaving room for the caret.
      y: wordRect.bottom - containerRect.top + 10,
    });
  }, []);

  const dismissPopover = useCallback(() => setAnchor(null), []);
  const words = originalWords(clip.text);
  const percent = Math.round(accuracy * 100);

  const verdict =
    percent >= 95
      ? 'Flawless. Every word landed.'
      : percent >= 85
        ? 'Strong pass — the engine is tracking this as mastery.'
        : percent >= 70
          ? 'Mostly there. Replay it and notice the words that slipped.'
          : percent >= 55
            ? 'A rough pass. Listen again at normal speed before moving on.'
            : 'This one needs another listen — Slow Mode will help.';

  const stats = [
    { label: 'correct', value: alignment.correct, tone: 'plain' },
    { label: 'spelling', value: alignment.misspelled, tone: 'warn' },
    { label: 'substituted', value: alignment.substitutions, tone: 'bad' },
    { label: 'missed', value: alignment.deletions, tone: 'bad' },
    { label: 'extra', value: alignment.insertions, tone: 'bad' },
  ];

  return (
    <motion.div
      initial={{ y: 14 }}
      animate={{ y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28 }}
      className="glass-strong glass-sheen flex flex-col gap-5 p-4 sm:p-6"
    >
      {/* ------------------------------------------------------------ score -- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-baseline gap-3">
          {/* Scale-only entrance: the score must be legible from the very first
              frame, so it never starts at zero opacity. */}
          <motion.span
            initial={{ scale: 0.86 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 22 }}
            className="metric text-5xl font-semibold leading-none text-white"
          >
            {percent}%
          </motion.span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium tracking-tight text-neutral-300">round accuracy</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
              {alignment.correct}/{alignment.expectedCount} words · word-level levenshtein
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Pill title="Experience earned from this voice">
            <Zap size={10} />
            +<span className="metric">{xpGained}</span> xp
          </Pill>
          <Pill title="This round was answered at reduced speed, so it paused mastery progress.">
            <Clock size={10} />
            {usedSlowMode ? 'slow mode used' : 'normal speed'}
          </Pill>
          <Pill title="Extra listens beyond the first play">
            <Repeat size={10} />
            <span className="metric">{replays}</span> {pluralWord(replays, 'replay')}
          </Pill>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-neutral-300">{verdict}</p>

      {alignment.misspelled > 0 ? (
        <p className="text-[11px] leading-relaxed text-amber-200/80">
          {alignment.misspelled} word{alignment.misspelled === 1 ? '' : 's'} matched the right
          pronunciation but {alignment.misspelled === 1 ? 'was' : 'were'} spelled differently —{' '}
          {alignment.misspelled === 1 ? 'it counts' : 'they count'} as correct here, since this is a
          listening exercise.
        </p>
      ) : null}

      {/* ------------------------------------------------------------- diff -- */}
      <div className="glass-inset p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
            what was actually said
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
            {clip.splitLabel}
          </span>
        </div>

        <div ref={sentenceRef} className="relative" data-persian-words>
          <p className="text-balance text-base font-medium leading-[2.1] tracking-tight text-neutral-300 sm:text-lg">
            {alignment.tokens.map((token, index) => (
              <span key={`${token.status}-${index}-${token.expected ?? token.actual ?? ''}`}>
                <TokenChip
                  token={token}
                  words={words}
                  onWordClick={handleWordClick}
                  activeWord={anchor?.word ?? null}
                />
                {index < alignment.tokens.length - 1 ? ' ' : ''}
              </span>
            ))}
          </p>

          <PersianWordPopover
            anchor={anchor}
            boundsWidth={boundsWidth}
            onDismiss={dismissPopover}
          />
        </div>

        <p className="mt-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-600">
          click any word for instant Persian meaning · click the eye icon for the full sentence
        </p>

        <PersianSentence clipId={clip.id} english={clip.text} />

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.07] pt-3 font-mono text-[10px] uppercase tracking-[0.1em]">
          {stats.map((stat) => (
            <span key={stat.label} className="inline-flex items-center gap-1.5">
              <span className="text-neutral-600">{stat.label}</span>
              <span
                className={`metric ${
                  stat.value === 0
                    ? 'text-neutral-500'
                    : stat.tone === 'warn'
                      ? 'text-amber-300/90'
                      : stat.tone === 'bad'
                        ? 'text-red-400/85'
                        : 'text-neutral-200'
                }`}
              >
                {stat.value}
              </span>
            </span>
          ))}
          <span className="inline-flex flex-wrap items-center gap-2 text-neutral-600">
            <span className="diff-misspelled normal-case">amber</span> spelling, counted
            <span className="diff-wrong normal-case">red</span> wrong
          </span>
        </div>
      </div>

      {/* -------------------------------------------------------- your text -- */}
      <div className="glass-inset p-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
          what you typed
        </span>
        <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
          {result.userText.trim() ? result.userText : <em className="text-neutral-600">(empty)</em>}
        </p>
      </div>

      {/* A reviewed round reports its own history, not the session's current state. */}
      {reviewing ? (
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
          <Clock size={11} />
          voice {roundNumber} of {totalRounds} · score is final
        </div>
      ) : shift ? (
        <div
          className={`flex items-start gap-3 rounded-2xl border p-3.5 ${
            shift.direction === 'up'
              ? 'border-white/45 bg-white/[0.09]'
              : 'border-white/[0.14] bg-white/[0.035]'
          }`}
        >
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
              shift.direction === 'up' ? 'bg-white text-black' : 'border border-white/20 text-white'
            }`}
          >
            {shift.direction === 'up' ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
          </span>
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold tracking-tight text-white">
              {shift.direction === 'up' ? (
                <>
                  <Sparkles size={12} /> Mastery detected — auto-switched to Level {shift.to}
                </>
              ) : (
                <>Stepping down to Level {shift.to}</>
              )}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
              {getLevel(shift.from).name} → {getLevel(shift.to).name}. {shift.reason}. The next voice
              already uses the new tier.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
          <CheckCircle2 size={11} />
          tier held at level {currentLevel} · {getLevel(currentLevel).name}
        </div>
      )}

      {/* -------------------------------------------------------- next step -- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onReplayNormal} className="btn-ghost py-2.5 text-[12px]">
            Replay 1.0x
          </button>
          <button type="button" onClick={onReplaySlow} className="btn-ghost py-2.5 text-[12px]">
            Slow {slowRate}x
          </button>
          <button
            type="button"
            onClick={onPrevious}
            disabled={roundNumber <= 1}
            className="btn-ghost py-2.5 text-[12px]"
            title="Step back through this session’s voices. Past answers cannot be re-graded."
          >
            <ArrowLeft size={13} />
            Previous voice
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
            re-listening does not change your score
          </span>
        </div>

        <button type="button" onClick={onNext} className="btn-primary py-3.5" autoFocus>
          {reviewing
            ? 'Forward'
            : isLastRoundEffective
              ? 'See session summary'
              : `Next voice · Level ${nextLevel}`}
          <ArrowRight size={16} />
        </button>
      </div>
    </motion.div>
  );
}
