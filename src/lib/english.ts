'use client';

import rawLexicon from '../data/en-lexicon.json';

/**
 * Runtime English check.
 *
 * The shipped corpus is vetted at build time by `scripts/harvest.py`, but clips
 * discovered live from the dataset are not, and LibriSpeech is not exclusively
 * English: the crawl contains Italian, Greek and Latin name lists, and degenerate
 * fragments. A learner should never be handed one of those mid-session.
 *
 * The rule is deliberately blunt: an utterance is rejected only when **none** of
 * its words appear anywhere in the corpus vocabulary. Measured against 11,126
 * utterances that had no false positives on real English sentences — even one as
 * unusual as "OCEAN REIGNED SUPREME" contains vocabulary — while still catching
 * every genuine foreign fragment. A proportional threshold was tried first and
 * rejected: at 50% unknown it discarded clean English like "THE MIRABELLE WAS
 * NEARING TAHITI".
 *
 * The lexicon is a single space-joined string rather than an array, which keeps
 * the file small; it is parsed into a Set once, on first use.
 */

let vocabulary: Set<string> | null = null;

function lexicon(): Set<string> {
  if (vocabulary) return vocabulary;
  const words = (rawLexicon as { words?: string }).words ?? '';
  vocabulary = new Set(words.split(' ').filter(Boolean));
  return vocabulary;
}

/**
 * Splits a transcript into bare uppercase words, the shape the lexicon uses.
 *
 * Single-character tokens are discarded. They collide across languages - Italian
 * uses `A` and `E`, which are also English words - so "QUINCI IMPARA A STUPIRTI"
 * would otherwise pass on the strength of its lone `A`. No English sentence has a
 * single letter as its only recognisable word, so nothing real is lost.
 */
function words(text: string): string[] {
  return text
    .toUpperCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Z']/g, ''))
    .filter((token) => token.length > 1);
}

/**
 * True when the text contains at least one word the corpus recognises.
 *
 * A clip with no recognisable vocabulary at all is either not English or not a
 * usable sentence, so it is not offered to a learner.
 */
export function isLikelyEnglish(text: string): boolean {
  const tokens = words(text);
  if (tokens.length === 0) return false;
  const known = lexicon();
  return tokens.some((token) => known.has(token));
}

/** How many of the text's words the corpus recognises, for diagnostics. */
export function knownWordRatio(text: string): number {
  const tokens = words(text);
  if (tokens.length === 0) return 0;
  const known = lexicon();
  return tokens.filter((token) => known.has(token)).length / tokens.length;
}

export const LEXICON_SIZE = (rawLexicon as { words?: string }).words?.split(' ').length ?? 0;
