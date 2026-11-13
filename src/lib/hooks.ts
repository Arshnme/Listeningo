'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  advanceStreak,
  clearState,
  defaultState,
  loadState,
  saveState,
  todayKey,
  type SaveOutcome,
} from './storage';
import type { CachedUserState } from './types';

/**
 * True only after the component has mounted on the client.
 *
 * Every persisted read is gated behind this so the server render and the first
 * client render produce identical markup: no hydration mismatch warnings, and
 * `next build` stays clean.
 */
export function useIsMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

export interface UserStateApi {
  /** False during SSR and the first paint; render skeletons until true. */
  hydrated: boolean;
  state: CachedUserState;
  /** Functional update; persisted on the next debounce tick. */
  update: (updater: (previous: CachedUserState) => CachedUserState) => void;
  /** Replaces the cache with defaults and wipes localStorage. */
  reset: () => void;
  /** Non-null when the last write had to be trimmed or failed outright. */
  storageNotice: string | null;
  dismissStorageNotice: () => void;
  /** Bytes currently held by the serialised cache. */
  cacheBytes: number;
}

/** Debounce window for localStorage writes. */
const PERSIST_DEBOUNCE_MS = 350;

/**
 * Owns the single `librispeech_vercel_cache_v1` document.
 *
 * Reads happen once on mount; writes are debounced, then verified. If the write
 * had to be trimmed to fit the quota, the in-memory state is replaced with what
 * actually landed on disk so the two never disagree.
 */
export function useUserState(): UserStateApi {
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<CachedUserState>(defaultState);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [cacheBytes, setCacheBytes] = useState(0);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<CachedUserState | null>(null);
  const hydratedRef = useRef(false);

  // --- initial hydration ---------------------------------------------------
  useEffect(() => {
    const stored = loadState();
    const base = stored ?? defaultState();
    // Streak advances on first interaction of a new day.
    const withStreak = advanceStreak(base, todayKey());
    setState(withStreak);
    setCacheBytes(JSON.stringify(withStreak).length);
    hydratedRef.current = true;
    setHydrated(true);
  }, []);

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const outcome: SaveOutcome = saveState(pending);
    setCacheBytes(outcome.bytes);
    if (!outcome.ok) {
      setStorageNotice('Local storage is full and could not be written. Progress may not persist.');
    } else if (outcome.pruned) {
      setStorageNotice('Local cache was trimmed to stay within the browser storage quota.');
      // Adopt exactly what was stored so memory and disk stay in step.
      setState(outcome.persisted);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, PERSIST_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [state, hydrated, flush]);

  // A tab close must not lose the last debounced write.
  useEffect(() => {
    const onHide = () => {
      if (pendingRef.current) flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush]);

  const update = useCallback((updater: (previous: CachedUserState) => CachedUserState) => {
    setState((previous) => {
      const next = updater(previous);
      if (next === previous) return previous;
      pendingRef.current = next;
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    clearState();
    const fresh = defaultState();
    pendingRef.current = fresh;
    setState(fresh);
    setStorageNotice(null);
  }, []);

  const dismissStorageNotice = useCallback(() => setStorageNotice(null), []);

  return useMemo(
    () => ({ hydrated, state, update, reset, storageNotice, dismissStorageNotice, cacheBytes }),
    [hydrated, state, update, reset, storageNotice, dismissStorageNotice, cacheBytes],
  );
}

/**
 * Tracks a CSS media query. Used to tone down the visualiser on phones and to
 * respect `prefers-reduced-motion`.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', listener);
    return () => list.removeEventListener('change', listener);
  }, [query]);
  return matches;
}

/** Monotonic clock for animation loops, paused while the tab is hidden. */
export function useAnimationFrame(callback: (deltaMs: number) => void, active: boolean): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      callbackRef.current(delta);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [active]);
}
