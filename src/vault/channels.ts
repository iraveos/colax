/**
 * Sidebar channels and the tag catalogue.
 *
 * A channel is a saved view over the vault. Four ship built in (all logins,
 * dashboard, mail, history); the rest are user defined.
 *
 * Favorites, Needs attention and Weak or reused used to be rows of their own
 * beside All logins. They are now *sections* of it — the tab strip inside the
 * main channel — because they were never really separate places: they were
 * subsets of the same list, and three near-identical rows made the rail longer
 * without adding a decision. The kinds stay valid, so a channel somebody makes
 * with `kind: 'favorites'` still works exactly as it did; only the shipped rows
 * went away (see ALL_LOGIN_TABS and normaliseChannels).
 *
 * Every channel is fully editable — name, icon, colour, accent theme, background
 * image and tags — including the built-ins. The only invariant is that the `all`
 * channel exists, because it is the fallback view when preferences are empty.
 * Tags narrow *any* channel rather than being a channel kind of their own, so a
 * channel can be "favorites that are also tagged work".
 */

import { findReusedPasswords, type VaultItem } from './types.ts';
import { estimateStrength } from '../crypto/passwords.ts';
import { EMPTY_SECURITY, normaliseSecurity, type LoginSecurity } from '../crypto/security.ts';

/** Mirrors AccentName in storage.ts, redeclared here to avoid an import cycle. */
export type ChannelAccent = 'slate' | 'sage' | 'dusk' | 'clay';

export const CHANNEL_ACCENTS: ChannelAccent[] = ['slate', 'sage', 'dusk', 'clay'];

export type ChannelKind =
  | 'all'
  | 'favorites'
  | 'attention'
  | 'tags'
  | 'weak'
  | 'dashboard'
  | 'mail'
  | 'unassigned'
  /** The change log: what was added, edited or deleted, with restore. */
  | 'history';

/**
 * Human names for the built-in channel kinds.
 *
 * Two places (the dashboard rows and the channel manager) rendered
 * `channel.kind` verbatim for untagged built-ins, so users saw lowercase
 * identifiers — "favorites", "attention", "weak" — where every other label in
 * the app is a proper name. A channel with tags shows its tag names instead,
 * so this only covers the untagged case.
 */
export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  all: 'Everything',
  favorites: 'Favorites',
  attention: 'Needs attention',
  tags: 'Tagged',
  weak: 'Weak or reused',
  dashboard: 'Dashboard',
  mail: 'Mail',
  unassigned: 'Unassigned',
  history: 'History',
};

/**
 * Kinds that render a purpose-built screen instead of the login list.
 *
 * These three are ordinary scrolling pages, which is why the shell must not
 * freeze their overflow the way it does for the Flow list view.
 */
export const CHANNEL_SCREEN_KINDS: ChannelKind[] = ['dashboard', 'mail', 'history'];

/** A tab inside the merged All logins channel. */
export type AllLoginTab = 'all' | 'favorites' | 'attention' | 'weak';

/**
 * The sections of the single "All logins" channel, in tab order.
 *
 * These four kinds used to be four sidebar rows. They are the same list with a
 * different filter, which is what a tab strip is for, so they became one row
 * with four tabs: the rail states where you are once instead of four times, and
 * the main channel is where the vault's own summary of itself lives.
 */
export const ALL_LOGIN_TABS: { kind: AllLoginTab; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'favorites', label: 'Favorites' },
  { kind: 'attention', label: 'Needs attention' },
  { kind: 'weak', label: 'Weak or reused' },
];

const ALL_LOGIN_TAB_KINDS = new Set<string>(ALL_LOGIN_TABS.map((tab) => tab.kind));

/** Whether a kind is one of the merged sections rather than a screen of its own. */
export function isAllLoginTab(kind: ChannelKind): kind is AllLoginTab {
  return ALL_LOGIN_TAB_KINDS.has(kind);
}

/**
 * The shipped rows the tab strip replaced.
 *
 * Their stored channels are dropped on load rather than left beside the tabs.
 * Only the shipped ids are listed: an id is only ever `all`/`favorites`/
 * `attention`/`weak` for a preset, since everything a user makes is `ch_…`.
 */
const RETIRED_CHANNEL_IDS = new Set(['favorites', 'attention', 'weak']);

/**
 * The synthetic "no tags" channel.
 *
 * It is built on the fly rather than stored, so anything that validates ids
 * against `channels` has to name it explicitly — the tab strip, for instance,
 * can point a tab at it even though it never appears in the channel list.
 */
export const UNASSIGNED_CHANNEL_ID = 'unassigned';

/**
 * Ids the app owns and must never store as channels.
 *
 * `unassigned` is a pseudo-channel built on the fly for logins with no tags at
 * all. The retired per-row placement menu used to save it like any other row,
 * which wrote a real copy into `channels` AND left the pseudo row in the tree —
 * so the rail drew Unassigned twice and never recovered. Dropping the stored
 * copy heals those vaults; `normaliseSidebar` then drops the orphaned tree
 * entry.
 */
const RESERVED_CHANNEL_IDS = new Set([UNASSIGNED_CHANNEL_ID]);

/**
 * Whether an id belonged to one of the rows the tab strip replaced.
 *
 * Used to sweep the retired ids out of stored lists that still refer to them —
 * `hiddenChannels`, for instance — so nothing renders a row for a channel that
 * cannot be opened.
 */
export function isRetiredChannelId(id: string): boolean {
  return RETIRED_CHANNEL_IDS.has(id);
}

/**
 * Where one of the merged sections lives for this vault.
 *
 * A channel the user made with one of those kinds is a real channel and wins:
 * their own "Favorites" row keeps working. Otherwise the section is the tab of
 * All logins that stands in for it. Every caller that used to jump to one of the
 * retired ids — the dashboard tiles, the background menu — goes through this, so
 * none of them can point at a channel that no longer exists.
 */
export function sectionTarget(
  channels: readonly Pick<Channel, 'id' | 'kind'>[],
  tab: AllLoginTab,
): { channelId: string; tab?: AllLoginTab } {
  const own = channels.find((channel) => channel.kind === tab);
  if (own && own.id !== 'all') return { channelId: own.id };
  const main = channels.find((channel) => channel.kind === 'all') ?? channels[0];
  return { channelId: main?.id ?? 'all', tab };
}

export interface Channel {
  id: string;
  name: string;
  /** The base filter. 'tags' behaves like 'all'; use tagIds to narrow it. */
  kind: ChannelKind;
  /** Tag ids that narrow this channel. Empty means "no tag filter". */
  tagIds: string[];
  /** Icon key, resolved in the UI. */
  icon: string;
  /** Hue in degrees for the channel's dot and highlight. */
  hue: number;
  /** Accent theme applied while this channel is selected. */
  accent: ChannelAccent;
  /** https URL or uploaded data URL. */
  backgroundImage: string;
  /**
   * How the picture behaves. These are the channel's *own* values rather than
   * the global ones on purpose: a channel whose photo is stretched across the
   * whole app wants a different strength from one painting a band behind its own
   * rail row. Anything left at the shipped defaults follows the same look as
   * before, so an existing channel keeps the appearance it had.
   */
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundDim: number;
  /** One of the four shipped channels. */
  builtin: boolean;
  /** Cannot be deleted or reordered away — there must always be one view. */
  locked: boolean;
  /**
   * Whether logins show their message expander while this channel is active.
   * Hiding keeps a work channel free of personal mail without disconnecting
   * anything.
   */
  showMail: boolean;
  /**
   * Which account's mail the expander reads: 'all' or an account id. A stored
   * id that no longer exists behaves as 'all' rather than showing nothing.
   */
  mailAccount: string;
  /**
   * Optional second factor required to browse this channel, exactly like a
   * folder's. Empty on every shipped channel and on anything stored before the
   * field existed, so nothing gains a gate it did not ask for.
   */
  security: LoginSecurity;
}

export interface Tag {
  id: string;
  name: string;
  /** Hue in degrees, drives the chip colour. */
  hue: number;
}

/** A folder: a named, themed, expandable group of channels with optional its own lock. */
export interface Folder {
  id: string;
  name: string;
  /** Icon key, resolved in the UI. */
  icon: string;
  hue: number;
  accent: ChannelAccent;
  backgroundImage: string;
  /** The folder's own strength/blur/veil for that picture. See Channel. */
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundDim: number;
  /** Whether the user has collapsed it in the sidebar. */
  collapsed: boolean;
  /**
   * Main tags: applied to every channel in the folder, and inherited by any
   * login created while the folder is open. A channel's own tags narrow this
   * set further rather than replacing it.
   */
  tagIds: string[];
  /**
   * Alternate tags: apply only to child channels that have no tags of their
   * own. They are the folder's fallback filing, so an untagged channel still
   * belongs to the folder's subject instead of showing the whole vault.
   */
  altTagIds: string[];
  /** Free-form notes, shown from the folder's notes button in the workspace. */
  notes: string;
  /** Right-clicking the notes button hides it; this remembers that choice. */
  notesHidden: boolean;
  /** Optional second factor required to browse the channels inside. */
  security: LoginSecurity;
}

/** One row in the sidebar: a channel, a separator rule, or a folder. */
export type SidebarEntry =
  | { kind: 'channel'; id: string }
  | { kind: 'separator'; id: string }
  | { kind: 'folder'; id: string; children: SidebarEntry[] };

export function newFolderId(): string {
  return `fd_${crypto.randomUUID().slice(0, 8)}`;
}

export function createFolder(name: string, patch: Partial<Folder> = {}): Folder {
  return {
    id: newFolderId(),
    name: name.trim() || 'Folder',
    icon: 'layers',
    hue: Math.round(Math.random() * 359),
    accent: 'slate',
    backgroundImage: '',
    backgroundOpacity: DEFAULT_BACKGROUND_LOOK.opacity,
    backgroundBlur: DEFAULT_BACKGROUND_LOOK.blur,
    backgroundDim: DEFAULT_BACKGROUND_LOOK.dim,
    collapsed: false,
    tagIds: [],
    altTagIds: [],
    notes: '',
    notesHidden: false,
    security: EMPTY_SECURITY,
    ...patch,
  };
}

/**
 * How a channel's tags narrow its list once its parent folder is accounted for.
 *
 * `required` is the folder's main set: those tags apply to *every* channel in
 * the folder, so a login must carry all of them to be in the folder at all.
 *
 * `anyOf` is the narrowing set, and it is what makes a channel more specific
 * than its folder: a login needs at least one of these, and an empty list means
 * "no narrowing". Critically, it holds only the tags the channel adds *beyond*
 * the folder's main set — the main tags are already required, so treating them
 * as narrowing too would let them satisfy the test on their own.
 *
 * Splitting the two is the whole point, and the subtraction is why. Reading
 * every tag as one OR'd bag (the original behaviour) meant a folder's main tag
 * alone satisfied every channel in it: an "Albion" folder with an EU channel and
 * a West channel listed both servers' logins under each. Subtracting the main
 * set fixes the same bug where it actually bites: a channel created inside a
 * folder is *seeded* with the folder's main tags, so the moment "eu" is added
 * its own tags are [albion, eu] — and without the subtraction "albion" would
 * still match a West-only login.
 *
 * So, inside a folder:
 *   - the main tags are required;
 *   - any extra tag the channel carries narrows it to that slice;
 *   - a channel carrying only the main tags narrows to nothing, i.e. it lists
 *     the folder's whole scope;
 *   - a channel with no tags at all falls back to the folder's alternate set,
 *     which is the only thing that set is for.
 *
 * Outside a folder there is nothing to require and the channel's own tags are
 * the whole filter.
 */
export function channelTagFilter(
  channel: Pick<Channel, 'tagIds'>,
  folder?: Pick<Folder, 'tagIds' | 'altTagIds'> | null,
): { required: string[]; anyOf: string[] } {
  if (!folder) return { required: [], anyOf: channel.tagIds };

  const main = new Set(folder.tagIds);
  const extra = channel.tagIds.filter((tagId) => !main.has(tagId));
  const anyOf = extra.length > 0 ? extra : channel.tagIds.length === 0 ? folder.altTagIds : [];
  return { required: folder.tagIds, anyOf };
}

/**
 * The folder a channel is filed under, from the sidebar tree.
 *
 * Everywhere a channel is filtered — its list, its badge, a count in Settings —
 * the parent folder has to travel with it, because a channel inside a folder is
 * scoped by the folder's main tags. A count computed without the parent is
 * answering a different question than the row it is drawn on.
 */
export function parentFolderFor(
  sidebar: SidebarEntry[],
  folders: Folder[],
  channelId: string,
): Folder | undefined {
  for (const row of sidebar) {
    if (row.kind !== 'folder') continue;
    if (row.children.some((child) => child.kind === 'channel' && child.id === channelId)) {
      return folders.find((folder) => folder.id === row.id);
    }
  }
  return undefined;
}

/**
 * The properties a channel created inside a folder starts with: the folder's
 * look and its main tags. Copying them is what makes "new channel in this
 * folder" start as a member of the folder instead of a blank row that has to
 * be re-tagged by hand.
 */
export function channelSeedFromFolder(folder: Folder): Partial<Channel> {
  return {
    tagIds: [...folder.tagIds],
    // 'folder' is a folder-only glyph; the nearest channel glyph is layers.
    icon: folder.icon === 'folder' ? 'layers' : folder.icon,
    hue: folder.hue,
    accent: folder.accent,
    backgroundImage: folder.backgroundImage,
    backgroundOpacity: folder.backgroundOpacity,
    backgroundBlur: folder.backgroundBlur,
    backgroundDim: folder.backgroundDim,
  };
}

/**
 * The strength, blur and veil a new channel or folder starts with.
 *
 * Mirrors the app-wide background defaults in storage.ts. Duplicated as a
 * constant here rather than imported: storage.ts imports *this* module, and a
 * runtime import back would be a cycle whose constants could evaluate before
 * these exist.
 */
export const DEFAULT_BACKGROUND_LOOK = { opacity: 0.35, blur: 0, dim: 0.25 } as const;

/**
 * The same three values under their field names, for the built-in channels.
 * Spreading one constant keeps the shipped rows in step with the defaults a new
 * channel gets; spelling the numbers out seven times is how they drift.
 */
export const DEFAULT_BACKGROUND_FIELDS = {
  backgroundOpacity: DEFAULT_BACKGROUND_LOOK.opacity,
  backgroundBlur: DEFAULT_BACKGROUND_LOOK.blur,
  backgroundDim: DEFAULT_BACKGROUND_LOOK.dim,
} as const;

/**
 * Clamps one stored strength/blur/veil triple.
 *
 * Every value is bounded to the range its slider allows, so a hand-edited or
 * partly-written record cannot leave a channel with a NaN veil (which would
 * make `background: transparent` win over the whole row) or a 1000px blur that
 * costs a frame per repaint. Missing fields fall back to the defaults, which is
 * what makes this safe to run on records saved before these fields existed.
 */
export function normaliseBackgroundLook(raw: Partial<Pick<Channel, 'backgroundOpacity' | 'backgroundBlur' | 'backgroundDim'>>): {
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundDim: number;
} {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    backgroundOpacity: clamp(raw.backgroundOpacity, 0, 1, DEFAULT_BACKGROUND_LOOK.opacity),
    backgroundBlur: clamp(raw.backgroundBlur, 0, 40, DEFAULT_BACKGROUND_LOOK.blur),
    backgroundDim: clamp(raw.backgroundDim, 0, 0.9, DEFAULT_BACKGROUND_LOOK.dim),
  };
}

/** All channel ids, in sidebar order, flattened including folder children. */
export function channelIdsIn(entries: SidebarEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'channel') ids.push(entry.id);
    else if (entry.kind === 'folder') {
      for (const child of entry.children) if (child.kind === 'channel') ids.push(child.id);
    }
  }
  return ids;
}

/** Where a channel currently sits: the id of its parent folder, or null at the root. */
export function parentFolderId(entries: SidebarEntry[], channelId: string): string | null {
  for (const entry of entries) {
    if (entry.kind === 'folder' && entry.children.some((child) => child.kind === 'channel' && child.id === channelId)) {
      return entry.id;
    }
  }
  return null;
}

/**
 * Moves one sidebar entry to a position, identified by id rather than index.
 *
 * The drag handlers used to splice by array index in two separate places, and
 * every copy had to agree on what the index meant after the source entry had
 * been removed. They did not always, which is how a channel ended up dropped
 * in the wrong slot or deleted outright. Addressing the entry by its id and
 * doing the removal in one place removes that whole class of bug.
 *
 * `targetList` is `'root'` for the top level or a folder id. `targetIndex` is a
 * slot in that list as it is *currently* rendered, so inserting at the same
 * number after removal puts the entry on the slot the user aimed at.
 *
 * Folders are not movable: they cannot nest, so a folder target is ignored and
 * the tree is returned untouched.
 */
export function moveSidebarEntry(
  entries: SidebarEntry[],
  entryId: string,
  targetList: string,
  targetIndex: number,
): SidebarEntry[] {
  const matches = (entry: SidebarEntry) => entry.id === entryId;

  // Locate and lift the entry out, wherever it currently lives. `remove`
  // returns the lifted entry rather than stashing it in a captured variable,
  // which TypeScript cannot narrow reliably.
  const remove = (list: SidebarEntry[]): SidebarEntry[] => {
    const out: SidebarEntry[] = [];
    for (const entry of list) {
      if (!lifted && matches(entry)) {
        lifted = entry;
        continue;
      }
      if (entry.kind === 'folder') out.push({ ...entry, children: remove(entry.children) });
      else out.push(entry);
    }
    return out;
  };

  let lifted: SidebarEntry | undefined;
  const stripped = remove(entries);
  if (!lifted) return entries;
  const entry: SidebarEntry = lifted;

  const folder = targetList === 'root' ? null : stripped.find((e) => e.kind === 'folder' && e.id === targetList);
  // A folder can only be reordered at the root; it cannot be dropped inside
  // another folder, so that request is ignored rather than silently corrupting
  // a tree that `normaliseSidebar` would then flatten on the next load.
  if (entry.kind === 'folder' && folder) return entries;

  const clamp = (list: SidebarEntry[]) => Math.max(0, Math.min(list.length, targetIndex));

  if (!folder) {
    const root = [...stripped];
    root.splice(clamp(root), 0, entry);
    return root;
  }

  return stripped.map((e) => {
    if (e.kind !== 'folder' || e.id !== targetList) return e;
    const children = [...e.children];
    children.splice(clamp(children), 0, entry);
    return { ...e, children };
  });
}

/**
 * Drops one login id at a position in the current view's flat order and
 * returns the new global manual order.
 *
 * `toIndex` is a slot in `visibleIds` *after* removing `loginId` — the view
 * computes it from the drop indicator, so what you aim at is what you get.
 * Ids the order has never seen are seeded first (visible ids in view order,
 * then `allIds`), so the first drag in any view starts from what is on screen
 * and untouched pairs keep their relative positions everywhere. Pass `allIds`
 * title-sorted so the seeded tail reads sensibly.
 */
export function moveManualOrder(
  current: string[],
  visibleIds: string[],
  allIds: string[],
  loginId: string,
  toIndex: number,
): string[] {
  const known = new Set(allIds);
  const base = current.filter((id) => known.has(id) && id !== loginId);
  for (const id of visibleIds) {
    if (id !== loginId && known.has(id) && !base.includes(id)) base.push(id);
  }
  for (const id of allIds) {
    if (id !== loginId && !base.includes(id)) base.push(id);
  }
  const rest = visibleIds.filter((id) => id !== loginId);
  const anchor = rest[Math.min(Math.max(toIndex, 0), rest.length)];
  if (anchor === undefined) return [...base, loginId];
  const at = base.indexOf(anchor);
  return at === -1 ? [...base, loginId] : [...base.slice(0, at), loginId, ...base.slice(at)];
}

/**
 * Moves a channel or separator to the root, or into a folder, appending it.
 *
 * Thin wrapper over `moveSidebarEntry` for the context menus, which have no
 * meaningful target index and always mean "put this at the end of there".
 * If the requested folder is not in the tree the entry falls back to the root
 * rather than being dropped on the floor, which is what an earlier version did.
 */
/** The folder the channel list is filed under, by name. */
export const CHANNELS_FOLDER_NAME = 'Channels';

/**
 * Files every channel into one folder, leaving Dashboard and Mail at the top.
 *
 * The rail was one long list in which the two structural screens, the built-in
 * filters and every channel anyone made all sat at the same level. This is the
 * one-time tidy: Dashboard and Mail stay where they are, everything else becomes
 * a single collapsible group whose order is the order the rail already had.
 *
 * Returns null when there is nothing to do — no channel to move, or they are
 * already in exactly one folder — and the caller stamps the pass either way, so
 * a rail the user has since rearranged is never reshuffled again.
 */
export function groupChannelsIntoFolder(
  channels: Channel[],
  folders: Folder[],
  sidebar: SidebarEntry[],
): { folders: Folder[]; sidebar: SidebarEntry[] } | null {
  const kept = new Set(
    channels.filter((channel) => channel.kind === 'dashboard' || channel.kind === 'mail').map((channel) => channel.id),
  );
  const movers = channels.filter((channel) => !kept.has(channel.id));
  if (movers.length === 0) return null;
  const moverIds = new Set(movers.map((channel) => channel.id));

  // The order each mover sits in today, flattened, so the folder reads the way
  // the rail read. Channels missing from the tree are appended.
  const seenOrder: string[] = [];
  const visit = (rows: SidebarEntry[]): void => {
    for (const row of rows) {
      if (row.kind === 'channel') seenOrder.push(row.id);
      else if (row.kind === 'folder') visit(row.children);
    }
  };
  visit(sidebar);
  const ordered = [
    ...seenOrder.filter((id) => moverIds.has(id)),
    ...movers.map((channel) => channel.id).filter((id) => !seenOrder.includes(id)),
  ];

  const existing = folders.find(
    (folder) => folder.name.trim().toLowerCase() === CHANNELS_FOLDER_NAME.toLowerCase(),
  );
  if (existing) {
    const row = sidebar.find((entry) => entry.kind === 'folder' && entry.id === existing.id);
    const children = row && row.kind === 'folder' ? row.children : [];
    const childIds = new Set(children.flatMap((child) => (child.kind === 'channel' ? [child.id] : [])));
    const allInside = ordered.every((id) => childIds.has(id));
    const stray = sidebar.some((entry) => entry.kind === 'channel' && moverIds.has(entry.id));
    const otherFolders = sidebar.filter((entry) => entry.kind === 'folder' && entry.id !== existing.id);
    if (allInside && !stray && otherFolders.length === 0) return null;
  }

  const folder = existing ?? createFolder(CHANNELS_FOLDER_NAME, { icon: 'layers' });
  const nextFolders = existing ? folders : [...folders, folder];
  // Dashboard and Mail keep their slots, in their current order; the folder is
  // the one thing appended after them.
  const root: SidebarEntry[] = [
    ...sidebar.filter((entry) => entry.kind === 'channel' && kept.has(entry.id)),
    {
      kind: 'folder',
      id: folder.id,
      children: ordered.map((id) => ({ kind: 'channel', id }) as SidebarEntry),
    },
  ];
  return { folders: nextFolders, sidebar: root };
}

export function moveChannelToFolder(entries: SidebarEntry[], channelId: string, folderId: string | null): SidebarEntry[] {
  const targetList = folderId ?? 'root';
  const list = folderId ? entries.find((e) => e.kind === 'folder' && e.id === folderId) : undefined;
  const children = list && list.kind === 'folder' ? list.children.length : entries.length;
  const fallback = folderId && !list ? 'root' : targetList;
  const index = fallback === 'root' ? entries.length : children;
  return moveSidebarEntry(entries, channelId, fallback, index);
}

export function normaliseFolders(stored: Folder[] | undefined): Folder[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const folders: Folder[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    folders.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Folder',
      icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : 'layers',
      hue: typeof raw.hue === 'number' && Number.isFinite(raw.hue) ? ((raw.hue % 360) + 360) % 360 : 212,
      accent: CHANNEL_ACCENTS.includes(raw.accent as ChannelAccent) ? (raw.accent as ChannelAccent) : 'slate',
      backgroundImage: typeof raw.backgroundImage === 'string' ? raw.backgroundImage : '',
      ...normaliseBackgroundLook(raw),
      collapsed: Boolean(raw.collapsed),
      // Both tag sets are id lists, deduplicated and shape-checked so a
      // hand-edited record cannot write a non-string into a filter.
      tagIds: Array.isArray(raw.tagIds)
        ? [...new Set(raw.tagIds.filter((tag): tag is string => typeof tag === 'string'))]
        : [],
      altTagIds: Array.isArray(raw.altTagIds)
        ? [...new Set(raw.altTagIds.filter((tag): tag is string => typeof tag === 'string'))]
        : [],
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      notesHidden: raw.notesHidden === true,
      // Shared helper — this used to rebuild the block inline without
      // passcode, silently unprotecting passcode-only folders on reload.
      security: normaliseSecurity(raw.security),
    });
  }
  return folders;
}

/** Validates the entry tree against the channels and folders that actually exist. */
export function normaliseSidebar(stored: SidebarEntry[] | undefined, channels: Channel[], folders: Folder[]): SidebarEntry[] {
  const channelIds = new Set(channels.map((channel) => channel.id));
  const folderIds = new Set(folders.map((folder) => folder.id));
  const usedChannels = new Set<string>();
  const usedFolders = new Set<string>();
  // Separators are the one entry kind the tree never de-duplicated, so a save
  // cycle that wrote the same row twice produced two rows with the same React
  // key. Ids are unique per separator, so first-one-wins is safe.
  const usedSeparators = new Set<string>();

  const fix = (list: SidebarEntry[] | undefined, depth: number): SidebarEntry[] => {
    if (!Array.isArray(list) || depth > 2) return [];
    const out: SidebarEntry[] = [];
    let lastKind: string | null = null;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.kind === 'channel' && typeof raw.id === 'string' && channelIds.has(raw.id) && !usedChannels.has(raw.id)) {
        usedChannels.add(raw.id);
        out.push({ kind: 'channel', id: raw.id });
        lastKind = 'channel';
      } else if (
        raw.kind === 'separator' &&
        typeof raw.id === 'string' &&
        lastKind !== 'separator' &&
        !usedSeparators.has(raw.id)
      ) {
        // Only two separators in a row are meaningless. The old guard also
        // required `out.length > 0`, which silently deleted a separator that
        // happened to be the first entry of a folder's children (and a leading
        // separator at the root), so it vanished on the next load.
        usedSeparators.add(raw.id);
        out.push({ kind: 'separator', id: raw.id });
        lastKind = 'separator';
      } else if (raw.kind === 'folder' && typeof raw.id === 'string' && folderIds.has(raw.id) && !usedFolders.has(raw.id)) {
        usedFolders.add(raw.id);
        out.push({ kind: 'folder', id: raw.id, children: fix(raw.children, depth + 1) });
        lastKind = 'folder';
      }
    }
    return out;
  };

  const entries = fix(stored, 0);
  // Channels missing from the tree are appended at the root so nothing disappears.
  for (const channel of channels) {
    if (!usedChannels.has(channel.id)) entries.push({ kind: 'channel', id: channel.id });
  }
  for (const folder of folders) {
    if (!usedFolders.has(folder.id)) entries.push({ kind: 'folder', id: folder.id, children: [] });
  }
  return entries;
}

/** Rows selectable in the sidebar: channel ids, 'folder:<id>' and 'unassigned'. */
export function selectableIds(entries: SidebarEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'channel') ids.push(entry.id);
    else if (entry.kind === 'folder') {
      ids.push(`folder:${entry.id}`);
      for (const child of entry.children) if (child.kind === 'channel') ids.push(child.id);
    }
  }
  return ids;
}

/** Hue used by channels that have not been recoloured. */
const DEFAULT_CHANNEL_HUE = 212;

export const BUILTIN_CHANNELS: Channel[] = [
  { id: 'all', name: 'All logins', kind: 'all', tagIds: [], builtin: true, locked: true, icon: 'inbox', hue: DEFAULT_CHANNEL_HUE, accent: 'slate', backgroundImage: '', ...DEFAULT_BACKGROUND_FIELDS, showMail: true, mailAccount: 'all', security: EMPTY_SECURITY },
  // Favorites, Needs attention and Weak or reused are tabs inside `all` now —
  // see ALL_LOGIN_TABS. Their kinds are still valid for channels anyone makes.
  { id: 'dashboard', name: 'Dashboard', kind: 'dashboard', tagIds: [], builtin: true, locked: true, icon: 'grid', hue: 268, accent: 'dusk', backgroundImage: '', ...DEFAULT_BACKGROUND_FIELDS, showMail: true, mailAccount: 'all', security: EMPTY_SECURITY },
  { id: 'mail', name: 'Mail', kind: 'mail', tagIds: [], builtin: true, locked: true, icon: 'inbox', hue: 205, accent: 'slate', backgroundImage: '', ...DEFAULT_BACKGROUND_FIELDS, showMail: false, mailAccount: 'all', security: EMPTY_SECURITY },
  // The change log is structural like the other two summary screens: there is
  // exactly one, it cannot be deleted, and it can still be renamed, recoloured,
  // moved into a folder or hidden like any other row.
  { id: 'history', name: 'History', kind: 'history', tagIds: [], builtin: true, locked: true, icon: 'clock', hue: 28, accent: 'clay', backgroundImage: '', ...DEFAULT_BACKGROUND_FIELDS, showMail: false, mailAccount: 'all', security: EMPTY_SECURITY },
];

/** Icon keys the sidebar knows how to draw. */
export const CHANNEL_ICONS = ['inbox', 'star', 'flag', 'shield', 'layers', 'key', 'lock', 'cloud', 'grid', 'clock'] as const;

/** Ids that may be deleted. */
export const DELETABLE_CHANNEL_KINDS: ChannelKind[] = ['all', 'favorites', 'attention', 'weak'];

/**
 * Every kind a stored channel is allowed to keep.
 *
 * This has to be wider than DELETABLE_CHANNEL_KINDS: `tags` and `dashboard` are
 * legitimate persisted kinds (auto-created tag channels use `tags`, the summary
 * screen uses `dashboard`) and neither is deletable. Validating against the
 * deletable list silently rewrote them to `all` on reload, which made the
 * Dashboard channel render the login list instead of the summary screen.
 */
const VALID_CHANNEL_KINDS: ChannelKind[] = [...DELETABLE_CHANNEL_KINDS, 'tags', 'dashboard', 'mail', 'unassigned', 'history'];

export function newChannelId(): string {
  return `ch_${crypto.randomUUID().slice(0, 8)}`;
}

export function newTagId(): string {
  return `tg_${crypto.randomUUID().slice(0, 8)}`;
}

/** Creates a tag, nudging the hue away from one already in use. */
export function createTag(name: string, existing: Tag[]): Tag {
  const hue = pickFreeHue(existing);
  return { id: newTagId(), name: name.trim() || 'Tag', hue };
}

/** Evenly spreads hues around the wheel so adjacent tags stay distinguishable. */
function pickFreeHue(existing: Tag[]): number {
  if (existing.length === 0) return 210;
  const used = new Set(existing.map((tag) => Math.round(tag.hue / 24) * 24 % 360));
  for (let hue = 0; hue < 360; hue += 24) {
    if (!used.has(hue)) return hue;
  }
  return Math.round((existing.length * 47) % 360);
}

/**
 * Applies a channel to the vault.
 *
 * The `kind` picks the base set; `tagIds` then narrows it, so tags work on any
 * channel rather than only on purpose-built tag channels. Inside a folder the
 * folder's main tags are a further requirement and the channel's own tags are
 * the narrowing set — see channelTagFilter.
 *
 * `weak` is derived rather than stored: it means a reused password, or one that
 * has not been changed in a long time.
 */
export function applyChannel(
  channel: Channel,
  items: VaultItem[],
  staleAfterDays = 180,
  folder?: Pick<Folder, 'tagIds' | 'altTagIds'> | null,
): VaultItem[] {
  let list: VaultItem[];

  switch (channel.kind) {
    case 'favorites':
      list = items.filter((item) => item.favorite);
      break;
    case 'attention':
      list = items.filter((item) => item.needsAttention);
      break;
    case 'unassigned':
      list = items.filter((item) => item.tags.length === 0);
      break;
    case 'dashboard':
    case 'mail':
    case 'history':
      // All three are summary screens rather than filtered lists. Treated as
      // "everything" so any tag narrowing still behaves predictably.
      list = items;
      break;
    case 'weak': {
      // Same source the dashboard's Weak tile counts from: reused, stale,
      // guessable on its own, or following the same pattern as another login
      // (summer2023/summer2024 and friends). Counting only reuse+age here made
      // the Weak tile say 4 while this channel listed 2 for the same vault.
      // Staleness honors each login's own reminder when set, else the global.
      const reused = findReusedPasswords(items);
      const now = Date.now();
      const patterns = new Map<string, number>();
      for (const item of items) {
        if (!item.password) continue;
        const stem = weakPatternStem(item.password);
        if (stem) patterns.set(stem, (patterns.get(stem) ?? 0) + 1);
      }
      list = items.filter((item) => {
        if (item.password === '') return false;
        if (reused.has(item.password)) return true;
        const threshold = item.reminderDays > 0 ? item.reminderDays : staleAfterDays;
        if (threshold > 0 && item.passwordUpdatedAt < now - threshold * 86_400_000) return true;
        if (estimateStrength(item.password).score <= 1) return true;
        const stem = weakPatternStem(item.password);
        if (stem && (patterns.get(stem) ?? 0) > 1) return true;
        return false;
      });
      break;
    }
    default:
      // 'all' and 'tags' both start from everything; 'tags' is narrowed below.
      list = items;
  }

  // A channel inside a folder is scoped by the folder's main tags and narrowed
  // by its own; see channelTagFilter for why the two are not one OR'd bag.
  const { required, anyOf } = channelTagFilter(channel, folder);
  if (required.length === 0 && anyOf.length === 0) return list;
  return list.filter((item) => {
    const carried = new Set(item.tags);
    // Every one of the folder's main tags has to be present...
    if (required.some((tagId) => !carried.has(tagId))) return false;
    // ...and then at least one of the channel's own, when it has any.
    return anyOf.length === 0 || anyOf.some((tagId) => carried.has(tagId));
  });
}

/**
 * One line saying what a channel holds, for the workspace header strip.
 *
 * The rail already names the channel; this says what the name *means*, so a
 * channel reads as a workspace with its own scope rather than a bare filter.
 */
export function describeChannel(channel: Pick<Channel, 'kind' | 'tagIds'>, tags: Tag[]): string {
  switch (channel.kind) {
    case 'all':
      return 'Everything in the vault';
    case 'favorites':
      return 'Starred logins, pinned on top';
    case 'attention':
      return 'Flagged for follow-up';
    case 'weak':
      return 'Passwords worth a rotation';
    case 'unassigned':
      return 'Logins still waiting for a tag';
    case 'dashboard':
    case 'mail':
      return '';
    case 'history':
      return 'Everything that changed, newest first';
    case 'tags':
    default: {
      const names = channel.tagIds
        .map((id) => tags.find((tag) => tag.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? `Tagged ${names.join(', ')}` : 'Tagged logins';
    }
  }
}

/**
 * Sanitises stored channels, preserving the user's order.
 *
 * Unlike an earlier version this does not force the built-ins to the front:
 * every channel is editable, so the stored order is authoritative. Built-ins
 * that are missing are appended, and `all` is re-added if it was deleted, since
 * the app needs a fallback view.
 */
export function normaliseChannels(stored: Channel[] | undefined): Channel[] {
  if (!Array.isArray(stored)) return BUILTIN_CHANNELS.map((channel) => ({ ...channel, tagIds: [] }));

  const defaults = new Map(BUILTIN_CHANNELS.map((channel) => [channel.id, channel]));
  const seen = new Set<string>();
  const channels: Channel[] = [];

  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id || seen.has(id)) continue;
    // The three merged rows are gone as channels; their content is the tabs of
    // All logins now. Dropping the stored copy here is what stops a reload from
    // resurrecting them beside the tab strip they were folded into.
    if (RETIRED_CHANNEL_IDS.has(id) || RESERVED_CHANNEL_IDS.has(id)) continue;
    seen.add(id);

    const preset = defaults.get(id);
    const kind: ChannelKind = VALID_CHANNEL_KINDS.includes(raw.kind as ChannelKind)
      ? (raw.kind as ChannelKind)
      : preset?.kind ?? 'all';
    channels.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : preset?.name ?? 'Channel',
      kind,
      tagIds: Array.isArray(raw.tagIds)
        ? [...new Set(raw.tagIds.filter((tag): tag is string => typeof tag === 'string'))]
        : [],
      icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : preset?.icon ?? 'layers',
      hue: typeof raw.hue === 'number' && Number.isFinite(raw.hue)
        ? ((raw.hue % 360) + 360) % 360
        : preset?.hue ?? DEFAULT_CHANNEL_HUE,
      accent: CHANNEL_ACCENTS.includes(raw.accent as ChannelAccent)
        ? (raw.accent as ChannelAccent)
        : preset?.accent ?? 'slate',
      backgroundImage: typeof raw.backgroundImage === 'string' ? raw.backgroundImage : '',
      ...normaliseBackgroundLook(raw),
      // `builtin` is fixed by id so a hand-edited file cannot promote a channel.
      builtin: Boolean(preset),
      // The fallback view and the summary screens are structural: there must
      // always be one of each, so none can be deleted or reordered away. They
      // can still be renamed, recoloured, hidden and moved — only deletion is
      // off the table, and `locked` is what the menus read to say so.
      locked: id === 'all' || kind === 'dashboard' || kind === 'mail' || kind === 'history',
      showMail: raw.showMail !== false,
      mailAccount: typeof raw.mailAccount === 'string' && raw.mailAccount ? raw.mailAccount : 'all',
      // Shared helper — a channel's factor must survive a reload for the same
      // reason a folder's does, and rebuilding the block by hand is how
      // passcode-only factors were silently dropped elsewhere.
      security: normaliseSecurity(raw.security),
    });
  }

  // A channel created before `dashboard` became a kind was stored under a
  // generated id with kind `all`, so selecting it rendered the login list
  // instead of the summary screen. Adopt such a channel rather than appending a
  // second Dashboard, which would leave the user with two rows and the wrong one
  // active. Runs before the built-ins are appended so it can claim the role.
  if (!channels.some((channel) => channel.kind === 'dashboard')) {
    const stray = channels.find(
      (channel) => !channel.builtin && /^(dashboard|home|overview|summary)$/i.test(channel.name),
    );
    if (stray) {
      stray.kind = 'dashboard';
      stray.locked = true;
      stray.hue = BUILTIN_CHANNELS.find((c) => c.kind === 'dashboard')?.hue ?? stray.hue;
    }
  }

  // Same adoption for the mail centre, which arrived the same way: a channel
  // somebody made and named Mail/Inbox has to keep being the row they click,
  // not gain a duplicate beside it.
  if (!channels.some((channel) => channel.kind === 'mail')) {
    const stray = channels.find(
      (channel) => !channel.builtin && /^(mail|inbox|messages|mailbox|emails?)$/i.test(channel.name),
    );
    if (stray) {
      stray.kind = 'mail';
      stray.locked = true;
      stray.icon = 'inbox';
      stray.hue = BUILTIN_CHANNELS.find((c) => c.kind === 'mail')?.hue ?? stray.hue;
    }
  }

  // And the change log, which arrived the same way: a channel somebody made and
  // named History/Log/Activity has to become the log they click, not gain a
  // second row beside it that shows the same thing.
  if (!channels.some((channel) => channel.kind === 'history')) {
    const stray = channels.find(
      (channel) => !channel.builtin && /^(history|log|activity|changelog|changes)$/i.test(channel.name),
    );
    if (stray) {
      stray.kind = 'history';
      stray.locked = true;
      stray.icon = 'clock';
      stray.hue = BUILTIN_CHANNELS.find((c) => c.kind === 'history')?.hue ?? stray.hue;
    }
  }

  for (const preset of BUILTIN_CHANNELS) {
    // The preset is only appended if nothing already plays that role.
    if (!seen.has(preset.id) && !channels.some((channel) => channel.kind === preset.kind)) {
      channels.push({ ...preset, tagIds: [] });
    }
  }

  // The sidebar renders `channels[0]` as a fallback, so guarantee a real view.
  if (!channels.some((channel) => channel.kind === 'all')) {
    channels.unshift({ ...BUILTIN_CHANNELS[0]!, tagIds: [] });
  }

  return channels;
}

/** A fresh, fully customisable channel. */
export function createChannel(name: string, patch: Partial<Channel> = {}): Channel {
  const { builtin: _ignoredBuiltin, locked: _ignoredLocked, ...safe } = patch;
  return {
    id: newChannelId(),
    name: name.trim() || 'New channel',
    kind: 'all',
    tagIds: [],
    icon: 'layers',
    hue: Math.round(Math.random() * 359),
    accent: 'slate',
    backgroundImage: '',
    backgroundOpacity: DEFAULT_BACKGROUND_LOOK.opacity,
    backgroundBlur: DEFAULT_BACKGROUND_LOOK.blur,
    backgroundDim: DEFAULT_BACKGROUND_LOOK.dim,
    showMail: true,
    mailAccount: 'all',
    security: EMPTY_SECURITY,
    ...safe,
    // A new channel is never one of the shipped ones, whatever the caller passed.
    builtin: false,
    locked: false,
  };
}

/** Lowercased digits-stripped stem, or '' when too short to mean anything. */
function weakPatternStem(password: string): string {
  const stem = password.toLowerCase().replace(/[0-9]+/g, '');
  return stem.length >= 4 ? stem : '';
}

/**
 * Editable default tags every vault starts with.
 *
 * These are ordinary tags — rename, recolour or delete them from the dashboard
 * like any other. They exist so "weak", "needs attention" and "reused" are
 * something you can put on a login and filter by, instead of only being badge
 * text the app decides for you. Hues are spread around the wheel so the three
 * stay distinguishable at a glance.
 */
export const DEFAULT_TAG_SEEDS: { name: string; hue: number }[] = [
  { name: 'weak', hue: 8 },
  { name: 'needs attention', hue: 36 },
  { name: 'reused', hue: 268 },
];

/**
 * Adds any missing default tag (matched case-insensitively), preserving the
 * user's order and never duplicating. Runs on load so older vaults gain the
 * defaults without losing the tags they already have.
 */
export function ensureDefaultTags(tags: Tag[]): Tag[] {
  const next = [...tags];
  const have = new Set(next.map((tag) => tag.name.trim().toLowerCase()));
  for (const seed of DEFAULT_TAG_SEEDS) {
    if (have.has(seed.name.toLowerCase())) continue;
    next.push({ id: newTagId(), name: seed.name, hue: seed.hue });
    have.add(seed.name.toLowerCase());
  }
  return next;
}

export function normaliseTags(stored: Tag[] | undefined): Tag[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const tags: Tag[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    tags.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Tag',
      hue: typeof raw.hue === 'number' && Number.isFinite(raw.hue) ? ((raw.hue % 360) + 360) % 360 : 210,
    });
  }
  return tags;
}

/** Drops tags that no login references any more. */
export function pruneTags(tags: Tag[], items: VaultItem[]): Tag[] {
  const used = new Set(items.flatMap((item) => item.tags));
  return tags.filter((tag) => used.has(tag.id));
}

/** Moves the item at `from` to `to`, returning a new array. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved as T);
  return next;
}