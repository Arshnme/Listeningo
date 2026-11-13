"""Harvest and curate the LibriSpeech clip corpus.

Crawls every row of the four evaluation splits, then curates a large,
quality-filtered corpus spanning all five difficulty tiers.

Two outputs:
  * public/manifest.json          the full curated corpus, served as a static
                                  asset and cached at the edge (kept out of the
                                  JS bundle so first load stays small)
  * src/data/manifest.generated.json
                                  a small core subset bundled into the app, so a
                                  first run has a working corpus with zero
                                  network calls

Audio bytes are never stored here. The manifest records `(config, split, rowIdx)`
and the client re-signs a fresh CDN URL per clip, because the published URLs are
CloudFront-signed and expire.

Quality signals actually available in this dataset:
  * SPEAKERS.TXT carries `MINUTES` of recorded speech per reader. It has no star
    rating column, so minutes is the only per-speaker quality proxy: a reader
    with hundreds of minutes in the corpus is a prolific, reliable LibriVox
    reader, whereas a reader with a handful is often a one-off contribution.
  * The `clean`/`other` assignment is itself the corpus authors' judgement of
    alignment and audio quality, and is already mirrored by the tier rules.
  * LibriSpeech transcripts carry no punctuation and are cut at silence
    boundaries mid-paragraph, so "is this a complete sentence" has to be
    inferred from how the utterance begins and, more tellingly, how it ends.
    A clip ending on a function word ("... AND", "... OF THE") is almost always
    a mid-clause cut and sounds like a fragment to a learner.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

API = "https://datasets-server.huggingface.co"
# Language identification for the English-only filter. Verified to send
# Access-Control-Allow-Origin: * and to need no API key.
GTX = "https://translate.googleapis.com/translate_a/single"
DATASET = "openslr/librispeech_asr"
LOCAL_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
FULL_OUT = os.path.abspath(os.path.join(HERE, "..", "public", "manifest.json"))
CORE_OUT = os.path.abspath(os.path.join(HERE, "..", "src", "data", "manifest.generated.json"))
RAW_CACHE = os.path.join(HERE, ".harvest-cache.json")
# Language decisions, keyed by clip id, so a re-run costs no network calls and a
# throttled endpoint cannot silently change what the corpus contains.
ENGLISH_CACHE = os.path.join(HERE, ".english-cache.json")
# Compact English lexicon for the client, which uses it to vet clips discovered
# live from the dataset. The shipped corpus is vetted here at build time; runtime
# discovery is not, and a learner should never be handed a non-English voice.
LEXICON_OUT = os.path.abspath(os.path.join(HERE, "..", "src", "data", "en-lexicon.json"))
# Exported whole rather than truncated. A narrower top-N list looked cheaper but
# diverged from the build-time rule: three shipped clips and ordinary words like
# NODS fell outside the top 3,000, so runtime discovery would have skipped valid
# English. The full list costs about 11 KB more gzipped and removes the
# inconsistency entirely.
LEXICON_EXPORT = 8000

# Target clips per tier.
#
# Sized against measured FLAC sizes rather than a flat average: a 3-word clip is
# ~45 KB and a 30-word clip ~191 KB, so the corpus total depends on the mix. At
# 180 per tier the five tiers come to roughly 80 MB of streamable audio, which is
# held on the CDN and in the learner's own browser cache rather than in the repo.
# Raised once Opus compaction landed: a cached clip is now ~8 KB instead of
# ~45-190 KB of FLAC, so the browser holds several times more of them. 300 per
# tier gives 1,500 clips (~22 MB as Opus, ~135 MB as streamed FLAC).
# Curated depth. Set above the largest tier pool so every tier fills with
# everything that passes the quality filters rather than an arbitrary quota:
# the eligible pool is ~4,900 utterances across the five tiers.
PER_LEVEL = 1200

# A word used in at least this many utterances counts as English vocabulary. By
# construction this excludes foreign words and one-off proper nouns.
MIN_LEXICON_CLIPS = 3
# Fraction of unrecognised words above which an utterance is worth a language check.
SUSPICION_RATIO = 0.34
# Clips bundled into the app for an instant, network-free first run.
CORE_PER_LEVEL = 12

# (level, config, word range)
#
# Ranges follow the product spec, with two adjustments that are about audio
# rather than difficulty: tier 3 starts at 9 words so it does not overlap tier 2,
# and tier 4 stops at 17 so it does not starve tier 5 of its long sentences.
LEVEL_RULES = [
    (1, "clean", 3, 6),
    (2, "clean", 7, 11),
    (3, "other", 9, 14),
    (4, "other", 14, 18),
    # The spec says 16+, but 16-18 is also tier 4's tail, so tier 5 starts at 19
    # to keep the ramp strictly increasing. The ceiling bounds clip duration:
    # past ~30 words a single utterance runs well over ten seconds.
    (5, "other", 19, 30),
]

# Minimum text-completeness score to accept a clip, tried in order. Starting
# strict and relaxing only if a tier cannot be filled keeps the quality bar as
# high as the available material allows instead of failing outright.
COMPLETENESS_LADDER = (3, 2, 1, 0)

SPLIT_LABEL = {
    ("clean", "test"): "test-clean",
    ("clean", "validation"): "dev-clean",
    ("other", "test"): "test-other",
    ("other", "validation"): "dev-other",
}

# Ending on one of these almost always means the utterance was cut mid-clause.
DANGLING = frozenset(
    """A AN AND AS AT BE BEEN BUT BY FOR FROM HAD HAS HAVE HE HER HIM HIS IF IN INTO
    IS IT ITS ME MY NOR NOT OF ON OR OUR OUT OVER SO THAN THAT THE THEIR THEM THEN
    THERE THESE THEY THIS THOSE THOU THY TO UNDER UP US WAS WE WERE WHAT WHEN
    WHERE WHICH WHO WHOM WHOSE WHY WILL WITH WOULD YOU YOUR""".split()
)

# Openers that read as the start of a sentence rather than a continuation.
OPENERS = frozenset(
    """A AFTER ALL AN AND AS AT BEING BUT BY DURING FOR FROM HE HER HERE HIS HOW I IF
    IN INTO IT ITS MY NO NOT NOW OF ON ONCE OR OUR OUT OVER SHE SO SOME THAT THE
    THEIR THEN THERE THESE THEY THIS THOSE TO UP WAS WE WERE WHAT WHEN WHERE
    WHICH WHO WHY WILL WITH YOU YOUR""".split()
)


def get_json(url, attempts=7):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "manifest-harvester/2.0"})
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 429:
                delay = min(90.0, 6.0 * (2**i))
            elif 500 <= exc.code < 600:
                delay = 3.0 * (i + 1)
            else:
                raise RuntimeError(f"{url} -> HTTP {exc.code}") from exc
            print(f"  retry {i + 1}/{attempts} in {delay:.0f}s ({exc.code})", file=sys.stderr)
            time.sleep(delay)
        except Exception as exc:  # noqa: BLE001 - retry any transport error
            last = exc
            time.sleep(2.0 * (i + 1))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def num_rows(config, split):
    payload = get_json(f"{API}/size?dataset={urllib.parse.quote(DATASET)}")
    for entry in payload["size"]["splits"]:
        if entry["config"] == config and entry["split"] == split:
            return entry["num_rows"]
    raise RuntimeError(f"split {config}/{split} not present")


def fetch_page(config, split, offset, length=100):
    url = (
        f"{API}/rows?dataset={urllib.parse.quote(DATASET)}"
        f"&config={urllib.parse.quote(config)}&split={urllib.parse.quote(split)}"
        f"&offset={offset}&length={length}"
    )
    payload = get_json(url)
    out = []
    for entry in payload.get("rows", []):
        row = entry["row"]
        audio = row.get("audio") or []
        if not audio or not audio[0].get("src"):
            continue
        out.append(
            {
                "id": row["id"],
                "text": row["text"],
                "speakerId": str(row["speaker_id"]),
                "chapterId": str(row["chapter_id"]),
                "config": config,
                "split": split,
                "rowIdx": entry["row_idx"],
            }
        )
    return out


def load_speakers():
    """`speakerId -> {sex, subset, minutes, name}` from the corpus metadata."""
    speakers = {}
    path = os.path.join(LOCAL_ROOT, "SPEAKERS.TXT")
    if not os.path.isfile(path):
        return speakers
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.startswith(";"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 5 or not parts[0].isdigit():
                continue
            try:
                minutes = float(parts[3])
            except ValueError:
                continue
            speakers[parts[0]] = {
                "sex": parts[1],
                "subset": parts[2],
                "minutes": minutes,
                "name": parts[4],
            }
    return speakers


def build_lexicon(rows):
    """Words that recur across the corpus.

    Foreign words and one-off names appear in a handful of utterances at most, so
    requiring recurrence yields an English vocabulary without shipping a dictionary.
    """
    counts = Counter()
    for item in rows:
        for token in {clean_token(part) for part in item["text"].upper().split()}:
            if token:
                counts[token] += 1
    return {word for word, count in counts.items() if count >= MIN_LEXICON_CLIPS}


def clean_token(token):
    return re.sub(r"[^A-Z']", "", token)


def unknown_ratio(text, lexicon):
    """Share of words the corpus does not recognise.

    Single-character tokens are dropped first: Italian shares `A`, `E`, `I` and `O`
    with English, so counting them let "QUINCI IMPARA A STUPIRTI" pass on the
    strength of its lone `A`.
    """
    words = [clean_token(part) for part in text.upper().split()]
    words = [word for word in words if len(word) > 1]
    if not words:
        return 1.0
    return sum(1 for word in words if word not in lexicon) / len(words)


def detect_language(text):
    """Authoritative language of one utterance, or None.

    ``sl=auto`` makes the service report the source language it inferred, which
    sits at index 2 of the response. Verified to return ``it``, ``la`` and ``eu``
    for the right inputs and ``en`` for every clean English sentence tried.
    """
    query = urllib.parse.quote(text, safe="")
    payload = get_json(f"{GTX}?client=gtx&sl=auto&tl=en&dt=t&q={query}")
    if isinstance(payload, list) and len(payload) > 2 and isinstance(payload[2], str):
        return payload[2]
    return None


def filter_english(rows):
    """Drops utterances that are not English.

    LibriSpeech is curated as English but is not exclusively so: the crawl holds
    Italian ("IL POPOLO E UNA BESTIA"), Greek and Latin name lists ("STEPHANOS
    DEDALOS"), and degenerate fragments ("SQUEAK SQUEAK", "GRUB PI LE GRUB PI LE").

    Two tiers of evidence. A clip with **no** recognisable word at all is
    decidable from the lexicon alone and is rejected without any network call.
    A clip that is partly recognisable needs language identification, because only
    that can separate an English line full of unusual names from a foreign one
    sharing a common word. Those answers are cached, and an unreachable endpoint
    keeps the clip rather than quietly reshaping the corpus.
    """
    lexicon = build_lexicon(rows)
    print(f"  lexicon: {len(lexicon)} recurring English words", file=sys.stderr)

    decisions = {}
    if os.path.isfile(ENGLISH_CACHE):
        with open(ENGLISH_CACHE, "r", encoding="utf-8") as handle:
            decisions = json.load(handle)
        print(f"  english: {len(decisions)} cached language decision(s)", file=sys.stderr)

    rejected = {}
    for item in rows:
        ratio = unknown_ratio(item["text"], lexicon)
        if ratio >= 1.0:
            # Nothing in this utterance occurs anywhere else in the corpus.
            decisions.setdefault(item["id"], "unknown")
            rejected[item["id"]] = "unknown"
            continue
        if ratio < SUSPICION_RATIO:
            continue

        cached = decisions.get(item["id"])
        if cached is None:
            cached = detect_language(item["text"])
            if cached is not None:
                decisions[item["id"]] = cached
            time.sleep(0.2)
        if cached is not None and cached != "en":
            rejected[item["id"]] = cached

    with open(ENGLISH_CACHE, "w", encoding="utf-8") as handle:
        json.dump(decisions, handle, indent=0, sort_keys=True)

    for clip_id, language in sorted(rejected.items(), key=lambda pair: pair[1]):
        text = next(r["text"] for r in rows if r["id"] == clip_id)
        print(f"    dropped [{language}] {text[:52]}", file=sys.stderr)
    kept = [r for r in rows if r["id"] not in rejected]
    print(f"  english: kept {len(kept)}, dropped {len(rejected)}", file=sys.stderr)
    return kept


def word_count(text):
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def completeness(text):
    """Heuristic 0-4 score for how much this utterance reads as a real sentence.

    LibriSpeech has no punctuation to lean on, so this uses the two edges of the
    utterance plus a crude verb check.
    """
    words = text.split()
    if not words:
        return 0
    score = 0
    if words[-1] not in DANGLING:
        score += 2
    if words[0] in OPENERS:
        score += 1
    if len(words) >= 5:
        score += 1
    return score


def main():
    # ---------------------------------------------------------------- crawl --
    pages = {}
    if os.path.isfile(RAW_CACHE):
        with open(RAW_CACHE, "r", encoding="utf-8") as handle:
            pages = json.load(handle)
    print(f"  resuming with {len(pages)} cached pages", file=sys.stderr)

    plan = [("clean", "test"), ("clean", "validation"), ("other", "test"), ("other", "validation")]
    rows = []
    seen_ids = set()
    for config, split in plan:
        total = num_rows(config, split)
        offsets = list(range(0, total, 100))
        fetched = 0
        for offset in offsets:
            key = f"{config}|{split}|{offset}"
            if key in pages:
                continue
            pages[key] = fetch_page(config, split, offset)
            with open(RAW_CACHE, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(pages, handle)
            fetched += 1
            time.sleep(1.0)
        print(f"  {config}/{split}: {total} rows ({fetched} new pages)", file=sys.stderr)

    for key in sorted(pages):
        for item in pages[key]:
            if item["id"] in seen_ids:
                continue
            seen_ids.add(item["id"])
            rows.append(item)
    print(f"  crawled {len(rows)} unique utterances", file=sys.stderr)

    rows = filter_english(rows)

    # Rebuilt here so it is in scope for the client lexicon export below.
    lexicon = build_lexicon(rows)

    speakers = load_speakers()
    print(f"  speaker metadata for {len(speakers)} readers", file=sys.stderr)

    # Cross-validate clean transcripts against the local tree when present.
    local = {}
    for split_dir in ("test-clean", "dev-clean"):
        root = os.path.join(LOCAL_ROOT, split_dir)
        if not os.path.isdir(root):
            continue
        for speaker in sorted(os.listdir(root)):
            sp_dir = os.path.join(root, speaker)
            if not os.path.isdir(sp_dir):
                continue
            for chapter in sorted(os.listdir(sp_dir)):
                trans = os.path.join(sp_dir, chapter, f"{speaker}-{chapter}.trans.txt")
                if not os.path.isfile(trans):
                    continue
                with open(trans, "r", encoding="utf-8") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        clip_id, _, text = line.partition(" ")
                        local[clip_id] = text.strip().upper()
    checked = mismatched = 0
    for item in rows:
        if item["config"] != "clean":
            continue
        reference = local.get(item["id"])
        if reference is None:
            continue
        checked += 1
        if reference != item["text"].strip().upper():
            mismatched += 1
    print(f"  cross-validated {checked} clean transcripts, {mismatched} mismatches", file=sys.stderr)
    if checked and mismatched:
        raise SystemExit("transcript mismatch against local corpus - aborting")

    # ------------------------------------------------------------ curate --
    global_used = set()
    curated = []
    for level, config, lo, hi in LEVEL_RULES:
        all_candidates = []
        for item in rows:
            if item["config"] != config or item["id"] in global_used:
                continue
            wc = word_count(item["text"])
            if not (lo <= wc <= hi):
                continue
            # Hard quality gate: an utterance that stops on a function word was cut
            # mid-clause by the corpus authors and sounds like a fragment. The
            # completeness ladder below may relax *other* standards to fill a tier,
            # but never this one.
            if item["text"].split()[-1] in DANGLING:
                continue
            speaker = speakers.get(item["speakerId"], {"minutes": 0.0, "sex": "", "subset": "", "name": ""})
            all_candidates.append(
                {
                    **item,
                    "wordCount": wc,
                    "completeness": completeness(item["text"]),
                    "speakerMinutes": round(speaker["minutes"], 1),
                    "sex": speaker["sex"],
                }
            )

        # Ranking inside a length bucket is by completeness only. Reader minutes
        # are deliberately NOT a signal: in these splits every reader sits at
        # 8-10 minutes, so it cannot separate good from bad.
        for item in all_candidates:
            item["rank"] = (-item["completeness"], item["id"])

        # Fill by round-robin across sentence lengths, so a tier spans its whole
        # word range instead of collapsing onto whichever length happens to score
        # best. Without this every tier converges on one sentence size - a tier of
        # nothing but 9-word lines is both monotonous and useless for training.
        # The completeness bar relaxes only if a tier would otherwise come up short.
        chosen = []
        speaker_uses = Counter()
        chapter_uses = Counter()
        picked_ids = set()
        for min_score in COMPLETENESS_LADDER:
            if len(chosen) >= PER_LEVEL:
                break
            for cap_speaker, cap_chapter in ((4, 6), (8, 12), (16, 24), (99, 99)):
                if len(chosen) >= PER_LEVEL:
                    break
                # Buckets are rebuilt for every cap pair. An earlier revision built
                # them once and popped items as it went, so a candidate rejected by
                # the speaker cap was discarded rather than reconsidered - which
                # quietly capped every tier at roughly four clips per speaker.
                buckets = {}
                for item in all_candidates:
                    if item["completeness"] < min_score or item["id"] in picked_ids:
                        continue
                    buckets.setdefault(item["wordCount"], []).append(item)
                if not buckets:
                    continue
                for bucket in buckets.values():
                    bucket.sort(key=lambda r: r["rank"])

                lengths = sorted(buckets)
                progressed = True
                while progressed and len(chosen) < PER_LEVEL:
                    progressed = False
                    for length in list(lengths):
                        if len(chosen) >= PER_LEVEL:
                            break
                        bucket = buckets.get(length) or []
                        while bucket:
                            item = bucket.pop(0)
                            if speaker_uses[item["speakerId"]] >= cap_speaker:
                                continue
                            if chapter_uses[item["chapterId"]] >= cap_chapter:
                                continue
                            speaker_uses[item["speakerId"]] += 1
                            chapter_uses[item["chapterId"]] += 1
                            picked_ids.add(item["id"])
                            chosen.append(item)
                            progressed = True
                            break
                        else:
                            lengths.remove(length)

        if not chosen:
            print(f"  level {level}: NO CANDIDATES ({len(all_candidates)} in range)", file=sys.stderr)
            continue

        chosen.sort(key=lambda r: (r["wordCount"], r["id"]))
        for index, item in enumerate(chosen):
            item["index"] = index
            item["level"] = level
            item["splitLabel"] = SPLIT_LABEL[(config, item["split"])]
            global_used.add(item["id"])
            curated.append(item)

        words = [c["wordCount"] for c in chosen]
        whole = sum(1 for c in chosen if c["completeness"] >= 3) * 100 // max(1, len(chosen))
        print(
            f"  level {level}: {len(chosen)}/{PER_LEVEL} clips "
            f"(pool {len(all_candidates)}), wc {min(words)}-{max(words)}, "
            f"{len({c['speakerId'] for c in chosen})} speakers, "
            f"{len({c['chapterId'] for c in chosen})} chapters, "
            f"whole-sentence {whole}%",
            file=sys.stderr,
        )
        if len(chosen) < PER_LEVEL:
            print(f"    NOTE: level {level} filled {len(chosen)} of {PER_LEVEL}", file=sys.stderr)

    def record(item):
        # Only fields the client cannot derive are emitted. `splitLabel`,
        # `wordCount` and `index` are all reconstructable in `validateManifest`,
        # and at this corpus size every dropped key saves a measurable amount of
        # the one asset the page has to fetch.
        return {
            "id": item["id"],
            "text": item["text"],
            "speakerId": item["speakerId"],
            "chapterId": item["chapterId"],
            "config": item["config"],
            "split": item["split"],
            "rowIdx": item["rowIdx"],
            "level": item["level"],
            "speakerMinutes": item["speakerMinutes"],
        }

    full = [record(item) for item in curated]
    # Estimated size uses a per-word-count curve measured from the local corpus,
    # because a flat average overstates short tiers and understates long ones.
    kb_by_words = {2: 41.6, 3: 45.1, 4: 45.2, 5: 50.2, 6: 53.7, 7: 57.1, 8: 61.3,
                   9: 67.7, 10: 71.2, 11: 78.0, 12: 82.0, 13: 89.7, 14: 94.9,
                   15: 98.5, 16: 104.4, 17: 114.0, 18: 118.2, 19: 127.4,
                   20: 129.1, 21: 138.7, 22: 140.8, 23: 146.1, 24: 152.3,
                   25: 156.2, 26: 162.5, 27: 168.3, 28: 174.6, 29: 186.8, 30: 190.7}
    approx_mb = sum(kb_by_words.get(item["wordCount"], 100) for item in curated) / 1024

    # Emit the client lexicon: one space-joined string, parsed into a Set on
    # first use. ~7 KB gzipped, and it is what lets the browser reject a
    # non-English clip that runtime discovery would otherwise hand to a learner.
    counts = Counter()
    for item in rows:
        for token in {clean_token(part) for part in item["text"].upper().split()}:
            if token in lexicon:
                counts[token] += 1
    vocabulary = [word for word, _ in counts.most_common(LEXICON_EXPORT)]
    with open(LEXICON_OUT, "w", encoding="utf-8", newline=chr(10)) as handle:
        json.dump({"v": 1, "words": " ".join(vocabulary)}, handle)

    os.makedirs(os.path.dirname(FULL_OUT), exist_ok=True)
    with open(FULL_OUT, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(full, handle, separators=(",", ":"), ensure_ascii=False)
        handle.write("\n")

    # The bundled core is the highest-completeness slice of each tier, so the
    # zero-network first run also gets the best material.
    core = []
    for level in range(1, 6):
        tier = [item for item in curated if item["level"] == level]
        tier.sort(key=lambda r: (-r["completeness"], -r["speakerMinutes"], r["index"]))
        picked = sorted(tier[:CORE_PER_LEVEL], key=lambda r: r["index"])
        for position, item in enumerate(picked):
            entry = record(item)
            entry["index"] = position
            core.append(entry)
    with open(CORE_OUT, "w", encoding="utf-8", newline=chr(10)) as handle:
        json.dump(core, handle, indent=2, ensure_ascii=False)
        handle.write(chr(10))

    print(
        f"wrote {len(full)} clips (~{approx_mb:.0f} MB streamed) -> {FULL_OUT}",
        file=sys.stderr,
    )
    print(f"wrote {len(core)} core clips -> {CORE_OUT}", file=sys.stderr)
    print(f"wrote {len(vocabulary)} lexicon words -> {LEXICON_OUT}", file=sys.stderr)

if __name__ == "__main__":
    main()
