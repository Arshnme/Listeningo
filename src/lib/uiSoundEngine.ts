/**
 * Tactile interface sounds, synthesised with the Web Audio API.
 *
 * Every cue is built from oscillators and gain envelopes at call time, so the
 * app ships zero audio files: a mechanical crystal click when a node is hovered
 * or pressed, a glass chime when a voice is understood, and a rising synth
 * sweep when the adaptive engine promotes the learner or fast-tracks a section.
 *
 * Design constraints, all deliberate:
 *
 * - **Lazy context.** An `AudioContext` may only start from a user gesture, so
 *   the context is created on the first real interaction and resumed on later
 *   calls. Before that, every method is a silent no-op — a hover on a freshly
 *   loaded page cannot throw or produce a browser warning.
 * - **No `window` at module scope.** The module must import cleanly in the
 *   Node-based verification suites, so every browser access is guarded.
 * - **Timid levels.** Peaks sit at 3–6% of full scale. These are texture, not
 *   content: the audio the learner is studying must always dominate.
 * - **Always fire-and-forget.** Nothing here returns a promise, blocks, or
 *   throws; a muted, suspended or missing audio device costs the user a click,
 *   never a round.
 */

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

interface ToneSpec {
  type: OscillatorType;
  /** Start frequency in Hz. */
  from: number;
  /** End frequency for a glide; omit for a steady pitch. */
  to?: number;
  /** Seconds after `now` at which the tone begins. */
  delay?: number;
  /** Total sounding time in seconds. */
  duration: number;
  /** Peak gain, 0..1. */
  peak: number;
  /** Optional lowpass sweep shaping a raw waveform into a soft synth tone. */
  filter?: { from: number; to: number };
}

class UiSoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;

  constructor() {
    if (typeof window !== 'undefined') {
      // One-time unlock: browsers only allow the context to start from a
      // gesture, and this is the earliest point any gesture can be observed.
      const unlock = () => this.ensure();
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock, { passive: true });
    }
  }

  /** Muted state, mirrored from the persisted Settings toggle. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (this.context) {
      if (this.context.state === 'suspended') {
        void this.context.resume().catch(() => undefined);
      }
      return this.context;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.context.destination);
    } catch {
      this.context = null;
      this.master = null;
      return null;
    }
    if (this.context.state === 'suspended') {
      void this.context.resume().catch(() => undefined);
    }
    return this.context;
  }

  /** Schedules one enveloped oscillator. Silent no-op without a live context. */
  private tone(spec: ToneSpec): void {
    const context = this.ensure();
    if (!context || !this.master) return;
    const start = context.currentTime + (spec.delay ?? 0);
    const end = start + spec.duration;

    const oscillator = context.createOscillator();
    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(Math.max(1, spec.from), start);
    if (spec.to !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), end);
    }

    const gain = context.createGain();
    // Exponential ramps cannot touch zero, so the envelope rides between two
    // tiny positive values; the audible result is a click-free fade.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(spec.peak, start + Math.min(0.012, spec.duration / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    let tail: AudioNode = oscillator;
    if (spec.filter) {
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(spec.filter.from, start);
      filter.frequency.exponentialRampToValueAtTime(Math.max(1, spec.filter.to), end);
      oscillator.connect(filter);
      tail = filter;
    }
    tail.connect(gain);
    gain.connect(this.master);

    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  /**
   * Subtle low-frequency mechanical crystal click, 180 Hz falling to 90 Hz in
   * 35 ms. `strength` lets hover stay lighter than an actual press.
   */
  playClick(strength = 1): void {
    const clamped = Math.min(1.5, Math.max(0, strength));
    this.tone({
      type: 'triangle',
      from: 180,
      to: 90,
      duration: 0.035,
      peak: 0.055 * clamped,
    });
  }

  /** Crisp harmonic glass chime — C5, E5, G5 in quick succession. */
  playSuccess(): void {
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((frequency, index) => {
      this.tone({
        type: 'sine',
        from: frequency,
        delay: index * 0.085,
        duration: 0.5,
        peak: 0.05,
      });
    });
  }

  /**
   * Two-note sparkle for the path companions — brighter and shorter than the
   * success chime, so saying hello to a mascot never reads as a graded answer.
   */
  playCharacterChime(): void {
    this.tone({ type: 'sine', from: 987.77, duration: 0.22, peak: 0.045 });
    this.tone({ type: 'sine', from: 1318.51, delay: 0.085, duration: 0.28, peak: 0.05 });
  }

  /** Rising futuristic sweep for a promotion or a fast-tracked section. */
  playPromotion(): void {
    this.tone({
      type: 'sawtooth',
      from: 160,
      to: 880,
      duration: 0.45,
      peak: 0.03,
      filter: { from: 240, to: 4800 },
    });
    this.tone({
      type: 'sine',
      from: 880,
      to: 1318.5,
      delay: 0.32,
      duration: 0.32,
      peak: 0.05,
    });
  }
}

/** Page-lifetime singleton, shared by every surface that plays a cue. */
export const uiSounds = new UiSoundEngine();
