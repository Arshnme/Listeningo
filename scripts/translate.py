"""Pre-generate Persian translations for the curated corpus.

Why pre-generate rather than translate on demand at runtime:

  * The bundled corpus is known at build time, so translating it now makes every
    sentence and most clicked words resolve instantly, with no network call and no
    dependency on a third-party endpoint being up while a learner is mid-session.
  * Single-word machine translation is much weaker than sentence translation, so
    the word glosses are fetched with `dt=bd`, which returns POS-tagged senses
    rather than one context-free guess.
  * It keeps runtime requests to the genuinely unseen: clips discovered live from
    the dataset, and words outside the bundled vocabulary.

Outputs one asset, `public/fa.json`, plus a small bundled core so a first run with
no network still translates the bundled clips:

  {"v": 1, "sentences": {clipId: "..."}, "words": {WORD: {"t": "...", "s": [...]}}}

Sources, in order: Google's `client=gtx` endpoint (verified to send
`Access-Control-Allow-Origin: *`, no key, no documented quota) with MyMemory as a
fallback (documented free tier, requires attribution, ~5k words/day per IP).
The client mirrors the same order at runtime.

The run is resumable: every result is written to a cache file as it arrives, so an
interruption costs nothing but the requests already in flight.
"""

import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.abspath(os.path.join(HERE, '..'))
MANIFEST = os.path.join(APP_ROOT, 'public', 'manifest.json')
OUT = os.path.join(APP_ROOT, 'public', 'fa.json')
CORE_OUT = os.path.join(APP_ROOT, 'src', 'data', 'fa-core.json')
CACHE = os.path.join(HERE, '.fa-cache.json')

# How many of the corpus's unique words to gloss up front. The measurement is:
# 8,845 canonical word forms, of which the top 800 cover 74.5% of all word
# occurrences, so this catches roughly three clicks in four with no network at all.
WORD_BUDGET = 800
# Give up after this many consecutive failures rather than retrying for hours.
MAX_CONSECUTIVE_FAILURES = 8
# The same glossary floor, plus sentence coverage, for the zero-network first run.
CORE_WORDS = 150
CORE_SENTENCES = 60

GTX = 'https://translate.googleapis.com/translate_a/single'
MYMEMORY = 'https://api.mymemory.translated.net/get'
UA = 'adaptive-listening-lab/1.0 (corpus translation pre-generation)'


def fetch_json(url, attempts=5):
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(request, timeout=25) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (429, 403):
                delay = min(60.0, 4.0 * (2 ** attempt))
            elif 500 <= exc.code < 600:
                delay = 2.0 * (attempt + 1)
            else:
                break
            time.sleep(delay)
        except Exception as exc:  # noqa: BLE001 - retry transport errors
            last = exc
            time.sleep(1.5 * (attempt + 1))
    return {'__error__': str(last)}


def translate_sentence(text):
    """Returns the Persian sentence, or None."""
    query = urllib.parse.quote(text, safe='')
    payload = fetch_json(f'{GTX}?client=gtx&sl=en&tl=fa&dt=t&q={query}')
    if isinstance(payload, list) and payload and isinstance(payload[0], list):
        parts = [chunk[0] for chunk in payload[0] if chunk and chunk[0]]
        joined = ''.join(parts).strip()
        if joined:
            return joined
    # Fallback to the documented free tier.
    payload = fetch_json(f'{MYMEMORY}?q={query}&langpair=en|fa')
    data = payload.get('responseData') if isinstance(payload, dict) else None
    if isinstance(data, dict):
        text_out = (data.get('translatedText') or '').strip()
        if text_out and 'MYMEMORY WARNING' not in text_out.upper():
            return text_out
    return None


PERSIAN_SCRIPT = re.compile(r'[؀-ۿ]')


def is_echo(source, translation):
    """True when the service handed the input straight back.

    That is what happens for text it cannot translate: proper-noun soup
    ("A MONTFICHET A MONTFICHET GAMEWELL TO THE RESCUE"), word salad the corpus
    itself mangled, and one LibriSpeech utterance that is genuinely Italian
    ("IL POPOLO E UNA BESTIA"). An echo is the service saying "no translation",
    so it must not be stored as though it were one.
    """
    def tokens(value):
        return {
            word
            for word in re.sub(r'[^a-z0-9 ]', ' ', (value or '').lower()).split()
            if len(word) > 1
        }

    # A translation into Persian must contain Persian script. When it does not,
    # the service failed and handed the input back - which is exactly what the
    # near-miss cases looked like ("THEE STUDY MEDICINE" -> "THE STUDY MEDICINE").
    # This is decisive in a way no similarity threshold can be.
    if not PERSIAN_SCRIPT.search(translation or ''):
        return True

    src = tokens(source)
    if not src:
        return False
    out = tokens(translation)
    # No Latin words survived: a real translation into Persian script.
    if not out:
        return False
    # Mostly the same words means the service handed the input back with a word
    # or two tidied. An exact comparison misses those, and they would otherwise
    # ship as "translations" showing English under a Persian heading.
    shared = len(src & out) / len(src)
    return shared >= 0.7


# A handful of words where Persian genuinely has no word-level equivalent, because
# the English word carries only grammar. These are grammatical facts stated in
# standard Persian terminology, not translations, and are the only entries here
# not produced by the translation service.
GRAMMATICAL_NOTES = {
    'THE': 'حرف تعریف معین',
    'AN': 'حرف تعریف نامعین',
    'O': 'حرف ندا',
}


def sanitize_gloss(gloss, word=None):
    """Drops encyclopaedic definitions, keeping word-level equivalents.

    A lookup for the pronoun *I* returns "the ninth letter of the English
    alphabet" among its senses; a learner reading a sentence does not want that.
    """
    def usable(term):
        # Must match the client's sanitizer: three words and 24 characters. A
        # single threshold is not enough - the bogus sense for *I* sat exactly on
        # a 4-word/28-character boundary.
        term = (term or '').strip()
        return 0 < len(term) <= 24 and len(term.split()) <= 3

    senses = []
    for sense in gloss.get('s', []):
        kept = [g for g in sense.get('g', []) if usable(g)]
        if kept:
            senses.append({'p': sense.get('p', ''), 'g': kept})

    # An echoed primary means the service handed the word back untranslated,
    # which happens for function words and proper nouns. Dropping it lets a real
    # sense take over instead of showing English under a Persian heading.
    raw_primary = gloss.get('t', '')
    echoed = word is not None and raw_primary.strip().lower() == word.strip().lower()
    primary = raw_primary if usable(raw_primary) and not echoed else ''
    if primary:
        return {'t': primary, 's': senses}
    # A long primary is a definition, not an equivalent. Prefer any short sense,
    # and only then fall back to the definition itself - which the UI labels as
    # such, because for a function word like "TO" a grammatical note is the
    # honest answer rather than a fabricated one-word equivalent.
    first = senses[0]['g'][0] if senses else None
    if first:
        return {'t': first, 's': senses}
    note = GRAMMATICAL_NOTES.get((word or '').strip().upper())
    if note:
        return {'t': note, 's': []}
    # Nothing usable: report no gloss rather than echoing the English word back.
    return {'t': '', 's': []}


def translate_word(word):
    """Returns `{t: primary, s: [{p: pos, g: [glosses]}]}` or None."""
    query = urllib.parse.quote(word, safe='')
    payload = fetch_json(f'{GTX}?client=gtx&sl=en&tl=fa&dt=t&dt=bd&q={query}')

    primary = None
    senses = []
    if isinstance(payload, list):
        if payload and isinstance(payload[0], list):
            parts = [chunk[0] for chunk in payload[0] if chunk and chunk[0]]
            joined = ''.join(parts).strip()
            primary = joined or None
        if len(payload) > 1 and isinstance(payload[1], list):
            for entry in payload[1][:3]:
                if not isinstance(entry, list) or len(entry) < 2:
                    continue
                pos = entry[0] if isinstance(entry[0], str) else ''
                terms = entry[1] if isinstance(entry[1], list) else []
                glosses = [t for t in terms if isinstance(t, str) and t.strip()][:4]
                if glosses:
                    senses.append({'p': pos, 'g': glosses})
    if primary:
        return {'t': primary, 's': senses}

    payload = fetch_json(f'{MYMEMORY}?q={query}&langpair=en|fa')
    data = payload.get('responseData') if isinstance(payload, dict) else None
    if isinstance(data, dict):
        text_out = (data.get('translatedText') or '').strip()
        if text_out and 'MYMEMORY WARNING' not in text_out.upper():
            return {'t': text_out, 's': []}
    return None


def main():
    with io.open(MANIFEST, encoding='utf-8') as handle:
        clips = json.load(handle)

    # Frequency-ranked vocabulary, so a truncated run still covers the commonest
    # words first.
    counts = Counter()
    for clip in clips:
        for token in clip['text'].upper().split():
            cleaned = re.sub(r"[^A-Z']", '', token)
            if cleaned:
                counts[cleaned] += 1
    vocabulary = [word for word, _ in counts.most_common(WORD_BUDGET)]

    cache = {'sentences': {}, 'words': {}}
    if os.path.isfile(CACHE):
        with io.open(CACHE, encoding='utf-8') as handle:
            cache = json.load(handle)
        print(f'  resuming: {len(cache["sentences"])} sentences, {len(cache["words"])} words', file=sys.stderr)

    # `--emit-only` rebuilds the assets from whatever is already cached. Useful
    # after the manifest changes: the corpus may have grown, but the translations
    # already paid for remain valid and should ship without touching the network.
    emit_only = '--emit-only' in sys.argv
    if emit_only:
        print('  emit-only: no network calls', file=sys.stderr)

    def save():
        with io.open(CACHE, 'w', encoding='utf-8', newline='\n') as handle:
            json.dump(cache, handle, ensure_ascii=False)

    # --- sentences -------------------------------------------------------
    pending = [c for c in clips if c['id'] not in cache['sentences']]
    print(f'  sentences: {len(pending)} to fetch', file=sys.stderr)
    consecutive_failures = 0
    for index, clip in enumerate(pending):
        if emit_only:
            break

        result = translate_sentence(clip['text'])
        if result:
            cache['sentences'][clip['id']] = result
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            # A run of failures means the endpoint is throttling this address, not
            # that these particular clips are untranslatable. Without this the loop
            # grinds through retry backoffs for hours making no progress; stopping
            # early keeps the cached work and reports honestly.
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                save()
                print(
                    f'  stopping: {consecutive_failures} consecutive failures - the endpoint is '
                    f'throttling this address. Cached work is kept; re-run to resume.',
                    file=sys.stderr,
                )
                break
        if index % 25 == 0:
            save()
            print(f'    {index}/{len(pending)}', file=sys.stderr)
        time.sleep(0.18)
    save()

    # --- words -----------------------------------------------------------
    # Sentences first, then the glossary: the glossary is fetched with two
    # services per call and is the likelier half to hit a quota.
    pending_words = [w for w in vocabulary if w not in cache['words']]
    print(f'  words: {len(pending_words)} to fetch', file=sys.stderr)
    consecutive_failures = 0
    for index, word in enumerate(pending_words):
        if emit_only:
            break

        result = translate_word(word)
        if result:
            cache['words'][word] = result
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                save()
                print(
                    f'  stopping: {consecutive_failures} consecutive failures - throttled.',
                    file=sys.stderr,
                )
                break
        if index % 25 == 0:
            save()
            print(f'    {index}/{len(pending_words)}', file=sys.stderr)
        time.sleep(0.18)
    save()

    missing_sentences = [
        c['id']
        for c in clips
        if c['id'] not in cache['sentences'] or is_echo(c['text'], cache['sentences'][c['id']])
    ]
    print(
        f'  done: {len(cache["sentences"])} sentences, {len(cache["words"])} words '
        f'({len(missing_sentences)} sentences unresolved)',
        file=sys.stderr,
    )

    words = {
        word: sanitize_gloss(gloss, word)
        for word, gloss in cache['words'].items()
    }
    words = {word: gloss for word, gloss in words.items() if gloss['t'] or gloss['s']}
    asset = {
        'v': 1,
        'source': 'Google gtx / MyMemory (machine translation)',
        'sentences': {
            c['id']: cache['sentences'][c['id']]
            for c in clips
            if c['id'] in cache['sentences'] and not is_echo(c['text'], cache['sentences'][c['id']])
        },
        'words': words,
    }
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(asset, handle, ensure_ascii=False, separators=(',', ':'))

    # Zero-network core: the bundled clips plus the most frequent words.
    core_clip_ids = []
    try:
        with io.open(os.path.join(APP_ROOT, 'src', 'data', 'manifest.generated.json'), encoding='utf-8') as handle:
            core_clip_ids = [c['id'] for c in json.load(handle)]
    except Exception:  # noqa: BLE001 - core manifest is optional here
        core_clip_ids = [c['id'] for c in clips[:CORE_SENTENCES]]

    core_vocabulary = [w for w in vocabulary[:CORE_WORDS] if w in cache['words']]
    core_sources = {c['id']: c['text'] for c in clips}
    core = {
        'v': 1,
        'sentences': {
            cid: cache['sentences'][cid]
            for cid in core_clip_ids
            if cid in cache['sentences']
            and not is_echo(core_sources.get(cid, ''), cache['sentences'][cid])
        },
        'words': {w: words[w] for w in core_vocabulary},
    }
    with io.open(CORE_OUT, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(core, handle, ensure_ascii=False, separators=(',', ':'))

    def size(path):
        return os.path.getsize(path) / 1024

    print(
        f'\nwrote {size(OUT):.0f} KB -> {OUT}\nwrote {size(CORE_OUT):.0f} KB -> {CORE_OUT}',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
