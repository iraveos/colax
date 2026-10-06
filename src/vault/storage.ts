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
import { EMPTY_SECURITY, type LoginSecurity } from '../crypto/security.ts';

/** How the vault is laid out on screen. The choice is persisted. */
export type VaultView = 'animated' | 'carousel' | 'basic';

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
};

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
  /** Automatically tags a login from its website/email provider domain. */
  autoTagDomain: boolean;
  /** View of the list: whether the letter group headings render. */
  showLetterGroups: boolean;

  // -- Clipboard capture
  /** Offers to save credentials spotted on the clipboard. */
  clipboardCapture: boolean;
  /** Saves them immediately rather than asking first. */
  clipboardAutoSave: boolean;

  // -- Gmail integration
  gmail: {
    enabled: boolean;
    address: string;
    /** An app password, from Google Account > Security. Never sent anywhere else. */
    appPassword: string;
    /** How often the inbox view re-polls, in seconds. */
    refreshSeconds: number;
  };

  // -- Alarms
  alarms: Alarm[];

  // -- Vault-level extra factor (opt-in), checked after the vault opens.
  vaultSecurity: LoginSecurity;

  // -- Security
  autoLockMinutes: number;
  /** Whether the vault re-locks as soon as the tab loses focus. */
  lockOnBlur: boolean;
  /** Also lock when the tab is merely hidden, which catches minimise and tab switches. */
  lockOnHidden: boolean;
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
  autoTagDomain: true,
  showLetterGroups: true,
  clipboardCapture: false,
  clipboardAutoSave: false,
  gmail: { enabled: false, address: '', appPassword: '', refreshSeconds: 5 },
  alarms: [],
  vaultSecurity: EMPTY_SECURITY,
  autoLockMinutes: 5,
  lockOnBlur: false,
  lockOnHidden: false,
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
  merged.tags = normaliseTags(merged.tags);
  merged.folders = normaliseFolders(merged.folders);
  merged.sidebar = normaliseSidebar(merged.sidebar, merged.channels, merged.folders);
  merged.showUnassignedChannel = Boolean(merged.showUnassignedChannel);
  merged.autoTagDomain = Boolean(merged.autoTagDomain);
  merged.showLetterGroups = merged.showLetterGroups !== false;
  merged.clipboardCapture = Boolean(merged.clipboardCapture);
  merged.clipboardAutoSave = Boolean(merged.clipboardAutoSave);
  merged.gmail = {
    enabled: Boolean(merged.gmail?.enabled),
    address: typeof merged.gmail?.address === 'string' ? merged.gmail.address : '',
    appPassword: typeof merged.gmail?.appPassword === 'string' ? merged.gmail.appPassword : '',
    refreshSeconds: [2, 5, 10, 15, 30, 60].includes(merged.gmail?.refreshSeconds)
      ? merged.gmail.refreshSeconds
      : DEFAULT_PREFERENCES.gmail.refreshSeconds,
  };
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
  merged.vaultSecurity = {
    totp: merged.vaultSecurity?.totp?.seed ? { seed: String(merged.vaultSecurity.totp.seed) } : null,
    questions: Array.isArray(merged.vaultSecurity?.questions)
      ? merged.vaultSecurity.questions
          .filter((question): question is NonNullable<typeof question> => Boolean(question && question.hash))
          .map((question) => ({
            id: String(question.id ?? `vq_${Math.random().toString(36).slice(2, 10)}`),
            prompt: String(question.prompt ?? ''),
            hash: String(question.hash),
            salt: String(question.salt ?? ''),
          }))
      : [],
  };

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
  merged.view = oneOf(merged.view, ['animated', 'carousel', 'basic'] as const, DEFAULT_PREFERENCES.view);
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
  const views: VaultView[] = ['animated', 'carousel', 'basic'];
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
  merged.sidebarPosition = oneOf(merged.sidebarPosition, ['left', 'right', 'top', 'bottom'] as const, 'left');

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