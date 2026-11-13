/**
 * Tolerant word matching for dictation.
 *
 * A learner typing what they hear should not lose points for spelling. Two
 * mechanisms run together, because each catches a class of error the other cannot:
 *
 * 1. **Orthographic closeness.** "goverment" for "government" is one deletion;
 *    "recieve" for "receive" is one transposition. Tolerance scales with word
 *    length and the leading letter must survive, because a first-letter flip
 *    changes the word ("table"/"cable") rather than misspelling it.
 *
 * 2. **Phonetic equivalence.** This is a listening exercise, so the decisive
 *    question is usually "does this sound the same". Measured against the corpus,
 *    "write" and "right" are *four* edits apart — orthographic similarity cannot
 *    reach them — yet no learner can tell them apart by ear. A phonetic key
 *    collapses a word to how it is pronounced and accepts that pair, along with
 *    their/there, sea/see, knight/night, phone/fone and bare/bear.
 *
 * The key deliberately keeps the word's **first vowel**. An earlier version
 * dropped every vowel, which made "cat" and "cut" — different words with
 * different stressed vowels — indistinguishable, and let them match.
 */

const PHONETIC_MAX_LENGTH = 6;
const VOWELS = 'AEIOU';

/**
 * A Metaphone-flavoured phonetic key: first letter, stressed vowel, then the
 * consonant skeleton.
 *
 * Not the full published algorithm — just the rules that change the sound of
 * English often enough to matter for dictation, applied in the order they must be
 * (digraphs before context-sensitive letters, and both before vowel handling).
 */
export function phoneticKey(input: string): string {
  let word = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (word.length === 0) return '';
  // A trailing silent E never changes the sound of the word.
  if (word.length > 3 && word.endsWith('E')) word = word.slice(0, -1);

  word = word
    // Silent leading clusters: knee, gnome, pneumonia, write, psalm.
    .replace(/^(KN|GN|PN|WR|PS|PT)/, (match) => match.slice(1))
    .replace(/^WH/, 'W')
    .replace(/^X/, 'Z')
    // Final -ough/-augh is an F sound: laugh, cough, tough.
    .replace(/(A|O)UGH$/, '$1F')
    // GH is otherwise silent after a vowel: right, night, though, daughter.
    .replace(/([AEIOU])GH/g, '$1')
    .replace(/GH$/, '')
    .replace(/TION|SION/g, 'XN')
    .replace(/TCH/g, 'X')
    .replace(/CH|SH/g, 'X')
    .replace(/TH/g, '0')
    .replace(/PH/g, 'F')
    .replace(/DG/g, 'J')
    .replace(/CK/g, 'K')
    .replace(/QU/g, 'K')
    // Soft C before a front vowel, hard C elsewhere.
    .replace(/C(?=[EIY])/g, 'S')
    .replace(/C/g, 'K')
    .replace(/Q/g, 'K')
    .replace(/X/g, 'KS')
    .replace(/V/g, 'F')
    .replace(/Z/g, 'S')
    .replace(/Y/g, 'I');

  if (word.length === 0) return '';

  const first = word[0] ?? '';
  const tail = word.slice(1);
  const vowelIndex = [...tail].findIndex((letter) => VOWELS.includes(letter));

  let key: string;
  if (vowelIndex === -1) {
    // No vowel after the first letter: the consonant skeleton is the whole word.
    key = first + tail;
  } else {
    const vowel = tail[vowelIndex] ?? '';
    const afterVowel = tail.slice(vowelIndex + 1).replace(/[AEIOU]/g, '');
    key = first + vowel + afterVowel;
  }

  return key.replace(/(.)\1+/g, '$1').slice(0, PHONETIC_MAX_LENGTH);
}

/** Levenshtein distance between two short strings, iterating over the shorter. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  let previous = new Array<number>(short.length + 1);
  let current = new Array<number>(short.length + 1);
  for (let i = 0; i <= short.length; i += 1) previous[i] = i;

  for (let j = 1; j <= long.length; j += 1) {
    current[0] = j;
    for (let i = 1; i <= short.length; i += 1) {
      const cost = short[i - 1] === long[j - 1] ? 0 : 1;
      current[i] = Math.min(
        (previous[i - 1] ?? 0) + cost,
        (previous[i] ?? 0) + 1,
        (current[i - 1] ?? 0) + 1,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[short.length] ?? long.length;
}

export type WordMatch = 'exact' | 'similar' | 'different';

/** Edit-distance allowance for a word of this length. */
function toleranceFor(length: number): number {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  if (length <= 12) return 3;
  return 4;
}

/** The shortest word that may be matched phonetically rather than exactly. */
const MIN_PHONETIC_LENGTH = 3;
/** The shortest word that gets any orthographic slack at all. */
const MIN_ORTHOGRAPHIC_LENGTH = 4;

/**
 * Decides how closely two tokens correspond.
 *
 * Returns `similar` when the learner clearly wrote the right word but spelled it
 * differently, which the scorer treats as correct and the UI paints amber.
 */
export function matchWord(expected: string, actual: string): WordMatch {
  if (expected === actual) return 'exact';
  if (expected.length === 0 || actual.length === 0) return 'different';

  const longest = Math.max(expected.length, actual.length);
  const shortest = Math.min(expected.length, actual.length);

  // Homophones, including those whose silent first letter differs (knight/night).
  // Key equality is itself a strong constraint: same opening sound, same stressed
  // vowel, same consonant skeleton. It is also the only test that can accept
  // write/right, which sit four edits apart.
  const expectedKey = phoneticKey(expected);
  if (
    shortest >= MIN_PHONETIC_LENGTH &&
    expectedKey.length > 0 &&
    expectedKey === phoneticKey(actual)
  ) {
    return 'similar';
  }

  // Short words sit in a dense neighbourhood (cat/cut/cot/kit), so they must be
  // written exactly. Judged on the *expected* word's length, not the longer of the
  // two: otherwise padding a three-letter word out to four ("was" -> "wass")
  // would escape the guard entirely. Homophones had their chance above.
  if (expected.length < MIN_ORTHOGRAPHIC_LENGTH) return 'different';

  const distance = editDistance(expected, actual);
  if (distance > toleranceFor(longest)) return 'different';
  if (distance / longest > 0.34) return 'different';
  // A different opening letter means a different word, not a spelling slip.
  if (expected[0] !== actual[0]) return 'different';

  return 'similar';
}

/** True when two tokens should be treated as the same word for scoring. */
export function isSameWord(expected: string, actual: string): boolean {
  return matchWord(expected, actual) !== 'different';
}
