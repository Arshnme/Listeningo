'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { Star } from '@/components/ui/icons';
import { STAGE_WIDTH, characterAnchor } from '@/lib/conduit';
import { uiSounds } from '@/lib/uiSoundEngine';
import type { DifficultyLevel } from '@/lib/types';

/**
 * The animated 3D companion that stands in each unit's open bend.
 *
 * Two art layers, layered for reliability:
 *
 * 1. **A built-in volumetric rig** drawn entirely with CSS gradients, borders
 *    and shadows — one parameterised character per unit (bot, owl, bear, fox,
 *    dragon-DJ). It renders on the very first frame with zero network cost, so
 *    a character is *never* missing or broken.
 * 2. **A high-resolution animated Fluent 3D asset** (Microsoft's animated
 *    emoji set, served from the community mirror on GitHub) that fades in over
 *    the rig once it actually loads, `loading="lazy"` so offscreen units cost
 *    nothing. If the request fails, the rig simply stays.
 *
 * Placement is derived from the same coordinate grid as the conduit
 * (`characterAnchor`), which guarantees by construction that the companion
 * never overlaps a header or a node: it stands between rows 1 and 2 on the
 * side opposite the curve's apex.
 *
 * Interactions are deliberate and throttled: a hover or tap triggers a happy
 * hop with a 3D flip, a short two-note sparkle, and a speech bubble that
 * dismisses itself after 2.5s. Reactions are rate-limited so dragging the
 * mouse across the path cannot machine-gun the chime, and the animation is
 * skipped entirely under `prefers-reduced-motion` — the bubble and the sound
 * still work, so the character stays alive without motion.
 */

interface MascotDefinition {
  name: string;
  role: string;
  /** Animated Fluent 3D asset; the rig shows until this resolves. */
  asset: string;
  /** Speech-bubble lines, cycled one per interaction. */
  lines: readonly string[];
  rig: 'bot' | 'owl' | 'bear' | 'fox' | 'dj';
}

const FLUENT_BASE =
  'https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis';

export const MASCOTS: Readonly<Record<DifficultyLevel, MascotDefinition>> = {
  1: {
    name: 'Echo',
    role: 'the Audio Bot',
    asset: `${FLUENT_BASE}/Smilies/Robot.png`,
    lines: ['Tap the glowing star to start!', 'Headphones on — let’s listen!'],
    rig: 'bot',
  },
  2: {
    name: 'Ollie',
    role: 'the Wise Owl',
    asset: `${FLUENT_BASE}/Animals/Owl.png`,
    lines: ['Hoot! Longer sentences ahead.', 'Try without Slow Mode to skip ahead!'],
    rig: 'owl',
  },
  3: {
    name: 'Bernie',
    role: 'the Listener',
    asset: `${FLUENT_BASE}/Animals/Bear.png`,
    lines: ['Take your time — every word counts.'],
    rig: 'bear',
  },
  4: {
    name: 'Foxy',
    role: 'the Noise Hunter',
    asset: `${FLUENT_BASE}/Animals/Fox.png`,
    lines: ['Noise waves incoming — stay sharp!'],
    rig: 'fox',
  },
  5: {
    name: 'Blaze',
    role: 'the Master DJ',
    asset: `${FLUENT_BASE}/Animals/Dragon.png`,
    lines: ['Final stretch. Master the crowd!'],
    rig: 'dj',
  },
};

/** Shared pieces of the rig: body, head and the studio headphones. */
function RigBase({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Body — a soft glass torso the head sits on. */}
      <span className="absolute inset-x-[16%] bottom-[4%] top-[42%] rounded-[45%_45%_38%_38%] border border-white/[0.12] bg-gradient-to-b from-white/[0.16] to-white/[0.03] shadow-[inset_0_1px_1px_rgba(255,255,255,0.28),0_10px_16px_rgba(0,0,0,0.65)]" />
      {/* Head — the brightest surface, like the pucks. */}
      <span className="absolute left-1/2 top-[8%] h-[46%] w-[70%] -translate-x-1/2 rounded-[48%] border border-white/[0.16] bg-gradient-to-b from-white/[0.24] to-white/[0.05] shadow-[inset_0_2px_3px_rgba(255,255,255,0.35),0_10px_18px_rgba(0,0,0,0.6)]" />
      {/* Oversized studio headphones: band + ear cups. */}
      <span className="absolute left-1/2 top-[4%] h-[34%] w-[86%] -translate-x-1/2 rounded-t-full border-x-[3px] border-t-[3px] border-white/[0.28]" />
      <span className="absolute left-[3%] top-[30%] h-[18%] w-[15%] rounded-full border border-white/[0.2] bg-gradient-to-b from-white/[0.18] to-black/70 shadow-[0_4px_0_0_#101013]" />
      <span className="absolute right-[3%] top-[30%] h-[18%] w-[15%] rounded-full border border-white/[0.2] bg-gradient-to-b from-white/[0.18] to-black/70 shadow-[0_4px_0_0_#101013]" />
      {children}
    </>
  );
}

/**
 * The hand-built 3D rig fallback: a metallic-and-glass mascot with blinking
 * eyes, breathing torso and per-unit silhouette parts (sound rings, owl tufts,
 * bear snout, fox ears, dragon horns).
 */
function MascotRig({ variant }: { variant: MascotDefinition['rig'] }) {
  return (
    <div className="absolute inset-0" aria-hidden>
      <RigBase>
        {/* Eyes — reused by every variant, blinking on their own clock. */}
        <span className="absolute inset-0">
          <span className="absolute left-[30%] top-[26%] h-[6%] w-[9%] animate-[mascot-blink_4.4s_ease-in-out_infinite] rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]" />
          <span className="absolute right-[30%] top-[26%] h-[6%] w-[9%] animate-[mascot-blink_4.4s_ease-in-out_infinite] rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]" />
        </span>

        {variant === 'bot' ? (
          <>
            {/* Glass visor band + antenna + LED chest. */}
            <span className="absolute left-1/2 top-[22%] h-[14%] w-[62%] -translate-x-1/2 rounded-full border border-white/[0.2] bg-gradient-to-b from-white/[0.14] to-transparent" />
            <span className="absolute left-1/2 top-[-4%] h-[12%] w-[2%] -translate-x-1/2 rounded-full bg-white/40" />
            <span className="absolute left-1/2 top-[-6%] h-[5%] w-[5%] -translate-x-1/2 animate-[stone-breathe_1.6s_ease-in-out_infinite] rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]" />
            <span className="absolute left-1/2 top-[56%] h-[3%] w-[26%] -translate-x-1/2 rounded-full bg-white/35" />
            {/* Sound rings travelling out of the right ear cup. */}
            <span className="absolute right-[-4%] top-[28%] h-[24%] w-[12%] animate-[mascot-ring_2.2s_ease-out_infinite] rounded-full border-2 border-white/50" />
            <span className="absolute right-[-8%] top-[26%] h-[28%] w-[14%] animate-[mascot-ring_2.2s_ease-out_infinite] rounded-full border border-white/30" style={{ animationDelay: '0.6s' }} />
          </>
        ) : null}

        {variant === 'owl' ? (
          <>
            {/* Ear tufts + beak. */}
            <span className="absolute left-[18%] top-[-2%] h-[12%] w-[14%] -rotate-[24deg] rounded-[40%]" />
            <span className="absolute left-[18%] top-[-2%] h-[12%] w-[14%] -rotate-[24deg] rounded-tl-[80%] border border-white/[0.2] bg-gradient-to-b from-white/[0.2] to-white/[0.05]" />
            <span className="absolute right-[18%] top-[-2%] h-[12%] w-[14%] rotate-[24deg] rounded-tr-[80%] border border-white/[0.2] bg-gradient-to-b from-white/[0.2] to-white/[0.05]" />
            <span className="absolute left-1/2 top-[36%] h-[10%] w-[9%] -translate-x-1/2 rotate-45 border border-white/[0.25] bg-gradient-to-b from-white/55 to-white/20" />
            {/* Wings. */}
            <span className="absolute left-[2%] top-[48%] h-[30%] w-[13%] -rotate-6 rounded-full border border-white/[0.12] bg-white/[0.06]" />
            <span className="absolute right-[2%] top-[48%] h-[30%] w-[13%] rotate-6 rounded-full border border-white/[0.12] bg-white/[0.06]" />
          </>
        ) : null}

        {variant === 'bear' ? (
          <>
            {/* Round ears + snout. */}
            <span className="absolute left-[12%] top-[0%] h-[16%] w-[16%] rounded-full border border-white/[0.2] bg-gradient-to-b from-white/[0.2] to-white/[0.05]" />
            <span className="absolute right-[12%] top-[0%] h-[16%] w-[16%] rounded-full border border-white/[0.2] bg-gradient-to-b from-white/[0.2] to-white/[0.05]" />
            <span className="absolute left-1/2 top-[34%] h-[15%] w-[30%] -translate-x-1/2 rounded-[50%] border border-white/[0.16] bg-gradient-to-b from-white/[0.2] to-white/[0.06]" />
            <span className="absolute left-1/2 top-[38%] h-[5%] w-[10%] -translate-x-1/2 rounded-full bg-white/70" />
            {/* Floating notes from the ear cups. */}
            <span className="absolute left-[-4%] top-[24%] animate-[mascot-note_2.6s_ease-in-out_infinite] font-mono text-[10px] text-white/60" style={{ animationDelay: '0.2s' }}>♪</span>
            <span className="absolute right-[-4%] top-[20%] animate-[mascot-note_2.6s_ease-in-out_infinite] font-mono text-[10px] text-white/50" style={{ animationDelay: '1.3s' }}>♪</span>
          </>
        ) : null}

        {variant === 'fox' ? (
          <>
            {/* Angular ears + pointed snout + whisker. */}
            <span className="absolute left-[12%] top-[-6%] h-[20%] w-[18%] -rotate-[18deg] rounded-tl-[90%] border border-white/[0.2] bg-gradient-to-b from-white/[0.22] to-white/[0.04]" />
            <span className="absolute right-[12%] top-[-6%] h-[20%] w-[18%] rotate-[18deg] rounded-tr-[90%] border border-white/[0.2] bg-gradient-to-b from-white/[0.22] to-white/[0.04]" />
            <span className="absolute left-1/2 top-[34%] h-[16%] w-[22%] -translate-x-1/2 rounded-[50%_50%_60%_60%] border border-white/[0.16] bg-gradient-to-b from-white/[0.24] to-white/[0.06]" />
            <span className="absolute left-1/2 top-[38%] h-[5%] w-[9%] -translate-x-1/2 rounded-full bg-white/75" />
            {/* Noise waves reacting on the left. */}
            <span className="absolute left-[-2%] top-[26%] h-[20%] w-[10%] animate-[mascot-ring_1.8s_ease-out_infinite] rounded-full border-l-2 border-white/50" />
            <span className="absolute left-[-6%] top-[22%] h-[28%] w-[14%] animate-[mascot-ring_1.8s_ease-out_infinite] rounded-full border-l border-white/30" style={{ animationDelay: '0.5s' }} />
          </>
        ) : null}

        {variant === 'dj' ? (
          <>
            {/* Dragon horns + crown + shades. */}
            <span className="absolute left-[16%] top-[-8%] h-[18%] w-[10%] -rotate-[22deg] rounded-t-full border border-white/[0.22] bg-gradient-to-b from-white/[0.24] to-white/[0.05]" />
            <span className="absolute right-[16%] top-[-8%] h-[18%] w-[10%] rotate-[22deg] rounded-t-full border border-white/[0.22] bg-gradient-to-b from-white/[0.24] to-white/[0.05]" />
            <span className="absolute left-1/2 top-[-10%] h-[12%] w-[30%] -translate-x-1/2 rounded-[4px] border border-white/[0.3] bg-gradient-to-b from-white/70 to-white/25 shadow-[0_0_10px_rgba(255,255,255,0.4)]" />
            <span className="absolute left-1/2 top-[24%] w-[58%] -translate-x-1/2 rounded-md border border-white/[0.24] bg-black/70" style={{ height: '9%' }} />
            {/* Turntable pulse. */}
            <span className="absolute left-1/2 top-[58%] h-[3%] w-[34%] -translate-x-1/2 animate-[stone-breathe_1.2s_ease-in-out_infinite] rounded-full bg-white/40" />
            <span className="absolute left-[-4%] top-[22%] animate-[mascot-note_2.4s_ease-in-out_infinite] font-mono text-[10px] text-white/60">♫</span>
          </>
        ) : null}
      </RigBase>
    </div>
  );
}

export function Animated3DCharacter({
  unitIndex,
  tier,
  stars,
  locked,
  complete,
}: {
  /** 0-based unit index; drives placement parity and rig selection. */
  unitIndex: number;
  tier: DifficultyLevel;
  /** Stars earned in this unit (max 15); drives the 3-star cluster. */
  stars: number;
  /** True while the unit is not yet accessible. */
  locked: boolean;
  /** True when all five nodes of the unit are finished. */
  complete: boolean;
}) {
  const mascot = MASCOTS[tier];
  const anchor = characterAnchor(unitIndex);
  const reduceMotion = useReducedMotion();

  const [assetReady, setAssetReady] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [lineIndex, setLineIndex] = useState(0);
  const lastReaction = useRef(0);
  const bubbleTimer = useRef<number | null>(null);
  const controls = useAnimationControls();

  useEffect(
    () => () => {
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current);
    },
    [],
  );

  const starsFilled = Math.min(3, Math.round(stars / 5));

  const react = useCallback(() => {
    const now = Date.now();
    // One reaction per beat: hover and click both land here, and a swipe across
    // the path must not turn into a chime machine gun.
    if (now - lastReaction.current < 1400) return;
    lastReaction.current = now;

    setBubble(mascot.lines[lineIndex % mascot.lines.length] ?? null);
    setLineIndex((index) => index + 1);
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble(null), 2500);

    uiSounds.playCharacterChime();

    if (!reduceMotion) {
      void controls.start({
        y: [0, -22, 0],
        rotateY: [0, 360],
        transition: { duration: 0.72, ease: 'easeInOut' },
      });
    }
  }, [controls, lineIndex, mascot.lines, reduceMotion]);

  return (
    <div
      className={`absolute z-[5] w-16 sm:w-28 ${locked ? 'opacity-60 grayscale' : ''}`}
      style={{
        left: `${(anchor.x / STAGE_WIDTH) * 100}%`,
        top: anchor.y,
        transform: 'translate(-50%, -50%)',
      }}
    >
      <div className="relative flex flex-col items-center">
        {complete ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-2 rounded-full bg-white/[0.06] blur-xl"
          />
        ) : null}

        <button
          type="button"
          onClick={react}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') react();
          }}
          aria-label={`${mascot.name} ${mascot.role} — tap to say hello`}
          className="relative w-full focus-visible:outline-offset-4"
        >
          <div style={{ perspective: 700 }}>
            {/* Idle: gentle float and sway — transform-only, so a stalled frame
                loop leaves the character visible and still. */}
            <motion.div
              animate={reduceMotion ? undefined : { y: [0, -6, 0], rotateZ: [-2, 2, -2] }}
              transition={
                reduceMotion
                  ? undefined
                  : { duration: 5.2, repeat: Infinity, ease: 'easeInOut' }
              }
            >
              {/* Reaction: the happy hop + 3D flip. */}
              <motion.div animate={controls} className="relative aspect-square w-full">
                <div
                  className={`absolute inset-0 transition-opacity duration-300 ${
                    assetReady ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  <MascotRig variant={mascot.rig} />
                </div>
                {/* The Fluent asset fades in only once it has genuinely decoded;
                    a slow or blocked network simply leaves the rig in place. */}
                {/* eslint-disable-next-line @next/next/no-img-element -- external animated
                    APNG from the Fluent emoji mirror; next/image cannot optimise APNG. */}
                <img
                  src={mascot.asset}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onLoad={() => setAssetReady(true)}
                  className={`pointer-events-none h-full w-full object-contain drop-shadow-[0_12px_18px_rgba(0,0,0,0.65)] transition-opacity duration-500 ${
                    assetReady ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </motion.div>
            </motion.div>
          </div>

          {/* Speech bubble, dismissed by a timer; render is a plain conditional
              so a stalled animation can never pin it to the screen. */}
          {bubble ? (
            <span
              role="status"
              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-[10rem] -translate-x-1/2 animate-[bubble-in_180ms_ease-out] rounded-2xl border border-white/[0.14] bg-white/[0.07] px-2.5 py-1.5 text-center text-[10px] leading-snug text-white shadow-[0_10px_24px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            >
              {bubble}
            </span>
          ) : null}
        </button>

        {/* 3D oval platform the character stands on. */}
        <span
          aria-hidden
          className="relative -mt-[15%] h-6 w-[88%] rounded-full border border-white/[0.1] bg-gradient-to-b from-white/[0.08] to-black/90 shadow-[0_8px_0_0_#141417,0_16px_30px_rgba(0,0,0,0.9)] sm:h-8 sm:w-28"
        />

        {/* The unit's 3-star progress cluster, like Duolingo's. */}
        <span
          className="mt-2.5 flex items-center gap-2"
          title={`${stars} of ${15} unit stars`}
          aria-label={`${stars} of 15 stars in this unit`}
        >
          {[1, 2, 3].map((pip) => {
            const earned = pip <= starsFilled;
            return (
              <Star
                key={pip}
                size={11}
                fill={earned ? 'currentColor' : 'none'}
                className={
                  earned
                    ? 'text-white drop-shadow-[0_2px_0_rgba(0,0,0,0.65),0_0_8px_rgba(255,255,255,0.35)]'
                    : 'text-white/[0.14] drop-shadow-[0_1px_0_rgba(255,255,255,0.05)]'
                }
              />
            );
          })}
        </span>
      </div>
    </div>
  );
}
