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
const SEARCH_INDEX: { tab: string; label: string; words: string; detail?: string }[] = [
  // Appearance
  { tab: 'appearance', label: 'Theme', words: 'light dark system colour mode auto', detail: 'Light · Dark · System' },
  { tab: 'appearance', label: 'Accent colour', words: 'slate sage dusk clay tint palette', detail: 'Slate · Sage · Dusk · Clay' },
  { tab: 'appearance', label: 'Animation intensity', words: 'motion movement subtle full reduce', detail: '0–100%' },
  { tab: 'appearance', label: 'Animation speed', words: 'motion fast slow instant transitions', detail: 'Instant · Normal · Relaxed' },
  { tab: 'appearance', label: 'Glow', words: 'ambient depth mesh light', detail: '0–100%' },
  { tab: 'appearance', label: 'Text size', words: 'font scale bigger smaller accessibility', detail: 'Smaller · Default · Larger' },
  { tab: 'appearance', label: 'Corner roundness', words: 'radius sharp soft cards inputs', detail: '0–30px' },
  { tab: 'appearance', label: 'Card shadow', words: 'depth elevation shadow', detail: 'None · Soft · Strong' },
  { tab: 'appearance', label: 'Density', words: 'compact comfortable spacious spacing rows', detail: 'Compact · Comfortable · Spacious' },
  { tab: 'appearance', label: 'Reduce transparency', words: 'glass blur frosted flat faster', detail: 'On · Off' },
  { tab: 'appearance', label: 'High contrast', words: 'borders text visibility accessibility', detail: 'On · Off' },
  { tab: 'appearance', label: 'Background image', words: 'wallpaper photo backdrop url upload opacity blur dim', detail: 'URL · Upload · Opacity · Blur · Dim' },
  { tab: 'appearance', label: 'Card appearance', words: 'card size width height radius surface tuner', detail: 'Width · Height · Radius · Surface' },
  { tab: 'appearance', label: 'Hide dividers', words: 'hairlines rules lines settings', detail: 'On · Off' },
  { tab: 'appearance', label: 'Floating controls', words: 'chrome pills detach buttons', detail: 'Attached · Floating' },
  // Layout
  { tab: 'layout', label: 'Default view', words: 'flow list grid cards views layout', detail: 'Flow · List · Grid' },
  { tab: 'layout', label: 'Sort by', words: 'order name recent oldest strength username manual custom', detail: 'Name A-Z · Recently updated · Least recent · Weakest · Username · Custom' },
  { tab: 'layout', label: 'Show websites', words: 'urls domains addresses display', detail: 'On · Off' },
  { tab: 'layout', label: 'Show notes on login cards', words: 'notes preview cards', detail: 'On · Off' },
  { tab: 'layout', label: 'Click a login to copy its password', words: 'copy click card password', detail: 'On · Off' },
  { tab: 'layout', label: 'Pin favorites', words: 'starred section top', detail: 'On · Off' },
  { tab: 'layout', label: 'Health badges', words: 'weak reused stale warning badge', detail: 'On · Off' },
  { tab: 'layout', label: 'Group list by first letter', words: 'alphabet letter headings groups', detail: 'On · Off' },
  { tab: 'layout', label: 'Auto-tag new logins', words: 'site domain provider tag automatic', detail: 'On · Off' },
  { tab: 'layout', label: 'Show unassigned channel', words: 'no tags untagged row', detail: 'On · Off' },
  { tab: 'layout', label: 'New tags become channels', words: 'auto create tag channels', detail: 'On · Off' },
  { tab: 'layout', label: 'Channel labels', words: 'sidebar icons names rail', detail: 'Icons and names · Icons only · Names only' },
  { tab: 'layout', label: 'Rail position', words: 'sidebar left right top bottom dock', detail: 'Left edge · Right edge · Top tabs · Bottom dock' },
  { tab: 'layout', label: 'Rail alignment', words: 'sidebar channels middle bottom vertical align', detail: 'Top · Middle · Bottom' },
  { tab: 'layout', label: 'Card size', words: 'width height min size cards', detail: 'Width · Minimum height · Scale' },
  { tab: 'layout', label: 'Quick-launch docks', words: 'docks shortcuts quick launch', detail: 'Add · Remove · Reorder' },
  { tab: 'layout', label: 'Hide buttons', words: 'chrome visibility new login bulk add settings lock sidebar', detail: 'New login · Bulk add · Settings · Lock · Sidebar · Dock' },
  // Hidden
  { tab: 'hidden', label: 'Show hidden items', words: 'restore hidden channels folders buttons bars', detail: 'Buttons · Channels · Folders · Show everything' },
  // Security
  { tab: 'security', label: 'Vault password', words: 'master password change enable remove passcode', detail: 'Enable · Change · Remove' },
  { tab: 'security', label: 'Auto-lock', words: 'lock idle timer minutes inactivity', detail: '1 min · 5 min · 15 min · 30 min · 1 hour · Never' },
  { tab: 'security', label: 'Vault second factor', words: 'vault security factor gate authenticator', detail: 'Authenticator · Passcode · Questions' },
  { tab: 'security', label: 'Lock now', words: 'lock immediately clear key', detail: 'Lock' },
  { tab: 'security', label: 'Key derivation', words: 'pbkdf2 rounds iterations crypto', detail: 'PBKDF2 rounds' },
  { tab: 'security', label: 'Encryption', words: 'aes gcm nonce crypto', detail: 'AES-GCM' },
  { tab: 'security', label: 'Clear clipboard', words: 'clipboard wipe seconds copy', detail: 'Never · 15s · 30s · 60s · 2 minutes' },
  { tab: 'security', label: 'Clear clipboard on lock', words: 'clipboard lock wipe', detail: 'On · Off' },
  { tab: 'security', label: 'Detect logins on the clipboard', words: 'clipboard watch capture email password', detail: 'On · Off' },
  { tab: 'security', label: 'Save clipboard logins straight away', words: 'auto save clipboard prompt', detail: 'On · Off' },
  { tab: 'security', label: 'Warn on reused passwords', words: 'reuse duplicate warning', detail: 'On · Off' },
  { tab: 'security', label: 'Tag reused passwords', words: 'reuse tag automatic', detail: 'On · Off' },
  { tab: 'security', label: 'Flag stale passwords', words: 'password age stale days', detail: 'Never · 30 · 60 · 90 · 180 · 365 · 730 days' },
  { tab: 'security', label: 'Flag stale emails', words: 'email address age stale', detail: 'Never · 30 · 60 · 90 · 180 · 365 · 730 days' },
  { tab: 'security', label: 'Email check reminder', words: 'email reminder interval stale', detail: 'Never · Monthly · 2 months · 3 months · 6 months · Yearly' },
  { tab: 'security', label: 'Mask email addresses', words: 'usernames hidden dots privacy', detail: 'On · Off' },
  { tab: 'security', label: 'Confirm before export', words: 'backup export password confirm', detail: 'On · Off' },
  { tab: 'security', label: 'Confirm deletions', words: 'delete confirm prompt', detail: 'On · Off' },
  { tab: 'security', label: 'Copy toasts', words: 'notification copied confirmation', detail: 'On · Off' },
  { tab: 'security', label: 'Notifications', words: 'toasts errors off silence alerts', detail: 'All · Errors only · Off' },
  // Alarms
  { tab: 'alarms', label: 'Alarms', words: 'reminders clock notifications sound', detail: 'Add · Time · Days · Sound' },
  // Sharing
  { tab: 'sharing', label: 'Share server', words: 'sharing lan port internet cloudflare tunnel public address browser', detail: 'Internet: Off · Cloudflare Quick Tunnel · Local network: On/Off · Port · Manual public address' },
  { tab: 'sharing', label: 'Share codes', words: 'sharing share code pin expiry device limit revoke tags channel folder approval', detail: 'Tags or individual logins · Code only / Code + PIN · Approve new devices · Expiry · Device limit · Notes / 2FA / Attachments' },
  { tab: 'sharing', label: 'Open a share', words: 'sharing redeem import code link linked copy', detail: 'Paste link · Paste copied code · PIN' },
  { tab: 'sharing', label: 'Linked copies', words: 'sharing imported shared copies sync now auto sync interval remove undo redo', detail: 'Auto-sync interval · Sync now · Remove copy · Ctrl+Z undo · Ctrl+Shift+Z redo' },
  { tab: 'sharing', label: 'Devices and approval', words: 'sharing recipients access activity sync approve pending allowlist reject disconnect', detail: 'Pending devices · Approve · Reject · Disconnect · Access log · Notify approval' },
  // Data
  { tab: 'data', label: 'Stored logins', words: 'size usage how much storage', detail: 'Count and local size' },
  { tab: 'data', label: 'App version', words: 'version build update', detail: 'Version and build info' },
  { tab: 'data', label: 'Export as CSV', words: 'spreadsheet plaintext excel passwords', detail: 'Plaintext CSV' },
  { tab: 'data', label: 'Import from CSV', words: 'spreadsheet another tool mapping tags', detail: 'Name · URL · Username · Password · Notes' },
  { tab: 'data', label: 'Encrypted backup', words: 'export import vault restore json', detail: 'Export · Restore' },
  { tab: 'data', label: 'Theme backup', words: 'look share layout channels', detail: 'Export · Import' },
  { tab: 'data', label: 'Restore from backup', words: 'replace import restore', detail: 'Replace current vault' },
  { tab: 'data', label: 'Delete all data', words: 'reset vault wipe start over', detail: 'Delete vault' },
  // Optimize
  { tab: 'optimize', label: 'One-click profiles', words: 'balanced maximum savings restore look', detail: 'Balanced · Maximum savings · Restore look' },
  { tab: 'optimize', label: 'Saved profiles', words: 'profiles save load optimise', detail: 'Save · Load · Delete' },
  { tab: 'optimize', label: 'What it costs right now', words: 'memory ram cpu usage', detail: 'Memory · CPU · Cache' },
  { tab: 'optimize', label: 'Low-memory mode', words: 'max savings restart memory ram', detail: 'On · Off' },
  { tab: 'optimize', label: 'Hardware acceleration', words: 'gpu compositor frame', detail: 'On · Off (restart)' },
  { tab: 'optimize', label: 'Spellcheck', words: 'typing red underlines dictionaries', detail: 'On · Off' },
  { tab: 'optimize', label: 'Mail loading', words: 'inline images page size cache messages', detail: 'Inline images · Page size · Cache' },
  { tab: 'optimize', label: 'Reset optimisations', words: 'restore defaults chrome switches', detail: 'Reset' },
  // Desktop
  { tab: 'desktop', label: 'Run at startup', words: 'autostart launch sign in windows', detail: 'On · Off' },
  { tab: 'desktop', label: 'System tray', words: 'icon clock minimize', detail: 'On · Off' },
  { tab: 'desktop', label: 'Minimise to tray on close', words: 'close button hide quit', detail: 'On · Off' },
  { tab: 'desktop', label: 'Mute all sounds', words: 'silent alarms chimes audio', detail: 'On · Off' },
  // About
  { tab: 'about', label: 'About', words: 'version update changelog credits', detail: 'Version · Build' },
  { tab: 'about', label: 'Keyboard shortcuts', words: 'keys cheatsheet help', detail: 'Shortcut sheet' },
  { tab: 'about', label: 'Diagnostics', words: 'report copy debug support', detail: 'Copy diagnostics report' },
  { tab: 'about', label: 'Reset preferences', words: 'settings defaults restore', detail: 'Reset settings only' },
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
      : SEARCH_INDEX.map((entry) => {
          const label = entry.label.toLowerCase();
          const words = entry.words.toLowerCase();
          const detail = entry.detail?.toLowerCase() ?? '';
          if (!`${label} ${words} ${detail}`.includes(needle)) return null;
          const score = label.startsWith(needle)
            ? 4
            : label.includes(needle)
              ? 3
              : words.includes(needle)
                ? 2
                : 1;
          return { entry, score };
        })
          .filter((item): item is { entry: (typeof SEARCH_INDEX)[number]; score: number } => item !== null)
          .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
          .slice(0, 20)
          .map((item) => item.entry);
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
                {entry.detail ? (
                  <span className="settings-window__result-detail">{entry.detail}</span>
                ) : null}
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
    case 'sharing':
      return 'Share with another device or a browser, locally or over the internet';
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