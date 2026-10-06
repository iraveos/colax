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