/**
 * Tolerant matching and preference verification suite.
 *
 * Covers the fuzzy spelling engine (edit distance, phonetic keys, and the guards
 * that stop it accepting genuinely different words), how misspellings flow into
 * scoring, and the selectable slow speeds.
 *
 * Run with:  npm test   (which executes this alongside the other two suites)
 */

import { editDistance, isSameWord, matchWord, phoneticKey } from '../src/lib/fuzzy';
import { alignWords, scoreTranscript } from '../src/lib/scoring';
import { SLOW_RATES } from '../src/lib/levels';
import { defaultState, parseState } from '../src/lib/storage';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function near(name: string, actual: number, expected: number, tolerance = 1e-12): void {
  check(name, Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(
    name,
    Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/* --------------------------------------------------------- edit distance -- */

eq('distance: identical', editDistance('word', 'word'), 0);
eq('distance: one substitution', editDistance('cat', 'cut'), 1);
eq('distance: one insertion', editDistance('cat', 'cats'), 1);
eq('distance: one deletion', editDistance('cats', 'cat'), 1);
eq('distance: transposition costs two', editDistance('recieve', 'receive'), 2);
eq('distance: empty against word', editDistance('', 'word'), 4);
eq('distance: word against empty', editDistance('word', ''), 4);
eq('distance: both empty', editDistance('', ''), 0);
eq('distance: symmetric', editDistance('abc', 'xyz'), editDistance('xyz', 'abc'));
eq('distance: unrelated words', editDistance('cat', 'elephant'), 6);

/* --------------------------------------------------------- phonetic keys -- */

eq('phonetic: same sound, different spelling', phoneticKey('receive'), phoneticKey('receeve'));
eq('phonetic: their and there are homophones', phoneticKey('their'), phoneticKey('there'));
eq('phonetic: right and write are homophones', phoneticKey('right'), phoneticKey('write'));
eq('phonetic: sea and see are homophones', phoneticKey('sea'), phoneticKey('see'));
eq('phonetic: knight drops the silent K', phoneticKey('knight'), phoneticKey('night'));
eq('phonetic: phone and fone match', phoneticKey('phone'), phoneticKey('fone'));
eq('phonetic: night and knight both start with N', phoneticKey('night')[0], 'N');
eq('phonetic: different words differ', phoneticKey('cat') !== phoneticKey('dog'), true);
eq('phonetic: empty input', phoneticKey(''), '');
eq('phonetic: punctuation is ignored', phoneticKey("don't"), phoneticKey('dont'));
eq('phonetic: is bounded in length', phoneticKey('extraordinarily').length <= 6, true);
eq('phonetic: case insensitive', phoneticKey('HELLO'), phoneticKey('hello'));

/* ------------------------------------------------------------ matchWord -- */

eq('match: exact', matchWord('hello', 'hello'), 'exact');
eq('match: single typo in a long word', matchWord('government', 'goverment'), 'similar');
eq('match: transposition', matchWord('receive', 'recieve'), 'similar');
eq('match: doubled letter', matchWord('necessary', 'neccessary'), 'similar');
eq('match: homophone accepted', matchWord('their', 'there'), 'similar');
eq('match: homophone accepted the other way', matchWord('write', 'right'), 'similar');
eq('match: silent letter dropped', matchWord('knight', 'night'), 'similar');

// The guards: tolerance must not swallow genuinely different words.
eq('guard: short words get no slack', matchWord('cat', 'cut'), 'different');
eq('guard: cut vs cot rejected', matchWord('cut', 'cot'), 'different');
eq('guard: different initial letter rejected', matchWord('there', 'where'), 'different');
eq('guard: wholly different words rejected', matchWord('house', 'car'), 'different');
eq('guard: same length but unrelated', matchWord('table', 'cable'), 'different');
eq('guard: unrelated long words', matchWord('government', 'parliament'), 'different');
eq('guard: one letter off in a three letter word', matchWord('the', 'thy'), 'different');
// A padded three-letter word is a homophone ("was"/"wass" sound identical), so
// the phonetic path accepts it as a spelling slip. That is the right answer for a
// dictation exercise: the learner demonstrably heard the word correctly.
eq('guard: padded three letter word is a homophone', matchWord('was', 'wass'), 'similar');
// Below three letters the phonetic path is disabled, so these must be exact.
eq('guard: padded two letter word rejected', matchWord('of', 'off'), 'different');
eq('guard: three letter word still exact', matchWord('was', 'was'), 'exact');
eq('guard: two letter word must be exact', matchWord('of', 'of'), 'exact');
// A genuine slip on a longer word is still forgiven.
eq('guard: doubled letter on a long word accepted', matchWord('nodding', 'noddingg'), 'similar');
eq('guard: empty actual', matchWord('word', ''), 'different');
eq('guard: empty expected', matchWord('', 'word'), 'different');
eq('guard: too many edits for length', matchWord('cat', 'dogma'), 'different');
eq('guard: isSameWord tracks matchWord', isSameWord('their', 'there'), true);
eq('guard: isSameWord rejects differences', isSameWord('cat', 'dog'), false);

/* --------------------------------------------------- scoring integration -- */

// A misspelled word must not cost accuracy.
const typo = alignWords(['the', 'government', 'fell'], ['the', 'goverment', 'fell']);
eq('score: typo counts as a match', typo.accuracy, 1);
eq('score: typo is not a substitution', typo.substitutions, 0);
eq('score: typo is counted separately', typo.misspelled, 1);
eq('score: typo token is flagged', typo.tokens[1]?.status, 'misspelled');
eq('score: typo still shows the written form', typo.tokens[1]?.actual, 'goverment');
eq('score: correct neighbours unaffected', typo.tokens[0]?.status, 'correct');

const loneTypo = alignWords(['elephant'], ['elefant']);
eq('score: a typo on a single word is full marks', loneTypo.accuracy, 1);
eq('score: a typo is still a match, not a miss', loneTypo.deletions, 0);

// Real errors still cost, and are marked differently from typos.
const realError = alignWords(['the', 'government', 'fell'], ['the', 'parliament', 'fell']);
near('score: a different word still costs', realError.accuracy, 2 / 3);
eq('score: a different word is flagged wrong', realError.tokens[1]?.status, 'wrong');
eq('score: a different word counts as substitution', realError.substitutions, 1);
eq('score: a different word is not a misspelling', realError.misspelled, 0);

// Both classes in one sentence.
const mixed = alignWords(
  ['the', 'government', 'fell', 'quickly'],
  ['the', 'goverment', 'rose', 'quickly'],
);
eq('score: mixed case accuracy', Math.round(mixed.accuracy * 100), 75);
eq('score: mixed misspellings counted', mixed.misspelled, 1);
eq('score: mixed substitutions counted', mixed.substitutions, 1);
eq('score: mixed statuses', mixed.tokens.map((t) => t.status), [
  'correct',
  'misspelled',
  'wrong',
  'correct',
]);

// Through the public entry point, including the contraction variants.
eq(
  'score: transcript with a typo scores 100',
  Math.round(scoreTranscript('THE GOVERNMENT FELL', 'the goverment fell').accuracy * 100),
  100,
);
eq(
  'score: homophone through the transcript path',
  Math.round(scoreTranscript('THEIR HOUSE', 'there house').accuracy * 100),
  100,
);
eq(
  'score: a real error is still an error',
  Math.round(scoreTranscript('THEIR HOUSE', 'car house').accuracy * 100),
  50,
);
eq(
  'score: empty answer still scores zero',
  scoreTranscript('THE GOVERNMENT FELL', '').accuracy,
  0,
);
eq(
  'score: insertion still penalised alongside a typo',
  alignWords(['a', 'government'], ['a', 'goverment', 'extra']).accuracy,
  0.5,
);
eq(
  'score: every token keeps an index for display',
  mixed.tokens.every((t) => t.status === 'extra' || typeof t.expectedIndex === 'number'),
  true,
);

/* --------------------------------------------------------------- slow rate -- */

eq('slow: five selectable speeds', SLOW_RATES.length, 5);
eq('slow: fastest option', SLOW_RATES[0], 0.75);
eq('slow: slowest option', SLOW_RATES[SLOW_RATES.length - 1], 0.4);
eq('slow: includes 0.5', (SLOW_RATES as readonly number[]).includes(0.5), true);
eq('slow: includes 0.6', (SLOW_RATES as readonly number[]).includes(0.6), true);
eq('slow: strictly descending', SLOW_RATES.every((r, i) => i === 0 || r < (SLOW_RATES[i - 1] ?? 0)), true);

eq('slow: default is 0.75', defaultState().slowRate, 0.75);
eq('slow: every published speed round-trips', SLOW_RATES.map((r) => parseState({ slowRate: r }).slowRate), [...SLOW_RATES]);
eq('slow: an unpublished speed falls back', parseState({ slowRate: 0.33 }).slowRate, 0.75);
eq('slow: nonsense falls back', parseState({ slowRate: 'fast' }).slowRate, 0.75);

/* ------------------------------------------------------------ compression -- */

eq('compress: default is on', defaultState().compressCache, true);
eq('compress: honours an explicit off', parseState({ compressCache: false }).compressCache, false);
eq('compress: coerces nonsense to the default', parseState({ compressCache: 'yes' }).compressCache, true);

/* ------------------------------------------------------- interface sounds -- */

eq('sound: default is on', defaultState().uiSounds, true);
eq('sound: honours an explicit off', parseState({ uiSounds: false }).uiSounds, false);
eq('sound: coerces nonsense to the default', parseState({ uiSounds: 'loud' }).uiSounds, true);

/* ------------------------------------------------------------------ report -- */

console.log(`\n[fuzzy] ${passed} checks passed`);
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('[fuzzy] All tolerant-matching checks passed.');
}
