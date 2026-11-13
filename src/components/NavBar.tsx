'use client';

import { BarChart3, Route, Settings2 } from '@/components/ui/icons';

export type AppTab = 'path' | 'dashboard' | 'settings';

export const TABS: readonly { id: AppTab; label: string; icon: typeof Route }[] = [
  { id: 'path', label: 'Path', icon: Route },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

/**
 * The only navigation surface.
 *
 * A floating dock pinned to the bottom at every width, rather than a top rail on
 * desktop: the app reads as one continuous column of content with the controls
 * within thumb reach, and there is no persistent header competing with the unit
 * banners for the top of the screen. The active tab is a static class instead of
 * a shared-layout animation so it stays legible even if frames stop arriving.
 */
export function BottomDock({
  tab,
  onChange,
}: {
  tab: AppTab;
  onChange: (next: AppTab) => void;
}) {
  return (
    <nav
      aria-label="Main views"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="glass-strong flex w-full max-w-sm items-center gap-1 p-1.5 sm:max-w-md">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onChange(entry.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-1 rounded-2xl px-2 py-2 transition-colors duration-200 sm:flex-row sm:justify-center sm:gap-2 ${
                active ? 'bg-white text-[#050505]' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white'
              }`}
            >
              <Icon size={17} />
              <span className="font-mono text-[9px] uppercase tracking-[0.12em] sm:text-[10px]">
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
