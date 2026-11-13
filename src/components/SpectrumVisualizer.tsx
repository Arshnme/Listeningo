'use client';

import { useEffect, useRef } from 'react';
import { AudioLines } from 'lucide-react';
import { useAnimationFrame } from '@/lib/hooks';
import type { AudioEngine } from '@/lib/audio/engine';

/**
 * Monochrome spectrum visualiser.
 *
 * Bar heights and peak caps are written straight to the DOM from a single
 * requestAnimationFrame loop. Driving 60 fps through React state would
 * re-render the whole arena every frame for no benefit, so the refs are updated
 * in place and React only re-renders when the playing flag or mode changes.
 */
export function SpectrumVisualizer({
  engine,
  playing,
  barCount = 28,
  height = 112,
  live,
  fallbackActive,
  slowMode,
  slowRate,
}: {
  engine: AudioEngine | null;
  playing: boolean;
  barCount?: number;
  height?: number;
  live: boolean;
  /**
   * True when the Web Audio graph could not be used for the analyser, so the
   * bars are driven by a synthesised envelope instead of live FFT data. This is
   * about the *visualiser* only — the audio is always genuine LibriSpeech.
   */
  fallbackActive: boolean;
  slowMode: boolean;
  /** Configured pitch-preserved speed, so the readout matches Settings. */
  slowRate: number;
}) {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const peakRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const smoothed = useRef<number[]>(new Array(barCount).fill(0));
  const peaks = useRef<number[]>(new Array(barCount).fill(0));

  // This badge describes where the *bars* come from, never where the voice comes
  // from — that is always the dataset. "Meter synth" says the meter is modelled.
  const sourceLabel = live ? 'live fft' : fallbackActive ? 'meter synth' : 'graph ready';

  useEffect(() => {
    smoothed.current = new Array(barCount).fill(0);
    peaks.current = new Array(barCount).fill(0);
  }, [barCount]);

  useAnimationFrame(() => {
    const values = engine?.getSpectrum(barCount) ?? new Array(barCount).fill(0);
    for (let index = 0; index < barCount; index += 1) {
      const raw = values[index] ?? 0;
      // Attack fast, release slow: reads as a real meter rather than a flicker.
      const previous = smoothed.current[index] ?? 0;
      const factor = raw > previous ? 0.55 : 0.12;
      const next = previous + (raw - previous) * factor;
      smoothed.current[index] = next;

      const peak = Math.max((peaks.current[index] ?? 0) - 0.012, next);
      peaks.current[index] = peak;

      const bar = barRefs.current[index];
      if (bar) {
        const scaled = Math.max(0.015, next);
        bar.style.transform = `scaleY(${scaled.toFixed(4)})`;
        bar.style.opacity = playing ? '1' : '0.32';
      }
      const cap = peakRefs.current[index];
      if (cap) {
        cap.style.bottom = `${Math.min(100, peak * 100).toFixed(2)}%`;
        cap.style.opacity = playing && peak > 0.06 ? '0.7' : '0';
      }
    }
  }, true);

  return (
    <div className="relative w-full">
      <div
        className="flex items-end justify-between gap-[3px] overflow-hidden"
        style={{ height }}
        aria-hidden
      >
        {Array.from({ length: barCount }, (_, index) => (
          <div key={index} className="relative h-full flex-1">
            {/* Peak-hold cap */}
            <span
              ref={(element) => {
                peakRefs.current[index] = element;
              }}
              className="absolute left-0 right-0 h-[1.5px] rounded-full bg-white transition-opacity duration-200"
              style={{ bottom: '0%', opacity: 0 }}
            />
            {/* Live bar */}
            <span
              ref={(element) => {
                barRefs.current[index] = element;
              }}
              className="absolute bottom-0 left-0 right-0 origin-bottom rounded-[2px]"
              style={{
                height: '100%',
                transform: 'scaleY(0.015)',
                background: slowMode
                  ? 'linear-gradient(to top, rgba(255,255,255,0.35), rgba(255,255,255,0.95))'
                  : 'linear-gradient(to top, rgba(255,255,255,0.22), #ffffff)',
                willChange: 'transform',
              }}
            />
          </div>
        ))}
      </div>

      {/* Baseline: a single hairline anchors the meter. */}
      <div className="mt-2 h-px w-full bg-gradient-to-r from-transparent via-white/25 to-transparent" />

      <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-neutral-600">
        <span>70 Hz</span>
        <span className="inline-flex items-center gap-1.5">
          <AudioLines size={10} />
          {sourceLabel}
        </span>
        <span>{slowMode ? `${slowRate}x` : '1.0x'} · 7.8 kHz</span>
      </div>
    </div>
  );
}
