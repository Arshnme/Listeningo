/**
 * IndexedDB store for decoded-source audio blobs.
 *
 * The Hugging Face CDN serves FLAC as `binary/octet-stream` and hand out
 * short-lived signed URLs, so a raw `<audio src="...">` is fragile and a stored
 * URL goes stale. Caching the *bytes* fixes both problems at once: a cached clip
 * replays instantly, works offline, and never expires.
 *
 * Everything degrades to a no-op when IndexedDB is unavailable (Safari private
 * mode, disabled storage), in which case the player simply re-fetches.
 */

const DB_NAME = 'librispeech_audio_cache_v1';
const DB_VERSION = 1;
const STORE = 'clips';

/** Maximum number of cached clips before the oldest are evicted. */
export const AUDIO_CACHE_MAX_CLIPS = 200;

export interface CachedClipRecord {
  id: string;
  blob: Blob;
  bytes: number;
  savedAt: number;
}

export interface AudioCacheStats {
  clips: number;
  bytes: number;
}

function hasIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  // A failed open must not poison every later call.
  void dbPromise.then((db) => {
    if (!db) dbPromise = null;
  });

  return dbPromise;
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const request = work(tx.objectStore(STORE));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/** Reads a cached clip blob, or null when it is not stored. */
export async function getCachedClip(id: string): Promise<Blob | null> {
  const record = await runTransaction<CachedClipRecord | undefined>('readonly', (store) =>
    store.get(id) as IDBRequest<CachedClipRecord | undefined>,
  );
  if (!record || !(record.blob instanceof Blob)) return null;
  return record.blob;
}

/** Stores a clip blob, then prunes the cache back under the clip cap. */
export async function putCachedClip(id: string, blob: Blob): Promise<boolean> {
  const record: CachedClipRecord = {
    id,
    blob,
    bytes: blob.size,
    savedAt: Date.now(),
  };
  const written = await runTransaction<IDBValidKey>('readwrite', (store) =>
    store.put(record) as IDBRequest<IDBValidKey>,
  );
  if (written === null) return false;
  await pruneAudioCache();
  return true;
}

/** Evicts the least recently stored clips once the cap is exceeded. */
export async function pruneAudioCache(max = AUDIO_CACHE_MAX_CLIPS): Promise<number> {
  return new Promise<number>((resolve) => {
    void openDb().then((db) => {
      if (!db) {
        resolve(0);
        return;
      }
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const countRequest = store.count();
        countRequest.onsuccess = () => {
          const excess = countRequest.result - max;
          if (excess <= 0) {
            resolve(0);
            return;
          }
          const index = store.index('savedAt');
          let removed = 0;
          const cursorRequest = index.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || removed >= excess) {
              resolve(removed);
              return;
            }
            cursor.delete();
            removed += 1;
            cursor.continue();
          };
          cursorRequest.onerror = () => resolve(removed);
        };
        countRequest.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });
  });
}

/** Ids currently held by the audio cache, for per-tier coverage readouts. */
export async function getCachedClipIds(): Promise<Set<string>> {
  const keys = await runTransaction<IDBValidKey[]>('readonly', (store) =>
    store.getAllKeys() as IDBRequest<IDBValidKey[]>,
  );
  if (!keys) return new Set();
  return new Set(keys.filter((key): key is string => typeof key === 'string'));
}

/** Clip count and total bytes held by the audio cache. */
export async function getAudioCacheStats(): Promise<AudioCacheStats> {
  return new Promise<AudioCacheStats>((resolve) => {
    void openDb().then((db) => {
      if (!db) {
        resolve({ clips: 0, bytes: 0 });
        return;
      }
      try {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const request = store.getAll();
        request.onsuccess = () => {
          const records = (request.result ?? []) as CachedClipRecord[];
          resolve({
            clips: records.length,
            bytes: records.reduce((sum, record) => sum + (record.bytes ?? 0), 0),
          });
        };
        request.onerror = () => resolve({ clips: 0, bytes: 0 });
      } catch {
        resolve({ clips: 0, bytes: 0 });
      }
    });
  });
}

/** Wipes the audio cache. Used by the "Clear Local Cache" utility. */
export async function clearAudioCache(): Promise<void> {
  await runTransaction<undefined>('readwrite', (store) => store.clear() as IDBRequest<undefined>);
}
