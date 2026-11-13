import { discoverClips } from './hf';
import { MANIFEST } from './manifest';
import {
  LEVELS,
  ROUNDS_PER_SESSION,
  clampLevel,
  resolveAcousticProfile,
} from './levels';
import { canonicalTokens, countWords } from './text';
import type {
  AcousticMode,
  DatasetConfig,
  DifficultyLevel,
  HistoryRound,
  ManifestClip,
  NodeKind,
  NoiseIntensity,
  RoundClip,
} from './types';

/**
 * Non-repeating clip selection.
 *
 * A session must be able to change tier mid-flight (a learner can start on
 * Tier 1 and reach Tier 3 by voice five), so the next clip is chosen *right
 * before each round* from whatever tier is current at that moment.
 *
 * The pool per tier is the shipped manifest plus anything discovered from the
 * dataset server at runtime. A tier's seen pool is only recycled once every
 * clip in it has been completed.
 */

/** Fisher-Yates shuffle over a copy, using the supplied random source. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * FNV-1a 32-bit hash, used to turn a lesson's identity into a stable seed.
 *
 * Strings like `1-2|3|auto` (node | tier | pool mode) hash to a fixed number
 * for the lifetime of the product, so the same lesson always draws the same
 * voices — across reloads, sessions and devices.
 */
export function seedFromKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mulberry32 — a tiny deterministic PRNG.
 *
 * Seeded shuffles need a generator that is stable across engines and versions;
 * `Math.random` is neither seedable nor reproducible, so the lesson seeds drive
 * this instead.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PickResult {
  clip: RoundClip;
  /**
   * True when the tier's seen pool had to be recycled because every clip in it
   * had already been completed.
   */
  poolReset: boolean;
}

/** Merges a tier's acoustic profile onto a clip, honouring noise intensity. */
export function toRoundClip(
  clip: ManifestClip,
  level: DifficultyLevel,
  mode: AcousticMode,
  intensity: NoiseIntensity = 'standard',
): RoundClip {
  const profile = resolveAcousticProfile(level, mode, intensity);
  return {
    ...clip,
    level,
    noiseDb: profile.noise.snrDb,
    noiseKind: profile.noise.kind,
    shaped: profile.noise.shaped,
  };
}

/** Fraction of a tier's pool the boss draws from first. */
const BOSS_TOP_FRACTION = 0.4;
/** Where the boss degrades to if those run out, and no further. */
const BOSS_MID_FRACTION = 0.7;
/** The boss always keeps at least this many candidates, however small the pool. */
const BOSS_MIN_CANDIDATES = 2;

/**
 * Orders a tier's pool into preference groups, best group first.
 *
 * The boss is served from the hardest end of the sentence range; the workout
 * puts sentences containing the learner's missed words ahead of everything else,
 * then prefers longer sentences because holding a longer utterance in working
 * memory is the harder skill. Every other node type gets a flat pool.
 *
 * Returning groups rather than a single filtered list is what keeps each rule
 * advisory: if the preferred group is exhausted or empty, the next one is used
 * instead of failing the round.
 */
function rankForNode(
  pool: readonly ManifestClip[],
  nodeKind: NodeKind,
  weakWords: readonly string[],
): ManifestClip[][] {
  if (pool.length === 0) return [];

  if (nodeKind === 'boss') {
    // Ranked by count rather than by an absolute word-count cut, so the rule
    // scales from a five-clip fixture to a fifty-clip live pool. An absolute cut
    // collapses on small pools and silently serves the *easiest* sentences.
    //
    // Two preference groups, never the whole tier: if the hardest clips run out
    // mid-session the boss steps down to the upper middle rather than quietly
    // becoming an ordinary round. Falling back to everything would mean the
    // tenth voice of a "boss" could be the easiest sentence in the tier.
    const byLength = [...pool].sort((a, b) => b.wordCount - a.wordCount);
    const hardTake = Math.max(BOSS_MIN_CANDIDATES, Math.ceil(pool.length * BOSS_TOP_FRACTION));
    const midTake = Math.max(hardTake, Math.ceil(pool.length * BOSS_MID_FRACTION));
    const groups: ManifestClip[][] = [];
    const hard = byLength.slice(0, hardTake);
    if (hard.length > 0) groups.push(hard);
    if (midTake > hardTake) {
      const mid = byLength.slice(0, midTake);
      if (mid.length > hard.length) groups.push(mid);
    }
    return groups.length > 0 ? groups : [[...pool]];
  }

  if (nodeKind === 'workout') {
    const byLength = [...pool].sort((a, b) => b.wordCount - a.wordCount);
    if (weakWords.length === 0) return [byLength];
    const wanted = new Set(weakWords);
    const targeted = byLength.filter((clip) =>
      canonicalTokens(clip.text).some((token) => wanted.has(token)),
    );
    if (targeted.length === 0) return [byLength];
    const targetedIds = new Set(targeted.map((clip) => clip.id));
    return [targeted, byLength.filter((clip) => !targetedIds.has(clip.id))];
  }

  return [[...pool]];
}

/**
 * Stateful clip pool that grows from the dataset server as sessions progress.
 */
export class ClipPool {
  /** Clips discovered at runtime, bucketed by the tier that requested them. */
  private readonly discovered = new Map<DifficultyLevel, ManifestClip[]>();

  /** True while a background discovery request is in flight for a tier. */
  private readonly inFlight = new Set<DifficultyLevel>();

  constructor(base: readonly ManifestClip[] = MANIFEST) {
    this.base = [...base];
  }

  private base: ManifestClip[];

  /**
   * Merges more clips into the corpus.
   *
   * Used when the full manifest arrives from `/manifest.json` after the app has
   * already started on the bundled core, so the pool deepens without a reload.
   */
  addBase(clips: readonly ManifestClip[]): number {
    const known = new Set(this.base.map((clip) => clip.id));
    let added = 0;
    for (const clip of clips) {
      if (known.has(clip.id)) continue;
      known.add(clip.id);
      this.base.push(clip);
      added += 1;
    }
    return added;
  }

  /** Every clip the app knows about, deduplicated and shipped manifest first. */
  allClips(): ManifestClip[] {
    const byId = new Map<string, ManifestClip>();
    for (const clip of this.base) byId.set(clip.id, clip);
    for (const bucket of this.discovered.values()) {
      for (const clip of bucket) if (!byId.has(clip.id)) byId.set(clip.id, clip);
    }
    return [...byId.values()];
  }

  /**
   * The pool that serves a tier.
   *
   * The corpus config is a *hard* constraint: `clean_only` must never hand out
   * an OTHER clip, and the noisy tiers must never quietly fall back to studio
   * audio. The tier's word range is a *soft* preference — when the requested
   * corpus has nothing in range (for example Clean Only on Tier 5, whose range
   * starts at 16 words), shorter or longer clips from the same corpus are far
   * better than silently ignoring the learner's choice.
   */
  clipsFor(level: DifficultyLevel, mode: AcousticMode = 'auto'): ManifestClip[] {
    const profile = resolveAcousticProfile(level, mode);
    const tier = LEVELS[level];
    const sameConfig = this.allClips().filter((clip) => clip.config === profile.config);
    const inRange = sameConfig.filter(
      (clip) => clip.wordCount >= tier.wordRange[0] && clip.wordCount <= tier.wordRange[1],
    );
    return inRange.length > 0 ? inRange : sameConfig;
  }

  /** Number of clips known for a tier, used by the dashboard. */
  poolSize(level: DifficultyLevel, mode: AcousticMode = 'auto'): number {
    return this.clipsFor(level, mode).length;
  }

  /**
   * Draws the next clip for a tier.
   *
   * `exclude` is the set whose ids are skipped while unseen material remains.
   * In the playful default mode that is the union of the persisted seen window
   * and the running session; when a `seed` is supplied the caller passes only
   * the running session, because a seeded draw must not depend on state that
   * changes outside the lesson (see {@link seedFromKey}).
   */
  pick(params: {
    level: DifficultyLevel;
    mode: AcousticMode;
    exclude: ReadonlySet<string>;
    random?: () => number;
    /**
     * Deterministic mode: a stable number that makes this draw a pure function
     * of the pool, the grouping and `exclude`. The same seed replays the same
     * voices for the same lesson, so reopening a node never re-rolls its set.
     */
    seed?: number;
    /** Node type driving the draw; defaults to a plain adaptive round. */
    nodeKind?: NodeKind;
    /** Words the learner has repeatedly missed, for the workout node. */
    weakWords?: readonly string[];
    /** Scales the injected noise bed. */
    intensity?: NoiseIntensity;
  }): PickResult | null {
    const {
      level,
      mode,
      exclude,
      random,
      seed,
      nodeKind = 'intro',
      weakWords = [],
      intensity = 'standard',
    } = params;

    // A seed takes precedence over any injected RNG: the two modes are
    // alternatives of the same mechanism, not layers of it.
    const rng = seed !== undefined ? mulberry32(seed) : random;

    const pool = this.clipsFor(level, mode);
    if (pool.length === 0) return null;

    const groups = rankForNode(pool, nodeKind, weakWords);
    for (const group of groups) {
      const fresh = group.filter((clip) => !exclude.has(clip.id));
      if (fresh.length === 0) continue;
      const [first] = shuffle(fresh, rng);
      if (first) return { clip: toRoundClip(first, level, mode, intensity), poolReset: false };
    }

    // Every clip in every preference group has been heard: recycle the tier.
    const widest = groups[groups.length - 1] ?? pool;
    const [first] = shuffle(widest, random);
    return first ? { clip: toRoundClip(first, level, mode, intensity), poolReset: true } : null;
  }

  /**
   * Grows a tier's pool from the dataset server in the background.
   *
   * Deliberately fire-and-forget: a failure only means the tier keeps using the
   * shipped manifest, which is always enough to run a full session.
   */
  async grow(
    level: DifficultyLevel,
    mode: AcousticMode = 'auto',
    exclude: ReadonlySet<string> = new Set(),
    desired = 40,
  ): Promise<number> {
    if (this.inFlight.has(level)) return 0;
    const profile = resolveAcousticProfile(level, mode);
    const tier = LEVELS[level];
    const known = new Set(this.clipsFor(level, mode).map((clip) => clip.id));
    if (known.size >= desired) return 0;

    this.inFlight.add(level);
    try {
      const splits: ('test' | 'validation')[] = ['test', 'validation'];
      let added = 0;
      for (const split of splits) {
        const found = await discoverClips({
          config: profile.config,
          split,
          level,
          minWords: tier.wordRange[0],
          maxWords: tier.wordRange[1],
          exclude: new Set([...known, ...exclude]),
          desired: desired - known.size - added,
        });
        if (found.length === 0) continue;
        const bucket = this.discovered.get(level) ?? [];
        for (const clip of found) {
          if (known.has(clip.id)) continue;
          known.add(clip.id);
          bucket.push(clip);
          added += 1;
        }
        this.discovered.set(level, bucket);
        if (known.size >= desired) break;
      }
      return added;
    } catch {
      return 0;
    } finally {
      this.inFlight.delete(level);
    }
  }
}

/** Summary of one session's rounds, built as the learner progresses. */
export function sessionAccuracy(accuracies: readonly number[]): number {
  if (accuracies.length === 0) return 0;
  return accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length;
}

/**
 * True when the round at `roundIndex` (0-based) is the session's final voice.
 *
 * The one place the "exactly N voices" rule is decided, so the arena, the
 * header copy and the completion check can never disagree about whether a
 * session still owes voices.
 */
export function isFinalRound(roundIndex: number, totalRounds: number): boolean {
  return roundIndex + 1 >= totalRounds;
}

export { ROUNDS_PER_SESSION };

/** Fresh id for a session record, without pulling in a uuid dependency. */
export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Rebuilds a playable clip from a persisted history round.
 *
 * The summary's replay buttons must work after a page reload, when clips that
 * were discovered at runtime no longer exist in memory. `rowIdx` is persisted
 * precisely so the audio can be re-signed from the dataset server.
 *
 * Noise character is derivable rather than stored: no noise means none, Tier 5
 * is the crowd bed, and everything else is the room bed.
 */
export function rebuildClipFromHistory(round: HistoryRound): RoundClip {
  const config: DatasetConfig = round.split.endsWith('clean') ? 'clean' : 'other';
  const split: 'test' | 'validation' = round.split.startsWith('dev') ? 'validation' : 'test';
  const hasNoise = round.noiseDb > 0;
  const level = clampLevel(round.level);

  return {
    id: round.clipId,
    text: round.expectedText,
    speakerId: round.speakerId,
    chapterId: '',
    config,
    split,
    splitLabel: round.split,
    rowIdx: round.rowIdx,
    level,
    wordCount: countWords(round.expectedText),
    speakerMinutes: 0,
    index: 0,
    noiseDb: hasNoise ? round.noiseDb : null,
    noiseKind: hasNoise ? (level === 5 ? 'crowd' : 'room') : 'none',
    shaped: hasNoise && level === 5,
  };
}
