import { NOMINAL_SPEECH_RMS, SLOW_MODE_NOISE_SCALE, SLOW_PLAYBACK_RATE } from '../levels';
import type { RoundClip, AudioSourceKind, EngineStatus, SlowRate } from '../types';
import { fetchClipBlob, DatasetError } from '../hf';
import { putCachedClip } from '../idb';
import { canEncodeOpus, encodeToOpusWebm, supportsOpusCache } from './opus';
import { bufferRms, createNoiseBuffer, estimateSpeechRms, solveNoiseGain } from './noise';

/**
 * The client-side audio engine.
 *
 * Signal flow:
 *
 *   <audio> ──MediaElementSource──┬─> masterGain ──> [shaping] ──> destination
 *                                 └─> analyser            (tap only)
 *   noiseBed(s) ──> filters ──> noiseGain ──┬─> masterGain
 *                                           └─> analyser
 *
 * Two deliberate choices keep audio from ever going silent:
 *
 * 1. The noise bed is a *parallel* graph, never fed by the media element. It
 *    cannot fail because of a cross-origin source.
 * 2. The media element is only rerouted through Web Audio once the context is
 *    confirmed `running`. If it is not, the element keeps playing natively and
 *    the visualiser falls back to a synthetic envelope. Creating a
 *    MediaElementSource on a suspended context is the classic way to make an app
 *    look alive but produce no sound, and that is exactly what this guard avoids.
 *
 * Because clips are played from locally created Blob URLs, the media element is
 * same-origin, so the graph can also read genuine spectrum data.
 */

/**
 * Vendor-prefixed pitch preservation flags, still needed on some engines.
 *
 * `preservesPitch` itself is already declared on HTMLMediaElement in modern
 * lib.dom, so only the legacy aliases are added here.
 */
type PitchPreservingAudio = HTMLAudioElement & {
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  msPreservesPitch?: boolean;
};

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export interface EngineCallbacks {
  onPlaybackChange?: (playing: boolean) => void;
  onProgress?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onStatusChange?: (status: EngineStatus) => void;
  onError?: (message: string) => void;
}

const FADE_IN_SECONDS = 0.35;
const FADE_OUT_SECONDS = 0.22;
const BAR_MIN_HZ = 70;
const BAR_MAX_HZ = 7800;

export class AudioEngine {
  private readonly audio: PitchPreservingAudio | null;
  private readonly callbacks: EngineCallbacks;

  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private shapingFilter: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseSources: AudioBufferSourceNode[] = [];
  private noiseBuffers = new Map<string, AudioBuffer>();

  private spectrumBuffer: Uint8Array<ArrayBuffer> | null = null;
  private barRanges: Array<[number, number]> = [];

  /** True once the media element is genuinely routed through the graph. */
  private graphReady = false;
  /** True when spectrum data comes from the real analyser rather than a model. */
  private spectrumLive = false;
  private fallbackReason: string | null = null;

  private currentClip: RoundClip | null = null;
  private objectUrl: string | null = null;
  private voiceRms = NOMINAL_SPEECH_RMS;
  private noiseRms = 1;
  private volume = 0.85;
  private slowMode = false;
  private slowRate: SlowRate = SLOW_PLAYBACK_RATE;
  /**
   * Re-encodes clips to WebM/Opus before storing them. Playback always uses the
   * downloaded audio; only the stored copy is compacted, in the background.
   */
  private compressCache = true;
  /** Bytes saved by compaction on this page, for the settings readout. */
  private bytesSaved = 0;
  private compressFailures = 0;
  private playing = false;
  private loaded = false;
  private disposed = false;

  constructor(callbacks: EngineCallbacks = {}) {
    this.callbacks = callbacks;
    this.audio = typeof window === 'undefined' ? null : (new Audio() as PitchPreservingAudio);
    if (this.audio) {
      this.audio.preload = 'auto';
      this.audio.crossOrigin = 'anonymous';
      this.audio.volume = 1;
      this.applyPitchPreservation(true);
      this.bindMediaEvents();
    }
  }

  // ---------------------------------------------------------------- status --

  getStatus(): EngineStatus {
    const contextState = this.context
      ? (this.context.state as EngineStatus['contextState'])
      : 'uninitialized';
    return {
      contextState,
      spectrumLive: this.spectrumLive,
      fallbackReason: this.fallbackReason,
      compression: {
        bytesSaved: this.bytesSaved,
        failures: this.compressFailures,
        supported: supportsOpusCache(),
      },
    };
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  hasDecodedAudio(): boolean {
    return this.voiceRms !== NOMINAL_SPEECH_RMS || this.spectrumLive;
  }

  /** Measured speech-active RMS of the loaded clip, for the HUD readout. */
  getVoiceRms(): number {
    return this.voiceRms;
  }

  /**
   * Current noise bed gain in dBFS, or null when no bed is loaded.
   *
   * This is the value actually applied to the graph, so it reflects the SNR
   * calibration and any Slow Mode attenuation in force right now.
   */
  getNoiseGainDb(): number | null {
    if (!this.noiseGain || this.noiseSources.length === 0) return null;
    const value = this.noiseGain.gain.value;
    if (value <= 0) return -120;
    return 20 * Math.log10(value);
  }

  private emitStatus(): void {
    this.callbacks.onStatusChange?.(this.getStatus());
  }

  // ------------------------------------------------------------ audio graph --

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (this.context) return this.context;
    const Ctor = getAudioContextConstructor();
    if (!Ctor) {
      this.fallbackReason = 'Web Audio API unavailable in this browser.';
      return null;
    }
    try {
      this.context = new Ctor();
    } catch {
      this.fallbackReason = 'Could not start a Web Audio context.';
      return null;
    }

    const analyser = this.context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    this.analyser = analyser;
    this.spectrumBuffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.computeBarRanges(analyser.frequencyBinCount);

    const master = this.context.createGain();
    master.gain.value = this.volume;
    this.masterGain = master;

    const shaping = this.context.createBiquadFilter();
    shaping.type = 'lowpass';
    shaping.frequency.value = 20_000;
    shaping.Q.value = 0.7;
    this.shapingFilter = shaping;

    master.connect(shaping);
    shaping.connect(this.context.destination);
    // Analyser is a pure tap: its output is intentionally left unconnected.
    master.connect(analyser);

    const noiseGain = this.context.createGain();
    noiseGain.gain.value = 0;
    noiseGain.connect(master);
    noiseGain.connect(analyser);
    this.noiseGain = noiseGain;

    return this.context;
  }

  /**
   * Routes the media element through the graph, but only when the context is
   * actually running. Returns false when audio must stay on the native path.
   */
  private async ensureGraph(): Promise<boolean> {
    if (this.graphReady) return true;
    const context = this.ensureContext();
    if (!context || !this.audio) return false;

    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch {
        /* handled by the state check below */
      }
    }
    if (context.state !== 'running') {
      this.fallbackReason = 'Audio context is suspended; using native playback.';
      this.emitStatus();
      return false;
    }

    if (!this.mediaSource) {
      try {
        this.mediaSource = context.createMediaElementSource(this.audio);
        if (this.masterGain) this.mediaSource.connect(this.masterGain);
        if (this.analyser) this.mediaSource.connect(this.analyser);
      } catch {
        // Another MediaElementSource already owns this element, or the browser
        // refused. Native playback stays in charge; only the visualiser suffers.
        this.mediaSource = null;
        this.fallbackReason = 'Live spectrum unavailable; visualiser synthesised.';
        this.emitStatus();
        return false;
      }
    }
    this.graphReady = true;
    this.spectrumLive = true;
    this.fallbackReason = null;
    this.emitStatus();
    return true;
  }

  private computeBarRanges(binCount: number): void {
    const nyquist = (this.context?.sampleRate ?? 48_000) / 2;
    const bars = 28;
    const ranges: Array<[number, number]> = [];
    const logMin = Math.log10(BAR_MIN_HZ);
    const logMax = Math.log10(Math.min(BAR_MAX_HZ, nyquist));
    for (let bar = 0; bar < bars; bar += 1) {
      const lowHz = 10 ** (logMin + ((logMax - logMin) * bar) / bars);
      const highHz = 10 ** (logMin + ((logMax - logMin) * (bar + 1)) / bars);
      const start = Math.max(0, Math.floor((lowHz / nyquist) * binCount));
      const end = Math.min(binCount, Math.max(start + 1, Math.ceil((highHz / nyquist) * binCount)));
      ranges.push([start, end]);
    }
    this.barRanges = ranges;
  }

  // ------------------------------------------------------------- media sync --

  private applyPitchPreservation(enabled: boolean): void {
    if (!this.audio) return;
    this.audio.preservesPitch = enabled;
    this.audio.webkitPreservesPitch = enabled;
    this.audio.mozPreservesPitch = enabled;
    this.audio.msPreservesPitch = enabled;
  }

  private bindMediaEvents(): void {
    const audio = this.audio;
    if (!audio) return;

    audio.addEventListener('play', () => {
      this.playing = true;
      this.startNoise();
      this.callbacks.onPlaybackChange?.(true);
    });
    audio.addEventListener('pause', () => {
      this.playing = false;
      this.stopNoise();
      this.callbacks.onPlaybackChange?.(false);
    });
    audio.addEventListener('ended', () => {
      this.playing = false;
      this.stopNoise();
      this.callbacks.onPlaybackChange?.(false);
      this.callbacks.onEnded?.();
    });
    audio.addEventListener('timeupdate', () => {
      this.callbacks.onProgress?.(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
    });
    audio.addEventListener('loadedmetadata', () => {
      this.callbacks.onProgress?.(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
    });
    audio.addEventListener('error', () => {
      this.playing = false;
      this.stopNoise();
      this.callbacks.onPlaybackChange?.(false);
      this.callbacks.onError?.('This clip could not be played. Try replaying or use Slow Mode.');
    });
  }

  // ---------------------------------------------------------------- loading --

  /**
   * Downloads and prepares one clip.
   *
   * Returns how the audio was obtained so the UI can badge the round. Throws a
   * {@link DatasetError} when nothing could be loaded — there is no substitute
   * voice: the caller surfaces a retry state, because every round must play
   * genuine LibriSpeech audio or none at all.
   */
  async load(clip: RoundClip, signal?: AbortSignal): Promise<{ source: AudioSourceKind }> {
    if (!this.audio) throw new DatasetError('network', 'Audio is not available in this environment.');
    this.releaseObjectUrl();
    this.loaded = false;
    this.currentClip = clip;
    this.voiceRms = NOMINAL_SPEECH_RMS;

    // Skip the downloader's cache write when a compacted copy is planned, so the
    // cache is not filled with FLAC only to be replaced moments later.
    const willCompress = this.compressCache && supportsOpusCache();
    const { blob, source } = await fetchClipBlob(clip, signal, {
      skipCacheWrite: willCompress,
    });
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    this.audio.load();
    this.loaded = true;

    // Decoding is an enhancement, never a requirement: it supplies the true
    // speech level for SNR calibration and the spectrum tap.
    let decoded: AudioBuffer | null = null;
    try {
      const context = this.ensureContext();
      if (context) {
        decoded = await context.decodeAudioData(await blob.arrayBuffer());
        this.voiceRms = estimateSpeechRms(decoded);
      }
    } catch {
      this.voiceRms = NOMINAL_SPEECH_RMS;
    }

    if (source === 'dataset') {
      if (willCompress && decoded) {
        // Fire and forget: the round must not wait on an encoder, and a failure
        // simply means this clip stays stored as FLAC.
        void this.storeCompressed(clip.id, decoded, blob.size);
      } else {
        // Compression was off, unsupported, or decoding failed: keep the original.
        void putCachedClip(clip.id, blob);
      }
    }

    await this.prepareNoise(clip);
    return { source };
  }

  /**
   * Re-encodes a decoded clip and replaces its cached copy.
   *
   * Runs after the round has already started on the downloaded audio, so nothing
   * the learner hears depends on the encoder finishing.
   */
  private async storeCompressed(
    id: string,
    decoded: AudioBuffer,
    originalBytes: number,
  ): Promise<void> {
    const originalUrl = this.objectUrl;
    try {
      const compact = (await canEncodeOpus()) ? await encodeToOpusWebm(decoded) : null;
      // Only accept the compacted copy when it is valid and genuinely smaller.
      if (compact && compact.size > 0 && compact.size < originalBytes) {
        const stored = await putCachedClip(id, compact);
        if (stored) {
          this.bytesSaved += originalBytes - compact.size;
          this.emitStatus();
          return;
        }
      }
      this.compressFailures += 1;
      // Never leave the clip uncached just because compaction did not work.
      if (originalUrl) {
        const original = await fetch(originalUrl)
          .then((response) => response.blob())
          .catch(() => null);
        if (original) void putCachedClip(id, original);
      }
    } catch {
      this.compressFailures += 1;
    }
  }

  private async prepareNoise(clip: RoundClip): Promise<void> {
    this.teardownNoise();

    // The shaping filter sits on the master bus, so it must be reset on every
    // clip. Returning early without clearing it would leave a muted, lowpassed
    // master in place and quietly muffle a clean Tier 1 voice after Tier 5.
    if (this.shapingFilter) {
      this.shapingFilter.frequency.value = clip.shaped ? 5200 : 20_000;
    }

    if (clip.noiseKind === 'none' || clip.noiseDb === null) {
      this.noiseRms = 1;
      return;
    }
    const context = this.ensureContext();
    if (!context || !this.noiseGain) return;

    // Tier 5 layers three beds to match the spec's "static + crowd murmur":
    // a modulated murmur, a low rumble under it, and a bright static hiss.
    const beds: Array<'white' | 'pink' | 'crowd' | 'brown'> =
      clip.noiseKind === 'crowd' ? ['crowd', 'brown', 'white'] : ['pink'];

    /** Relative weight of each bed before the SNR solve is applied. */
    const bedWeight: Record<'white' | 'pink' | 'crowd' | 'brown', number> = {
      crowd: 1,
      brown: 0.45,
      white: 0.3,
      pink: 1,
    };

    let aggregateRms = 0;
    for (const bed of beds) {
      const key = `${bed}`;
      let buffer = this.noiseBuffers.get(key);
      if (!buffer) {
        buffer = createNoiseBuffer(context, bed);
        this.noiseBuffers.set(key, buffer);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = context.createBiquadFilter();
      if (bed === 'brown') {
        // Low rumble: traffic and building noise below the voice band.
        filter.type = 'lowpass';
        filter.frequency.value = 240;
        filter.Q.value = 0.6;
      } else if (bed === 'white') {
        // Static hiss: sits above the consonant band so it masks detail.
        filter.type = 'highpass';
        filter.frequency.value = 2600;
        filter.Q.value = 0.6;
      } else if (clip.noiseKind === 'crowd') {
        filter.type = 'bandpass';
        filter.frequency.value = 720;
        filter.Q.value = 0.7;
      } else {
        filter.type = 'bandpass';
        filter.frequency.value = 900;
        filter.Q.value = 0.5;
      }

      const bedGain = context.createGain();
      bedGain.gain.value = bedWeight[bed];
      source.connect(filter);
      filter.connect(bedGain);
      bedGain.connect(this.noiseGain);

      this.noiseSources.push(source);
      aggregateRms += bufferRms(buffer) * bedWeight[bed];
    }
    this.noiseRms = Math.max(aggregateRms, 1e-6);
  }

  private teardownNoise(): void {
    for (const source of this.noiseSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.noiseSources = [];
  }

  // -------------------------------------------------------------- transport --

  /** Enables or disables Opus compaction of the local audio cache. */
  setCompressCache(enabled: boolean): void {
    this.compressCache = enabled;
  }

  /**
   * Whether this browser can compact at all. Surfaced so the settings screen can
   * explain why the toggle has no effect rather than appearing to do nothing.
   */
  static supportsCompression(): boolean {
    return supportsOpusCache();
  }

  /** Compaction figures since this page loaded. */
  getCompressionStats(): { bytesSaved: number; failures: number; supported: boolean } {
    return {
      bytesSaved: this.bytesSaved,
      failures: this.compressFailures,
      supported: supportsOpusCache(),
    };
  }

  /** Chooses the pitch-preserved speed used by Slow Mode. */
  setSlowRate(rate: SlowRate): void {
    this.slowRate = rate;
    if (this.slowMode && this.audio) this.audio.playbackRate = rate;
  }

  /** Sets playback rate, preserving pitch so Slow Mode never sounds like a chipmunk. */
  setSlowMode(enabled: boolean): void {
    this.slowMode = enabled;
    if (!this.audio) return;
    this.applyPitchPreservation(true);
    this.audio.playbackRate = enabled ? this.slowRate : 1;
    // Slow Mode halves the injected noise so difficult words surface.
    if (this.playing) this.applyNoiseLevel(true);
  }

  isSlowMode(): boolean {
    return this.slowMode;
  }

  /** The pitch-preserved speed currently used by Slow Mode. */
  getSlowRate(): SlowRate {
    return this.slowRate;
  }

  async play(): Promise<void> {
    if (!this.audio || !this.audio.src) return;
    await this.ensureGraph();
    if (this.context && this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        /* the element will still play natively */
      }
    }
    this.applyPitchPreservation(true);
    this.audio.playbackRate = this.slowMode ? this.slowRate : 1;
    try {
      await this.audio.play();
    } catch {
      this.callbacks.onError?.('Playback was blocked. Press play again to start audio.');
    }
  }

  pause(): void {
    this.audio?.pause();
  }

  /** Rewinds to the start and pauses, so the next play is a fresh listen. */
  rewind(): void {
    if (!this.audio) return;
    try {
      this.audio.currentTime = 0;
    } catch {
      /* some engines refuse before metadata is ready */
    }
  }

  async restart(rate1x: boolean): Promise<void> {
    if (!this.audio) return;
    this.setSlowMode(!rate1x);
    this.rewind();
    await this.play();
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.masterGain && this.context) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  // ------------------------------------------------------------------ noise --

  /** Target linear gain for the noise bed at the clip's calibrated SNR. */
  private noiseTargetGain(): number {
    const clip = this.currentClip;
    if (!clip || clip.noiseDb === null || clip.noiseKind === 'none') return 0;
    const base = solveNoiseGain(this.voiceRms, this.noiseRms, clip.noiseDb);
    return this.slowMode ? base * SLOW_MODE_NOISE_SCALE : base;
  }

  private applyNoiseLevel(ramp: boolean): void {
    if (!this.noiseGain || !this.context) return;
    const target = this.noiseTargetGain();
    const now = this.context.currentTime;
    this.noiseGain.gain.cancelScheduledValues(now);
    if (ramp) {
      this.noiseGain.gain.setValueAtTime(this.noiseGain.gain.value, now);
      this.noiseGain.gain.linearRampToValueAtTime(target, now + FADE_IN_SECONDS);
    } else {
      this.noiseGain.gain.setValueAtTime(target, now);
    }
  }

  private startNoise(): void {
    if (!this.context || this.noiseSources.length === 0) return;
    const now = this.context.currentTime;
    for (const source of this.noiseSources) {
      try {
        source.start(now);
      } catch {
        /* already running */
      }
    }
    this.applyNoiseLevel(true);
  }

  private stopNoise(): void {
    if (!this.context || !this.noiseGain) {
      this.teardownNoise();
      return;
    }
    const now = this.context.currentTime;
    const gain = this.noiseGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + FADE_OUT_SECONDS);
    const sources = [...this.noiseSources];
    this.noiseSources = [];
    // Let the fade finish before the nodes are released.
    window.setTimeout(() => {
      for (const source of sources) {
        try {
          source.stop();
          source.disconnect();
        } catch {
          /* already stopped */
        }
      }
    }, FADE_OUT_SECONDS * 1000 + 60);
  }

  /** Immediately silences the bed, e.g. when leaving the arena. */
  silenceNoise(): void {
    this.teardownNoise();
    if (this.noiseGain && this.context) {
      this.noiseGain.gain.cancelScheduledValues(this.context.currentTime);
      this.noiseGain.gain.setValueAtTime(0, this.context.currentTime);
    }
  }

  /** Fades the noise bed out — called when a round is submitted. */
  endNoise(): void {
    this.stopNoise();
  }

  // -------------------------------------------------------------- spectrum --

  /**
   * Normalised bar heights (0..1) for the visualiser.
   *
   * Real analyser data wherever the graph is live; otherwise a deterministic
   * envelope so the UI stays animated. {@link EngineStatus.spectrumLive} always
   * reports which of the two the caller is looking at.
   */
  getSpectrum(bars: number): number[] {
    const out = new Array<number>(bars).fill(0);
    const analyser = this.analyser;
    const buffer = this.spectrumBuffer;

    if (analyser && buffer && this.spectrumLive && this.playing) {
      analyser.getByteFrequencyData(buffer);
      for (let bar = 0; bar < bars; bar += 1) {
        const range = this.barRanges[Math.floor((bar / bars) * this.barRanges.length)];
        if (!range) continue;
        const [start, end] = range;
        let sum = 0;
        let count = 0;
        for (let bin = start; bin < end; bin += 1) {
          sum += buffer[bin] ?? 0;
          count += 1;
        }
        const average = count > 0 ? sum / count : 0;
        // Gentle tilt: the analyser is already in dB, so this only de-emphasises
        // the very top end where FLAC speech carries little energy.
        const tilt = 1 - (bar / bars) * 0.35;
        out[bar] = Math.min(1, (average / 255) * 1.35 * tilt);
      }
      return out;
    }

    // Synthetic mode: a smooth, non-repeating envelope that still responds to
    // real transport state (playing, position, slow mode).
    const position = this.audio?.currentTime ?? 0;
    const rate = this.slowMode ? this.slowRate : 1;
    for (let bar = 0; bar < bars; bar += 1) {
      const t = position * rate;
      const base = Math.sin(t * (3.1 + bar * 0.11) + bar * 0.7) * 0.5 + 0.5;
      const detail = Math.sin(t * (7.3 + bar * 0.37) + bar * 1.9) * 0.25 + 0.25;
      const envelope = this.playing ? 1 : 0.12;
      const shaped = Math.max(0.04, (base * 0.7 + detail * 0.3) * envelope);
      out[bar] = Math.min(1, shaped * (1 - Math.abs(bar / bars - 0.35) * 0.5));
    }
    return out;
  }

  // ----------------------------------------------------------------- cleanup --

  private releaseObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** Stops everything and frees the media element's source. */
  reset(): void {
    this.stopNoise();
    this.silenceNoise();
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch {
        /* nothing to release */
      }
    }
    this.releaseObjectUrl();
    this.currentClip = null;
    this.loaded = false;
    this.playing = false;
    this.voiceRms = NOMINAL_SPEECH_RMS;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
    this.teardownNoise();
    try {
      this.mediaSource?.disconnect();
      this.masterGain?.disconnect();
      this.analyser?.disconnect();
      this.noiseGain?.disconnect();
      this.shapingFilter?.disconnect();
      void this.context?.close();
    } catch {
      /* context already closed */
    }
    this.context = null;
    this.mediaSource = null;
    this.masterGain = null;
    this.analyser = null;
    this.noiseGain = null;
    this.shapingFilter = null;
  }
}
