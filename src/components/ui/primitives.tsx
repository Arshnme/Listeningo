'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ Glass -- */

export function GlassCard({
  children,
  className = '',
  variant = 'base',
  sheen = false,
}: {
  children: ReactNode;
  className?: string;
  variant?: 'base' | 'strong' | 'inset';
  sheen?: boolean;
}) {
  const variantClass =
    variant === 'strong' ? 'glass-strong' : variant === 'inset' ? 'glass-inset' : 'glass';
  return (
    <div className={`${variantClass} ${sheen ? 'glass-sheen' : ''} ${className}`}>{children}</div>
  );
}

/* ------------------------------------------------------------------- Pills -- */

export function Pill({
  children,
  tone = 'ghost',
  className = '',
  title,
}: {
  children: ReactNode;
  tone?: 'ghost' | 'solid' | 'outline';
  className?: string;
  title?: string;
}) {
  const toneClass =
    tone === 'solid'
      ? 'pill-solid'
      : tone === 'outline'
        ? 'pill border-white/40 text-white'
        : 'pill';
  return (
    <span className={`${toneClass} ${className}`} title={title}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Toggle -- */

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={hint}
      className="group inline-flex items-center gap-2.5 rounded-full border border-white/[0.12] bg-white/[0.03] py-1.5 pl-3 pr-1.5 transition-colors hover:border-white/25 disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-300 group-hover:text-neutral-100">
        {label}
      </span>
      <span
        className={`relative flex h-5 w-9 items-center rounded-full border transition-colors duration-300 ${
          checked ? 'border-white bg-white' : 'border-white/20 bg-white/[0.06]'
        }`}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 620, damping: 34 }}
          className={`block h-3.5 w-3.5 rounded-full ${checked ? 'ml-[18px] bg-black' : 'ml-[3px] bg-white/70'}`}
        />
      </span>
    </button>
  );
}

/* ------------------------------------------------------- SegmentedControl -- */

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="glass-inset flex items-center gap-0.5 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => onChange(option.value)}
            // The active state is expressed with static classes rather than an
            // animated shared-layout pill. `text-black` on the dark surface
            // would be unreadable if the pill failed to render because the
            // browser stopped producing frames.
            className={`relative rounded-[14px] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors duration-200 ${
              active
                ? 'bg-white font-semibold text-black'
                : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            <span className="relative z-10 whitespace-nowrap">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Badges -- */

export function StatusDot({ tone = 'idle' }: { tone?: 'idle' | 'live' | 'warn' }) {
  const color = tone === 'live' ? 'bg-white' : tone === 'warn' ? 'bg-neutral-400' : 'bg-neutral-600';
  return (
    <span className="relative flex h-1.5 w-1.5">
      {tone !== 'idle' && (
        <span className={`absolute inline-flex h-full w-full animate-pulse-ring rounded-full ${color}`} />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

/* ----------------------------------------------------------------- Metrics -- */

export function MetricBlock({
  label,
  value,
  sub,
  icon,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`glass-inset flex flex-col gap-2 p-4 ${emphasis ? 'border-white/25 bg-white/[0.05]' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
          {label}
        </span>
        {icon ? <span className="text-neutral-500">{icon}</span> : null}
      </div>
      <div className="metric text-3xl font-semibold leading-none text-white">{value}</div>
      {sub ? <div className="text-[11px] leading-snug text-neutral-400">{sub}</div> : null}
    </div>
  );
}

/**
 * Horizontal progress / accuracy bar, monochrome.
 *
 * Width is applied through a CSS transition rather than a JS animation loop: the
 * displayed value has to be correct even when frames are not being produced.
 */
export function Bar({
  value,
  className = '',
  height = 4,
}: {
  /** 0..1 */
  value: number;
  className?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-white/[0.08] ${className}`}
      style={{ height }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div
        className="h-full rounded-full bg-white transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Two-segment comparison bar for Clean vs Noisy accuracy. */
export function SplitBar({ clean, noisy }: { clean: number; noisy: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
        <span>clean</span>
        <span className="metric text-neutral-300">{Math.round(clean * 100)}%</span>
      </div>
      <Bar value={clean} />
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
        <span>noisy / other</span>
        <span className="metric text-neutral-300">{Math.round(noisy * 100)}%</span>
      </div>
      <Bar value={noisy} />
    </div>
  );
}

/* --------------------------------------------------------------- Skeletons -- */

export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/**
 * Shown until the localStorage cache has been read. Rendering this on both the
 * server and the first client pass is what keeps hydration warning-free.
 */
export function AppSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <SkeletonBlock className="h-16 w-full rounded-3xl" />
      <SkeletonBlock className="h-56 w-full rounded-3xl" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonBlock className="h-28 rounded-2xl" />
        <SkeletonBlock className="h-28 rounded-2xl" />
        <SkeletonBlock className="h-28 rounded-2xl" />
        <SkeletonBlock className="h-28 rounded-2xl" />
      </div>
      <SkeletonBlock className="h-40 w-full rounded-3xl" />
    </div>
  );
}

/* --------------------------------------------------------------- EmptyState -- */

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="glass-inset flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon ? <span className="text-neutral-600">{icon}</span> : null}
      <p className="text-sm font-medium text-neutral-200">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-neutral-500">{body}</p>
    </div>
  );
}
