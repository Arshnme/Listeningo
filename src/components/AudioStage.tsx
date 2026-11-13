'use client';

import { useEffect, useState } from 'react';
import { Loader2, Pause, Play, Repeat, Turtle, Volume2, VolumeX } from 'lucide-react';
import { SpectrumVisualizer } from '@/components/SpectrumVisualizer';
import { Pill } from '@/components/ui/primitives';
import { pluralWord } from '@/lib/text';
import type { AudioEngine } from '@/lib/audio/engine';

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const whole = Math.floor(value);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The listening stage: visualiser, the two playback speeds, replay counter and
 * a monitor of the synthesised noise actually being mixed in.
 */
export function AudioStage({
  engine,
  playing,
  slowMode,
  spectrumLive,
  fallbackActive,
  slowRate,
  loading,
  loadError,
  replays,
  volume,
  currentTime,
  duration,
  noiseDb,
  onPlayNormal,
  onPlaySlow,
  onPause,
  onVolumeChange,
  onRetryLoad,
}: {
  engine: AudioEngine | null;
  playing: boolean;
  slowMode: boolean;
  spectrumLive: boolean;
  fallbackActive: boolean;
  /** Configured pitch-preserved speed for Slow Mode. */
  slowRate: number;
  loading: boolean;
  loadError: string | null;
  replays: number;
  volume: number;
  currentTime: number;
  duration: number;
  noiseDb: number | null;
  onPlayNormal: () => void;
  onPlaySlow: () => void;
  onPause: () => void;
  onVolumeChange: (value: number) => void;
  onRetryLoad: () => void;
}) {
  // Noise gain is read from the graph on a slow poll: it changes only when the
  // clip, tier or Slow Mode changes, never per frame.
  const [noiseGainDb, setNoiseGainDb] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setNoiseGainDb(engine?.getNoiseGainDb() ?? null);
    read();
    const interval = window.setInterval(read, 400);
    return () => window.clearInterval(interval);
  }, [engine, slowMode, noiseDb]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const muted = volume <= 0.001;

  return (
    <div className="glass-strong glass-sheen flex flex-col gap-5 p-4 sm:p-6">
      {/* ------------------------------------------------------- visualiser -- */}
      <SpectrumVisualizer
        engine={engine}
        playing={playing}
        live={spectrumLive}
        fallbackActive={fallbackActive}
        slowMode={slowMode}
        slowRate={slowRate}
        barCount={32}
        height={104}
      />

      {/* --------------------------------------------------------- progress -- */}
      <div className="flex items-center gap-3">
        <span className="metric w-10 shrink-0 text-[11px] text-neutral-400">
          {formatSeconds(currentTime)}
        </span>
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
          {/* Width comes from the transport clock through a CSS transition, not
              from a JS animation loop, so position is right even without frames. */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/85 transition-[width] duration-150 ease-linear"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <span className="metric w-10 shrink-0 text-right text-[11px] text-neutral-500">
          {formatSeconds(duration)}
        </span>
      </div>

      {/* ---------------------------------------------------------- controls -- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onPlayNormal}
            disabled={loading || Boolean(loadError)}
            className="btn-primary min-w-[10.5rem] py-3.5"
            title="Replay at native speed (Tab or Ctrl+Space)"
          >
            {loading ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Loading voice…
              </>
            ) : (
              <>
                <Play size={16} />
                Play Normal · 1.0x
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onPlaySlow}
            disabled={loading || Boolean(loadError)}
            className={`btn-ghost py-3.5 ${slowMode ? 'btn-ghost-active' : ''}`}
            title={`Play at ${slowRate}x with pitch preserved, and halve the injected noise (Shift+Space)`}
          >
            <Turtle size={16} />
            Try Slow · {slowRate}x
          </button>

          {playing ? (
            <button type="button" onClick={onPause} className="btn-ghost py-3.5" title="Pause playback">
              <Pause size={15} />
              Pause
            </button>
          ) : null}
        </div>

        {/* ------------------------------------------------------ monitors -- */}
        <div className="flex flex-wrap items-center gap-2">
          <Pill title="Extra listens beyond the first. Slow Mode and more than 2 replays pause mastery progress.">
            <Repeat size={10} />
            <span className="metric">{replays}</span> {pluralWord(replays, 'replay')}
          </Pill>

          <Pill
            className="border-white/[0.1]"
            title={
              noiseDb === null
                ? 'No synthesised noise for this tier'
                : 'Level of the synthesised noise bed actually being mixed in, relative to full scale'
            }
          >
            <Volume2 size={10} />
            {noiseDb === null || noiseGainDb === null
              ? 'noise off'
              : `noise ${noiseGainDb.toFixed(1)} dBFS`}
          </Pill>

          {/* Volume */}
          <div className="glass-inset flex items-center gap-2 px-2.5 py-1.5">
            <button
              type="button"
              onClick={() => onVolumeChange(muted ? 0.85 : 0)}
              className="text-neutral-400 transition-colors hover:text-white"
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolumeChange(Number(event.target.value))}
              aria-label="Playback volume"
              className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/15 accent-white [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            />
            <span className="metric w-7 text-right text-[10px] text-neutral-500">
              {Math.round(volume * 100)}
            </span>
          </div>
        </div>
      </div>

      {loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.14] bg-white/[0.04] px-3.5 py-3">
          <p className="text-[11px] leading-relaxed text-neutral-300">{loadError}</p>
          <button type="button" onClick={onRetryLoad} className="btn-ghost py-1.5 text-[11px]">
            Retry download
          </button>
        </div>
      ) : null}

      {slowMode && noiseDb !== null ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
          slow mode active · noise bed attenuated 50% (~+6 dB snr) · pitch preserved
        </p>
      ) : null}
    </div>
  );
}
