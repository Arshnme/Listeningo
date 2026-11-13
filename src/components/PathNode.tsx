'use client';

import { motion } from 'framer-motion';
import { CircleCheckBig, Dumbbell, Gift, Lock, Star, Trophy } from '@/components/ui/icons';
import { nodeDefinition } from '@/lib/path';
import { uiSounds } from '@/lib/uiSoundEngine';
import type { NodeProgress } from '@/lib/types';

/**
 * One node on the path, drawn as an extruded 3D liquid-glass puck docked into a
 * recessed 3D pedestal.
 *
 * **The puck itself is the anchor.** The component's root box is exactly the
 * puck's size, and the parent positions that box by `translate(-50%, -50%)` at
 * the node's point on the shared coordinate grid — so the button's centre *is*
 * the grid point, and the conduit is guaranteed to meet it dead-centre. Every
 * decoration (START badge, aura, star ribbon, attempt counter) floats in
 * absolutely-positioned layers around that anchor and can never shift it.
 *
 * The puck stacks three layers to produce the tactile silhouette: a hard-edged
 * 8px lip cast by box-shadow, the lit top face, and a crescent dome gloss across
 * the upper half that reads as a curved glass lens. Pressing translates it 6px
 * downward while the lip collapses from 8px to 2px. That press is CSS `:active`
 * rather than a JS animation, deliberately: the button must still travel when no
 * animation frames are being produced.
 */

export type NodeState = 'locked' | 'active' | 'done';

/** Node kinds that earn an inner bevel ring: the ones that are not plain practice. */
const SPECIAL_KINDS = new Set(['workout', 'reward', 'boss']);

export function NodeIcon({
  kind,
  size = 22,
  bevel = false,
}: {
  kind: string;
  size?: number;
  bevel?: boolean;
}) {
  const className = bevel ? 'drop-shadow-[0_2px_2px_rgba(0,0,0,0.4)]' : undefined;
  switch (kind) {
    case 'workout':
      return <Dumbbell size={size} className={className} />;
    case 'reward':
      return <Gift size={size} className={className} />;
    case 'boss':
      return <Trophy size={size} className={className} />;
    case 'practice':
      return <CircleCheckBig size={size} className={className} />;
    case 'intro':
    default:
      return <Star size={size} className={className} />;
  }
}

/**
 * The 3D extruded star ribbon that floats under a node.
 *
 * Earned stars are bright, drop-shadowed badges that read as raised hardware;
 * unearned ones are recessed dark-glass slots, so the ribbon always shows what
 * has been earned *and* what is still on the table at a glance. The whole
 * ribbon is a curved glass pill with its own 4px bottom lip.
 */
export function StarRibbon({ stars }: { stars: number }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-[3px] shadow-[0_4px_0_0_#18181b]"
      aria-label={`${stars} of 3 stars`}
    >
      {[1, 2, 3].map((pip) => {
        const earned = pip <= stars;
        return (
          <Star
            key={pip}
            size={10}
            fill={earned ? 'currentColor' : 'none'}
            className={
              earned
                ? 'text-white drop-shadow-[0_1.5px_0_rgba(0,0,0,0.65)]'
                : 'text-white/[0.13] drop-shadow-[0_1px_0_rgba(255,255,255,0.05)]'
            }
          />
        );
      })}
    </span>
  );
}

export function PathNode({
  slot,
  kind,
  state,
  progress,
  isChestClaimed,
  index,
  onActivate,
  onLocked,
}: {
  slot: number;
  kind: string;
  state: NodeState;
  progress?: NodeProgress;
  isChestClaimed: boolean;
  index: number;
  /** Runs the node: starts a session, or claims a reward chest. */
  onActivate: () => void;
  /** Called instead when the node is still locked, so the UI can explain why. */
  onLocked: () => void;
}) {
  const definition = nodeDefinition(slot);
  const isReward = definition.isReward;
  const claimed = isReward && isChestClaimed;
  const visual: NodeState = claimed ? 'done' : state;

  const isBoss = kind === 'boss';
  const sizeClass = isBoss ? 'h-24 w-24' : 'h-20 w-20';
  const shell =
    visual === 'active' ? 'node3d-active' : visual === 'done' ? 'node3d-done' : 'node3d-locked';
  const special = SPECIAL_KINDS.has(kind);

  const label = claimed
    ? 'Reward claimed'
    : visual === 'locked'
      ? `Locked: ${definition.title}`
      : `${definition.title}${progress && progress.stars > 0 ? ` · ${progress.stars} of 3 stars` : ''}`;

  return (
    // The root box is exactly the puck: its centre is the grid point the parent
    // positions it on, so nothing in the decoration layer can move the anchor.
    <div className="relative flex flex-col items-center">
      {/* Floating START badge, positioned off the puck itself. Bobs on the y
          axis only; a stalled animation leaves it perfectly visible, just still. */}
      {visual === 'active' ? (
        <motion.div
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute -top-11 z-30 whitespace-nowrap"
        >
          <span className="relative inline-flex items-center rounded-full border border-white/40 bg-gradient-to-b from-white to-neutral-200 px-3.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#050505] shadow-[0_4px_0_0_#a3a3a3,0_10px_20px_rgba(0,0,0,0.7)]">
            {isReward ? 'Open' : 'Start'}
          </span>
        </motion.div>
      ) : null}

      {/* Aura behind the active puck. */}
      {visual === 'active' ? (
        <span
          aria-hidden
          className="path-node-aura pointer-events-none absolute top-0 h-20 w-20 rounded-full border border-white/25"
        />
      ) : null}

      {/* The perspective container is what lets the orbital ring lie back and
          tilts the pedestal plate into the scene. */}
      <div className="relative [perspective:1000px]">
        {/* 3D docking socket: a recessed plate under every puck, whatever its
            state, so the node reads as seated hardware. */}
        <span aria-hidden className="node3d-pedestal" />

        {visual === 'active' ? <OrbitalRing size={isBoss ? 132 : 116} /> : null}

        <button
          type="button"
          onClick={visual === 'locked' ? onLocked : onActivate}
          // Tactile SFX: mouse hover stays lighter than a real press, and touch
          // devices skip the hover cue entirely (a tap fires both pointerenter
          // and pointerdown back to back).
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') uiSounds.playClick(0.45);
          }}
          onPointerDown={() => uiSounds.playClick(1)}
          aria-label={label}
          aria-disabled={visual === 'locked'}
          title={label}
          className={`group relative z-10 flex items-center justify-center transition-transform duration-200 hover:-translate-y-0.5 ${sizeClass} ${shell}`}
        >
          {/* Curved dome across the top half. Bright on lit faces, barely there
              on the carved obsidian one. */}
          <span className={visual === 'locked' ? 'node3d-dome-dark' : 'node3d-dome'} aria-hidden />
          {special ? (
            <span
              className={visual === 'locked' ? 'node3d-bevel-dark' : 'node3d-bevel'}
              aria-hidden
            />
          ) : null}
          <span className="relative z-10 flex items-center justify-center">
            {visual === 'locked' ? (
              <Lock size={18} />
            ) : (
              <NodeIcon kind={kind} size={isBoss ? 28 : 22} bevel={special} />
            )}
          </span>
        </button>
      </div>

      {/* Mastery stars underneath, as a 3D extruded ribbon (out of flow). */}
      {isReward ? (
        claimed ? (
          <span className="absolute left-1/2 top-full mt-2.5 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-500">
            claimed
          </span>
        ) : null
      ) : visual === 'locked' ? null : (
        <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap">
          <StarRibbon stars={progress?.stars ?? 0} />
        </span>
      )}

      {/* Attempt count, once a node has been tried. */}
      {progress && progress.attempts > 1 && !isReward ? (
        <span className="absolute left-1/2 top-full mt-9 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-600">
          {progress.attempts} tries
        </span>
      ) : null}

      <span className="sr-only">
        Node {slot} of tier, position {index + 1}
      </span>
    </div>
  );
}

/**
 * Tilted orbital progress ring around the active puck.
 *
 * Twelve dashes laid flat in 3D rather than an animated SVG stroke: it needs no
 * frames to look right, and `rotateX` is what makes it orbit rather than frame.
 * Near-side dashes are brighter than far-side ones, which is what gives the ring
 * a front and a back instead of reading as a flat clock face.
 */
function OrbitalRing({ size }: { size: number }) {
  const radius = size / 2 - 6;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2"
      style={{
        width: size,
        height: size,
        transform: 'translate(-50%, -50%) rotateX(62deg)',
        transformStyle: 'preserve-3d',
      }}
    >
      {Array.from({ length: 12 }, (_, index) => {
        const angle = index * 30;
        const facing = Math.max(0, Math.cos((angle * Math.PI) / 180));
        return (
          <span
            key={angle}
            className="absolute left-1/2 top-1/2 h-[3px] w-[10px] rounded-full bg-white"
            style={{
              transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${radius}px)`,
              opacity: 0.16 + facing * 0.64,
            }}
          />
        );
      })}
    </span>
  );
}
