import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findReusedPasswords, hostnameOf, type VaultItem } from '../vault/types.ts';
import {
  applyChannel,
  createChannel,
  createTag,
  normaliseChannels,
  normaliseSidebar,
  moveChannelToFolder,
  CHANNEL_ACCENTS,
  CHANNEL_ICONS,
  type Channel,
  type Folder,
  type SidebarEntry,
} from '../vault/channels.ts';
import { captureToDraft, findSimilarTag, suggestTagsForDraft } from '../vault/site-intel.ts';
import { isSecured, requiresVerification, EMPTY_SECURITY } from '../crypto/security.ts';
import { SecurityGate } from './SecurityGate.tsx';
import { FolderEditor } from './FolderEditor.tsx';
import { useClipboardWatcher } from './useClipboardWatcher.ts';
import { useAlarms, playAlarmSound } from './useAlarms.ts';
import { useCaptureOffer, type PendingCapture } from './useCaptureOffer.ts';
import type { SortMode, VaultView } from '../vault/storage.ts';
import { LockScreen } from './LockScreen.tsx';
import { ItemEditor } from './ItemEditor.tsx';
import { AppearancePanel } from './AppearancePanel.tsx';
import { Settings } from './Settings.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ViewMenu } from './ViewMenu.tsx';
import { ContextMenu, type ContextMenuState, type MenuItem } from './context-menu.tsx';
import { ChannelEditor } from './ChannelEditor.tsx';
import { Alert, Modal, Toasts } from './primitives.tsx';
import { AnimatedListView, BasicView, CarouselView, ViewEmptyState, type ViewActions } from './views.tsx';
import {
  useAutoLock,
  useClipboard,
  useHotkeys,
  useToasts,
  useVault,
  applyAppearance,
  applyChannelAppearance,
} from './hooks.ts';
import {
  AlertIcon,
  CopyIcon,
  EditIcon,
  ExternalIcon,
  FlagIcon,
  GridIcon,
  InboxIcon,
  KeyboardIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  MoonIcon,
  PaletteIcon,
  PlusIcon,
  RowsIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  TrashIcon,
  XIcon,
} from './icons.tsx';

const SORT_LABELS: Record<SortMode, string> = {
  title: 'Name',
  recent: 'Recently updated',
  oldest: 'Least recently updated',
  strength: 'Weakest first',
  username: 'Username',
};

/** The always-present bucket for logins with no tag at all. */
const UNASSIGNED: Channel = {
  id: 'unassigned',
  name: 'Unassigned',
  kind: 'unassigned',
  tagIds: [],
  icon: 'inbox',
  hue: 220,
  accent: 'slate',
  backgroundImage: '',
  builtin: false,
  locked: false,
};

function stripChannel(rows: SidebarEntry[], id: string): SidebarEntry[] {
  return rows
    .filter((row) => !(row.kind === 'channel' && row.id === id))
    .map((row) => (row.kind === 'folder' ? { ...row, children: stripChannel(row.children, id) } : row));
}

function addSeparatorAtEnd(rows: SidebarEntry[]): SidebarEntry[] {
  return [...rows, { kind: 'separator', id: `sep_${Math.random().toString(36).slice(2, 8)}` }];
}

/** Human names for the rail positions, shared by the menu and Settings. */
const POSITION_LABELS = {
  left: 'Left edge',
  right: 'Right edge',
  top: 'Top, as a tab bar',
  bottom: 'Bottom, as a dock',
} as const;

export function App() {
  const vault = useVault();
  const { toasts, notify } = useToasts();
  const { copy } = useClipboard(vault.prefs.clearClipboardSeconds, notify, vault.prefs.copyToasts);

  const [activeId, setActiveId] = useState('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<VaultItem | null | 'new'>(null);
  /**
   * Logins whose second factor has been cleared this session.
   *
   * Verification is remembered per session so a user is not re-prompted for
   * every row they touch, but it is deliberately NOT persisted: closing the app
   * re-locks every protected login.
   */
  const [verifiedItems, setVerifiedItems] = useState<ReadonlySet<string>>(new Set());
  /** A login waiting on the gate before it will open or reveal. */
  const [pendingItem, setPendingItem] = useState<VaultItem | null>(null);
  /** Whether the appearance slide-over is open. */
  const [showTuner, setShowTuner] = useState(false);
  /** Whether the pending gate is for revealing the password or for editing. */
  const [pendingIntent, setPendingIntent] = useState<'reveal' | 'edit'>('edit');
  const [confirmDelete, setConfirmDelete] = useState<VaultItem | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  /** null = closed; a channel id edits that one; 'new' creates one. */
  const [editingChannel, setEditingChannel] = useState<string | 'new' | null>(null);
  /** null = closed; a folder id edits that one; 'new' creates one. */
  const [editingFolder, setEditingFolder] = useState<string | 'new' | null>(null);
  /** When creating a channel from a folder's menu, it lands in that folder. */
  const [newChannelFolder, setNewChannelFolder] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const openSettings = useCallback((tab?: string) => {
    setSettingsTab(tab);
    setShowSettings(true);
  }, []);
  const search = useRef<HTMLInputElement>(null);
  const view = vault.prefs.view;
  const prefs = vault.prefs;

  useAutoLock(prefs.autoLockMinutes, vault.status === 'unlocked', vault.lock);

  // Clipboard login detection, opt-in from Settings.
  const { pending: clipPending, dismiss: dismissClip } = useClipboardWatcher({
    enabled: prefs.clipboardCapture,
    unlocked: vault.status === 'unlocked',
    autoSave: prefs.clipboardAutoSave,
    onAutoSave: (creds) => {
      void vault
        .mutate(() =>
          vault.service.addItem({
            title: creds.username.split('@')[0] ?? 'Clipboard login',
            username: creds.username,
            password: creds.password,
            url: '',
          }),
        )
        .then(() => notify('Saved credentials from the clipboard'));
    },
  });

  // Reminders with custom sounds.
  useAlarms(prefs.alarms, (alarm) => {
    playAlarmSound(alarm);
    notify(`Alarm: ${alarm.label || alarm.time}`);
  });

  // Extra factor gating the whole vault, verified once per unlock.
  const [vaultVerified, setVaultVerified] = useState(false);
  useEffect(() => {
    if (vault.status !== 'unlocked') setVaultVerified(false);
  }, [vault.status]);

  // Extra factor gating a folder, remembered per session.
  const [foldersUnlocked, setFoldersUnlocked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (vault.status !== 'unlocked') setFoldersUnlocked(new Set());
  }, [vault.status]);

  /** A sign-up or sign-in offered by the browser extension, awaiting a decision. */
  const capture = useCaptureOffer({
    // Only while the vault can actually store something.
    enabled: vault.status === 'unlocked',
    tags: prefs.tags,
    onAccept: (offer) => void saveCapture(offer),
  });

  /**
   * Stores an accepted capture.
   *
   * The suggested tags are resolved against the live catalogue as they are
   * applied, so a tag that was created while the prompt was open is matched
   * rather than shadowed by a second copy of itself.
   */
  const saveCapture = useCallback(
    async (offer: PendingCapture) => {
      const draft = captureToDraft(offer.capture, offer.insight);
      let catalogue = prefs.tags;
      const tagIds: string[] = [];

      for (const suggestion of offer.insight.suggestedTags) {
        if (suggestion.id) {
          // Guard against a tag that was deleted while the prompt was open.
          if (catalogue.some((tag) => tag.id === suggestion.id)) {
            tagIds.push(suggestion.id);
            continue;
          }
        }
        const similar = findSimilarTag(suggestion.name, catalogue.map((tag) => ({ id: tag.id, name: tag.name })));
        if (similar) {
          tagIds.push(similar.id);
          continue;
        }
        const created = createTag(suggestion.name, catalogue);
        catalogue = [...catalogue, created];
        tagIds.push(created.id);
      }

      const channels = [...prefs.channels];
      // Auto-created channels only apply to a brand new tag, and only when the
      // user asked for that behaviour.
      if (prefs.autoTagChannel) {
        for (const tagId of tagIds) {
          if (!channels.some((channel) => channel.tagIds.includes(tagId))) {
            const tag = catalogue.find((entry) => entry.id === tagId);
            if (tag) channels.push(createChannel(tag.name, { kind: 'tags', tagIds: [tag.id], hue: tag.hue }));
          }
        }
      }

      await vault.mutate(() => vault.service.addItem({ ...draft, tags: tagIds }));
      await vault.updatePrefs({ tags: catalogue, channels });
      notify(`Saved ${draft.title}`);
    },
    [notify, prefs.autoTagChannel, prefs.channels, prefs.tags, vault],
  );

  // Optional lock triggers for shared machines.
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    if (prefs.lockOnBlur) {
      const onBlur = () => vault.lock();
      window.addEventListener('blur', onBlur);
      return () => window.removeEventListener('blur', onBlur);
    }
  }, [prefs.lockOnBlur, vault.status, vault]);

  useEffect(() => {
    if (vault.status !== 'unlocked' || !prefs.lockOnHidden) return;
    const onVisibility = () => {
      if (document.hidden) vault.lock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [prefs.lockOnHidden, vault.status, vault]);

  const cycleView = useCallback(
    (current: VaultView) => {
      const order: VaultView[] = ['animated', 'carousel', 'basic'];
      void vault.updatePrefs({ view: order[(order.indexOf(current) + 1) % order.length] as VaultView });
    },
    [vault],
  );

useHotkeys(
    {
      '/': () => search.current?.focus(),
      n: () => setEditing('new'),
      l: () => vault.lock(),
      v: () => cycleView(vault.prefs.view),
      '?': () => setShowShortcuts(true),
      // Undo/redo. useHotkeys ignores events carrying ctrl/meta, so these are
      // bound separately below rather than through the map above.
      escape: () => {
        setEditing(null);
        setConfirmDelete(null);
        setShowShortcuts(false);
      },
    },
    {
      enabled:
        vault.status === 'unlocked' && !editing && !confirmDelete && !showShortcuts && !showSettings && !menu,
    },
  );

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Bound here because useHotkeys deliberately
  // ignores modified keystrokes, which would otherwise swallow them.
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      // Never steal the shortcut from a text field the user is typing in.
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('input, textarea, [contenteditable="true"]') &&
        !(target instanceof HTMLInputElement && target.type === 'range')
      ) {
        return;
      }
      event.preventDefault();
      const redo = key === 'y' || event.shiftKey;
      void (redo ? vault.redo() : vault.undo()).then((changed) => {
        if (changed) notify(redo ? 'Redone' : 'Undone');
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [vault, notify]);

const duplicateIds = useMemo(() => findReusedPasswords(vault.items), [vault.items]);

// Normalised on read so the list is never empty, even for the first render
  // before stored preferences have loaded.
  const channels = useMemo(() => normaliseChannels(prefs.channels), [prefs.channels]);
  const folders = prefs.folders;
  const sidebarBase = useMemo(() => {
    // Stored tree, with the dashboard channel pinned to the top.
    const entries = normaliseSidebar(prefs.sidebar, channels, folders);
    const dashboardIndex = entries.findIndex(
      (entry) => entry.kind === 'channel' && channels.find((channel) => channel.id === entry.id)?.kind === 'dashboard',
    );
    if (dashboardIndex > 0) {
      const [dashboard] = entries.splice(dashboardIndex, 1);
      entries.unshift(dashboard!);
    }
    if (prefs.showUnassignedChannel) {
      entries.push({ kind: 'channel', id: UNASSIGNED.id });
    }
    return entries;
  }, [prefs.sidebar, channels, folders, prefs.showUnassignedChannel]);

  const channelLookup = useMemo(() => [...channels, UNASSIGNED], [channels]);

  const activeFolder = useMemo(
    () => (activeId.startsWith('folder:') ? folders.find((folder) => folder.id === activeId.slice('folder:'.length)) ?? null : null),
    [folders, activeId],
  );
  const activeChannel = useMemo(() => {
    if (activeFolder) return null;
    return channelLookup.find((channel) => channel.id === activeId) ?? channelLookup.find((c) => c.kind === 'all') ?? channels[0]!;
  }, [channelLookup, activeId, activeFolder, channels]);

/** How long a password may go unchanged before the weak/stale view counts it. */
  const staleDays = prefs.passwordAgeDays;

/** Keyed by channel id, for the sidebar badges. The dashboard is a summary
   *  screen rather than a filtered list, so it gets no count. Folders sum
   *  their children. */
  const channelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const channel of channelLookup) {
      if (channel.kind === 'dashboard') continue;
      counts[channel.id] = applyChannel(channel, vault.items, staleDays).length;
    }
    for (const folder of folders) {
      const entry = sidebarBase.find((row) => row.kind === 'folder' && row.id === folder.id);
      if (entry && entry.kind === 'folder') {
        counts[`folder:${folder.id}`] = entry.children.reduce(
          (total, child) => (child.kind === 'channel' ? total + (counts[child.id] ?? 0) : total),
          0,
        );
      }
    }
    return counts;
  }, [channelLookup, vault.items, staleDays, folders, sidebarBase]);

  // A channel carries its own accent and image, so the app re-skins while it is
  // selected. Anything the channel leaves blank falls back to the preference.
  const getParentFolderForChannel = useCallback(
    (id: string): Folder | undefined => {
      for (const row of sidebarBase) {
        if (row.kind !== 'folder') continue;
        if (row.children.some((c) => c.kind === 'channel' && c.id === id)) {
          return folders.find((f) => f.id === row.id);
        }
      }
      return undefined;
    },
    [sidebarBase, folders],
  );

  const contextForAppearance = useMemo(() => {
    if (activeFolder) return activeFolder;
    if (activeChannel) {
      const pf = getParentFolderForChannel(activeChannel.id);
      if (pf && (pf.backgroundImage || pf.accent !== prefs.accent)) return pf;
      return activeChannel;
    }
    return null;
  }, [activeFolder, activeChannel, getParentFolderForChannel, folders, prefs.accent]);

  const channelIsCustom = contextForAppearance
    ? contextForAppearance.accent !== prefs.accent || Boolean(contextForAppearance.backgroundImage)
    : false;
  useEffect(() => {
    if (channelIsCustom && contextForAppearance) {
      applyChannelAppearance(prefs, contextForAppearance as unknown as Channel);
    } else {
      applyAppearance(prefs);
    }
  }, [contextForAppearance, prefs, channelIsCustom]);

  // Extra factor gating a folder, remembered per session. Computed now that
  // activeFolder exists.
  const folderLocked = Boolean(
    activeFolder && isSecured(activeFolder.security) && !foldersUnlocked.has(activeFolder.id),
  );

const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    // A query searches the whole vault rather than just the active channel, so
    // the sidebar filter does not silently hide the thing you searched for. The
    // channel only narrows the list when nothing is typed.
    let list: VaultItem[];
    if (activeFolder) {
      const entry = sidebarBase.find((row) => row.kind === 'folder' && row.id === activeFolder.id);
      const seen = new Set<string>();
      list = [];
      if (entry && entry.kind === 'folder') {
        for (const child of entry.children) {
          if (child.kind !== 'channel') continue;
          const channel = channelLookup.find((candidate) => candidate.id === child.id);
          if (!channel) continue;
          for (const item of applyChannel(channel, vault.items, staleDays)) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              list.push(item);
            }
          }
        }
      }
    } else {
      list = needle ? vault.items : applyChannel(activeChannel!, vault.items, staleDays);
    }

    const sorted = [...list].sort((a, b) => {
      const pin = prefs.pinFavorites ? Number(b.favorite) - Number(a.favorite) : 0;
      if (pin !== 0) return pin;
      switch (prefs.sort) {
        case 'recent':
          return b.updatedAt - a.updatedAt;
        case 'oldest':
          return a.updatedAt - b.updatedAt;
        case 'strength':
          return estimateStrength(a.password).bits - estimateStrength(b.password).bits;
        case 'username':
          return (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase());
        default:
          return (a.title || '~').toLowerCase().localeCompare((b.title || '~').toLowerCase());
      }
    });

    if (!needle) return sorted;
    return sorted.filter((item) =>
      [item.title, item.username, item.url, item.notes].some((field) =>
        (field ?? '').toLowerCase().includes(needle),
      ),
    );
  }, [vault.items, activeChannel, activeFolder, sidebarBase, channelLookup, query, prefs.sort, prefs.pinFavorites, staleDays]);

  /* ---- Channel editing -------------------------------------------------- */

  const saveChannel = useCallback(
    (next: Channel) => {
      const exists = channels.some((channel) => channel.id === next.id);
      const nextChannels = exists
        ? channels.map((channel) => (channel.id === next.id ? next : channel))
        : [...channels, next];
      // A new channel appears at the end of the sidebar tree.
      let nextSidebar = exists ? sidebarBase : [...sidebarBase, { kind: 'channel', id: next.id } as SidebarEntry];
      if (!exists && newChannelFolder) {
        nextSidebar = moveChannelToFolder(nextSidebar, next.id, newChannelFolder);
        setNewChannelFolder(null);
      }
      void vault.updatePrefs({ channels: nextChannels, sidebar: nextSidebar });
      if (!exists) {
        setActiveId(next.id);
        notify(`Channel "${next.name}" added`);
      } else {
        notify(`Channel "${next.name}" updated`);
      }
    },
    [channels, vault, notify, sidebarBase, newChannelFolder],
  );

  const deleteChannel = useCallback(
    (id: string) => {
      const target = channels.find((channel) => channel.id === id);
      if (!target || target.locked) return;
      void vault.updatePrefs({
        channels: channels.filter((channel) => channel.id !== id),
        sidebar: stripChannel(sidebarBase, id),
      });
      if (activeId === id) setActiveId('all');
      notify(`Channel "${target.name}" removed`);
    },
    [channels, vault, activeId, notify, sidebarBase],
  );

  const saveFolder = useCallback(
    (next: Folder) => {
      const exists = folders.some((folder) => folder.id === next.id);
      const nextFolders = exists ? folders.map((folder) => (folder.id === next.id ? next : folder)) : [...folders, next];
      const nextSidebar = exists
        ? sidebarBase
        : [...sidebarBase, { kind: 'folder', id: next.id, children: [] } as SidebarEntry];
      void vault.updatePrefs({ folders: nextFolders, sidebar: nextSidebar });
      notify(exists ? `Folder "${next.name}" updated` : `Folder "${next.name}" added`);
    },
    [folders, sidebarBase, vault, notify],
  );

  const deleteFolder = useCallback(
    (id: string) => {
      const folder = folders.find((entry) => entry.id === id);
      if (!folder) return;
      // Children are promoted to the root so nothing is lost.
      const entry = sidebarBase.find((row) => row.kind === 'folder' && row.id === id);
      const children = entry && entry.kind === 'folder' ? entry.children : [];
      const nextSidebar = sidebarBase
        .map((row) => (row.kind === 'folder' && row.id === id ? null : row))
        .filter(Boolean) as SidebarEntry[];
      nextSidebar.push(...children);
      void vault.updatePrefs({ folders: folders.filter((entry) => entry.id !== id), sidebar: nextSidebar });
      if (activeId === `folder:${id}`) setActiveId('all');
      notify(`Folder "${folder.name}" removed`);
    },
    [folders, sidebarBase, vault, activeId, notify],
  );

  const toggleFolderCollapse = useCallback(
    (id: string) => {
      void vault.updatePrefs({
        folders: folders.map((folder) => (folder.id === id ? { ...folder, collapsed: !folder.collapsed } : folder)),
      });
    },
    [folders, vault],
  );

  const moveChannel = useCallback(
    (channelId: string, folderId: string | null) => {
      void vault.updatePrefs({ sidebar: moveChannelToFolder(sidebarBase, channelId, folderId) });
    },
    [sidebarBase, vault],
  );

  const insertSeparatorAt = useCallback(
    (rows: SidebarEntry[], anchorId: string): SidebarEntry[] =>
      rows.flatMap((entry) => {
        if (entry.id === anchorId) return [{ kind: 'separator', id: `sep_${Math.random().toString(36).slice(2, 8)}` }, entry];
        if (entry.kind === 'folder') return [{ ...entry, children: insertSeparatorAt(entry.children, anchorId) }];
        return [entry];
      }),
    [],
  );

  const addSeparator = useCallback(
    (anchorEntryId?: string) => {
      if (!anchorEntryId) {
        void vault.updatePrefs({ sidebar: addSeparatorAtEnd(sidebarBase) });
        return;
      }
      const next = insertSeparatorAt(sidebarBase, anchorEntryId);
      void vault.updatePrefs({ sidebar: next });
    },
    [sidebarBase, vault, insertSeparatorAt],
  );

  const removeSeparator = useCallback(
    (id: string) => {
      const strip = (rows: SidebarEntry[]): SidebarEntry[] =>
        rows
          .filter((row) => !(row.kind === 'separator' && row.id === id))
          .map((row) => (row.kind === 'folder' ? { ...row, children: strip(row.children) } : row));
      void vault.updatePrefs({ sidebar: strip(sidebarBase) });
    },
    [sidebarBase, vault],
  );

  /** Sidebar right-click on empty space: offer to create or reshape channels. */
  const newChannelMenu = useCallback((): MenuItem[] => {
    return [
      { kind: 'item', label: 'Channels', icon: <LayersIcon />, disabled: true },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'New channel.',
        icon: <PlusIcon />,
        onSelect: () => setEditingChannel('new'),
      },
      {
        kind: 'item',
        label: 'New folder.',
        icon: <PlusIcon />,
        onSelect: () => setEditingFolder('new'),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'New separator',
        icon: <RowsIcon />,
        onSelect: () => void vault.updatePrefs({ sidebar: addSeparatorAtEnd(sidebarBase) }),
      },
      {
        kind: 'item',
        label: 'Manage channels',
        icon: <RowsIcon />,
        onSelect: () => openSettings('channels'),
      },
      {
        kind: 'submenu',
        label: 'Channel layout',
        icon: <LayersIcon />,
        items: [
          { kind: 'item' as const, label: 'Icons and names', checked: prefs.sidebarLabels === 'both', onSelect: () => void vault.updatePrefs({ sidebarLabels: 'both' }) },
          { kind: 'item' as const, label: 'Icons only', checked: prefs.sidebarLabels === 'icon', onSelect: () => void vault.updatePrefs({ sidebarLabels: 'icon' }) },
          { kind: 'item' as const, label: 'Names only', checked: prefs.sidebarLabels === 'name', onSelect: () => void vault.updatePrefs({ sidebarLabels: 'name' }) },
        ],
      },
      {
        kind: 'submenu',
        label: 'Rail position',
        icon: <GridIcon />,
        items: (['left', 'right', 'top', 'bottom'] as const).map((position) => ({
          kind: 'item' as const,
          label: POSITION_LABELS[position],
          checked: prefs.sidebarPosition === position,
          onSelect: () => void vault.updatePrefs({ sidebarPosition: position }),
        })),
      },
      {
        kind: 'item',
        label: 'Card appearance…',
        icon: <StarIcon />,
        onSelect: () => setShowTuner(true),
      },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Quick add',
        icon: <StarIcon />,
        items: [
          { kind: 'favorites', label: 'Favorites' },
          { kind: 'attention', label: 'Needs attention' },
          { kind: 'weak', label: 'Weak or reused' },
        ].map((option) => ({
          kind: 'item' as const,
          label: option.label,
          icon:
            option.kind === 'favorites' ? <StarIcon /> : option.kind === 'attention' ? <FlagIcon /> : <ShieldIcon />,
          onSelect: () => {
            const exists = channels.find((channel) => channel.kind === option.kind);
            if (exists) {
              setActiveId(exists.id);
              return;
            }
            saveChannel(createChannel(option.label, { kind: option.kind as Channel['kind'] }));
          },
        })),
      },
    ];
  }, [sidebarBase, channels, saveChannel, vault, setEditingChannel, setEditingFolder, openSettings, setActiveId]);

  /**
   * Removes a deleted tag from every login that referenced it.
   *
   * Logins hold their own copy of the tag list, so dropping the tag from the
   * catalogue alone would leave a dangling id that no UI can ever clear.
   */
  const scrubTag = useCallback(
    async (tagId: string) => {
      const affected = vault.items.filter((item) => item.tags.includes(tagId));
      if (affected.length === 0) return;
      for (const item of affected) {
        await vault.service.updateItem(item.id, { tags: item.tags.filter((id) => id !== tagId) });
      }
      await vault.mutate(async () => {});
      notify(`Tag removed from ${affected.length} login${affected.length === 1 ? '' : 's'}`);
    },
    [vault, notify],
  );

  /** Sidebar right-click: quick actions for one channel, then the full editor. */
  const channelMenu = useCallback(
    (channel: Channel): MenuItem[] => {
      const label = channel.name;
      return [
        { kind: 'item', label, icon: <LayersIcon />, disabled: true },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Open',
          icon: <InboxIcon />,
          onSelect: () => setActiveId(channel.id),
        },
        {
          kind: 'item',
          label: 'Edit channel…',
          icon: <EditIcon />,
          shortcut: 'right click',
          onSelect: () => setEditingChannel(channel.id),
        },
        {
          kind: 'submenu',
          label: 'Change colour',
          icon: <PaletteIcon />,
          items: CHANNEL_ACCENTS.map((accent) => ({
            kind: 'item' as const,
            label: accent[0]!.toUpperCase() + accent.slice(1),
            checked: channel.accent === accent,
            onSelect: () => {
              saveChannel({ ...channel, accent });
              notify(`${label} now uses the ${accent} theme`);
            },
          })),
        },
        {
          kind: 'submenu',
          label: 'Change icon',
          icon: <GridIcon />,
          items: CHANNEL_ICONS.map((icon) => ({
            kind: 'item' as const,
            label: icon[0]!.toUpperCase() + icon.slice(1),
            checked: channel.icon === icon,
            onSelect: () => saveChannel({ ...channel, icon }),
          })),
        },
        {
          kind: 'submenu',
          label: 'Show',
          icon: <RowsIcon />,
          items: [
            { kind: 'all', label: 'Everything', icon: <InboxIcon /> },
            { kind: 'favorites', label: 'Favorites', icon: <StarIcon /> },
            { kind: 'attention', label: 'Needs attention', icon: <FlagIcon /> },
            { kind: 'weak', label: 'Weak or reused', icon: <ShieldIcon /> },
          ].map((option) => ({
            kind: 'item' as const,
            label: option.label,
            checked: channel.kind === option.kind,
            icon: option.icon,
            onSelect: () => saveChannel({ ...channel, kind: option.kind as Channel['kind'] }),
          })),
        },
        ...(prefs.tags.length > 0
          ? [
              {
                kind: 'submenu' as const,
                label: 'Filter by tag',
                icon: <TagIcon />,
                items: prefs.tags.map((tag) => ({
                  kind: 'item' as const,
                  label: tag.name,
                  checked: channel.tagIds.includes(tag.id),
                  onSelect: () =>
                    saveChannel({
                      ...channel,
                      tagIds: channel.tagIds.includes(tag.id)
                        ? channel.tagIds.filter((id) => id !== tag.id)
                        : [...channel.tagIds, tag.id],
                    }),
                })),
              },
            ]
          : []),
        { kind: 'separator' },
        {
          kind: 'submenu',
          label: 'Move to folder',
          icon: <LayersIcon />,
          items: [
            { kind: 'item' as const, label: 'Root', checked: !parentFolderIdOf(channel.id), onSelect: () => moveChannel(channel.id, null) },
            ...folders.map((folder) => ({
              kind: 'item' as const,
              label: folder.name,
              checked: parentFolderIdOf(channel.id) === folder.id,
              onSelect: () => moveChannel(channel.id, folder.id),
            })),
          ],
        },
        {
          kind: 'item',
          label: 'Add separator above',
          icon: <RowsIcon />,
          onSelect: () => addSeparator(channel.id),
        },
        {
          kind: 'item',
          label: 'New channel…',
          icon: <PlusIcon />,
          onSelect: () => setEditingChannel('new'),
        },
        {
          kind: 'item',
          label: channel.locked ? 'Cannot be deleted' : 'Delete channel',
          icon: <TrashIcon />,
          danger: true,
          disabled: channel.locked,
          onSelect: () => deleteChannel(channel.id),
        },
      ];
    },
    [prefs.tags, folders, saveChannel, deleteChannel, notify, moveChannel, addSeparator],
  );

  const parentFolderIdOf = useCallback(
    (channelId: string): string | null => {
      const entry = sidebarBase.find(
        (row) => row.kind === 'folder' && row.children.some((child) => (child.kind === 'channel' || child.kind === 'separator') && child.id === channelId),
      );
      if (entry && entry.kind === 'folder') return entry.id;
      return null;
    },
    [sidebarBase],
  );

  const folderMenu = useCallback(
    (folder: Folder): MenuItem[] => [
      { kind: 'item', label: folder.name, icon: <LayersIcon />, disabled: true },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Open',
        icon: <InboxIcon />,
        onSelect: () => setActiveId(`folder:${folder.id}`),
      },
      {
        kind: 'item',
        label: 'Edit folder…',
        icon: <EditIcon />,
        onSelect: () => setEditingFolder(folder.id),
      },
      {
        kind: 'item',
        label: folder.collapsed ? 'Expand' : 'Collapse',
        icon: <RowsIcon />,
        onSelect: () => toggleFolderCollapse(folder.id),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'New channel in this folder…',
        icon: <PlusIcon />,
        onSelect: () => {
          setNewChannelFolder(folder.id);
          setEditingChannel('new');
        },
      },
      {
        kind: 'item',
        label: 'Remove folder',
        icon: <TrashIcon />,
        danger: true,
        onSelect: () => deleteFolder(folder.id),
      },
    ],
    [deleteFolder, toggleFolderCollapse],
  );

  const separatorMenu = useCallback(
    (entryId: string): MenuItem[] => [
      { kind: 'item', label: 'Separator', icon: <RowsIcon />, disabled: true },
      { kind: 'separator' },
      // A separator is an ordinary sidebar entry, so it gets the same
      // move-to-folder treatment a channel does rather than being root-only.
      {
        kind: 'submenu',
        label: 'Move to folder',
        icon: <LayersIcon />,
        items: [
          { kind: 'item' as const, label: 'Root', checked: !parentFolderIdOf(entryId), onSelect: () => moveChannel(entryId, null) },
          ...folders.map((folder) => ({
            kind: 'item' as const,
            label: folder.name,
            checked: parentFolderIdOf(entryId) === folder.id,
            onSelect: () => moveChannel(entryId, folder.id),
          })),
        ],
      },
      {
        kind: 'item',
        label: 'Remove separator',
        icon: <TrashIcon />,
        danger: true,
        onSelect: () => removeSeparator(entryId),
      },
    ],
    [removeSeparator, moveChannel, parentFolderIdOf, folders],
  );

  /* ---- Item actions ---------------------------------------------------- */

  const openItem = useCallback(
    (item: VaultItem) => {
      if (!item.password) {
        notify(`${item.title || 'That login'} has no password saved`, 'error');
        return;
      }
      if (prefs.warnOnReuse && duplicateIds.has(item.password) && vault.items.length > 1) {
        setConfirmDelete({ ...item, notes: '__reuse__' });
        return;
      }
      void copy(item.password, 'Password');
    },
    [copy, notify, prefs.warnOnReuse, duplicateIds, vault.items.length],
  );

  const toggleFavorite = useCallback(
    async (item: VaultItem) => {
      await vault.mutate(() => vault.service.updateItem(item.id, { favorite: !item.favorite }));
    },
    [vault],
  );

  const toggleAttention = useCallback(
    async (item: VaultItem) => {
      await vault.mutate(() =>
        vault.service.updateItem(item.id, { needsAttention: !item.needsAttention }),
      );
    },
    [vault],
  );

  const requestDelete = useCallback(
    (item: VaultItem) => {
      if (prefs.confirmDeletes) setConfirmDelete(item);
      else void vault.mutate(() => vault.service.deleteItem(item.id));
    },
    [prefs.confirmDeletes, vault],
  );

  const openUrl = useCallback((item: VaultItem) => {
    if (!item.url) return;
    const host = hostnameOf(item.url);
    notify(`Opening ${host ?? 'site'}${prefs.warnOnReuse && duplicateIds.has(item.password) ? ' — password is reused' : ''}`, prefs.warnOnReuse && duplicateIds.has(item.password) ? 'error' : 'ok');
    window.open(item.url, '_blank', 'noopener');
  }, [notify, prefs.warnOnReuse, duplicateIds]);

  /**
   * Opens the editor, but only once the login's second factor is cleared.
   *
   * Every route into the editor funnels through here — double-click, the row
   * menu, the keyboard shortcut — because the editor shows the password in a
   * plain input. Left ungated, adding recovery questions to a login protected
   * nothing: the editor still handed over the password on the next double-click.
   * A login with no factor set is unaffected.
   */
  const requestEdit = useCallback(
    (item: VaultItem) => {
      if (requiresVerification(item.security) && !verifiedItems.has(item.id)) {
        setPendingIntent('edit');
        setPendingItem(item);
        return;
      }
      setEditing(item);
    },
    [verifiedItems],
  );

  /** Clears the gate and then opens the editor the user was trying to reach. */
  const completeGate = useCallback(() => {
    const item = pendingItem;
    if (!item) return;
    setVerifiedItems((current) => new Set(current).add(item.id));
    setPendingItem(null);
    setEditing(item);
  }, [pendingItem]);

  const viewActions: ViewActions = {
    onCopy: copy,
    onSelect: openItem,
    onEdit: requestEdit,
    onDelete: requestDelete,
    onToggleFavorite: (item) => void toggleFavorite(item),
    onToggleAttention: (item) => void toggleAttention(item),
tags: prefs.tags,
    showTagChips: prefs.showTagChips,
    onOpenUrl: openUrl,
    onItemMenu: (event, item) => {
      event.preventDefault();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: itemMenu(item),
      });
    },
  };

  const itemMenu = useCallback(
    (item: VaultItem): MenuItem[] => {
      const host = hostnameOf(item.url);
      const reused = duplicateIds.has(item.password) && item.password !== '';
      return [
        {
          kind: 'item',
          label: 'Copy password',
          icon: <KeyIcon />,
          shortcut: 'click',
          disabled: !item.password,
          onSelect: () => void copy(item.password, 'Password'),
        },
        {
          kind: 'item',
          label: 'Copy username',
          icon: <CopyIcon />,
          disabled: !item.username,
          onSelect: () => void copy(item.username, 'Username'),
        },
        {
          kind: 'item',
          label: 'Copy URL',
          icon: <ExternalIcon />,
          disabled: !item.url,
          onSelect: () => void copy(item.url, 'URL'),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: item.favorite ? 'Remove from favorites' : 'Add to favorites',
          icon: <StarIcon />,
          onSelect: () => void toggleFavorite(item),
        },
        {
          kind: 'item',
          label: 'Edit login',
          icon: <EditIcon />,
          onSelect: () => setEditing(item),
        },
        {
          kind: 'submenu',
          label: 'Open',
          icon: <ExternalIcon />,
          disabled: !item.url,
          items: [
            {
              kind: 'item',
              label: host ?? 'Website',
              icon: <ExternalIcon />,
              disabled: !item.url,
              onSelect: () => openUrl(item),
            },
            ...(reused
              ? [{ kind: 'item' as const, label: 'Note: password is reused', disabled: true }]
              : []),
          ],
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Delete login',
          icon: <TrashIcon />,
          danger: true,
          onSelect: () => requestDelete(item),
        },
      ];
    },
    [copy, duplicateIds, toggleFavorite, openUrl, requestDelete],
  );

  const appMenu = useCallback((): MenuItem[] => {
    return [
      {
        kind: 'item',
        label: 'New login',
        icon: <PlusIcon />,
        shortcut: 'N',
        onSelect: () => setEditing('new'),
      },
{
        kind: 'submenu',
        label: 'Switch view',
        icon: <LayersIcon />,
        heading: 'View',
        items: (['animated', 'carousel', 'basic'] as VaultView[]).map((id) => ({
          kind: 'item' as const,
          label: { animated: 'Flow', carousel: 'Orbit', basic: 'List' }[id],
          checked: view === id,
          icon: id === 'carousel' ? <GridIcon /> : id === 'basic' ? <RowsIcon /> : <LayersIcon />,
          onSelect: () => void vault.updatePrefs({ view: id }),
        })),
      },
{
        kind: 'submenu',
        label: 'Sort by',
        icon: <RowsIcon />,
        heading: 'Sort order',
        items: (Object.keys(SORT_LABELS) as SortMode[]).map((id) => ({
          kind: 'item' as const,
          label: SORT_LABELS[id],
          checked: prefs.sort === id,
          onSelect: () => void vault.updatePrefs({ sort: id }),
        })),
      },
      {
        kind: 'submenu',
        label: 'Appearance',
        icon: <SunIcon />,
        items: [
          ...(['slate', 'sage', 'dusk', 'clay'] as const).map((accent) => ({
            kind: 'item' as const,
            label: accent[0]!.toUpperCase() + accent.slice(1),
            checked: prefs.accent === accent,
            onSelect: () => void vault.updatePrefs({ accent }),
          })),
          { kind: 'separator' as const },
          ...(['light', 'dark', 'system'] as const).map((theme) => ({
            kind: 'item' as const,
            label: theme[0]!.toUpperCase() + theme.slice(1),
            checked: prefs.theme === theme,
            icon: theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : undefined,
            onSelect: () => void vault.updatePrefs({ theme }),
          })),
{ kind: 'separator' as const },
          {
            kind: 'item' as const,
            label: prefs.motion > 0 ? 'Reduce animation' : 'Enable animation',
            checked: prefs.motion === 0,
            onSelect: () => void vault.updatePrefs({ motion: prefs.motion > 0 ? 0 : 1 }),
          },
        ],
      },
      { kind: 'separator' },
      {
        kind: 'item',
label: 'Settings',
        icon: <SettingsIcon />,
        onSelect: () => openSettings(),
      },
      {
        kind: 'item',
        label: 'Keyboard shortcuts',
        icon: <KeyboardIcon />,
        shortcut: '?',
        onSelect: () => setShowShortcuts(true),
      },
      {
        kind: 'item',
        label: 'Lock vault',
        icon: <LockIcon />,
        shortcut: 'L',
        onSelect: () => vault.lock(),
      },
    ];
  }, [view, prefs, vault]);

  // Suppress the native menu everywhere and open ours instead.
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
// Let the browser handle it inside text fields and dialogs. The sidebar
      // has its own channel menu, so it opts out of the generic one here.
      if (
        target?.closest('input, textarea, [contenteditable="true"], .ctx-menu, .settings-window, .modal, .sidebar')
      ) {
        return;
      }
      event.preventDefault();
      const itemEl = target?.closest('[data-vault-item]') as HTMLElement | null;
      if (itemEl) {
        const id = itemEl.dataset.vaultItem;
        const item = vault.items.find((entry) => entry.id === id);
        if (item) {
          setMenu({ x: event.clientX, y: event.clientY, items: itemMenu(item) });
          return;
        }
      }
      setMenu({ x: event.clientX, y: event.clientY, items: appMenu() });
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, [vault.status, vault.items, vault, itemMenu, appMenu]);

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    void vault.updatePrefs({ theme: next });
  };

  // The preference can be "system", so the toggle label has to follow whatever
  // is actually on screen rather than the stored preference.
  const resolvedTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  /* ---- Boot / storage failure ----------------------------------------- */

  if (vault.boot.kind === 'failed') {
    return (
      <>
        <Ambient strength={prefs.ambient} />
        <div className="lock">
          <div className="lock__card">
            <div className="lock__brand">
              <div className="lock__mark" style={{ background: 'var(--danger)' }}>
                <AlertIcon width="28" height="28" />
              </div>
              <div>
                <h1 className="lock__title">Storage unavailable</h1>
                <p className="lock__hint">{vault.boot.message}</p>
              </div>
            </div>
            <Alert tone="danger">
              Colax keeps your vault in this browser&apos;s local storage. If storage is blocked there is
              nowhere safe to put your passwords, so the app stops here rather than pretending.
            </Alert>
            <button className="btn btn--primary btn--block" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </>
    );
  }

  if (vault.status === 'loading') {
    return (
      <>
        <Ambient strength={prefs.ambient} />
        <div className="lock">
          <span className="spinner" style={{ width: 24, height: 24 }} />
        </div>
      </>
    );
  }

  if (vault.status !== 'unlocked') {
    return (
      <>
        <Ambient strength={prefs.ambient} />
        <LockScreen
          mode={vault.status === 'absent' ? 'create' : 'unlock'}
          protection={vault.protection}
          onUnlock={vault.unlock}
onCreate={vault.create}
          onToggleTheme={toggleTheme}
          theme={resolvedTheme}
          persistent={vault.persistent}
          onNotify={notify}
        />
        <Toasts toasts={toasts} />
      </>
    );
  }

  // A second factor on the vault itself gates the main screen.
  if (isSecured(prefs.vaultSecurity) && !vaultVerified) {
    return (
      <>
        <Ambient strength={prefs.ambient} />
        <SecurityGate
          security={prefs.vaultSecurity}
          title="Vault verification"
          hint="The vault is open, but this account added a second factor. Prove it is you."
          onVerified={() => setVaultVerified(true)}
          onCancel={() => vault.lock()}
        />
        <Toasts toasts={toasts} />
      </>
    );
  }

  const showEmpty = visible.length === 0;
  // A reuse warning masquerades as a delete dialog; treat it separately.
  const reuseWarning = confirmDelete?.notes === '__reuse__' ? confirmDelete : null;
  const pendingDelete = reuseWarning ? null : confirmDelete;

const commonProps = {
    items: visible,
    duplicateIds,
    showHealthBadges: prefs.showHealthBadges,
    showUrls: prefs.showUrls,
    staleDays,
    showLetterGroups: prefs.showLetterGroups,
    // Each view reads its own slice, so tuning Orbit never resizes Flow.
    cardSize: prefs.cardSize[view],
    ...viewActions,
  };

  // Tag chips and orbit labels are per-view toggles rather than common ones, so
  // they are passed only to the views that actually read them.
  const cardProps = { tags: prefs.tags, showTagChips: prefs.showTagChips };

  return (
    <>
      <Ambient strength={prefs.ambient} />

      <div
        className="shell"
        data-compact-sidebar={prefs.compactSidebar || undefined}
        data-floating={prefs.floatingChrome || undefined}
        data-rail={prefs.sidebarPosition}
        data-labels={prefs.sidebarLabels}
      >
        <Sidebar
          entries={sidebarBase}
          channels={channelLookup}
          folders={folders}
          activeId={activeId}
          counts={channelCounts}
          compact={prefs.compactSidebar}
          labels={prefs.sidebarLabels}
          onSelect={setActiveId}
          onReorder={(next) => void vault.updatePrefs({ sidebar: next })}
          onToggleFolder={toggleFolderCollapse}
          onChannelMenu={(event, channel) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: channelMenu(channel) });
          }}
          onFolderMenu={(event, folder) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: folderMenu(folder) });
          }}
          onSeparatorMenu={(event, entryId) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: separatorMenu(entryId) });
          }}
          onBackgroundMenu={(event) => {
            setMenu({ x: event.clientX, y: event.clientY, items: newChannelMenu() });
          }}
          onNewChannel={() => setEditingChannel('new')}
          onToggleCompact={() => void vault.updatePrefs({ compactSidebar: !prefs.compactSidebar })}
          showShortcuts={prefs.showShortcuts}
          showLock={prefs.showLockButton}
          floating={prefs.floatingChrome}
          onOpenSettings={() => openSettings()}
          onOpenShortcuts={() => setShowShortcuts(true)}
          onLock={() => {
            vault.lock();
            if (prefs.clearClipboardOnLock) void navigator.clipboard.writeText('').catch(() => {});
          }}
        />

<main className="main">
          <header className="topbar">
            {/* The lead slot is a spacer: the icon moved under the search, so the
                left cell only has to balance the right one. */}
            <div className="topbar__lead" aria-hidden="true" />

            {/* Search and the brand icon share the centre column, the icon sitting
                directly beneath the field on the same centre line. */}
            <div className="topbar__centre">
              <div className="brand-subtitle">Colax</div>
              <div className="search">
                <SearchIcon className="search__icon" width="15" height="15" />
                <input
                  ref={search}
                  className="search__input"
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search logins"
                  aria-label="Search logins"
                />
                {query ? (
                  <button
                    className="search__clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery('');
                      search.current?.focus();
                    }}
                  >
                    <XIcon width="14" height="14" />
                  </button>
                ) : (
                  <span className="search__kbd">
                    <span className="kbd">/</span>
                  </span>
                )}
              </div>
            </div>

            <div className="topbar__actions">
              <ViewMenu value={view} onChange={(next) => void vault.updatePrefs({ view: next })} />
              <button className="btn btn--quiet" onClick={() => setEditing('new')}>
                <PlusIcon width="15" height="15" />
                New login
              </button>
            </div>
          </header>

{/* Flow and Orbit manage their own overflow. The dashboard is a normal
              scrolling page, so it must not inherit that. */}
          <div
            className="content"
            style={view !== 'basic' && activeChannel?.kind !== 'dashboard' ? { overflow: 'hidden' } : undefined}
          >
            {folderLocked && activeFolder ? (
              <SecurityGate
                security={activeFolder.security}
                title={`Open "${activeFolder.name}"`}
                hint="This folder has its own second factor."
                onVerified={() =>
                  setFoldersUnlocked((current) => new Set(current).add(activeFolder.id))
                }
                onCancel={() => setActiveId('all')}
              />
            ) : activeChannel?.kind === 'dashboard' ? (
              <div className="content__inner">
                <Dashboard
                  channels={channels}
                  tags={prefs.tags}
                  items={vault.items}
                  prefs={prefs}
                  onEditChannel={(channelId) => setEditingChannel(channelId)}
                  onNewChannel={() => setEditingChannel('new')}
                  onSelectChannel={(id) => setActiveId(id)}
                  onTagsChange={(tags) => {
                    // A new tag can become a channel automatically.
                    if (prefs.autoTagChannel && tags.length > prefs.tags.length) {
                      const fresh = tags.filter((tag) => !prefs.tags.some((old) => old.id === tag.id));
                      if (fresh.length > 0) {
                        const added = fresh.map((tag) =>
                          createChannel(tag.name, { kind: 'tags', tagIds: [tag.id], hue: tag.hue }),
                        );
                        void vault.updatePrefs({ tags, channels: [...channels, ...added] });
                        notify(`Channel created for ${fresh.length === 1 ? fresh[0]!.name : `${fresh.length} tags`}`);
                        return;
                      }
                    }
                    void vault.updatePrefs({ tags });
                  }}
                  onScrubTag={(tagId) => void scrubTag(tagId)}
                  onUpdate={(patch) => void vault.updatePrefs(patch)}
                  onNotify={notify}
                />
              </div>
            ) : showEmpty ? (
              <div className="content__inner">
                <ViewEmptyState query={query} screen={activeChannel ? activeChannel.id : `folder:${activeFolder?.id ?? ''}`} onAdd={() => setEditing('new')} />
              </div>
            ) : view === 'animated' ? (
              // data-flow-scroll bounds this wrapper to the content area. Without
              // a definite height here the AnimatedList's `height: 100%` resolves
              // against an auto-height parent, the inner scroll container grows
              // to fit its cards instead of scrolling, and its
              // `overscroll-behavior: contain` then swallows the wheel before it
              // can reach .content. The result is a list you cannot scroll at all.
              <div data-vault-list data-flow-scroll>
                <AnimatedListView {...commonProps} {...cardProps} />
              </div>
            ) : view === 'carousel' ? (
              <CarouselView {...commonProps} {...cardProps} showOrbitLabels={prefs.showOrbitLabels} />
            ) : (
              <div data-vault-list>
                <BasicView {...commonProps} {...cardProps} />
              </div>
            )}
          </div>
        </main>
      </div>

      <ContextMenu state={menu} onClose={() => setMenu(null)} />

<Settings
        open={showSettings}
        tab={settingsTab}
        onClose={() => setShowSettings(false)}
        hideDividers={prefs.hideDividers}
        prefs={prefs}
        service={vault.service}
        protection={vault.protection}
        items={vault.items}
        onUpdate={vault.updatePrefs}
        onNotify={notify}
        onLock={vault.lock}
        onEditChannel={(channelId) => setEditingChannel(channelId)}
        onScrubTag={(tagId) => void scrubTag(tagId)}
        onOpenTuner={(target) => {
          // Switching first means the sliders act on the view whose size the
          // user just clicked, not whichever view happened to be open.
          if (target && target !== view) void vault.updatePrefs({ view: target });
          setShowSettings(false);
          setShowTuner(true);
        }}
        onReset={async () => {
          await vault.service.reset();
          vault.clearHistory();
          setActiveId('all');
          setEditing(null);
          notify('Vault deleted from this device');
        }}
      />

      {pendingItem && requiresVerification(pendingItem.security) && !verifiedItems.has(pendingItem.id) ? (
        <SecurityGate
          security={pendingItem.security ?? EMPTY_SECURITY}
          title={pendingIntent === 'edit' ? `Unlock ${pendingItem.title || 'this login'}` : 'Show password'}
          hint={
            pendingIntent === 'edit'
              ? 'This login has a second factor. Clear it to open the editor.'
              : 'This login has a second factor. Clear it to reveal the password.'
          }
          onVerified={completeGate}
          onCancel={() => setPendingItem(null)}
        />
      ) : null}

      {editingFolder ? (
        <FolderEditor
          key={editingFolder}
          folder={editingFolder === 'new' ? null : folders.find((entry) => entry.id === editingFolder) ?? null}
          onSave={saveFolder}
          onDelete={deleteFolder}
          onClose={() => setEditingFolder(null)}
          onNotify={notify}
        />
      ) : null}

      {clipPending ? (
        <Modal
          title="Login found on the clipboard"
          onClose={dismissClip}
          footer={
            <>
              <button className="btn btn--secondary" onClick={dismissClip}>
                Not now
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  void vault
                    .mutate(() =>
                      vault.service.addItem({
                        title: clipPending.username.split('@')[0] ?? 'Clipboard login',
                        username: clipPending.username,
                        password: clipPending.password,
                        url: '',
                      }),
                    )
                    .then(() => notify('Saved from the clipboard'));
                  dismissClip();
                }}
              >
                Save to vault
              </button>
            </>
          }
        >
          <dl className="capture__fields">
            <dt>Username</dt>
            <dd>{clipPending.username}</dd>
            <dt>Password</dt>
            <dd>••••••••</dd>
          </dl>
          <p className="capture__note">Turn this off in Settings &gt; Security if it prompts too often.</p>
        </Modal>
      ) : null}

      {editingChannel ? (
        <ChannelEditor
          // Remount per channel so the draft always matches what is being edited.
          key={editingChannel}
          channel={editingChannel === 'new' ? null : channels.find((entry) => entry.id === editingChannel) ?? null}
          tags={prefs.tags}
          itemCount={
            editingChannel === 'new'
              ? vault.items.length
              : applyChannel(
                  channels.find((entry) => entry.id === editingChannel) ?? channels[0]!,
                  vault.items,
                ).length
          }
          onSave={saveChannel}
          onDelete={deleteChannel}
          onClose={() => setEditingChannel(null)}
          onNotify={notify}
        />
      ) : null}

      {showTuner ? (
        <AppearancePanel
          view={view}
          cardSize={prefs.cardSize[view]}
          accent={prefs.accent}
          onCardSizeChange={(next) => void vault.updatePrefs({ cardSize: { ...prefs.cardSize, [view]: next } })}
          onAccentChange={(next) => void vault.updatePrefs({ accent: next })}
          onClose={() => setShowTuner(false)}
        />
      ) : null}

{editing ? (
<ItemEditor
          item={editing === 'new' ? null : editing}
          tags={prefs.tags}
          onCommitTags={(next) => void vault.updatePrefs({ tags: next })}
          generatorOptions={prefs.passwordGenerator}
          onGeneratorOptionsChange={(next) => void vault.updatePrefs({ passwordGenerator: next })}
          verified={editing === 'new' || verifiedItems.has(editing.id)}
          onRequestUnlock={() => {
            // Reached only when the editor was opened for a secured login
            // without the gate being cleared, which the gate above is meant to
            // prevent. Clearing the factor marks the login verified for the
            // session, so the form unlocks rather than looping.
            if (editing && editing !== 'new') {
              setVerifiedItems((current) => new Set(current).add(editing.id));
            }
          }}
          onSave={async (draft) => {
            if (editing === 'new') {
              // Auto-tag the new login from its website and email provider.
              if (prefs.autoTagDomain) {
                let catalogue = prefs.tags;
                for (const suggestion of suggestTagsForDraft(draft)) {
                  const existing = findSimilarTag(suggestion.name, catalogue.map((tag) => ({ id: tag.id, name: tag.name })));
                  let tagId: string;
                  if (existing) {
                    tagId = existing.id;
                  } else {
                    const created = createTag(suggestion.name, catalogue);
                    catalogue = [...catalogue, created];
                    tagId = created.id;
                  }
                  if (!(draft.tags ?? []).includes(tagId)) {
                    draft = { ...draft, tags: [...(draft.tags ?? []), tagId] };
                  }
                }
                if (catalogue !== prefs.tags) await vault.updatePrefs({ tags: catalogue });
              }
              await vault.mutate(() => vault.service.addItem(draft));
              notify('Login added');
            } else if (editing) {
              await vault.mutate(() => vault.service.updateItem(editing.id, draft));
              notify('Login updated');
            }
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          onNotify={notify}
        />
      ) : null}

{/* A sign-up or sign-in from another tab, offered rather than taken. */}
      {capture.pending ? (
        <Modal
          title="Save this login?"
          onClose={capture.dismiss}
          footer={
            <>
              <button className="btn btn--secondary" onClick={capture.dismiss}>
                Not now
              </button>
              <button className="btn btn--primary" onClick={capture.accept}>
                Save to Colax
              </button>
            </>
          }
        >
          <div className="capture">
            <div className="capture__site">
              <span className="capture__name">{capture.pending.insight.siteName}</span>
              <span className="capture__host">{capture.pending.insight.host}</span>
            </div>

            <dl className="capture__fields">
              <dt>Username</dt>
              <dd>{capture.pending.capture.username || '—'}</dd>
              <dt>Password</dt>
              <dd className="capture__pw">
                {capture.pending.insight.passwordLooksFake ? 'Not captured' : '••••••••'}
              </dd>
            </dl>

            {/* What the site was recognised as, and where it will be filed. */}
            <div className="capture__tags">
              <span className="capture__tags-label">
                {capture.pending.insight.suggestedTags.length > 0 ? 'Tags' : 'No matching tag'}
              </span>
              {capture.pending.insight.suggestedTags.map((tag) => (
                <span
                  key={tag.name}
                  className={`chip ${tag.id ? 'chip--tag' : 'chip--tag chip--new'}`}
                  title={
                    tag.id
                      ? 'Using an existing tag'
                      : tag.reason === 'site'
                        ? 'Matched from the site'
                        : 'Taken from the email domain'
                  }
                >
                  {tag.name}
                  {tag.id ? '' : ' (new)'}
                </span>
              ))}
            </div>

            <p className="capture__note">
              Nothing is stored until you choose Save. Dismissing remembers the site and stops asking.
            </p>
          </div>
        </Modal>
      ) : null}

      {reuseWarning ? (
        <Modal
          title="This password is reused"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  void copy(reuseWarning.password, 'Password');
                  setConfirmDelete(null);
                }}
              >
                Copy anyway
              </button>
            </>
          }
        >
          <Alert tone="warn">
            <strong>{reuseWarning.title || 'This login'}</strong> shares its password with at least one other
            entry. If one site is breached, the others fall too.
          </Alert>
        </Modal>
      ) : null}

      {pendingDelete ? (
        <Modal
          title={`Delete ${pendingDelete.title || 'this login'}?`}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() =>
                  void vault
                    .mutate(() => vault.service.deleteItem(pendingDelete.id))
                    .then(() => {
                      setConfirmDelete(null);
                      notify('Login deleted');
                    })
                }
              >
                Delete
              </button>
            </>
          }
        >
          <Alert tone="danger">
            The password for <strong>{pendingDelete.username || pendingDelete.url || 'this login'}</strong>{' '}
            will be erased from this device. There is no undo.
          </Alert>
        </Modal>
      ) : null}

      {showShortcuts ? (
        <Modal title="Keyboard shortcuts" onClose={() => setShowShortcuts(false)}>
          <div className="shortcuts">
{[
              ['Focus search', ['/']],
              ['New login', ['N']],
              ['Lock vault', ['L']],
              ['Cycle view', ['V']],
              ['Undo', ['Ctrl', 'Z']],
              ['Redo', ['Ctrl', 'Shift', 'Z']],
              ['This dialog', ['?']],
              ['Right-click menu', ['right click']],
              ['Close / cancel', ['Esc']],
            ].flatMap(([label, keys]) => [
              <span className="shortcuts__label" key={`${label}-l`}>
                {label as string}
              </span>,
              <span className="shortcuts__keys" key={`${label}-k`}>
                {(keys as string[]).map((key) => (
                  <span className="kbd" key={key}>
                    {key}
                  </span>
                ))}
              </span>,
            ])}
          </div>
        </Modal>
      ) : null}

      <Toasts toasts={toasts} />
    </>
  );
}

function Ambient({ strength }: { strength: number }) {
  return (
    <>
      <div className="ambient" style={{ ['--ambient-strength' as string]: strength }} aria-hidden="true">
        <div className="ambient__blob ambient__blob--1" />
        <div className="ambient__blob ambient__blob--2" />
        <div className="ambient__blob ambient__blob--3" />
      </div>
<div className="grain" aria-hidden="true" />
    </>
  );
}
