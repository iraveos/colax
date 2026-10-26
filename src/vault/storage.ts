/**
 * Persistence boundary.
 *
 * Everything above this interface is plain TypeScript, so swapping IndexedDB
 * for SQLite, a file, or a native keychain later touches only this folder.
 * Nothing here ever receives a master password or a plaintext credential.
 */

import { normaliseItem, type StoredItem, type VaultAttachment, type VaultItem } from './types.ts';
import type { VaultHeader } from '../crypto/vault-crypto.ts';

import {
  ensureDefaultTags,
  isRetiredChannelId,
  normaliseChannels,
  normaliseFolders,
  normaliseSidebar,
  normaliseTags,
  UNASSIGNED_CHANNEL_ID,
  type Channel,
  type ChannelAccent,
  type Folder,
  type SidebarEntry,
  type Tag,
} from './channels.ts';
import { EMPTY_SECURITY, normaliseSecurity, type LoginSecurity } from '../crypto/security.ts';
import { MAIL_PROVIDERS, providerById, providerForAddress } from '../lib/mail-providers.ts';
import { normaliseMailOAuth, type MailAuthKind, type MailOAuth } from '../lib/oauth.ts';
import { normaliseReusableEmails } from '../lib/temp-mail.ts';
import {
  normaliseOptimizeProfiles,
  readStyle,
  type OptimizeProfile,
  type OptimizeStyle,
} from './optimize.ts';
import {
  DEFAULT_SHARE_SERVER,
  normaliseShareServer,
  normaliseShares,
  type ShareServerConfig,
  type VaultShare,
} from '../lib/shares.ts';

/** How the vault is laid out on screen. The choice is persisted. */
export type VaultView = 'animated' | 'basic' | 'grid';

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

/**
 * Where the channel list sits vertically inside a side-docked rail.
 *
 * This is about the whole list, not individual rows: 'middle' floats the run of
 * channels in the middle of the rail and 'bottom' parks it just above the
 * footer. Ignored when the rail is docked top or bottom, where it runs
 * horizontally and the question does not apply.
 */
export type RailAlign = 'top' | 'middle' | 'bottom';

/** Per-view card geometry and colour. */
export interface CardSizePrefs {
  /** Overall scale, 0.6 to 1.6, as a multiple shown as 0.6x to 1.6x. */
  scale: number;
  /**
   * Card width in px, as a cap rather than a fixed width. Flow and List both
   * stay fluid inside it, so the value means "allowed to grow this wide".
   */
  width: number;
  /**
   * Floor on the card's height in px, for Flow and List. It is a minimum and
   * not a fixed height, because the cards carry a photo, a title, tag chips and
   * a credential block, and a hard height would clip whichever of those is
   * tallest.
   */
  minHeight: number;
  /** Height as a multiple of width; kept for stored records, ignored by views. */
  aspect: number;
  /** Card surface tint: 0 = fully transparent, 1 = fully opaque. */
  surface: number;
  /** Corner radius in px. */
  radius: number;
}

export const DEFAULT_CARD_SIZE: Record<VaultView, CardSizePrefs> = {
  // The shipped Flow card: wide, short and softly rounded. A new vault opens
  // on Flow, so this is the card most people see first.
  animated: { scale: 1.1, width: 890, minHeight: 60, aspect: 1, surface: 1, radius: 28 },
  basic: { scale: 1, width: 900, minHeight: 64, aspect: 1, surface: 1, radius: 14 },
  // Grid reflows to whatever fits, so its width is the widest a single cell may
  // get before the track count drops. That is the one number worth tuning here:
  // raising it buys larger cards at the cost of columns.
  grid: { scale: 1, width: 340, minHeight: 96, aspect: 1, surface: 1, radius: 14 },
};

/**
 * The shipped list-tab strip: the four merged sections of All logins.
 *
 * This is also the strip every channel and folder inherits until it is given
 * a configuration of its own, so tabs do not disappear just because a scope
 * has never been visited. A scope stores an empty list to hide its strip.
 */
export const DEFAULT_LIST_TABS: Record<string, string[]> = {
  all: ['tab:all', 'tab:favorites', 'tab:attention', 'tab:weak'],
};

/**
 * The tabs a scope actually shows.
 *
 * A scope with no record of its own inherits the shipped All-logins strip, so
 * channels and folders are not left without tabs just because nobody has
 * configured them yet. An explicit empty array is preserved: that is how a
 * scope says "hide the strip here".
 */
export function listTabsFor(listTabs: Record<string, string[]>, scope: string): string[] {
  return listTabs[scope] ?? DEFAULT_LIST_TABS.all ?? [];
}

/**
 * The non-channel tab ids a strip may hold.
 *
 * `unassigned` is a real tab target — it is in the rail and in the "Add tabs"
 * list — but it is synthetic, so it can never pass the `channelIds` check
 * below. Naming it here keeps a strip pointing at it from losing that tab the
 * moment any preference is saved.
 */
const LIST_TAB_IDS = new Set(['tab:all', 'tab:favorites', 'tab:attention', 'tab:weak', UNASSIGNED_CHANNEL_ID]);

/**
 * Coerces a stored per-scope tab configuration.
 *
 * A tab id is either `tab:<kind>` for one of the built-ins or a channel id, so
 * the strip can hold a jump to any channel. Entries pointing at channels that
 * no longer exist are dropped rather than left as dead buttons, and a malformed
 * record falls back to the shipped All-logins strip.
 */
export function normaliseListTabs(raw: unknown, channels: Pick<Channel, 'id'>[]): Record<string, string[]> {
  const channelIds = new Set(channels.map((channel) => channel.id));
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LIST_TABS };
  const clean: Record<string, string[]> = {};
  for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!scope || !Array.isArray(value)) continue;
    // An empty list is kept: hiding a scope's strip entirely is a user choice,
    // and dropping it here would resurrect the default on every reload.
    clean[scope] = [...new Set(
      value.filter(
        (id): id is string =>
          typeof id === 'string' && (LIST_TAB_IDS.has(id) || channelIds.has(id)),
      ),
    )];
  }
  return clean;
}

/**
 * The strip a tab jump should show on arrival.
 *
 * The strip used to be carried only into scopes that had never been
 * configured, so landing on All logins kept its shipped four tabs and dropped
 * every channel tab the jump came from. The destination is now the union of
 * the strip being used and the one already there: source order first, so the
 * row that was on screen does not reshuffle, then any destination-only tabs.
 * `via` (the clicked tab) and `back` (the channel the jump came from) are
 * appended when missing, so neither direction of the jump loses its tab.
 */
export function mergeListTabs(
  source: string[],
  destination: string[],
  via?: string,
  back?: string,
): string[] {
  const merged = source.some((id) => !destination.includes(id))
    ? [...source, ...destination.filter((id) => !source.includes(id))]
    : [...destination];
  if (via && !merged.includes(via)) merged.push(via);
  if (back && !merged.includes(back)) merged.push(back);
  return merged;
}

/**
 * Moves one tab within a strip, dropping it before or after another tab.
 *
 * Drag-and-drop reorders the visible row, so the index of the target has to be
 * read after the dragged tab is removed — otherwise moving a tab rightwards
 * lands one slot short. Ids that are not both present are left untouched.
 */
export function moveListTab(tabs: string[], from: string, to: string, after: boolean): string[] {
  if (from === to) return [...tabs];
  const fromIndex = tabs.indexOf(from);
  if (fromIndex < 0 || !tabs.includes(to)) return [...tabs];
  const next = tabs.filter((id) => id !== from);
  const target = next.indexOf(to);
  next.splice(after ? target + 1 : target, 0, from);
  return next;
}

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

/**
 * How many jump slots the dock holds. Generous on purpose — the bar scrolls
 * rather than refusing a ninth slot. Bare-key shortcuts come from 1–9 then
 * a–z, so the cap matches that pool.
 */
export const MAX_DOCK_SLOTS = 24;

/** How many quick-launch bars may exist at once. */
export const MAX_DOCKS = 4;

/**
 * One quick-launch bar: its slots, its spot, whether it shows. Several may
 * exist — a views bar at the bottom and a mail bar on the side, for example —
 * each dragged, configured and hidden independently.
 */
export interface DockState {
  id: string;
  slots: DockSlotConfig[];
  pos: DockPlacement;
  enabled: boolean;
}

export function newDockId(): string {
  return `dock_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Where a fresh bar spawns: the middle, unless a bar already sits there, in
 * which case the emptiest lane wins. Without this every new dock landed
 * exactly atop the last one and several bars read as one stuck line.
 */
export function freeDockSpot(docks: { pos: { edge: string; fx: number; fy: number } }[]): DockPlacement {
  const taken = docks.filter((dock) => dock.pos.edge === 'bottom').map((dock) => dock.pos.fx);
  const lanes = [0.5, 0.3, 0.7, 0.15, 0.85];
  const fx = lanes.find((lane) => taken.every((t) => Math.abs(t - lane) > 0.12)) ?? 0.5;
  return { edge: 'bottom', fx, fy: 0.78 };
}

export const DEFAULT_DOCK_SLOTS: DockSlotConfig[] = [
  { kind: 'view', ref: 'animated', key: '1' },
  { kind: 'view', ref: 'basic', key: '2' },
  { kind: 'view', ref: 'grid', key: '3' },
  { kind: 'inbox', ref: '', key: '4' },
];

/**
 * One connected mailbox. Either an app password (Google Account > Security,
 * never sent anywhere but the mail host) or an OAuth2 sign-in with the
 * user's own client id — both authenticate the same IMAP reading below.
 * Each account polls on its own cadence; messages merge newest-first
 * wherever they render.
 */
export interface GmailAccount {
  id: string;
  address: string;
  appPassword: string;
  /**
   * How this mailbox signs in. Absent (or 'app-password') means the stored
   * app password; 'oauth' means the record in `oauth` holds the client
   * config and tokens, and `appPassword` is empty.
   */
  auth?: MailAuthKind;
  /** OAuth2 client config and tokens. Only meaningful when auth is 'oauth'. */
  oauth?: MailOAuth;
  enabled: boolean;
  /** How often to re-poll, in seconds. 0 means manual only (no timer). */
  refreshSeconds: number;
  /**
   * Which mail host this account belongs to (see lib/mail-providers). Absent on
   * records written before any host but Google was possible; the provider is
   * then inferred from the address, so an old account keeps working untouched.
   */
  provider?: string;
  /**
   * Connection details. Only meaningful for a hand-configured server: when the
   * provider has a known host, these are left empty and filled in from the
   * preset at connect time, so a corrected preset reaches existing accounts.
   */
  host?: string;
  port?: number;
  secure?: boolean;
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
 *
 * Returns the SAME cache reference when nothing changed, so callers can skip
 * their store write: without this every poll rewrites prefs and re-renders
 * the whole app even when the mailbox said nothing new.
 */
export function mergeMailCache(
  cache: Record<string, CachedMailMessage[]>,
  accountId: string,
  incoming: CachedMailMessage[],
): Record<string, CachedMailMessage[]> {
  const existing = cache[accountId] ?? [];
  const seen = new Set<string>();
  const merged: CachedMailMessage[] = [];
  for (const message of [...incoming, ...existing]) {
    if (!message || typeof message.id !== 'string') continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  // Newest first, id as the tie-break: without a deterministic order, polls
  // returning the same messages in a different order would read as "changed"
  // every time and defeat the same-reference skip below.
  merged.sort(
    (a, b) => Date.parse(b.issued || '') - Date.parse(a.issued || '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const capped = merged.slice(0, MAIL_CACHE_CAP);
  if (capped.length === existing.length && capped.every((message, index) => message.id === existing[index]!.id)) {
    return cache;
  }
  return { ...cache, [accountId]: capped };
}

/**
 * How a view is named wherever the three views are offered as a group: the
 * topbar picker, the sidebar, and the right-click menu.
 *
 * Mirrors SidebarLabels rather than reusing it, because the two are tuned
 * independently.
 */
export type ViewLabels = 'icon' | 'name' | 'both';

/** Sort order for the list views. `manual` is the user's own drag order. */
export type SortMode = 'title' | 'recent' | 'oldest' | 'strength' | 'username' | 'manual';

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

/**
 * How many history events are kept. Bounded because every delete and every
 * edit carries a snapshot of the login, and prefs travel in backups.
 */
export const MAX_HISTORY_EVENTS = 200;

/**
 * Rough ceiling on the whole log, in serialized characters. A login with an
 * uploaded card image is megabytes on its own, so the count cap alone cannot
 * bound this: the oldest entries are evicted until the log fits again.
 */
export const MAX_HISTORY_CHARS = 400_000;

/**
 * True when two versions of a login differ in nothing a user would call a
 * change: every field matches apart from the save clocks. Used to keep a
 * re-save out of the History log.
 *
 * Media counts by digest: the data URLs are megabytes and this runs on every
 * edit of any login, so stringifying them twice per check is a stall — id,
 * type and length answer "did the media change" just as well.
 */
function sameContent(a: VaultItem, b: VaultItem): boolean {
  const strip = (item: VaultItem) => {
    const { updatedAt: _u, passwordUpdatedAt: _p, usernameUpdatedAt: _n, ...rest } = item;
    if (rest.attachments?.length) {
      rest.attachments = rest.attachments.map(
        (attachment) => ({ ...attachment, dataUrl: attachment.dataUrl.length }),
      ) as unknown as VaultAttachment[];
    }
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

/**
 * One thing that happened to one login.
 *
 * `before` is the login as it stood *prior* to the change, and exists only for
 * the actions that overwrote or removed it. `restore` writes it back; for an
 * addition there is nothing to go back to, so the row offers to remove the
 * login instead.
 */
export interface HistoryEvent {
  id: string;
  at: number;
  action: 'added' | 'edited' | 'deleted';
  itemId: string;
  /** Name as it read at the time, so the log stays readable after a rename. */
  title: string;
  username: string;
  before: VaultItem | null;
}

export function newHistoryEventId(): string {
  return `he_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;
}

/**
 * Reads the stored log back, dropping anything malformed.
 *
 * Shape-checked field by field like the rest of preferences: a truncated or
 * hand-edited record must not be able to make the History channel throw, and a
 * `before` snapshot that is not an object is exactly what a partial write looks
 * like — better no restore than a login restored from half a record.
 */
export function normaliseHistory(raw: unknown): HistoryEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEvent[] = [];
  for (const entry of raw.slice(0, MAX_HISTORY_EVENTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const action = record.action;
    if (action !== 'added' && action !== 'edited' && action !== 'deleted') continue;
    const itemId = typeof record.itemId === 'string' ? record.itemId : '';
    if (!itemId) continue;
    const before = record.before;
    out.push({
      id: typeof record.id === 'string' && record.id ? record.id : newHistoryEventId(),
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
      action,
      itemId,
      title: typeof record.title === 'string' ? record.title.slice(0, 200) : '',
      username: typeof record.username === 'string' ? record.username.slice(0, 200) : '',
      before:
        before && typeof before === 'object'
          ? normaliseItem(before as Partial<VaultItem> & { id: string }, 0)
          : null,
    });
  }
  return out;
}

/**
 * Turns "what the items were" and "what they are now" into log entries.
 *
 * Three shapes only: something that appeared is `added`, something that
 * vanished is `deleted` (carrying the login as it was, which is the only copy
 * left once the record is gone), and something whose `updatedAt` moved is
 * `edited` (carrying the version it replaced). Ordering is the after-list first,
 * so a paste of five logins reads top to bottom the way it was pasted, then the
 * deletions.
 *
 * A bulk action produces one entry per login on purpose: "delete 12 logins" is
 * twelve restorable rows, not one lump that can only come back whole.
 *
 * Lives here rather than in the UI because it is the interesting half of the
 * feature and it needs no React: the caller has the before/after lists anyway,
 * and a diff that can be called from a test is a diff that can be trusted.
 * `now` is injectable so the tests do not have to race the clock.
 */
export function historyEventsFor(
  before: readonly VaultItem[],
  after: readonly VaultItem[],
  now: number = Date.now(),
): HistoryEvent[] {
  const previous = new Map(before.map((item) => [item.id, item]));
  const events: HistoryEvent[] = [];
  const describe = (item: VaultItem) => ({
    title: item.title || item.username || 'Untitled',
    username: item.username,
  });
  /**
   * History snapshots go into prefs, and prefs live **unencrypted** on disk —
   * pasted media, however well encrypted in the item blob, must never copy
   * into it. A restore keeps the text and loses the media; the editor's note
   * says so at the point of paste, where the tradeoff is visible.
   */
  const snapshot = (item: VaultItem): VaultItem => {
    if (!item.attachments?.length && !item.tempMail) return item;
    // The disposable-inbox address and its hidden-session key are deliberately
    // left out too: history lives in preferences, which are not encrypted, and
    // a restored login can create a fresh inbox in seconds.
    const { attachments: _withoutMedia, tempMail: _withoutTempMail, ...rest } = item;
    return { ...rest, attachments: [], tempMail: null };
  };

  for (const item of after) {
    const was = previous.get(item.id);
    if (!was) {
      events.push({ id: newHistoryEventId(), at: now, action: 'added', itemId: item.id, ...describe(item), before: null });
      continue;
    }
    // A bump to `updatedAt` with nothing else different is a re-save, not a
    // change. Logging those was how the log filled with rows that described
    // nothing — open a login, save it untouched, and a row appeared. Only the
    // fields that make a login what it is are compared; the two clocks
    // (`updatedAt`, and the per-field `passwordUpdatedAt` / `usernameUpdatedAt`
    // that move with it) are what a no-op save touches.
    if (was.updatedAt !== item.updatedAt && !sameContent(was, item)) {
      events.push({ id: newHistoryEventId(), at: now, action: 'edited', itemId: item.id, ...describe(was), before: snapshot(was) });
    }
  }
  const alive = new Set(after.map((item) => item.id));
  for (const item of before) {
    if (alive.has(item.id)) continue;
    events.push({ id: newHistoryEventId(), at: now, action: 'deleted', itemId: item.id, ...describe(item), before: snapshot(item) });
  }
  return events;
}

/**
 * Prepends an event and trims the log to its count and size budgets.
 *
 * Purely functional so the caller can fold several events from one mutation
 * into one write, and so the trimming rule is testable without a vault.
 */
export function appendHistory(existing: HistoryEvent[], additions: HistoryEvent[]): HistoryEvent[] {
  if (additions.length === 0) return existing;
  let log = [...additions, ...existing].slice(0, MAX_HISTORY_EVENTS);
  let size = () => JSON.stringify(log).length;
  while (log.length > 1 && size() > MAX_HISTORY_CHARS) {
    log = log.slice(0, Math.max(1, Math.floor(log.length / 2)));
  }
  return log;
}

export interface VaultPreferences {
  theme: ThemeMode;
  accent: AccentName;

  // -- Appearance
  /** 0 = no motion, 1 = full. Honoured on top of the OS reduced-motion setting. */
  motion: number;
  /**
   * Duration multiplier for every transition: every duration divides by it, so
   * 2 is the fastest setting and 1 is the app's normal pace.
   *
   * The scale deliberately stops at 1. It used to reach 0.25 — labelled
   * "Languid" — which made every panel, menu and tab drag, and reads as a bug
   * next to the rest of the app. Nothing slower than normal is offered now, so
   * no stored value, profile or slider position can produce it.
   */
  motionSpeed: number;
  /**
   * Small transitions on the controls that never had any: buttons, chips, tabs,
   * toggles, rows and badges. On by default, because "nothing moves" is not the
   * calm the app is going for; switched off from Optimize when frames matter
   * more than feel. Larger motion (cards, panels) is `motion`.
   */
  microMotion: boolean;
  /** Mesh-gradient background intensity, 0 to 1. */
  ambient: number;
  density: Density;
  /** Corner radius scale, 0.6 to 1.4. */
  roundness: number;
  /** Shadow depth under login cards, 0 (flat) to 1 (deep). */
  cardDepth: number;

  /**
   * Named Optimize profiles: looks the user saved so they can put the app back
   * exactly the way it was later. Stored in preferences, so they travel with an
   * encrypted backup and survive a reinstall.
   */
  optimizeProfiles: OptimizeProfile[];
  /**
   * The look that was in place before the first savings profile was applied.
   * "Restore my look" restores this — background picture included — rather than
   * guessing at the shipped defaults and losing whatever was there.
   */
  optimizeSnapshot: OptimizeStyle | null;
  /**
   * Name of the saved profile applied last, for the tick beside it. Empty when
   * the current look came from a one-click preset or from the sliders.
   */
  activeOptimizeProfile: string;
  /**
   * Turns the desktop shell's spellchecker off. Electron loads a hunspell
   * dictionary per language at startup whether or not a field ever needs it;
   * this is the one Optimize switch that removes real megabytes.
   */
  disableSpellcheck: boolean;
  /**
   * Per-view card sizing and colour, so each of the three views can be tuned
   * independently. Flow, List and Grid have genuinely different geometry:
   * a list row's width sets the measure of the text, a grid cell's width
   * sets how many fit per row.
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
  /** Where the channel list sits vertically in a side-docked rail. */
  railAlign: RailAlign;
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
  /** Shows note previews and attachment counts on login cards. */
  showNotes: boolean;
  /**
   * A plain click on a login copies its password. Off makes copying deliberate:
   * the copy buttons and menu still work, and double-click still opens the editor.
   */
  clickToCopy: boolean;
  /** Pins favorites to a section above everything else. */
  pinFavorites: boolean;
  /**
   * Retired. It used to make a single click open the login editor, which put
   * the whole edit form over the list on one click — the gesture the app uses
   * for "edit" is a double-click. Kept in the record so an existing vault's
   * value round-trips instead of being dropped, and nothing reads it.
   */
  expandOnOpen: boolean;
  /** Collapses the sidebar to icons only. */
  compactSidebar: boolean;
  /** Shows the keyboard shortcuts entry in the sidebar. Also in Settings › About. */
  showShortcuts: boolean;
  /**
   * Quick-launch bars, in no particular order — each carries its own slots,
   * spot and visibility.
   *
   * Each slot jumps somewhere (a view, a channel, the inbox) on click or on
   * its key. Keys are single characters pressed bare (no modifier), matched
   * only when no text field, menu, dialog or editor is open. Bare keys are
   * what makes it fast; the guard list is what keeps it from eating
   * keystrokes. The key lives on the slot (not in a parallel array) so the
   * dock, the badges, the listener and the settings rows cannot disagree
   * about which key means what.
   */
  docks: DockState[];
  usage: Record<string, { count: number; at: number }>;
  /** The tab strips, per scope. See 'listTabs *' helpers near DEFAULT_LIST_TABS. */
  listTabs: Record<string, string[]>;
  /**
   * Which in-app toast notifications appear. 'all' is the shipped behaviour,
   * 'errors' keeps only the failure toasts (and the confirmations that matter:
   * anything sent with the 'error' tone), 'off' silences the lot.
   */
  notifications: 'all' | 'errors' | 'off';
  /** Desktop shell settings. Read by Electron; inert on web, where there is no
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
   * Stamp for the one-time tidy that files every non-Dashboard/Mail channel
   * into a single "Channels" folder. A stamp rather than a rule: running it on
   * every load would undo the user's own rearranging of the rail.
   */
  sidebarGrouped?: boolean;
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
  /** Shows the New login button in the topbar. Right-click it to hide. */
  showNewLoginButton: boolean;
  /** Shows the Bulk add button in the topbar. Right-click it to hide. */
  showBulkAddButton: boolean;
  /** Shows the Settings button in the sidebar footer. Right-click it to hide. */
  showSettingsButton: boolean;
  /** Shows the Hide-sidebar button in the sidebar footer. Right-click it to hide. */
  showHideSidebarButton: boolean;
  /**
   * Folder ids hidden from the sidebar. Like hiddenChannels: the folder keeps
   * everything, it just takes up no rail space. Shown again from Settings.
   */
  hiddenFolders: string[];
  /**
   * Card button ids hidden by right-click (copy, edit, reveal, …), anywhere
   * they render. Shown again from Settings › Hidden.
   */
  hiddenButtons: string[];
  /**
   * The user's own login order, as ids. Dragging a login in the List or Grid
   * view writes here and switches sorting to `manual`. Ids never seen stay at
   * the end in title order, so new logins need no bookkeeping.
   */
  manualOrder: string[];
  /**
   * Per-channel and per-folder drag orders, keyed by the sidebar id (`all`,
   * `ch_…`, or `folder:fd_…`). The global list above is the fallback and the
   * order `All logins` uses, so an existing vault keeps its arrangement; a
   * channel the user has never dragged follows it too, and the first drop in
   * that channel seeds its own list from what is on screen.
   *
   * Stored separately because one global order made arranging a folder's
   * logins rearrange every other view: the same ids appeared in a different
   * place the moment you came back. This is what "put it back how I left it"
   * means when each channel is a different workspace.
   */
  manualOrderByScope: Record<string, string[]>;
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
  /** Shows the first letters of email addresses only, on cards and messages. */
  maskEmails: boolean;

  // -- Gmail integration: several accounts, each independent. The old single
  // `gmail` object migrates into the first entry on load, so a connected
  // mailbox survives the upgrade without reconnecting.
  gmailAccounts: GmailAccount[];
  /**
   * Addresses the user wants to reuse for throwaway signups. The editor can
   * pick one at random; they are just addresses, never credentials.
   */
  reusableEmails: string[];
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
  /**
   * Whether opening an HTML message also fetches its inline images.
   *
   * On by default because most mail is fine as it is; switched off in
   * Optimize → Messages it is the largest per-message saving available —
   * the reader skips up to four images of 512 KB each, which is a couple of
   * megabytes of base64 that would otherwise sit in memory for the rest of
   * the session. The message still opens: the images are simply not asked
   * for, and cid: references render as the same labelled placeholder the
   * app already uses for remote images.
   */
  mailInlineImages: boolean;
  /**
   * How many inbox headers one list request asks for.
   *
   * A page is one IMAP round trip either way, so this is purely about how
   * much arrives per click: 100 is one trip for a long list, 25 keeps each
   * answer — and the row state built from it — small.
   */
  mailPageSize: number;
  /**
   * Whether the one-time Messages scoping has run: logins that had the
   * expander on by old default (rather than by choice) and are not related
   * to any connected mailbox get switched off, so a mailbox connected for
   * one login stops putting a Messages button on every other login.
   *
   * Superseded by {@link mailEveryLogin}. Kept so an existing vault's flag is
   * still round-tripped rather than dropped from the record.
   */
  mailOptInMigrated: boolean;
  /**
   * Superseded by {@link mailLinkedOnly}: this stamped the pass that switched
   * the Messages button on for every login, which is the rule the app no longer
   * follows. Kept so an existing vault's flag round-trips instead of being
   * dropped, and nothing acts on it.
   */
  mailEveryLogin: boolean;
  /**
   * Whether the one-time linked-only pass has run: the Messages button is
   * switched off for every login that is not linked to a connected mailbox
   * (see planMailLinkedOnly). Stamped once, so a login switched back on by
   * hand keeps its button.
   */
  mailLinkedOnly: boolean;
  /**
   * Whether the shipped look defaults (instant animation, full motion, high
   * contrast, transparency and floating chrome) have been written into an
   * existing vault once. See {@link LOOK_PRESET}.
   */
  lookPresetMigrated: boolean;

  // -- Sharing
  /**
   * Share codes, rules, connected devices and access logs. Only the hash of a
   * code is stored, and only the ids of the source logins are held here; the
   * selected credentials are sealed with the logins themselves.
   */
  shares: VaultShare[];
  /** Local share server settings. Off until the user enables it. */
  shareServer: ShareServerConfig;
  /**
   * `shareId|sourceItemId` keys the recipient deliberately removed. Sync uses
   * these so a deleted linked copy is not silently resurrected.
   */
  shareDismissals: string[];
  /** Minutes between automatic linked-copy syncs. 0 means manual only. */
  shareSyncMinutes: number;
  /** Show a toast when a new device is waiting for approval. */
  shareNotifyApproval: boolean;

  // -- History
  /**
   * What changed in the vault, newest first — the History channel's data.
   *
   * A log rather than a diff engine: every mutation records what it did and, for
   * a change that destroyed something (a delete, an edit), the login as it was.
   * That snapshot is what makes "Restore" possible at all, since a deleted
   * record is gone from storage and an edited one has already been overwritten.
   * It lives in preferences, which are sealed with the vault, so a snapshot of a
   * password is exactly as protected as the password itself.
   */
  history: HistoryEvent[];

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
  /**
   * Warns when a login about to be copied shares its password elsewhere. The
   * warning is a tappable notification, not a modal: it says its piece for a
   * few seconds and then gets out of the way.
   */
  warnOnReuse: boolean;
  /**
   * Files a login whose password is reused under a "Reused password" tag, so
   * the group is visible in the sidebar and can be worked through in one place
   * instead of being rediscovered from the health panel.
   */
  autoTagReused: boolean;
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

/**
 * The shipped look and behavior of a brand-new vault.
 *
 * The appearance half of this record is the program's default theme: compact
 * spacing, soft high-roundness surfaces, deep card shadows, wide short Flow
 * cards, calm (no micro) motion, a vertically centred rail, a flat list without
 * letter headings and a divider-free settings window. It deliberately carries no channels, folders, tags, sidebar
 * rows, docks, hidden buttons or saved looks — those describe one person's
 * vault, not the program's style.
 */
export const DEFAULT_PREFERENCES: VaultPreferences = {
  theme: 'system',
  accent: 'slate',
  motion: 1,
  // 2 is the top of the slider and reads "Instant": every transition divides
  // by this, so 2 makes --fast/--normal/--slow half as long. The app shipped
  // at 1 ("Normal") and, at this user's request, moves at full speed by
  // default — a languid default is the thing they complained about.
  motionSpeed: 2,
  // Off: the shipped look is calm, so controls change state without a small
  // transition of their own. The larger entrance animations still run.
  microMotion: false,
  ambient: 1,
  density: 'compact',
  roundness: 1.4,
  cardDepth: 1,
  optimizeProfiles: [],
  optimizeSnapshot: null,
  activeOptimizeProfile: '',
  disableSpellcheck: false,
  cardSize: DEFAULT_CARD_SIZE,
  sidebarLabels: 'both',
  viewLabels: 'both',
  viewLabelsByView: {},
  sidebarPosition: 'left',
  railAlign: 'middle',
  textScale: 100,
  reduceTransparency: false,
  highContrast: true,
  backgroundImage: '',
  backgroundOpacity: 0.35,
  backgroundBlur: 0,
  backgroundDim: 0.25,
  view: 'animated',
  sort: 'title',
  showUrls: true,
  showNotes: true,
  clickToCopy: true,
  pinFavorites: true,
  expandOnOpen: false,
  compactSidebar: false,
  showShortcuts: false,
  docks: [
    {
      id: 'main',
      slots: DEFAULT_DOCK_SLOTS.map((slot) => ({ ...slot })),
      pos: { edge: 'bottom', fx: 0.5, fy: 0.94 },
      enabled: true,
    },
  ],
  usage: {},
  listTabs: DEFAULT_LIST_TABS,
  notifications: 'all',
  trayEnabled: true,
  closeToTray: true,
  launchAtLogin: false,
  soundsMuted: false,
  floatingChrome: true,
  showLockButton: true,
  autoTagChannel: false,
  showTagChips: true,
  hideDividers: true,
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
  hiddenFolders: [],
  hiddenButtons: [],
  manualOrder: [],
  manualOrderByScope: {},
  showNewChannelButton: true,
  showCompactButton: true,
  showNewLoginButton: true,
  showBulkAddButton: true,
  showSettingsButton: true,
  showHideSidebarButton: true,
  showSidebar: true,
  autoTagDomain: true,
  showLetterGroups: false,
  clipboardCapture: false,
  clipboardAutoSave: false,
  maskEmails: true,
  shares: [],
  shareServer: DEFAULT_SHARE_SERVER,
  shareDismissals: [],
  shareSyncMinutes: 5,
  shareNotifyApproval: true,
  alarms: [],
  vaultSecurity: EMPTY_SECURITY,
  autoLockMinutes: 5,
  clearClipboardSeconds: 30,
  clearClipboardOnLock: true,
  revealPasswords: false,
  showHealthBadges: true,
  warnOnReuse: true,
  autoTagReused: true,
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
  reusableEmails: [],
  mailCache: {},
  mailInlineImages: true,
  mailPageSize: 50,
  mailOptInMigrated: false,
  mailEveryLogin: false,
  /**
   * Whether the one-time "messages follow the linked mailbox" pass has run.
   *
   * {@link mailEveryLogin} put a Messages button under *every* login; the user
   * asked for the opposite — the button belongs to the login that is linked to
   * a connected mailbox, and nowhere else. The pass switches the flag off for
   * the logins that are not linked, once, and stamps this so a login switched
   * back on by hand stays on.
   */
  mailLinkedOnly: false,
  /**
   * Whether the shipped motion/look defaults have been applied once to an
   * existing vault. New vaults start at these values anyway; a vault stored
   * before them would otherwise never see the change, because stored
   * preferences always win over defaults.
   */
  lookPresetMigrated: false,
  history: [],
};

/**
 * One bar's placement as clamped fractions. Anything outside 0–1 (a
 * hand-edited record, a resize across monitors) is pulled back on screen
 * rather than stranding the bar where no pointer can reach it.
 */
export function normaliseDockPos(raw: unknown): DockPlacement {
  const record = (raw ?? {}) as Partial<DockPlacement>;
  const edge = record.edge === 'top' || record.edge === 'left' || record.edge === 'right' ? record.edge : 'bottom';
  const clamp = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(0.94, Math.max(0.06, value)) : fallback;
  return { edge, fx: clamp(record.fx, 0.5), fy: clamp(record.fy, edge === 'top' ? 0.06 : 0.94) };
}

/**
 * One bar's slots: at most MAX_DOCK_SLOTS, each with a valid kind, a valid
 * view ref, a unique single-character key, a short label and a safe icon.
 * Anything else falls back slot by slot, so a hand-edited or partially-written
 * record cannot leave a slot unreachable, two slots fighting over one key, or
 * a javascript: URL smuggled in as an icon. Empty in, defaults out.
 */
export function normaliseDockSlots(raw: unknown): DockSlotConfig[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  // Single-character jump keys: digits first, then letters.
  const fallbackKeys = [...'123456789abcdefghijklmnopqrstuvwxyz'].slice(0, MAX_DOCK_SLOTS);
  const clean: DockSlotConfig[] = [];
  for (const entry of list.slice(0, MAX_DOCK_SLOTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = (entry as { kind?: unknown }).kind;
    if (kind !== 'view' && kind !== 'channel' && kind !== 'folder' && kind !== 'login' && kind !== 'inbox' && kind !== 'mailbox') continue;
    const ref = typeof (entry as { ref?: unknown }).ref === 'string' ? (entry as { ref: string }).ref : '';
    if (kind === 'view' && !(['animated', 'basic', 'grid'] as const).includes(ref as VaultView)) continue;
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
  return clean.length > 0 ? clean : DEFAULT_DOCK_SLOTS.map((slot) => ({ ...slot }));
}

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
        // Favorites, Needs attention and Weak or reused are tabs of All logins
        // now, so a stored hide entry for one of them would show in Settings ›
        // Hidden as a row that hides nothing and cannot be restored.
        .filter((id) => !isRetiredChannelId(id))
    : [];
  merged.hiddenFolders = Array.isArray(merged.hiddenFolders)
    ? [...new Set(merged.hiddenFolders.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  merged.hiddenButtons = Array.isArray(merged.hiddenButtons)
    ? [...new Set(merged.hiddenButtons.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        // The labelled Copy button was removed from the cards because it only
        // appeared on some of them. A stored hide entry for it would otherwise
        // sit in Settings › Hidden as a row that hides nothing.
        .filter((id) => id !== 'card-copy')
    : [];
  merged.shares = normaliseShares(merged.shares);
  merged.shareServer = normaliseShareServer(merged.shareServer);
  merged.shareDismissals = Array.isArray(merged.shareDismissals)
    ? [...new Set(merged.shareDismissals.filter((key): key is string => typeof key === 'string'))].slice(-5000)
    : [];
  merged.shareSyncMinutes =
    typeof merged.shareSyncMinutes === 'number' && Number.isFinite(merged.shareSyncMinutes)
      ? Math.max(0, Math.min(1440, Math.round(merged.shareSyncMinutes)))
      : 5;
  merged.shareNotifyApproval = merged.shareNotifyApproval !== false;
  merged.manualOrder = Array.isArray(merged.manualOrder)
    ? [...new Set(merged.manualOrder.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  // Per-scope orders: same validation, one list at a time. A malformed entry
  // is dropped rather than repaired into an empty list, so the fallback (the
  // global order) applies instead of a scope silently losing its arrangement.
  {
    const raw = (merged.manualOrderByScope ?? {}) as Record<string, unknown>;
    const clean: Record<string, string[]> = {};
    for (const [scope, list] of Object.entries(raw)) {
      if (!scope || !Array.isArray(list)) continue;
      const ids = [...new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0))];
      if (ids.length > 0) clean[scope] = ids;
    }
    merged.manualOrderByScope = clean;
  }
  merged.showNewChannelButton = Boolean(merged.showNewChannelButton);
  merged.showCompactButton = Boolean(merged.showCompactButton);
  // Visibility switches default to shown: a missing key must never hide a
  // button out from under the user. The same rule keeps notes previews and the
  // single-click copy fast path for every vault written before the switches.
  merged.showNotes = merged.showNotes !== false;
  merged.clickToCopy = merged.clickToCopy !== false;
  merged.showNewLoginButton = merged.showNewLoginButton !== false;
  merged.showBulkAddButton = merged.showBulkAddButton !== false;
  merged.showSettingsButton = merged.showSettingsButton !== false;
  merged.showHideSidebarButton = merged.showHideSidebarButton !== false;
  merged.showSidebar = merged.showSidebar !== false;
  merged.sidebarGrouped = merged.sidebarGrouped === true;
  merged.autoTagDomain = Boolean(merged.autoTagDomain);
  // Opt-out, like the other helpful defaults: only a real `false` turns it off.
  merged.autoTagReused = merged.autoTagReused !== false;
  merged.showLetterGroups =
    typeof merged.showLetterGroups === 'boolean'
      ? merged.showLetterGroups
      : DEFAULT_PREFERENCES.showLetterGroups;
  merged.clipboardCapture = Boolean(merged.clipboardCapture);
  merged.clipboardAutoSave = Boolean(merged.clipboardAutoSave);
  merged.maskEmails = merged.maskEmails !== false;
  merged.mailOptInMigrated = Boolean(merged.mailOptInMigrated);
  merged.mailEveryLogin = Boolean(merged.mailEveryLogin);
  // Stamps, not switches: only a real `true` counts as "this pass has already
  // run". A hand-edited or half-written truthy value must not stand in for a
  // completed pass, or the repair it guards would never happen.
  merged.mailLinkedOnly = merged.mailLinkedOnly === true;
  merged.lookPresetMigrated = merged.lookPresetMigrated === true;
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
      // Which host this mailbox lives on. Accounts written before other
      // providers existed carry no field at all, so the address decides — that
      // is what upgrades a stored Yahoo or Outlook address from "Gmail" (where
      // it could never connect) to its real server without a single new
      // question. A hand-typed host is never overridden by the preset.
      const rawHost = typeof record.host === 'string' ? record.host.trim().slice(0, 120) : '';
      const provider =
        typeof record.provider === 'string' && record.provider
          ? record.provider
          : (providerForAddress(address)?.id ?? MAIL_PROVIDERS[0]!.id);
      const rawPort = record.port;
      const preset = providerById(provider);
      // Sign-in kind. A usable oauth *config* (client id + both URLs) is
      // enough to keep the account on the OAuth path — tokens may not exist
      // yet, because the mailbox is saved before the browser flow finishes,
      // so a sign-in that failed still leaves a Reconnect-able account
      // instead of degrading to a password field the user never filled.
      // Only a record whose config cannot drive a sign-in at all falls back
      // to the old path rather than locking the mailbox out entirely.
      const oauth = normaliseMailOAuth(record.oauth);
      const auth: MailAuthKind = oauth ? 'oauth' : 'app-password';
      clean.push({
        id: typeof record.id === 'string' && record.id ? record.id : newGmailAccountId(),
        address,
        // An OAuth mailbox never carries a password; a password mailbox never
        // carries tokens. The two credentials are alternatives, not layers.
        appPassword: auth === 'oauth' ? '' : appPassword,
        auth,
        ...(oauth ? { oauth } : {}),
        enabled: record.enabled !== false,
        refreshSeconds: cadence,
        provider,
        host: rawHost,
        port:
          typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
            ? Math.round(rawPort)
            : preset.port,
        secure: typeof record.secure === 'boolean' ? record.secure : preset.secure,
      });
    }
    merged.gmailAccounts = clean;
    delete legacy.gmail;
  }
  merged.reusableEmails = normaliseReusableEmails(merged.reusableEmails);
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
  // Mail loading costs, per Optimize → Messages. Absent reads as on (the
  // shipped behaviour); only an explicit false skips the images. The page
  // size is one of the three offered values, never a hostile number.
  merged.mailInlineImages = merged.mailInlineImages !== false;
  merged.mailPageSize = [25, 50, 100].includes(merged.mailPageSize)
    ? merged.mailPageSize
    : DEFAULT_PREFERENCES.mailPageSize;
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
  // Orbit is gone: a vault saved on it lands back on Flow.
  merged.view = oneOf(merged.view, ['animated', 'basic', 'grid'] as const, DEFAULT_PREFERENCES.view);
  merged.notifications = oneOf(
    merged.notifications,
    ['all', 'errors', 'off'] as const,
    DEFAULT_PREFERENCES.notifications,
  );
  merged.listTabs = normaliseListTabs(merged.listTabs, merged.channels);
  merged.sort = oneOf(
    merged.sort,
    ['title', 'recent', 'oldest', 'strength', 'username', 'manual'] as const,
    DEFAULT_PREFERENCES.sort,
  );
  merged.density = oneOf(merged.density, ['compact', 'comfortable', 'spacious'] as const, DEFAULT_PREFERENCES.density);

  merged.motion = clampRange(merged.motion, 0, 1, DEFAULT_PREFERENCES.motion);
  // Floor of 1, not 0.25: the sub-normal end of this scale was the "Languid"
  // setting, and a vault stored with it would otherwise keep dragging for good.
  merged.motionSpeed = clampRange(merged.motionSpeed, 1, 2, DEFAULT_PREFERENCES.motionSpeed);
  // Only a real boolean counts; a record with no field (or a hostile value)
  // takes the shipped look, which keeps micro-animations off.
  merged.microMotion =
    typeof merged.microMotion === 'boolean' ? merged.microMotion : DEFAULT_PREFERENCES.microMotion;
  merged.history = normaliseHistory(merged.history);

  // Flow card width used to be one global percentage of the content column,
  // which contradicted the per-view px cap and left two live controls fighting
  // over the same box. Dropped outright rather than migrated: it never meant
  // anything the per-view width does not already say, so folding it in would
  // just bake an arbitrary number into a card the user never sized.
  delete (merged as Partial<Record<'flowCardSize', unknown>>).flowCardSize;

  // Orbit was removed in 1.0.62. Its view preference and the dock-repair
  // bookkeeping that came back with it are stale keys now; deleting them here
  // is what stops a restored theme backup from re-importing them forever.
  delete (merged as Partial<Record<'showOrbitLabels' | 'orbitDockRestored', unknown>>).showOrbitLabels;
  delete (merged as Partial<Record<'showOrbitLabels' | 'orbitDockRestored', unknown>>).orbitDockRestored;
  // A stored carousel card-size entry is dead weight without the view.
  delete (merged.cardSize as Partial<Record<'carousel', unknown>> | undefined)?.carousel;

  // Per-view card geometry. Each field is clamped individually rather than
  // taking the stored object wholesale, so a partially-written or hand-edited
  // record cannot leave a view with a zero width or a NaN radius.
  const views: VaultView[] = ['animated', 'basic', 'grid'];
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
  merged.railAlign = oneOf(
    merged.railAlign,
    ['top', 'middle', 'bottom'] as const,
    DEFAULT_PREFERENCES.railAlign,
  );

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
  merged.trayEnabled = Boolean(merged.trayEnabled);
  merged.closeToTray = Boolean(merged.closeToTray);
  merged.launchAtLogin = Boolean(merged.launchAtLogin);
  merged.soundsMuted = Boolean(merged.soundsMuted);
  // Quick-launch bars. Stored docks win; otherwise the pre-multi-dock single
  // bar migrates into the first dock, so nothing is lost in the upgrade. At
  // least one dock always survives: an empty list restores the default bar.
  {
    const legacy = merged as Partial<VaultPreferences> & {
      dockEnabled?: unknown;
      dockSlots?: unknown;
      dockPos?: unknown;
    };
    // Stored docks win — but only when the stored record actually carried
    // them. Reading `merged` here would see the defaults backfilled over a
    // legacy record and skip its migration every time.
    const storedDocks = Array.isArray((stored as Partial<VaultPreferences> | undefined | null)?.docks)
      ? ((stored as Partial<VaultPreferences>)!.docks as DockState[])
      : [];
    const clean: DockState[] = [];
    for (const entry of storedDocks.slice(0, MAX_DOCKS)) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as unknown as Record<string, unknown>;
      const id = typeof record.id === 'string' && record.id ? record.id : newDockId();
      const slots = normaliseDockSlots(record.slots);
      if (slots.length === 0) continue;
      clean.push({
        id,
        slots,
        pos: normaliseDockPos(record.pos),
        enabled: record.enabled !== false,
      });
    }
    if (clean.length === 0) {
      clean.push({
        id: 'main',
        slots: normaliseDockSlots(legacy.dockSlots),
        pos: normaliseDockPos(legacy.dockPos),
        enabled: legacy.dockEnabled !== false,
      });
    }
    merged.docks = clean;
    delete legacy.dockEnabled;
    delete legacy.dockSlots;
    delete legacy.dockPos;
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
  // Saved looks. Oldest-first ids are irrelevant; names are deduplicated inside
  // the normaliser, and a style that cannot be read is dropped there too, so a
  // truncated record can never restore a mystery look.
  merged.disableSpellcheck = Boolean(merged.disableSpellcheck);
  merged.optimizeProfiles = normaliseOptimizeProfiles(merged.optimizeProfiles);
  merged.optimizeSnapshot = readStyle(merged.optimizeSnapshot);
  merged.activeOptimizeProfile =
    typeof merged.activeOptimizeProfile === 'string' &&
    merged.optimizeProfiles.some((profile) => profile.name === merged.activeOptimizeProfile)
      ? merged.activeOptimizeProfile
      : '';
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