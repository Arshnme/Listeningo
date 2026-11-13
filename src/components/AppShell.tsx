'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from '@/components/ui/icons';
import { Dashboard } from '@/components/Dashboard';
import { GuidebookModal } from '@/components/GuidebookModal';
import { LevelShiftBanner } from '@/components/LevelShiftBanner';
import { ListeningArena, type ArenaPhase } from '@/components/ListeningArena';
import { BottomDock, type AppTab } from '@/components/NavBar';
import { PathView } from '@/components/PathView';
import { SessionSummary, type NodeOutcome } from '@/components/SessionSummary';
import { SessionOverlay } from '@/components/SessionOverlay';
import { SettingsView } from '@/components/SettingsView';
import { AppSkeleton } from '@/components/ui/primitives';
import { AudioEngine } from '@/lib/audio/engine';
import { uiSounds } from '@/lib/uiSoundEngine';
import { DatasetError } from '@/lib/hf';
import { clearAudioCache, getAudioCacheStats } from '@/lib/idb';
import { BUNDLED_AUDIO } from '@/lib/localAudio';
import { CORE_MANIFEST_SIZE, loadFullManifest } from '@/lib/manifest';
import { loadTranslationCorpus } from '@/lib/translationService';
import { getCachedClipIds } from '@/lib/idb';
import {
  ROUNDS_PER_SESSION,
  ClipPool,
  isFinalRound,
  newSessionId,
  rebuildClipFromHistory,
  seedFromKey,
  toRoundClip,
} from '@/lib/session';
import { clampVoicesPerSession } from '@/lib/levels';
import {
  SECTIONS,
  activeNode,
  applySessionToNode,
  claimChest,
  extractWeakWords,
  isNodeUnlocked,
  isTierAccessible,
  nodeDefinition,
  nodeLockReason,
  raiseFastTrack,
} from '@/lib/path';
import { computeXp, evaluateAdaptation, scoreTranscript } from '@/lib/scoring';
import {
  appendSession,
  clearHistory,
  exportState,
  importState,
  pushSeenClip,
  recordVoice,
  resetSeenForTier,
  stateBytes,
} from '@/lib/storage';
import { useUserState } from '@/lib/hooks';
import type {
  AcousticMode,
  AudioSourceKind,
  DifficultyLevel,
  NoiseIntensity,
  EngineStatus,
  HistoryRound,
  NodeKind,
  PathNodeRef,
  RoundClip,
  ManifestClip,
  RoundResult,
  SessionHistoryEntry,
  SlowRate,
} from '@/lib/types';

/** What a running session is attached to. */
interface SessionContext {
  /** The path node being played, or null for free practice from the dashboard. */
  ref: PathNodeRef | null;
  kind: NodeKind;
  /** Tier the session runs at. */
  tier: DifficultyLevel;
  /**
   * True when replaying a tier below the learner's current placement. The
   * adaptive engine is paused for these, because promoting or demoting a review
   * would fight the placement the learner actually earned.
   */
  review: boolean;
}

/** Consecutive clean voices the engine needs before promoting. */
const PROMOTION_NEED = 2;

/**
 * Root client component: owns the audio engine, the clip pool, the running
 * session, and every piece of persisted progress.
 *
 * Kept as one orchestrator on purpose. The adaptive engine is inherently
 * stateful and cross-cutting — one round's outcome changes the tier of the next
 * round *and* can unlock path sections — and splitting that flow across contexts
 * would make the mid-session promotion logic much harder to follow.
 */
export default function AppShell() {
  //  from the hook used to feed the header's cache readout. Settings
  // computes its own storage figure from the live state, so only the pieces the
  // shell actually needs are destructured here.
  const { hydrated, state, update, reset, storageNotice, dismissStorageNotice } = useUserState();

  const [tab, setTab] = useState<AppTab>('path');
  const [guidebookTier, setGuidebookTier] = useState<DifficultyLevel | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    contextState: 'uninitialized',
    spectrumLive: false,
    fallbackReason: null,
    compression: { bytesSaved: 0, failures: 0, supported: false },
  });

  // --- session runtime ------------------------------------------------------
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  const [roundIndex, setRoundIndex] = useState(0);
  /**
   * Voices this session owes, frozen from the setting when it starts.
   *
   * Held in state rather than read live from `state.voicesPerSession` so the
   * count cannot shift under a running session: a session must deliver exactly
   * the number it started with.
   */
  const [totalRounds, setTotalRounds] = useState<number>(ROUNDS_PER_SESSION);
  const [clip, setClip] = useState<RoundClip | null>(null);
  const [phase, setPhase] = useState<ArenaPhase>('loading');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<AudioSourceKind | null>(null);
  const [replays, setReplays] = useState(0);
  const [slowUsed, setSlowUsed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [slowMode, setSlowMode] = useState(false);
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 });
  const [volume, setVolume] = useState(0.85);
  const [hintEnabled, setHintEnabled] = useState(true);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [banner, setBanner] = useState<RoundResult['shift']>(null);
  const [fastTrack, setFastTrack] = useState<{ tier: number; title: string } | null>(null);
  const [nextLevel, setNextLevel] = useState<DifficultyLevel>(1);
  const [startLevel, setStartLevel] = useState<DifficultyLevel>(1);
  const [summary, setSummary] = useState<SessionHistoryEntry | null>(null);
  /**
   * Which completed round the report is displaying, 0-based, or null to follow
   * the live round. Stepping back is read-only: a stored score is never revised.
   */
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  /**
   * Bumped whenever a session ends. The path scrolls back to the current node on
   * every change, so a learner who just cleared one lands on whatever opened
   * rather than on wherever they happened to be scrolled.
   */
  const [mapFocus, setMapFocus] = useState(0);
  const [nodeOutcome, setNodeOutcome] = useState<NodeOutcome | null>(null);
  const [cachedClips, setCachedClips] = useState(0);
  const [cachedBytes, setCachedBytes] = useState(0);
  const [cachedIds, setCachedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [corpus, setCorpus] = useState<readonly ManifestClip[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // --- refs -----------------------------------------------------------------
  const engineRef = useRef<AudioEngine | null>(null);
  const poolRef = useRef<ClipPool | null>(null);
  const hasPlayedRef = useRef(false);
  const loadTokenRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionRef = useRef<SessionContext | null>(null);
  sessionRef.current = sessionContext;

  /**
   * Per-round idempotency guards.
   *
   * Enter can submit and a focused button can click in the same tick, so both
   * actions must be safe to call twice. Tracking which round each action has
   * already run for is exact, unlike a shared cooldown timer — which would also
   * swallow a legitimate "next voice" click made quickly after submitting.
   */
  const submittedRoundRef = useRef(-1);
  /**
   * Clip ids already played in the running session, which keeps a lesson's
   * deterministic sequence moving forward without ever repeating a voice.
   * Cleared whenever a session starts.
   */
  const sessionClipIdsRef = useRef<Set<string>>(new Set());
  const advancedRoundRef = useRef(-1);

  // Live settings, read inside callbacks that must not re-create per render.
  const acousticRef = useRef(state.acousticMode);
  acousticRef.current = state.acousticMode;
  const intensityRef = useRef(state.noiseIntensity);
  intensityRef.current = state.noiseIntensity;

  /** Words the learner keeps missing, driving the Mastery Workout node. */
  const weakWords = useMemo(() => extractWeakWords(state.sessionHistory), [state.sessionHistory]);
  const weakWordsRef = useRef(weakWords);
  weakWordsRef.current = weakWords;

  const activeRef = useMemo(() => activeNode(state.path), [state.path]);

  // --- engine bootstrap -----------------------------------------------------
  useEffect(() => {
    const engine = new AudioEngine({
      onPlaybackChange: setPlaying,
      onProgress: (currentTime, duration) => setProgress({ currentTime, duration }),
      onStatusChange: setEngineStatus,
      onError: (message) => setNotice(message),
    });
    engineRef.current = engine;
    setEngineStatus(engine.getStatus());
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const pool = new ClipPool();
    poolRef.current = pool;
    // Start on the bundled core immediately, then deepen the pool when the full
    // curated corpus arrives. The app is fully usable before it lands.
    setCorpus(pool.allClips());
    void loadFullManifest().then((clips) => {
      if (clips.length === 0) return;
      pool.addBase(clips);
      setCorpus(pool.allClips());
    });
    // The pre-generated translations were previously reached only through the
    // live network layer, because this call was missing: every sentence lookup
    // cost a round trip to a third-party endpoint even though the answer was
    // already sitting in /fa.json. Loading it here is what makes the common path
    // instant and offline.
    void loadTranslationCorpus();
    void getAudioCacheStats().then((stats) => {
      setCachedClips(stats.clips);
      setCachedBytes(stats.bytes);
    });
    void getCachedClipIds().then((ids) => setCachedIds(new Set(ids)));
  }, [hydrated]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  // Settings changes take effect immediately, including mid-playback.
  useEffect(() => {
    engineRef.current?.setSlowRate(state.slowRate);
  }, [state.slowRate]);

  useEffect(() => {
    engineRef.current?.setCompressCache(state.compressCache);
  }, [state.compressCache]);

  // The interface-sound engine mirrors the persisted toggle. The effect matters
  // on hydration: a profile with sounds turned off must stay silent from the
  // first interaction, not from the first visit to Settings.
  useEffect(() => {
    uiSounds.setEnabled(state.uiSounds);
  }, [state.uiSounds]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (storageNotice) setNotice(storageNotice);
  }, [storageNotice]);

  const refreshAudioCacheStats = useCallback(() => {
    void getAudioCacheStats().then((stats) => {
      setCachedClips(stats.clips);
      setCachedBytes(stats.bytes);
    });
    void getCachedClipIds().then((ids) => setCachedIds(new Set(ids)));
  }, []);

  // -------------------------------------------------------------- load round --

  const loadRound = useCallback(
    async (index: number, level: DifficultyLevel, context: SessionContext) => {
      const pool = poolRef.current;
      if (!pool) return;

      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;

      setPhase('loading');
      setLoading(true);
      setLoadError(null);
      setResult(null);
      setBanner(null);
      setFastTrack(null);
      setReplays(0);
      setSlowUsed(false);
      setProgress({ currentTime: 0, duration: 0 });
      hasPlayedRef.current = false;
      engineRef.current?.reset();
      setSlowMode(false);
      engineRef.current?.setSlowMode(false);

      const mode = acousticRef.current;
      const intensity = intensityRef.current;
      const randomize = stateRef.current.randomizeLessons;
      const picked = pool.pick({
        level,
        mode,
        intensity,
        // Randomized lessons (the default) draw fresh voices on every open and
        // skip everything in the persisted seen window; fixed lessons replay a
        // seeded, deterministic set and are filtered only by the ids already
        // played in THIS session, so reopening a node always replays its own
        // voices. Either way the session itself never repeats a clip.
        exclude: randomize
          ? new Set<string>([...stateRef.current.seenClipIds, ...sessionClipIdsRef.current])
          : sessionClipIdsRef.current,
        seed: randomize
          ? undefined
          : seedFromKey(
              `${context.ref ? `${context.ref.tier}-${context.ref.slot}` : 'free'}|${level}|${mode}`,
            ),
        nodeKind: context.kind,
        weakWords: weakWordsRef.current,
      });

      if (!picked) {
        setLoading(false);
        setLoadError('No clips available for this tier. Try a different node or level.');
        setPhase('listening');
        return;
      }

      if (picked.poolReset) {
        // Every clip in the tier has been heard; the pool recycles by design.
        update((previous) =>
          resetSeenForTier(previous, pool.clipsFor(level, mode).map((item) => item.id)),
        );
        setNotice(`Every clip in this tier has been completed — the pool for Level ${level} has reset.`);
      }

      const roundClip = toRoundClip(picked.clip, level, mode, intensity);
      setClip(roundClip);

      try {
        const engine = engineRef.current;
        if (!engine) throw new DatasetError('network', 'Audio engine unavailable.');
        const { source } = await engine.load(roundClip);
        if (loadTokenRef.current !== token) return;
        setSourceKind(source);
        if (source === 'cache') refreshAudioCacheStats();
      } catch (error) {
        if (loadTokenRef.current !== token) return;
        // Only LibriSpeech audio is ever played — there is deliberately no
        // speech-synthesiser fallback. A failed download surfaces as a retry
        // state instead, so a learner is never graded against a substitute voice.
        const reason =
          error instanceof DatasetError ? error.message : 'The clip could not be downloaded.';
        setLoadError(`${reason} Press “Retry download” to stream it again.`);
        setNotice(reason);
      } finally {
        if (loadTokenRef.current === token) {
          setLoading(false);
          setPhase('listening');
        }
      }

      // With the corpus bundled locally there is nothing to grow from the
      // dataset server: the pool is already complete, and staying offline is
      // the point of the bundled build.
      if (!BUNDLED_AUDIO) void pool.grow(level, mode, sessionClipIdsRef.current);
    },
    [update, refreshAudioCacheStats],
  );

  // ---------------------------------------------------------------- sessions --

  /** Starts a session. `ref` is the path node, or null for free practice. */
  const startSession = useCallback(
    (ref: PathNodeRef | null) => {
      const current = stateRef.current;
      const tier: DifficultyLevel = ref ? ref.tier : current.currentLevel;
      const kind: NodeKind = ref ? nodeDefinition(ref.slot).kind : 'intro';
      const review = ref ? ref.tier < current.currentLevel : false;
      const context: SessionContext = { ref, kind, tier, review };

      submittedRoundRef.current = -1;
      advancedRoundRef.current = -1;
      sessionClipIdsRef.current = new Set();
      setRounds([]);
      setRoundIndex(0);
      setTotalRounds(clampVoicesPerSession(current.voicesPerSession));
      setStartLevel(tier);
      setNextLevel(tier);
      setSummary(null);
      setNodeOutcome(null);
      setReviewIndex(null);
      setSessionContext(context);
      setBanner(null);
      setFastTrack(null);
      void loadRound(0, tier, context);
    },
    [loadRound],
  );

  const play = useCallback(
    (slow: boolean) => {
      const engine = engineRef.current;
      if (!engine || !clip) return;

      if (hasPlayedRef.current) setReplays((count) => count + 1);
      hasPlayedRef.current = true;
      if (slow) setSlowUsed(true);
      setSlowMode(slow);

      // The clip is always a genuine LibriSpeech stream (or a cached copy of
      // one); there is no synthesised-speech branch to route around.
      void engine.restart(!slow);
    },
    [clip],
  );

  const pause = useCallback(() => engineRef.current?.pause(), []);

  const submit = useCallback(
    (text: string) => {
      const context = sessionRef.current;
      if (!clip || phase !== 'listening' || !context) return;
      if (text.trim().length === 0) return;
      // Idempotent per round: pressing Enter while the button click is also in
      // flight must grade once, but a later round must never be blocked.
      if (submittedRoundRef.current === roundIndex) return;
      submittedRoundRef.current = roundIndex;

      const alignment = scoreTranscript(clip.text, text);
      const accuracy = alignment.accuracy;
      const before = stateRef.current;

      const adaptation = evaluateAdaptation({
        accuracy,
        usedSlowMode: slowUsed,
        replays,
        // The *running* level, not the session's starting tier. Feeding the
        // starting tier back in makes promotion non-cumulative: the session
        // cycles up a tier, falls back to the baseline, and promotes again.
        currentLevel: clip.level,
        consecutiveHighStreak: before.consecutiveHighStreak,
        consecutiveLooseStreak: before.consecutiveLooseStreak,
        consecutiveLowStreak: before.consecutiveLowStreak,
        // Reviews never adapt, and neither does a session with auto-level off.
        autoLevelEnabled: before.autoLevelEnabled && !context.review,
      });

      const xpGained = computeXp(accuracy, clip.level, slowUsed);

      // Tactile feedback for the round: a pass earns the glass chime, and a
      // live promotion rides the rising sweep on top of it. Both are throttled
      // internally and silent when the Settings toggle is off.
      if (accuracy >= 0.7) uiSounds.playSuccess();
      if (adaptation.shift?.direction === 'up' && !context.review) uiSounds.playPromotion();

      const roundResult: RoundResult = {
        clip,
        userText: text,
        alignment,
        accuracy,
        usedSlowMode: slowUsed,
        replays,
        shift: adaptation.shift,
        xpGained,
      };

      // Fast-track: a live promotion can open path sections ahead of the nodes.
      let nextPath = before.path;
      if (adaptation.shift?.direction === 'up' && !context.review) {
        const raised = raiseFastTrack(nextPath, adaptation.shift.to);
        const newlyUnlocked = SECTIONS.map((section) => section.tier).filter(
          (tier) =>
            !isTierAccessible(nextPath, tier as DifficultyLevel) &&
            isTierAccessible(raised, tier as DifficultyLevel),
        );
        nextPath = raised;
        const first = newlyUnlocked[0];
        setFastTrack(
          first
            ? { tier: first, title: SECTIONS[first - 1]?.title ?? `Section ${first}` }
            : null,
        );
      } else {
        setFastTrack(null);
      }

      setResult(roundResult);
      setRounds((previous) => [...previous, roundResult]);
      setReviewIndex(null);
      setPhase('graded');
      setBanner(adaptation.shift);
      setNextLevel(adaptation.nextLevel);
      engineRef.current?.endNoise();

      // Feed the lesson's deterministic walk: the next draw skips this voice.
      sessionClipIdsRef.current.add(clip.id);

      update((previous) => {
        const withVoice = recordVoice(previous, {
          accuracy,
          isNoisy: clip.config === 'other' || clip.noiseDb !== null,
          usedSlowMode: slowUsed,
          xp: xpGained,
        });
        const withSeen = pushSeenClip(withVoice, clip.id);
        // A review is read-only for the placement: it must not move the global
        // tier *and* it must not accumulate promotion or demotion streaks, or
        // sailing through two easy Section 1 voices would promote the learner
        // out of the tier they actually earned.
        const streaks = context.review
          ? {
              consecutiveHighStreak: previous.consecutiveHighStreak,
              consecutiveLooseStreak: previous.consecutiveLooseStreak,
              consecutiveLowStreak: previous.consecutiveLowStreak,
            }
          : {
              consecutiveHighStreak: adaptation.nextHighStreak,
              consecutiveLooseStreak: adaptation.nextLooseStreak,
              consecutiveLowStreak: adaptation.nextLowStreak,
            };
        return {
          ...withSeen,
          path: nextPath,
          currentLevel: context.review ? previous.currentLevel : adaptation.nextLevel,
          ...streaks,
        };
      });
    },
    [clip, phase, roundIndex, replays, slowUsed, update],
  );

  const finishSession = useCallback(
    (completed: RoundResult[]) => {
      const context = sessionRef.current;
      const average =
        completed.length === 0
          ? 0
          : completed.reduce((sum, round) => sum + round.accuracy, 0) / completed.length;

      const entry: SessionHistoryEntry = {
        id: newSessionId(),
        timestamp: new Date().toISOString(),
        startLevel,
        endLevel: nextLevel,
        averageAccuracy: average,
        rounds: completed.map<HistoryRound>((round) => ({
          clipId: round.clip.id,
          split: round.clip.splitLabel,
          level: round.clip.level,
          noiseDb: round.clip.noiseDb ?? 0,
          accuracy: round.accuracy,
          usedSlowMode: round.usedSlowMode,
          replays: round.replays,
          expectedText: round.clip.text,
          userText: round.userText,
          rowIdx: round.clip.rowIdx,
          speakerId: round.clip.speakerId,
        })),
      };

      // Fold the run into the progression map. Computed outside the updater so
      // the result can also be surfaced in the summary card.
      let outcome: NodeOutcome | null = null;
      let nextPath = stateRef.current.path;
      let bonusXp = 0;

      if (context?.ref && completed.length > 0) {
        const applied = applySessionToNode(nextPath, context.ref, average);
        nextPath = applied.path;
        bonusXp = applied.cleared ? 20 * context.ref.tier : 0;
        outcome = {
          nodeTitle: nodeDefinition(context.ref.slot).title,
          tier: context.ref.tier,
          cleared: applied.cleared,
          alreadyCleared: !applied.cleared && Boolean(stateRef.current.path.nodes[`${context.ref.tier}-${context.ref.slot}`]),
          stars: applied.stars,
          bestAccuracy: Math.max(
            average,
            stateRef.current.path.nodes[`${context.ref.tier}-${context.ref.slot}`]?.bestAccuracy ?? 0,
          ),
          unlockedTiers: applied.unlocked
            .filter((item) => item.slot === 1 && item.tier > context.ref!.tier)
            .map((item) => item.tier),
          isReview: context.review,
        };
      }

      update((previous) => ({ ...appendSession({ ...previous, path: nextPath }, entry), xp: previous.xp + bonusXp }));

      setNodeOutcome(outcome);
      setSummary(entry);
      engineRef.current?.reset();
    },
    [startLevel, nextLevel, update],
  );

  const advance = useCallback(() => {
    const context = sessionRef.current;
    if (!context) return;
    // While a report older than the newest is open, "forward" pages through
    // history. Once the newest is reached the view behaves like the live graded
    // round again, so the same click also leaves review mode and starts the next
    // voice rather than spending a click doing nothing visible.
    if (reviewIndex !== null && reviewIndex < rounds.length - 1) {
      setReviewIndex(reviewIndex + 1);
      return;
    }
    if (reviewIndex !== null) setReviewIndex(null);
    if (advancedRoundRef.current === roundIndex) return;
    advancedRoundRef.current = roundIndex;
    // The session ends after exactly `totalRounds` graded voices — the count is
    // the one captured when the session started, never a running setting.
    if (isFinalRound(roundIndex, totalRounds)) {
      finishSession(rounds);
      return;
    }
    setRoundIndex(roundIndex + 1);
    void loadRound(roundIndex + 1, nextLevel, context);
  }, [rounds, roundIndex, reviewIndex, nextLevel, totalRounds, finishSession, loadRound]);

  /** Steps back one report; on the newest report it opens the previous one. */
  const retreat = useCallback(() => {
    const completed = sessionRef.current ? rounds.length : 0;
    if (completed === 0) return;
    const from = reviewIndex ?? completed - 1;
    if (from <= 0) return;
    setReviewIndex(from - 1);
  }, [rounds.length, reviewIndex]);

  const closeSession = useCallback(() => {
    engineRef.current?.reset();
    // Ask the map to bring the current node back into view.
    setMapFocus((value) => value + 1);
    setSessionContext(null);
    setSummary(null);
    setReviewIndex(null);
    setNodeOutcome(null);
    setClip(null);
    setResult(null);
    setBanner(null);
    setFastTrack(null);
    setRounds([]);
  }, []);

  /** Replays a past voice from the session summary. */
  const reviewRound = useCallback(async (round: HistoryRound, slow: boolean) => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const rebuilt = rebuildClipFromHistory(round);
      await engine.load(rebuilt);
      engine.setSlowMode(slow);
      await engine.play();
    } catch {
      setNotice('That clip could not be re-downloaded just now. Check your connection and try again.');
    }
  }, []);

  // ------------------------------------------------------------ path actions --

  const activateNode = useCallback(
    (ref: PathNodeRef) => {
      // The view marks locked nodes, but the gate belongs here too: a reward
      // chest must not be claimable, and a session must not be startable, on a
      // node the learner has not reached yet.
      if (!isNodeUnlocked(stateRef.current.path, ref.tier, ref.slot)) {
        setNotice(
          nodeLockReason(stateRef.current.path, ref.tier, ref.slot) || 'That node is not available yet.',
        );
        return;
      }
      const definition = nodeDefinition(ref.slot);
      if (definition.isReward) {
        const claim = claimChest(stateRef.current.path, ref.tier, ref.slot);
        if (claim.alreadyClaimed) {
          setNotice('That reward has already been claimed.');
          return;
        }
        update((previous) => ({ ...previous, path: claim.path, xp: previous.xp + claim.xp }));
        uiSounds.playSuccess();
        setNotice(`Reward claimed: +${claim.xp} XP and the Tier ${ref.tier} Audio Mastery badge.`);
        return;
      }
      startSession(ref);
    },
    [startSession, update],
  );

  // ------------------------------------------------------------- selections --

  const explainLockedNode = useCallback((ref: PathNodeRef) => {
    setNotice(
      nodeLockReason(stateRef.current.path, ref.tier, ref.slot) || 'That node is not available yet.',
    );
  }, []);

  const handleLevelChange = useCallback(
    (level: DifficultyLevel) => {
      // A manual pick is an explicit override, so auto-level stands down.
      //
      // It also opens the path up to that tier. The placement the engine plays
      // at and the section the map allows must not disagree, or a learner who
      // deliberately jumps to Tier 4 in Settings would find every Tier 4 node
      // still locked and be unable to play the level they just chose.
      update((previous) => ({
        ...previous,
        currentLevel: level,
        autoLevelEnabled: false,
        path: raiseFastTrack(previous.path, level),
      }));
      setNextLevel(level);
    },
    [update],
  );

  const handleAutoLevelChange = useCallback(
    (enabled: boolean) => update((previous) => ({ ...previous, autoLevelEnabled: enabled })),
    [update],
  );

  const handleAcousticModeChange = useCallback(
    (mode: AcousticMode) => update((previous) => ({ ...previous, acousticMode: mode })),
    [update],
  );

  const handleNoiseIntensityChange = useCallback(
    (intensity: NoiseIntensity) => update((previous) => ({ ...previous, noiseIntensity: intensity })),
    [update],
  );

  const handleSlowRateChange = useCallback(
    (rate: SlowRate) => update((previous) => ({ ...previous, slowRate: rate })),
    [update],
  );

  const handleVoicesPerSessionChange = useCallback(
    (voices: number) =>
      update((previous) => ({ ...previous, voicesPerSession: clampVoicesPerSession(voices) })),
    [update],
  );

  const handleRandomizeLessonsChange = useCallback(
    (enabled: boolean) => update((previous) => ({ ...previous, randomizeLessons: enabled })),
    [update],
  );

  const handleCompressCacheChange = useCallback(
    (enabled: boolean) => update((previous) => ({ ...previous, compressCache: enabled })),
    [update],
  );

  const handleUiSoundsChange = useCallback(
    (enabled: boolean) => {
      uiSounds.setEnabled(enabled);
      // Audition the toggle as it is switched on, so "ON" is verifiable by ear.
      if (enabled) uiSounds.playSuccess();
      update((previous) => ({ ...previous, uiSounds: enabled }));
    },
    [update],
  );

  const handleExport = useCallback(() => {
    const json = exportState(stateRef.current);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `listening-progress-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('Progress exported as JSON.');
  }, []);

  const handleImport = useCallback(
    (json: string) => {
      const parsed = importState(json);
      if (!parsed.ok || !parsed.state) {
        setNotice(parsed.error ?? 'That file could not be imported.');
        return;
      }
      const restored = parsed.state;
      update(() => restored);
      setNotice('Progress restored from JSON.');
    },
    [update],
  );

  const handleReset = useCallback(() => {
    reset();
    void clearAudioCache().then(() => {
      setCachedClips(0);
      setCachedBytes(0);
      setCachedIds(new Set<string>());
    });
    closeSession();
    setTab('path');
  }, [reset, closeSession]);

  const handleClearAudioCache = useCallback(() => {
    void clearAudioCache().then(() => {
      setCachedClips(0);
      setCachedBytes(0);
      setCachedIds(new Set<string>());
      setNotice('Cached audio cleared. Clips will stream again on demand.');
    });
  }, []);

  const arena = useMemo(() => {
    if (!clip || !sessionContext) return null;
    return (
      <ListeningArena
        clip={clip}
        roundNumber={roundIndex + 1}
        totalRounds={totalRounds}
        phase={phase}
        loading={loading}
        loadError={loadError}
        sourceKind={sourceKind}
        nodeLabel={
          sessionContext.ref
            ? `${nodeDefinition(sessionContext.ref.slot).title} · Section ${sessionContext.ref.tier}`
            : 'Free practice'
        }
        reviewMode={sessionContext.review}
        highStreak={state.consecutiveHighStreak}
        promotionNeed={PROMOTION_NEED}
        replays={replays}
        slowMode={slowMode}
        playing={playing}
        currentTime={progress.currentTime}
        duration={progress.duration}
        spectrumLive={engineStatus.spectrumLive}
        fallbackActive={Boolean(engineStatus.fallbackReason)}
        volume={volume}
        hintEnabled={hintEnabled}
        slowRate={state.slowRate}
        result={
          reviewIndex !== null ? (rounds[reviewIndex] ?? result) : result
        }
        reviewRound={reviewIndex !== null ? reviewIndex + 1 : roundIndex + 1}
        reviewing={reviewIndex !== null && reviewIndex < rounds.length - 1}
        engine={engineRef.current}
        nextLevel={nextLevel}
        onPlay={play}
        onPause={pause}
        onVolumeChange={setVolume}
        onSubmit={submit}
        onNext={advance}
        onPrevious={retreat}
        onQuit={closeSession}
        onRetryLoad={() => void loadRound(roundIndex, clip.level, sessionContext)}
        onHintToggle={() => setHintEnabled((value) => !value)}
      />
    );
  }, [
    clip,
    sessionContext,
    roundIndex,
    totalRounds,
    phase,
    loading,
    loadError,
    sourceKind,
    state.consecutiveHighStreak,
    replays,
    slowMode,
    playing,
    progress,
    engineStatus.spectrumLive,
    engineStatus.fallbackReason,
    volume,
    hintEnabled,
    state.slowRate,
    result,
    rounds,
    reviewIndex,
    nextLevel,
    play,
    pause,
    submit,
    advance,
    retreat,
    closeSession,
    loadRound,
  ]);

  const shiftBanner = banner ? (
    <LevelShiftBanner
      shift={banner}
      fastTrack={fastTrack}
      onDismiss={() => {
        setBanner(null);
        setFastTrack(null);
      }}
    />
  ) : null;

  if (!hydrated) {
    return <AppSkeleton />;
  }

  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* Transient notices. Rendered directly rather than through
          AnimatePresence so a stalled exit animation cannot pin a stale notice
          to the screen; the auto-dismiss timer lives in state. */}
      {notice ? (
        <div
          className="fixed bottom-24 left-1/2 z-[80] w-[calc(100%-1.5rem)] max-w-lg -translate-x-1/2 animate-[toast-in_200ms_ease-out] md:bottom-6"
          role="status"
          aria-live="polite"
        >
          <div className="glass-strong flex items-start gap-3 p-3.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-neutral-400" />
            <p className="flex-1 text-[11px] leading-relaxed text-neutral-300">{notice}</p>
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                dismissStorageNotice();
              }}
              className="icon-btn h-7 w-7 shrink-0 border-white/10"
              aria-label="Dismiss notice"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : null}

      <main className="flex-1">
        {tab === 'path' ? (
          <PathView
            path={state.path}
            currentLevel={state.currentLevel}
            autoLevelEnabled={state.autoLevelEnabled}
            noiseIntensity={state.noiseIntensity}
            weakWords={weakWords}
            onActivateNode={activateNode}
            onLockedNode={explainLockedNode}
            onOpenGuidebook={setGuidebookTier}
            focusSignal={mapFocus}
          />
        ) : null}

        {tab === 'dashboard' ? (
          <Dashboard
            state={state}
            manifestSize={corpus.length || CORE_MANIFEST_SIZE}
            cachedClips={cachedClips}
            onStart={() => startSession(activeRef)}
            onClearHistory={() => {
              update(clearHistory);
              setNotice('Session history cleared. Path progress and XP were kept.');
            }}
            starting={false}
            onReviewRound={(round, slow) => void reviewRound(round, slow)}
            slowRate={state.slowRate}
          />
        ) : null}

        {tab === 'settings' ? (
          <SettingsView
            state={state}
            storageBytes={stateBytes(state)}
            audioCacheClips={cachedClips}
            audioCacheBytes={cachedBytes}
            corpus={corpus}
            cachedIds={cachedIds}
            onCacheChanged={refreshAudioCacheStats}
            onAutoLevelChange={handleAutoLevelChange}
            onLevelChange={handleLevelChange}
            onAcousticModeChange={handleAcousticModeChange}
            onNoiseIntensityChange={handleNoiseIntensityChange}
            onSlowRateChange={handleSlowRateChange}
            onVoicesPerSessionChange={handleVoicesPerSessionChange}
            onRandomizeLessonsChange={handleRandomizeLessonsChange}
            onCompressCacheChange={handleCompressCacheChange}
            onUiSoundsChange={handleUiSoundsChange}
            compression={engineStatus.compression}
            onExport={handleExport}
            onImport={handleImport}
            onReset={handleReset}
            onClearAudioCache={handleClearAudioCache}
          />
        ) : null}
      </main>

      {tab !== 'settings' ? (
        <footer className="mx-auto w-full max-w-5xl px-4 pb-28 pt-2 sm:px-5">
          <p className="text-[10px] leading-relaxed text-neutral-600">
            Audio: LibriSpeech (OpenSLR SLR12, CC BY 4.0) streamed from the Hugging Face datasets
            server and cached in your browser. Injection noise is synthesised locally with the Web
            Audio API. Progress never leaves this device.
          </p>
        </footer>
      ) : null}

      {/* ------------------------------------------------------------- stack -- */}

      <BottomDock tab={tab} onChange={setTab} />

      {/* Banner floats above the active view when no session is running. */}
      {shiftBanner && !sessionContext ? (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-[65] px-3 sm:px-5">
          <div className="mx-auto w-full max-w-3xl">{shiftBanner}</div>
        </div>
      ) : null}

      {sessionContext ? (
        <SessionOverlay totalRounds={totalRounds}>
          {summary ? (
            <SessionSummary
              session={summary}
              nextLevel={state.currentLevel}
              nodeOutcome={nodeOutcome}
              onContinue={closeSession}
              onReviewRound={(round, slow) => void reviewRound(round, slow)}
              onExit={closeSession}
              slowRate={state.slowRate}
            />
          ) : (
            <>
              {shiftBanner ? (
                <div className="sticky top-0 z-40 px-3 pt-3 sm:px-5">
                  <div className="mx-auto w-full max-w-3xl">{shiftBanner}</div>
                </div>
              ) : null}
              {arena}
            </>
          )}
        </SessionOverlay>
      ) : null}

      {guidebookTier ? (
        <GuidebookModal
          tier={guidebookTier}
          path={state.path}
          noiseIntensity={state.noiseIntensity}
          voicesPerSession={state.voicesPerSession}
          onClose={() => setGuidebookTier(null)}
        />
      ) : null}
    </div>
  );
}
