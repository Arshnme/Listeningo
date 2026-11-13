/**
 * Shared domain types for the adaptive listening trainer.
 *
 * The persisted shape is versioned independently from the runtime shape so the
 * cache can be migrated or discarded without breaking the UI.
 */

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

/** Which Hugging Face dataset config a clip comes from. */
export type DatasetConfig = 'clean' | 'other';

/** LibriSpeech directory name, e.g. `test-clean`. `other` splits are the noisy/accented ones. */
export type DatasetSplit = 'test-clean' | 'dev-clean' | 'test-other' | 'dev-other';

/** User-selectable pool filter. */
export type AcousticMode = 'auto' | 'clean_only' | 'noisy_forced';

/**
 * How hard the synthesised noise bed is driven relative to the tier's own SNR.
 *
 * `standard` honours the tier definition, `boosted` adds 6 dB of noise, and
 * `muted` disables injection entirely without changing the corpus split.
 */
export type NoiseIntensity = 'standard' | 'boosted' | 'muted';

/** Pitch-preserved slow playback speed. Lower is slower. */
export type SlowRate = 0.75 | 0.65 | 0.6 | 0.5 | 0.4;

/** Which of the five node slots a tier offers. */
export type NodeKind = 'intro' | 'practice' | 'workout' | 'reward' | 'boss';

/** A node's position on the path. */
export interface PathNodeRef {
  /** 1-5 */
  tier: DifficultyLevel;
  /** 1-5, the slot within the tier. */
  slot: number;
}

/** Persisted outcome for one path node. */
export interface NodeProgress {
  /** 0-3 stars, derived from the best session accuracy. */
  stars: number;
  /** Best session average accuracy, 0..1. */
  bestAccuracy: number;
  /** ISO timestamp of the clearing session. */
  completedAt: string;
  /** How many sessions have been attempted on this node. */
  attempts: number;
}

/** Everything the progression map needs to know. */
export interface PathProgress {
  /** Keyed by `tier-slot`, e.g. `"3-2"`. */
  nodes: Record<string, NodeProgress>;
  /** Node keys whose reward chest has been claimed. */
  chestsOpened: string[];
  /** Earned badges, e.g. `tier-1-mastery` or `tier-1-crown`. */
  badges: string[];
  /**
   * Highest tier unlocked by demonstrating mastery in the live engine rather
   * than by clearing nodes. Starts at 1.
   */
  fastTrackTier: DifficultyLevel;
}

/** Synthesised background bed layered under the voice. */
export type NoiseKind = 'none' | 'room' | 'crowd';

/**
 * How the audio for a round was actually obtained. Always real LibriSpeech
 * audio: shipped with the app (`bundled`), restored from the device's own
 * IndexedDB (`cache`), or streamed from the dataset server (`dataset`).
 */
export type AudioSourceKind = 'bundled' | 'dataset' | 'cache';

/** A single verified LibriSpeech clip from the offline manifest. */
export interface ManifestClip {
  id: string;
  text: string;
  speakerId: string;
  chapterId: string;
  config: DatasetConfig;
  /** Raw HF split name (`test` | `validation`). */
  split: 'test' | 'validation';
  /** LibriSpeech directory name derived from config + split. */
  splitLabel: DatasetSplit;
  /** Row index inside the configured split — how a fresh signed URL is resolved. */
  rowIdx: number;
  level: DifficultyLevel;
  wordCount: number;
  /**
   * Minutes of speech this speaker contributed to the corpus, from SPEAKERS.TXT.
   *
   * The corpus metadata has no star-rating column; `minutes` is the only
   * per-reader quality proxy available, and a prolific reader is a reliable one.
   * The manifest used to carry a `rating` field that was in fact populated with
   * the reader's *name*, which is why that field no longer exists.
   */
  speakerMinutes: number;
  /** Position within the tier, used as a stable shuffle key. */
  index: number;
}

/** A clip selected for a specific round, with its resolved acoustic profile. */
export interface RoundClip extends ManifestClip {
  /** SNR in dB, or null when no noise is injected. */
  noiseDb: number | null;
  noiseKind: NoiseKind;
  /** True when a lowpass shaping stage simulates muffled room acoustics. */
  shaped: boolean;
}

/** Result of grading one spoken sentence. */
export interface DiffToken {
  /**
   * `correct` matched exactly, `misspelled` matched the right word but spelled
   * differently, `wrong` a different word entirely, `missing` not produced,
   * `extra` produced but not in the sentence.
   */
  status: 'correct' | 'misspelled' | 'wrong' | 'missing' | 'extra';
  /** Ground-truth word (absent for `extra`). */
  expected?: string;
  /** What the user produced (absent for `missing`). */
  actual?: string;
  /** Index into the ground-truth word list, used to recover original casing. */
  expectedIndex?: number;
  /** Index into the learner's normalised word list. */
  actualIndex?: number;
}

export interface AlignmentResult {
  tokens: DiffToken[];
  correct: number;
  /** Right word, wrong spelling. Counted as correct, shown in yellow. */
  misspelled: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Expected word count. */
  expectedCount: number;
  /** 1 - WER, clamped to [0, 1]. Misspellings are not penalised. */
  accuracy: number;
}

/** Per-round record persisted in session history. */
export interface HistoryRound {
  clipId: string;
  split: DatasetSplit;
  level: number;
  noiseDb: number;
  accuracy: number;
  usedSlowMode: boolean;
  replays: number;
  expectedText: string;
  userText: string;
  /**
   * Dataset row index for the clip. Stored in addition to the id so the session
   * summary can re-resolve audio for its replay buttons even after a reload,
   * when runtime-discovered clips are no longer in memory.
   */
  rowIdx: number;
  /** LibriSpeech speaker id, shown in the replay list. */
  speakerId: string;
}

/** A completed 10-voice session. */
export interface SessionHistoryEntry {
  id: string;
  timestamp: string;
  startLevel: number;
  endLevel: number;
  averageAccuracy: number;
  rounds: HistoryRound[];
}

/** The single localStorage document, keyed `librispeech_vercel_cache_v1`. */
export interface CachedUserState {
  currentLevel: DifficultyLevel;
  autoLevelEnabled: boolean;
  acousticMode: AcousticMode;
  /** Scales the injected noise relative to the tier's own SNR. */
  noiseIntensity: NoiseIntensity;
  /**
   * Pitch-preserved speed used by the Slow Mode button.
   */
  slowRate: SlowRate;
  /**
   * Voices in every session and every path stage, exactly as configured.
   *
   * The session loop ends after precisely this many graded voices — never more,
   * never fewer — and every surface that mentions the count (arena header,
   * progress rail, summary, node copy) reads it from here.
   */
  voicesPerSession: number;
  /**
   * When true (the default), every time a lesson is opened its voices are drawn
   * fresh, with the seen window keeping them from repeating while fresh
   * material remains. When false, each lesson keeps one deterministic set of
   * voices — reopening it replays exactly the same clips.
   */
  randomizeLessons: boolean;
  /**
   * Re-encode cached audio to WebM/Opus so several times more clips fit in the
   * browser. Ignored on browsers that cannot encode or play it.
   */
  compressCache: boolean;
  /**
   * Synthesised interface sounds (node clicks, the completion chime, the
   * promotion sweep). Local only — nothing is downloaded or sent anywhere.
   */
  uiSounds: boolean;
  /** Duolingo-style progression map state. */
  path: PathProgress;
  consecutiveHighStreak: number;
  /**
   * Consecutive clean rounds scoring at or above the looser 85% bar.
   * Required in addition to {@link consecutiveHighStreak} so the two promotion
   * rules (90% twice, or 85% three times) can be told apart.
   */
  consecutiveLooseStreak: number;
  consecutiveLowStreak: number;
  xp: number;
  streakDays: number;
  lastActiveDate: string;
  /** Rolling window capped at 500 ids. */
  seenClipIds: string[];
  totalVoicesCompleted: number;
  overallAccuracy: number;
  cleanAccuracy: number;
  noisyAccuracy: number;
  /**
   * Voice counts behind {@link cleanAccuracy} and {@link noisyAccuracy}.
   *
   * Stored alongside the ratios so those two figures are exact arithmetic means
   * rather than a decayed approximation — the dashboard's headline comparison
   * has to be trustworthy.
   */
  cleanVoicesCompleted: number;
  noisyVoicesCompleted: number;
  slowModeUsageCount: number;
  /** Most recent 50 sessions. */
  sessionHistory: SessionHistoryEntry[];
}

/** Why the auto-leveler changed tier after a round. */
export interface LevelShift {
  direction: 'up' | 'down';
  from: DifficultyLevel;
  to: DifficultyLevel;
  reason: string;
}

/** Outcome of grading + adaptive evaluation for one round. */
export interface RoundResult {
  clip: RoundClip;
  userText: string;
  alignment: AlignmentResult;
  accuracy: number;
  usedSlowMode: boolean;
  replays: number;
  shift: LevelShift | null;
  xpGained: number;
}

/** Live status of the audio pipeline shown in the HUD. */
export interface EngineStatus {
  contextState: 'uninitialized' | 'suspended' | 'running' | 'closed';
  /** True when the analyser is fed by the real playback graph. */
  spectrumLive: boolean;
  /**
   * Non-null when the Web Audio graph could not be used — playback then runs
   * through the native media path and the visualiser shows a synthesised
   * envelope. The audio itself is always genuine LibriSpeech.
   */
  fallbackReason: string | null;
  /** Live Opus compaction figures, for the settings readout. */
  compression: { bytesSaved: number; failures: number; supported: boolean };
}
