/**
 * Text normalisation for dictation scoring.
 *
 * LibriSpeech transcripts are already normalised by the corpus authors: they
 * contain no digits (numbers are spelled out) and use `'` for both possessives
 * (`ALEXANDER'S`) and contractions (`AREN'T`). That makes naive contraction
 * expansion wrong, so the canonical form simply *joins* apostrophe words and
 * number expansion is applied to the learner's free text instead.
 */

const APOSTROPHES = /[\u2018\u2019\u02BC\uFF07`]/g;

/** Unambiguous contractions, used only to build the optional expanded variant. */
const CONTRACTIONS: Readonly<Record<string, string>> = {
  "aren't": 'are not',
  "can't": 'can not',
  "couldn't": 'could not',
  "didn't": 'did not',
  "doesn't": 'does not',
  "don't": 'do not',
  "hadn't": 'had not',
  "hasn't": 'has not',
  "haven't": 'have not',
  "he'd": 'he would',
  "he'll": 'he will',
  "he's": 'he is',
  "how's": 'how is',
  "i'd": 'i would',
  "i'll": 'i will',
  "i'm": 'i am',
  "i've": 'i have',
  "isn't": 'is not',
  "it'd": 'it would',
  "it'll": 'it will',
  "it's": 'it is',
  "let's": 'let us',
  "mustn't": 'must not',
  "shan't": 'shall not',
  "she'd": 'she would',
  "she'll": 'she will',
  "she's": 'she is',
  "shouldn't": 'should not',
  "that's": 'that is',
  "there's": 'there is',
  "they'd": 'they would',
  "they'll": 'they will',
  "they're": 'they are',
  "they've": 'they have',
  "wasn't": 'was not',
  "we'd": 'we would',
  "we'll": 'we will',
  "we're": 'we are',
  "we've": 'we have',
  "weren't": 'were not',
  "what's": 'what is',
  "where's": 'where is',
  "who'd": 'who would',
  "who's": 'who is',
  "won't": 'will not',
  "wouldn't": 'would not',
  "you'd": 'you would',
  "you'll": 'you will',
  "you're": 'you are',
  "you've": 'you have',
};

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const ORDINALS: Readonly<Record<string, string>> = {
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth',
  '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth',
  '11th': 'eleventh', '12th': 'twelfth', '13th': 'thirteenth', '14th': 'fourteenth',
  '15th': 'fifteenth', '16th': 'sixteenth', '17th': 'seventeenth', '18th': 'eighteenth',
  '19th': 'nineteenth', '20th': 'twentieth', '30th': 'thirtieth', '40th': 'fortieth',
  '50th': 'fiftieth', '60th': 'sixtieth', '70th': 'seventieth', '80th': 'eightieth',
  '90th': 'ninetieth', '100th': 'hundredth',
};

/** Converts a non-negative integer (0..999,999,999) into spoken words. */
function intToWords(value: number): string[] {
  if (value === 0) return ['zero'];
  if (value < 0 || !Number.isFinite(value) || value > 999_999_999) return [];

  const words: string[] = [];
  const scales: readonly [number, string][] = [
    [1_000_000, 'million'],
    [1_000, 'thousand'],
    [1, ''],
  ];

  let remaining = Math.floor(value);
  for (const [scale, label] of scales) {
    const group = Math.floor(remaining / scale) % 1000;
    remaining %= scale;
    if (group === 0) continue;
    words.push(...under1000(group));
    if (label) words.push(label);
  }
  return words;

  function under1000(group: number): string[] {
    const out: string[] = [];
    const hundreds = Math.floor(group / 100);
    const rest = group % 100;
    if (hundreds > 0) {
      out.push(ONES[hundreds] ?? '', 'hundred');
    }
    if (rest === 0) return out;
    if (rest < 20) {
      out.push(ONES[rest] ?? '');
    } else {
      out.push(TENS[Math.floor(rest / 10)] ?? '');
      if (rest % 10 !== 0) out.push(ONES[rest % 10] ?? '');
    }
    return out;
  }
}

/**
 * Rewrites numeric tokens as spoken words so a learner who types `10` is not
 * marked wrong against the corpus spelling `TEN`.
 */
export function expandNumbers(text: string): string {
  return text
    .split(/\s+/)
    .flatMap((token) => {
      const bare = token.replace(/[^\w.']/g, '');
      if (!bare) return [];
      const ordinal = ORDINALS[bare.toLowerCase()];
      if (ordinal) return [ordinal];
      const cleaned = bare.replace(/,/g, '');
      // Plain integers.
      if (/^\d+$/.test(cleaned)) {
        const asNumber = Number(cleaned);
        // Years and long ids read digit-by-digit in speech are not worth
        // guessing; only single groups up to 999,999,999 are expanded.
        const words = intToWords(asNumber);
        return words.length > 0 ? words : [cleaned];
      }
      // Decimals, e.g. `3.5` -> `three point five`.
      const decimal = /^(\d+)\.(\d+)$/.exec(cleaned);
      if (decimal) {
        const whole = intToWords(Number(decimal[1]));
        const fraction = [...(decimal[2] ?? '')].map((d) => ONES[Number(d)] ?? d);
        return [...whole, 'point', ...fraction];
      }
      return [bare];
    })
    .join(' ');
}

/** Splits a raw contraction token into its expanded words, when unambiguous. */
function expandContractionToken(token: string): string[] {
  const expanded = CONTRACTIONS[token];
  if (expanded) return expanded.split(' ');
  return [token];
}

/**
 * Canonical token list: lowercased, numbers spelled out, apostrophes joined
 * into their host word, everything else reduced to `[a-z0-9]`.
 */
export function canonicalTokens(input: string): string[] {
  const lowered = expandNumbers(input.normalize('NFKC').replace(APOSTROPHES, "'")).toLowerCase();
  return lowered
    .split(/\s+/)
    .map((raw) => raw.replace(/'+/g, '').replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 0);
}

/**
 * Contraction-expanded token list. Scoring takes the better of this and the
 * canonical form so both `aren't` and `are not` are accepted.
 */
export function expandedTokens(input: string): string[] {
  const lowered = expandNumbers(input.normalize('NFKC').replace(APOSTROPHES, "'")).toLowerCase();
  return lowered
    .split(/\s+/)
    .map((raw) => raw.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter((token) => token.length > 0)
    .flatMap(expandContractionToken)
    .flatMap((token) => token.split(' '))
    .map((token) => token.replace(/'+/g, '').replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 0);
}

/** Word count as a learner would count it, ignoring punctuation-only tokens. */
export function countWords(input: string): number {
  return canonicalTokens(input).length;
}

/**
 * Picks the singular or plural form of a noun for a count.
 *
 * Voice counts are a user setting, so "1" is genuinely reachable wherever a
 * count is printed — the HUD, the summary, the history list — and "1 voices"
 * reads as broken software.
 */
export function pluralWord(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
