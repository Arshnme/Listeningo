import { matchWord } from './fuzzy';
import { canonicalTokens, expandedTokens } from './text';
import { DEMOTION, PROMOTION } from './levels';
import type { AlignmentResult, DifficultyLevel, DiffToken, LevelShift } from './types';

/**
 * Word-level Levenshtein alignment with an edit-script backtrace.
 *
 * Costs are the standard unit costs (match 0, substitution 1, insertion 1,
 * deletion 1) so the derived accuracy is exactly `1 - WER`, clamped at zero.
 *
 * A word that is *recognisably the same word* but spelled differently costs 0,
 * exactly like a match. That is deliberate: this is a listening exercise, and a
 * learner who heard "government" and typed "goverment" has demonstrated the
 * skill under test. Substituting a genuinely different word still costs 1.
 */
export function alignWords(expected: readonly string[], actual: readonly string[]): AlignmentResult {
  const n = expected.length;
  const m = actual.length;

  // dp[i][j] = edit distance between expected[0..i) and actual[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const firstRow = dp[0];
  if (firstRow) {
    for (let j = 0; j <= m; j += 1) firstRow[j] = j;
  }
  for (let i = 0; i <= n; i += 1) {
    const row = dp[i];
    if (row) row[0] = i;
  }
  for (let i = 1; i <= n; i += 1) {
    const row = dp[i];
    const prev = dp[i - 1];
    if (!row || !prev) continue;
    for (let j = 1; j <= m; j += 1) {
      const cost = matchWord(expected[i - 1] ?? '', actual[j - 1] ?? '') === 'different' ? 1 : 0;
      row[j] = Math.min(
        (prev[j - 1] ?? Number.POSITIVE_INFINITY) + cost,
        (prev[j] ?? Number.POSITIVE_INFINITY) + 1,
        (row[j - 1] ?? Number.POSITIVE_INFINITY) + 1,
      );
    }
  }

  // Walk back from the far corner, emitting the edit script in reverse.
  const reversed: DiffToken[] = [];
  let correct = 0;
  let misspelled = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const current = dp[i]?.[j] ?? 0;
    const diagonal = dp[i - 1]?.[j - 1] ?? 0;
    const up = dp[i - 1]?.[j] ?? 0;

    const match = i > 0 && j > 0 ? matchWord(expected[i - 1] ?? '', actual[j - 1] ?? '') : 'different';

    if (i > 0 && j > 0 && current === diagonal && match !== 'different') {
      reversed.push({
        status: match === 'exact' ? 'correct' : 'misspelled',
        expected: expected[i - 1],
        actual: actual[j - 1],
        expectedIndex: i - 1,
        actualIndex: j - 1,
      });
      if (match === 'exact') correct += 1;
      else misspelled += 1;
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && j > 0 && current === diagonal + 1) {
      reversed.push({
        status: 'wrong',
        expected: expected[i - 1],
        actual: actual[j - 1],
        expectedIndex: i - 1,
        actualIndex: j - 1,
      });
      substitutions += 1;
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && current === up + 1) {
      reversed.push({ status: 'missing', expected: expected[i - 1], expectedIndex: i - 1 });
      deletions += 1;
      i -= 1;
      continue;
    }
    reversed.push({ status: 'extra', actual: actual[j - 1], actualIndex: j - 1 });
    insertions += 1;
    j -= 1;
  }

  const tokens = reversed.reverse();
  const expectedCount = n;
  // Misspellings are excluded from the error count, which is the whole point of
  // the fuzzy matcher: they are correct answers written untidily.
  const errors = substitutions + deletions + insertions;
  const accuracy = expectedCount === 0 ? 0 : clamp01(1 - errors / expectedCount);

  return {
    tokens,
    correct,
    misspelled,
    substitutions,
    deletions,
    insertions,
    expectedCount,
    accuracy,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Grades free text against the ground-truth transcript.
 *
 * Both the apostrophe-joined and the contraction-expanded readings are scored
 * and the friendlier one wins, so `don't` and `do not` are equally accepted
 * while `ALEXANDER'S` is never misread as `alexander is`.
 */
export function scoreTranscript(expectedText: string, userText: string): AlignmentResult {
  const expectedCanonical = canonicalTokens(expectedText);
  const canonical = alignWords(expectedCanonical, canonicalTokens(userText));

  const expectedExpanded = expandedTokens(expectedText);
  const expanded = alignWords(expectedExpanded, expandedTokens(userText));

  const best =
    expanded.accuracy > canonical.accuracy
      ? { ...expanded, tokens: expanded.tokens }
      : { ...canonical, tokens: canonical.tokens };

  return best;
}

/** XP: accuracy-weighted, scaled by tier difficulty, with a no-slow-mode bonus. */
export function computeXp(accuracy: number, level: DifficultyLevel, usedSlowMode: boolean): number {
  const tierMultiplier = 1 + (level - 1) * 0.35;
  const slowPenalty = usedSlowMode ? 0.6 : 1;
  return Math.max(0, Math.round(accuracy * 100 * tierMultiplier * slowPenalty));
}

/** Inputs to the per-round adaptive evaluation. */
export interface AdaptationInput {
  accuracy: number;
  usedSlowMode: boolean;
  replays: number;
  currentLevel: DifficultyLevel;
  /** Consecutive clean rounds at or above {@link PROMOTION.tier1.minAccuracy}. */
  consecutiveHighStreak: number;
  /** Consecutive clean rounds at or above {@link PROMOTION.tier2.minAccuracy}. */
  consecutiveLooseStreak: number;
  /** Consecutive rounds below {@link DEMOTION.maxAccuracy}. */
  consecutiveLowStreak: number;
  autoLevelEnabled: boolean;
}

export interface AdaptationOutcome {
  nextLevel: DifficultyLevel;
  nextHighStreak: number;
  nextLooseStreak: number;
  nextLowStreak: number;
  shift: LevelShift | null;
}

/**
 * Adaptive evaluation, run after every single voice.
 *
 * A round only counts toward promotion when it was understood at normal speed:
 * no slow mode and at most {@link PROMOTION.maxReplays} replays. Such an
 * assisted round *pauses* the streak rather than resetting it, so asking for
 * help once delays mastery instead of erasing it. A clean round that simply
 * misses the bar does reset the streak.
 */
export function evaluateAdaptation(input: AdaptationInput): AdaptationOutcome {
  const {
    accuracy,
    usedSlowMode,
    replays,
    currentLevel,
    autoLevelEnabled,
  } = input;

  const assisted = usedSlowMode || replays > PROMOTION.maxReplays;
  let highStreak = input.consecutiveHighStreak;
  let looseStreak = input.consecutiveLooseStreak;
  let lowStreak = input.consecutiveLowStreak;

  if (assisted) {
    // Paused: both mastery counters hold their value.
  } else if (accuracy >= PROMOTION.tier1.minAccuracy) {
    highStreak += 1;
    looseStreak += 1;
  } else if (accuracy >= PROMOTION.tier2.minAccuracy) {
    highStreak = 0;
    looseStreak += 1;
  } else {
    highStreak = 0;
    looseStreak = 0;
  }

  lowStreak = accuracy < DEMOTION.maxAccuracy ? lowStreak + 1 : 0;

  const stall = (shift: LevelShift | null): AdaptationOutcome => ({
    nextLevel: currentLevel,
    nextHighStreak: highStreak,
    nextLooseStreak: looseStreak,
    nextLowStreak: lowStreak,
    shift,
  });

  if (!autoLevelEnabled || currentLevel >= 5) {
    // Still report a demotion at the ceiling only if one is warranted below.
    if (autoLevelEnabled && currentLevel >= 5 && lowStreak >= DEMOTION.consecutive) {
      const to = (currentLevel - 1) as DifficultyLevel;
      return { nextLevel: to, nextHighStreak: 0, nextLooseStreak: 0, nextLowStreak: 0, shift: {
        direction: 'down',
        from: currentLevel,
        to,
        reason: `${DEMOTION.consecutive} voices below ${Math.round(DEMOTION.maxAccuracy * 100)}% — easing the difficulty`,
      } };
    }
    return stall(null);
  }

  const tier1Promotion = highStreak >= PROMOTION.tier1.consecutive;
  const tier2Promotion = looseStreak >= PROMOTION.tier2.consecutive;

  if (tier1Promotion || tier2Promotion) {
    const to = (currentLevel + 1) as DifficultyLevel;
    return {
      nextLevel: to,
      nextHighStreak: 0,
      nextLooseStreak: 0,
      nextLowStreak: 0,
      shift: {
        direction: 'up',
        from: currentLevel,
        to,
        reason: tier1Promotion
          ? `${PROMOTION.tier1.consecutive} straight voices at ${Math.round(PROMOTION.tier1.minAccuracy * 100)}%+ without Slow Mode`
          : `${PROMOTION.tier2.consecutive} straight voices at ${Math.round(PROMOTION.tier2.minAccuracy * 100)}%+ without Slow Mode`,
      },
    };
  }

  if (lowStreak >= DEMOTION.consecutive && currentLevel > 1) {
    const to = (currentLevel - 1) as DifficultyLevel;
    return {
      nextLevel: to,
      nextHighStreak: 0,
      nextLooseStreak: 0,
      nextLowStreak: 0,
      shift: {
        direction: 'down',
        from: currentLevel,
        to,
        reason: `${DEMOTION.consecutive} voices below ${Math.round(DEMOTION.maxAccuracy * 100)}% — easing the difficulty`,
      },
    };
  }

  return stall(null);
}

/** Progress toward the next promotion, for the HUD streak pill. */
export function promotionProgress(level: DifficultyLevel, highStreak: number): { have: number; need: number } {
  if (level >= 5) return { have: 0, need: 0 };
  return { have: Math.min(highStreak, PROMOTION.tier1.consecutive), need: PROMOTION.tier1.consecutive };
}

/** Demotion progress, so the HUD can warn before a step-down happens. */
export function demotionProgress(level: DifficultyLevel, lowStreak: number): { have: number; need: number } {
  if (level <= 1) return { have: 0, need: 0 };
  return { have: Math.min(lowStreak, DEMOTION.consecutive), need: DEMOTION.consecutive };
}
