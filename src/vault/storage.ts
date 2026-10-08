/**
 * Persistence boundary.
 *
 * Everything above this interface is plain TypeScript, so swapping IndexedDB
 * for SQLite, a file, or a native keychain later touches only this folder.
 * Nothing here ever receives a master password or a plaintext credential.
 */

import type { StoredItem } from './types.ts';
import type { VaultHeader } from '../crypto/vault-crypto.ts';

import {
  ensureDefaultTags,
  normaliseChannels,
  normaliseFolders,
  normaliseSidebar,
  normaliseTags,
  type Channel,
  type ChannelAccent,
  type Folder,
  type SidebarEntry,
  type Tag,
} from './channels.ts';
import { EMPTY_SECURITY, normaliseSecurity, type LoginSecurity } from '../crypto/security.ts';

/** How the vault is laid out on screen. The choice is persisted. */
export type VaultView = 'animated' | 'carousel' | 'basic' | 'grid';

/** Light/dark, or follow the system. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** Accent gradient. Each sets --accent-h plus the two gradient stops. */
export type AccentName = ChannelAccent;

/** A small, deliberately calm palette. Chroma is kept low on purpose. */
export const ACCENT_PRESETS: { id: AccentName; label: string; from: number; to: number }[] = [
  { id: 'slate', label: 'Slate', from: 212, to: 196 },
  { id: 'sage', label: 'Sage', from: 152, to: 172 },
  { id: 'dusk', label: 'Dusk', from: 268, to: 232 },
  { id: 'clay', label: 'Clay', from: 28, to: 348 },
];

/** Row height / padding scale. */
export type Density = 'compact' | 'comfortable' | 'spacious';

/**
 * How much of each card's own text the rail shows.
 *
 * Icon-only is a narrow rail you read by shape, name-only drops the glyphs for
 * a plain list, and both is the default. Name-only still reserves room for the
 * status dot, because that dot carries the per-channel hue and removing it
 * would make two channels indistinguishable.
 */
export type SidebarLabels = 'icon' | 'name' | 'both';

/** Which edge of the window the channel rail is docked to. */
export type SidebarPosition = 'left' | 'right' | 'top' | 'bottom';

/** Per-view card geometry and colour. */
export interface CardSizePrefs {
  /** Overall scale, 0.6 to 1.6, as a multiple shown as 0.6x to 1.6x. */
  scale: number;
  /**
   * Card width in px, as a cap rather than a fixed width. Flow and List both
   * stay fluid inside it, so the value means "allowed to grow this wide"; Orbit
   * is the one view that needs a real fixed width because its ring geometry is
   * computed from it.
   */
  width: number;
  /**
   * Floor on the card's height in px, for Flow and List. It is a minimum and
   * not a fixed height, because the cards carry a photo, a title, tag chips and
   * a credential block, and a hard height would clip whichever of those is
   * tallest. Orbit ignores this and uses `aspect` instead.
   */
  minHeight: number;
  /** Height as a multiple of width for Orbit; ignored elsewhere. */
  aspect: number;
  /** Card surface tint: 0 = fully transparent, 1 = fully opaque. */
  surface: number;
  /** Corner radius in px. */
  radius: number;
}

export const DEFAULT_CARD_SIZE: Record<VaultView, CardSizePrefs> = {
  // Orbit was previously hard-coded to 230px wide, which read as far too small
  // once the ring had more than a handful of logins on it.
  animated: { scale: 1, width: 560, minHeight: 132, aspect: 1, surface: 1, radius: 14 },
  carousel: { scale: 1, width: 340, minHeight: 0, aspect: 1.35, surface: 1, radius: 20 },
  basic: { scale: 1, width: 900, minHeight: 64, aspect: 1, surface: 1, radius: 14 },
  // Grid reflows to whatever fits, so its width is the widest a single cell may
  // get before the track count drops. That is the one number worth tuning here:
  // raising it buys larger cards at the cost of columns.
  grid: { scale: 1, width: 340, minHeight: 96, aspect: 1, surface: 1, radius: 14 },
};

/**
 * One dock slot's configuration.
 *
 * `ref` is a VaultView for kind 'view', a channel id for kind 'channel', a
 * login id for kind 'login', a Gmail account id for kind 'mailbox', and
 * unused for 'inbox'. `label` overrides the display name when present;
 * `icon` overrides the glyph with an uploaded (data URL) or remote (https)
 * image. `action` (login slots only) chooses what pressing the slot does.
 * A slot whose target no longer exists is skipped at render rather than
 * erroring, so deleting a channel cannot break the bar.
 */
export type DockSlotKind = 'view' | 'channel' | 'folder' | 'login' | 'inbox' | 'mailbox';

/** What a dock login slot does when pressed. 'both' is the historic behavior. */
export type DockLoginAction = 'password' | 'email' | 'both' | 'edit' | 'messages';

export const DOCK_LOGIN_ACTIONS: DockLoginAction[] = ['password', 'email', 'both', 'edit', 'messages'];

/** Which edge the dock snaps its orientation to. The bar reflows to a column on the sides. */
export type DockPosition = 'bottom' | 'top' | 'left' | 'right';

/**
 * Where the dock sits: viewport fractions plus the snapped edge that decides
 * its orientation (row on top/bottom, column on the sides). Free placement,
 * not four slots — the bar drags anywhere and the edge follows the nearest
 * side on drop.
 */
export interface DockPlacement {
  edge: DockPosition;
  /** 0–1 across the viewport width. */
  fx: number;
  /** 0–1 down the viewport height. */
  fy: number;
}

export interface DockSlotConfig {
  kind: DockSlotKind;
  ref: string;
  label?: string;
  key: string;
  icon?: string;
  /** Login slots only: what pressing does. Absent means 'both', as before. */
  action?: DockLoginAction;
}

/** Hard cap: more slots than this wrap the bar into a second row. */
export const MAX_DOCK_SLOTS = 8;

export const DEFAULT_DOCK_SLOTS: DockSlotConfig[] = [
  { kind: 'view', ref: 'animated', key: '1' },
  { kind: 'view', ref: 'carousel', key: '2' },
  { kind: 'view', ref: 'basic', key: '3' },
  { kind: 'view', ref: 'grid', key: '4' },
  { kind: 'inbox', ref: '', key: '5' },
];

/**
 * One connected mailbox. An app password, from Google Account > Security,
 * never sent anywhere but mail.google.com. Each account polls on its own
 * cadence; messages merge newest-first wherever they render.
 */
export interface GmailAccount {
  id: string;
  address: string;
  appPassword: string;
  enabled: boolean;
  /** How often to re-poll, in seconds. 0 means manual only (no timer). */
  refreshSeconds: number;
}

export function newGmailAccountId(): string {
  return `gm_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One cached inbox message. Same shape the feed parser produces — subjects
 * and senders, never credentials — kept so the message lists can grow past
 * the ~20 Google's feed returns per read.
 */
export interface CachedMailMessage {
  id: string;
  title: string;
  author: string;
  email: string;
  summary: string;
  issued: string;
  alternate: string;
  accountId: string;
}

/** How many messages are kept per account. Bounds the prefs blob. */
export const MAIL_CACHE_CAP = 300;

/**
 * Merges freshly fetched messages into an account's cache, newest first.
 * Pure, so it is unit-testable: dedupes by message id, keeps the newest, and
 * caps the list so one chatty mailbox cannot grow the stored record forever.
 */
export function mergeMailCache(
  cache: Record<string, CachedMailMessage[]>,
  accountId: string,
  incoming: CachedMailMessage[],
): Record<string, CachedMailMessage[]> {
  const seen = new Set<string>();
  const merged: CachedMailMessage[] = [];
  for (const message of [...incoming, ...(cache[accountId] ?? [])]) {
    if (!message || typeof message.id !== 'string') continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  merged.sort((a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || ''));
  return { ...cache, [accountId]: merged.slice(0, MAIL_CACHE_CAP) };
}

/**
 * How a view is named wherever the four views are offered as a group: the
 * topbar picker, the sidebar, and the right-click menu.
 *
 * Mirrors SidebarLabels rather than reusing it, because the two are tuned
 * independently. The sidebar rail can afford to drop names to a tooltip; the
 * view switcher is the only place that says what "Orbit" is, and taking the
 * names away there leaves four unlabelled glyphs.
 */
export type ViewLabels = 'icon' | 'name' | 'both';

/** Sort order for the list views. */
export type SortMode = 'title' | 'recent' | 'oldest' | 'strength' | 'username';

/** A repeating reminder with its own sound. */
export interface Alarm {
  id: string;
  label: string;
  /** 'HH:MM', 24h, local time. */
  time: string;
  /** 0 = Sunday .. 6 = Saturday. Empty means every day. */
  days: number[];
  /** A name plus an imported data URL; null uses the built-in chime. */
  sound: { name: string; dataUrl: string | null } | null;
  enabled: boolean;
}

export function newAlarmId(): string {
  return `al_${crypto.randomUUID().slice(0, 8)}`;
}

export interface VaultPreferences {
  theme: ThemeMode;
  accent: AccentName;

  // -- Appearance
  /** 0 = no motion, 1 = full. Honoured on top of the OS reduced-motion setting. */
  motion: number;
  /** Duration multiplier for every transition. 0.25 = instant, 2 = languid. */
  motionSpeed: number;
  /** Mesh-gradient background intensity, 0 to 1. */
  ambient: number;
  density: Density;
  /** Corner radius scale, 0.6 to 1.4. */
  roundness: number;
  /** Shadow depth under login cards, 0 (flat) to 1 (deep). */
  cardDepth: number;
  /**
   * Per-view card sizing and colour, so each of the three views can be tuned
   * independently. The user asked for a size control on Flow, List and Orbit
   * separately rather than one global slider, because the three views have
   * genuinely different geometry: a ring card's width sets how much of the
   * ring is visible, a list row's width sets the measure of the text.
   */
  cardSize: Record<VaultView, CardSizePrefs>;
  /** How the sidebar rail presents channels. */
  sidebarLabels: SidebarLabels;
  /**
   * Whether the view switcher shows glyphs, names, or both. One value for the
   * whole group, because a switcher showing four icons on the left and four
   * labelled entries on the right reads as two different controls that happen
   * to sit together. Settings has a per-view override for anyone who wants
   * them to disagree, applied on top of this.
   */
  viewLabels: ViewLabels;
  /**
   * Per-view override of `viewLabels`. A view absent from the record follows
   * the global setting, so the override is opt-in rather than four more
   * preferences to keep in step by hand.
   */
  viewLabelsByView: Partial<Record<VaultView, ViewLabels>>;
  /** Which edge of the window the channel rail is docked to. */
  sidebarPosition: SidebarPosition;
  /** Root font size as a percentage of the default. */
  textScale: number;
  /** Drops the frosted-glass effect for a flatter, faster surface. */
  reduceTransparency: boolean;
  /** Boosts border and text contrast. */
  highContrast: boolean;

  // -- Background
  /** App-wide background image: https URL or uploaded data URL. */
  backgroundImage: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundDim: number;

  // -- Layout
  view: VaultView;
  sort: SortMode;
  /** Shows the URL alongside the username in rows. */
  showUrls: boolean;
  /** Pins favorites to a section above everything else. */
  pinFavorites: boolean;
  /** Opens a login's details as soon as it is selected. */
  expandOnOpen: boolean;
  /** Collapses the sidebar to icons only. */
  compactSidebar: boolean;
  /** Shows the keyboard shortcuts entry in the sidebar. Also in Settings › About. */
  showShortcuts: boolean;
  /**
   * Quick-launch dock slots, in bar order.
   *
   * Each slot jumps somewhere (a view, a channel, the inbox) on click or on
   * its key. Keys are single characters pressed bare (no modifier), matched
   * only when no text field, menu, dialog or editor is open. Bare keys are
   * what makes it fast; the guard list is what keeps it from eating
   * keystrokes. The key lives on the slot (not in a parallel array) so the
   * dock, the badges, the listener and the settings rows cannot disagree
   * about which key means what.
   */
  dockEnabled: boolean;
  dockSlots: DockSlotConfig[];
  dockPos: DockPlacement;
  /**
   * Per-login use counts: incremented on copy and on edit, read by the
   * Frequently-used panel and the untouched-login scan.
   *
   * Plaintext like the rest of prefs — counts are not secret — and capped, so
   * a deleted login's entry cannot grow the record forever. Entries for gone
   * logins are pruned on write, not on load, because load cannot see the items.
   */
  usage: Record<string, { count: number; at: number }>;
  /**
   * Desktop shell settings. Read by Electron; inert on web, where there is no
   * tray, no autostart and no window chrome to manage. Kept in prefs (not in
   * the shell) so they back up and reset with everything else.
   */
  trayEnabled: boolean;
  /** The X button hides to the tray instead of quitting. Needs trayEnabled. */
  closeToTray: boolean;
  /** Start with the OS, into the tray. */
  launchAtLogin: boolean;
  /** Silences alarm sounds (and the test chime). Toasts still appear. */
  soundsMuted: boolean;
  /** Detaches sidebar channels and topbar buttons into floating pills. */
  floatingChrome: boolean;
  /** Shows the lock control on the main screen. Settings always keeps its own. */
  showLockButton: boolean;
  /** Every new tag also becomes a sidebar channel. */
  autoTagChannel: boolean;
  /** Shows the tag chips on each login card. */
  showTagChips: boolean;
  /** Puts each login's title and email inside its own node in the Orbit ring. */
  showOrbitLabels: boolean;
  /** Hides the hairline dividers inside the settings window. */
  hideDividers: boolean;

  // -- Reminders
  /** Days before an unchanged password is treated as stale. 0 disables. */
  passwordAgeDays: number;
  /** Days before an unchanged email/username is flagged. 0 disables. */
  emailAgeDays: number;
  /** Days between "check your email" reminders. 0 disables. */
  emailCheckDays: number;
  /** How tags are ordered in the dashboard and pickers. */
  tagSort: 'name' | 'count' | 'hue';
  /** User-defined sidebar views, built-ins are always prepended. */
  channels: Channel[];
  /** Global tag catalogue; logins reference these by id. */
  tags: Tag[];
  /** Expandable, themeable channel groups with their own optional lock. */
  folders: Folder[];
  /** The sidebar tree. When empty it is derived from `channels`. */
  sidebar: SidebarEntry[];
  /** Shows a channel for logins that have no tags at all. */
  showUnassignedChannel: boolean;
  /**
   * Channel ids hidden from the sidebar. Hidden is not deleted: the channel
   * keeps its logins, stays editable in Settings, and still works from the
   * dock or the dashboard — it just takes up no rail space.
   */
  hiddenChannels: string[];
  /** Shows the "New channel" shortcut at the end of the sidebar. */
  showNewChannelButton: boolean;
  /** Shows the Compact toggle in the sidebar footer. */
  showCompactButton: boolean;
  /**
   * Shows the channel rail at all. Off hides the entire sidebar; a button in
   * the topbar brings it back, so this can never strand Settings.
   */
  showSidebar: boolean;
  /** Automatically tags a login from its website/email provider domain. */
  autoTagDomain: boolean;
  /** View of the list: whether the letter group headings render. */
  showLetterGroups: boolean;

  // -- Clipboard capture
  /** Offers to save credentials spotted on the clipboard. */
  clipboardCapture: boolean;
  /** Saves them immediately rather than asking first. */
  clipboardAutoSave: boolean;

  // -- Gmail integration: several accounts, each independent. The old single
  // `gmail` object migrates into the first entry on load, so a connected
  // mailbox survives the upgrade without reconnecting.
  gmailAccounts: GmailAccount[];
  /**
   * Messages accumulated from the inbox feeds, per account id.
   *
   * Google's Atom feed only ever returns the ~20 most recent unread messages
   * and offers no pagination, so without this a login's message list could
   * never grow past that. Every successful fetch merges into this cache, so
   * history keeps building across polls and the expander can keep loading
   * past 20. Plaintext like the rest of prefs; subjects and senders are not
   * secrets.
   */
  mailCache: Record<string, CachedMailMessage[]>;

  // -- Alarms
  alarms: Alarm[];

  // -- Vault-level extra factor (opt-in), checked after the vault opens.
  vaultSecurity: LoginSecurity;

  // -- Security
  autoLockMinutes: number;
  clearClipboardSeconds: number;
  /** Also wipe the clipboard when locking. */
  clearClipboardOnLock: boolean;
  revealPasswords: boolean;
  /** Shows the "reused" and "old" badges. */
  showHealthBadges: boolean;
  /** Warns before opening a site whose password is reused elsewhere. */
  warnOnReuse: boolean;
  /** Requires the vault password before a backup can be written. */
  confirmBeforeExport: boolean;

  // -- Generator defaults
  passwordGenerator: {
    length: number;
    lower: boolean;
    upper: boolean;
    digits: boolean;
    symbols: boolean;
    avoidAmbiguous: boolean;
  };

  // -- Misc
  /** Toast on copy. */
  copyToasts: boolean;
  /** Confirms destructive actions with a modal rather than acting immediately. */
  confirmDeletes: boolean;
}

export const DEFAULT_PREFERENCES: VaultPreferences = {
  theme: 'system',
  accent: 'slate',
  motion: 1,
  motionSpeed: 1,
  ambient: 1,
  density: 'comfortable',
  roundness: 1,
  cardDepth: 0.4,
  cardSize: DEFAULT_CARD_SIZE,
  sidebarLabels: 'both',
  viewLabels: 'both',
  viewLabelsByView: {},
  sidebarPosition: 'left',
  textScale: 100,
  reduceTransparency: false,
  highContrast: false,
  backgroundImage: '',
  backgroundOpacity: 0.35,
  backgroundBlur: 0,
  backgroundDim: 0.25,
  view: 'animated',
  sort: 'title',
  showUrls: true,
  pinFavorites: true,
  expandOnOpen: false,
  compactSidebar: false,
  showShortcuts: false,
  dockEnabled: true,
  dockSlots: DEFAULT_DOCK_SLOTS.map((slot) => ({ ...slot })),
  dockPos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
  usage: {},
  trayEnabled: true,
  closeToTray: true,
  launchAtLogin: false,
  soundsMuted: false,
  floatingChrome: false,
  showLockButton: true,
  autoTagChannel: false,
  showTagChips: true,
  showOrbitLabels: true,
  hideDividers: false,
  passwordAgeDays: 180,
  emailAgeDays: 365,
  emailCheckDays: 90,
  tagSort: 'name',
  channels: [],
  tags: [],
  folders: [],
  sidebar: [],
  showUnassignedChannel: true,
  hiddenChannels: [],
  showNewChannelButton: true,
  showCompactButton: true,
  showSidebar: true,
  autoTagDomain: true,
  showLetterGroups: true,
  clipboardCapture: false,
  clipboardAutoSave: false,
  alarms: [],
  vaultSecurity: EMPTY_SECURITY,
  autoLockMinutes: 5,
  clearClipboardSeconds: 30,
  clearClipboardOnLock: true,
  revealPasswords: false,
  showHealthBadges: true,
  warnOnReuse: true,
  confirmBeforeExport: false,
  passwordGenerator: {
    length: 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: true,
  },
  copyToasts: true,
  confirmDeletes: true,
  gmailAccounts: [],
  mailCache: {},
};

/**
 * Merges stored preferences over the defaults and coerces anything stale.
 *
 * Preferences live in plaintext (they are not secret), and a bad value here
 * would break rendering, so unknown enum members fall back rather than throw.
 */
export function normalisePreferences(stored: Partial<VaultPreferences> | undefined | null): VaultPreferences {
  const merged: VaultPreferences = { ...DEFAULT_PREFERENCES, ...stored };
  merged.passwordGenerator = { ...DEFAULT_PREFERENCES.passwordGenerator, ...stored?.passwordGenerator };
  merged.channels = normaliseChannels(merged.channels);
  // Default health tags are ordinary, editable tags — seeded here so every
  // vault (new or migrated) has weak / needs attention / reused to assign and
  // filter by, rather than badge text only the app controls.
  merged.tags = ensureDefaultTags(normaliseTags(merged.tags));
  merged.folders = normaliseFolders(merged.folders);
  merged.sidebar = normaliseSidebar(merged.sidebar, merged.channels, merged.folders);
  merged.showUnassignedChannel = Boolean(merged.showUnassignedChannel);
  merged.hiddenChannels = Array.isArray(merged.hiddenChannels)
    ? [...new Set(merged.hiddenChannels.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  merged.showNewChannelButton = Boolean(merged.showNewChannelButton);
  merged.showCompactButton = Boolean(merged.showCompactButton);
  merged.showSidebar = merged.showSidebar !== false;
  merged.autoTagDomain = Boolean(merged.autoTagDomain);
  merged.showLetterGroups = merged.showLetterGroups !== false;
  merged.clipboardCapture = Boolean(merged.clipboardCapture);
  merged.clipboardAutoSave = Boolean(merged.clipboardAutoSave);
  // Several accounts now; the old single object migrates into the first entry
  // so a connected mailbox keeps working without reconnecting. Anything
  // malformed is dropped per account rather than wiping the whole list.
  {
    const legacy = merged as Partial<VaultPreferences> & {
      gmail?: { enabled?: unknown; address?: unknown; appPassword?: unknown; refreshSeconds?: unknown };
    };
    // Stored accounts win when non-empty; otherwise the legacy single object
    // migrates in. Checking length (not just Array) matters because the
    // defaults spread an empty array over a record that predates accounts.
    const storedAccounts = Array.isArray(merged.gmailAccounts) && merged.gmailAccounts.length > 0
      ? merged.gmailAccounts
      : [];
    const raw: unknown[] =
      storedAccounts.length > 0
        ? storedAccounts
        : legacy.gmail && (typeof legacy.gmail.address === 'string' || typeof legacy.gmail.appPassword === 'string')
          ? [{ ...legacy.gmail, id: newGmailAccountId() }]
          : [];
    const clean: GmailAccount[] = [];
    const seen = new Set<string>();
    for (const entry of raw.slice(0, 8)) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const address = typeof record.address === 'string' ? record.address.trim() : '';
      const appPassword = typeof record.appPassword === 'string' ? record.appPassword.replace(/\s+/g, '') : '';
      if (!address && !appPassword) continue;
      if (address && seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      // Very old builds stored 2s/10s/15s cadences, which no longer exist as
      // choices: they migrate onto the nearest offered one. 0 (manual) and
      // the offered sub-minute and minute-scale choices pass through.
      const rawCadence = record.refreshSeconds as number;
      const cadence = [0, 5, 30, 60, 120, 300, 600, 900].includes(rawCadence)
        ? rawCadence
        : rawCadence > 900
          ? 900
          : rawCadence <= 5
            ? 5
            : rawCadence <= 30
              ? 30
              : 60;
      clean.push({
        id: typeof record.id === 'string' && record.id ? record.id : newGmailAccountId(),
        address,
        appPassword,
        enabled: record.enabled !== false,
        refreshSeconds: cadence,
      });
    }
    merged.gmailAccounts = clean;
    delete legacy.gmail;
  }
  // Message cache: plain objects with string fields only, capped per account
  // so a hand-edited record cannot bloat the stored prefs.
  {
    const raw = (merged.mailCache ?? {}) as Record<string, unknown>;
    const clean: Record<string, CachedMailMessage[]> = {};
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    for (const [accountId, list] of Object.entries(raw)) {
      if (!accountId || !Array.isArray(list)) continue;
      const kept: CachedMailMessage[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== 'string' || !record.id) continue;
        kept.push({
          id: record.id as string,
          title: str(record.title),
          author: str(record.author),
          email: str(record.email),
          summary: str(record.summary),
          issued: str(record.issued),
          alternate: str(record.alternate),
          accountId,
        });
        if (kept.length >= MAIL_CACHE_CAP) break;
      }
      if (kept.length > 0) clean[accountId] = kept;
    }
    merged.mailCache = clean;
  }
  merged.alarms = Array.isArray(merged.alarms)
    ? merged.alarms
        .filter((alarm): alarm is Alarm => Boolean(alarm && typeof alarm.id === 'string' && typeof alarm.time === 'string'))
        .map((alarm) => ({
          id: alarm.id,
          label: typeof alarm.label === 'string' ? alarm.label : '',
          time: /^\d{2}:\d{2}$/.test(alarm.time) ? alarm.time : '08:00',
          days: Array.isArray(alarm.days) ? alarm.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
          sound: alarm.sound && typeof alarm.sound === 'object'
            ? { name: String(alarm.sound.name ?? 'Custom'), dataUrl: typeof alarm.sound.dataUrl === 'string' ? alarm.sound.dataUrl : null }
            : null,
          enabled: Boolean(alarm.enabled),
        }))
    : [];
  // normaliseSecurity, not a hand-rolled rebuild: three sites used to rebuild
  // this object inline and all three forgot `passcode`, so a passcode-only
  // second factor silently stopped protecting anything on reload.
  merged.vaultSecurity = normaliseSecurity(merged.vaultSecurity);

  const oneOf = <T extends string>(value: T, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value) ? value : fallback;

  /** A finite number, or the fallback. Guards against NaN from stored JSON. */
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  merged.theme = oneOf(merged.theme, ['light', 'dark', 'system'] as const, DEFAULT_PREFERENCES.theme);
  // Legacy accent names from earlier versions map onto the calm set.
  const LEGACY_ACCENTS: Record<string, AccentName> = {
    aurora: 'slate',
    mint: 'sage',
    nebula: 'dusk',
    orchid: 'dusk',
    sunset: 'clay',
    ember: 'clay',
  };
  merged.accent = oneOf(
    LEGACY_ACCENTS[merged.accent] ?? merged.accent,
    ['slate', 'sage', 'dusk', 'clay'] as const,
    DEFAULT_PREFERENCES.accent,
  );
  merged.view = oneOf(merged.view, ['animated', 'carousel', 'basic', 'grid'] as const, DEFAULT_PREFERENCES.view);
  merged.sort = oneOf(
    merged.sort,
    ['title', 'recent', 'oldest', 'strength', 'username'] as const,
    DEFAULT_PREFERENCES.sort,
  );
  merged.density = oneOf(merged.density, ['compact', 'comfortable', 'spacious'] as const, DEFAULT_PREFERENCES.density);

  merged.motion = clampRange(merged.motion, 0, 1, DEFAULT_PREFERENCES.motion);
  merged.motionSpeed = clampRange(merged.motionSpeed, 0.25, 2, DEFAULT_PREFERENCES.motionSpeed);

  // Flow card width used to be one global percentage of the content column,
  // which contradicted the per-view px cap and left two live controls fighting
  // over the same box. Dropped outright rather than migrated: it never meant
  // anything the per-view width does not already say, so folding it in would
  // just bake an arbitrary number into a card the user never sized.
  delete (merged as Partial<Record<'flowCardSize', unknown>>).flowCardSize;

  // Per-view card geometry. Each field is clamped individually rather than
  // taking the stored object wholesale, so a partially-written or hand-edited
  // record cannot leave a view with a zero width or a NaN radius.
  const views: VaultView[] = ['animated', 'carousel', 'basic', 'grid'];
  const storedCardSize = (merged.cardSize ?? {}) as Partial<Record<VaultView, Partial<CardSizePrefs>>>;
  const cardSize = {} as Record<VaultView, CardSizePrefs>;
  for (const view of views) {
    const fallback = DEFAULT_CARD_SIZE[view];
    const raw = storedCardSize[view] ?? {};
    cardSize[view] = {
      scale: clampRange(num(raw.scale, fallback.scale), 0.6, 1.6, fallback.scale),
      width: Math.round(clampRange(num(raw.width, fallback.width), 180, 1200, fallback.width)),
      minHeight: Math.round(clampRange(num(raw.minHeight, fallback.minHeight), 0, 480, fallback.minHeight)),
      aspect: clampRange(num(raw.aspect, fallback.aspect), 0.5, 3, fallback.aspect),
      surface: clampRange(num(raw.surface, fallback.surface), 0, 1, fallback.surface),
      radius: Math.round(clampRange(num(raw.radius, fallback.radius), 0, 48, fallback.radius)),
    };
  }
  merged.cardSize = cardSize;
  merged.sidebarLabels = oneOf(merged.sidebarLabels, ['icon', 'name', 'both'] as const, 'both');
  merged.viewLabels = oneOf(merged.viewLabels, ['icon', 'name', 'both'] as const, 'both');

  // The per-view override is filtered rather than coerced field by field, and a
  // view whose entry is dropped simply falls back to the global setting. An
  // empty object is the normal state and must stay one, so it is not replaced
  // with null or omitted.
  const VIEW_LABEL_MODES = ['icon', 'name', 'both'] as const;
  const rawViewLabels = (merged.viewLabelsByView ?? {}) as Record<string, unknown>;
  const viewLabelsByView: Partial<Record<VaultView, ViewLabels>> = {};
  for (const view of views) {
    const mode = rawViewLabels[view];
    if (typeof mode === 'string' && (VIEW_LABEL_MODES as readonly string[]).includes(mode)) {
      viewLabelsByView[view] = mode as ViewLabels;
    }
  }
  merged.viewLabelsByView = viewLabelsByView;
  merged.sidebarPosition = oneOf(merged.sidebarPosition, ['left', 'right', 'top', 'bottom'] as const, 'left');

  // Dock slots: at most MAX_DOCK_SLOTS, each with a valid kind, a valid view ref,
  // a unique single-character key, a short label and a safe icon. Anything
  // else falls back slot by slot, so a hand-edited or partially-written record
  // cannot leave a slot unreachable, two slots fighting over one key, or a
  // javascript: URL smuggled in as an icon.
  merged.dockEnabled = Boolean(merged.dockEnabled);
  // Use counts: plain objects with numeric fields only, capped at 200 by
  // recency so the record cannot grow without bound. Pruning by id happens on
  // write (which sees the items); load only validates shape.
  {
    const raw = (merged.usage ?? {}) as Record<string, unknown>;
    const entries: [string, { count: number; at: number }][] = [];
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const count = typeof record.count === 'number' && Number.isFinite(record.count) ? Math.max(0, Math.floor(record.count)) : 0;
      const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
      if (id && (count > 0 || at > 0)) entries.push([id, { count, at }]);
    }
    entries.sort((a, b) => b[1].at - a[1].at);
    merged.usage = Object.fromEntries(entries.slice(0, 200));
  }
  // Free placement as clamped fractions. Anything outside 0–1 (a hand-edited
  // record, a resize across monitors) is pulled back on screen rather than
  // stranding the bar where no pointer can reach it.
  {
    const raw = (merged.dockPos ?? {}) as Partial<DockPlacement>;
    const edge = raw.edge === 'top' || raw.edge === 'left' || raw.edge === 'right' ? raw.edge : 'bottom';
    const clamp = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(0.94, Math.max(0.06, value)) : fallback;
    merged.dockPos = { edge, fx: clamp(raw.fx, 0.5), fy: clamp(raw.fy, edge === 'top' ? 0.06 : 0.94) };
  }
  merged.trayEnabled = Boolean(merged.trayEnabled);
  merged.closeToTray = Boolean(merged.closeToTray);
  merged.launchAtLogin = Boolean(merged.launchAtLogin);
  merged.soundsMuted = Boolean(merged.soundsMuted);
  {
    const raw = Array.isArray(merged.dockSlots) ? merged.dockSlots : [];
    const seen = new Set<string>();
    const fallbackKeys = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const clean: DockSlotConfig[] = [];
    for (const entry of raw.slice(0, MAX_DOCK_SLOTS)) {
      if (!entry || typeof entry !== 'object') continue;
      const kind = (entry as { kind?: unknown }).kind;
      if (kind !== 'view' && kind !== 'channel' && kind !== 'folder' && kind !== 'login' && kind !== 'inbox' && kind !== 'mailbox') continue;
      const ref = typeof (entry as { ref?: unknown }).ref === 'string' ? (entry as { ref: string }).ref : '';
      if (kind === 'view' && !(['animated', 'carousel', 'basic', 'grid'] as const).includes(ref as VaultView)) continue;
      if ((kind === 'channel' || kind === 'folder' || kind === 'login' || kind === 'mailbox') && !ref) continue;
      if (kind === 'inbox' && clean.some((slot) => slot.kind === 'inbox')) continue;
      if (clean.some((slot) => slot.kind === kind && slot.ref === ref)) continue;
      const rawAction = (entry as { action?: unknown }).action;
      const action: DockLoginAction | undefined =
        kind === 'login' && typeof rawAction === 'string' && (DOCK_LOGIN_ACTIONS as readonly string[]).includes(rawAction)
          ? (rawAction as DockLoginAction)
          : undefined;
      const rawKey = typeof (entry as { key?: unknown }).key === 'string' ? (entry as { key: string }).key.trim() : '';
      let key = rawKey.length === 1 && !seen.has(rawKey.toLowerCase()) ? rawKey : '';
      if (!key) {
        const free = fallbackKeys.find((candidate) => !seen.has(candidate));
        if (!free) continue;
        key = free;
      }
      seen.add(key.toLowerCase());
      const rawLabel = typeof (entry as { label?: unknown }).label === 'string' ? (entry as { label: string }).label.trim() : '';
      const rawIcon = typeof (entry as { icon?: unknown }).icon === 'string' ? (entry as { icon: string }).icon.trim() : '';
      clean.push({
        kind,
        ref,
        ...(rawLabel ? { label: rawLabel.slice(0, 24) } : {}),
        key,
        ...(rawIcon.startsWith('data:image/') || rawIcon.startsWith('https://') ? { icon: rawIcon } : {}),
        ...(action ? { action } : {}),
      });
    }
    merged.dockSlots = clean.length > 0 ? clean : DEFAULT_DOCK_SLOTS.map((slot) => ({ ...slot }));
  }

  // Reminder windows. Anything at 0 switches that check off.
  merged.passwordAgeDays = [0, 30, 60, 90, 180, 365, 730].includes(merged.passwordAgeDays)
    ? merged.passwordAgeDays
    : DEFAULT_PREFERENCES.passwordAgeDays;
  merged.emailAgeDays = [0, 90, 180, 365, 730].includes(merged.emailAgeDays)
    ? merged.emailAgeDays
    : DEFAULT_PREFERENCES.emailAgeDays;
  merged.emailCheckDays = [0, 30, 60, 90, 180, 365].includes(merged.emailCheckDays)
    ? merged.emailCheckDays
    : DEFAULT_PREFERENCES.emailCheckDays;
  merged.tagSort = oneOf(merged.tagSort, ['name', 'count', 'hue'] as const, DEFAULT_PREFERENCES.tagSort);
  merged.ambient = clampRange(merged.ambient, 0, 1, DEFAULT_PREFERENCES.ambient);
  merged.roundness = clampRange(merged.roundness, 0.6, 1.4, DEFAULT_PREFERENCES.roundness);
  merged.cardDepth = clampRange(merged.cardDepth, 0, 1, DEFAULT_PREFERENCES.cardDepth);
  merged.textScale = clampRange(merged.textScale, 85, 130, DEFAULT_PREFERENCES.textScale);
  merged.clearClipboardSeconds = clampRange(merged.clearClipboardSeconds, 0, 300, DEFAULT_PREFERENCES.clearClipboardSeconds);
  merged.passwordGenerator.length = Math.round(
    clampRange(merged.passwordGenerator.length, 8, 64, DEFAULT_PREFERENCES.passwordGenerator.length),
  );

  merged.autoLockMinutes = [0, 1, 5, 15, 30, 60].includes(merged.autoLockMinutes)
    ? merged.autoLockMinutes
    : DEFAULT_PREFERENCES.autoLockMinutes;

  // Only the on/off flags are coerced. `length` is a number and must not be
  // run through Boolean(), which would turn it into `true`.
  for (const key of ['lower', 'upper', 'digits', 'symbols', 'avoidAmbiguous'] as const) {
    merged.passwordGenerator[key] = Boolean(merged.passwordGenerator[key]);
  }
  // Turning every character set off would make the generator unusable.
  const setCount = (['lower', 'upper', 'digits', 'symbols'] as const).filter(
    (key) => merged.passwordGenerator[key],
  ).length;
  if (setCount === 0) merged.passwordGenerator = { ...DEFAULT_PREFERENCES.passwordGenerator };

  return merged;
}

function clampRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export interface VaultStorage {
  loadHeader(): Promise<VaultHeader | null>;
  saveHeader(header: VaultHeader): Promise<void>;
  loadItems(): Promise<StoredItem[]>;
  putItem(item: StoredItem): Promise<void>;
  putItems(items: StoredItem[]): Promise<void>;
  deleteItem(id: string): Promise<void>;
  /** Wipes header and items. Used by "reset vault". */
  clear(): Promise<void>;
  loadPreferences(): Promise<VaultPreferences>;
  savePreferences(prefs: VaultPreferences): Promise<void>;
}

const DB_NAME = 'aegis-vault';
const DB_VERSION = 1;
const META_STORE = 'meta';
const ITEM_STORE = 'items';

export class IndexedDbVaultStorage implements VaultStorage {
  #db: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB) {
    this.#db = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        if (!db.objectStoreNames.contains(ITEM_STORE)) {
          db.createObjectStore(ITEM_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the vault database.'));
    });
  }

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async #tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#db;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = run(tx.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Vault database request failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Vault database transaction aborted.'));
    });
  }

  loadHeader(): Promise<VaultHeader | null> {
    return this.#tx<VaultHeader | undefined>(META_STORE, 'readonly', (s) => s.get('header')).then(
      (value) => value ?? null,
    );
  }

  saveHeader(header: VaultHeader): Promise<void> {
    return this.#tx(META_STORE, 'readwrite', (s) => s.put(header, 'header')).then(() => undefined);
  }

  loadItems(): Promise<StoredItem[]> {
    return this.#tx<StoredItem[]>(ITEM_STORE, 'readonly', (s) => s.getAll());
  }

  async putItem(item: StoredItem): Promise<void> {
    await this.putItems([item]);
  }

  putItems(items: StoredItem[]): Promise<void> {
    const db = this.#db;
    return db.then(
      (handle) =>
        new Promise<void>((resolve, reject) => {
          const tx = handle.transaction(ITEM_STORE, 'readwrite');
          const store = tx.objectStore(ITEM_STORE);
          for (const item of items) store.put(item);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('Could not save item.'));
          tx.onabort = () => reject(tx.error ?? new Error('Could not save item.'));
        }),
    );
  }

  deleteItem(id: string): Promise<void> {
    return this.#tx(ITEM_STORE, 'readwrite', (s) => s.delete(id)).then(() => undefined);
  }

  async clear(): Promise<void> {
    const db = await this.#db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE, ITEM_STORE], 'readwrite');
      tx.objectStore(META_STORE).clear();
      tx.objectStore(ITEM_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not reset the vault.'));
    });
  }

  async loadPreferences(): Promise<VaultPreferences> {
    const stored = await this.#tx<Partial<VaultPreferences> | undefined>(META_STORE, 'readonly', (s) =>
      s.get('preferences'),
    );
    return normalisePreferences(stored);
  }

  savePreferences(prefs: VaultPreferences): Promise<void> {
    return this.#tx(META_STORE, 'readwrite', (s) => s.put(prefs, 'preferences')).then(() => undefined);
  }
}

/** In-memory backend. Keeps the crypto layer testable and gives the app a fallback on locked-down browsers. */
export class MemoryVaultStorage implements VaultStorage {
  #header: VaultHeader | null = null;
  #items = new Map<string, StoredItem>();
  #prefs: VaultPreferences = DEFAULT_PREFERENCES;

  loadHeader() {
    return Promise.resolve(this.#header);
  }
  saveHeader(header: VaultHeader) {
    this.#header = header;
    return Promise.resolve();
  }
  loadItems() {
    return Promise.resolve([...this.#items.values()]);
  }
  putItem(item: StoredItem) {
    this.#items.set(item.id, item);
    return Promise.resolve();
  }
  putItems(items: StoredItem[]) {
    for (const item of items) this.#items.set(item.id, item);
    return Promise.resolve();
  }
  deleteItem(id: string) {
    this.#items.delete(id);
    return Promise.resolve();
  }
  clear() {
    this.#header = null;
    this.#items.clear();
    return Promise.resolve();
  }
  loadPreferences() {
    return Promise.resolve(normalisePreferences(this.#prefs));
  }
  savePreferences(prefs: VaultPreferences) {
    this.#prefs = normalisePreferences(prefs);
    return Promise.resolve();
  }
}