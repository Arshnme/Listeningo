import { LEVELS, LEVEL_NUMBERS } from './levels';
import { scoreTranscript } from './scoring';
import type {
  DifficultyLevel,
  NodeKind,
  NodeProgress,
  PathNodeRef,
  PathProgress,
  SessionHistoryEntry,
} from './types';

/**
 * The Duolingo-style progression map, as pure data and pure functions.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a DOM: node definitions, unlock rules, star rating and the
 * weak-word extraction that drives the targeted workout node.
 */

export interface NodeDefinition {
  kind: NodeKind;
  /** 1-5 */
  slot: number;
  title: string;
  /** One line shown in the node tooltip and the guidebook. */
  blurb: string;
  /** Reward chests are claimed by tapping rather than by listening. */
  isReward: boolean;
}

/**
 * Ten node slots, identical in shape for every tier.
 *
 * Five sections × ten nodes = fifty lessons over the 4,491-voice corpus. The
 * first five slots keep their original meanings exactly (a saved profile's
 * progress, badges and chest claims carry over untouched); slots 6–10 extend
 * the unit with a second practice arc, a second workout, a second chest and the
 * tier's true final boss.
 */
export const NODE_SLOTS: readonly NodeDefinition[] = [
  {
    kind: 'intro',
    slot: 1,
    title: 'Adaptive Session',
    blurb: 'A standard {voices}-voice session with the live auto-level engine running.',
    isReward: false,
  },
  {
    kind: 'practice',
    slot: 2,
    title: 'Core Practice',
    blurb: '{voices} more voices from this tier, mixing sentence lengths across the range.',
    isReward: false,
  },
  {
    kind: 'workout',
    slot: 3,
    title: 'Mastery Workout',
    blurb:
      '{voices} longer voices weighted toward words you have previously missed, training the exact vocabulary your ear is weakest on.',
    isReward: false,
  },
  {
    kind: 'reward',
    slot: 4,
    title: 'Milestone Reward',
    blurb: 'A milestone marker on the path. Tap to claim bonus XP and this tier’s Audio Mastery badge.',
    isReward: true,
  },
  {
    kind: 'boss',
    slot: 5,
    title: 'Tier Boss',
    blurb:
      '{voices} voices drawn from the hardest end of this tier’s sentence range. Complete it to earn the Tier Crown.',
    isReward: false,
  },
  {
    kind: 'practice',
    slot: 6,
    title: 'Extension Practice',
    blurb: '{voices} more voices from this tier, drawn across its whole sentence range.',
    isReward: false,
  },
  {
    kind: 'workout',
    slot: 7,
    title: 'Mastery Workout II',
    blurb:
      '{voices} longer voices on a second pass through the words you keep missing, so a weakness met once is met again.',
    isReward: false,
  },
  {
    kind: 'reward',
    slot: 8,
    title: 'Second Milestone',
    blurb: 'A second milestone marker. Tap to claim more bonus XP for this tier.',
    isReward: true,
  },
  {
    kind: 'workout',
    slot: 9,
    title: 'Boss Preparation',
    blurb:
      '{voices} voices re-ranked toward your missed words, longer sentences first — the last warm-up before the final boss.',
    isReward: false,
  },
  {
    kind: 'boss',
    slot: 10,
    title: 'Final Boss',
    blurb:
      '{voices} voices drawn from the hardest end of this tier’s range. Clear every listening node to face it.',
    isReward: false,
  },
];

/**
 * Renders a node's blurb with the learner's configured session length.
 *
 * The count is a setting, not a constant, so every place that describes a node
 * (the guidebook today) reads the real number rather than a frozen "ten".
 */
export function nodeBlurb(definition: NodeDefinition, voices: number): string {
  return definition.blurb.replace('{voices}', String(voices));
}

/**
 * Star thresholds: 70%, 85%, 90%.
 *
 * Deliberately the same numbers the adaptive engine already uses — 85% is its
 * loose-mastery bar and 90% its mastery bar — so a three-star node means exactly
 * what a promotion means, rather than introducing a second definition of "good".
 */
export const STAR_THRESHOLDS = [0.7, 0.85, 0.9] as const;

export interface SectionDefinition {
  tier: DifficultyLevel;
  /** e.g. `SECTION 1, UNIT 1` */
  label: string;
  title: string;
  subtitle: string;
}

/** Section banners shown sticky above each tier's nodes. */
export const SECTIONS: readonly SectionDefinition[] = [
  {
    tier: 1,
    label: 'Section 1, Unit 1',
    title: 'Studio Clean Foundations',
    subtitle: 'Short studio sentences with crisp articulation and no added noise.',
  },
  {
    tier: 2,
    label: 'Section 2, Unit 2',
    title: 'Natural Flow',
    subtitle: 'Longer studio sentences at a natural speaking cadence.',
  },
  {
    tier: 3,
    label: 'Section 3, Unit 3',
    title: 'Accented Raw Speech',
    subtitle: 'The OTHER split: accented speakers and non-studio room acoustics.',
  },
  {
    tier: 4,
    label: 'Section 4, Unit 4',
    title: 'Noisy Environment',
    subtitle: 'A synthesised room-noise bed at 16 dB SNR over challenging speech.',
  },
  {
    tier: 5,
    label: 'Section 5, Unit 5',
    title: 'Extreme Acoustic Mastery',
    subtitle: 'Crowd murmur, rumble and static at 10 dB SNR with acoustic shaping.',
  },
];

export function nodeKey(tier: number, slot: number): string {
  return `${tier}-${slot}`;
}

export function parseNodeKey(key: string): PathNodeRef | null {
  const match = /^([1-5])-([1-5])$/.exec(key);
  if (!match) return null;
  return { tier: Number(match[1]) as DifficultyLevel, slot: Number(match[2]) };
}

export function nodeDefinition(slot: number): NodeDefinition {
  return NODE_SLOTS[Math.max(0, Math.min(NODE_SLOTS.length - 1, slot - 1))] as NodeDefinition;
}

/** Every node on the path, in reading order. */
export const ALL_NODE_REFS: readonly PathNodeRef[] = LEVEL_NUMBERS.flatMap((tier) =>
  NODE_SLOTS.map((slot) => ({ tier, slot: slot.slot })),
);

export function emptyPathProgress(): PathProgress {
  return { nodes: {}, chestsOpened: [], badges: [], fastTrackTier: 1 };
}

export function progressFor(path: PathProgress, tier: number, slot: number): NodeProgress | undefined {
  return path.nodes[nodeKey(tier, slot)];
}

/** Stars for a session accuracy, 0 when below the lowest threshold. */
export function starsFor(accuracy: number): number {
  let stars = 0;
  for (const threshold of STAR_THRESHOLDS) {
    if (accuracy >= threshold) stars += 1;
  }
  return stars;
}

/**
 * True only when a node has actually been *cleared*.
 *
 * A failed attempt still writes a record (so the UI can show the try count and
 * the best score so far), which means presence alone is not enough — `completedAt`
 * is stamped exclusively on a clear.
 */
export function isCompleted(path: PathProgress, tier: number, slot: number): boolean {
  const progress = progressFor(path, tier, slot);
  return Boolean(progress && progress.completedAt !== '');
}

export function isChestClaimed(path: PathProgress, tier: number, slot: number): boolean {
  return path.chestsOpened.includes(nodeKey(tier, slot));
}

/**
 * A tier becomes accessible when the previous tier's workout node (slot 3) is
 * cleared, or when the live engine demonstrated mastery and fast-tracked it.
 *
 * Gating on the workout rather than the boss keeps the path forgiving: the boss
 * and reward nodes stay available as optional content in a tier you can already
 * move past, and a learner who is flying is not made to grind.
 */
export function isTierAccessible(path: PathProgress, tier: DifficultyLevel): boolean {
  if (tier === 1) return true;
  if (tier <= path.fastTrackTier) return true;
  return isCompleted(path, tier - 1, 3);
}

/** The reason a tier is still locked, for the lock tooltip. */
export function tierLockReason(path: PathProgress, tier: DifficultyLevel): string {
  const previous = LEVELS[(tier - 1) as DifficultyLevel];
  return `Finish the Mastery Workout in ${previous.name} to unlock ${LEVELS[tier].name}.`;
}

/**
 * Node availability: sequential inside a tier, and the tier itself must be
 * accessible. A boss node is the tier's climax — it needs every non-reward node
 * before it (for the first boss that is exactly slots 1–3, unchanged from the
 * original five-slot map). Reward chests are never required — they are a detour
 * the learner can skip.
 */
export function isNodeUnlocked(path: PathProgress, tier: DifficultyLevel, slot: number): boolean {
  if (!isTierAccessible(path, tier)) return false;
  if (slot === 1) return true;
  if (nodeDefinition(slot).kind === 'boss') {
    return NODE_SLOTS.filter((candidate) => candidate.slot < slot && !candidate.isReward).every(
      (candidate) => isCompleted(path, tier, candidate.slot),
    );
  }
  return isCompleted(path, tier, slot - 1);
}

/** The first unlocked node that has not been cleared: where the START pill sits. */
export function activeNode(path: PathProgress): PathNodeRef | null {
  for (const ref of ALL_NODE_REFS) {
    const definition = nodeDefinition(ref.slot);
    if (!isNodeUnlocked(path, ref.tier, ref.slot)) continue;
    if (definition.isReward) {
      // A reward node stops being "active" once claimed; it never blocks.
      if (!isChestClaimed(path, ref.tier, ref.slot)) return ref;
      continue;
    }
    if (!isCompleted(path, ref.tier, ref.slot)) return ref;
  }
  return null;
}

/**
 * Explains why one specific node cannot be played yet.
 *
 * Two distinct causes: the whole section is still closed, or the section is open
 * but this node sits behind an earlier one.
 */
export function nodeLockReason(path: PathProgress, tier: DifficultyLevel, slot: number): string {
  // Total by construction: an available node has no reason to give, so the
  // caller never has to guard against a misleading message.
  if (isNodeUnlocked(path, tier, slot)) return '';
  if (!isTierAccessible(path, tier)) return tierLockReason(path, tier);
  if (nodeDefinition(slot).kind === 'boss') {
    // Reachable only while the boss is genuinely gated, so the missing list is
    // never empty here. Reward chests are excluded: they are never a gate.
    const missing = NODE_SLOTS.filter(
      (candidate) =>
        candidate.slot < slot && !candidate.isReward && !isCompleted(path, tier, candidate.slot),
    );
    const titles = missing.map((candidate) => candidate.title).join(', ');
    return `Clear ${titles} in ${LEVELS[tier].name} to open the ${nodeDefinition(slot).title}.`;
  }
  return `Clear ${nodeDefinition(Math.max(1, slot - 1)).title} first.`;
}

/** How many nodes of a tier carry a star, used for the section header badge. */
export function tierStarCount(path: PathProgress, tier: DifficultyLevel): number {
  return NODE_SLOTS.reduce((sum, slot) => sum + (progressFor(path, tier, slot.slot)?.stars ?? 0), 0);
}

export function tierCompletedCount(path: PathProgress, tier: DifficultyLevel): number {
  return NODE_SLOTS.filter((slot) => {
    if (slot.isReward) return isChestClaimed(path, tier, slot.slot);
    return isCompleted(path, tier, slot.slot);
  }).length;
}

/** Total stars earned across the whole path (maximum 150). */
export function totalStars(path: PathProgress): number {
  return Object.values(path.nodes).reduce((sum, node) => sum + (node.stars ?? 0), 0);
}

/** Best stars earned in a tier, for the section header. */
export function tierBestStars(path: PathProgress, tier: DifficultyLevel): number {
  return NODE_SLOTS.reduce(
    (best, slot) => Math.max(best, progressFor(path, tier, slot.slot)?.stars ?? 0),
    0,
  );
}

/** Badge identifiers. */
export function masteryBadge(tier: number): string {
  return `tier-${tier}-mastery`;
}

export function crownBadge(tier: number): string {
  return `tier-${tier}-crown`;
}

/** Bonus XP for claiming a reward chest, scaling with tier. */
export function chestXp(tier: number): number {
  return 50 * tier;
}

export interface TierUpdateResult {
  path: PathProgress;
  /** True when this result newly cleared the node. */
  cleared: boolean;
  stars: number;
  /** Nodes unlocked as a direct consequence. */
  unlocked: PathNodeRef[];
}

/**
 * Folds a finished session into the path.
 *
 * **Finishing a node is what unlocks the next one, whatever the score.** Accuracy
 * decides how many stars the node earns, not whether it opens: a learner who sits
 * through every voice in the session has done the work, and gating the map on a
 * score they cannot yet reach turns practice into a wall.
 *
 * A later, better run raises the stars and the recorded best, and does not
 * re-stamp `completedAt` - the completion date is when the node was opened.
 */
export function applySessionToNode(
  path: PathProgress,
  ref: PathNodeRef,
  averageAccuracy: number,
): TierUpdateResult {
  const definition = nodeDefinition(ref.slot);
  const key = nodeKey(ref.tier, ref.slot);
  const previous = path.nodes[key];
  const stars = starsFor(averageAccuracy);

  const wasComplete = Boolean(previous);
  const before = ALL_NODE_REFS.filter((candidate) => isNodeUnlocked(path, candidate.tier, candidate.slot));

  const nextNodes = { ...path.nodes };
  nextNodes[key] = {
    stars: Math.max(previous?.stars ?? 0, stars),
    bestAccuracy: Math.max(previous?.bestAccuracy ?? 0, averageAccuracy),
    completedAt: previous?.completedAt ?? new Date().toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
  };

  const intermediate: PathProgress = { ...path, nodes: nextNodes };
  const after = ALL_NODE_REFS.filter((candidate) => isNodeUnlocked(intermediate, candidate.tier, candidate.slot));
  const beforeKeys = new Set(before.map((item) => nodeKey(item.tier, item.slot)));
  const unlocked = after.filter((item) => !beforeKeys.has(nodeKey(item.tier, item.slot)));

  // Completing the boss earns the tier crown, at any score: the crown marks the
  // tier being finished, not a grade.
  const badges = [...path.badges];
  if (definition.kind === 'boss' && !badges.includes(crownBadge(ref.tier))) {
    badges.push(crownBadge(ref.tier));
  }

  return {
    path: { ...intermediate, badges },
    // `cleared` means *this run* is what opened the node, which is what the
    // summary reports; a replay reports false while still raising stars.
    cleared: !wasComplete,
    stars,
    unlocked,
  };
}

/** Claims a reward chest, returning bonus XP and any newly granted badge. */
export function claimChest(
  path: PathProgress,
  tier: DifficultyLevel,
  slot: number,
): { path: PathProgress; xp: number; badge: string | null; alreadyClaimed: boolean } {
  const key = nodeKey(tier, slot);
  if (path.chestsOpened.includes(key)) {
    return { path, xp: 0, badge: null, alreadyClaimed: true };
  }
  const badge = masteryBadge(tier);
  return {
    path: {
      ...path,
      chestsOpened: [...path.chestsOpened, key],
      badges: path.badges.includes(badge) ? path.badges : [...path.badges, badge],
    },
    xp: chestXp(tier),
    badge,
    alreadyClaimed: false,
  };
}

/** Raises the fast-track marker when the live engine promotes past it. */
export function raiseFastTrack(path: PathProgress, tier: DifficultyLevel): PathProgress {
  if (tier <= path.fastTrackTier) return path;
  return { ...path, fastTrackTier: tier };
}

/**
 * Words the learner has repeatedly misheard, newest sessions weighted first.
 *
 * Rebuilt from the persisted session history by re-running the same alignment
 * the round used, so it needs no extra stored state. Only the most recent
 * sessions are scanned to bound the work; a word must be missed more than once
 * to qualify, which keeps one-off slips out of the workout.
 */
export function extractWeakWords(
  history: readonly SessionHistoryEntry[],
  options: { maxSessions?: number; limit?: number } = {},
): string[] {
  const { maxSessions = 20, limit = 40 } = options;
  const counts = new Map<string, number>();

  const recent = history.slice(-maxSessions);
  for (let index = 0; index < recent.length; index += 1) {
    const session = recent[index];
    if (!session) continue;
    // Recent sessions count for more.
    const weight = 1 + index / Math.max(1, recent.length);
    for (const round of session.rounds) {
      if (!round.expectedText) continue;
      const { tokens } = scoreTranscript(round.expectedText, round.userText ?? '');
      for (const token of tokens) {
        if (token.status !== 'missing' && token.status !== 'wrong') continue;
        const word = (token.expected ?? '').toLowerCase();
        if (word.length < 3) continue;
        counts.set(word, (counts.get(word) ?? 0) + weight);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, score]) => score > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/** Human-readable summary of what a node type does, for the guidebook. */
export function nodeStrategy(kind: NodeKind): string {
  switch (kind) {
    case 'workout':
      return 'Clips are re-ranked so sentences containing your missed words come first, and longer sentences are preferred.';
    case 'boss':
      return 'Clips are drawn from the hardest 40% of this tier’s sentence range.';
    case 'reward':
      return 'No listening required — claim it to bank bonus XP and the Audio Mastery badge for this tier.';
    case 'practice':
      return 'A balanced draw across the whole sentence range of this tier.';
    case 'intro':
    default:
      return 'A standard session with the auto-level engine free to promote or step you down mid-run. Finishing any node opens the next one; your score decides the stars.';
  }
}
