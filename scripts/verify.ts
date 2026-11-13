/**
 * Logic verification harness for the pure (non-DOM) parts of the app.
 *
 * Run with:  npx jiti scripts/verify.ts
 *
 * Covers the behaviour that is easy to get subtly wrong and hard to spot in the
 * UI: dictation scoring, the adaptive promotion/demotion rules, SNR calibration
 * maths, cache coercion and non-repeating clip selection.
 */

import { canonicalTokens, countWords, expandNumbers, expandedTokens } from '../src/lib/text';
import {
  alignWords,
  computeXp,
  demotionProgress,
  evaluateAdaptation,
  promotionProgress,
  scoreTranscript,
} from '../src/lib/scoring';
import { LEVELS, resolveAcousticProfile } from '../src/lib/levels';
import { bufferRms, ratioToSnrDb, solveNoiseGain, snrToRatio } from '../src/lib/audio/noise';
import {
  advanceStreak,
  appendSession,
  defaultState,
  parseState,
  pushSeenClip,
  recordVoice,
  resetSeenForTier,
  saveState,
  SEEN_CLIP_CAP,
  SESSION_HISTORY_CAP,
} from '../src/lib/storage';
import { ClipPool, rebuildClipFromHistory, shuffle, toRoundClip } from '../src/lib/session';
import type { CachedUserState, HistoryRound, ManifestClip } from '../src/lib/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(
    name,
    Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function near(name: string, actual: number, expected: number, tolerance: number): void {
  check(
    name,
    Math.abs(actual - expected) <= tolerance,
    `expected ~${expected} (±${tolerance}), got ${actual}`,
  );
}

/* ------------------------------------------------------------------ text -- */

eq('canonical: lowercase + strip punctuation', canonicalTokens('The QUICK, brown fox!').join(' '), 'the quick brown fox');
eq('canonical: apostrophe joined, not expanded', canonicalTokens("ALEXANDER'S book").join(' '), 'alexanders book');
eq('canonical: contraction joined', canonicalTokens("aren't you").join(' '), 'arent you');
eq('canonical: curly apostrophe normalised', canonicalTokens('don\u2019t stop').join(' '), 'dont stop');
eq('canonical: digits expanded', canonicalTokens('10').join(' '), 'ten');
eq('canonical: 21 expanded', canonicalTokens('21').join(' '), 'twenty one');
eq('canonical: 100 expanded', canonicalTokens('100').join(' '), 'one hundred');
eq('canonical: 1015 expanded', canonicalTokens('1015').join(' '), 'one thousand fifteen');
eq('canonical: ordinal expanded', canonicalTokens('3rd').join(' '), 'third');
eq('canonical: decimal expanded', canonicalTokens('3.5').join(' '), 'three point five');
eq('canonical: thousands separator', canonicalTokens('1,000').join(' '), 'one thousand');
eq('expanded: don\u2019t splits', expandedTokens("don't go").join(' '), 'do not go');
eq('expanded: possessive stays joined', expandedTokens("ALEXANDER'S book").join(' '), 'alexanders book');
eq('word count ignores punctuation', countWords('Hello,   world!! — again'), 3);
eq('word count of empty string', countWords('   '), 0);
eq('expandNumbers leaves words alone', expandNumbers('chapter seven'), 'chapter seven');

/* --------------------------------------------------------------- scoring -- */

const perfect = alignWords(['the', 'quick', 'fox'], ['the', 'quick', 'fox']);
eq('align: perfect accuracy', perfect.accuracy, 1);
eq('align: perfect counts', [perfect.correct, perfect.substitutions, perfect.deletions, perfect.insertions], [3, 0, 0, 0]);

const oneSub = alignWords(['the', 'quick', 'fox'], ['the', 'slow', 'fox']);
// 1 - WER = 1 - 1/3. Compared with a tolerance because 1 - 1/3 and 2/3 differ
// in the final bit of the float mantissa.
near('align: one substitution accuracy', oneSub.accuracy, 2 / 3, 1e-12);
eq('align: one substitution token status', oneSub.tokens.map((token) => token.status), ['correct', 'wrong', 'correct']);

const missingWord = alignWords(['the', 'quick', 'fox'], ['the', 'fox']);
// One deletion out of three expected words: 1 - 1/3, not 1/3.
near('align: deletion accuracy', missingWord.accuracy, 2 / 3, 1e-12);
eq('align: deletion statuses', missingWord.tokens.map((t) => t.status), ['correct', 'missing', 'correct']);

const extra = alignWords(['the', 'fox'], ['the', 'big', 'bad', 'fox']);
eq('align: insertions penalised', extra.accuracy, 0);
eq('align: insertion statuses', extra.tokens.map((t) => t.status), ['correct', 'extra', 'extra', 'correct']);

eq('align: empty answer scores zero', alignWords(['a', 'b'], []).accuracy, 0);
eq('align: empty expectation scores zero', alignWords([], ['a']).accuracy, 0);
check('align: accuracy never negative', alignWords(['a'], ['x', 'y', 'z', 'w']).accuracy >= 0);

// The canonical-vs-expanded dual scoring.
eq('score: exact match', Math.round(scoreTranscript('THE QUICK BROWN FOX', 'the quick brown fox').accuracy * 100), 100);
eq('score: contraction typed as contraction', Math.round(scoreTranscript("THEY AREN'T HERE", "they aren't here").accuracy * 100), 100);
eq(
  'score: contraction typed expanded also accepted',
  Math.round(scoreTranscript("THEY AREN'T HERE", 'they are not here').accuracy * 100),
  100,
);
eq(
  'score: possessive typed without apostrophe accepted',
  Math.round(scoreTranscript("ALEXANDER'S HORSE", 'alexanders horse').accuracy * 100),
  100,
);
eq(
  'score: possessive typed WITH apostrophe accepted',
  Math.round(scoreTranscript("ALEXANDER'S HORSE", "alexander's horse").accuracy * 100),
  100,
);
eq('score: digits typed as numerals accepted', Math.round(scoreTranscript('HE WAS TEN', 'he was 10').accuracy * 100), 100);
eq('score: wrong sentence scores low', scoreTranscript('THE QUICK BROWN FOX', 'totally different words here').accuracy < 0.3, true);

eq('xp: scales with tier', computeXp(1, 5, false) > computeXp(1, 1, false), true);
eq('xp: slow mode reduces reward', computeXp(1, 3, true) < computeXp(1, 3, false), true);

/* -------------------------------------------------------------- adaptive -- */

const baseAdapt = {
  usedSlowMode: false,
  replays: 0,
  currentLevel: 1 as const,
  consecutiveHighStreak: 0,
  consecutiveLooseStreak: 0,
  consecutiveLowStreak: 0,
  autoLevelEnabled: true,
};

const promoteFirst = evaluateAdaptation({ ...baseAdapt, accuracy: 0.95 });
eq('adapt: one mastery voice does not promote', promoteFirst.nextLevel, 1);
eq('adapt: high streak increments', promoteFirst.nextHighStreak, 1);

const promoteSecond = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.95,
  consecutiveHighStreak: promoteFirst.nextHighStreak,
  consecutiveLooseStreak: promoteFirst.nextLooseStreak,
});
eq('adapt: two mastery voices in a row promote', promoteSecond.nextLevel, 2);
check('adapt: promotion reports a shift', promoteSecond.shift?.direction === 'up');
eq('adapt: shift target is correct', promoteSecond.shift?.to, 2);

// 85-91% must not promote on two voices; it needs three.
const loose1 = evaluateAdaptation({ ...baseAdapt, accuracy: 0.87 });
const loose2 = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.87,
  consecutiveHighStreak: loose1.nextHighStreak,
  consecutiveLooseStreak: loose1.nextLooseStreak,
});
eq('adapt: 87% twice does not promote', loose2.nextLevel, 1);
eq('adapt: 87% resets the 90% streak', loose2.nextHighStreak, 0);
const loose3 = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.87,
  consecutiveHighStreak: loose2.nextHighStreak,
  consecutiveLooseStreak: loose2.nextLooseStreak,
});
eq('adapt: 87% three times promotes', loose3.nextLevel, 2);

// Slow mode pauses rather than resets.
const paused = evaluateAdaptation({ ...baseAdapt, accuracy: 0.98, usedSlowMode: true, consecutiveHighStreak: 1 });
eq('adapt: slow mode pauses streak', paused.nextHighStreak, 1);
eq('adapt: slow mode does not promote', paused.nextLevel, 1);
const tooManyReplays = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.99,
  replays: 3,
  consecutiveHighStreak: 1,
});
eq('adapt: >2 replays pauses streak', tooManyReplays.nextHighStreak, 1);

// A genuinely poor clean round resets the mastery streak.
const reset = evaluateAdaptation({ ...baseAdapt, accuracy: 0.7, consecutiveHighStreak: 1 });
eq('adapt: mediocre round resets streak', reset.nextHighStreak, 0);

// Demotion.
const low1 = evaluateAdaptation({ ...baseAdapt, accuracy: 0.4, currentLevel: 3 });
eq('adapt: one low voice does not demote', low1.nextLevel, 3);
const low2 = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.4,
  currentLevel: 3,
  consecutiveLowStreak: low1.nextLowStreak,
});
eq('adapt: two low voices demote', low2.nextLevel, 2);
check('adapt: demotion reports a shift', low2.shift?.direction === 'down');

const floor = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.1,
  currentLevel: 1,
  consecutiveLowStreak: 5,
});
eq('adapt: cannot demote below level 1', floor.nextLevel, 1);
check('adapt: level stays a valid tier', floor.nextLevel >= 1 && floor.nextLevel <= 5);
check('adapt: no shift reported at the floor', floor.shift === null);

const ceiling = evaluateAdaptation({
  ...baseAdapt,
  accuracy: 0.99,
  currentLevel: 5,
  consecutiveHighStreak: 9,
  consecutiveLooseStreak: 9,
});
eq('adapt: cannot promote above level 5', ceiling.nextLevel, 5);

const disabled = evaluateAdaptation({ ...baseAdapt, accuracy: 0.99, autoLevelEnabled: false, consecutiveHighStreak: 5 });
eq('adapt: auto-level off never promotes', disabled.nextLevel, 1);

eq('hud: promotion progress caps at need', promotionProgress(1, 9), { have: 2, need: 2 });
eq('hud: no promotion progress at max tier', promotionProgress(5, 2), { have: 0, need: 0 });
eq('hud: no demotion progress at tier 1', demotionProgress(1, 5), { have: 0, need: 0 });

/* ----------------------------------------------------------------- levels -- */

eq('levels: ladder is clean then other', [LEVELS[1].config, LEVELS[2].config, LEVELS[3].config, LEVELS[4].config, LEVELS[5].config], ['clean', 'clean', 'other', 'other', 'other']);
eq('levels: snr ladder', [LEVELS[1].noise.snrDb, LEVELS[2].noise.snrDb, LEVELS[3].noise.snrDb, LEVELS[4].noise.snrDb, LEVELS[5].noise.snrDb], [null, null, null, 16, 10]);
eq('levels: slow-mode noise scale halves amplitude', resolveAcousticProfile(4, 'auto').noise.snrDb, 16);

const cleanOnly = resolveAcousticProfile(5, 'clean_only');
eq('mode: clean_only forces clean config', cleanOnly.config, 'clean');
eq('mode: clean_only removes noise', cleanOnly.noise.snrDb, null);

const forced = resolveAcousticProfile(1, 'noisy_forced');
eq('mode: noisy_forced uses other split', forced.config, 'other');
eq('mode: noisy_forced injects 16 dB', forced.noise.snrDb, 16);

const forcedHigh = resolveAcousticProfile(5, 'noisy_forced');
eq('mode: noisy_forced keeps tier 5 profile', forcedHigh.noise.snrDb, 10);

/* -------------------------------------------------------------- snr math -- */

near('snr: 16 dB ratio', snrToRatio(16), 6.3096, 0.001);
near('snr: ratio round trip', ratioToSnrDb(snrToRatio(10)), 10, 1e-9);

// The core guarantee: requested SNR must be the achieved SNR.
for (const targetDb of [10, 16, 24]) {
  const voiceRms = 0.083;
  const noiseRms = 0.021;
  const gain = solveNoiseGain(voiceRms, noiseRms, targetDb);
  const achievedNoise = noiseRms * gain;
  near(`snr: ${targetDb} dB is achieved`, ratioToSnrDb(voiceRms / achievedNoise), targetDb, 1e-9);
}
eq('snr: silent noise source yields zero gain', solveNoiseGain(0.1, 0, 16), 0);

// RMS of a known signal: a full-scale square wave has RMS 1.
const square = new Float32Array(1000).fill(1);
near('rms: full-scale square wave', bufferRms({ numberOfChannels: 1, getChannelData: () => square } as unknown as AudioBuffer), 1, 1e-9);
near('rms: half-scale square wave', bufferRms({ numberOfChannels: 1, getChannelData: () => square.map(() => 0.5) as unknown as Float32Array } as unknown as AudioBuffer), 0.5, 1e-9);

/* --------------------------------------------------------------- storage -- */

const defaults = defaultState();
eq('storage: new users start at level 1', defaults.currentLevel, 1);
eq('storage: auto-level defaults on', defaults.autoLevelEnabled, true);
eq('storage: acoustic mode defaults auto', defaults.acousticMode, 'auto');
eq('storage: history starts empty', defaults.sessionHistory.length, 0);

// Hostile input must never throw or produce an invalid state.
const hostile = parseState({
  currentLevel: 99,
  autoLevelEnabled: 'yes',
  acousticMode: 'bogus',
  seenClipIds: 'not-an-array',
  sessionHistory: [{ rounds: 'nope' }],
  totalVoicesCompleted: -5,
  overallAccuracy: 42,
  xp: Number.NaN,
});
eq('storage: clamps out-of-range level', hostile.currentLevel, 5);
eq('storage: falls back on bad boolean', hostile.autoLevelEnabled, true);
eq('storage: falls back on bad mode', hostile.acousticMode, 'auto');
eq('storage: coerces bad array to empty', hostile.seenClipIds.length, 0);
eq('storage: clamps negative totals', hostile.totalVoicesCompleted, 0);
eq('storage: clamps accuracy above 1', hostile.overallAccuracy, 1);
eq('storage: replaces NaN', hostile.xp, 0);
check('storage: survives non-object input', parseState(null).currentLevel === 1);
check('storage: survives string input', parseState('garbage').currentLevel === 1);

// seenClipIds rolling window.
const rolling = defaultState();
let rollingFilled = rolling;
for (let i = 0; i < SEEN_CLIP_CAP + 120; i += 1) rollingFilled = pushSeenClip(rollingFilled, `clip-${i}`);
eq('storage: seen window is capped', rollingFilled.seenClipIds.length, SEEN_CLIP_CAP);
eq('storage: cap keeps the newest', rollingFilled.seenClipIds[rollingFilled.seenClipIds.length - 1], `clip-${SEEN_CLIP_CAP + 119}`);
eq('storage: cap drops the oldest', rollingFilled.seenClipIds.includes('clip-0'), false);
check('storage: duplicate ids are ignored', pushSeenClip(rollingFilled, `clip-${SEEN_CLIP_CAP + 119}`) === rollingFilled);

// The window runs clip-120..clip-619, so remove two ids from inside it.
const afterReset = resetSeenForTier(rollingFilled, ['clip-600', 'clip-601']);
eq('storage: tier reset removes exactly those ids', afterReset.seenClipIds.length, SEEN_CLIP_CAP - 2);
eq('storage: tier reset keeps others', afterReset.seenClipIds.includes('clip-619'), true);
eq('storage: tier reset removes the targets', afterReset.seenClipIds.includes('clip-600'), false);

// sessionHistory cap.
let capped = defaultState();
for (let i = 0; i < SESSION_HISTORY_CAP + 10; i += 1) {
  capped = appendSession(capped, {
    id: `s-${i}`,
    timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
    startLevel: 1,
    endLevel: 2,
    averageAccuracy: 0.9,
    rounds: [],
  });
}
eq('storage: history is capped', capped.sessionHistory.length, SESSION_HISTORY_CAP);
eq('storage: history keeps the newest', capped.sessionHistory[capped.sessionHistory.length - 1]?.id, `s-${SESSION_HISTORY_CAP + 9}`);

// Exact arithmetic means for the clean/noisy split.
let acc = defaultState();
acc = recordVoice(acc, { accuracy: 1, isNoisy: false, usedSlowMode: false, xp: 100 });
acc = recordVoice(acc, { accuracy: 0, isNoisy: false, usedSlowMode: true, xp: 0 });
acc = recordVoice(acc, { accuracy: 0.5, isNoisy: true, usedSlowMode: false, xp: 50 });
eq('storage: clean voice count', acc.cleanVoicesCompleted, 2);
eq('storage: noisy voice count', acc.noisyVoicesCompleted, 1);
near('storage: clean mean is exact', acc.cleanAccuracy, 0.5, 1e-12);
near('storage: noisy mean is exact', acc.noisyAccuracy, 0.5, 1e-12);
near('storage: overall mean is exact', acc.overallAccuracy, 0.5, 1e-12);
eq('storage: slow mode counted', acc.slowModeUsageCount, 1);
eq('storage: xp accumulated', acc.xp, 150);
eq('storage: total voices counted', acc.totalVoicesCompleted, 3);

// Daily streak.
eq('streak: first day', advanceStreak(defaultState(), '2026-03-01').streakDays, 1);
eq(
  'streak: same day is a no-op',
  advanceStreak({ ...defaultState(), streakDays: 4, lastActiveDate: '2026-03-01' }, '2026-03-01').streakDays,
  4,
);
eq(
  'streak: consecutive day increments',
  advanceStreak({ ...defaultState(), streakDays: 4, lastActiveDate: '2026-03-01' }, '2026-03-02').streakDays,
  5,
);
eq(
  'streak: gap resets',
  advanceStreak({ ...defaultState(), streakDays: 9, lastActiveDate: '2026-03-01' }, '2026-03-05').streakDays,
  1,
);

/* ---------------------------------------------------------- clip selection -- */

function fakeClip(id: string, level: 1 | 2 | 3 | 4 | 5, wordCount: number): ManifestClip {
  return {
    id,
    text: Array.from({ length: wordCount }, (_, i) => `w${i}`).join(' '),
    speakerId: `spk-${id}`,
    chapterId: `ch-${id}`,
    config: level <= 2 ? 'clean' : 'other',
    split: 'test',
    splitLabel: level <= 2 ? 'test-clean' : 'test-other',
    rowIdx: Number(id.replace(/\D/g, '')) || 0,
    level,
    wordCount,
    speakerMinutes: 120,
    index: 0,
  };
}

// Deterministic shuffle for reproducible assertions.
eq('shuffle: preserves length', shuffle([1, 2, 3, 4, 5], () => 0.5).length, 5);
eq('shuffle: preserves membership', [...shuffle([1, 2, 3, 4, 5], () => 0.42)].sort().join(','), '1,2,3,4,5');
eq('shuffle: does not mutate input', (() => {
  const input = [1, 2, 3];
  shuffle(input, () => 0.9);
  return input.join(',');
})(), '1,2,3');

const level1Clips = ['a1', 'a2', 'a3', 'a4'].map((id) => fakeClip(id, 1, 4));
const level3Clips = ['b1', 'b2', 'b3'].map((id) => fakeClip(id, 3, 10));
const pool = new ClipPool([...level1Clips, ...level3Clips]);

eq('pool: level 1 pool size', pool.poolSize(1), 4);
eq('pool: level 3 pool size', pool.poolSize(3), 3);

// Draw the whole tier: no repeats until it is exhausted.
const seen = new Set<string>();
const drawn: string[] = [];
for (let i = 0; i < 4; i += 1) {
  const picked = pool.pick({ level: 1, mode: 'auto', exclude: seen, random: Math.random });
  check(`pool: draw ${i + 1} succeeds`, picked !== null);
  if (!picked) break;
  check(`pool: draw ${i + 1} is not a repeat`, !seen.has(picked.clip.id), picked.clip.id);
  check(`pool: draw ${i + 1} reports no premature reset`, picked.poolReset === false);
  seen.add(picked.clip.id);
  drawn.push(picked.clip.id);
}
eq('pool: four unique clips drawn', new Set(drawn).size, 4);

// The fifth draw must recycle the tier and say so.
const fifth = pool.pick({ level: 1, mode: 'auto', exclude: seen, random: Math.random });
check('pool: fifth draw still returns a clip', fifth !== null);
eq('pool: fifth draw flags the pool reset', fifth?.poolReset, true);

// clean_only must never hand out an OTHER clip, even when the tier's word range
// has no clean clips in it (Tier 3 starts at 8 words, the clean clips are 4).
const forcedClean = pool.pick({ level: 3, mode: 'clean_only', exclude: new Set(), random: Math.random });
eq('pool: clean_only never yields other split', forcedClean?.clip.config, 'clean');
check('pool: clean_only clip comes from the clean set', forcedClean !== null && forcedClean.clip.id.startsWith('a'));
eq('pool: clean_only relaxes the word range rather than the corpus', forcedClean?.clip.wordCount, 4);

// The same guarantee at the top of the ladder, where Clean Only has no hope of
// matching the 16-word range at all.
const cleanOnlyTier5 = pool.pick({ level: 5, mode: 'clean_only', exclude: new Set(), random: Math.random });
eq('pool: clean_only at tier 5 stays clean', cleanOnlyTier5?.clip.config, 'clean');
eq('pool: clean_only at tier 5 injects no noise', cleanOnlyTier5?.clip.noiseDb, null);

// auto on tier 3 must only hand out OTHER clips, never the clean ones.
const autoOther = pool.pick({ level: 3, mode: 'auto', exclude: new Set(), random: Math.random });
eq('pool: tier 3 auto yields other split', autoOther?.clip.config, 'other');
check('pool: tier 3 auto comes from the other set', autoOther !== null && autoOther.clip.id.startsWith('b'));

// noisy_forced on a clean tier must switch corpus and add a bed.
const forcedNoisy = pool.pick({ level: 1, mode: 'noisy_forced', exclude: new Set(), random: Math.random });
eq('pool: noisy_forced yields other split on tier 1', forcedNoisy?.clip.config, 'other');
eq('pool: noisy_forced injects 16 dB on tier 1', forcedNoisy?.clip.noiseDb, 16);

// An empty pool is reported rather than throwing.
const emptyPool = new ClipPool([]);
eq('pool: empty pool returns null', emptyPool.pick({ level: 1, mode: 'auto', exclude: new Set() }), null);
eq('pool: empty pool has zero size', emptyPool.poolSize(1), 0);

// Round clips must carry their tier's acoustic profile.
const roundClip = toRoundClip(fakeClip('c1', 4, 16), 4, 'auto');
eq('pool: tier 4 clip gets 16 dB', roundClip.noiseDb, 16);
eq('pool: tier 4 clip gets room bed', roundClip.noiseKind, 'room');
const roundClip5 = toRoundClip(fakeClip('c2', 5, 20), 5, 'auto');
eq('pool: tier 5 clip gets 10 dB', roundClip5.noiseDb, 10);
eq('pool: tier 5 clip is shaped', roundClip5.shaped, true);
eq('pool: tier 2 clip has no noise', toRoundClip(fakeClip('c3', 2, 9), 2, 'auto').noiseDb, null);

/* ---------------------------------------------------- history rehydration -- */

const historyRound: HistoryRound = {
  clipId: '2094-142345-0022',
  split: 'test-clean',
  level: 1,
  noiseDb: 0,
  accuracy: 0.9,
  usedSlowMode: false,
  replays: 1,
  expectedText: 'WHERE IS THAT',
  userText: 'where is that',
  rowIdx: 330,
  speakerId: '2094',
};
const rebuilt = rebuildClipFromHistory(historyRound);
eq('rebuild: keeps clip id', rebuilt.id, historyRound.clipId);
eq('rebuild: keeps row index', rebuilt.rowIdx, 330);
eq('rebuild: derives clean config', rebuilt.config, 'clean');
eq('rebuild: derives test split', rebuilt.split, 'test');
eq('rebuild: no noise when none recorded', rebuilt.noiseDb, null);
eq('rebuild: derives word count', rebuilt.wordCount, 3);

const noisyRound: HistoryRound = { ...historyRound, split: 'test-other', level: 5, noiseDb: 10 };
const rebuiltNoisy = rebuildClipFromHistory(noisyRound);
eq('rebuild: derives other config', rebuiltNoisy.config, 'other');
eq('rebuild: derives crowd bed at tier 5', rebuiltNoisy.noiseKind, 'crowd');
eq('rebuild: applies shaping at tier 5', rebuiltNoisy.shaped, true);

const devRound: HistoryRound = { ...historyRound, split: 'dev-other', level: 4, noiseDb: 16 };
const rebuiltDev = rebuildClipFromHistory(devRound);
eq('rebuild: dev split maps to validation', rebuiltDev.split, 'validation');
eq('rebuild: tier 4 uses room bed', rebuiltDev.noiseKind, 'room');

/* ------------------------------------------------------------------ report -- */

// saveState must survive having no DOM.
const noDomOutcome = saveState(defaultState() as CachedUserState);
eq('storage: saveState without a DOM reports failure, not a throw', noDomOutcome.ok, false);

console.log(`\n${passed} checks passed`);
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('All logic checks passed.');
}
