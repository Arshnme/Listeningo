'use client';

import {
  STAGE_WIDTH,
  conduitStateFor,
  joinPaths,
  nodePoint,
  segmentPath,
  segmentPointAt,
  type ConduitPoint,
  type ConduitState,
} from '@/lib/conduit';
import type { DifficultyLevel, PathProgress } from '@/lib/types';

/**
 * The 3D extruded liquid-glass conduit that links a unit's nodes.
 *
 * Every segment is built from four synchronized layers carved out of the same
 * cubic bezier so the bridge reads as a physical object with genuine thickness:
 *
 *   1. a blurred floor shadow, dropped 14px so the bridge floats above the floor
 *   2. an 18px extrusion sidewall, 6px down, that forms the bottom lip
 *   3. the 16px glass tube body itself
 *   4. a 3px specular ridge 2px up, the razor highlight along the top spine
 *
 * The SVG shares its coordinate grid with the node wrappers (`viewBox="0 0 420 H"`
 * over the same box the nodes position into), and both endpoints come from
 * `nodePoint(i, unitIndex)` — so the curve is mathematically guaranteed to pass
 * through the dead centre of every button in every section.
 *
 * Layers are grouped by segment state so one `<path>` can carry every segment
 * that shares a treatment, keeping the DOM small. The active segment carries a
 * dashed white pulse whose dash offset is animated with CSS: the light travels
 * even when no JS frames are produced, and rests as a static highlight under
 * `prefers-reduced-motion`.
 */

const STONE_POSITIONS = [1 / 3, 2 / 3] as const;

interface ConduitStone {
  x: number;
  y: number;
  state: ConduitState;
}

/** Extrusion shadows and lit faces for the three stepping-stone states. */
const STONE_CLASS: Readonly<Record<ConduitState, string>> = {
  completed:
    'border-white/60 bg-white/85 shadow-[0_3px_0_0_#27272a,0_0_12px_rgba(255,255,255,0.35)]',
  active:
    'border-white/50 bg-white/70 shadow-[0_3px_0_0_#27272a,0_0_10px_rgba(255,255,255,0.28)] animate-[stone-breathe_1.8s_ease-in-out_infinite]',
  locked: 'border-white/[0.08] bg-[#17171a] shadow-[0_3px_0_0_#101013]',
};

export function GlassConduit({
  path,
  tier,
  unitIndex,
  count,
  height,
}: {
  path: PathProgress;
  tier: DifficultyLevel;
  /** 0-based unit index; selects the mirror parity of the coordinate grid. */
  unitIndex: number;
  /** Number of nodes in the unit; the conduit has `count - 1` segments. */
  count: number;
  /** Stage height in px — the SVG viewBox height. */
  height: number;
}) {
  const points: ConduitPoint[] = Array.from({ length: count }, (_, index) =>
    nodePoint(index, unitIndex),
  );

  const shadow: string[] = [];
  const sidewallOpen: string[] = [];
  const sidewallLocked: string[] = [];
  const bodyCompleted: string[] = [];
  const bodyActive: string[] = [];
  const bodyLocked: string[] = [];
  const ridgeOpen: string[] = [];
  const ridgeLocked: string[] = [];
  const pulses: string[] = [];
  const stones: ConduitStone[] = [];

  for (let index = 0; index < count - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) continue;

    const state = conduitStateFor(path, tier, index);
    shadow.push(segmentPath(from, to, 14));

    const sidewall = segmentPath(from, to, 6);
    const body = segmentPath(from, to, 0);
    const ridge = segmentPath(from, to, -2);

    if (state === 'locked') {
      sidewallLocked.push(sidewall);
      bodyLocked.push(body);
      ridgeLocked.push(ridge);
    } else {
      sidewallOpen.push(sidewall);
      ridgeOpen.push(ridge);
      if (state === 'completed') {
        bodyCompleted.push(body);
      } else {
        bodyActive.push(body);
        pulses.push(body);
      }
    }

    for (const t of STONE_POSITIONS) {
      const point = segmentPointAt(from, to, t);
      stones.push({ x: point.x, y: point.y, state });
    }
  }

  const shadowFilter = `url(#conduit-shadow-${tier})`;
  const bloomFilter = `url(#conduit-bloom-${tier})`;
  const metalGradient = `url(#conduit-metal-${tier})`;

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      <svg
        viewBox={`0 0 ${STAGE_WIDTH} ${height}`}
        preserveAspectRatio="none"
        fill="none"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          <filter id={`conduit-shadow-${tier}`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          {/* Same blur, separate id: the bloom sits on a white stroke and must not
              inherit the shadow's filter region by accident on any engine. */}
          <filter id={`conduit-bloom-${tier}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <linearGradient id={`conduit-metal-${tier}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#a1a1aa" />
          </linearGradient>
        </defs>

        {/* Layer 1 — deep floor drop shadow: the bridge floats above the floor. */}
        {shadow.length > 0 ? (
          <path
            d={joinPaths(shadow)}
            stroke="rgba(0,0,0,0.9)"
            strokeWidth={22}
            strokeLinecap="round"
            filter={shadowFilter}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Layer 2 — physical extrusion wall (the 3D bottom lip). */}
        {sidewallOpen.length > 0 ? (
          <path
            d={joinPaths(sidewallOpen)}
            stroke="#52525b"
            strokeWidth={18}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {sidewallLocked.length > 0 ? (
          <path
            d={joinPaths(sidewallLocked)}
            stroke="#121214"
            strokeWidth={18}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Layer 3 — the tube body. Completed tubes glow silver over a bloom;
            the active tube is frosted glass under a travelling pulse; locked
            tubes are carved obsidian with a dark inner groove. */}
        {bodyCompleted.length > 0 ? (
          <>
            <path
              d={joinPaths(bodyCompleted)}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={26}
              strokeLinecap="round"
              filter={bloomFilter}
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={joinPaths(bodyCompleted)}
              stroke={metalGradient}
              strokeWidth={16}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
        {bodyActive.length > 0 ? (
          <path
            d={joinPaths(bodyActive)}
            stroke="rgba(255,255,255,0.16)"
            strokeWidth={16}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {bodyLocked.length > 0 ? (
          <>
            <path
              d={joinPaths(bodyLocked)}
              stroke="#1c1c1f"
              strokeWidth={16}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={joinPaths(bodyLocked)}
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={5}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}

        {/* Layer 4 — top specular glass ridge: the light along the top spine. */}
        {ridgeOpen.length > 0 ? (
          <path
            d={joinPaths(ridgeOpen)}
            stroke="rgba(255,255,255,0.45)"
            strokeWidth={3}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {ridgeLocked.length > 0 ? (
          <path
            d={joinPaths(ridgeLocked)}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={3}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Travelling light pulse toward the node the learner should play next. */}
        {pulses.map((d, index) => (
          <path
            key={`pulse-${index}`}
            d={d}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray="12 24"
            className="conduit-pulse"
            style={{ animationDelay: `${index * 0.4}s` }}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {/* Stepping-stone micro-pucks, lit as the learner walks past them. */}
      {stones.map((stone, index) => (
        <span
          key={`stone-${index}`}
          className={`absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border ${STONE_CLASS[stone.state]}`}
          style={{ left: `${(stone.x / STAGE_WIDTH) * 100}%`, top: stone.y }}
        />
      ))}
    </div>
  );
}
