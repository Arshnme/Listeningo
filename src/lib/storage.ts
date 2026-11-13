import { emptyPathProgress } from './path';
import { SLOW_RATES, ROUNDS_PER_SESSION, clampLevel as clampTier, clampVoicesPerSession } from './levels';
import type {
  AcousticMode,
  CachedUserState,
  DifficultyLevel,
  NodeProgress,
  NoiseIntensity,
  PathProgress,
  SessionHistoryEntry,
  SlowRate,
} from './types';

export const CACHE_KEY = 'librispeech_vercel_cache_v1';

/** Rolling window of recently heard clip ids, per spec. */
export const SEEN_CLIP_CAP = 500;
/** Most recent sessions retained, per spec. */
export const SESSION_HISTORY_CAP = 50;

export function defaultState(): CachedUserState {
  return {
    currentLevel: 1,
    autoLevelEnabled: true,
    acousticMode: 'auto',
    noiseIntensity: 'standard',
    slowRate: 0.75,
    voicesPerSession: ROUNDS_PER_SESSION,
    randomizeLessons: true,
    compressCache: true,
    uiSounds: true,
    path: emptyPathProgress(),
    consecutiveHighStreak: 0,
    consecutiveLooseStreak: 0,
    consecutiveLowStreak: 0,
    xp: 0,
    streakDays: 0,
    lastActiveDate: '',
    seenClipIds: [],
    totalVoicesCompleted: 0,
    overallAccuracy: 0,
    cleanAccuracy: 0,
    noisyAccuracy: 0,
    cleanVoicesCompleted: 0,
    noisyVoicesCompleted: 0,
    slowModeUsageCount: 0,
    sessionHistory: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function clampLevel(value: unknown): DifficultyLevel {
  return num(value, 1, 1, 5) as DifficultyLevel;
}

function parseAcousticMode(value: unknown): AcousticMode {
  return value === 'clean_only' || value === 'noisy_forced' || value === 'auto' ? value : 'auto';
}

function parseNoiseIntensity(value: unknown): NoiseIntensity {
  return value === 'boosted' || value === 'muted' || value === 'standard' ? value : 'standard';
}

function parseSlowRate(value: unknown): SlowRate {
  const parsed = Number(value);
  // Accepts anything in the published ladder; a stale or hand-edited document
  // falls back to the default rather than producing an unusable speed.
  return (SLOW_RATES as readonly number[]).includes(parsed) ? (parsed as SlowRate) : 0.75;
}

/**
 * Coerces persisted path state.
 *
 * Keyed records are rebuilt key by key rather than trusted wholesale, so a
 * hand-edited or half-written cache degrades to "node not attempted" instead of
 * throwing during hydration.
 */
function parsePath(value: unknown): PathProgress {
  const base = emptyPathProgress();
  if (!isRecord(value)) return base;

  const nodes: Record<string, NodeProgress> = {};
  if (isRecord(value.nodes)) {
    for (const [key, entry] of Object.entries(value.nodes)) {
      if (!/^[1-5]-[1-5]$/.test(key) || !isRecord(entry)) continue;
      nodes[key] = {
        stars: num(entry.stars, 0, 0, 3),
        bestAccuracy: num(entry.bestAccuracy, 0, 0, 1),
        completedAt: str(entry.completedAt),
        attempts: num(entry.attempts, 0, 0, 100_000),
      };
    }
  }

  const keys = (input: unknown, pattern: RegExp): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string' && pattern.test(item))
      : [];

  return {
    nodes,
    chestsOpened: keys(value.chestsOpened, /^[1-5]-[1-5]$/),
    badges: keys(value.badges, /^tier-[1-5]-(mastery|crown)$/),
    fastTrackTier: clampTier(num(value.fastTrackTier, 1, 1, 5)),
  };
}

function parseRounds(value: unknown): SessionHistoryEntry['rounds'] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((raw) => {
    const round = isRecord(raw) ? raw : {};
    const split = str(round.split, 'test-clean');
    return {
      clipId: str(round.clipId),
      split: (split === 'test-other' || split === 'dev-other' || split === 'dev-clean'
        ? split
        : 'test-clean') as SessionHistoryEntry['rounds'][number]['split'],
      level: num(round.level, 1, 1, 5),
      noiseDb: num(round.noiseDb, 0, -20, 60),
      accuracy: num(round.accuracy, 0, 0, 1),
      usedSlowMode: bool(round.usedSlowMode, false),
      replays: num(round.replays, 0, 0, 999),
      expectedText: str(round.expectedText),
      userText: str(round.userText),
      rowIdx: num(round.rowIdx, -1, -1, Number.MAX_SAFE_INTEGER),
      speakerId: str(round.speakerId),
    };
  });
}

function parseHistory(value: unknown): SessionHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-SESSION_HISTORY_CAP).map((raw, index) => {
    const entry = isRecord(raw) ? raw : {};
    return {
      id: str(entry.id, `legacy-${index}`),
      timestamp: str(entry.timestamp),
      startLevel: num(entry.startLevel, 1, 1, 5),
      endLevel: num(entry.endLevel, 1, 1, 5),
      averageAccuracy: num(entry.averageAccuracy, 0, 0, 1),
      rounds: parseRounds(entry.rounds),
    };
  });
}

function parseSeen(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string');
  // Keep the most recent entries when the stored list exceeds the cap.
  return ids.slice(-SEEN_CLIP_CAP);
}

/**
 * Coerces arbitrary persisted JSON into a valid state object.
 *
 * Anything malformed falls back to its default, so a partially written or
 * hand-edited cache can never crash the app on hydration.
 */
export function parseState(raw: unknown): CachedUserState {
  const base = defaultState();
  if (!isRecord(raw)) return base;
  return {
    currentLevel: clampLevel(raw.currentLevel),
    autoLevelEnabled: bool(raw.autoLevelEnabled, base.autoLevelEnabled),
    acousticMode: parseAcousticMode(raw.acousticMode),
    noiseIntensity: parseNoiseIntensity(raw.noiseIntensity),
    slowRate: parseSlowRate(raw.slowRate),
    voicesPerSession: clampVoicesPerSession(raw.voicesPerSession),
    randomizeLessons: bool(raw.randomizeLessons, base.randomizeLessons),
    compressCache: bool(raw.compressCache, base.compressCache),
    uiSounds: bool(raw.uiSounds, base.uiSounds),
    path: parsePath(raw.path),
    consecutiveHighStreak: num(raw.consecutiveHighStreak, 0, 0, 999),
    consecutiveLooseStreak: num(raw.consecutiveLooseStreak, 0, 0, 999),
    consecutiveLowStreak: num(raw.consecutiveLowStreak, 0, 0, 999),
    xp: num(raw.xp, 0, 0, 100_000_000),
    streakDays: num(raw.streakDays, 0, 0, 100_000),
    lastActiveDate: str(raw.lastActiveDate),
    seenClipIds: parseSeen(raw.seenClipIds),
    totalVoicesCompleted: num(raw.totalVoicesCompleted, 0, 0, 100_000_000),
    overallAccuracy: num(raw.overallAccuracy, 0, 0, 1),
    cleanAccuracy: num(raw.cleanAccuracy, 0, 0, 1),
    noisyAccuracy: num(raw.noisyAccuracy, 0, 0, 1),
    cleanVoicesCompleted: num(raw.cleanVoicesCompleted, 0, 0, 100_000_000),
    noisyVoicesCompleted: num(raw.noisyVoicesCompleted, 0, 0, 100_000_000),
    slowModeUsageCount: num(raw.slowModeUsageCount, 0, 0, 100_000_000),
    sessionHistory: parseHistory(raw.sessionHistory),
  };
}

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Reads and validates the cache. Returns null when nothing is stored yet. */
export function loadState(): CachedUserState | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return parseState(JSON.parse(raw) as unknown);
  } catch {
    // Corrupt JSON: drop it rather than wedging the app.
    try {
      window.localStorage.removeItem(CACHE_KEY);
    } catch {
      /* storage unavailable - nothing further to do */
    }
    return null;
  }
}

export interface SaveOutcome {
  ok: boolean;
  /** Serialised size in bytes of the document that was eventually written. */
  bytes: number;
  /** True when the state had to be trimmed to fit the storage quota. */
  pruned: boolean;
  /**
   * The state that actually reached storage. When pruning kicked in this is
   * smaller than the input, and callers should adopt it so memory and disk do
   * not drift apart.
   */
  persisted: CachedUserState;
}

/**
 * Writes the cache, shrinking it on `QuotaExceededError`.
 *
 * Progressive fallback: halve the seen-clip window, then drop session history in
 * thirds, then give up on history entirely. The newest data always survives.
 */
export function saveState(state: CachedUserState): SaveOutcome {
  if (!isBrowser()) return { ok: false, bytes: 0, pruned: false, persisted: state };

  const attempts: CachedUserState[] = [
    state,
    { ...state, seenClipIds: state.seenClipIds.slice(-Math.floor(SEEN_CLIP_CAP / 2)) },
    {
      ...state,
      seenClipIds: state.seenClipIds.slice(-Math.floor(SEEN_CLIP_CAP / 4)),
      sessionHistory: state.sessionHistory.slice(-Math.floor(SESSION_HISTORY_CAP / 3)),
    },
    { ...state, seenClipIds: [], sessionHistory: [] },
  ];

  let pruned = false;
  let bytes = 0;
  for (let index = 0; index < attempts.length; index += 1) {
    const candidate = attempts[index];
    if (!candidate) continue;
    const serialised = JSON.stringify(candidate);
    bytes = serialised.length;
    try {
      window.localStorage.setItem(CACHE_KEY, serialised);
      return { ok: true, bytes, pruned: pruned || index > 0, persisted: candidate };
    } catch (error) {
      const isQuota =
        error instanceof DOMException &&
        (error.name === 'QuotaExceededError' ||
          error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
          error.code === 22);
      if (!isQuota) return { ok: false, bytes, pruned, persisted: state };
      pruned = true;
    }
  }
  return { ok: false, bytes, pruned, persisted: state };
}

export function clearState(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable - nothing further to do */
  }
}

/**
 * Appends a clip id to the rolling seen window, dropping the oldest entries so
 * the list never grows past {@link SEEN_CLIP_CAP}.
 */
export function pushSeenClip(state: CachedUserState, clipId: string): CachedUserState {
  if (state.seenClipIds.includes(clipId)) return state;
  const next = [...state.seenClipIds, clipId];
  return {
    ...state,
    seenClipIds: next.length > SEEN_CLIP_CAP ? next.slice(-SEEN_CLIP_CAP) : next,
  };
}

/** Clears the seen pool for one tier so its clips become available again. */
export function resetSeenForTier(state: CachedUserState, clipIds: readonly string[]): CachedUserState {
  const remove = new Set(clipIds);
  return { ...state, seenClipIds: state.seenClipIds.filter((id) => !remove.has(id)) };
}

/** Local calendar day string (`YYYY-MM-DD`) used for streak tracking. */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Drops the session history while keeping path progress, badges, streak and XP.
 *
 * Deliberately narrower than a full reset: the dashboard's trash icon clears the
 * history list, and wiping a learner's whole progression from a list control
 * would be a nasty surprise.
 */
export function clearHistory(state: CachedUserState): CachedUserState {
  if (state.sessionHistory.length === 0) return state;
  return { ...state, sessionHistory: [] };
}

/** Pretty-printed progress export, for the Settings backup control. */
export function exportState(state: CachedUserState): string {
  return JSON.stringify({ key: CACHE_KEY, exportedAt: new Date().toISOString(), state }, null, 2);
}

export interface ImportResult {
  ok: boolean;
  state?: CachedUserState;
  error?: string;
}

/**
 * Restores a progress export.
 *
 * Accepts either the wrapped `{ key, state }` envelope this module produces or a
 * bare state document, and runs the full validator over whatever it finds so an
 * edited or truncated file cannot inject an unusable state.
 */
export function importState(json: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }

  const envelope = isRecord(parsed) ? parsed : {};
  const candidate = 'state' in envelope ? envelope.state : parsed;
  if (!isRecord(candidate)) {
    return { ok: false, error: 'The file does not contain an exported progress document.' };
  }
  // A document with none of our fields is almost certainly the wrong file.
  const known = ['currentLevel', 'totalVoicesCompleted', 'path', 'sessionHistory', 'seenClipIds'];
  if (!known.some((field) => field in candidate)) {
    return { ok: false, error: 'The file does not look like listening progress.' };
  }

  return { ok: true, state: parseState(candidate) };
}

/** Serialised size of a state document, for the Settings cache readout. */
export function stateBytes(state: CachedUserState): number {
  return JSON.stringify(state).length;
}

/**
 * Advances the daily streak. Consecutive days increment, a same-day return is a
 * no-op, and a gap resets to 1.
 */
export function advanceStreak(state: CachedUserState, today: string): CachedUserState {
  if (!state.lastActiveDate) {
    return { ...state, streakDays: 1, lastActiveDate: today };
  }
  if (state.lastActiveDate === today) return state;

  const previous = new Date(`${state.lastActiveDate}T00:00:00`);
  const current = new Date(`${today}T00:00:00`);
  const dayMs = 24 * 60 * 60 * 1000;
  const gapDays = Math.round((current.getTime() - previous.getTime()) / dayMs);
  return {
    ...state,
    streakDays: gapDays === 1 ? state.streakDays + 1 : 1,
    lastActiveDate: today,
  };
}

/**
 * Folds one completed voice into the running aggregates.
 *
 * A voice counts as "noisy" when the learner had to cope with the OTHER split
 * or with an injected noise bed — that is what the dashboard comparison means.
 */
export function recordVoice(
  state: CachedUserState,
  params: { accuracy: number; isNoisy: boolean; usedSlowMode: boolean; xp: number },
): CachedUserState {
  const total = state.totalVoicesCompleted + 1;
  const overallAccuracy = (state.overallAccuracy * state.totalVoicesCompleted + params.accuracy) / total;

  const cleanCount = state.cleanVoicesCompleted + (params.isNoisy ? 0 : 1);
  const noisyCount = state.noisyVoicesCompleted + (params.isNoisy ? 1 : 0);
  const cleanAccuracy = params.isNoisy
    ? state.cleanAccuracy
    : (state.cleanAccuracy * state.cleanVoicesCompleted + params.accuracy) / Math.max(1, cleanCount);
  const noisyAccuracy = params.isNoisy
    ? (state.noisyAccuracy * state.noisyVoicesCompleted + params.accuracy) / Math.max(1, noisyCount)
    : state.noisyAccuracy;

  return {
    ...state,
    totalVoicesCompleted: total,
    overallAccuracy,
    cleanVoicesCompleted: cleanCount,
    noisyVoicesCompleted: noisyCount,
    cleanAccuracy,
    noisyAccuracy,
    slowModeUsageCount: state.slowModeUsageCount + (params.usedSlowMode ? 1 : 0),
    xp: state.xp + params.xp,
  };
}

/** Appends a finished session, keeping only the most recent window. */
export function appendSession(state: CachedUserState, entry: SessionHistoryEntry): CachedUserState {
  const next = [...state.sessionHistory, entry];
  return {
    ...state,
    sessionHistory: next.length > SESSION_HISTORY_CAP ? next.slice(-SESSION_HISTORY_CAP) : next,
  };
}
