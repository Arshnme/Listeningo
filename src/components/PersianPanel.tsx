'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Info, Loader2 } from '@/components/ui/icons';
import {
  resolveSentence,
  resolveWord,
  type TranslationSource,
  type WordGloss,
} from '@/lib/translationService';

/**
 * Persian translation surfaces for the graded report.
 *
 * Two separate reveals, because they answer different questions: the sentence
 * toggle gives the whole meaning, and tapping a single word gives a dictionary
 * gloss for the piece the learner got stuck on.
 *
 * Both expand with a CSS transition rather than a JS animation. That is a
 * functional requirement, not a style preference: a toggle whose closing depends
 * on an animation frame completing can become impossible to close if frames stop
 * arriving, and `prefers-reduced-motion` would otherwise leave it stuck open.
 */

/** Humane label for where a translation came from. */
function sourceLabel(source: TranslationSource | null): string {
  switch (source) {
    case 'core':
      return 'bundled';
    case 'corpus':
      return 'pre-translated';
    case 'cache':
      return 'cached';
    case 'live':
      return 'machine translation';
    default:
      return '';
  }
}

/**
 * Eye toggle plus the collapsible Persian sentence.
 *
 * Local translations render on the same tick as the click; only a genuinely
 * unseen clip shows a loading state.
 */
export function PersianSentence({
  clipId,
  english,
}: {
  clipId: string;
  english: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [source, setSource] = useState<TranslationSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset whenever the round changes, so a new voice never shows the last one's
  // translation.
  useEffect(() => {
    setOpen(false);
    setText(null);
    setSource(null);
    setFailed(false);
  }, [clipId]);

  const request = useCallback(async () => {
    if (text || loading) return;
    setLoading(true);
    setFailed(false);
    const result = await resolveSentence(clipId, english);
    if (result) {
      setText(result.value);
      setSource(result.source);
    } else {
      setFailed(true);
    }
    setLoading(false);
  }, [clipId, english, text, loading]);

  const toggle = useCallback(() => {
    setOpen((previous) => {
      const next = !previous;
      if (next) void request();
      return next;
    });
  }, [request]);

  return (
    <div className="mt-3 border-t border-white/[0.07] pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
          Persian translation
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? 'Hide Persian translation' : 'Show Persian Translation'}
          title={open ? 'Hide Persian translation' : 'Show Persian Translation'}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
            open
              ? 'border-white/70 bg-white/[0.1] text-white'
              : 'border-white/[0.12] bg-white/[0.03] text-neutral-400 hover:border-white/30 hover:text-white'
          }`}
        >
          {open ? <EyeOff size={11} /> : <Eye size={11} />}
          {open ? 'hide' : 'Persian'}
        </button>
      </div>

      {/* CSS grid-rows reveal: the closed state has a real height of zero, so it
          also removes itself from the accessibility tree. */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div className="mt-2.5 rounded-2xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-3 backdrop-blur-xl">
            {loading ? (
              <LoadingDots label="translating" />
            ) : failed ? (
              <p className="text-[11px] leading-relaxed text-neutral-500">
                No Persian translation is available for this voice right now. It will be looked up
                again next time.
              </p>
            ) : (
              <>
                <p dir="rtl" lang="fa" className="fa-text text-base text-white sm:text-lg">
                  {text}
                </p>
                <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-600">
                  <Info size={9} />
                  {sourceLabel(source)}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The three-dot monochrome shimmer used while a lookup is in flight. */
function LoadingDots({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 py-0.5">
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
            style={{ animationDelay: `${dot * 160}ms` }}
          />
        ))}
      </span>
      <Loader2 size={11} className="animate-spin text-neutral-500" />
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
        {label}
      </span>
    </span>
  );
}

export interface WordAnchor {
  word: string;
  /** Position within the sentence container, in px. */
  x: number;
  y: number;
}

/**
 * Floating glass gloss for one tapped word.
 *
 * Anchored to the tapped token and clamped to the container so it never spills
 * off a narrow screen. Dismissed by tapping elsewhere, pressing Escape, or
 * tapping a different word (which simply re-anchors it).
 */
export function PersianWordPopover({
  anchor,
  boundsWidth,
  onDismiss,
}: {
  anchor: WordAnchor | null;
  boundsWidth: number;
  onDismiss: () => void;
}) {
  const [gloss, setGloss] = useState<WordGloss | null>(null);
  const [source, setSource] = useState<TranslationSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!anchor) {
      setGloss(null);
      setSource(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setGloss(null);
    setFailed(false);
    void resolveWord(anchor.word).then((result) => {
      if (cancelled) return;
      if (result) {
        setGloss(result.value);
        setSource(result.source);
      } else {
        setFailed(true);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (cardRef.current && target && cardRef.current.contains(target)) return;
      // Clicks on another word re-anchor via the token handler, so only clicks
      // outside the sentence area close the card.
      const inSentence = (target as HTMLElement | null)?.closest?.('[data-persian-words]');
      if (inSentence) return;
      onDismiss();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [anchor, onDismiss]);

  if (!anchor) return null;

  // Keep the card inside the sentence column even when the word sits at an edge.
  const width = Math.min(320, Math.max(200, boundsWidth));
  const left = Math.max(0, Math.min(anchor.x - width / 2, Math.max(0, boundsWidth - width)));

  return (
    <div
      className="absolute z-30"
      style={{ left, top: anchor.y, width }}
      role="dialog"
      aria-label={`Persian meaning of ${anchor.word}`}
    >
      <div
        ref={cardRef}
        className="glass-strong relative animate-[menu-in_140ms_ease-out] p-3"
        style={{ boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.25), 0 18px 40px rgba(0,0,0,0.9)' }}
      >
        {/* Caret pointing back up at the word. */}
        <span
          aria-hidden
          className="absolute -top-[6px] h-3 w-3 rotate-45 border-l border-t border-white/[0.16] bg-white/[0.05]"
          style={{ left: Math.max(10, Math.min(width - 22, anchor.x - left - 6)) }}
        />
        <div className="relative">
          {/* No pronounce button here: the only voice this app is allowed to
              play is genuine LibriSpeech audio, and the OS synthesiser is not
              that. The word is shown for reading instead. */}
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.08] pb-2">
            <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white">
              {anchor.word.toLowerCase()}
            </span>
          </div>

          <div className="mt-2.5">
            {loading ? (
              <LoadingDots label="looking up" />
            ) : failed ? (
              <p className="text-[11px] leading-relaxed text-neutral-500">
                No Persian gloss found for this word. It may be a name or a rare form.
              </p>
            ) : gloss ? (
              <>
                <p dir="rtl" lang="fa" className="fa-text text-lg leading-[1.9] text-white">
                  {gloss.t}
                </p>
                {gloss.s.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1.5 border-t border-white/[0.07] pt-2">
                    {gloss.s.map((sense) => (
                      <li key={sense.p} className="flex items-start gap-2">
                        <span className="mt-[3px] shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-500">
                          {sense.p}
                        </span>
                        <span
                          dir="rtl"
                          lang="fa"
                          className="fa-text flex-1 text-[13px] leading-[1.9] text-neutral-200"
                        >
                          {sense.g.join('، ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-600">
                  {sourceLabel(source)} · meaning depends on context
                </p>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
