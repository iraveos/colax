import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findReusedPasswords, hostnameOf, isWeakPassword, type VaultItem } from '../vault/types.ts';
import {
  applyChannel,
  createChannel,
  createTag,
  normaliseChannels,
  normaliseSidebar,
  moveChannelToFolder,
  moveManualOrder,
  CHANNEL_ACCENTS,
  CHANNEL_ICONS,
  type Channel,
  type Folder,
  type SidebarEntry,
} from '../vault/channels.ts';
import { freeDockSpot, MAX_DOCKS, mergeMailCache, newDockId } from '../vault/storage.ts';
import { captureToDraft, findSimilarTag, suggestTagsForDraft } from '../vault/site-intel.ts';
import { isSecured, requiresVerification, EMPTY_SECURITY } from '../crypto/security.ts';
import { SecurityGate } from './SecurityGate.tsx';
import { FolderEditor } from './FolderEditor.tsx';
import { detect as detectClipboard, detectBulk, markClipboardSelfWritten, useClipboardWatcher } from './useClipboardWatcher.ts';
import { useAlarms, playAlarmSound } from './useAlarms.ts';
import { useCaptureOffer, type PendingCapture } from './useCaptureOffer.ts';
import type { DockSlotConfig, DockState, GmailAccount, SortMode, VaultPreferences, VaultView } from '../vault/storage.ts';
import { LockScreen } from './LockScreen.tsx';
import { ItemEditor } from './ItemEditor.tsx';
import { AppearancePanel } from './AppearancePanel.tsx';
import { Settings } from './Settings.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ViewContextMenu, VIEW_OPTIONS, useViewShortcuts } from './ViewMenu.tsx';
import { Dock, useDockShortcuts, type DockSlot } from './Dock.tsx';
import { CHANNEL_ICONS_MAP } from './Sidebar.tsx';
import { ContextMenu, hideChromeMenu, type ChromeElementId, type ContextMenuState, type MenuItem } from './context-menu.tsx';
import { ChannelEditor } from './ChannelEditor.tsx';
import { Alert, Modal, Toasts } from './primitives.tsx';
import { BulkSecurityDialog, hasSecurityFactor, withoutSecurityFactor } from './BulkSecurityDialog.tsx';
import { AnimatedListView, BasicView, CarouselView, GridView, ViewEmptyState, type ViewActions } from './views.tsx';
import { LoginMessages } from './LoginMessages.tsx';
import { MailboxWindow } from './MailboxWindow.tsx';
import {
  useAutoLock,
  useClipboard,
  useHotkeys,
  useSelectAllShortcuts,
  useToasts,
  useVault,
  applyAppearance,
  applyChannelAppearance,
  typingHasFocus,
} from './hooks.ts';
import { useSelection } from './useSelection.ts';
import { applyBulkEdit, bulkMenu, type BulkEdit } from './bulk-edit.ts';
import { BulkAddDialog, BulkEditDialog } from './BulkEditDialog.tsx';
import { formatLoginCompact, formatLoginForClipboard, formatLoginsForClipboard } from './login-format.ts';
import { getPlatform } from '../lib/platform.ts';
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  EditIcon,
  ExternalIcon,
  EyeOffIcon,
  FlagIcon,
  GridIcon,
  InboxIcon,
  KeyboardIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  MailIcon,
  MoonIcon,
  PaletteIcon,
  PlusIcon,
  RowsIcon,
  SearchIcon,
  SettingsIcon,
  ShareIcon,
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
  manual: 'Custom order',
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
  showMail: true,
  mailAccount: 'all',
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
  /** Search covers the active channel; 'all' widens it to the whole vault. */
  const [searchScope, setSearchScope] = useState<'channel' | 'all'>('channel');
  // A new channel is a new scope: searching the whole vault must not leak
  // across channel switches.
  useEffect(() => {
    setSearchScope('channel');
  }, [activeId]);
  const [editing, setEditing] = useState<VaultItem | null | 'new'>(null);
  // Multi-selection, plus which bulk dialog (if any) is open over it.
  const selection = useSelection();
  const [bulkField, setBulkField] = useState<'title' | 'notes' | 'tags' | 'theme' | null>(null);
  const [bulkSecurity, setBulkSecurity] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [bulkDelete, setBulkDelete] = useState<VaultItem[] | null>(null);
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
  // The selection, mirrored into a ref for the window-level contextmenu handler.
  // That listener is registered once and must not depend on the selection, or
  // every ctrl-click would re-register it mid-gesture.
  const bulkRef = useRef<ReadonlySet<string>>(new Set());
  bulkRef.current = selection.ids;
  // The bulk menu itself, for the same reason: the window listener reads it but
  // must not depend on it.
  const selectionMenuRef = useRef<MenuItem[]>([]);
  // Shift-right-click opens the view picker on its own. On its own because the
  // plain right-click is already busy: cards get an item menu and empty space
  // gets the app menu, and neither had room for four views without burying the
  // actions people actually reach for.
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewMenuAt, setViewMenuAt] = useState({ x: 0, y: 0 });
  /** A mailbox opened from a dock slot, showing its messages in a window. */
  const [mailboxFor, setMailboxFor] = useState<GmailAccount | null>(null);
  /** A login whose messages were opened from a dock slot. */
  const [messagesFor, setMessagesFor] = useState<VaultItem | null>(null);
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
      // Left untagged, which is what puts it in the Unassigned channel. That is
      // deliberate: a clipboard login has no site to categorise it by, so it
      // waits there instead of being guessed into a channel that may be wrong.
      // autoTagDomain applies when a login is edited in the app, not here.
      void vault
        .mutate(() =>
          vault.service.addItem({
            // A clipboard block that carried a title keeps it; otherwise the
            // local part of the address is a better guess than "Clipboard login".
            title: creds.title?.trim() || creds.username.split('@')[0] || 'Clipboard login',
            username: creds.username,
            password: creds.password,
            url: creds.url ?? '',
            notes: creds.notes ?? '',
          }),
        )
        .then(() => notify('Saved credentials from the clipboard'));
    },
  });

  // Reminders with custom sounds. Muted alarms still toast — silence is about
  // sound, not about missing the reminder.
  useAlarms(prefs.alarms, (alarm) => {
    if (!prefs.soundsMuted) playAlarmSound(alarm);
    notify(`Alarm: ${alarm.label || alarm.time}`);
  });

  /* ---- Desktop shell ------------------------------------------------------
     Push window-chrome settings whenever they change (and once at boot), and
     listen for the two tray actions the shell cannot handle alone. Everything
     here is behind `shell?`, so the web build neither sends nor listens. */
  useEffect(() => {
    const shell = getPlatform().shell;
    if (!shell) return;
    shell.update({
      trayEnabled: prefs.trayEnabled,
      closeToTray: prefs.closeToTray,
      launchAtLogin: prefs.launchAtLogin,
      soundsMuted: prefs.soundsMuted,
    });
    return shell.onTrayAction((action) => {
      if (action === 'lock-now') vault.lock();
      else if (action === 'toggle-mute') {
        void vault.updatePrefs({ soundsMuted: !prefs.soundsMuted });
      }
    });
    // prefs.* individually: the effect must re-run per field, not per prefs
    // object identity, or every keystroke anywhere re-pushes shell state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.trayEnabled, prefs.closeToTray, prefs.launchAtLogin, prefs.soundsMuted]);

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

  const cycleView = useCallback(
    (current: VaultView) => {
      // Built from VIEW_OPTIONS so a new view is cyclable the moment it is
      // added. A hardcoded list was how Grid became unreachable from the `v`
      // hotkey: it was never added here, and cycling from Grid wrapped to Flow
      // because indexOf returned -1.
      const order = VIEW_OPTIONS.map((option) => option.id);
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

  // Only a background image overrides the global appearance now; the accent is
  // global. See applyChannelAppearance for why the accent was taken back out.
  const contextForAppearance = useMemo(() => {
    if (activeFolder) return activeFolder;
    if (activeChannel) {
      const pf = getParentFolderForChannel(activeChannel.id);
      if (pf && pf.backgroundImage) return pf;
      return activeChannel;
    }
    return null;
  }, [activeFolder, activeChannel, getParentFolderForChannel, folders]);

  const channelIsCustom = Boolean(contextForAppearance?.backgroundImage);
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

    // A query searches inside the active channel; "entire vault" widens it.
    // (This used to always search everything, but a channel then read as a
    // filter that mysteriously stopped filtering the moment you typed.)
    let list: VaultItem[];
    if (needle && searchScope === 'all' && !activeFolder) {
      list = vault.items;
    } else if (activeFolder) {
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

    // The drag order, as an index map. Ids never dragged stay after every
    // placed id in title order, so new logins need no bookkeeping.
    const manualIndex = new Map(prefs.manualOrder.map((id, index) => [id, index] as const));
    // One row per login, no matter the source: a duplicated id would render
    // the same login twice (two identical React keys), which reads as ghost
    // duplication in every view.
    const seenIds = new Set<string>();
    const unique = list.filter((item) => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });
    const sorted = [...unique].sort((a, b) => {
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
        case 'manual': {
          const ai = manualIndex.get(a.id);
          const bi = manualIndex.get(b.id);
          if (ai !== undefined && bi !== undefined) return ai - bi;
          if (ai !== undefined) return -1;
          if (bi !== undefined) return 1;
          return (a.title || '~').toLowerCase().localeCompare((b.title || '~').toLowerCase());
        }
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
  }, [vault.items, activeChannel, activeFolder, sidebarBase, channelLookup, query, searchScope, prefs.sort, prefs.pinFavorites, prefs.manualOrder, staleDays]);



  /**
   * Drops a dragged login at a flat position in the current view and records
   * the custom order. The stored order is global: untouched pairs keep their
   * relative positions whatever the view holds, and ids never dragged stay at
   * the end — so the first drag in any view seeds from what is on screen and
   * nothing else moves. A first drag also switches sorting to Custom, with a
   * toast saying so, because silently re-sorting under the user reads as the
   * list scrambling itself.
   */
  const moveLogin = useCallback(
    (loginId: string, toIndex: number, flatIds: string[]) => {
      const byTitle = [...vault.items]
        .sort((a, b) => (a.title || '~').toLowerCase().localeCompare((b.title || '~').toLowerCase()))
        .map((item) => item.id);
      const next = moveManualOrder(prefs.manualOrder, flatIds, byTitle, loginId, toIndex);
      const firstManual = prefs.sort !== 'manual';
      // A drop that changes nothing (onto itself, or before its own successor)
      // saves nothing — least of all a toast claiming something happened.
      if (!firstManual && next.join('\n') === prefs.manualOrder.join('\n')) return;
      void vault
        .updatePrefs({ manualOrder: next, ...(firstManual ? { sort: 'manual' as const } : {}) })
        .then(() => {
          if (firstManual) notify('Custom order saved — sorting switched to Custom');
        });
    },
    [vault, notify, prefs.manualOrder, prefs.sort, vault.items],
  );

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
        kind: 'item',
        label: 'Hide sidebar',
        icon: <EyeOffIcon />,
        onSelect: () => {
          void vault.updatePrefs({ showSidebar: false });
          notify('Hidden — the recovery pill sits on the same edge');
        },
      },
      {
        kind: 'item',
        label: 'Show hidden items…',
        icon: <EyeOffIcon />,
        onSelect: () => openSettings('hidden'),
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
      // The size controls, per view, straight from the menu. Each entry states
      // what that view is currently set to, so the menu doubles as a readout.
      cardSizeMenu(),
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
        ...(channel.locked
          ? []
          : [
              {
                kind: 'item' as const,
                label: prefs.hiddenChannels.includes(channel.id) ? 'Show channel' : 'Hide channel',
                icon: <EyeOffIcon />,
                onSelect: () => {
                  const hidden = prefs.hiddenChannels.includes(channel.id)
                    ? prefs.hiddenChannels.filter((id) => id !== channel.id)
                    : [...prefs.hiddenChannels, channel.id];
                  void vault.updatePrefs({ hiddenChannels: hidden }).then(() => {
                    if (hidden.includes(channel.id)) notify('Hidden — bring it back in Settings › Hidden');
                  });
                },
              },
            ]),
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
    [prefs.tags, prefs.hiddenChannels, folders, saveChannel, deleteChannel, notify, moveChannel, addSeparator, vault],
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
        label: prefs.hiddenFolders.includes(folder.id) ? 'Show folder' : 'Hide folder',
        icon: <EyeOffIcon />,
        onSelect: () => {
          const hidden = prefs.hiddenFolders.includes(folder.id)
            ? prefs.hiddenFolders.filter((id) => id !== folder.id)
            : [...prefs.hiddenFolders, folder.id];
          void vault.updatePrefs({ hiddenFolders: hidden }).then(() => {
            if (hidden.includes(folder.id)) notify('Hidden — bring it back in Settings › Hidden');
          });
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
    [deleteFolder, toggleFolderCollapse, prefs.hiddenFolders, vault, notify],
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

  /**
   * Opens the appearance panel on a chosen view.
   *
   * Switches the view first, so the sliders act on the view the user asked for
   * rather than whichever one happened to be open. Without that the panel said
   * "Flow" while editing Orbit's numbers.
   */
  const openTuner = useCallback(
    (target?: VaultView) => {
      const next = target ?? view;
      if (next !== view) void vault.updatePrefs({ view: next });
      setShowSettings(false);
      setShowTuner(true);
    },
    [view, vault],
  );

  /**
   * The per-view size controls, as a submenu.
   *
   * Reachable from both the item menu and the background menu, because the ask
   * was "right-click, then get to the size settings of the views" and only one
   * of those two menus had a route there. Every entry opens the appearance panel
   * already scoped to that view, so there is one place the sliders actually
   * live rather than a second, divergent copy of them in a menu.
   *
   * Labels are names only. An earlier version appended each view's current
   * numbers ("Flow — 560px wide, 132px min"), which truncated to gibberish in
   * the 232px menu. The panel itself is the readout; the menu is the route.
   */
  const cardSizeMenu = useCallback(
    (): MenuItem => ({
      kind: 'submenu',
      label: 'Card size',
      icon: <PaletteIcon />,
      heading: 'Per-view card size',
      items: VIEW_OPTIONS.map((option) => ({
        kind: 'item' as const,
        label: option.label,
        checked: view === option.id,
        icon: <option.Icon />,
        onSelect: () => openTuner(option.id),
      })),
    }),
    [prefs.cardSize, view, openTuner],
  );

  /* ---- Item actions ---------------------------------------------------- */

  /**
   * Records one use of a login for the Frequently-used panel and the
   * untouched-login scan. Copying and editing count; merely looking does not,
   * so scrolling past a login never promotes it.
   */
  const touchLogin = useCallback(
    (id: string) => {
      void vault.recordUse(
        id,
        new Set(vault.items.map((entry) => entry.id)),
      );
    },
    [vault],
  );

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
      touchLogin(item.id);
    },
    [copy, notify, prefs.warnOnReuse, duplicateIds, vault.items.length, touchLogin, vault],
  );

  /* ---- Untouched-login scan ------------------------------------------------
     Once per unlock: any login with a password that nobody has copied or
     edited within the staleness window gets flagged for attention. The flag
     carries no age of its own (setAttention preserves updatedAt), so this
     fires at most once per window per login rather than every unlock. Off when
     the staleness window itself is off. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    if (prefs.passwordAgeDays <= 0) return;
    const cutoff = Date.now() - prefs.passwordAgeDays * 86_400_000;
    const untouched = vault.items.filter((item) => {
      if (item.needsAttention || !item.password) return false;
      const lastUse = prefs.usage[item.id]?.at ?? item.updatedAt;
      return lastUse < cutoff;
    });
    if (untouched.length === 0) return;
    void vault
      .mutate(async () => {
        for (const item of untouched) await vault.service.setAttention(item.id, true);
      })
      .then(() =>
        notify(
          `${untouched.length} untouched login${untouched.length === 1 ? '' : 's'} flagged for attention`,
        ),
      );
    // Runs once per unlock by depending on status alone. Depending on items or
    // prefs would re-run after the flagging itself writes, which is both
    // pointless (everything newly flagged is excluded) and noisy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status]);

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
    // Through the platform seam, not window.open directly: inside Electron a
    // bare window.open spawns a second app window holding the unlocked vault,
    // and the shell routes this to the OS browser instead. Web behavior is
    // unchanged (the fallback is the same call).
    getPlatform().openExternal(item.url);
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

  /**
   * Clears the gate, then continues wherever the user was headed.
   *
   * 'edit' opens the editor they double-clicked toward; 'reveal' only marks
   * the login verified, because the editor is already open and re-setting it
   * would discard the draft in progress. Before this branched, the editor's
   * unlock button skipped the gate outright — one click revealed the password
   * with no factor checked at all.
   */
  const completeGate = useCallback(() => {
    const item = pendingItem;
    if (!item) return;
    setVerifiedItems((current) => new Set(current).add(item.id));
    setPendingItem(null);
    if (pendingIntent === 'edit') setEditing(item);
  }, [pendingItem, pendingIntent]);

  const viewActions: ViewActions = {
    // Card-button copies count as use when the card passes itself along.
    onCopy: (value: string, label: string, item?: VaultItem) => {
      void copy(value, label);
      if (item) touchLogin(item.id);
    },
    onSelect: openItem,
    onEdit: requestEdit,
    onDelete: requestDelete,
    onToggleFavorite: (item) => void toggleFavorite(item),
    onToggleAttention: (item) => void toggleAttention(item),
    // Fresh inbox reads join the persistent per-account cache, so message
    // lists keep reaching further back than Google's ~20-per-read feed.
    onCacheMail: (accountId, messages) => {
      const next = mergeMailCache(vault.prefs.mailCache ?? {}, accountId, messages);
      void vault.updatePrefs({ mailCache: next });
    },
tags: prefs.tags,
    showTagChips: prefs.showTagChips,
    onOpenUrl: openUrl,
    // Message links leave through the platform seam, never a bare
    // window.open — which inside Electron spawns a second app window.
    onOpenExternal: (url) => getPlatform().openExternal(url),
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
          onSelect: () => {
            void copy(item.password, 'Password');
            touchLogin(item.id);
          },
        },
        {
          kind: 'item',
          label: 'Copy username',
          icon: <CopyIcon />,
          disabled: !item.username,
          onSelect: () => {
            void copy(item.username, 'Username');
            touchLogin(item.id);
          },
        },
        {
          kind: 'item',
          label: 'Copy URL',
          icon: <ExternalIcon />,
          disabled: !item.url,
          onSelect: () => {
            void copy(item.url, 'URL');
            touchLogin(item.id);
          },
        },
        // Short on purpose: three lines (title, email, password) that a friend
        // with Colax pastes straight back into a login. The full labelled
        // block is what bulk Share copies; one login does not need it.
        {
          kind: 'item',
          label: 'Share login',
          icon: <ShareIcon />,
          disabled: !item.password && !item.username,
          onSelect: () => {
            const text = formatLoginCompact({
              title: item.title,
              username: item.username,
              password: item.password,
              totpSecret: item.totpSecret,
            });
            markClipboardSelfWritten(text);
            void copy(text, 'Login shared');
            touchLogin(item.id);
          },
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
          label: item.needsAttention ? 'Clear needs attention' : 'Flag as needing attention',
          icon: <FlagIcon />,
          onSelect: () => void toggleAttention(item),
        },
        {
          kind: 'item',
          label: 'Edit login',
          icon: <EditIcon />,
          // Gated like every other route into the editor: a secured login
          // clears its second factor first instead of handing over the secret.
          onSelect: () => requestEdit(item),
        },
        // Per-view card sizing. This was only reachable from the *background*
        // context menu, so right-clicking a card — the thing you are actually
        // looking at — had no route to the size sliders for it.
        cardSizeMenu(),
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
    // cardSizeMenu is a callback that changes when the sizes change. Leaving it
    // out of this list froze the card menu's Card-size submenu on whatever the
    // sizes were at first render: it opened the tuner for the wrong view and
    // described numbers that no longer matched.
    [copy, duplicateIds, toggleFavorite, toggleAttention, openUrl, requestDelete, requestEdit, cardSizeMenu, touchLogin],
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
      // The only way back when the rail is hidden: the pill is gone by
      // request, so empty-space right-click carries the recovery instead.
      ...(prefs.showSidebar === false
        ? [
            {
              kind: 'item' as const,
              label: 'Show sidebar',
              icon: <EyeOffIcon />,
              onSelect: () => void vault.updatePrefs({ showSidebar: true }),
            },
          ]
        : []),
      {
        kind: 'submenu',
        label: 'Switch view',
        icon: <LayersIcon />,
        heading: 'View',
        // Built from VIEW_OPTIONS so this submenu, the topbar panel and the
        // right-click list are one list, not three that drift apart.
        items: VIEW_OPTIONS.map((option) => ({
          kind: 'item' as const,
          label: option.label,
          shortcut: option.shortcut,
          checked: view === option.id,
          icon: <option.Icon />,
          onSelect: () => void vault.updatePrefs({ view: option.id }),
        })),
      },
      // Same per-view size controls as the card menu. Empty space is the most
      // common right-click target and it had no route to them at all.
      cardSizeMenu(),
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
        label: 'Show hidden items…',
        icon: <EyeOffIcon />,
        onSelect: () => openSettings('hidden'),
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
      // Any button carrying data-hide-id offers Hide on top of whatever menu
      // would otherwise open. The button hides everywhere it renders; the
      // Hidden tab brings it back.
      const hideEntry = (): MenuItem[] => {
        const el = target?.closest?.('[data-hide-id]') as HTMLElement | null;
        const id = el?.dataset.hideId;
        if (!id || prefs.hiddenButtons.includes(id)) return [];
        const label = (el?.dataset.hideLabel || id).toLowerCase();
        return [
          {
            kind: 'item' as const,
            label: `Hide ${label}`,
            icon: <EyeOffIcon />,
            onSelect: () => {
              void vault
                .updatePrefs({ hiddenButtons: [...prefs.hiddenButtons, id] })
                .then(() => notify('Hidden — bring it back in Settings › Hidden'));
            },
          },
          { kind: 'separator' as const },
        ];
      };
      const itemEl = target?.closest('[data-vault-item]') as HTMLElement | null;
      if (event.shiftKey) {
        event.preventDefault();
        setMenu(null);
        setViewMenuAt({ x: event.clientX, y: event.clientY });
        setViewMenuOpen(true);
        return;
      }
      setViewMenuOpen(false);
      if (itemEl) {
        const id = itemEl.dataset.vaultItem;
        const item = vault.items.find((entry) => entry.id === id);
        if (item) {
          // Right-clicking inside an existing selection acts on the whole
          // selection, which is what makes the gesture useful: you select a set,
          // then right-click any member of it. Right-clicking outside it starts
          // over from that one login, so a mis-click does not silently apply a
          // bulk action to rows the user had forgotten they had selected.
          const bulk = bulkRef.current;
          if (bulk.has(item.id) && bulk.size > 1) {
            setMenu({ x: event.clientX, y: event.clientY, items: [...hideEntry(), ...selectionMenuRef.current] });
            return;
          }
          selection.clear();
          setMenu({ x: event.clientX, y: event.clientY, items: [...hideEntry(), ...itemMenu(item)] });
          return;
        }
      }
      setMenu({ x: event.clientX, y: event.clientY, items: [...hideEntry(), ...appMenu()] });
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
    // selectionMenu is read through a ref rather than depended on. It is
    // rebuilt whenever the selection changes, so listing it here would tear down
    // and re-add this window listener on every click of a selection, which also
    // risks losing the very gesture that is still being handled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status, vault.items, vault, prefs, notify, itemMenu, appMenu, selection]);

  /* ---- Paste to create ----------------------------------------------------
     Click the vault body, Ctrl+V a copied email+password, and a new Unassigned
     login is created from it — or one login per entry when the paste holds
     several (alternating address/password lines, or `-`-divided blocks).
     Reads the event's clipboard data directly, so no permission prompt is
     involved; only fires outside text fields, menus and dialogs, so pasting
     into a form never creates anything. An exact username+password duplicate
     is reported instead of duplicated — pasting twice must not fork the login. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], .ctx-menu, .settings-window, .modal, .editor-window, .sidebar',
        )
      ) {
        return;
      }
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text.trim()) return;
      // Several credentials at once win over the single-pair read: alternating
      // address/password lines or `-`-divided blocks each mint their own login.
      // Exact duplicates (in the vault or inside the paste) are skipped, and a
      // paste of nothing-new is reported rather than silently dropped.
      const bulk = detectBulk(text);
      if (bulk && bulk.length > 0) {
        event.preventDefault();
        const seen = new Set(
          vault.items.map((entry) => `${entry.username}\n${entry.password}`),
        );
        const fresh = bulk.filter((creds) => {
          const key = `${creds.username}\n${creds.password}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (fresh.length === 0) {
          notify('Those logins are already in the vault', 'error');
          return;
        }
        void vault
          .mutate(async () => {
            for (const creds of fresh) {
              await vault.service.addItem({
                title: creds.title?.trim() || creds.username.split('@')[0] || 'Pasted login',
                username: creds.username,
                password: creds.password,
                url: creds.url ?? '',
                notes: creds.notes ?? '',
              });
            }
          })
          .then(() =>
            notify(
              fresh.length === 1
                ? 'Created login in Unassigned'
                : `Created ${fresh.length} logins in Unassigned`,
            ),
          );
        return;
      }
      const creds = detectClipboard(text);
      if (!creds) return;
      event.preventDefault();
      const duplicate = vault.items.some(
        (entry) => entry.username === creds.username && entry.password === creds.password,
      );
      if (duplicate) {
        notify('That login is already in the vault', 'error');
        return;
      }
      void vault
        .mutate(() =>
          vault.service.addItem({
            title: creds.title?.trim() || creds.username.split('@')[0] || 'Pasted login',
            username: creds.username,
            password: creds.password,
            url: creds.url ?? '',
            notes: creds.notes ?? '',
          }),
        )
        .then(() => notify('Created login in Unassigned'));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [vault, notify]);

  useViewShortcuts((next) => void vault.updatePrefs({ view: next }));

  /* ---- Docks ----------------------------------------------------------------
     Each bar resolves its own slots, in bar order: views, channels, and the
     inbox. The inbox slot selects the dashboard channel, which is where
     connected-mail messages render — the dock does not fetch mail itself, so
     enabling it adds no polling. A channel slot whose channel is gone renders
     nothing rather than a dead button (normalization cannot know the channel
     list, so the filter lives here where channels are visible). */
  const buildDockSlots = useCallback(
    (configs: DockSlotConfig[]): DockSlot[] => {
      const dashboardId = channelLookup.find((channel) => channel.kind === 'dashboard')?.id;
      const resolved: DockSlot[] = [];
      for (const slot of configs) {
      const id = `${slot.kind}:${slot.ref || slot.kind}`;
      if (slot.kind === 'view') {
        const option = VIEW_OPTIONS.find((entry) => entry.id === slot.ref);
        if (!option) continue;
        resolved.push({
          id,
          label: slot.label || option.label,
          hint: option.hint,
          Icon: option.Icon,
          imageUrl: slot.icon,
          key: slot.key,
          active: view === option.id,
          onJump: () => void vault.updatePrefs({ view: option.id as VaultView }),
        });
      } else if (slot.kind === 'inbox') {
        resolved.push({
          id,
          label: slot.label || 'Inbox',
          hint: 'Dashboard and recent mail',
          Icon: MailIcon,
          imageUrl: slot.icon,
          key: slot.key,
          active: activeChannel?.kind === 'dashboard',
          onJump: () => {
            if (dashboardId) setActiveId(dashboardId);
          },
        });
      } else if (slot.kind === 'folder') {
        const folder = folders.find((entry) => entry.id === slot.ref);
        if (!folder) continue;
        const Icon = CHANNEL_ICONS_MAP[folder.icon] ?? LayersIcon;
        resolved.push({
          id,
          label: slot.label || folder.name,
          hint: `Folder: ${folder.name}`,
          Icon,
          imageUrl: slot.icon,
          hue: folder.hue,
          key: slot.key,
          active: activeFolder?.id === folder.id,
          onJump: () => setActiveId(`folder:${folder.id}`),
        });
      } else if (slot.kind === 'login') {
        const item = vault.items.find((entry) => entry.id === slot.ref);
        // Gone (deleted) renders nothing, like a deleted channel's slot.
        if (!item) continue;
        const action = slot.action ?? 'both';
        const actionHint =
          action === 'password' ? 'Copy password'
          : action === 'email' ? 'Copy email'
          : action === 'edit' ? 'Edit login'
          : action === 'messages' ? 'Show messages'
          : 'Copy login';
        resolved.push({
          id,
          label: slot.label || item.title || item.username || 'Login',
          hint: item.username || item.url || actionHint,
          Icon: KeyIcon,
          imageUrl: slot.icon,
          key: slot.key,
          active: selection.ids.has(item.id),
          onJump: () => {
            // The slot's configured action, chosen in the dock settings. The
            // default stays the historic one line, "email password", ready to
            // paste into a form.
            if (action === 'password') {
              if (item.password) void copy(item.password, 'Password');
            } else if (action === 'email') {
              if (item.username) void copy(item.username, 'Email');
            } else if (action === 'edit') {
              requestEdit(item);
            } else if (action === 'messages') {
              setMessagesFor(item);
            } else {
              const line = [item.username.trim(), item.password].filter(Boolean).join(' ');
              if (line) void copy(line, 'Login');
            }
          },
        });
      } else if (slot.kind === 'mailbox') {
        const account = prefs.gmailAccounts.find((entry) => entry.id === slot.ref);
        // Disconnected since: renders nothing rather than a dead button.
        if (!account) continue;
        resolved.push({
          id,
          label: slot.label || account.address || 'Mailbox',
          hint: account.address ? `Messages for ${account.address}` : 'Mailbox messages',
          Icon: MailIcon,
          imageUrl: slot.icon,
          key: slot.key,
          active: mailboxFor?.id === account.id,
          onJump: () => setMailboxFor(account),
        });
      } else {
        const channel = channelLookup.find((entry) => entry.id === slot.ref);
        if (!channel) continue;
        const Icon = CHANNEL_ICONS_MAP[channel.icon] ?? LayersIcon;
        resolved.push({
          id,
          label: slot.label || channel.name,
          hint: `Channel: ${channel.name}`,
          Icon,
          imageUrl: slot.icon,
          hue: channel.hue,
          key: slot.key,
          active: activeId === channel.id,
          onJump: () => setActiveId(channel.id),
        });
      }
    }
    return resolved;
    },
    [prefs.gmailAccounts, channelLookup, folders, view, activeChannel, activeFolder, activeId, selection, vault, viewActions, copy, mailboxFor, requestEdit],
  );

  /** One resolved bar per stored dock. */
  const dockModels = useMemo(
    () => prefs.docks.map((dock) => ({ dock, slots: buildDockSlots(dock.slots) })),
    [prefs.docks, buildDockSlots],
  );

  /** Patches one bar, leaving the others alone. */
  const patchDock = useCallback(
    (dockId: string, patch: Partial<DockState>) => {
      void vault.updatePrefs({
        docks: prefs.docks.map((dock) => (dock.id === dockId ? { ...dock, ...patch } : dock)),
      });
    },
    [vault, prefs.docks],
  );

  /**
   * The dock's own menu: position, a route to full configuration, and hide.
   * Dragging the grip repositions without menus, but discoverability needs a
   * right-click path too — and Hide must live here, because hiding removes the
   * bar you would otherwise unhide it from.
   */
  /**
   * Hides one chrome button by right-click, from wherever it lives. Writes the
   * same preference its Settings toggle writes, so the menu and Settings can
   * never disagree — and toasts where it went, because a button that vanishes
   * with no word is indistinguishable from a bug.
   */
  const hideChrome = useCallback(
    (id: ChromeElementId) => {
      const patches: Record<ChromeElementId, Partial<VaultPreferences>> = {
        'new-login': { showNewLoginButton: false },
        'bulk-add': { showBulkAddButton: false },
        'sidebar-add': { showNewChannelButton: false },
        'footer-settings': { showSettingsButton: false },
        'footer-lock': { showLockButton: false },
        'footer-shortcuts': { showShortcuts: false },
        'footer-compact': { showCompactButton: false },
        'footer-hide': { showHideSidebarButton: false },
      };
      void vault.updatePrefs(patches[id]).then(() => notify('Hidden — bring it back in Settings › Hidden'));
    },
    [vault, notify],
  );

  /**
   * Right-click on one dock slot: edit whatever it jumps to, without detouring
   * through Settings. Falls back to the bar menu when the target is gone.
   */
  const dockSlotMenu = useCallback(
    (slotId: string): MenuItem[] => {
      const sep = slotId.indexOf(':');
      const kind = sep === -1 ? slotId : slotId.slice(0, sep);
      const ref = sep === -1 ? '' : slotId.slice(sep + 1);
      const customize: MenuItem[] = [
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Customize this bar…',
          icon: <SettingsIcon />,
          onSelect: () => openSettings('layout'),
        },
        {
          kind: 'item',
          label: 'Show hidden items…',
          onSelect: () => openSettings('hidden'),
        },
      ];
      if (kind === 'login') {
        const item = vault.items.find((entry) => entry.id === ref);
        return [
          item
            ? {
                kind: 'item' as const,
                label: `Edit ${item.title || item.username || 'login'}`,
                icon: <EditIcon />,
                onSelect: () => requestEdit(item),
              }
            : { kind: 'item' as const, label: 'Login deleted', disabled: true },
          ...customize,
        ];
      }
      if (kind === 'channel') {
        const channel = channelLookup.find((entry) => entry.id === ref);
        return [
          channel
            ? {
                kind: 'item' as const,
                label: `Edit ${channel.name}`,
                icon: <EditIcon />,
                onSelect: () => setEditingChannel(channel.id),
              }
            : { kind: 'item' as const, label: 'Channel deleted', disabled: true },
          ...customize,
        ];
      }
      if (kind === 'folder') {
        const folder = folders.find((entry) => entry.id === ref);
        return [
          folder
            ? {
                kind: 'item' as const,
                label: `Edit ${folder.name}`,
                icon: <EditIcon />,
                onSelect: () => setEditingFolder(folder.id),
              }
            : { kind: 'item' as const, label: 'Folder deleted', disabled: true },
          ...customize,
        ];
      }
      if (kind === 'mailbox') {
        const account = prefs.gmailAccounts.find((entry) => entry.id === ref);
        return [
          account
            ? {
                kind: 'item' as const,
                label: `Open ${account.address || 'mailbox'}`,
                icon: <MailIcon />,
                onSelect: () => setMailboxFor(account),
              }
            : { kind: 'item' as const, label: 'Mailbox disconnected', disabled: true },
          ...customize,
        ];
      }
      return [
        {
          kind: 'item',
          label: 'Customize this bar…',
          icon: <SettingsIcon />,
          onSelect: () => openSettings('layout'),
        },
        {
          kind: 'item',
          label: 'Show hidden items…',
          onSelect: () => openSettings('hidden'),
        },
      ];
    },
    [vault.items, channelLookup, folders, prefs.gmailAccounts, requestEdit, openSettings],
  );

  const dockMenu = useCallback(
    (dockId: string): MenuItem[] => {
      const dock = prefs.docks.find((entry) => entry.id === dockId);
      // Canonical spots per edge; dragging refines from here freely.
      const positions = [
        { id: 'bottom', label: 'Bottom', fx: 0.5, fy: 0.94 },
        { id: 'top', label: 'Top', fx: 0.5, fy: 0.06 },
        { id: 'left', label: 'Left', fx: 0.06, fy: 0.5 },
        { id: 'right', label: 'Right', fx: 0.94, fy: 0.5 },
      ] as const;
      return [
        {
          kind: 'submenu',
          label: 'Dock position',
          heading: 'Dock position',
          items: positions.map((position) => ({
            kind: 'item' as const,
            label: position.label,
            checked: dock?.pos.edge === position.id,
            onSelect: () => patchDock(dockId, { pos: { edge: position.id, fx: position.fx, fy: position.fy } }),
          })),
        },
        {
          kind: 'item',
          label: 'Configure dock…',
          icon: <SettingsIcon />,
          onSelect: () => openSettings('layout'),
        },
        ...(prefs.docks.length < MAX_DOCKS
          ? [
              {
                kind: 'item' as const,
                label: 'New dock',
                icon: <PlusIcon />,
                onSelect: () => {
                  const fresh = {
                    id: newDockId(),
                    slots: [],
                    pos: freeDockSpot(prefs.docks),
                    enabled: true,
                  };
                  void vault
                    .updatePrefs({ docks: [...prefs.docks, fresh] })
                    .then(() => notify('New dock added — fill it in Settings › Layout'));
                },
              },
              {
                kind: 'item' as const,
                label: 'Duplicate this dock',
                icon: <CopyIcon />,
                onSelect: () => {
                  if (!dock) return;
                  const fresh = {
                    ...dock,
                    id: newDockId(),
                    slots: dock.slots.map((slot) => ({ ...slot })),
                    pos: { ...freeDockSpot(prefs.docks), edge: dock.pos.edge },
                  };
                  void vault.updatePrefs({ docks: [...prefs.docks, fresh] }).then(() => notify('Dock duplicated'));
                },
              },
            ]
          : []),
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Hide this dock',
          onSelect: () => {
            patchDock(dockId, { enabled: false });
            notify('Hidden — bring it back in Settings › Hidden');
          },
        },
        {
          kind: 'item',
          label: 'Show hidden items…',
          onSelect: () => openSettings('hidden'),
        },
      ];
    },
    [prefs.docks, patchDock, openSettings, vault, notify],
  );

  // Stable across renders on purpose: it reads only the DOM, so re-creating it
  // would re-subscribe the key listener on every render (each keystroke while
  // searching, each selection click) for no reason.
  const dockGuard = useCallback(
    // DOM-based rather than state-based: any open menu, modal, settings
    // window, tuner or editor has one of these classes, including ones added
    // later, so a new dialog cannot accidentally become type-into-the-dock.
    () =>
      !typingHasFocus() &&
      !document.querySelector('.ctx-menu, .modal, .settings-window, .tuner, .editor-window'),
    [],
  );
  // Every enabled bar contributes its keys. Two bars claiming one key cannot
  // both win; the first bar's slot takes it, and the settings rows (which
  // check keys per bar) stay honest for the common single-bar case.
  const dockShortcutSlots = useMemo(
    () => dockModels.filter((model) => model.dock.enabled).flatMap((model) => model.slots),
    [dockModels],
  );
  useDockShortcuts(dockShortcutSlots, dockGuard);
  useSelectAllShortcuts(
    () => selection.selectAll(visible),
    () => selection.clear(),
    // Suppressed inside any text field so Ctrl+A still selects text there.
    () => !typingHasFocus() && !showSettings && !editing,
  );

  /* ---- Workspace scroll memory ----------------------------------------------
     Cards keep their scroll position per channel and view: switching away and
     back lands where you were, instead of at the top every time. Selection
     needs no such help — it already lives outside any one channel. */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollMemory = useRef<Record<string, number>>({});
  const scrollKey = useRef('');
  useEffect(() => {
    const el = contentRef.current;
    if (el && scrollKey.current) scrollMemory.current[scrollKey.current] = el.scrollTop;
    const key = `${activeId}|${view}`;
    scrollKey.current = key;
    if (el) el.scrollTop = scrollMemory.current[key] ?? 0;
  }, [activeId, view]);

  /* ---- Channel jumping ------------------------------------------------------
     Alt+1..9 jumps to the first nine visible channels in rail order, folders
     included. Bare digits belong to the dock; Alt keeps the two systems from
     ever claiming one press. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    const flat: string[] = [];
    for (const entry of sidebarBase) {
      if (entry.kind === 'channel') {
        if (!prefs.hiddenChannels.includes(entry.id)) flat.push(entry.id);
      } else if (entry.kind === 'folder') {
        if (prefs.hiddenFolders.includes(entry.id)) continue;
        for (const child of entry.children) {
          if (child.kind === 'channel' && !prefs.hiddenChannels.includes(child.id)) flat.push(child.id);
        }
      }
      if (flat.length >= 9) break;
    }
    const ids = flat.slice(0, 9);
    if (ids.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .ctx-menu, .modal, .settings-window')) {
        return;
      }
      const id = ids[Number(event.key) - 1];
      if (!id) return;
      event.preventDefault();
      setActiveId(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [vault.status, sidebarBase, prefs.hiddenChannels, prefs.hiddenFolders]);

  /* ---- Selection and bulk actions -----------------------------------------
     These have to sit above the boot/lock early returns below, not beside the
     views that use them. App returns early while loading, while locked and while
     the vault gate is up, so a hook declared after those returns is skipped on
     the first render and then called on the second — which React reports as
     "rendered more hooks than during the previous render" and refuses to
     recover from. Every hook in this component has to be above the first return. */

  const onSelectForEdit = useCallback(
    (item: VaultItem, extend: boolean) => {
      if (extend) selection.extendTo(item, visible);
      else selection.toggle(item);
    },
    [selection, visible],
  );

  /** The selection resolved against what is currently on screen. */
  const selectedItems = useMemo(() => selection.resolve(visible), [selection, visible]);

  const shareSelection = useCallback(async () => {
    if (selectedItems.length === 0) return;
    const text =
      selectedItems.length === 1
        ? formatLoginForClipboard(selectedItems[0]!)
        : formatLoginsForClipboard(selectedItems);
    markClipboardSelfWritten(text);
    await copy(text, selectedItems.length === 1 ? 'Login' : `${selectedItems.length} logins`);
  }, [copy, selectedItems]);

  const applySelectionEdit = useCallback(
    async (edit: BulkEdit) => {
      const target = selectedItems;
      if (target.length === 0) return;
      await vault.mutate(() =>
        applyBulkEdit(target, edit, (id, patch) => vault.service.updateItem(id, patch)),
      );
      // Reported from the dialog's own "Apply to N" count rather than recounted
      // here: the count was computed from the same diff, and re-deriving it here
      // risks the two disagreeing about what "changed" means.
      notify(`${target.length} ${target.length === 1 ? 'login' : 'logins'} checked`, 'ok');
    },
    [notify, selectedItems, vault],
  );

  const selectionMenu = useMemo(
    () =>
      bulkMenu({
        items: selectedItems,
        icon: { share: <ShareIcon />, edit: <EditIcon />, shield: <ShieldIcon />, trash: <TrashIcon />, all: <CheckIcon /> },
        onShare: () => void shareSelection(),
        onEditFields: () => setBulkField('title'),
        // Deliberately concrete actions rather than a bulk security form. Every
        // entry names one field and does one thing, so there is no state in
        // which a factor could be carried across from one login to another by
        // accident. A TOTP seed is per-credential and copying one onto several
        // logins would break every one of them at once.
        onEditSecurity: () => setBulkSecurity(true),
        onDelete: () => {
          if (prefs.confirmDeletes) setBulkDelete(selectedItems);
          else
            void vault.mutate(async () => {
              for (const item of selectedItems) await vault.service.deleteItem(item.id);
            });
        },
        onSelectAll: () => selection.selectAll(visible),
        onClear: () => selection.clear(),
      }),
    [selectedItems, shareSelection, vault, prefs.confirmDeletes, selection, visible],
  );

  // Published to the contextmenu listener, which runs outside this render's
  // dependency graph. Kept in a ref so the listener never needs rebuilding.
  selectionMenuRef.current = selectionMenu;

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    void vault.updatePrefs({ theme: next });
  };

  // Hiding the channel or folder you are looking at drops you back to All
  // logins rather than stranding the content on a view the rail no longer
  // offers.
  useEffect(() => {
    if (activeId !== 'all' && prefs.hiddenChannels.includes(activeId)) setActiveId('all');
    if (activeId.startsWith('folder:') && prefs.hiddenFolders.includes(activeId.slice('folder:'.length))) {
      setActiveId('all');
    }
  }, [activeId, prefs.hiddenChannels, prefs.hiddenFolders]);

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
    selectedIds: selection.ids,
    onSelectForEdit,
    // Mail scope follows the active channel: a channel that hides mail, or one
    // pinned to a single account, scopes every card it shows. Anything else —
    // All logins, folders, search — shows everything.
    gmailAccounts: prefs.gmailAccounts,
    mailCache: prefs.mailCache,
    mailScope: {
      show: activeChannel?.showMail !== false,
      account:
        activeChannel &&
        activeChannel.mailAccount !== 'all' &&
        prefs.gmailAccounts.some((entry) => entry.id === activeChannel.mailAccount)
          ? activeChannel.mailAccount
          : 'all',
    },
    // Drag-reorder for the List and Grid views; Flow and Orbit ignore it but
    // still follow the custom order through sorting.
    onReorderLogins: moveLogin,
    // Card buttons hidden by right-click, everywhere they render.
    hiddenButtons: prefs.hiddenButtons,
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
        // Icons-only labels read as a narrow rail too, so the column follows
        // the same rule — otherwise the rail shrinks to 60px inside a 272px
        // column and most of the sidebar is dead space.
        data-compact-sidebar={prefs.compactSidebar || prefs.sidebarLabels === 'icon' || undefined}
        data-sidebar-hidden={prefs.showSidebar === false || undefined}
        data-floating={prefs.floatingChrome || undefined}
        data-rail={prefs.sidebarPosition}
        data-labels={prefs.sidebarLabels}
      >
        {prefs.showSidebar !== false ? (
        <Sidebar
          entries={sidebarBase}
          channels={channelLookup}
          folders={folders}
          activeId={activeId}
          counts={channelCounts}
          compact={prefs.compactSidebar}
          labels={prefs.sidebarLabels}
          hiddenChannels={prefs.hiddenChannels}
          hiddenFolders={prefs.hiddenFolders}
          showNewChannelButton={prefs.showNewChannelButton}
          showCompactButton={prefs.showCompactButton}
          showSettingsButton={prefs.showSettingsButton}
          showHideSidebarButton={prefs.showHideSidebarButton}
          onHideChrome={(id, event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: hideChromeMenu(id, () => hideChrome(id), () => openSettings('hidden')) });
          }}
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
          onHideSidebar={() => void vault.updatePrefs({ showSidebar: false })}
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
        ) : null}

<main className="main">
          <header className="topbar">
            {/* The lead slot is a spacer — unless the sidebar is hidden, in
                which case it carries the way back, so Settings stays
                reachable. */}
            {/* The lead slot is a spacer. Sidebar recovery lives in the floating
                pill on the rail's own edge, next to where it hid from. */}
            <div className="topbar__lead" />

            {/* Search sits alone in the centre column. */}
            <div className="topbar__centre">
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
              {query.trim() && searchScope === 'all' ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  title="Back to searching the active channel"
                  onClick={() => setSearchScope('channel')}
                >
                  Entire vault ×
                </button>
              ) : null}
            </div>

            <div className="topbar__actions">
              {prefs.showBulkAddButton !== false ? (
                <button
                  className="btn btn--quiet"
                  onClick={() => setBulkAdding(true)}
                  title="Bulk add — right-click to hide"
                  onContextMenu={(event) => {
                    // Stopped here: without this the window menu below opens a
                    // beat later and overwrites this one, so Hide never shows.
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ x: event.clientX, y: event.clientY, items: hideChromeMenu('bulk-add', () => hideChrome('bulk-add'), () => openSettings('hidden')) });
                  }}
                >
                  <PlusIcon width="15" height="15" />
                  Bulk add
                </button>
              ) : null}
              {prefs.showNewLoginButton !== false ? (
                <button
                  className="btn btn--quiet"
                  onClick={() => setEditing('new')}
                  title="New login — right-click to hide"
                  onContextMenu={(event) => {
                    // Stopped here, same as Bulk add above: the window menu
                    // would otherwise overwrite this one.
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ x: event.clientX, y: event.clientY, items: hideChromeMenu('new-login', () => hideChrome('new-login'), () => openSettings('hidden')) });
                  }}
                >
                  <PlusIcon width="15" height="15" />
                  New login
                </button>
              ) : null}
            </div>
          </header>

{/* Flow and Orbit manage their own overflow. The dashboard is a normal
              scrolling page, so it must not inherit that. */}
          <div
            className="content"
            ref={contentRef}
            style={{
              ...(view !== 'basic' && activeChannel?.kind !== 'dashboard' ? { overflow: 'hidden' } : undefined),
              // A bottom-docked bar floats over the page end: without clearance
              // the dashboard's last rows scroll underneath it.
              ...(prefs.docks.some((dock) => dock.enabled && dock.pos.edge === 'bottom')
                ? { paddingBottom: 96 }
                : undefined),
            }}
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
              <div className="content__inner content__inner--dash">
                <Dashboard
                  channels={channels}
                  tags={prefs.tags}
                  items={vault.items}
                  prefs={prefs}
                  usage={prefs.usage}
                  onSelectChannel={(id) => setActiveId(id)}
                  onOpenLogin={(item) => requestEdit(item)}
                  onOpenSettings={(tab) => openSettings(tab)}
                  onAddLogin={() => setEditing('new')}
                  onNewChannel={() => setEditingChannel('new')}
                  onBulkAdd={() => setBulkAdding(true)}
                />
              </div>
            ) : showEmpty ? (
              <div className="content__inner">
                <ViewEmptyState
                  query={query}
                  screen={activeChannel ? activeChannel.id : `folder:${activeFolder?.id ?? ''}`}
                  onAdd={() => setEditing('new')}
                  onSearchAll={query.trim() && searchScope === 'channel' ? () => setSearchScope('all') : null}
                />
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
            ) : view === 'grid' ? (
              // Grid scrolls in the pane like List, so it gets the plain wrapper.
              <div data-vault-list>
                <GridView {...commonProps} {...cardProps} />
              </div>
            ) : (
              <div data-vault-list>
                <BasicView {...commonProps} {...cardProps} />
              </div>
            )}
          </div>
        </main>
      </div>

      {bulkField && selectedItems.length > 0 ? (
        <BulkEditDialog
          items={selectedItems}
          field={bulkField}
          tags={prefs.tags}
          onApply={(edit) => void applySelectionEdit(edit)}
          onCancel={() => setBulkField(null)}
          onNotify={notify}
        />
      ) : null}

      {bulkAdding ? (
        <BulkAddDialog
          existingUsernames={new Set(vault.items.map((item) => item.username.trim().toLowerCase()).filter(Boolean))}
          onAdd={(entries) => {
            void vault
              .mutate(async () => {
                const saved = new Set(vault.items.map((item) => item.username.trim().toLowerCase()).filter(Boolean));
                let added = 0;
                for (const entry of entries) {
                  // Re-checked at write time, so an address saved while the
                  // dialog was open still cannot duplicate.
                  if (saved.has(entry.username.toLowerCase())) continue;
                  saved.add(entry.username.toLowerCase());
                  await vault.service.addItem({
                    title: entry.username.split('@')[0] || entry.username,
                    username: entry.username,
                    password: entry.password,
                  });
                  added += 1;
                }
                return added;
              })
              .then((added) => notify(added === 1 ? 'Added 1 login' : `Added ${added} logins`));
          }}
          onCancel={() => setBulkAdding(false)}
          onNotify={notify}
        />
      ) : null}

      {bulkSecurity && selectedItems.length > 0 ? (
        <BulkSecurityDialog
          items={selectedItems}
          onNotify={notify}
          onCancel={() => setBulkSecurity(false)}
          onApply={async (factor) => {
            const targets = selectedItems;
            await vault.mutate(async () => {
              for (const item of targets) {
                if (!hasSecurityFactor(item, factor)) continue;
                await vault.service.updateItem(item.id, { security: withoutSecurityFactor(item, factor) });
              }
            });
          }}
        />
      ) : null}

      {bulkDelete && bulkDelete.length > 0 ? (
        <Modal
          title={`Delete ${bulkDelete.length} ${bulkDelete.length === 1 ? 'login' : 'logins'}?`}
          onClose={() => setBulkDelete(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setBulkDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  const targets = bulkDelete;
                  setBulkDelete(null);
                  selection.clear();
                  void vault.mutate(async () => {
                    for (const item of targets) await vault.service.deleteItem(item.id);
                  });
                  notify(`${targets.length} ${targets.length === 1 ? 'login' : 'logins'} deleted`);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="field__note">
            {bulkDelete.length === 1 ? `“${bulkDelete[0]?.title}” will be removed.` : null} This cannot be undone.
          </p>
        </Modal>
      ) : null}

      {/* Docks only exist on the unlocked vault screen: they jump between
          views and the inbox, none of which exist before unlock. */}
      {dockModels
        .filter((model) => model.dock.enabled)
        .map((model) => (
          <Dock
            key={model.dock.id}
            slots={model.slots}
            pos={model.dock.pos}
            onPosChange={(pos) => patchDock(model.dock.id, { pos })}
            onMenu={(event) => setMenu({ x: event.clientX, y: event.clientY, items: dockMenu(model.dock.id) })}
            onSlotMenu={(event, slotId) =>
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: dockSlotMenu(slotId),
              })
            }
          />
        ))}

      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <ViewContextMenu
        open={viewMenuOpen}
        x={viewMenuAt.x}
        y={viewMenuAt.y}
        value={view}
        labels={prefs.viewLabels}
        labelsByView={prefs.viewLabelsByView}
        onPick={(next) => void vault.updatePrefs({ view: next })}
        onClose={() => setViewMenuOpen(false)}
      />

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
        onOpenTuner={openTuner}
        onReset={async () => {
          // Goes through the hook, not the service: resetting only the service
          // wipes storage while the rendered logins stay on screen. Every
          // session-only set is dropped too, so a vault created afterwards
          // starts with no verified logins, no open folders and no selection
          // leaking over from the deleted one.
          await vault.resetVault();
          setActiveId('all');
          setEditing(null);
          selection.clear();
          setVerifiedItems(new Set());
          setFoldersUnlocked(new Set());
          setVaultVerified(false);
          setPendingItem(null);
          setConfirmDelete(null);
          setBulkDelete(null);
          setBulkSecurity(false);
          setBulkField(null);
          setMenu(null);
          setViewMenuOpen(false);
          notify('All data deleted from this device');
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
                  // Untagged, so it lands in Unassigned. A clipboard login has no
                  // site to categorise it by and guessing a channel here would
                  // quietly file it somewhere the user did not choose.
                  void vault
                    .mutate(() =>
                      vault.service.addItem({
                        title: clipPending.title?.trim() || clipPending.username.split('@')[0] || 'Clipboard login',
                        username: clipPending.username,
                        password: clipPending.password,
                        url: clipPending.url ?? '',
                        notes: clipPending.notes ?? '',
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
            {clipPending.title ? (
              <>
                <dt>Title</dt>
                <dd>{clipPending.title}</dd>
              </>
            ) : null}
            <dt>Username</dt>
            <dd>{clipPending.username}</dd>
            <dt>Password</dt>
            <dd>••••••</dd>
            {clipPending.url ? (
              <>
                <dt>Website</dt>
                <dd>{clipPending.url}</dd>
              </>
            ) : null}
          </dl>
          <p className="capture__note">Saves untagged, so it waits in Unassigned until you file it.</p>
          <p className="capture__note">Turn this off in Settings &gt; Security if it prompts too often.</p>
        </Modal>
      ) : null}

      {(() => {
        const liveAccount = mailboxFor ? prefs.gmailAccounts.find((entry) => entry.id === mailboxFor.id) : null;
        return liveAccount ? (
          <MailboxWindow
            key={liveAccount.id}
            account={liveAccount}
            cache={prefs.mailCache}
            onCacheMessages={viewActions.onCacheMail}
            onOpenExternal={(url) => getPlatform().openExternal(url)}
            onClose={() => setMailboxFor(null)}
          />
        ) : null;
      })()}

      {(() => {
        const liveItem = messagesFor ? vault.items.find((entry) => entry.id === messagesFor.id) : null;
        return liveItem ? (
          <Modal
            title={`Messages · ${liveItem.title || liveItem.username || 'Login'}`}
            onClose={() => setMessagesFor(null)}
            wide
          >
            <LoginMessages
              item={liveItem}
              accounts={prefs.gmailAccounts}
              accountScope="all"
              cache={prefs.mailCache}
              onCacheMessages={viewActions.onCacheMail}
              onOpenExternal={(url) => getPlatform().openExternal(url)}
              defaultOpen
            />
          </Modal>
        ) : null;
      })()}

      {editingChannel ? (
        <ChannelEditor
          // Remount per channel so the draft always matches what is being edited.
          key={editingChannel}
          channel={editingChannel === 'new' ? null : channels.find((entry) => entry.id === editingChannel) ?? null}
          tags={prefs.tags}
          accounts={prefs.gmailAccounts}
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
          gmailAccounts={prefs.gmailAccounts}
          onGmailAccountsChange={(gmailAccounts) => void vault.updatePrefs({ gmailAccounts })}
          onCacheMail={viewActions.onCacheMail}
          onCommitTags={(next) => void vault.updatePrefs({ tags: next })}
          generatorOptions={prefs.passwordGenerator}
          onGeneratorOptionsChange={(next) => void vault.updatePrefs({ passwordGenerator: next })}
          staleDays={prefs.passwordAgeDays}
          verified={editing === 'new' || verifiedItems.has(editing.id)}
          onRequestUnlock={() => {
            // Reached only when the editor was opened for a secured login
            // without the gate being cleared. Routes through the gate like
            // every other reveal path — the previous version marked the login
            // verified outright, so the "unlock" button showed the password
            // with no factor checked.
            if (editing && editing !== 'new') {
              setPendingIntent('reveal');
              setPendingItem(editing);
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
              const created = await vault.mutate(() => vault.service.addItem(draft));
              touchLogin(created.id);
              notify('Login added');
            } else if (editing) {
              // A changed password is re-graded on the spot: a weak replacement
              // earns the weak badge and a needs-attention flag immediately,
              // rather than waiting for the next health scan to notice it.
              // Only ever sets the flag, never clears it — clearing stays a
              // deliberate act, so saving a strong password cannot silently
              // dismiss a flag set for another reason.
              const rotatedWeak =
                draft.password !== undefined &&
                draft.password !== '' &&
                draft.password !== editing.password &&
                isWeakPassword({ password: draft.password });
              if (rotatedWeak) {
                draft = { ...draft, needsAttention: true };
              }
              await vault.mutate(() => vault.service.updateItem(editing.id, draft));
              touchLogin(editing.id);
              notify(rotatedWeak ? 'Saved — that password looks weak, flagged for attention' : 'Login updated');
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
              ['Switch channel', ['Alt', '1–9']],
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
  // Zero means zero work: three infinitely-animating gradient layers plus a
  // fullscreen grain layer cost compositing every frame even at opacity 0.
  if (strength <= 0) return null;
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
