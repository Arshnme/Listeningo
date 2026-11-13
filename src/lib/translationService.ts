'use client';

import faCore from '../data/fa-core.json';

/**
 * English → Persian translation, in three layers, none of which needs an API key
 * or a server.
 *
 * 1. **Pre-generated asset.** `scripts/translate.py` translates the whole curated
 *    corpus ahead of time into `/fa.json`, and a small slice of it is bundled in
 *    the JS bundle. For the built-in corpus this means every sentence and most
 *    clicked words resolve with zero network calls and zero latency, offline
 *    included — which matters because a learner is mid-session when they need it.
 *
 * 2. **Permanent local cache** under `librispeech_fa_translations_v1`, so a word
 *    fetched once is instant forever after.
 *
 * 3. **Live fetch** for clips discovered from the dataset at runtime and for words
 *    outside the bundled glossary. Google's `client=gtx` endpoint first (no key,
 *    no documented quota, verified to send `Access-Control-Allow-Origin: *`), with
 *    MyMemory as a documented free fallback.
 *
 * Every layer degrades to "no translation available" rather than throwing, so a
 * blocked or offline network costs the learner a study aid, never a round.
 */

export interface WordSense {
  /** Part of speech, e.g. `noun`. */
  p: string;
  /** Persian glosses for that sense, most common first. */
  g: string[];
}

export interface WordGloss {
  /** Primary Persian rendering. */
  t: string;
  /** POS-tagged senses, when the source supplies them. */
  s: WordSense[];
}

interface TranslationAsset {
  v: number;
  sentences: Record<string, string>;
  words: Record<string, WordGloss>;
}

interface TranslationCache {
  sentences: Record<string, string>;
  words: Record<string, WordGloss>;
  misses: string[];
}

export const FA_CACHE_KEY = 'librispeech_fa_translations_v1';

const GTX = 'https://translate.googleapis.com/translate_a/single';
const MYMEMORY = 'https://api.mymemory.translated.net/get';
const LIVE_TIMEOUT_MS = 8000;
/** Cap the stored miss list so a hostile word set cannot grow the cache forever. */
const MAX_MISSES = 500;

/** How a result was obtained, for the provenance line in the UI. */
export type TranslationSource = 'core' | 'corpus' | 'cache' | 'live' | 'none';

/**
 * Ceilings for a usable gloss.
 *
 * Both are needed: the offending sense for *I* was "نهمین حرف الفبای انگلیسی"
 * (the ninth letter of the English alphabet) at four words and 28 characters,
 * which sits right on a single-threshold boundary. Real word-level equivalents
 * are short — "روشن کردن" (to light), "به محض اینکه" (as soon as) — so three
 * words and 24 characters keeps every genuine gloss and drops the definitions.
 */
const MAX_GLOSS_CHARS = 24;
const MAX_GLOSS_WORDS = 3;

/**
 * Drops glosses that are definitions rather than equivalents.
 *
 * A single-word lookup against a translation service happily returns things like
 * "نهمین حرف الفبای انگلیسی" for the pronoun *I* — an encyclopaedia entry about
 * the letter I, not a meaning a learner clicking a word in a sentence wants. The
 * tell is length: a usable gloss for a word being read in context is a word or a
 * short phrase, so anything past a few words is discarded.
 */
/**
 * Words where Persian has no word-level equivalent, because the English word is
 * pure grammar. Stated as grammatical facts rather than translations, and the
 * only hand-written entries in the glossary.
 */
const GRAMMATICAL_NOTES: Readonly<Record<string, string>> = {
  THE: 'حرف تعریف معین',
  AN: 'حرف تعریف نامعین',
  O: 'حرف ندا',
};

export function sanitizeGloss(gloss: WordGloss, word?: string): WordGloss {
  const usable = (term: string) => {
    const trimmed = term.trim();
    return (
      trimmed.length > 0 &&
      trimmed.length <= MAX_GLOSS_CHARS &&
      trimmed.split(/\s+/).length <= MAX_GLOSS_WORDS
    );
  };

  // An echoed primary means the service handed the word back untranslated -
  // common for function words and proper nouns. Dropping it lets a real sense
  // take over rather than showing English under a Persian heading.
  const echoed = Boolean(word) && gloss.t.trim().toLowerCase() === (word ?? '').trim().toLowerCase();
  const primary = usable(gloss.t) && !echoed ? gloss.t : '';
  const senses = gloss.s
    .map((sense) => ({ p: sense.p, g: sense.g.filter(usable) }))
    .filter((sense) => sense.g.length > 0);

  if (primary) return { t: primary, s: senses };
  // Nothing short enough: fall back to the first available sense so the learner
  // still sees a meaning, truncated rather than dropped.
  const firstSense = senses[0]?.g[0];
  if (firstSense) return { t: firstSense, s: senses };
  const note = GRAMMATICAL_NOTES[(word ?? '').trim().toUpperCase()];
  if (note) return { t: note, s: [] };
  return { t: '', s: [] };
}

const bundled: TranslationAsset = {
  v: faCore.v,
  sentences: faCore.sentences as Record<string, string>,
  words: faCore.words as Record<string, WordGloss>,
};

let corpus: TranslationAsset | null = null;
let corpusPromise: Promise<TranslationAsset | null> | null = null;
let cache: TranslationCache = { sentences: {}, words: {}, misses: [] };
let hydrated = false;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Reads the persistent layer once. Safe to call repeatedly. */
function hydrate(): void {
  if (hydrated || !isBrowser()) return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(FA_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<TranslationCache>;
    cache = {
      sentences: parsed.sentences ?? {},
      words: parsed.words ?? {},
      misses: Array.isArray(parsed.misses) ? parsed.misses.slice(-MAX_MISSES) : [],
    };
  } catch {
    cache = { sentences: {}, words: {}, misses: [] };
  }
}

function persist(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(FA_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full quota must not break a study aid; the in-memory copy still works.
  }
}

/**
 * Fetches the pre-generated corpus translations, once per page load.
 *
 * Failure is not an error: the bundled core still covers the built-in clips, and
 * anything else falls through to the live layer.
 */
export function loadTranslationCorpus(): Promise<TranslationAsset | null> {
  if (corpusPromise) return corpusPromise;
  hydrate();
  corpusPromise = (async () => {
    try {
      const response = await fetch('/fa.json');
      if (!response.ok) return null;
      const parsed = (await response.json()) as Partial<TranslationAsset>;
      if (!parsed.sentences || typeof parsed.sentences !== 'object') return null;
      corpus = {
        v: parsed.v ?? 1,
        sentences: parsed.sentences,
        words: parsed.words ?? {},
      };
      return corpus;
    } catch {
      return null;
    }
  })();
  return corpusPromise;
}

function lookupSentence(clipId: string): { value: string; source: TranslationSource } | null {
  hydrate();
  const stored = cache.sentences[clipId];
  if (stored) return { value: stored, source: 'cache' };
  const fromCorpus = corpus?.sentences[clipId];
  if (fromCorpus) return { value: fromCorpus, source: 'corpus' };
  const fromCore = bundled.sentences[clipId];
  if (fromCore) return { value: fromCore, source: 'core' };
  return null;
}

function lookupWord(word: string): { value: WordGloss; source: TranslationSource } | null {
  hydrate();
  const key = word.toUpperCase();
  const present = (gloss: WordGloss, source: TranslationSource) => {
    const clean = sanitizeGloss(gloss, key);
    // A gloss stripped to nothing carries no information; report a miss instead.
    return clean.t || clean.s.length > 0 ? { value: clean, source } : null;
  };
  const stored = cache.words[key];
  if (stored) return present(stored, 'cache');
  const fromCorpus = corpus?.words[key];
  if (fromCorpus) return present(fromCorpus, 'corpus');
  const fromCore = bundled.words[key];
  if (fromCore) return present(fromCore, 'core');
  return null;
}

/** Sentence translation already available locally, or null. */
export function peekSentence(clipId: string): { value: string; source: TranslationSource } | null {
  return lookupSentence(clipId);
}

/** Word gloss already available locally, or null. */
export function peekWord(word: string): { value: WordGloss; source: TranslationSource } | null {
  return lookupWord(word);
}

async function fetchWithTimeout(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function joinSentenceChunks(payload: unknown): string | null {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return null;
  const parts: string[] = [];
  for (const chunk of payload[0] as unknown[]) {
    if (Array.isArray(chunk) && typeof chunk[0] === 'string' && chunk[0].trim()) {
      parts.push(chunk[0]);
    }
  }
  const joined = parts.join('').trim();
  return joined.length > 0 ? joined : null;
}

/**
 * True when the service returned the input unchanged.
 *
 * That is how these endpoints say "I cannot translate this": proper-noun soup,
 * garbled corpus text, or the one LibriSpeech utterance that is actually Italian
 * ("IL POPOLO E UNA BESTIA"). Storing an echo as a translation would show the
 * learner English under a Persian heading, so it is treated as a miss.
 */
function isEcho(source: string, translation: string): boolean {
  // A translation into Persian must contain Persian script. When it does not, the
  // service failed and handed the input back, which is what the near-misses looked
  // like ("THEE STUDY MEDICINE" became "THE STUDY MEDICINE"). Decisive in a way no
  // similarity threshold can be.
  if (!/[؀-ۿ]/.test(translation)) return true;

  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 1),
    );
  const sourceTokens = tokens(source);
  if (sourceTokens.size === 0) return false;
  const outputTokens = tokens(translation);
  // No Latin words survived, so this really is a translation into Persian script.
  if (outputTokens.size === 0) return false;
  // Mostly the same words means the service handed the input back with a word or
  // two tidied up. Comparing for exact equality missed those, and they would ship
  // as translations showing English under a Persian heading.
  let shared = 0;
  for (const token of sourceTokens) {
    if (outputTokens.has(token)) shared += 1;
  }
  return shared / sourceTokens.size >= 0.7;
}

async function myMemory(query: string): Promise<string | null> {
  const payload = (await fetchWithTimeout(
    `${MYMEMORY}?q=${encodeURIComponent(query)}&langpair=en|fa`,
  )) as { responseData?: { translatedText?: string } } | null;
  const text = payload?.responseData?.translatedText?.trim();
  if (!text || text.toUpperCase().includes('MYMEMORY WARNING')) return null;
  return text;
}

/**
 * Translates one sentence live.
 *
 * Returns null rather than throwing on every failure path, so the caller can show
 * an "unavailable" state instead of an error.
 */
export async function translateSentenceLive(text: string): Promise<string | null> {
  const query = encodeURIComponent(text);
  const payload = await fetchWithTimeout(
    `${GTX}?client=gtx&sl=en&tl=fa&dt=t&q=${query}`,
  );
  const direct = joinSentenceChunks(payload);
  if (direct) return direct;
  return myMemory(text);
}

/** Translates one word live, preferring POS-tagged senses over a single guess. */
export async function translateWordLive(word: string): Promise<WordGloss | null> {
  const payload = await fetchWithTimeout(
    `${GTX}?client=gtx&sl=en&tl=fa&dt=t&dt=bd&q=${encodeURIComponent(word)}`,
  );
  const primary = joinSentenceChunks(payload);
  const senses: WordSense[] = [];
  if (Array.isArray(payload) && Array.isArray(payload[1])) {
    for (const entry of (payload[1] as unknown[]).slice(0, 3)) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const pos = typeof entry[0] === 'string' ? entry[0] : '';
      const terms = Array.isArray(entry[1]) ? (entry[1] as unknown[]) : [];
      const glosses = terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 4);
      if (glosses.length > 0) senses.push({ p: pos, g: glosses });
    }
  }
  if (primary) return sanitizeGloss({ t: primary, s: senses });

  const fallback = await myMemory(word);
  return fallback ? sanitizeGloss({ t: fallback, s: [] }) : null;
}

/**
 * Resolves a sentence translation, using the local layers when possible.
 *
 * `preferLocal` exists so the UI can render instantly from a local hit and only
 * reach for the network when it genuinely has nothing.
 */
export async function resolveSentence(
  clipId: string,
  english: string,
): Promise<{ value: string; source: TranslationSource } | null> {
  const local = lookupSentence(clipId);
  if (local) return local;
  const live = await translateSentenceLive(english);
  if (!live || isEcho(english, live)) return null;
  cache.sentences[clipId] = live;
  persist();
  return { value: live, source: 'live' };
}

/** Resolves a word gloss, using the local layers when possible. */
export async function resolveWord(
  word: string,
): Promise<{ value: WordGloss; source: TranslationSource } | null> {
  const key = word.toUpperCase();
  const local = lookupWord(key);
  if (local) return local;
  // A word already known to be untranslatable is not retried on every click.
  if (cache.misses.includes(key)) return null;

  const live = await translateWordLive(key);
  if (!live || live.t.trim().toLowerCase() === key.toLowerCase()) {
    cache.misses = [...cache.misses, key].slice(-MAX_MISSES);
    persist();
    return null;
  }
  cache.words[key] = live;
  persist();
  return { value: live, source: 'live' };
}

/** How much of the corpus is pre-translated, for the Settings readout. */
export function translationStats(): {
  bundledSentences: number;
  bundledWords: number;
  cachedSentences: number;
  cachedWords: number;
  corpusLoaded: boolean;
} {
  hydrate();
  return {
    bundledSentences: Object.keys(bundled.sentences).length,
    bundledWords: Object.keys(bundled.words).length,
    cachedSentences: Object.keys(cache.sentences).length,
    cachedWords: Object.keys(cache.words).length,
    corpusLoaded: corpus !== null,
  };
}

/**
 * Splits a transcript into display tokens, preserving the original spelling.
 *
 * LibriSpeech text is uppercased with no punctuation, and apostrophes are real
 * (possessives and contractions), so a token may contain one.
 */
export function transcriptTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ''))
    .filter((token) => token.length > 0);
}
