'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  BookOpen,
  ChevronRight,
  Compass,
  Flame,
  Lock,
  Medal,
  Sparkles,
  Star,
  Trophy,
} from '@/components/ui/icons';
import { Animated3DCharacter } from '@/components/PathCharacter';
import { GlassConduit } from '@/components/PathConduit';
import { PathNode, type NodeState } from '@/components/PathNode';
import { GlassCard, Pill } from '@/components/ui/primitives';
import { nodePoint, stageHeight, STAGE_WIDTH } from '@/lib/conduit';
import { LEVELS } from '@/lib/levels';
import {
  NODE_SLOTS,
  SECTIONS,
  activeNode,
  isChestClaimed,
  isNodeUnlocked,
  nodeDefinition,
  nodeKey,
  nodeStrategy,
  progressFor,
  totalStars,
  tierCompletedCount,
  tierLockReason,
  tierStarCount,
} from '@/lib/path';
import type { DifficultyLevel, NoiseIntensity, PathNodeRef, PathProgress } from '@/lib/types';

/**
 * The default home view: a Duolingo-style stepped progression path.
 *
 * Five sections of ten nodes each, drawn on one shared coordinate grid per
 * unit: the conduit SVG (`viewBox="0 0 420 H"`) and the node wrappers (`left: x%`,
 * `top: y px`) both read their positions from `nodePoint(i, unitIndex)`, so the
 * 3D glass path is mathematically guaranteed to pass through the dead centre of
 * every button in every section, at every viewport — there is no measurement and
 * no drift. Each unit's open bend is occupied by an animated 3D companion on a
 * docked platform, and the unit banner is deliberately minimal: label, current
 * tier, title, subtitle, a unit star badge and the guidebook.
 */
export function PathView({
  path,
  currentLevel,
  autoLevelEnabled,
  noiseIntensity,
  weakWords,
  onActivateNode,
  onLockedNode,
  onOpenGuidebook,
  focusSignal,
}: {
  path: PathProgress;
  currentLevel: DifficultyLevel;
  autoLevelEnabled: boolean;
  noiseIntensity: NoiseIntensity;
  weakWords: readonly string[];
  onActivateNode: (ref: PathNodeRef) => void;
  onLockedNode: (ref: PathNodeRef) => void;
  onOpenGuidebook: (tier: DifficultyLevel) => void;
  /**
   * Incremented by the shell whenever a session closes. The map scrolls to the
   * current node on every change, so a learner who just cleared a node is looking
   * at the one that opened rather than at wherever they happened to be.
   */
  focusSignal: number;
}) {
  const active = useMemo(() => activeNode(path), [path]);
  /** Node elements by key, so the map can scroll to the one that matters. */
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastFocusRef = useRef<{ key: string | null; signal: number }>({ key: null, signal: -1 });

  const activeKey = active ? nodeKey(active.tier, active.slot) : null;

  /**
   * Brings the current node into view.
   *
   * Fires on first paint, whenever the active node changes (a node was cleared
   * and the next one opened), and whenever the shell signals a return from a
   * session. The first scroll is instant rather than smooth: opening the app
   * should put you at your place, not animate its way there.
   */
  useEffect(() => {
    if (!activeKey) return;
    const previous = lastFocusRef.current;
    if (previous.key === activeKey && previous.signal === focusSignal) return;
    const first = previous.signal === -1;
    lastFocusRef.current = { key: activeKey, signal: focusSignal };

    const element = nodeRefs.current.get(activeKey);
    if (!element) return;
    // One frame's grace so the section banner has its final height and the node
    // does not land under it.
    const frame = window.requestAnimationFrame(() => {
      element.scrollIntoView({
        behavior: first ? 'auto' : 'smooth',
        block: 'center',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeKey, focusSignal]);

  const stars = totalStars(path);
  const unitHeight = stageHeight(NODE_SLOTS.length);

  const nextTierToUnlock = useMemo(() => {
    for (const section of SECTIONS) {
      if (!isNodeUnlocked(path, section.tier, 1)) return section.tier;
    }
    return null;
  }, [path]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-32 pt-5 sm:px-6">
      {SECTIONS.map((section, sectionIndex) => {
        const completed = tierCompletedCount(path, section.tier);
        const sectionStars = tierStarCount(path, section.tier);
        const tierAccessible = isNodeUnlocked(path, section.tier, 1);
        const isCurrentSection = currentLevel === section.tier;

        return (
          <section key={section.tier} className="relative">
            {/* Sticky unit banner: label, tier pill, title, one-line subtitle,
                a compact unit star badge and the guidebook. Everything the old
                pill rows carried lives in the Dashboard and Settings now. */}
            <div className="sticky top-2 z-20 mb-6">
              <GlassCard
                variant="strong"
                sheen
                className="rounded-2xl px-4 py-3 shadow-[0_8px_0_0_rgba(255,255,255,0.09),0_20px_40px_rgba(0,0,0,0.85)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                        {section.label}
                      </span>
                      {isCurrentSection ? <Pill tone="solid">current tier</Pill> : null}
                      {!tierAccessible ? (
                        <Pill className="border-white/[0.1]" title={tierLockReason(path, section.tier)}>
                          <Lock size={9} /> locked
                        </Pill>
                      ) : null}
                    </div>
                    <h2 className="mt-1.5 truncate text-lg font-semibold tracking-tight text-white sm:text-xl">
                      {section.title}
                    </h2>
                    <p className="mt-0.5 truncate text-[11px] leading-relaxed text-neutral-500">
                      {section.subtitle}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Pill
                      className="px-2.5 py-1.5 text-[10px]"
                      title={`${sectionStars} of ${NODE_SLOTS.length * 3} stars earned in this unit`}
                    >
                      <Star
                        size={10}
                        className={sectionStars > 0 ? 'text-white' : 'text-neutral-500'}
                        fill={sectionStars > 0 ? 'currentColor' : 'none'}
                      />
                      <span className="metric">{sectionStars}</span>
                      <span className="text-neutral-500">/ {NODE_SLOTS.length * 3}</span>
                    </Pill>
                    <button
                      type="button"
                      onClick={() => onOpenGuidebook(section.tier)}
                      aria-label={`Guidebook for ${section.title}`}
                      title="Guidebook"
                      className="icon-btn h-10 w-10 shrink-0"
                    >
                      <BookOpen size={16} />
                    </button>
                  </div>
                </div>
              </GlassCard>
            </div>

            {/* One stage per unit: the conduit and the nodes share this exact
                box and coordinate grid. `max-w` (not `w`) keeps 320px viewports
                overflow-free while the mapping stays identical at every width. */}
            <div
              className="relative mx-auto w-full max-w-[360px] sm:max-w-[420px]"
              style={{ height: unitHeight }}
            >
              <GlassConduit
                path={path}
                tier={section.tier}
                unitIndex={sectionIndex}
                count={NODE_SLOTS.length}
                height={unitHeight}
              />

              {NODE_SLOTS.map((slot, slotIndex) => {
                const definition = nodeDefinition(slot.slot);
                const point = nodePoint(slotIndex, sectionIndex);
                const unlocked = isNodeUnlocked(path, section.tier, slot.slot);
                const progress = progressFor(path, section.tier, slot.slot);
                const claimed = isChestClaimed(path, section.tier, slot.slot);
                const isNodeActive = active?.tier === section.tier && active?.slot === slot.slot;

                const natural: NodeState = !unlocked
                  ? 'locked'
                  : progress || (definition.isReward && claimed)
                    ? 'done'
                    : 'active';

                return (
                  <div
                    key={slot.slot}
                    ref={(element) => {
                      const key = nodeKey(section.tier, slot.slot);
                      if (element) nodeRefs.current.set(key, element);
                      else nodeRefs.current.delete(key);
                    }}
                    // The one binding that matters: percentage on x and pixels
                    // on y are the same mapping the SVG's viewBox applies, so
                    // the puck's centre lands exactly on the bezier endpoint.
                    className="absolute z-10"
                    style={{
                      left: `${(point.x / STAGE_WIDTH) * 100}%`,
                      top: point.y,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    <PathNode
                      slot={slot.slot}
                      kind={slot.kind}
                      state={isNodeActive ? 'active' : natural}
                      progress={progress}
                      isChestClaimed={claimed}
                      index={sectionIndex * NODE_SLOTS.length + slotIndex}
                      onActivate={() => onActivateNode({ tier: section.tier, slot: slot.slot })}
                      onLocked={() => onLockedNode({ tier: section.tier, slot: slot.slot })}
                    />
                  </div>
                );
              })}

              {/* The unit's animated 3D companion, in the open bend opposite the
                  curve's apex (see `characterAnchor`). */}
              <Animated3DCharacter
                unitIndex={sectionIndex}
                tier={section.tier}
                stars={sectionStars}
                locked={!tierAccessible}
                complete={completed === NODE_SLOTS.length}
              />
            </div>
          </section>
        );
      })}

      {/* ----------------------------------------------------------- summary -- */}
      <GlassCard className="mt-2 p-5">
        <div className="flex items-center gap-2">
          <Compass size={15} className="text-neutral-500" />
          <h3 className="text-sm font-semibold tracking-tight text-white">Where you are</h3>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <PathStat
            icon={<Star size={12} />}
            label="stars"
            value={`${stars}/${SECTIONS.length * NODE_SLOTS.length * 3}`}
          />
          <PathStat icon={<Medal size={12} />} label="badges" value={`${path.badges.length}/10`} />
          <PathStat icon={<Sparkles size={12} />} label="fast-track" value={`L${path.fastTrackTier}`} />
          <PathStat icon={<Flame size={12} />} label="weak words" value={`${weakWords.length}`} />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {active ? (
            <p className="text-[11px] leading-relaxed text-neutral-400">
              Next up:{' '}
              <span className="text-white">
                {nodeDefinition(active.slot).title} · {LEVELS[active.tier].name}
              </span>
              . {nodeStrategy(nodeDefinition(active.slot).kind)}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-[11px] leading-relaxed text-neutral-300">
              <Trophy size={12} /> Every node cleared. The full ladder is mastered — replay any node
              to defend your stars.
            </p>
          )}

          {!autoLevelEnabled ? (
            <p className="text-[11px] leading-relaxed text-neutral-500">
              Auto-Level is off, so the engine will not fast-track you. Turn it on in Settings to let
              mastery unlock sections ahead of the path.
            </p>
          ) : nextTierToUnlock ? (
            <p className="text-[11px] leading-relaxed text-neutral-500">
              Clear a Mastery Workout, or score 90%+ on two consecutive voices, to open{' '}
              <span className="text-neutral-300">{LEVELS[nextTierToUnlock].name}</span>.
            </p>
          ) : null}

          {weakWords.length > 0 ? (
            <p className="text-[11px] leading-relaxed text-neutral-500">
              The Mastery Workout is currently targeting{' '}
              <span className="font-mono text-neutral-300">{weakWords.slice(0, 6).join(', ')}</span>
              {weakWords.length > 6 ? ` +${weakWords.length - 6} more` : ''}.
            </p>
          ) : null}

          {noiseIntensity !== 'standard' ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
              noise intensity: {noiseIntensity}
            </p>
          ) : null}

          {path.badges.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {path.badges.map((badge) => (
                <Pill key={badge} tone="outline" className="border-white/25 text-white">
                  {badge.includes('crown') ? '★' : '◆'} {badgeLabel(badge)}
                </Pill>
              ))}
            </div>
          ) : null}

          <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">
            <ChevronRight size={11} />
            tap a node to begin
          </div>
        </div>
      </GlassCard>
    </div>
  );
}

function PathStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="glass-inset flex flex-col gap-1 px-3 py-2.5">
      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-500">
        {icon}
        {label}
      </span>
      <span className="metric text-lg font-semibold text-white">{value}</span>
    </div>
  );
}

/** Turns `tier-3-crown` into `Tier 3 Crown`. */
export function badgeLabel(badge: string): string {
  const match = /^tier-([1-5])-(mastery|crown)$/.exec(badge);
  if (!match) return badge;
  return `Tier ${match[1]} ${match[2] === 'crown' ? 'Crown' : 'Mastery'}`;
}
