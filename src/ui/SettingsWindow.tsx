/**
 * Settings as an in-page window.
 *
 * Sections are tabs in a single dialog, and the active panel slides in from the
 * side so switching feels directional rather than a hard swap.
 */

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface SettingsTab {
  id: string;
  label: string;
  icon: ReactNode;
  render: () => ReactNode;
}

/**
 * The flat search index for the settings window.
 *
 * Every findable control is one entry: the tab it lives in, its name, and a few
 * synonyms people type instead of the label. Render functions hold the real
 * rows, so this list is maintained by hand — the ids must match the tab ids in
 * Settings.tsx, and a new control only appears in search once someone lists it
 * here. That is the price of searching panels that are functions, and it keeps
 * the search from having to walk the DOM.
 */
const SEARCH_INDEX: { tab: string; label: string; words: string }[] = [
  // Appearance
  { tab: 'appearance', label: 'Theme', words: 'light dark system colour mode' },
  { tab: 'appearance', label: 'Accent colour', words: 'slate sage dusk clay tint' },
  { tab: 'appearance', label: 'Motion speed', words: 'animation instant languid transitions' },
  { tab: 'appearance', label: 'Micro motion', words: 'animations small transitions' },
  { tab: 'appearance', label: 'Ambient depth', words: 'glow mesh depth' },
  { tab: 'appearance', label: 'Density', words: 'compact comfortable spacious spacing' },
  { tab: 'appearance', label: 'Roundness', words: 'corner radius sharp' },
  { tab: 'appearance', label: 'Card depth', words: 'shadow elevation' },
  { tab: 'appearance', label: 'Text size', words: 'font scale bigger smaller' },
  { tab: 'appearance', label: 'Reduce transparency', words: 'glass blur flat faster' },
  { tab: 'appearance', label: 'High contrast', words: 'borders text contrast visibility' },
  { tab: 'appearance', label: 'Background image', words: 'wallpaper photo backdrop opacity blur dim' },
  { tab: 'appearance', label: 'Card appearance', words: 'card size width height radius surface tuner' },
  { tab: 'appearance', label: 'Hide dividers', words: 'hairlines rules settings window' },
  // Layout
  { tab: 'layout', label: 'Vault view', words: 'flow list grid switch views' },
  { tab: 'layout', label: 'Sort by', words: 'order name recent strength manual' },
  { tab: 'layout', label: 'Show websites', words: 'urls domains display' },
  { tab: 'layout', label: 'Pin favorites', words: 'starred section top' },
  { tab: 'layout', label: 'Letter groups', words: 'alphabet grouping headings' },
  { tab: 'layout', label: 'Tag chips', words: 'labels on cards show' },
  { tab: 'layout', label: 'Sidebar labels', words: 'icons names rail' },
  { tab: 'layout', label: 'Sidebar position', words: 'rail left right top bottom dock' },
  { tab: 'layout', label: 'Rail alignment', words: 'rail placement channels middle bottom vertical align sidebar' },
  { tab: 'layout', label: 'Compact sidebar', words: 'icons only narrow rail' },
  { tab: 'layout', label: 'Floating chrome', words: 'pills detach buttons' },
  { tab: 'layout', label: 'Channel layout', words: 'channels folders reorder rail' },
  { tab: 'layout', label: 'Hide buttons', words: 'chrome visibility new login bulk add settings' },
  { tab: 'layout', label: 'Unassigned channel', words: 'no tags row' },
  // Hidden
  { tab: 'hidden', label: 'Show hidden items', words: 'restore hidden channels folders buttons' },
  // Security
  { tab: 'security', label: 'Master password', words: 'change password enable disable passcode' },
  { tab: 'security', label: 'Auto-lock', words: 'lock idle timer minutes' },
  { tab: 'security', label: 'Clipboard', words: 'clear seconds copy capture auto save' },
  { tab: 'security', label: 'Mask emails', words: 'usernames hidden dots' },
  { tab: 'security', label: 'Confirmations', words: 'confirm export deletions' },
  { tab: 'security', label: 'Copy toasts', words: 'notification confirmations after copying' },
  { tab: 'security', label: 'Notifications', words: 'toasts errors off silence alerts' },
  { tab: 'security', label: 'Second factor', words: 'vault security factor gate' },
  // Alarms
  { tab: 'alarms', label: 'Alarms', words: 'reminders clock notifications sound' },
  // Data
  { tab: 'data', label: 'Encrypted backup', words: 'export import vault restore json' },
  { tab: 'data', label: 'CSV export', words: 'spreadsheet plaintext excel passwords' },
  { tab: 'data', label: 'CSV import', words: 'spreadsheet from another tool mapping tags' },
  { tab: 'data', label: 'Theme backup', words: 'look share layout channels' },
  { tab: 'data', label: 'Storage', words: 'size usage how much' },
  { tab: 'data', label: 'Reset vault', words: 'delete everything wipe start over' },
  // Optimize
  { tab: 'optimize', label: 'One-click profiles', words: 'balanced maximum savings restore look' },
  { tab: 'optimize', label: 'Low-memory mode', words: 'max savings restart memory ram' },
  { tab: 'optimize', label: 'Hardware acceleration', words: 'gpu frame work compositor' },
  { tab: 'optimize', label: 'Spellcheck', words: 'typing red underlines dictionaries' },
  { tab: 'optimize', label: 'Mail loading', words: 'inline images page size cache messages' },
  // Desktop
  { tab: 'desktop', label: 'Run at startup', words: 'autostart launch sign in windows' },
  { tab: 'desktop', label: 'System tray', words: 'icon clock minimize' },
  { tab: 'desktop', label: 'Minimise to tray on close', words: 'close button hide quit' },
  { tab: 'desktop', label: 'Mute all sounds', words: 'silent alarms chimes audio' },
  // About
  { tab: 'about', label: 'About', words: 'version update changelog credits' },
  { tab: 'about', label: 'Keyboard shortcuts', words: 'keys cheatsheet help' },
];

export function SettingsWindow({
  open,
  tabs,
  onClose,
  onNavigate,
  tab,
  speed = 1,
  hideDividers = false,
}: {
  open: boolean;
  tabs: SettingsTab[];
  onClose: () => void;
  onNavigate?: (id: string) => void;
  /** Jump to this tab when it changes, e.g. from a sidebar shortcut. */
  tab?: string;
  /** Animation duration multiplier, from the motion-speed preference. */
  speed?: number;
  /** Drops the hairline rules between rows and around the rail. */
  hideDividers?: boolean;
}) {
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? '');
  const [direction, setDirection] = useState(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the selected tab valid if the tab list changes. Keyed on the ids rather
  // than the array itself, since the caller rebuilds `tabs` on every render.
  const tabKey = tabs.map((tab) => tab.id).join('|');
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeId)) setActiveId(tabs[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey, activeId]);

  // A higher speed means a stiffer, shorter spring rather than a scaled
  // duration, which is what makes switching feel immediate instead of floaty.
  useEffect(() => {
    if (!tab || !tabs.some((entry) => entry.id === tab)) return;
    const from = tabs.findIndex((entry) => entry.id === activeId);
    const to = tabs.findIndex((entry) => entry.id === tab);
    setDirection(to >= from ? 1 : -1);
    setActiveId(tab);
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab, tabKey]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      // Ctrl/Cmd+1..9 jumps straight to a tab.
      if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
        const tab = tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          select(tab.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  function select(id: string) {
    const from = tabs.findIndex((tab) => tab.id === activeId);
    const to = tabs.findIndex((tab) => tab.id === id);
    setDirection(to >= from ? 1 : -1);
    setActiveId(id);
    bodyRef.current?.scrollTo({ top: 0 });
    onNavigate?.(id);
  }

  /* ---- Settings search -----------------------------------------------------
     Typing filters the hand-built index in the rail; picking a result jumps to
     its tab. The rail keeps the tab list, so a search never hides where you
     can still go — the results appear under the box instead. */
  const [settingsQuery, setSettingsQuery] = useState('');
  const needle = settingsQuery.trim().toLowerCase();
  const searchResults =
    needle.length === 0
      ? []
      : SEARCH_INDEX.filter((entry) => `${entry.label} ${entry.words}`.toLowerCase().includes(needle)).slice(0, 12);
  const tabLabel = (id: string) => tabs.find((tab) => tab.id === id)?.label ?? id;
  const searchMenu = (
    <>
      <input
        type="search"
        className="settings-window__search"
        placeholder="Search settings…"
        aria-label="Search settings"
        value={settingsQuery}
        onChange={(event) => setSettingsQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setSettingsQuery('');
          }
        }}
      />
      {needle !== '' ? (
        <div className="settings-window__results" role="list" aria-label="Search results">
          {searchResults.length === 0 ? (
            <p className="settings-window__no-results">No matching settings</p>
          ) : (
            searchResults.map((entry, index) => (
              <button
                key={`${entry.tab}-${entry.label}-${index}`}
                type="button"
                role="listitem"
                className="settings-window__result"
                onClick={() => {
                  select(entry.tab);
                  setSettingsQuery('');
                }}
              >
                <span className="settings-window__result-label">{entry.label}</span>
                <span className="settings-window__result-tab">{tabLabel(entry.tab)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </>
  );

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <AnimatePresence>
      {open && active ? (
        <motion.div
          className="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
          <motion.div
            className="settings-window" data-no-dividers={hideDividers || undefined}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, scale: 0.97, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32, mass: 0.8 }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <aside className="settings-window__rail">
              <div className="settings-window__brand">
                <span className="settings-window__dot" aria-hidden="true" />
                Settings
              </div>
              {searchMenu}
              <nav className="settings-window__tabs" role="tablist" aria-orientation="vertical">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    role="tab"
                    type="button"
                    className="settings-tab"
                    aria-selected={tab.id === activeId}
                    aria-controls={`settings-panel-${tab.id}`}
                    id={`settings-tab-${tab.id}`}
                    onClick={() => select(tab.id)}
                  >
                    <span className="settings-tab__icon">{tab.icon}</span>
                    <span className="settings-tab__label">{tab.label}</span>
                  </button>
                ))}
              </nav>
            </aside>

            <div className="settings-window__main">
              <header className="settings-window__header">
                <div>
                  <h2 className="settings-window__title">{active.label}</h2>
                  <p className="settings-window__hint">{describe(active.id)}</p>
                </div>
                <button className="btn btn--icon" onClick={onClose} aria-label="Close settings">
                  <XIcon />
                </button>
              </header>

              <div className="settings-window__body" ref={bodyRef}>
                <AnimatePresence mode="wait" custom={direction}>
                  <motion.div
                    key={active.id}
                    id={`settings-panel-${active.id}`}
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${active.id}`}
                    className="settings-panel"
                    custom={direction}
                    initial={{ opacity: 0, x: direction * 14 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: direction * -10 }}
                    transition={{
                      type: 'spring',
                      stiffness: 520 * speed,
                      damping: 40,
                      mass: 0.45,
                    }}
                  >
                    {active.render()}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function describe(id: string): string {
  switch (id) {
    case 'appearance':
      return 'Theme, colour, motion and the app background';
    case 'background':
      return 'The image behind the whole app';
    case 'channels':
      return 'Sidebar views, their tags and how they look';
    case 'layout':
      return 'How your logins are displayed and ordered';
    case 'generator':
      return 'Defaults for new passwords';
    case 'password':
      return 'Encrypts the vault key itself';
    case 'security':
      return 'Locking, clipboard and warnings';
    case 'optimize':
      return 'Trade eye-candy for memory, CPU and battery';
    case 'data':
      return 'Import, export and what is stored';
    case 'backup':
      return 'Encrypted backups and restore';
    case 'about':
      return 'Diagnostics and resets';
    default:
      return '';
  }
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}