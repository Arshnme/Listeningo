/**
 * Voices-per-session verification suite.
 *
 * The setting promises something exact: every stage plays the configured number
 * of voices, never more and never fewer. That promise has three independently
 * breakable halves, so each is pinned here:
 *
 *   1. **Coercion** — a persisted or hand-edited value must land on an integer
 *      inside the published bounds, or fall back to the default.
 *   2. **The session loop** — the completion check must fire on exactly round N
 *      for every legal N, with no off-by-one at either end.
 *   3. **The corpus** — a tier must actually hold at least the maximum
 *      configured count of distinct unseen clips, or "exactly N" could collide
 *      with the pool-recycling rule.
 *
 * Run with:  npm test   (which executes this among the other suites)
 */

import {
  MAX_VOICES_PER_SESSION,
  MIN_VOICES_PER_SESSION,
  ROUNDS_PER_SESSION,
  clampVoicesPerSession,
} from '../src/lib/levels';
import { ClipPool, isFinalRound, mulberry32, seedFromKey } from '../src/lib/session';
import { defaultState, exportState, importState, parseState } from '../src/lib/storage';
import { validateManifest } from '../src/lib/manifest';
import { pluralWord } from '../src/lib/text';
import { BUNDLED_AUDIO, BUNDLED_AUDIO_STATS, bundledAudioPath } from '../src/lib/localAudio';
import fs from 'node:fs';
import path from 'node:path';
import rawFull from '../public/manifest.json';
import type { DifficultyLevel } from '../src/lib/types';

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

/* -------------------------------------------------------------- coercion -- */

eq('clamp: default is five voices', clampVoicesPerSession(undefined), ROUNDS_PER_SESSION);
eq('clamp: null falls back', clampVoicesPerSession(null), ROUNDS_PER_SESSION);
eq('clamp: non-numeric string falls back', clampVoicesPerSession('many'), ROUNDS_PER_SESSION);
eq('clamp: NaN falls back', clampVoicesPerSession(Number.NaN), ROUNDS_PER_SESSION);
eq('clamp: a valid count passes through', clampVoicesPerSession(5), 5);
eq('clamp: a numeric string passes through', clampVoicesPerSession('7'), 7);
eq('clamp: a fraction rounds to an integer', clampVoicesPerSession(7.6), 8);
eq('clamp: zero cannot produce an empty session', clampVoicesPerSession(0), MIN_VOICES_PER_SESSION);
eq('clamp: negative values floor at the minimum', clampVoicesPerSession(-9), MIN_VOICES_PER_SESSION);
eq('clamp: values above the ceiling fall to the maximum', clampVoicesPerSession(999), MAX_VOICES_PER_SESSION);
eq('clamp: the minimum is exact', clampVoicesPerSession(MIN_VOICES_PER_SESSION), MIN_VOICES_PER_SESSION);
eq('clamp: the maximum is exact', clampVoicesPerSession(MAX_VOICES_PER_SESSION), MAX_VOICES_PER_SESSION);

/* ---------------------------------------------------------------- storage -- */

eq('state: a fresh profile starts at five voices', defaultState().voicesPerSession, ROUNDS_PER_SESSION);
eq('state: randomization is on by default', defaultState().randomizeLessons, true);
eq('state: randomization honours an explicit off', parseState({ randomizeLessons: false }).randomizeLessons, false);
eq('state: a legacy document defaults to randomized', parseState({ currentLevel: 2 }).randomizeLessons, true);
eq('state: a valid setting survives parsing', parseState({ voicesPerSession: 5 }).voicesPerSession, 5);
eq('state: a hostile count is clamped down', parseState({ voicesPerSession: 400 }).voicesPerSession, MAX_VOICES_PER_SESSION);
eq('state: a negative count is clamped up', parseState({ voicesPerSession: -2 }).voicesPerSession, MIN_VOICES_PER_SESSION);
eq('state: a legacy document defaults the count', parseState({ currentLevel: 3 }).voicesPerSession, ROUNDS_PER_SESSION);
eq('state: a non-numeric count defaults', parseState({ voicesPerSession: 'lots' }).voicesPerSession, ROUNDS_PER_SESSION);

const carried = parseState(importState(exportState({ ...defaultState(), voicesPerSession: 15 })).state);
eq('export/import: the setting round-trips', carried.voicesPerSession, 15);

/* ---------------------------------------------------- the exact-N session -- */

// The loop the arena runs: round i is served while isFinalRound(i) is false.
// Counting the rounds it produces must equal the configured length exactly.
function roundsProduced(total: number): number {
  let index = 0;
  let produced = 0;
  // The guard is deliberately generous; a correct loop terminates long before.
  while (index < 1000) {
    produced += 1;
    if (isFinalRound(index, total)) break;
    index += 1;
  }
  return produced;
}

for (const total of [MIN_VOICES_PER_SESSION, 2, 5, 10, 11, 20, MAX_VOICES_PER_SESSION]) {
  eq(`loop: ${total} voices produce exactly ${total} rounds`, roundsProduced(total), total);
}

eq('loop: the first round of one is already final', isFinalRound(0, 1), true);
eq('loop: round 4 of five is not final', isFinalRound(4 - 1, 5), false);
eq('loop: round 5 of five is final', isFinalRound(5 - 1, 5), true);
eq('loop: round 5 of ten is not final', isFinalRound(5 - 1, 10), false);
eq('loop: round 10 of ten is final', isFinalRound(10 - 1, 10), true);

/* --------------------------------------------------------------- plural -- */

// A one-voice session is a legal setting, so the singular form must be reachable.
eq('plural: one voice is singular', pluralWord(1, 'voice'), 'voice');
eq('plural: zero voices is plural', pluralWord(0, 'voice'), 'voices');
eq('plural: two voices is plural', pluralWord(2, 'voice'), 'voices');
eq('plural: one clip is singular', pluralWord(1, 'clip'), 'clip');
eq('plural: an explicit plural is honoured', pluralWord(2, 'person', 'people'), 'people');

/* -------------------------------------------------- deterministic lessons -- */

// One parse of the shipped corpus serves the lesson and bundle checks below,
// and the depth check further down.
const shipped = validateManifest(rawFull as unknown);

// A lesson's voices are a pure function of its identity: the same node always
// replays the same clips — across reloads, sessions and devices — while a
// different node draws a different stream.
eq('seed: stable for the same lesson key', seedFromKey('1-1|1|auto'), seedFromKey('1-1|1|auto'));
check('seed: a different node differs', seedFromKey('1-1|1|auto') !== seedFromKey('1-2|1|auto'));
check('seed: a different tier differs', seedFromKey('1-1|1|auto') !== seedFromKey('1-1|3|auto'));
check('seed: a different pool mode differs', seedFromKey('1-1|1|auto') !== seedFromKey('1-1|1|clean_only'));

const rngA = mulberry32(123);
const rngA2 = mulberry32(123);
const rngB = mulberry32(124);
const seqA = [rngA(), rngA(), rngA()];
const seqA2 = [rngA2(), rngA2(), rngA2()];
const seqB = [rngB(), rngB(), rngB()];
eq('rng: the same seed replays the same stream', seqA, seqA2);
check('rng: different seeds diverge', seqA.join() !== seqB.join());
check('rng: values stay in [0, 1)', seqA.every((value) => value >= 0 && value < 1));

const seededPool = new ClipPool(shipped);
const lessonSeed = seedFromKey('1-1|1|auto');
const firstDraw = seededPool.pick({ level: 1, mode: 'auto', exclude: new Set<string>(), seed: lessonSeed });
const firstAgain = seededPool.pick({ level: 1, mode: 'auto', exclude: new Set<string>(), seed: lessonSeed });
eq('lesson: reopening picks the same first voice', firstDraw?.clip.id, firstAgain?.clip.id);
check('lesson: the first voice is a real clip', Boolean(firstDraw?.clip.id));

const firstId = firstDraw?.clip.id ?? '';
const secondDraw = seededPool.pick({ level: 1, mode: 'auto', exclude: new Set([firstId]), seed: lessonSeed });
const secondAgain = seededPool.pick({ level: 1, mode: 'auto', exclude: new Set([firstId]), seed: lessonSeed });
check('lesson: the next voice advances past the used one', Boolean(secondDraw) && secondDraw?.clip.id !== firstId);
eq('lesson: the second voice also replays', secondDraw?.clip.id, secondAgain?.clip.id);

const otherLesson = seededPool.pick({
  level: 1,
  mode: 'auto',
  exclude: new Set<string>(),
  seed: seedFromKey('1-2|1|auto'),
});
check('lesson: a different node draws a different stream', otherLesson?.clip.id !== firstId);

/* ------------------------------------------------------- bundled audio -- */

// The corpus ships with the deployment, so every lesson is offline on first
// visit. The generated stats file, the directory on disk and the manifest must
// agree — a partial bundle would silently strand some lessons on the network.
eq('bundle: the corpus ships locally', BUNDLED_AUDIO, true);
eq('bundle: url shape', bundledAudioPath('1089-134686-0000'), '/audio/1089-134686-0000.webm');
eq('bundle: every manifest clip is covered', BUNDLED_AUDIO_STATS.clips, shipped.length);
const bundledFiles = fs
  .readdirSync(path.join(process.cwd(), 'public', 'audio'))
  .filter((name) => name.endsWith('.webm')).length;
eq('bundle: every bundled id has a file on disk', bundledFiles, BUNDLED_AUDIO_STATS.clips);
check(
  'bundle: the payload stays inside the 80 MB budget',
  BUNDLED_AUDIO_STATS.bytes < 80 * 1024 * 1024,
  `${(BUNDLED_AUDIO_STATS.bytes / (1024 * 1024)).toFixed(1)} MB`,
);

/* ------------------------------------------------------------ corpus depth -- */

// "Exactly N" must be able to hand out N *distinct* voices; a tier shallower
// than the maximum configured count would recycle the pool mid-session.
const pool = new ClipPool(shipped);

for (const level of [1, 2, 3, 4, 5] as DifficultyLevel[]) {
  const seen = new Set<string>();
  let unique = 0;
  let recycled = false;
  for (let index = 0; index < MAX_VOICES_PER_SESSION; index += 1) {
    const picked = pool.pick({ level, mode: 'auto', exclude: seen, nodeKind: 'intro' });
    if (!picked) break;
    if (picked.poolReset) recycled = true;
    seen.add(picked.clip.id);
    unique += 1;
  }
  check(
    `corpus: tier ${level} serves ${MAX_VOICES_PER_SESSION} distinct voices without recycling`,
    unique === MAX_VOICES_PER_SESSION && !recycled,
    `unique ${unique}, recycled ${recycled}`,
  );
}

console.log(`[session-length] ${passed} checks passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`[session-length] ${failures.length} checks FAILED`);
  process.exitCode = 1;
} else {
  console.log('[session-length] All session-length checks passed.');
}
