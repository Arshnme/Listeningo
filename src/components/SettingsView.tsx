'use client';

import { useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  Languages,
  Loader2,
  FileJson,
  Gauge,
  HardDrive,
  Layers,
  Minus,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Trash2,
  Turtle,
  Upload,
  Volume2,
  VolumeX,
  Zap,
} from '@/components/ui/icons';
import { Bar, GlassCard, Pill, SegmentedControl, Toggle } from '@/components/ui/primitives';
import { LEVELS, LEVEL_NUMBERS, MAX_VOICES_PER_SESSION, MIN_VOICES_PER_SESSION, SLOW_RATES, clampVoicesPerSession } from '@/lib/levels';
import { BUNDLED_AUDIO, BUNDLED_AUDIO_STATS } from '@/lib/localAudio';
import { estimateClipBytes, estimateCompactBytes, formatBytes } from '@/lib/manifest';
import { downloadClips, type DownloadProgress } from '@/lib/offline';
import { NODE_SLOTS, totalStars } from '@/lib/path';
import { pluralWord } from '@/lib/text';
import { translationStats } from '@/lib/translationService';
import { SEEN_CLIP_CAP, SESSION_HISTORY_CAP } from '@/lib/storage';
import type {
  AcousticMode,
  CachedUserState,
  DifficultyLevel,
  ManifestClip,
  NoiseIntensity,
  SlowRate,
} from '@/lib/types';

/**
 * Settings control center.
 *
 * Grouped by what each control actually affects — the adaptive engine, the
 * acoustic simulation, and local storage — because those are three independent
 * mental models and mixing them in one list makes the consequences unclear.
 */
export function SettingsView({
  state,
  storageBytes,
  audioCacheClips,
  audioCacheBytes,
  corpus,
  cachedIds,
  onCacheChanged,
  onAutoLevelChange,
  onLevelChange,
  onAcousticModeChange,
  onNoiseIntensityChange,
  onSlowRateChange,
  onVoicesPerSessionChange,
  onRandomizeLessonsChange,
  onCompressCacheChange,
  onUiSoundsChange,
  compression,
  onExport,
  onImport,
  onReset,
  onClearAudioCache,
}: {
  state: CachedUserState;
  storageBytes: number;
  audioCacheClips: number;
  audioCacheBytes: number;
  /** The full curated corpus, used for per-tier offline downloads. */
  corpus: readonly ManifestClip[];
  /** Ids already stored in the browser's audio cache. */
  cachedIds: ReadonlySet<string>;
  /** Called after a download changes the cache. */
  onCacheChanged: () => void;
  onAutoLevelChange: (enabled: boolean) => void;
  onLevelChange: (level: DifficultyLevel) => void;
  onAcousticModeChange: (mode: AcousticMode) => void;
  onNoiseIntensityChange: (intensity: NoiseIntensity) => void;
  onSlowRateChange: (rate: SlowRate) => void;
  /**
   * Sets how many voices every session and path stage runs. The next session
   * started uses the new count; a session already under way never changes its
   * length mid-flight.
   */
  onVoicesPerSessionChange: (voices: number) => void;
  /**
   * Toggles fresh voice draws per lesson (on, the default) versus a fixed
   * deterministic set that replays identically on every open (off).
   */
  onRandomizeLessonsChange: (enabled: boolean) => void;
  /**
   * Enables or disables the synthesised interface sounds (node clicks, the
   * completion chime, the promotion sweep).
   */
  onUiSoundsChange: (enabled: boolean) => void;
  /** Enables or disables Opus compaction of the local audio cache. */
  onCompressCacheChange: (enabled: boolean) => void;
  /** Live compaction figures from the audio engine. */
  compression: { bytesSaved: number; failures: number; supported: boolean };
  onExport: () => void;
  onImport: (json: string) => void;
  onReset: () => void;
  onClearAudioCache: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmAudioClear, setConfirmAudioClear] = useState(false);
  const [activeTier, setActiveTier] = useState<DifficultyLevel | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [translations] = useState(() => translationStats());
  const compacts = state.compressCache && compression.supported;
  /** What a set of clips will occupy locally, honouring the compression setting. */
  const storedBytes = (clips: readonly ManifestClip[]) =>
    compacts ? estimateCompactBytes(clips) : estimateClipBytes(clips);

  const tierClips = (level: DifficultyLevel) => corpus.filter((clip) => clip.level === level);
  const cachedInTier = (level: DifficultyLevel) =>
    tierClips(level).filter((clip) => cachedIds.has(clip.id)).length;

  const runDownload = async (level: DifficultyLevel) => {
    const clips = tierClips(level);
    if (clips.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveTier(level);
    setProgress({ total: clips.length, alreadyCached: 0, completed: 0, failed: 0, bytes: 0 });
    try {
      const final = await downloadClips(clips, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setProgress(final);
      onCacheChanged();
    } finally {
      abortRef.current = null;
      setActiveTier(null);
    }
  };

  const stopDownload = () => abortRef.current?.abort();

  const tier = LEVELS[state.currentLevel];
  const seenCount = state.seenClipIds.length;
  const historyCount = state.sessionHistory.length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-32 pt-5 sm:px-6">
      <header className="px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-[12px] leading-relaxed text-neutral-500">
          Every control here applies immediately and is stored on this device only.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
          {BUNDLED_AUDIO ? (
            <>
              Corpus: <span className="text-neutral-300">{corpus.length} clips</span> across five
              tiers, shipped with the app as{' '}
              <span className="text-neutral-300">{formatBytes(BUNDLED_AUDIO_STATS.bytes)}</span> of
              compact Opus — nothing is streamed at runtime, and every lesson plays offline on the
              very first visit.
            </>
          ) : (
            <>
              Corpus: <span className="text-neutral-300">{corpus.length} clips</span> across five
              tiers. Those bytes stream from the dataset CDN and cache in this browser; none of them
              ship inside the app bundle. As streamed FLAC that is{' '}
              {formatBytes(estimateClipBytes(corpus))}
              {compacts
                ? `, which compaction brings down to about ${formatBytes(estimateCompactBytes(corpus))} on disk.`
                : `, and with compaction off that is what the cache will hold.`}
            </>
          )}
        </p>
      </header>

      {/* ------------------------------------------- adaptive intelligence -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<Zap size={15} />} title="Adaptive intelligence" />
        <div className="mt-4 flex flex-col gap-4">
          <Row
            label="Auto-level switching"
            hint="Promotes you mid-session when you demonstrate mastery, steps you down when you struggle, and fast-tracks sections on the path."
          >
            <Toggle
              label={`Auto-Level: ${state.autoLevelEnabled ? 'ON' : 'OFF'}`}
              checked={state.autoLevelEnabled}
              onChange={onAutoLevelChange}
            />
          </Row>

          <Row
            label="Manual tier override"
            hint={`Currently ${tier.tierPill}. Choosing a tier manually switches Auto-Level off.`}
          >
            <div className="grid grid-cols-1 gap-1.5 sm:w-80">
              {LEVEL_NUMBERS.map((level) => {
                const config = LEVELS[level];
                const active = level === state.currentLevel;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => onLevelChange(level)}
                    aria-pressed={active}
                    className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                      active
                        ? 'border-white bg-white text-[#050505]'
                        : 'border-white/[0.08] bg-white/[0.02] text-neutral-300 hover:border-white/25'
                    }`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-[10px] opacity-70">L{level}</span>
                      <span className="text-[12px] font-medium tracking-tight">{config.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] opacity-70">
                      {config.config === 'other' ? 'other' : 'clean'} ·{' '}
                      {config.noise.snrDb !== null ? `${config.noise.snrDb}dB` : 'no noise'}
                    </span>
                  </button>
                );
              })}
            </div>
          </Row>

          <Row
            label="Interface sounds"
            hint="Synthesised on the spot with the Web Audio API — no audio files are downloaded. A crystal click when you press a node, a glass chime when a voice lands, and a rising sweep when the engine promotes you."
          >
            <Toggle
              label={`Sounds: ${state.uiSounds ? 'ON' : 'OFF'}`}
              checked={state.uiSounds}
              onChange={onUiSoundsChange}
            />
          </Row>
        </div>
      </GlassCard>

      {/* ---------------------------------------------------- session length -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<Timer size={15} />} title="Session length" />
        <div className="mt-4">
          <Row
            label="Voices per session"
            hint="Every stage — path nodes and free practice — plays exactly this many voices and then reports, never more and never fewer. Takes effect on the next session you start."
          >
            <div className="flex flex-col gap-2 sm:items-end">
              <div
                role="radiogroup"
                aria-label="Voices per session presets"
                className="glass-inset flex flex-wrap items-center gap-0.5 p-0.5"
              >
                {[5, 10, 15, 20, 30].map((preset) => {
                  const active = state.voicesPerSession === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => onVoicesPerSessionChange(preset)}
                      title={`Run exactly ${preset} voices per session`}
                      className={`rounded-[14px] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors duration-200 ${
                        active
                          ? 'bg-white font-semibold text-[#050505]'
                          : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      {preset}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onVoicesPerSessionChange(clampVoicesPerSession(state.voicesPerSession - 1))
                  }
                  disabled={state.voicesPerSession <= MIN_VOICES_PER_SESSION}
                  className="icon-btn h-9 w-9"
                  aria-label="One fewer voice per session"
                  title="One fewer voice per session"
                >
                  <Minus size={13} />
                </button>
                <span className="metric w-24 text-center text-sm text-white">
                  {state.voicesPerSession}
                  <span className="ml-1.5 text-[10px] font-normal uppercase tracking-[0.12em] text-neutral-500">
                    {pluralWord(state.voicesPerSession, 'voice')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onVoicesPerSessionChange(clampVoicesPerSession(state.voicesPerSession + 1))
                  }
                  disabled={state.voicesPerSession >= MAX_VOICES_PER_SESSION}
                  className="icon-btn h-9 w-9"
                  aria-label="One more voice per session"
                  title="One more voice per session"
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>
          </Row>

          <Row
            label="Randomize lesson voices"
            hint="On (default): every time you open a lesson its voices are drawn fresh, and the seen window keeps them from repeating while fresh material remains. Off: each lesson keeps one fixed set of voices — reopening it replays exactly the same clips."
          >
            <Toggle
              label={`Random: ${state.randomizeLessons ? 'ON' : 'OFF'}`}
              checked={state.randomizeLessons}
              onChange={onRandomizeLessonsChange}
            />
          </Row>
        </div>
      </GlassCard>

      {/* --------------------------------------------- acoustic simulation -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<SlidersHorizontal size={15} />} title="Acoustic & dataset pool" />
        <div className="mt-4 flex flex-col gap-4">
          <Row
            label="Audio pool"
            hint="Auto follows each tier's own corpus. Clean forces studio audio. Noisy forces the OTHER split with a noise bed."
          >
            <SegmentedControl<AcousticMode>
              ariaLabel="Audio pool"
              value={state.acousticMode}
              onChange={onAcousticModeChange}
              options={[
                { value: 'auto', label: 'Auto', hint: 'Each tier uses its own profile' },
                { value: 'clean_only', label: 'Clean only', hint: 'Studio audio, no injected noise' },
                { value: 'noisy_forced', label: 'Noisy / other', hint: 'Force OTHER split with noise' },
              ]}
            />
          </Row>

          <Row
            label="Synthetic background noise"
            hint="Scales the Web Audio noise generator against the tier's calibrated SNR. Muting also disables the room-shaping filter."
          >
            <SegmentedControl<NoiseIntensity>
              ariaLabel="Noise intensity"
              value={state.noiseIntensity}
              onChange={onNoiseIntensityChange}
              options={[
                { value: 'standard', label: 'Standard', hint: 'Use the tier’s own SNR' },
                { value: 'boosted', label: 'Boosted', hint: '6 dB louder noise bed' },
                { value: 'muted', label: 'Muted', hint: 'No injected noise at all' },
              ]}
            />
          </Row>

          <Row
            label="Slow mode speed"
            hint="Pitch is preserved at both speeds, and the noise bed is halved whenever Slow Mode is in use."
          >
            <div
              role="radiogroup"
              aria-label="Slow mode speed"
              className="glass-inset flex flex-wrap items-center gap-0.5 p-0.5"
            >
              {SLOW_RATES.map((rate) => {
                const active = rate === state.slowRate;
                return (
                  <button
                    key={rate}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onSlowRateChange(rate)}
                    title={
                      rate === 0.75
                        ? 'Default pitch-preserved slow speed'
                        : `Play at ${rate}x with pitch preserved`
                    }
                    className={`rounded-[14px] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors duration-200 ${
                      active
                        ? 'bg-white font-semibold text-[#050505]'
                        : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'
                    }`}
                  >
                    {rate}x
                  </button>
                );
              })}
            </div>
          </Row>

          <Row
            label="Compress cached audio"
            hint="Re-encodes each clip to WebM/Opus before storing it locally, which fits several times more voices in the browser. Playback quality is unaffected — Opus is transparent for 16 kHz speech — and the download from the dataset is unchanged."
          >
            <Toggle
              label={`Compress: ${state.compressCache ? 'ON' : 'OFF'}`}
              checked={state.compressCache}
              onChange={onCompressCacheChange}
              disabled={!compression.supported}
              hint={
                compression.supported
                  ? 'Opus encoding is available in this browser'
                  : 'This browser cannot encode Opus, so clips are stored as FLAC'
              }
            />
          </Row>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <AudioFact
              icon={<Layers size={12} />}
              label="saved this session"
              value={compression.bytesSaved > 0 ? formatBytes(compression.bytesSaved) : '—'}
            />
            <AudioFact
              icon={<Database size={12} />}
              label="opus support"
              value={compression.supported ? 'available' : 'unavailable'}
            />
            <AudioFact
              icon={<Layers size={12} />}
              label="fallbacks"
              value={`${compression.failures}`}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <AudioFact icon={<Volume2 size={12} />} label="tier noise" value={
              tier.noise.snrDb === null ? 'none' : `${tier.noise.snrDb} dB snr`
            } />
            <AudioFact icon={<VolumeX size={12} />} label="injected now" value={
              state.noiseIntensity === 'muted'
                ? 'muted'
                : state.noiseIntensity === 'boosted'
                  ? 'boosted 6 dB'
                  : 'standard'
            } />
            <AudioFact icon={<Turtle size={12} />} label="slow speed" value={`${state.slowRate}x`} />
          </div>
        </div>
      </GlassCard>

      {/* ------------------------------------------------- offline audio -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<Layers size={15} />} title="Offline audio" />
        {BUNDLED_AUDIO ? (
          <>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
              The entire corpus ships inside this app as compact Opus audio — every tier plays with
              no network at all, on the very first visit, with nothing to download. The files are
              served immutably, so a voice crosses the network at most once ever.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {LEVEL_NUMBERS.map((level) => (
                <Pill key={level} className="border-white/[0.1]" title={LEVELS[level].name}>
                  L{level} · <span className="metric">{tierClips(level).length}</span>
                </Pill>
              ))}
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
              {BUNDLED_AUDIO_STATS.clips} clips · {formatBytes(BUNDLED_AUDIO_STATS.bytes)} of Opus
              bundled with the app
            </p>
          </>
        ) : (
          <>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
          Save a tier to this browser and it plays with no network at all. Downloads run two at a
          time to stay polite to the dataset server, so a tier takes a few minutes; you can stop at
          any point and keep whatever has already arrived.
        </p>

        <ul className="mt-4 flex flex-col gap-2">
          {LEVEL_NUMBERS.map((level) => {
            const config = LEVELS[level];
            const clips = tierClips(level);
            const have = cachedInTier(level);
            const running = activeTier === level;
            const done = clips.length > 0 && have >= clips.length;
            const pct = clips.length > 0 ? Math.round((have / clips.length) * 100) : 0;
            return (
              <li key={level} className="glass-inset flex flex-col gap-2.5 px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="metric flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.09] text-[10px] text-neutral-300">
                      {level}
                    </span>
                    <span className="text-[12px] font-medium tracking-tight text-white">
                      {config.name}
                    </span>
                    <Pill className="border-white/[0.1]">
                      {clips.length} clips · ~{formatBytes(storedBytes(clips))}
                      {compacts ? ' stored' : ''}
                    </Pill>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="metric text-[11px] text-neutral-400">
                      {have}/{clips.length}
                    </span>
                    {running ? (
                      <button type="button" onClick={stopDownload} className="btn-ghost py-1.5 text-[11px]">
                        Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void runDownload(level)}
                        disabled={clips.length === 0 || done || activeTier !== null}
                        className="btn-ghost py-1.5 text-[11px]"
                      >
                        {done ? <CheckCircle2 size={12} /> : <Download size={12} />}
                        {done ? 'Saved' : have > 0 ? 'Resume' : 'Save offline'}
                      </button>
                    )}
                  </div>
                </div>

                <Bar value={have / Math.max(1, clips.length)} height={3} />

                {running && progress ? (
                  <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-400">
                    <Loader2 size={10} className="animate-spin" />
                    {progress.completed}/{progress.total} fetched · {formatBytes(progress.bytes)}
                    {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
                  </p>
                ) : done ? (
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                    fully available offline
                  </p>
                ) : have > 0 ? (
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
                    {pct}% cached · ~
                    {formatBytes(storedBytes(clips.filter((c) => !cachedIds.has(c.id))))} remaining
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
          </>
        )}
      </GlassCard>

      {/* --------------------------------------------- persian translation -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<Languages size={15} />} title="Persian translation" />
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <AudioFact
            icon={<Database size={12} />}
            label="sentences pre-translated"
            value={`${translations.bundledSentences} bundled${
              translations.corpusLoaded ? ' + corpus loaded' : ''
            }`}
          />
          <AudioFact
            icon={<Layers size={12} />}
            label="glossary size"
            value={`${translations.bundledWords} words`}
          />
          <AudioFact
            icon={<CheckCircle2 size={12} />}
            label="learned this device"
            value={`${translations.cachedSentences} sentences · ${translations.cachedWords} words`}
          />
          <AudioFact
            icon={<Languages size={12} />}
            label="lookup order"
            value="bundled → cache → live"
          />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          Translations are machine-generated and pre-computed for the built-in corpus, so the common
          path needs no network at all. Anything outside it — a clip discovered live from the dataset,
          or an unseen word — is translated on demand and then cached on this device permanently.
        </p>
        <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
          Sentence and word translations are machine translation, not human review, and a single word
          often has several correct renderings depending on context — the gloss lists them where the
          source provides them. Translation data:{' '}
          <span className="text-neutral-400">Google Translate</span> with{' '}
          <span className="text-neutral-400">MyMemory</span> as the fallback service.
        </p>
      </GlassCard>

      {/* -------------------------------------------------- local storage -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<Database size={15} />} title="Local cache & storage" />
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <AudioFact
            icon={<HardDrive size={12} />}
            label="progress document"
            value={formatBytes(storageBytes)}
          />
          <AudioFact
            icon={<Layers size={12} />}
            label="seen clips"
            value={`${seenCount}/${SEEN_CLIP_CAP}`}
          />
          <AudioFact
            icon={<FileJson size={12} />}
            label="sessions kept"
            value={`${historyCount}/${SESSION_HISTORY_CAP}`}
          />
        </div>

        <div className="glass-inset mt-3 flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
              cached audio clips
            </p>
            <p className="metric mt-1 text-sm text-white">
              {audioCacheClips} clips · {formatBytes(audioCacheBytes)}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">
              Streamed from the dataset CDN and stored in IndexedDB, so replays need no network.
              {audioCacheClips > 0
                ? ` Currently averaging ${formatBytes(Math.round(audioCacheBytes / audioCacheClips))} per clip.`
                : ''}
            </p>
          </div>
          {confirmAudioClear ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onClearAudioCache();
                  setConfirmAudioClear(false);
                }}
                className="btn-ghost border-white/40 py-1.5 text-[11px] text-white"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmAudioClear(false)}
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 hover:text-white"
              >
                cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmAudioClear(true)}
              className="btn-ghost py-2 text-[12px]"
            >
              <Trash2 size={13} />
              Clear cached audio
            </button>
          )}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button type="button" onClick={onExport} className="btn-ghost py-3 text-[12px]">
            <Download size={14} />
            Export progress JSON
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="btn-ghost py-3 text-[12px]"
          >
            <Upload size={14} />
            Import progress JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setImportError(null);
              try {
                onImport(await file.text());
              } catch {
                setImportError('That file could not be read.');
              }
            }}
          />
        </div>

        {importError ? (
          <p className="mt-2 text-[11px] text-neutral-300">{importError}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.14] bg-white/[0.03] px-3.5 py-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-neutral-400" />
            <div>
              <p className="text-[12px] font-medium tracking-tight text-white">Reset all progress</p>
              <p className="mt-1 max-w-md text-[10px] leading-relaxed text-neutral-500">
                Wipes the path, badges, stars, session history, streak, XP and the cached audio. This
                cannot be undone, so export first if you want a copy.
              </p>
            </div>
          </div>
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onReset();
                  setConfirmReset(false);
                }}
                className="btn-ghost border-white/40 py-1.5 text-[11px] text-white"
              >
                Confirm reset
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 hover:text-white"
              >
                cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="btn-ghost py-2 text-[12px]"
            >
              <RotateCcw size={13} />
              Reset
            </button>
          )}
        </div>
      </GlassCard>

      {/* -------------------------------------------------------- profile -- */}
      <GlassCard className="p-5">
        <SectionHeading icon={<Gauge size={15} />} title="Progress snapshot" />
        <div className="mt-4 flex flex-wrap gap-2">
          <Pill>
            <span className="metric">{state.totalVoicesCompleted}</span>{' '}
            {pluralWord(state.totalVoicesCompleted, 'voice')}
          </Pill>
          <Pill>
            <span className="metric">{Math.round(state.overallAccuracy * 100)}%</span> overall
          </Pill>
          <Pill>
            <span className="metric">{state.xp.toLocaleString()}</span> xp
          </Pill>
          <Pill>
            <span className="metric">{state.streakDays}</span>d streak
          </Pill>
          <Pill>
            <span className="metric">{totalStars(state.path)}</span>/
            {LEVEL_NUMBERS.length * NODE_SLOTS.length * 3} stars
          </Pill>
          <Pill>
            <span className="metric">{state.path.badges.length}</span> badges
          </Pill>
          <Pill>
            fast-track L<span className="metric">{state.path.fastTrackTier}</span>
          </Pill>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          Accuracy is a true arithmetic mean over every graded voice, split into studio and
          noisy/other pools in the dashboard. Nothing here is sent anywhere.
        </p>
      </GlassCard>
    </div>
  );
}

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-neutral-500">{icon}</span>
      <h2 className="text-sm font-semibold tracking-tight text-white">{title}</h2>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-white/[0.07] pt-4 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="sm:max-w-xs">
        <p className="text-[12px] font-medium tracking-tight text-white">{label}</p>
        <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function AudioFact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="glass-inset flex flex-col gap-1 px-3 py-2.5">
      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-500">
        {icon}
        {label}
      </span>
      <span className="metric text-[13px] font-medium text-white">{value}</span>
    </div>
  );
}


