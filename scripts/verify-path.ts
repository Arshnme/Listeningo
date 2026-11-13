/**
 * Path / progression verification suite.
 *
 * Covers the Duolingo-style map: unlock rules, star bands, node clearing,
 * reward chests, fast-track, weak-word mining, noise intensity and the
 * export/import round trip.
 *
 * Run with:  npm test   (which executes this and verify.ts)
 */

import { LEVELS, applyNoiseIntensity, resolveAcousticProfile } from '../src/lib/levels';
import { ClipPool, toRoundClip } from '../src/lib/session';
import {
  ALL_NODE_REFS,
  NODE_SLOTS,
  activeNode,
  applySessionToNode,
  claimChest,
  crownBadge,
  emptyPathProgress,
  extractWeakWords,
  isChestClaimed,
  isNodeUnlocked,
  isTierAccessible,
  masteryBadge,
  nodeDefinition,
  nodeKey,
  nodeLockReason,
  raiseFastTrack,
  starsFor,
  tierCompletedCount,
  totalStars,
} from '../src/lib/path';
import { clearHistory, defaultState, exportState, importState, parseState } from '../src/lib/storage';
import {
  CENTER_X,
  ROW_STEP,
  STAGE_WIDTH,
  X_OFFSETS,
  X_OFFSETS_MIRRORED,
  characterAnchor,
  conduitStateFor,
  joinPaths,
  nodePoint,
  segmentPath,
  segmentPointAt,
  stageHeight,
} from '../src/lib/conduit';
import { uiSounds } from '../src/lib/uiSoundEngine';
import { LEXICON_SIZE, isLikelyEnglish, knownWordRatio } from '../src/lib/english';
import rawLexicon from '../src/data/en-lexicon.json';
import {
  OPUS_COMPRESSION_RATIO,
  clipBytes,
  estimateClipBytes,
  formatBytes,
  validateManifest,
} from '../src/lib/manifest';
import rawFull from '../public/manifest.json';
import rawCore from '../src/data/manifest.generated.json';
import type { ManifestClip, SessionHistoryEntry } from '../src/lib/types';

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

/* ------------------------------------------------------------- topology -- */

const fresh = emptyPathProgress();
eq('path: starts with no progress', Object.keys(fresh.nodes).length, 0);
eq('path: tier 1 open from the start', isTierAccessible(fresh, 1), true);
eq('path: tier 2 starts locked', isTierAccessible(fresh, 2), false);
eq('path: fast-track marker starts at 1', fresh.fastTrackTier, 1);
eq('path: 50 nodes across the ladder', ALL_NODE_REFS.length, 50);
eq('path: ten node slots per tier', NODE_SLOTS.length, 10);

eq('path: node 1-1 unlocked', isNodeUnlocked(fresh, 1, 1), true);
eq('path: 1-2 locked behind 1-1', isNodeUnlocked(fresh, 1, 2), false);
eq('path: chest locked behind 1-3', isNodeUnlocked(fresh, 1, 4), false);
eq('path: boss locked at the start', isNodeUnlocked(fresh, 1, 5), false);
eq('path: tier 2 locked at the start', isNodeUnlocked(fresh, 2, 1), false);
eq(
  'path: the active pointer starts on 1-1',
  activeNode(fresh) ? nodeKey(activeNode(fresh)!.tier, activeNode(fresh)!.slot) : null,
  '1-1',
);

/* ----------------------------------------------------------------- stars -- */

eq('stars: 69% earns none', starsFor(0.69), 0);
eq('stars: 70% earns one', starsFor(0.7), 1);
eq('stars: 84% earns one', starsFor(0.84), 1);
eq('stars: 80% earns one', starsFor(0.8), 1);
eq('stars: 85% earns two', starsFor(0.85), 2);
eq('stars: 89% earns two', starsFor(0.89), 2);
eq('stars: 90% earns three', starsFor(0.9), 3);
eq('stars: 100% earns three', starsFor(1), 3);

/* --------------------------------------------------------------- clearing -- */

const clear11 = applySessionToNode(fresh, { tier: 1, slot: 1 }, 0.92);
eq('clear: 1-1 records three stars', clear11.path.nodes['1-1']?.stars, 3);
eq('clear: 1-1 reports cleared', clear11.cleared, true);
eq('clear: 1-1 opens 1-2', isNodeUnlocked(clear11.path, 1, 2), true);
eq(
  'clear: 1-1 reports the opened node',
  clear11.unlocked.map((r) => nodeKey(r.tier, r.slot)).includes('1-2'),
  true,
);
eq('clear: 1-1 does not open tier 2', isTierAccessible(clear11.path, 2), false);

// Finishing is what opens the next node, whatever the score. Gating the map on an
// accuracy the learner cannot yet reach turns practice into a wall.
const lowScore = applySessionToNode(fresh, { tier: 1, slot: 1 }, 0.4);
eq('clear: a low-scoring run still completes', lowScore.cleared, true);
eq('clear: a low-scoring run records an attempt', lowScore.path.nodes['1-1']?.attempts, 1);
eq('clear: a low-scoring run still opens 1-2', isNodeUnlocked(lowScore.path, 1, 2), true);
eq('clear: a low score earns no stars', lowScore.path.nodes['1-1']?.stars, 0);
eq('clear: a low score still stamps completion', Boolean(lowScore.path.nodes['1-1']?.completedAt), true);
eq('clear: a low score is recorded as the best so far', lowScore.path.nodes['1-1']?.bestAccuracy, 0.4);

// Walk the first section far enough to open section 2.
let ladder = fresh;
ladder = applySessionToNode(ladder, { tier: 1, slot: 1 }, 0.95).path;
ladder = applySessionToNode(ladder, { tier: 1, slot: 2 }, 0.95).path;
const workout = applySessionToNode(ladder, { tier: 1, slot: 3 }, 0.8);
// 80% sits in the 70-85% band, so exactly one star.
eq('clear: workout earns one star at 80%', workout.path.nodes['1-3']?.stars, 1);
eq('clear: workout opens tier 2', isTierAccessible(workout.path, 2), true);
eq('clear: workout leaves tier 3 closed', isTierAccessible(workout.path, 3), false);
eq('clear: node 2-1 is now available', isNodeUnlocked(workout.path, 2, 1), true);
eq(
  'clear: workout reports section 2 opening',
  workout.unlocked.some((r) => r.tier === 2 && r.slot === 1),
  true,
);

// Replaying a cleared node better raises stars without re-stamping.
const improve = applySessionToNode(workout.path, { tier: 1, slot: 3 }, 0.97);
eq('clear: a better replay raises stars', improve.path.nodes['1-3']?.stars, 3);
eq('clear: a better replay adds an attempt', improve.path.nodes['1-3']?.attempts, 2);
eq('clear: a better replay is not a fresh clear', improve.cleared, false);

/* ----------------------------------------------------------------- chest -- */

eq('chest: available once 1-3 is cleared', isNodeUnlocked(workout.path, 1, 4), true);
// The chest is a detour, not a gate: the boss opens on the three listening
// nodes, so a learner who skips the reward is never blocked.
eq('chest: boss opens without the chest', isNodeUnlocked(workout.path, 1, 5), true);
eq('chest: chest is still unclaimed', isChestClaimed(workout.path, 1, 4), false);
eq('chest: pointer prefers the unclaimed chest', activeNode(workout.path)?.slot, 4);

const claimed = claimChest(workout.path, 1, 4);
eq('chest: grants bonus xp', claimed.xp, 50);
eq('chest: grants the mastery badge', claimed.badge, masteryBadge(1));
eq('chest: recorded as claimed', isChestClaimed(claimed.path, 1, 4), true);
eq('chest: is skipped by the active pointer', activeNode(claimed.path)?.slot, 5);
eq('chest: claiming twice reports already claimed', claimChest(claimed.path, 1, 4).alreadyClaimed, true);
eq('chest: claiming twice grants no xp', claimChest(claimed.path, 1, 4).xp, 0);
eq('chest: bonus scales with tier', claimChest(emptyPathProgress(), 5, 4).xp, 250);

/* ------------------------------------------------------------------ boss -- */


const bossFail = applySessionToNode(claimed.path, { tier: 1, slot: 5 }, 0.79);
eq('boss: completes even below the star bar', bossFail.cleared, true);
eq('boss: a low boss score earns one star', bossFail.path.nodes['1-5']?.stars, 1);
const boss = applySessionToNode(claimed.path, { tier: 1, slot: 5 }, 0.85);
eq('boss: 85% completes', boss.cleared, true);
eq('boss: clearing grants the crown', boss.path.badges.includes(crownBadge(1)), true);
eq('boss: section fully complete', tierCompletedCount(boss.path, 1), 5);

/* --------------------------------------------------- extended unit map -- */

// Slots 6–10 extend a unit without redefining slots 1–5: a second practice arc,
// a second workout, a second chest and the tier's true final boss. Because the
// original five slots keep their meanings, a saved profile's progress, stars,
// chests and badges all carry over untouched.
eq(
  'slots: the extension keeps the original five meanings',
  NODE_SLOTS.slice(0, 5).map((slot) => slot.kind),
  ['intro', 'practice', 'workout', 'reward', 'boss'],
);
eq('slots: the final slot is a second boss', NODE_SLOTS[9]?.kind, 'boss');
eq('slots: two chests per tier', NODE_SLOTS.filter((slot) => slot.isReward).length, 2);

const afterFirstBoss = boss.path;
eq('slots: the second arc opens after the first boss', isNodeUnlocked(afterFirstBoss, 1, 6), true);
eq('slots: the second arc advances sequentially', isNodeUnlocked(afterFirstBoss, 1, 7), false);
check(
  'slots: the final boss lock names the second arc',
  /Extension Practice/.test(nodeLockReason(afterFirstBoss, 1, 10)),
);

let beforeFinalBoss = afterFirstBoss;
for (const slot of [6, 7, 9]) {
  beforeFinalBoss = applySessionToNode(beforeFinalBoss, { tier: 1, slot }, 0.9).path;
}
eq(
  'slots: the final boss opens once every listening node is clear',
  isNodeUnlocked(beforeFinalBoss, 1, 10),
  true,
);
check('slots: the final boss never needs the unclaimed chest', !isChestClaimed(beforeFinalBoss, 1, 8));
eq(
  'slots: the unclaimed chest is the active pointer first',
  activeNode(beforeFinalBoss)?.slot,
  8,
);
const afterSecondChest = claimChest(beforeFinalBoss, 1, 8).path;
eq(
  'slots: with the chest claimed the pointer reaches the final boss',
  activeNode(afterSecondChest)?.slot,
  10,
);
const finalCleared = applySessionToNode(afterSecondChest, { tier: 1, slot: 10 }, 0.9).path;
eq('slots: the tier is then fully complete', tierCompletedCount(finalCleared, 1), NODE_SLOTS.length);
eq('slots: clearing the final boss opens no further tier', isTierAccessible(finalCleared, 3), false);
eq('slots: tier 2 opened when its workout cleared earlier', isNodeUnlocked(afterFirstBoss, 2, 1), true);

/* ------------------------------------------------------------ fast track -- */

const tracked = raiseFastTrack(fresh, 4);
eq('fast-track: opens tier 4', isTierAccessible(tracked, 4), true);
eq('fast-track: opens tier 3 implicitly', isTierAccessible(tracked, 3), true);
eq('fast-track: leaves tier 5 closed', isTierAccessible(tracked, 5), false);
eq('fast-track: is monotonic', raiseFastTrack(tracked, 2).fastTrackTier, 4);
eq('fast-track: node 4-1 is reachable', isNodeUnlocked(tracked, 4, 1), true);
eq(
  'fast-track: node 4-2 still needs 4-1',
  isNodeUnlocked(tracked, 4, 2),
  false,
);

eq('stars: totals sum every node', totalStars(workout.path), 3 + 3 + 1);

/* -------------------------------------------------------- english filter -- */

// Runtime discovery pulls clips straight from the dataset, so the browser needs
// its own guard. The rule is deliberately blunt - reject only when no word at all
// is recognised - because a proportional threshold discarded clean English.
eq('english: recognises ordinary speech', isLikelyEnglish('HE NODS HIS CONSENT'), true);
eq('english: recognises a proper-noun-heavy line', isLikelyEnglish('SILENCE YOU KNAVE CRIED MONTFICHET'), true);
eq('english: recognises vocabulary with no function words', isLikelyEnglish('OCEAN REIGNED SUPREME'), true);
eq('english: recognises a name-dense line', isLikelyEnglish('MARK SOWERBY AND CLAUS HENNERBERG'), true);
eq('english: recognises a poetic repetition', isLikelyEnglish('BURN FIRE BURN FLICKER FLICKER FLAME'), true);

// Genuine non-English content found in the crawl.
eq('english: rejects Italian', isLikelyEnglish('IL POPOLO E UNA BESTIA'), false);
eq('english: rejects Italian despite the shared article', isLikelyEnglish('QUINCI IMPARA A STUPIRTI'), false);
eq('english: rejects Greek names', isLikelyEnglish('STEPHANOS DEDALOS'), false);
eq('english: rejects a garbled fragment', isLikelyEnglish('GRUB PI LE GRUB PI LE'), false);
eq('english: rejects an empty string', isLikelyEnglish('   '), false);

check('english: lexicon is shipped and substantial', LEXICON_SIZE >= 2000, `${LEXICON_SIZE} words`);
check(
  'english: lexicon is uppercase',
  (rawLexicon as { words: string }).words.split(' ').every((word: string) => word === word.toUpperCase()),
);
// Self-contained: the shipped corpus is parsed again here rather than relying on
// the binding declared further down the file.
const englishChecked = validateManifest(rawFull as unknown);
check(
  'english: every shipped clip passes the runtime rule',
  englishChecked.every((clip) => isLikelyEnglish(clip.text)),
  `${englishChecked.filter((clip) => !isLikelyEnglish(clip.text)).length} would fail`,
);
// Not every word of a sentence need be in the lexicon: NODS appears in only two
// utterances corpus-wide, so it is outside the recurrence threshold. The rule only
// requires *some* word to be recognisable.
check(
  'english: ratio is high for ordinary text',
  knownWordRatio('HE NODS HIS CONSENT') > 0.5,
  String(knownWordRatio('HE NODS HIS CONSENT')),
);
check('english: and it still passes the rule', isLikelyEnglish('HE NODS HIS CONSENT'), 'NODS is outside the lexicon');
check('english: ratio is lower for foreign text', knownWordRatio('IL POPOLO E UNA BESTIA') < 0.5);

/* ------------------------------------------------------------ lock reasons -- */

// Section 1 with the first two nodes cleared: the workout is next, so the boss
// is still gated on it while the reward chest is not a gate at all.
const beforeWorkout = applySessionToNode(
  applySessionToNode(fresh, { tier: 1, slot: 1 }, 0.95).path,
  { tier: 1, slot: 2 },
  0.95,
).path;

check('lock: a closed section explains the gate', /Mastery Workout/.test(nodeLockReason(fresh, 3, 1)));
check('lock: an open section names the previous node', /Core Practice/.test(nodeLockReason(clear11.path, 1, 3)));
eq('lock: an available node gives no reason', nodeLockReason(workout.path, 1, 5), '');
eq('lock: a fresh profile gives no reason for 1-1', nodeLockReason(fresh, 1, 1), '');
check(
  'lock: the boss never blames the reward chest',
  !/Milestone Reward/.test(nodeLockReason(beforeWorkout, 1, 5)),
  'the chest is an optional detour, not a gate',
);
check('lock: boss names the missing workout', /Mastery Workout/.test(nodeLockReason(beforeWorkout, 1, 5)));
check(
  'lock: a node one step past the frontier is open',
  isNodeUnlocked(clear11.path, 1, 2),
  'the node after a cleared one must be reachable',
);

// A manual placement must open the section it names, not leave it gated.
const manualJump = raiseFastTrack(fresh, 3);
eq('placement: jumping to tier 3 opens section 3', isTierAccessible(manualJump, 3), true);
eq('placement: jumping to tier 3 opens its first node', isNodeUnlocked(manualJump, 3, 1), true);
eq('placement: jumping to tier 3 leaves tier 4 shut', isTierAccessible(manualJump, 4), false);

/* ------------------------------------------------------- noise intensity -- */

const base16 = { kind: 'room' as const, snrDb: 16, shaped: false };
eq('noise: standard keeps the tier snr', applyNoiseIntensity(base16, 'standard').snrDb, 16);
eq('noise: boosted subtracts 6 dB', applyNoiseIntensity(base16, 'boosted').snrDb, 10);
eq('noise: muted removes the bed', applyNoiseIntensity(base16, 'muted').snrDb, null);
eq('noise: muted drops shaping', applyNoiseIntensity(base16, 'muted').shaped, false);
eq('noise: muted sets kind none', applyNoiseIntensity(base16, 'muted').kind, 'none');
eq(
  'noise: a clean tier ignores intensity',
  applyNoiseIntensity({ kind: 'none', snrDb: null, shaped: false }, 'boosted').snrDb,
  null,
);
eq('profile: muted removes tier 5 noise', resolveAcousticProfile(5, 'auto', 'muted').noise.snrDb, null);
eq('profile: boosted deepens tier 5', resolveAcousticProfile(5, 'auto', 'boosted').noise.snrDb, 4);
eq('profile: muted still uses the other split', resolveAcousticProfile(5, 'auto', 'muted').config, 'other');

const intenseClip = toRoundClip(fakeClip('i1', 4, 16), 4, 'auto', 'muted');
eq('round clip: honours muted intensity', intenseClip.noiseDb, null);
eq('round clip: honours standard intensity', toRoundClip(fakeClip('i2', 4, 16), 4, 'auto', 'standard').noiseDb, 16);

/* ------------------------------------------------------- node-driven draw -- */

const bossPool = new ClipPool(['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => fakeClip(id, 4, 14 + i)));
const bossPicks = new Set<string>();
for (let i = 0; i < 3; i += 1) {
  const picked = bossPool.pick({ level: 4, mode: 'auto', exclude: bossPicks, nodeKind: 'boss' });
  check('draw: boss pick succeeds', picked !== null);
  if (!picked) break;
  check(
    'draw: boss never serves the easiest sentence',
    picked.clip.wordCount > 14,
    `got ${picked.clip.wordCount}`,
  );
  bossPicks.add(picked.clip.id);
}

// The workout must surface the sentence containing the missed word.
const weakPool = new ClipPool([
  fakeClip('w1', 3, 10),
  fakeClip('w2', 3, 10),
  fakeClip('w3', 3, 10),
]);
const target = weakPool.allClips().find((clip) => clip.id === 'w2');
if (!target) throw new Error('fixture missing w2');
// Give w2 a keyword so the preference has something to match on.
const rewritten = { ...target, text: `${target.text} zzz` };
const weakPool2 = new ClipPool([fakeClip('w1', 3, 10), rewritten, fakeClip('w3', 3, 10)]);
const weakPick = weakPool2.pick({
  level: 3,
  mode: 'auto',
  exclude: new Set(),
  nodeKind: 'workout',
  weakWords: ['zzz'],
});
eq('draw: workout prefers the sentence with the missed word', weakPick?.clip.id, 'w2');

// Without weak words the workout still returns something playable.
const noWeak = weakPool.pick({ level: 3, mode: 'auto', exclude: new Set(), nodeKind: 'workout' });
check('draw: workout works with no weak words', noWeak !== null);

/* -------------------------------------------------------- weak-word mine -- */

function historyWith(expected: string, user: string | undefined): SessionHistoryEntry {
  return {
    id: `s-${expected.length}-${expected.slice(0, 4)}`,
    timestamp: new Date(2026, 0, 1).toISOString(),
    startLevel: 1,
    endLevel: 1,
    averageAccuracy: 0.5,
    rounds: [
      {
        clipId: 'x',
        split: 'test-clean',
        level: 1,
        noiseDb: 0,
        accuracy: 0.5,
        usedSlowMode: false,
        replays: 0,
        expectedText: expected,
        userText: user ?? '',
        rowIdx: 1,
        speakerId: '1',
      },
    ],
  };
}

const missedTwice = [
  historyWith('THE QUICK BROWN FOX', 'the quick fox'),
  historyWith('ANOTHER BROWN THING', 'another thing'),
  historyWith('BROWN AGAIN HERE', 'again here'),
];
const mined = extractWeakWords(missedTwice);
eq('weak: surfaces a word missed across sessions', mined.includes('brown'), true);
eq('weak: ignores short function words', mined.includes('the'), false);
eq('weak: ignores one-letter words', mined.includes('a'), false);
eq('weak: empty history yields nothing', extractWeakWords([]).length, 0);
eq(
  'weak: a single miss is not enough',
  extractWeakWords([historyWith('LONELY GIRAFFE TODAY', 'lonely today')]).includes('giraffe'),
  false,
);

const perfectHistory = [historyWith('ALL CORRECT HERE', 'all correct here')];
eq('weak: a perfect session yields nothing', extractWeakWords(perfectHistory).length, 0);
eq('weak: honours the result limit', extractWeakWords(missedTwice, { limit: 1 }).length <= 1, true);

/* -------------------------------------------------------- export / import -- */

const rich = (() => {
  let state = defaultState();
  state = { ...state, path: applySessionToNode(state.path, { tier: 2, slot: 1 }, 0.88).path, xp: 420 };
  return state;
})();

const exported = exportState(rich);
check('export: carries the cache key', exported.includes('librispeech_vercel_cache_v1'));
const restored = importState(exported);
eq('import: succeeds', restored.ok, true);
eq('import: restores xp', restored.state?.xp, 420);
eq('import: restores stars', restored.state?.path.nodes['2-1']?.stars, 2);
eq('import: rejects malformed json', importState('{ not json').ok, false);
eq('import: rejects an unrelated document', importState('{"hello":"world"}').ok, false);
eq('import: accepts a bare state document', importState(JSON.stringify(rich)).ok, true);

const hostile = importState(
  JSON.stringify({
    currentLevel: 42,
    path: { nodes: { '1-1': { stars: 99 }, bogus: { stars: 1 } }, fastTrackTier: 9 },
  }),
);
eq('import: clamps a hostile level', hostile.state?.currentLevel, 5);
eq('import: clamps hostile stars', hostile.state?.path.nodes['1-1']?.stars, 3);
eq('import: drops malformed node keys', hostile.state?.path.nodes.bogus, undefined);
eq('import: clamps hostile fast-track', hostile.state?.path.fastTrackTier, 5);

/* ---------------------------------------------------------------- history -- */

const clearedHistory = clearHistory(rich);
eq('history: clear empties the list', clearedHistory.sessionHistory.length, 0);
eq('history: clear keeps xp', clearedHistory.xp, rich.xp);
eq('history: clear keeps path stars', totalStars(clearedHistory.path), totalStars(rich.path));
eq('history: clearing an empty list is a no-op', clearHistory(clearedHistory) === clearedHistory, true);

/* --------------------------------------------- schema migration defaults -- */

const legacy = parseState({ currentLevel: 3, xp: 50 });
eq('migrate: a legacy document still loads', legacy.currentLevel, 3);
eq('migrate: missing intensity defaults', legacy.noiseIntensity, 'standard');
eq('migrate: missing slow rate defaults', legacy.slowRate, 0.75);
eq('migrate: missing path defaults to empty', Object.keys(legacy.path.nodes).length, 0);
eq('migrate: missing fast-track defaults to 1', legacy.path.fastTrackTier, 1);

const badPrefs = parseState({ noiseIntensity: 'extreme', slowRate: 0.1 });
eq('migrate: bad intensity falls back', badPrefs.noiseIntensity, 'standard');
eq('migrate: bad slow rate falls back', badPrefs.slowRate, 0.75);
eq('migrate: a valid 0.65 is kept', parseState({ slowRate: 0.65 }).slowRate, 0.65);

const defaults = defaultState();
eq('defaults: intensity is standard', defaults.noiseIntensity, 'standard');
eq('defaults: slow rate is 0.75', defaults.slowRate, 0.75);
eq('defaults: no badges', defaults.path.badges.length, 0);
eq('defaults: no chests claimed', defaults.path.chestsOpened.length, 0);

/* ------------------------------------------------------- shipped corpus -- */

// The curated manifest is generated data, so these are the invariants that keep
// a bad regeneration from shipping silently.
const shipped = validateManifest(rawFull as unknown);
check('corpus: full manifest parses', shipped.length > 0, `parsed ${shipped.length}`);
check('corpus: at least 600 clips', shipped.length >= 600, `got ${shipped.length}`);
eq('corpus: no duplicate ids', shipped.length, new Set(shipped.map((c) => c.id)).size);
eq('corpus: every clip has a row index', shipped.every((c) => Number.isFinite(c.rowIdx)), true);
eq('corpus: every clip has a level', shipped.every((c) => c.level >= 1 && c.level <= 5), true);
eq(
  'corpus: every clip has real speaker metadata',
  shipped.every((c) => c.speakerMinutes > 0),
  true,
);
eq('corpus: no clip under three words', shipped.every((c) => c.wordCount >= 3), true);

// The bundled core must be a genuine subset of the fetched corpus, otherwise a
// first run would see different material from a warmed-up one.
const fullIds = new Set(shipped.map((c) => c.id));
eq(
  'corpus: bundled core is a subset of the full manifest',
  validateManifest(rawCore as unknown).every((c) => fullIds.has(c.id)),
  true,
);

// Sentence length must actually span each tier's range. A tier of nothing but
// one sentence size is monotonous and cannot train length tolerance.
for (const level of [1, 2, 3, 4, 5] as const) {
  const tier = shipped.filter((c) => c.level === level);
  const lengths = new Set(tier.map((c) => c.wordCount));
  check(
    `corpus: tier ${level} spans several sentence lengths`,
    lengths.size >= 4,
    `only ${lengths.size} distinct lengths in ${tier.length} clips`,
  );
  const total = tier.reduce((sum, c) => sum + c.wordCount, 0);
  check(
    `corpus: tier ${level} averages inside its declared range`,
    total / tier.length >= LEVELS[level].wordRange[0] &&
      total / tier.length <= LEVELS[level].wordRange[1],
    `average ${(total / tier.length).toFixed(1)} vs range ${LEVELS[level].wordRange.join('-')}`,
  );
  check(
    `corpus: tier ${level} has speaker variety`,
    new Set(tier.map((c) => c.speakerId)).size >= 15,
    `${new Set(tier.map((c) => c.speakerId)).size} speakers`,
  );
}

// Every tier must be deep enough that a ten-voice session rarely repeats, and
// the whole corpus needs to land near the requested audio volume. Size comes
// from the measured per-word curve, not a flat average.
check(
  'corpus: each tier holds at least 150 clips',
  [1, 2, 3, 4, 5].every((level) => shipped.filter((c) => c.level === level).length >= 150),
);
// Two separate budgets matter, and they are very different numbers. The streamed
// FLAC volume is what the corpus offers; the Opus-stored volume is what actually
// has to fit in the learner's browser, and compaction is what makes a corpus this
// large affordable.
const flacMb = estimateClipBytes(shipped) / (1024 * 1024);
const opusMb = flacMb / OPUS_COMPRESSION_RATIO;
check('corpus: offers well over 80 MB of source audio', flacMb >= 100, `~${flacMb.toFixed(0)} MB`);
// The corpus is now sized deliberately against the compressed figure: the whole
// eligible pool is roughly 425 MB of FLAC, which lands near the 80 MB budget once
// each stored clip is compacted to Opus.
check(
  'corpus: compacts within the storage budget',
  opusMb <= 85,
  `~${opusMb.toFixed(0)} MB as Opus`,
);

// No clip may end on a function word: that is the signature of an utterance cut
// mid-clause, and it is what makes a sentence sound like a fragment.
const DANGLING = new Set(
  'A AN AND AS AT BUT BY FOR FROM HIS HER IN INTO IS IT OF ON OR OVER THAT THE THEIR THEM THEN THERE THESE THEY THIS TO UNDER UP WAS WERE WHAT WHEN WHERE WHICH WHO WITH WOULD YOU YOUR'.split(' '),
);
const fragments = shipped.filter((c) => DANGLING.has(c.text.trim().split(' ').pop() ?? ''));
eq('corpus: no clip ends mid-clause', fragments.length, 0);

// Tiers must not overlap in a way that makes an easier tier harder than a
// harder one.
const ranges = [1, 2, 3, 4, 5].map((level) => LEVELS[level as 1].wordRange);
check(
  'corpus: tier ranges ramp upward',
  ranges.every((range, index) => index === 0 || range[0] >= (ranges[index - 1] as [number, number])[0]),
);

/* ------------------------------------------------------ offline download -- */

// Size must track sentence length: a flat average would be wrong by 4x across
// the ladder, which is what the per-word curve exists to fix.
check('offline: short clips are cheaper than long ones', clipBytes(3) < clipBytes(25), `3w=${clipBytes(3)} 25w=${clipBytes(25)}`);
check('offline: a 3-word clip is under 60 KB', clipBytes(3) < 60 * 1024, `${clipBytes(3)} bytes`);
check('offline: a 30-word clip is over 150 KB', clipBytes(30) > 150 * 1024, `${clipBytes(30)} bytes`);
eq('offline: length estimate is monotonic', clipBytes(5) <= clipBytes(10) && clipBytes(10) <= clipBytes(20), true);
eq('offline: a set sums its clips', estimateClipBytes([{ wordCount: 3 }, { wordCount: 3 }]), clipBytes(3) * 2);
eq('offline: formatter handles bytes', formatBytes(512), '512 B');
eq('offline: formatter handles kilobytes', formatBytes(2048), '2.0 KB');
eq('offline: formatter handles megabytes', formatBytes(5 * 1024 * 1024), '5.0 MB');

/* ---------------------------------------------------- 3D glass conduit -- */

// ONE coordinate grid, shared by the SVG conduit and the node wrappers: the
// viewBox is 420 wide and, with percentage-left and pixel-top bindings, both
// sides evaluate the identical mapping at every viewport. These assertions pin
// the grid itself and the dead-centre lock it exists to guarantee.
eq('grid: stage width is 420', STAGE_WIDTH, 420);
eq('grid: the centre axis is half the stage', CENTER_X, 210);
eq('grid: row step is 148', ROW_STEP, 148);
eq('grid: stage height for five nodes', stageHeight(5), 5 * ROW_STEP + 120);
eq('grid: the swing pattern is symmetric', X_OFFSETS, [0, 68, 0, -68, 0, 68, 0, -68, 0, 0]);
eq('grid: the mirrored pattern inverts it', X_OFFSETS_MIRRORED, [0, -68, 0, 68, 0, -68, 0, 68, 0, 0]);
eq('grid: unit 0 node 0 sits on the centre axis', nodePoint(0, 0), { x: 210, y: 85 });
eq('grid: unit 0 node 1 swings right', nodePoint(1, 0), { x: 278, y: 233 });
eq('grid: unit 1 mirrors the swing', nodePoint(1, 1), { x: 142, y: 233 });
eq('grid: the double S returns to centre', nodePoint(9, 0), { x: 210, y: 85 + 9 * 148 });
eq('grid: rows advance one step', nodePoint(2, 0).y - nodePoint(1, 0).y, ROW_STEP);

for (const unit of [0, 1, 2, 3, 4]) {
  for (let index = 0; index < 10; index += 1) {
    const point = nodePoint(index, unit);
    check(
      `grid: unit ${unit} node ${index} stays inside the stage`,
      point.x >= 40 && point.x <= STAGE_WIDTH - 40,
      `x=${point.x}`,
    );
  }
  eq(
    `grid: unit ${unit} follows the alternating parity`,
    nodePoint(1, unit).x,
    unit % 2 === 0 ? CENTER_X + 68 : CENTER_X - 68,
  );
}

// The lock itself: every bezier endpoint IS the node centre, in every unit.
for (const unit of [0, 1, 2, 3, 4]) {
  let locked = true;
  for (let index = 0; index < 9; index += 1) {
    const from = nodePoint(index, unit);
    const to = nodePoint(index + 1, unit);
    const d = segmentPath(from, to);
    const midY = ((from.y + to.y) / 2).toFixed(1);
    locked =
      locked &&
      d.startsWith(`M ${from.x.toFixed(1)} ${from.y.toFixed(1)}`) &&
      d.includes(`C ${from.x.toFixed(1)} ${midY}`) &&
      d.endsWith(`${to.x.toFixed(1)} ${to.y.toFixed(1)}`);
  }
  check(`grid: unit ${unit} curve starts and ends on every puck centre`, locked);
}

const cFrom = nodePoint(0, 0);
const cTo = nodePoint(1, 0);
check('conduit: a y-offset drops the whole curve', segmentPath(cFrom, cTo, 6).includes(`${(cFrom.y + 6).toFixed(1)}`));
eq('conduit: joining fragments concatenates them', joinPaths(['M 0 0', 'M 1 1']), 'M 0 0 M 1 1');

// Stones evaluate the exact control points the SVG draws with: the half-way
// stone must equal the plain midpoint of the two node centres, and the two
// third-points must mirror about it (the curve is symmetric by construction).
const mid = segmentPointAt(cFrom, cTo, 0.5);
near('conduit: the half-way stone is the curve midpoint in x', mid.x, (cFrom.x + cTo.x) / 2, 1e-9);
near('conduit: the half-way stone is the curve midpoint in y', mid.y, (cFrom.y + cTo.y) / 2, 1e-9);
const third = segmentPointAt(cFrom, cTo, 1 / 3);
const twothird = segmentPointAt(cFrom, cTo, 2 / 3);
near('conduit: third-points mirror in x', third.x + twothird.x, cFrom.x + cTo.x, 1e-9);
near('conduit: third-points mirror in y', third.y + twothird.y, cFrom.y + cTo.y, 1e-9);

/* -------------------------------------------------- companion anchors -- */

// The characters stand in the open bend, opposite the curve's apex, and the
// no-overlap guarantee is an AABB assertion rather than a promise: for every
// unit, against every one of its five pucks (boss radius 48) plus the stack's
// own half-extents (56 x 74), the gap on at least one axis must stay positive.
const PUCK_RADIUS = 48;
const MASCOT_HALF_W = 56;
const MASCOT_HALF_H = 74;
for (const unit of [0, 1, 2, 3, 4]) {
  const anchor = characterAnchor(unit);
  eq(`companion: unit ${unit} stands between rows 1 and 2`, anchor.y, 85 + 1.5 * ROW_STEP);
  eq(
    `companion: unit ${unit} takes the side opposite the apex`,
    anchor.side,
    unit % 2 === 0 ? 'left' : 'right',
  );
  let minGap = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 10; index += 1) {
    const point = nodePoint(index, unit);
    const dx = Math.abs(point.x - anchor.x) - (PUCK_RADIUS + MASCOT_HALF_W);
    const dy = Math.abs(point.y - anchor.y) - (PUCK_RADIUS + MASCOT_HALF_H);
    minGap = Math.min(minGap, Math.max(dx, dy));
  }
  check(
    `companion: unit ${unit} never overlaps a node`,
    minGap > 8,
    `min gap ${minGap.toFixed(1)}px`,
  );
}

/* ------------------------------------------------------- interface sounds -- */

// The sound engine must be import-safe without a DOM: the verification suites
// run in Node, and a thrown error here would mean a page-level crash risk.
eq('sound: engine imports without a DOM', typeof uiSounds.setEnabled, 'function');
let soundSafe = true;
try {
  uiSounds.playClick();
  uiSounds.playSuccess();
  uiSounds.playPromotion();
  uiSounds.playCharacterChime();
  uiSounds.setEnabled(false);
  uiSounds.setEnabled(true);
} catch {
  soundSafe = false;
}
eq('sound: every cue is a safe no-op without an AudioContext', soundSafe, true);
eq('sound: the enabled flag round-trips', uiSounds.isEnabled(), true);
// Segment states: the bridge into a finished node is solid, into a playable
// node it pulses, and anywhere further ahead stays carved.
const freshPath = emptyPathProgress();
eq(
  'conduit: every segment starts locked',
  [0, 1, 2, 3].map((index) => conduitStateFor(freshPath, 1, index)),
  ['locked', 'locked', 'locked', 'locked'],
);

const after1 = applySessionToNode(freshPath, { tier: 1, slot: 1 }, 0.9).path;
eq('conduit: the bridge into node 2 pulses once node 1 clears', conduitStateFor(after1, 1, 0), 'active');
eq('conduit: the far bridge stays carved', conduitStateFor(after1, 1, 1), 'locked');

const after12 = applySessionToNode(after1, { tier: 1, slot: 2 }, 0.9).path;
eq('conduit: a walked bridge turns solid', conduitStateFor(after12, 1, 0), 'completed');
eq('conduit: the next bridge pulses', conduitStateFor(after12, 1, 1), 'active');

const after123 = applySessionToNode(after12, { tier: 1, slot: 3 }, 0.9).path;
eq('conduit: the chest bridge pulses while unclaimed', conduitStateFor(after123, 1, 2), 'active');
eq('conduit: the boss bridge pulses once 1-3 cleared', conduitStateFor(after123, 1, 3), 'active');

const claimedChest = claimChest(after123, 1, 4).path;
eq('conduit: a claimed chest completes its bridge', conduitStateFor(claimedChest, 1, 2), 'completed');
eq('conduit: the boss bridge still pulses', conduitStateFor(claimedChest, 1, 3), 'active');

const afterBoss = applySessionToNode(claimedChest, { tier: 1, slot: 5 }, 0.7).path;
eq('conduit: a cleared boss completes the last bridge', conduitStateFor(afterBoss, 1, 3), 'completed');

/* ------------------------------------------------------------------ report -- */

console.log(`\n[path] ${passed} checks passed`);
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('[path] All progression checks passed.');
}
