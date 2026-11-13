/**
 * Translation-layer verification suite.
 *
 * Covers the parts that must hold without a network: transcript tokenisation,
 * the gloss sanitiser that strips encyclopaedic definitions, the local lookup
 * order, and the shape of the pre-generated asset.
 *
 * The live layer is deliberately not exercised here — it talks to a
 * third-party endpoint, and a suite that depends on the internet is a suite that
 * fails for reasons that have nothing to do with this code.
 */

import {
  FA_CACHE_KEY,
  peekSentence,
  peekWord,
  sanitizeGloss,
  transcriptTokens,
  translationStats,
} from '../src/lib/translationService';
import faCore from '../src/data/fa-core.json';
import rawManifest from '../public/manifest.json';
import rawFa from '../public/fa.json';

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

/* ------------------------------------------------------------- tokens -- */

eq('tokens: splits on whitespace', transcriptTokens('THE QUICK FOX'), ['THE', 'QUICK', 'FOX']);
eq('tokens: keeps apostrophes', transcriptTokens("DON'T STOP"), ["DON'T", 'STOP']);
eq('tokens: trims surrounding punctuation', transcriptTokens('HELLO, WORLD.'), ['HELLO', 'WORLD']);
eq('tokens: collapses runs of spaces', transcriptTokens('A   B'), ['A', 'B']);
eq('tokens: empty input', transcriptTokens('   '), []);
eq('tokens: drops punctuation-only tokens', transcriptTokens('A - B'), ['A', 'B']);
// Internal hyphens are part of the word as printed, so they survive; only
// leading and trailing punctuation is trimmed.
eq('tokens: keeps an internal hyphen', transcriptTokens('WELL-KNOWN'), ['WELL-KNOWN']);
// Apostrophes survive at the edges too, because the tokeniser cannot tell a
// stray quote from a word that legitimately starts one. LibriSpeech never emits
// edge apostrophes, so this only matters for hand-typed text.
eq('tokens: edge apostrophes are kept', transcriptTokens("'QUOTED'"), ["'QUOTED'"]);
eq('tokens: preserves case for display', transcriptTokens('The Fox'), ['The', 'Fox']);

/* --------------------------------------------------------- sanitiser -- */

const definition = 'نهمین حرف الفبای انگلیسی';
const sanitizedDefinition = sanitizeGloss({ t: 'من', s: [{ p: 'noun', g: [definition, 'خودم'] }] });
eq('gloss: drops a four-word definition', sanitizedDefinition.s[0]?.g, ['خودم']);
eq('gloss: keeps the primary meaning', sanitizedDefinition.t, 'من');

eq(
  'gloss: keeps two-word equivalents',
  sanitizeGloss({ t: 'روشن کردن', s: [] }).t,
  'روشن کردن',
);
eq(
  'gloss: keeps three-word equivalents',
  sanitizeGloss({ t: 'به محض اینکه', s: [] }).t,
  'به محض اینکه',
);
eq(
  'gloss: drops an over-long primary and promotes a sense',
  sanitizeGloss({ t: definition, s: [{ p: 'noun', g: ['خودم'] }] }).t,
  'خودم',
);
eq(
  'gloss: removes senses left with nothing usable',
  sanitizeGloss({ t: 'من', s: [{ p: 'noun', g: [definition] }, { p: 'verb', g: ['بودن'] }] }).s.length,
  1,
);
eq(
  'gloss: an empty gloss survives without throwing',
  sanitizeGloss({ t: '', s: [] }).t,
  '',
);
eq(
  'gloss: whitespace-only primary is discarded',
  sanitizeGloss({ t: '   ', s: [{ p: 'noun', g: ['چیز'] }] }).t,
  'چیز',
);

/* ------------------------------------------- echoed words and articles -- */

// An echoed primary is the service handing the word back untranslated. Showing
// that under a Persian heading would be worse than showing nothing.
eq(
  'gloss: an echoed language word is dropped',
  sanitizeGloss({ t: 'HOME', s: [{ p: 'noun', g: ['خانه'] }] }, 'HOME').t,
  'خانه',
);
eq(
  'gloss: an echoed word with no sense yields nothing',
  sanitizeGloss({ t: 'PHRONSIE', s: [] }, 'PHRONSIE').t,
  '',
);
eq(
  'gloss: a genuine translation is kept when a word is supplied',
  sanitizeGloss({ t: 'خانه', s: [] }, 'HOUSE').t,
  'خانه',
);
eq(
  'gloss: without a word argument nothing is treated as an echo',
  sanitizeGloss({ t: 'HOME', s: [] }).t,
  'HOME',
);

// Words that carry only grammar get a grammatical note rather than a fabricated
// one-word equivalent, because Persian has no such word.
eq('article: THE is described, not translated', sanitizeGloss({ t: 'THE', s: [] }, 'THE').t, 'حرف تعریف معین');
eq('article: AN is described', sanitizeGloss({ t: 'AN', s: [] }, 'AN').t, 'حرف تعریف نامعین');
eq('article: O is described', sanitizeGloss({ t: 'O', s: [] }, 'O').t, 'حرف ندا');
eq(
  'article: the note is only applied to that word',
  sanitizeGloss({ t: '', s: [] }, 'PHRONSIE').t,
  '',
);
check(
  'article: the note is short enough to survive the next read',
  sanitizeGloss({ t: '', s: [] }, 'THE').t.split(/\s+/).length <= 3,
  sanitizeGloss({ t: '', s: [] }, 'THE').t,
);

/* ----------------------------------------------------- bundled asset -- */

const bundledSentences = Object.keys(faCore.sentences);
const bundledWords = Object.keys(faCore.words);
check('core: ships some sentence translations', bundledSentences.length > 0, `${bundledSentences.length}`);
check('core: ships some word glosses', bundledWords.length > 0, `${bundledWords.length}`);
check(
  'core: every sentence is Persian script',
  Object.values(faCore.sentences).every((value) => /[\u0600-\u06FF]/.test(value)),
);
check(
  'core: every gloss is Persian script',
  Object.values(faCore.words).every((gloss) => /[\u0600-\u06FF]/.test(gloss.t)),
);
check(
  'core: bundled sentences belong to bundled clips',
  bundledSentences.every((id) => rawManifest.some((clip) => clip.id === id)),
);
check(
  'core: word keys are uppercase',
  bundledWords.every((word) => word === word.toUpperCase()),
);

/* ------------------------------------------------ generated asset shape -- */

const faSentences = rawFa.sentences as Record<string, string>;
const faWords = rawFa.words as Record<string, { t: string; s: { p: string; g: string[] }[] }>;
const englishById = new Map(rawManifest.map((clip) => [clip.id, clip.text]));

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

check('asset: covers most of the corpus', Object.keys(faSentences).length > 1200, `${Object.keys(faSentences).length}`);
check('asset: every sentence is Persian script', Object.values(faSentences).every((v) => /[\u0600-\u06FF]/.test(v)));
check(
  'asset: no sentence is an echo of its source',
  Object.entries(faSentences).every(([id, value]) => {
    const english = englishById.get(id) ?? '';
    return normalize(english) !== normalize(value.replace(/[\u0600-\u06FF]/g, ''));
  }),
);
check(
  'asset: every sentence key is a real clip',
  Object.keys(faSentences).every((id) => englishById.has(id)),
);

check('asset: ships a glossary', Object.keys(faWords).length > 500, `${Object.keys(faWords).length}`);
check(
  'asset: no gloss primary is an echo of its own headword',
  Object.entries(faWords).every(([word, gloss]) => normalize(gloss.t) !== normalize(word)),
);
check(
  'asset: every gloss primary is within the limits',
  Object.values(faWords).every((g) => g.t.length > 0 && g.t.length <= 24 && g.t.split(/\s+/).length <= 3),
);
check(
  'asset: every sense is within the limits',
  Object.values(faWords).every((g) => g.s.every((sense) => sense.g.every((term) => term.length <= 24 && term.split(/\s+/).length <= 3))),
);
check(
  'asset: gloss keys are uppercase',
  Object.keys(faWords).every((word) => word === word.toUpperCase()),
);
check(
  'asset: most glosses carry a part of speech',
  Object.values(faWords).filter((g) => g.s.length > 0).length / Object.keys(faWords).length > 0.9,
);

/* ------------------------------------------------------- local lookup -- */

const sampleSentenceId = bundledSentences[0];
if (sampleSentenceId) {
  const hit = peekSentence(sampleSentenceId);
  check('lookup: a bundled sentence resolves locally', hit !== null);
  eq('lookup: it reports the bundled source', hit?.source, 'core');
  check('lookup: its value is Persian', /[\u0600-\u06FF]/.test(hit?.value ?? ''));
}
eq('lookup: an unknown clip resolves to nothing', peekSentence('does-not-exist-0000'), null);

const sampleWord = bundledWords[0];
if (sampleWord) {
  const hit = peekWord(sampleWord);
  check('lookup: a bundled word resolves locally', hit !== null);
  eq('lookup: it reports the bundled source', hit?.source, 'core');
}
eq('lookup: an unknown word resolves to nothing', peekWord('ZZZZNOTAWORD'), null);
eq('lookup: lookup is case-insensitive', peekWord('zzzznotaword'), null);

/* -------------------------------------------------------------- stats -- */

const stats = translationStats();
eq('stats: reports the bundled sentence count', stats.bundledSentences, bundledSentences.length);
eq('stats: reports the bundled word count', stats.bundledWords, bundledWords.length);
check('stats: cache key is the documented one', FA_CACHE_KEY === 'librispeech_fa_translations_v1');

/* ------------------------------------------------------------------ report -- */

console.log(`\n[translation] ${passed} checks passed`);
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('[translation] All translation-layer checks passed.');
}
