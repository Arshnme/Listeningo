import { getCachedClip, putCachedClip } from './idb';
import { isLikelyEnglish } from './english';
import { fetchBundledAudio } from './localAudio';
import { countWords } from './text';
import type { AudioSourceKind, DatasetConfig, ManifestClip } from './types';

/**
 * Client-side resolver for LibriSpeech audio.
 *
 * Everything here runs in the browser: the app ships no audio and no serverless
 * proxy, so a Vercel Hobby deployment never pays a bandwidth bill or risks a
 * 10-second function timeout.
 *
 * The datasets-server hands out CloudFront URLs that are signed and expiring
 * (roughly a year, but expiring all the same), which is why the shipped manifest
 * stores each clip's `(config, split, rowIdx)` rather than a URL. A single
 * one-row request re-signs a fresh URL on demand, and the bytes are then kept in
 * IndexedDB so replays and repeat sessions need no network at all.
 */

const DEFAULT_API = 'https://datasets-server.huggingface.co';
const DATASET = 'openslr/librispeech_asr';

const API_BASE = (process.env.NEXT_PUBLIC_HF_DATASETS_SERVER || DEFAULT_API).replace(/\/+$/, '');

/**
 * Retry budgets.
 *
 * The interactive budget is deliberately tight. A learner is staring at a
 * "Loading voice…" button while it runs, and the Web Speech fallback is already
 * good, so waiting a minute for a flaky host is far worse than switching voice
 * source after a few seconds. Background pool discovery has no user waiting on
 * it and can afford to be patient.
 */
interface RetryBudget {
  attempts: number;
  timeoutMs: number;
  /** Ceiling for exponential backoff between attempts. */
  maxBackoffMs: number;
}

const INTERACTIVE_BUDGET: RetryBudget = { attempts: 2, timeoutMs: 8_000, maxBackoffMs: 1_500 };
const BACKGROUND_BUDGET: RetryBudget = { attempts: 4, timeoutMs: 15_000, maxBackoffMs: 12_000 };

const AUDIO_TIMEOUT_MS = 12_000;

/** Typed failure so the UI can explain what went wrong and fall back cleanly. */
export class DatasetError extends Error {
  readonly code: 'network' | 'rate_limited' | 'not_found' | 'invalid_audio' | 'aborted';

  constructor(code: DatasetError['code'], message: string) {
    super(message);
    this.name = 'DatasetError';
    this.code = code;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    return await fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

function backoffDelay(attempt: number, rateLimited: boolean, maxBackoffMs: number): number {
  const base = rateLimited ? 900 : 400;
  const jitter = Math.random() * 250;
  return Math.min(maxBackoffMs, base * 2 ** attempt + jitter);
}

function requestUrl(path: string, params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  search.set('dataset', DATASET);
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return `${API_BASE}/${path}?${search.toString()}`;
}

async function getJson<T>(
  url: string,
  signal?: AbortSignal,
  budget: RetryBudget = BACKGROUND_BUDGET,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < budget.attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, budget.timeoutMs, signal);
      if (response.status === 429) {
        lastError = new DatasetError('rate_limited', 'The dataset server is rate limiting requests.');
        if (attempt < budget.attempts - 1) {
          await sleep(backoffDelay(attempt, true, budget.maxBackoffMs));
        }
        continue;
      }
      if (response.status === 404) {
        throw new DatasetError('not_found', 'That clip is no longer available in the dataset.');
      }
      if (!response.ok) {
        lastError = new DatasetError('network', `Dataset server responded ${response.status}.`);
        await sleep(backoffDelay(attempt, false, budget.maxBackoffMs));
        continue;
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DatasetError && error.code === 'not_found') throw error;
      if (signal?.aborted) throw new DatasetError('aborted', 'Request cancelled.');
      lastError = error;
      if (attempt < budget.attempts - 1) {
        await sleep(backoffDelay(attempt, false, budget.maxBackoffMs));
      }
    }
  }
  if (lastError instanceof DatasetError) throw lastError;
  throw new DatasetError('network', 'Could not reach the LibriSpeech dataset server.');
}

interface RowAudio {
  src?: string;
  type?: string;
}

interface RowPayload {
  row_idx: number;
  row: {
    id: string;
    text: string;
    speaker_id: number;
    chapter_id: number;
    audio?: RowAudio[];
  };
}

interface RowsResponse {
  rows?: RowPayload[];
}

interface SizeEntry {
  config: string;
  split: string;
  num_rows: number;
}

interface SizeResponse {
  size?: { splits?: SizeEntry[] };
}

const numRowsCache = new Map<string, number>();

/** Row count for a config/split pair, memoised for the page lifetime. */
export async function getSplitCount(config: DatasetConfig, split: 'test' | 'validation'): Promise<number> {
  const key = `${config}/${split}`;
  const cached = numRowsCache.get(key);
  if (cached !== undefined) return cached;

  const payload = await getJson<SizeResponse>(requestUrl('size', {}));
  let found = 0;
  for (const entry of payload.size?.splits ?? []) {
    numRowsCache.set(`${entry.config}/${entry.split}`, entry.num_rows);
    if (entry.config === config && entry.split === split) found = entry.num_rows;
  }
  return found;
}

function rowToClip(
  payload: RowPayload,
  config: DatasetConfig,
  split: 'test' | 'validation',
  level: ManifestClip['level'],
): ManifestClip {
  const splitLabel = (
    split === 'test'
      ? config === 'clean'
        ? 'test-clean'
        : 'test-other'
      : config === 'clean'
        ? 'dev-clean'
        : 'dev-other'
  ) as ManifestClip['splitLabel'];

  return {
    id: payload.row.id,
    text: payload.row.text,
    speakerId: String(payload.row.speaker_id),
    chapterId: String(payload.row.chapter_id),
    config,
    split,
    splitLabel,
    rowIdx: payload.row_idx,
    level,
    wordCount: countWords(payload.row.text),
    speakerMinutes: 0,
    index: 0,
  };
}

/** In-flight URL resolutions, so two rounds never double-request the same row. */
const urlCache = new Map<string, string>();

/**
 * Re-signs a fresh CDN URL for a clip.
 *
 * The response is verified against the requested id: the dataset server is
 * authoritative, and a silent row shift would otherwise play the wrong sentence
 * under the right transcript.
 */
export async function resolveAudioUrl(
  clip: ManifestClip,
  signal?: AbortSignal,
  budget: RetryBudget = INTERACTIVE_BUDGET,
): Promise<string> {
  const cached = urlCache.get(clip.id);
  if (cached) return cached;

  const payload = await getJson<RowsResponse>(
    requestUrl('rows', { config: clip.config, split: clip.split, offset: clip.rowIdx, length: 1 }),
    signal,
    budget,
  );
  const row = payload.rows?.[0];
  const src = row?.row.audio?.[0]?.src;
  if (!row || !src) {
    throw new DatasetError('not_found', `No audio published for clip ${clip.id}.`);
  }
  if (row.row.id !== clip.id) {
    throw new DatasetError(
      'invalid_audio',
      `Dataset row ${clip.rowIdx} now holds ${row.row.id}, expected ${clip.id}.`,
    );
  }
  urlCache.set(clip.id, src);
  return src;
}

function looksLikeFlac(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 512) return false;
  const header = new Uint8Array(buffer, 0, 4);
  // Either a native FLAC stream, or an ID3 container wrapping one.
  return header[0] === 0x66 && header[1] === 0x4c && header[2] === 0x61 && header[3] === 0x43;
}

/**
 * Downloads a clip's bytes and returns a typed Blob.
 *
 * Resolution order is bundled file → IndexedDB cache → dataset server. Every
 * bundled clip is a static WebM/Opus asset of this app, so the common path is
 * same-origin, offline-capable and edge-cached; the dataset route remains only
 * as the fallback for a trimmed build or a live-discovered clip. Wrapping bytes
 * in a Blob with an explicit MIME type also makes them same-origin, which lets
 * the Web Audio graph read real spectrum data without CORS tainting.
 */
export async function fetchClipBlob(
  clip: ManifestClip,
  signal?: AbortSignal,
  options: { skipCacheWrite?: boolean } = {},
): Promise<{ blob: Blob; source: AudioSourceKind }> {
  // Bundled first, and deliberately *without* touching the IndexedDB cache:
  // re-storing a static asset the browser already caches immutably would just
  // duplicate the corpus inside the user's storage.
  const bundled = await fetchBundledAudio(clip.id, signal);
  if (bundled) return { blob: bundled, source: 'bundled' };

  const cached = await getCachedClip(clip.id);
  if (cached) return { blob: cached, source: 'cache' };

  const url = await resolveAudioUrl(clip, signal);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < INTERACTIVE_BUDGET.attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, AUDIO_TIMEOUT_MS, signal);
      if (response.status === 403) {
        // Signed URL expired mid-flight: drop it and re-sign once.
        urlCache.delete(clip.id);
        lastError = new DatasetError('not_found', 'The signed audio URL expired.');
        if (attempt < INTERACTIVE_BUDGET.attempts - 1) {
          await resolveAudioUrl(clip, signal);
          continue;
        }
        break;
      }
      if (!response.ok) {
        lastError = new DatasetError('network', `Audio download failed (${response.status}).`);
        await sleep(backoffDelay(attempt, response.status === 429, INTERACTIVE_BUDGET.maxBackoffMs));
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (!looksLikeFlac(buffer)) {
        throw new DatasetError('invalid_audio', 'Downloaded data was not a FLAC stream.');
      }
      const blob = new Blob([buffer], { type: 'audio/flac' });
      // Persisting is best-effort: a full or disabled cache must not fail the round.
      // When the caller intends to store a compressed copy it skips this write, so
      // the cache is not filled with FLAC only to be overwritten a moment later.
      if (!options.skipCacheWrite) void putCachedClip(clip.id, blob);
      return { blob, source: 'dataset' };
    } catch (error) {
      if (signal?.aborted) throw new DatasetError('aborted', 'Request cancelled.');
      lastError = error;
      if (error instanceof DatasetError && error.code === 'invalid_audio') break;
      await sleep(backoffDelay(attempt, false, INTERACTIVE_BUDGET.maxBackoffMs));
    }
  }

  if (lastError instanceof DatasetError) throw lastError;
  throw new DatasetError('network', 'Could not download this clip.');
}

/** Fetches unrelated rows, used to grow the pool beyond the shipped manifest. */
export async function discoverClips(params: {
  config: DatasetConfig;
  split: 'test' | 'validation';
  level: ManifestClip['level'];
  minWords: number;
  maxWords: number;
  exclude: ReadonlySet<string>;
  desired: number;
  signal?: AbortSignal;
}): Promise<ManifestClip[]> {
  const { config, split, level, minWords, maxWords, exclude, desired, signal } = params;
  const total = await getSplitCount(config, split);
  if (total <= 0) return [];

  const found: ManifestClip[] = [];
  const seenHere = new Set<string>();
  const pageSize = 100;
  const maxPages = 3;

  for (let page = 0; page < maxPages && found.length < desired; page += 1) {
    const maxOffset = Math.max(0, total - pageSize);
    const offset = Math.floor(Math.random() * (maxOffset + 1));
    let payload: RowsResponse;
    try {
      payload = await getJson<RowsResponse>(
        requestUrl('rows', { config, split, offset, length: pageSize }),
        signal,
      );
    } catch {
      break;
    }
    for (const entry of payload.rows ?? []) {
      const words = countWords(entry.row.text);
      if (words < minWords || words > maxWords) continue;
      // The shipped corpus is English-vetted at build time; runtime discovery is
      // not, and LibriSpeech is not exclusively English.
      if (!isLikelyEnglish(entry.row.text)) continue;
      if (exclude.has(entry.row.id) || seenHere.has(entry.row.id)) continue;
      seenHere.add(entry.row.id);
      found.push(rowToClip(entry, config, split, level));
      if (found.length >= desired) break;
    }
  }
  return found;
}
