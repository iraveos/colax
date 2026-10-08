/**
 * Sidebar channels and the tag catalogue.
 *
 * A channel is a saved view over the vault. Four ship built in (all, favorites,
 * needs attention, weak or reused); the rest are user defined.
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

export type ChannelKind = 'all' | 'favorites' | 'attention' | 'tags' | 'weak' | 'dashboard' | 'unassigned';

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
  unassigned: 'Unassigned',
};

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
  /** Whether the user has collapsed it in the sidebar. */
  collapsed: boolean;
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
    collapsed: false,
    security: EMPTY_SECURITY,
    ...patch,
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
 * Moves a channel or separator to the root, or into a folder, appending it.
 *
 * Thin wrapper over `moveSidebarEntry` for the context menus, which have no
 * meaningful target index and always mean "put this at the end of there".
 * If the requested folder is not in the tree the entry falls back to the root
 * rather than being dropped on the floor, which is what an earlier version did.
 */
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
      collapsed: Boolean(raw.collapsed),
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
      } else if (raw.kind === 'separator' && typeof raw.id === 'string' && lastKind !== 'separator') {
        // Only two separators in a row are meaningless. The old guard also
        // required `out.length > 0`, which silently deleted a separator that
        // happened to be the first entry of a folder's children (and a leading
        // separator at the root), so it vanished on the next load.
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
  { id: 'all', name: 'All logins', kind: 'all', tagIds: [], builtin: true, locked: true, icon: 'inbox', hue: DEFAULT_CHANNEL_HUE, accent: 'slate', backgroundImage: '', showMail: true, mailAccount: 'all' },
  { id: 'favorites', name: 'Favorites', kind: 'favorites', tagIds: [], builtin: true, locked: false, icon: 'star', hue: 44, accent: 'slate', backgroundImage: '', showMail: true, mailAccount: 'all' },
  { id: 'attention', name: 'Needs attention', kind: 'attention', tagIds: [], builtin: true, locked: false, icon: 'flag', hue: 8, accent: 'clay', backgroundImage: '', showMail: true, mailAccount: 'all' },
  { id: 'weak', name: 'Weak or reused', kind: 'weak', tagIds: [], builtin: true, locked: false, icon: 'shield', hue: 152, accent: 'sage', backgroundImage: '', showMail: true, mailAccount: 'all' },
  { id: 'dashboard', name: 'Dashboard', kind: 'dashboard', tagIds: [], builtin: true, locked: true, icon: 'grid', hue: 268, accent: 'dusk', backgroundImage: '', showMail: true, mailAccount: 'all' },
];

/** Icon keys the sidebar knows how to draw. */
export const CHANNEL_ICONS = ['inbox', 'star', 'flag', 'shield', 'layers', 'key', 'lock', 'cloud', 'grid'] as const;

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
const VALID_CHANNEL_KINDS: ChannelKind[] = [...DELETABLE_CHANNEL_KINDS, 'tags', 'dashboard', 'unassigned'];

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
 * channel rather than only on purpose-built tag channels.
 *
 * `weak` is derived rather than stored: it means a reused password, or one that
 * has not been changed in a long time.
 */
export function applyChannel(channel: Channel, items: VaultItem[], staleAfterDays = 180): VaultItem[] {
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
      // A summary screen, not a filtered list. Treated as "everything" so any
      // tag narrowing still behaves predictably.
      list = items;
      break;
    case 'weak': {
      // Same source the dashboard's Weak tile counts from: reused, stale,
      // guessable on its own, or following the same pattern as another login
      // (summer2023/summer2024 and friends). Counting only reuse+age here made
      // the Weak tile say 4 while this channel listed 2 for the same vault.
      const reused = findReusedPasswords(items);
      const patterns = new Map<string, number>();
      for (const item of items) {
        if (!item.password) continue;
        const stem = weakPatternStem(item.password);
        if (stem) patterns.set(stem, (patterns.get(stem) ?? 0) + 1);
      }
      const cutoff = staleAfterDays > 0 ? Date.now() - staleAfterDays * 86_400_000 : 0;
      list = items.filter((item) => {
        if (item.password === '') return false;
        if (reused.has(item.password)) return true;
        if (staleAfterDays > 0 && item.passwordUpdatedAt < cutoff) return true;
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

  if (channel.tagIds.length === 0) return list;
  const wanted = new Set(channel.tagIds);
  return list.filter((item) => item.tags.some((tagId) => wanted.has(tagId)));
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
      // `builtin` is fixed by id so a hand-edited file cannot promote a channel.
      builtin: Boolean(preset),
      // The fallback view and the summary screen are both structural: there must
      // always be one of each, so neither can be deleted or reordered away.
      locked: id === 'all' || kind === 'dashboard',
      showMail: raw.showMail !== false,
      mailAccount: typeof raw.mailAccount === 'string' && raw.mailAccount ? raw.mailAccount : 'all',
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
    showMail: true,
    mailAccount: 'all',
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