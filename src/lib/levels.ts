import type {
  AcousticMode,
  DatasetConfig,
  DatasetSplit,
  DifficultyLevel,
  NoiseIntensity,
  NoiseKind,
  SlowRate,
} from './types';

/** Acoustic profile injected by the Web Audio noise engine for a tier. */
export interface NoiseProfile {
  kind: NoiseKind;
  /** Target signal-to-noise ratio in dB. `null` means no noise is injected. */
  snrDb: number | null;
  /** Adds a lowpass stage so the bed sounds like a muffled room. */
  shaped: boolean;
}

export interface LevelConfig {
  level: DifficultyLevel;
  /** Short display name, e.g. `Studio Clean`. */
  name: string;
  /** HUD pill label, e.g. `Tier 3: Raw Other`. */
  tierPill: string;
  /** Which corpus config this tier draws from. */
  config: DatasetConfig;
  /** Flat label used for badges and history, derived from config. */
  splitLabel: Extract<DatasetSplit, 'test-clean' | 'test-other'>;
  /** Inclusive word-count window used to match manifest clips. */
  wordRange: readonly [number, number];
  noise: NoiseProfile;
  description: string;
}

export const LEVELS: Readonly<Record<DifficultyLevel, LevelConfig>> = {
  1: {
    level: 1,
    name: 'Studio Clean',
    tierPill: 'Tier 1: Clean',
    config: 'clean',
    splitLabel: 'test-clean',
    wordRange: [3, 6],
    noise: { kind: 'none', snrDb: null, shaped: false },
    description: 'Very short studio sentences with crisp articulation and no added noise.',
  },
  2: {
    level: 2,
    name: 'Natural Clean',
    tierPill: 'Tier 2: Natural',
    config: 'clean',
    splitLabel: 'test-clean',
    wordRange: [7, 11],
    noise: { kind: 'none', snrDb: null, shaped: false },
    description: 'Longer studio sentences at a natural speaking cadence, still noise free.',
  },
  3: {
    level: 3,
    name: 'Raw Other',
    tierPill: 'Tier 3: Raw Other',
    config: 'other',
    splitLabel: 'test-other',
    wordRange: [9, 14],
    noise: { kind: 'none', snrDb: null, shaped: false },
    description: 'Switches to the LibriSpeech OTHER split: accented speakers and non-studio cadence.',
  },
  4: {
    level: 4,
    name: 'Noisy Environment',
    tierPill: 'Tier 4: Noisy',
    config: 'other',
    splitLabel: 'test-other',
    wordRange: [14, 18],
    noise: { kind: 'room', snrDb: 16, shaped: false },
    description: 'OTHER split sentences with a synthesised room-noise bed layered at 16 dB SNR.',
  },
  5: {
    level: 5,
    name: 'Extreme Noisy',
    tierPill: 'Tier 5: Extreme',
    config: 'other',
    splitLabel: 'test-other',
    wordRange: [19, 30],
    noise: { kind: 'crowd', snrDb: 10, shaped: true },
    description: 'Long literary sentences under crowd murmur at 10 dB SNR plus acoustic shaping.',
  },
};

export const LEVEL_NUMBERS: readonly DifficultyLevel[] = [1, 2, 3, 4, 5];

export function getLevel(level: number): LevelConfig {
  const clamped = Math.min(5, Math.max(1, Math.round(level))) as DifficultyLevel;
  return LEVELS[clamped];
}

export function clampLevel(level: number): DifficultyLevel {
  return Math.min(5, Math.max(1, Math.round(level))) as DifficultyLevel;
}

/** Reads a tier's display name safely from an arbitrary persisted number. */
export function levelName(level: number): string {
  return getLevel(level).name;
}

/** Reads a tier's HUD pill safely from an arbitrary persisted number. */
export function levelPill(level: number): string {
  return getLevel(level).tierPill;
}

export function levelSplitLabel(level: number): DatasetSplit {
  return getLevel(level).splitLabel;
}

/**
 * Applies the user's pool preference on top of the tier's own profile.
 *
 * `clean_only` pins every tier to studio audio with no injected noise, while
 * `noisy_forced` pushes audio onto the OTHER split and guarantees at least a
 * 16 dB room bed. `auto` simply honours the tier definition.
 */
export function resolveAcousticProfile(
  level: DifficultyLevel,
  mode: AcousticMode,
  intensity: NoiseIntensity = 'standard',
): { config: DatasetConfig; splitLabel: Extract<DatasetSplit, 'test-clean' | 'test-other'>; noise: NoiseProfile } {
  const base = LEVELS[level];
  let resolved: {
    config: DatasetConfig;
    splitLabel: Extract<DatasetSplit, 'test-clean' | 'test-other'>;
    noise: NoiseProfile;
  };

  if (mode === 'clean_only') {
    resolved = {
      config: 'clean',
      splitLabel: 'test-clean',
      noise: { kind: 'none', snrDb: null, shaped: false },
    };
  } else if (mode === 'noisy_forced') {
    resolved = {
      config: 'other',
      splitLabel: 'test-other',
      noise: base.noise.kind === 'none' ? { kind: 'room', snrDb: 16, shaped: false } : base.noise,
    };
  } else {
    resolved = { config: base.config, splitLabel: base.splitLabel, noise: base.noise };
  }

  return { ...resolved, noise: applyNoiseIntensity(resolved.noise, intensity) };
}

/** dB added to the tier's SNR target by each intensity setting. */
export const NOISE_INTENSITY_OFFSET_DB: Readonly<Record<NoiseIntensity, number>> = {
  standard: 0,
  // Lower SNR means more noise, so a boost subtracts.
  boosted: -6,
  muted: 0,
};

/**
 * Scales a tier's noise bed by the user's intensity preference.
 *
 * `muted` removes injection *and* the lowpass shaping stage, since both are part
 * of the synthesised-acoustic simulation the setting turns off.
 */
export function applyNoiseIntensity(profile: NoiseProfile, intensity: NoiseIntensity): NoiseProfile {
  if (intensity === 'muted') {
    return { kind: 'none', snrDb: null, shaped: false };
  }
  if (profile.snrDb === null || profile.kind === 'none') return profile;
  return { ...profile, snrDb: profile.snrDb + NOISE_INTENSITY_OFFSET_DB[intensity] };
}

/** Slow Mode halves the injected noise amplitude so difficult words surface. */
export const SLOW_MODE_NOISE_SCALE = 0.5;

/**
 * Selectable pitch-preserved slow speeds, fastest first.
 *
 * Anything below about 0.5x starts to smear consonants on long words, but it is
 * still the right call on a Tier 5 clip where the alternative is guessing.
 */
export const SLOW_RATES: readonly SlowRate[] = [0.75, 0.65, 0.6, 0.5, 0.4];

/** Default pitch-preserved slow speed. */
export const SLOW_PLAYBACK_RATE: SlowRate = 0.75;

/**
 * Default voices in one session.
 *
 * The actual count is a user setting (`voicesPerSession`, 1–30); this is the
 * value a fresh profile starts on and the fallback for anything unusable. Five
 * keeps a daily lesson short by default — the stepper widens it for anyone who
 * wants longer runs.
 */
export const ROUNDS_PER_SESSION = 5;

/**
 * Bounds for the voices-per-session setting.
 *
 * The ceiling is 30 rather than arbitrary: a session's rounds are persisted in
 * the history document, which accepts up to 40 rounds per session, so anything
 * at or below 30 can survive a reload intact. The floor is 1 — a short stage is
 * still a stage, and the setting must do exactly what it says.
 */
export const MIN_VOICES_PER_SESSION = 1;
export const MAX_VOICES_PER_SESSION = 30;

/**
 * Coerces an arbitrary persisted or user-supplied value into a usable session
 * length: an integer inside {@link MIN_VOICES_PER_SESSION}–{@link MAX_VOICES_PER_SESSION},
 * or the default when it is not a number at all.
 */
export function clampVoicesPerSession(value: unknown, fallback: number = ROUNDS_PER_SESSION): number {
  // `null` and `''` both coerce to 0 through Number(), which would silently
  // become a one-voice session; treat anything that is not genuinely numeric as
  // absent instead.
  let parsed: number;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && value.trim() !== '') parsed = Number(value);
  else return fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_VOICES_PER_SESSION, Math.max(MIN_VOICES_PER_SESSION, Math.round(parsed)));
}

/** Auto-promotion thresholds. */
export const PROMOTION = {
  tier1: { minAccuracy: 0.9, consecutive: 2 },
  tier2: { minAccuracy: 0.85, consecutive: 3 },
  /** Replays above this disqualify a round from counting toward promotion. */
  maxReplays: 2,
} as const;

/** Auto-demotion threshold: two consecutive rounds below this score step down. */
export const DEMOTION = { maxAccuracy: 0.55, consecutive: 2 } as const;

/** Approximate amplitude scale of speech used when no measurement is available. */
export const NOMINAL_SPEECH_RMS = 0.1;
