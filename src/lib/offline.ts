import { fetchClipBlob, DatasetError } from './hf';
import { getCachedClipIds } from './idb';
import type { ManifestClip } from './types';

/**
 * Bulk audio download, so a tier can be played entirely offline.
 *
 * This is how the corpus is "selected and stored" without putting ~84 MB of FLAC
 * into the repository: the bytes live in the learner's own IndexedDB, fetched
 * from the CDN on demand. The Vercel deployment stays tiny and no audio ever
 * passes through a serverless function.
 *
 * Downloads run sequentially with a small concurrency. A burst of parallel
 * requests against the datasets-server is the fastest way to get rate limited,
 * and a bulk download is exactly when a stall is least welcome.
 */

export interface DownloadProgress {
  /** Clips this run intends to fetch. */
  total: number;
  /** Clips already present in the cache before this run started. */
  alreadyCached: number;
  /** Clips fetched so far in this run. */
  completed: number;
  /** Failures, which leave the clip available to retry later. */
  failed: number;
  /** Bytes fetched in this run. */
  bytes: number;
}

const CONCURRENCY = 2;

/** Which of these clips are already stored locally. */
export async function cachedSubset(clips: readonly ManifestClip[]): Promise<Set<string>> {
  const cached = await getCachedClipIds();
  const present = new Set<string>();
  for (const clip of clips) {
    if (cached.has(clip.id)) present.add(clip.id);
  }
  return present;
}

/**
 * Downloads every clip not already cached.
 *
 * Resolves with the final progress; `signal` aborts cleanly and keeps whatever
 * has already been stored, so a cancelled download is still progress.
 */
export async function downloadClips(
  clips: readonly ManifestClip[],
  options: {
    onProgress?: (progress: DownloadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<DownloadProgress> {
  const { onProgress, signal } = options;
  const alreadyCached = await cachedSubset(clips);
  const pending = clips.filter((clip) => !alreadyCached.has(clip.id));

  const progress: DownloadProgress = {
    total: pending.length,
    alreadyCached: alreadyCached.size,
    completed: 0,
    failed: 0,
    bytes: 0,
  };
  onProgress?.({ ...progress });

  let cursor = 0;

  const worker = async () => {
    while (!signal?.aborted) {
      const index = cursor;
      cursor += 1;
      const clip = pending[index];
      if (!clip) return;
      try {
        const { blob } = await fetchClipBlob(clip, signal);
        progress.completed += 1;
        progress.bytes += blob.size;
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof DatasetError && error.code === 'aborted') return;
        progress.failed += 1;
      }
      onProgress?.({ ...progress });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  return progress;
}
