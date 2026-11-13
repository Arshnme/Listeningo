import { isChestClaimed, isCompleted, isNodeUnlocked, nodeDefinition } from './path';
import type { DifficultyLevel, PathProgress } from './types';

/**
 * The single source of truth for the path's coordinate grid.
 *
 * Every unit draws into one fixed stage: an SVG with `viewBox="0 0 420 H"` and
 * `preserveAspectRatio="none"`, rendered at the stage's real pixel width, paired
 * with node wrappers positioned at `left: (x / 420) * 100%` / `top: y px`. With
 * that pairing, one user unit is exactly one CSS pixel vertically at any width,
 * and horizontally the two mappings are the same function of the container
 * width — so a node *cannot* drift off its curve, in any section, at any
 * viewport. No measurement, no resize observers, no drift.
 *
 * Local (not global) indices are used deliberately: the wave pattern is a
 * property of the unit, and using the global clip index previously made
 * sections 2–4 swing on a different pattern than the conduit drawn beneath
 * them.
 */

/** Width of the stage's coordinate grid. */
export const STAGE_WIDTH = 420;

/** Vertical distance between node centres, in px. */
export const ROW_STEP = 148;

/** The stage's horizontal centre axis, in user units. */
export const CENTER_X = STAGE_WIDTH / 2;

/**
 * Horizontal swing of each of the ten nodes in a unit.
 *
 * A double S that leaves and returns to the centre axis, so the winding-path
 * look holds across the whole extended unit (the original five-slot pattern
 * repeated, then eased back to centre for the final boss), and the serpentine
 * alternates direction unit to unit.
 */
export const X_OFFSETS: readonly number[] = [0, 68, 0, -68, 0, 68, 0, -68, 0, 0];

/** The mirrored pattern for alternating units, so the S flows unit to unit. */
export const X_OFFSETS_MIRRORED: readonly number[] = X_OFFSETS.map((offset) => -offset);

/** Stage height for a unit: the rows plus headroom for the badge and tail. */
export function stageHeight(count: number): number {
  return count * ROW_STEP + 120;
}

export interface ConduitPoint {
  x: number;
  y: number;
}

/**
 * Centre of the node at `index` inside unit `unitIndex`, in stage user units.
 *
 * `unitIndex` is 0-based (Section 1 is 0). Even units open their S to the right;
 * odd units mirror it.
 */
export function nodePoint(index: number, unitIndex: number): ConduitPoint {
  const offsets = unitIndex % 2 === 0 ? X_OFFSETS : X_OFFSETS_MIRRORED;
  return {
    x: CENTER_X + (offsets[index] ?? 0),
    y: 85 + index * ROW_STEP,
  };
}

/**
 * SVG path data for one curved segment between two node centres.
 *
 * The cubic's control points sit on the vertical midpoint so the curve leaves
 * and enters each node straight down. `dy` drops the whole curve by the given
 * number of pixels, which is how the extruded sidewall, floor shadow and
 * specular ridge layers are produced from the same geometry.
 */
export function segmentPath(from: ConduitPoint, to: ConduitPoint, dy = 0): string {
  const x1 = from.x;
  const y1 = from.y + dy;
  const x2 = to.x;
  const y2 = to.y + dy;
  const midY = (y1 + y2) / 2;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${midY.toFixed(1)} ${x2.toFixed(1)} ${midY.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** Concatenates path fragments into one path element (several subpaths). */
export function joinPaths(paths: readonly string[]): string {
  return paths.join(' ');
}

/**
 * Point on a segment's curve at parameter `t` (0..1), evaluated against the
 * exact control points {@link segmentPath} draws with.
 */
export function segmentPointAt(from: ConduitPoint, to: ConduitPoint, t: number): ConduitPoint {
  const midY = (from.y + to.y) / 2;
  const u = 1 - t;
  const x =
    u * u * u * from.x + 3 * t * u * u * from.x + 3 * t * t * u * to.x + t * t * t * to.x;
  const y =
    u * u * u * from.y + 3 * t * u * u * midY + 3 * t * t * u * midY + t * t * t * to.y;
  return { x, y };
}

export type ConduitState = 'locked' | 'active' | 'completed';

/**
 * How the segment between slots `segmentIndex + 1` and `segmentIndex + 2`
 * should be drawn.
 *
 * - `locked` — the far end has not unlocked yet, so the bridge is carved and dark.
 * - `active` — the far end is playable but not finished: the tube carries the
 *   travelling light pulse toward the node the learner should play next.
 * - `completed` — the far end has been finished (a claimed reward chest counts),
 *   so the bridge is solid, glowing silver.
 */
export function conduitStateFor(
  path: PathProgress,
  tier: DifficultyLevel,
  segmentIndex: number,
): ConduitState {
  const toSlot = segmentIndex + 2;
  if (!isNodeUnlocked(path, tier, toSlot)) return 'locked';
  const definition = nodeDefinition(toSlot);
  const reached = definition.isReward
    ? isChestClaimed(path, tier, toSlot)
    : isCompleted(path, tier, toSlot);
  return reached ? 'completed' : 'active';
}

export interface CharacterAnchor {
  /** Centre of the character stack, in stage user units. */
  x: number;
  y: number;
  side: 'left' | 'right';
}

/**
 * Where a unit's companion character stands.
 *
 * Midway between rows 1 and 2 — `85 + 1.5 * ROW_STEP` — on the side *opposite*
 * the curve's apex (the apex node for even units swings right, so the character
 * takes the left bend, and vice versa). At `x = 58` the stack clears the nearest
 * puck centre by more than its own half-width plus the puck radius, which the
 * verification suite asserts as a hard invariant.
 */
export function characterAnchor(unitIndex: number): CharacterAnchor {
  const even = unitIndex % 2 === 0;
  return {
    x: even ? 58 : STAGE_WIDTH - 58,
    y: 85 + 1.5 * ROW_STEP,
    side: even ? 'left' : 'right',
  };
}
