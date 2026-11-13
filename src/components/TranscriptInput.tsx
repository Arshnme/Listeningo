'use client';

import { forwardRef } from 'react';
import { CornerDownLeft, Eye, EyeOff, Keyboard, Lightbulb, Turtle } from 'lucide-react';
import { Pill } from '@/components/ui/primitives';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-white/[0.14] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-neutral-300">
      {children}
    </kbd>
  );
}

/**
 * Transcription box with a live word counter and the round's shortcut legend.
 *
 * The expected word count is a genuine hint — it narrows the search space
 * considerably on a 27-word Tier 5 sentence — so it is a toggle rather than an
 * always-on fixture.
 */
export const TranscriptInput = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
    typedWords: number;
    expectedWords: number;
    hintEnabled: boolean;
    onHintToggle: () => void;
    slowRate: number;
  }
>(function TranscriptInput(
  { value, onChange, onSubmit, disabled, typedWords, expectedWords, hintEnabled, onHintToggle, slowRate },
  ref,
) {
  const matches = typedWords === expectedWords;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="glass flex flex-col gap-3 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          htmlFor="transcript"
          className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500"
        >
          type exactly what you heard
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Pill
            className={matches ? 'border-white/45 text-white' : 'border-white/[0.1]'}
            title="Live count of the words you have typed so far"
          >
            <span className="metric">{typedWords}</span> words typed
          </Pill>

          <button
            type="button"
            onClick={onHintToggle}
            aria-pressed={hintEnabled}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.12] bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-400 transition-colors hover:border-white/30 hover:text-white"
            title="Show or hide how many words the sentence contains"
          >
            {hintEnabled ? <Eye size={10} /> : <EyeOff size={10} />}
            hint {hintEnabled ? 'on' : 'off'}
          </button>

          {hintEnabled ? (
            <Pill tone="outline" className="border-white/25 text-white" title="Length of the hidden ground-truth sentence">
              <Lightbulb size={10} />
              sentence has <span className="metric">{expectedWords}</span> words
            </Pill>
          ) : null}
        </div>
      </div>

      <input
        id="transcript"
        ref={ref}
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder={disabled ? 'Waiting for the voice…' : 'Start typing the sentence…'}
        aria-label="Your transcription of the sentence you heard"
        className="w-full rounded-2xl border border-white/[0.12] bg-white/[0.04] px-4 py-4 text-base font-medium tracking-tight text-white placeholder:text-neutral-600 backdrop-blur-xl transition-colors focus:border-white/45 focus:bg-white/[0.06] focus:outline-none disabled:opacity-50 sm:text-lg"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-neutral-500">
          <span className="inline-flex items-center gap-1.5">
            <Keyboard size={10} />
            <Kbd>Tab</Kbd>
            <span className="text-neutral-700">/</span>
            <Kbd>Ctrl</Kbd>
            <Kbd>Space</Kbd>
            replay 1.0x
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Shift</Kbd>
            <Kbd>Space</Kbd>
            <Turtle size={10} />
            slow {slowRate}x
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            submit
          </span>
        </div>

        <button type="submit" disabled={disabled} className="btn-primary py-3">
          <CornerDownLeft size={15} />
          Grade my answer
        </button>
      </div>

      <p className="text-[10px] leading-relaxed text-neutral-600">
        Punctuation and capitalisation are ignored, numbers spelled as words are accepted, and
        contractions score the same as their expanded form. Press Escape to release the Tab shortcut
        if you need to move focus with the keyboard.
      </p>
    </form>
  );
});
