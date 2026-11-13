'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AudioStage } from '@/components/AudioStage';
import { DiffCard } from '@/components/DiffCard';
import { RoundHeader } from '@/components/RoundHeader';
import { TranscriptInput } from '@/components/TranscriptInput';
import { countWords } from '@/lib/text';
import type { AudioEngine } from '@/lib/audio/engine';
import type { AudioSourceKind, RoundClip, RoundResult } from '@/lib/types';

export type ArenaPhase = 'loading' | 'listening' | 'graded';

/**
 * One round of the session: header, audio stage, transcription box, and the
 * graded report once the answer is submitted.
 *
 * Global shortcuts live here rather than on individual controls so they work no
 * matter where focus sits: Tab or Ctrl+Space replays at 1.0x, Shift+Space plays
 * at 0.75x, and Enter submits or advances. Tab is only captured while the
 * transcription field has focus, and Escape releases it again, so keyboard users
 * are never trapped in the round.
 */
export function ListeningArena({
  clip,
  roundNumber,
  totalRounds,
  phase,
  loading,
  loadError,
  sourceKind,
  nodeLabel,
  reviewMode,
  highStreak,
  promotionNeed,
  replays,
  slowMode,
  playing,
  currentTime,
  duration,
  spectrumLive,
  fallbackActive,
  volume,
  hintEnabled,
  slowRate,
  result,
  reviewRound,
  reviewing,
  engine,
  nextLevel,
  onPlay,
  onPause,
  onVolumeChange,
  onSubmit,
  onNext,
  onPrevious,
  onQuit,
  onRetryLoad,
  onHintToggle,
}: {
  clip: RoundClip;
  roundNumber: number;
  totalRounds: number;
  phase: ArenaPhase;
  loading: boolean;
  loadError: string | null;
  sourceKind: AudioSourceKind | null;
  nodeLabel: string | null;
  reviewMode: boolean;
  highStreak: number;
  promotionNeed: number;
  replays: number;
  slowMode: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  spectrumLive: boolean;
  fallbackActive: boolean;
  volume: number;
  hintEnabled: boolean;
  slowRate: number;
  result: RoundResult | null;
  /** Which graded round the report is showing, 1-based. Equals `roundNumber`
      unless the learner has stepped back through the session. */
  reviewRound: number;
  /** True when `reviewRound` is behind the newest graded round. */
  reviewing: boolean;
  engine: AudioEngine | null;
  nextLevel: number;
  onPlay: (slow: boolean) => void;
  onPause: () => void;
  onVolumeChange: (value: number) => void;
  onSubmit: (text: string) => void;
  onNext: () => void;
  /** Steps back to the previous round's report. */
  onPrevious: () => void;
  onQuit: () => void;
  onRetryLoad: () => void;
  onHintToggle: () => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A new voice clears the box and returns focus to it.
  useEffect(() => {
    setText('');
  }, [clip.id]);

  useEffect(() => {
    if (phase === 'listening' && !loading && !loadError) {
      inputRef.current?.focus();
    }
  }, [phase, loading, loadError, clip.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (phase === 'graded') {
        if (event.key === 'Enter') onNext();
        // Arrow keys page through the session's reports, the way any document
        // viewer behaves. Backspace is not bound: a learner may still be editing.
        if (event.key === 'ArrowLeft') onPrevious();
        return;
      }
      if (phase !== 'listening' || loading || loadError) return;

      const target = event.target as HTMLElement | null;
      const inInput = target === inputRef.current;

      if (event.key === 'Tab' && !event.shiftKey && inInput) {
        event.preventDefault();
        onPlay(false);
        return;
      }
      if (event.key === 'Escape' && inInput) {
        inputRef.current?.blur();
        return;
      }
      if (event.code === 'Space' && event.ctrlKey) {
        event.preventDefault();
        onPlay(false);
        return;
      }
      if (event.code === 'Space' && event.shiftKey) {
        event.preventDefault();
        onPlay(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, loading, loadError, onPlay, onNext, onPrevious]);

  const disabled = loading || Boolean(loadError) || phase === 'graded';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
      <motion.div
        key={clip.id}
        initial={{ y: 10 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className="glass rounded-3xl p-4 sm:p-5"
      >
        <RoundHeader
          clip={clip}
          roundNumber={roundNumber}
          totalRounds={totalRounds}
          replays={replays}
          slowMode={slowMode}
          sourceKind={sourceKind}
          nodeLabel={nodeLabel}
          reviewMode={reviewMode}
          highStreak={highStreak}
          promotionNeed={promotionNeed}
          onQuit={onQuit}
        />
      </motion.div>

      <AudioStage
        engine={engine}
        playing={playing}
        slowMode={slowMode}
        spectrumLive={spectrumLive}
        fallbackActive={fallbackActive}
        slowRate={slowRate}
        loading={loading}
        loadError={loadError}
        replays={replays}
        volume={volume}
        currentTime={currentTime}
        duration={duration}
        noiseDb={clip.noiseDb}
        onPlayNormal={() => onPlay(false)}
        onPlaySlow={() => onPlay(true)}
        onPause={onPause}
        onVolumeChange={onVolumeChange}
        onRetryLoad={onRetryLoad}
      />

      {/* The graded report and the transcription box are primary content, so the
          swap is a plain conditional render rather than an AnimatePresence
          transition. If the animation loop is throttled (backgrounded tab, low
          power mode, embedded webview) an exit animation would never complete
          and the learner would submit an answer and see nothing change.
          Animations below are transform-only decoration for the same reason:
          starting from `opacity: 0` would leave content invisible whenever
          frames are not being produced. */}
      {phase === 'graded' && result ? (
        <DiffCard
          result={result}
          isLastRound={roundNumber >= totalRounds}
          currentLevel={clip.level}
          nextLevel={nextLevel}
          roundNumber={reviewRound}
          totalRounds={totalRounds}
          reviewing={reviewing}
          onNext={onNext}
          onPrevious={onPrevious}
          onReplayNormal={() => onPlay(false)}
          onReplaySlow={() => onPlay(true)}
          slowRate={slowRate}
        />
      ) : (
        <TranscriptInput
          ref={inputRef}
          value={text}
          onChange={setText}
          onSubmit={() => onSubmit(text)}
          disabled={disabled}
          typedWords={countWords(text)}
          expectedWords={clip.wordCount}
          hintEnabled={hintEnabled}
          onHintToggle={onHintToggle}
          slowRate={slowRate}
        />
      )}
    </div>
  );
}
