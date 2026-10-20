import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { estimateStrength } from '../crypto/passwords.ts';
import { findReusedPasswords, hostnameOf, isWeakPassword, type VaultItem } from '../vault/types.ts';
import {
  applyChannel,
  createChannel,
  createTag,
  normaliseChannels,
  normaliseSidebar,
  groupChannelsIntoFolder,
  channelSeedFromFolder,
  moveChannelToFolder,
  moveManualOrder,
  selectableIds,
  parentFolderFor,
  ALL_LOGIN_TABS,
  describeChannel,
  sectionTarget,
  DEFAULT_BACKGROUND_FIELDS,
  CHANNEL_ACCENTS,
  CHANNEL_ICONS,
  CHANNEL_SCREEN_KINDS,
  UNASSIGNED_CHANNEL_ID,
  type AllLoginTab,
  type Channel,
  type Folder,
  type SidebarEntry,
  type Tag,
} from '../vault/channels.ts';
import {
  DEFAULT_DOCK_SLOTS,
  DEFAULT_LIST_TABS,
  DEFAULT_PREFERENCES,
  freeDockSpot,
  listTabsFor,
  MAX_DOCKS,
  mergeListTabs,
  mergeMailCache,
  moveListTab,
  newDockId,
} from '../vault/storage.ts';
import { captureToDraft, findSimilarTag, mailboxOwnedBy, mailboxUsable, planMailLinkedOnly, tagIdsForDraft } from '../vault/site-intel.ts';
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
import { HistoryPanel, type HistoryPanelProps } from './HistoryPanel.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ViewContextMenu, VIEW_OPTIONS, useViewShortcuts } from './ViewMenu.tsx';
import { Dock, useDockShortcuts, type DockSlot } from './Dock.tsx';
import { CHANNEL_ICONS_MAP } from './Sidebar.tsx';
import { ContextMenu, hideChromeMenu, type ChromeElementId, type ContextMenuState, type MenuItem } from './context-menu.tsx';
import { ChannelEditor } from './ChannelEditor.tsx';
import { Alert, Modal, Toasts } from './primitives.tsx';
import { BulkSecurityDialog, hasSecurityFactor, withoutSecurityFactor } from './BulkSecurityDialog.tsx';
import { AnimatedListView, BasicView, GridView, ViewEmptyState, type ViewActions } from './views.tsx';
import { LoginMessages } from './LoginMessages.tsx';
import { MailboxWindow } from './MailboxWindow.tsx';
import { MailCenter } from './MailCenter.tsx';
import {
  useAppActive,
  useAutoLock,
  useClipboard,
  useHotkeys,
  useSelectAllShortcuts,
  useToasts,
  useVault,
  applyAppearance,
  applyChannelAppearance,
  typingHasFocus,
  type Toast,
} from './hooks.ts';
import { useSelection } from './useSelection.ts';
import { applyBulkEdit, bulkMenu, type BulkEdit, type BulkField } from './bulk-edit.ts';
import { BulkAddDialog, BulkEditDialog } from './BulkEditDialog.tsx';
import { formatLoginCompact, formatLoginForClipboard, formatLoginsForClipboard } from './login-format.ts';
import { appActiveNow } from '../lib/activity.ts';
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

/**
 * The tag auto-applied to every login whose password is shared with another.
 * Matched by name (case-insensitively) so a vault that already has one keeps
 * its colour and id rather than gaining a second tag called the same thing.
 */
const REUSED_TAG_NAME = 'Reused password';

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
  id: UNASSIGNED_CHANNEL_ID,
  name: 'Unassigned',
  kind: 'unassigned',
  tagIds: [],
  icon: 'inbox',
  hue: 220,
  accent: 'slate',
  backgroundImage: '',
  ...DEFAULT_BACKGROUND_FIELDS,
  builtin: false,
  locked: false,
  showMail: true,
  mailAccount: 'all',
  security: EMPTY_SECURITY,
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
  const { toasts: rawToasts, notify: rawNotify } = useToasts();
  /**
   * The notification switch reads the preference each render, so flipping the
   * setting takes effect without an app restart. 'errors' keeps only the
   * error-toned toasts; 'off' silences everything; 'all' is the old behaviour.
   * The clipboard/shortcut plumbing below keeps calling `notify(...)` the same
   * way it always has — the filter lives only here.
   */
  const notificationsLevel = vault.prefs.notifications ?? 'all';
  const notify = useCallback(
    (message: string, tone?: Toast['tone'], duration?: number, onSelect?: () => void) => {
      if (notificationsLevel === 'off') return;
      if (notificationsLevel === 'errors' && tone !== 'error') return;
      rawNotify(message, tone, duration, onSelect);
    },
    [notificationsLevel, rawNotify],
  );
  const { copy } = useClipboard(vault.prefs.clearClipboardSeconds, notify, vault.prefs.copyToasts);
  // False while the window is minimized, in the tray, or behind another app.
  // Drives the `data-quiet` attribute below; the polling loops read the same
  // source themselves (see lib/activity).
  const appActive = useAppActive();

  const [activeId, setActiveId] = useState('all');
  /**
   * Which section of All logins is showing.
   *
   * Favorites, Needs attention and Weak or reused are tabs of the main channel
   * now, not rows of their own. The tab is a view of the same channel, so it
   * lives here rather than being pushed into the channel's kind — switching
   * tabs must not rewrite the channel the user saved.
   */
  const [allTab, setAllTab] = useState<AllLoginTab>('all');
  const [query, setQuery] = useState('');
  /** Tags chosen from the search bar's tag picker; any of them matches. */
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagPickerQuery, setTagPickerQuery] = useState('');
  /** Whether the open folder's notes are expanded. Per visit, not persisted. */
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    setNotesOpen(false);
  }, [activeId]);
  // The tag picker closes on a click anywhere outside it, the way a popover
  // should; leaving it open behind the next click would swallow that click.
  useEffect(() => {
    if (!tagPickerOpen) return;
    const onDown = (event: MouseEvent) => {
      if (tagPicker.current?.contains(event.target as Node)) return;
      setTagPickerOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [tagPickerOpen]);
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
  const [bulkField, setBulkField] = useState<BulkField | null>(null);
  const [bulkSecurity, setBulkSecurity] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  // True while a History restore is being written: two clicks on a slow disk
  // would otherwise restore the same version twice and log it twice.
  const [historyBusy, setHistoryBusy] = useState(false);
  const [bulkDelete, setBulkDelete] = useState<VaultItem[] | null>(null);
  /**
   * A section of the Dashboard to jump to, set by the reused-password notice.
   * Cleared as soon as it has been honoured so a later visit is not re-flashed.
   */
  const [dashboardFocus, setDashboardFocus] = useState<'reused' | null>(null);
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
  // Tags of whatever channel or folder is open, mirrored into a ref for the
  // clipboard watcher below: that hook is wired up before the sidebar tree is
  // computed, and a paste has to read the *current* selection, not the one from
  // the render that first installed the watcher.
  const focusedTagsRef = useRef<readonly string[]>([]);
  // Whether a folder (rather than a channel) is open, mirrored into a ref for
  // the same reason as the tags: the paste and clipboard paths are wired up
  // before the sidebar tree is computed. A login that arrives in a folder is
  // filed by the folder, never by a provider guess from its address.
  const folderOpenRef = useRef(false);
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
  /** The strip tab being dragged, and the tab/edge it would be dropped on. */
  const [stripDrag, setStripDrag] = useState<{ id: string; over: string; after: boolean } | null>(null);
  const openSettings = useCallback((tab?: string) => {
    setSettingsTab(tab);
    setShowSettings(true);
  }, []);
  const search = useRef<HTMLInputElement>(null);
  const tagPicker = useRef<HTMLDivElement>(null);
  const view = vault.prefs.view;
  const prefs = vault.prefs;

  useAutoLock(prefs.autoLockMinutes, vault.status === 'unlocked', vault.lock);

  /**
   * The tags a login arriving right now should carry.
   *
   * One rule for every way a login can arrive — typed, pasted, bulk-added, or
   * accepted from the capture prompt — so automatic tagging means the same thing
   * in All logins as it does anywhere else:
   *
   *  1. the open channel's tags, or the open folder's main tags, come first;
   *  2. the login's own site and email provider are added when automatic tagging
   *     is on, which is what files a login created in All logins by what it is
   *     for instead of leaving it in Unassigned;
   *  3. inside a folder the provider guess is skipped: the folder's own tags are
   *     the filing there, and a login made in it has to belong to it.
   *
   * Read through refs rather than the memos, so the early clipboard watcher and
   * the late editor can share one callback without either capturing a stale set.
   */
  const tagsForNewLogin = useCallback(
    // `catalogue` is overridable so a bulk paste can keep chaining the tags it
    // has already created into the next entry, instead of minting a second copy
    // of each new tag per row.
    (draft: { url?: string; username?: string }, catalogue: Tag[] = prefs.tags) =>
      tagIdsForDraft(draft, focusedTagsRef.current, catalogue, {
        autoTag: prefs.autoTagDomain && !folderOpenRef.current,
      }),
    [prefs.autoTagDomain, prefs.tags],
  );

  // Clipboard login detection, opt-in from Settings.
  const { pending: clipPending, dismiss: dismissClip } = useClipboardWatcher({
    enabled: prefs.clipboardCapture,
    unlocked: vault.status === 'unlocked',
    autoSave: prefs.clipboardAutoSave,
    onAutoSave: (creds) => {
      // Filed where the paste landed: the open tagged channel or folder's tags
      // come first, then whatever the login's own address and site suggest. With
      // neither, the login is left untagged and waits in Unassigned, as before.
      const { tagIds, catalogue } = tagsForNewLogin(creds);
      void (async () => {
        if (catalogue !== prefs.tags) await vault.updatePrefs({ tags: catalogue });
        const created = await vault.mutate(() =>
          vault.service.addItem({
            // A clipboard block that carried a title keeps it; otherwise the
            // local part of the address is a better guess than "Clipboard login".
            title: creds.title?.trim() || creds.username.split('@')[0] || 'Clipboard login',
            username: creds.username,
            password: creds.password,
            url: creds.url ?? '',
            notes: creds.notes ?? '',
            tags: tagIds,
          }),
        );
        appendToOrder([created.id]);
        notify('Saved credentials from the clipboard');
      })();
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

  // The same for a single channel that carries its own factor.
  const [channelsUnlocked, setChannelsUnlocked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (vault.status !== 'unlocked') setChannelsUnlocked(new Set());
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

      // The open channel — or folder — files it first, exactly as it does for a
      // paste or a login typed into the editor. Without this, a capture accepted
      // while a channel was open landed in Unassigned instead of the channel the
      // user was looking at.
      for (const id of focusedTagsRef.current) {
        if (catalogue.some((tag) => tag.id === id) && !tagIds.includes(id)) tagIds.push(id);
      }

      // Then the capture's own guesses, when automatic tagging is on. These come
      // from `inspectCapture` rather than a fresh guess, so they keep the richer
      // work: an unknown mail provider still falls back to the domain itself.
      if (prefs.autoTagDomain && !folderOpenRef.current) {
        for (const suggestion of offer.insight.suggestedTags) {
          if (suggestion.id) {
            // Guard against a tag that was deleted while the prompt was open.
            if (catalogue.some((tag) => tag.id === suggestion.id)) {
              if (!tagIds.includes(suggestion.id)) tagIds.push(suggestion.id);
              continue;
            }
          }
          const similar = findSimilarTag(suggestion.name, catalogue.map((tag) => ({ id: tag.id, name: tag.name })));
          if (similar) {
            if (!tagIds.includes(similar.id)) tagIds.push(similar.id);
            continue;
          }
          const created = createTag(suggestion.name, catalogue);
          catalogue = [...catalogue, created];
          tagIds.push(created.id);
        }
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

      const created = await vault.mutate(() => vault.service.addItem({ ...draft, tags: tagIds }));
      await vault.updatePrefs({ tags: catalogue, channels });
      appendToOrder([created.id]);
      notify(`Saved ${draft.title}`);
    },
    [notify, prefs.autoTagChannel, prefs.autoTagDomain, prefs.channels, prefs.tags, vault],
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
  const channelLookup = useMemo(() => [...channels, UNASSIGNED], [channels]);

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

  const activeFolder = useMemo(
    () => (activeId.startsWith('folder:') ? folders.find((folder) => folder.id === activeId.slice('folder:'.length)) ?? null : null),
    [folders, activeId],
  );
  const activeChannel = useMemo(() => {
    if (activeFolder) return null;
    return channelLookup.find((channel) => channel.id === activeId) ?? channelLookup.find((c) => c.kind === 'all') ?? channels[0]!;
  }, [channelLookup, activeId, activeFolder, channels]);

  /**
   * Opens a channel, optionally on one of the merged tabs.
   *
   * Every deliberate jump to a channel goes through here, so the tab always
   * matches where the jump came from: clicking All logins in the rail shows
   * everything, while the Dashboard's Favorites tile opens All logins *on*
   * Favorites. Without the reset the second click on "the same" row would land
   * on whichever tab was left behind.
   */
  const openChannel = useCallback((id: string, tab?: AllLoginTab) => {
    setActiveId(id);
    setAllTab(tab ?? 'all');
  }, []);

  /**
   * Jumps to a merged section: a channel the user made with that kind if one
   * exists, otherwise the All logins tab that now stands in for it.
   */
  const openSection = useCallback(
    (tab: AllLoginTab) => {
      const target = sectionTarget(channels, tab);
      openChannel(target.channelId, target.tab);
    },
    [channels, openChannel],
  );

  /**
   * The channel as the list should read it: the merged tabs are the All logins
   * channel with a different base filter, so the kind is swapped for the list
   * while the channel itself — tags, look, security — stays what it is.
   */
  const listChannel = useMemo(() => {
    if (!activeChannel) return null;
    if (activeChannel.id !== 'all' || allTab === 'all') return activeChannel;
    return { ...activeChannel, kind: allTab as Channel['kind'] };
  }, [activeChannel, allTab]);

  /**
   * Which strip configuration governs the current screen: the built-in All
   * logins channel answers to the 'all' scope, a folder screen to its own, and
   * any other channel to its id. Absent means no strip at all.
   */
  const scopeId = activeFolder ? `folder:${activeFolder.id}` : activeChannel ? activeChannel.id : 'all';

  /** The workspace whose drag order applies: a folder, a channel, or all. */
  const scopeKey = activeFolder ? `folder:${activeFolder.id}` : activeId;

  /**
   * The folder a channel is being created in — the one explicitly chosen from
   * a folder's menu, or the folder that is open. Null at the root.
   */
  const pendingChannelFolder = useMemo(() => {
    const id = newChannelFolder ?? activeFolder?.id ?? null;
    return id ? folders.find((folder) => folder.id === id) ?? null : null;
  }, [newChannelFolder, activeFolder, folders]);

  /** Starting tags and look for a new channel, copied from that folder. */
  const channelSeed = useMemo(
    () => (pendingChannelFolder ? channelSeedFromFolder(pendingChannelFolder) : undefined),
    [pendingChannelFolder],
  );

  /**
   * Records freshly added logins at the end of the current workspace's order.
   * New logins used to land wherever the alphabetical tie-break put them (and,
   * inside a scope with no order of its own, in the middle of the list). This
   * pins them to the bottom of the page the user just added to.
   */
  const appendToOrder = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const base = prefs.manualOrderByScope[scopeKey] ?? prefs.manualOrder;
      const nextScope = [...base];
      for (const id of ids) if (!nextScope.includes(id)) nextScope.push(id);
      const nextGlobal = [...prefs.manualOrder];
      for (const id of ids) if (!nextGlobal.includes(id)) nextGlobal.push(id);
      void vault.updatePrefs({
        manualOrder: nextGlobal,
        manualOrderByScope: { ...prefs.manualOrderByScope, [scopeKey]: nextScope },
      });
    },
    [prefs.manualOrder, prefs.manualOrderByScope, scopeKey, vault],
  );

  /**
   * The tags the open channel — or, for a folder, its channels — stands for.
   *
   * This is what a newly pasted login inherits: a login that arrives while a
   * tagged channel is on screen belongs to that channel's subject matter. A
   * folder's union is deliberate rather than "the first child's tags", because
   * a folder is a group of channels and the paste cannot know which child it
   * would have gone to.
   */
  const focusedTagIds = useMemo(() => {
    if (activeFolder) {
      // A folder files by its own tags first. Its main and alternate sets are
      // what a login created here belongs to; the old union-of-children rule
      // was what put a login under "Google" while it was pasted into a work
      // folder whose channels had no tags at all.
      const own = [...new Set([...activeFolder.tagIds, ...activeFolder.altTagIds])];
      if (own.length > 0) return own;
      const entry = sidebarBase.find((row) => row.kind === 'folder' && row.id === activeFolder.id);
      const ids = new Set<string>();
      if (entry && entry.kind === 'folder') {
        for (const child of entry.children) {
          if (child.kind !== 'channel') continue;
          for (const tagId of channelLookup.find((channel) => channel.id === child.id)?.tagIds ?? []) {
            ids.add(tagId);
          }
        }
      }
      return [...ids];
    }
    return activeChannel?.tagIds ?? [];
  }, [activeFolder, activeChannel, sidebarBase, channelLookup]);
  focusedTagsRef.current = focusedTagIds;
  folderOpenRef.current = Boolean(activeFolder);

  /** The Dashboard row, so the reused-password notice can lead there. */
  const dashboardChannelId = useMemo(
    () => channels.find((channel) => channel.kind === 'dashboard')?.id ?? null,
    [channels],
  );

  /**
   * Says that some passwords are shared, without standing in the way.
   *
   * This was a modal in front of the copy, so every click on a reused login
   * became an interrogation. It is a notification now: it says its piece for a
   * few seconds and tapping it jumps to the Dashboard, where the reused logins
   * are listed. Nothing is reused means nothing is said.
   */
  const notifyReusedPasswords = useCallback(() => {
    const shared = vault.items.filter((item) => item.password !== '' && duplicateIds.has(item.password));
    if (shared.length === 0) return;
    notify(
      `${shared.length} ${shared.length === 1 ? 'login shares' : 'logins share'} a reused password — tap to review`,
      'error',
      3000,
      () => {
        if (!dashboardChannelId) return;
        setActiveId(dashboardChannelId);
        setDashboardFocus('reused');
      },
    );
  }, [vault.items, duplicateIds, notify, dashboardChannelId]);

  /* ---- The reused-password reminder, on a slow timer ---------------------
     "From time to time" without nagging: once a few seconds after the vault
     settles with something shared, then no more often than every two minutes,
     and never while the window is in the background — a reminder nobody can
     see is just wasted work. */
  useEffect(() => {
    if (vault.status !== 'unlocked' || !prefs.warnOnReuse || duplicateIds.size === 0) return;
    const first = setTimeout(() => notifyReusedPasswords(), 6_000);
    const repeat = setInterval(() => {
      if (appActiveNow()) notifyReusedPasswords();
    }, 120_000);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [vault.status, prefs.warnOnReuse, duplicateIds, notifyReusedPasswords]);

  /* ---- A tag for reused passwords ----------------------------------------
     Every login sharing a password is filed under one tag, so the group is a
     sidebar row you can work through rather than a number on a panel. The ids
     are collected on the spot and written once, and the write is deliberately
     unlogged: the History channel is for changes a user made, not for this
     housekeeping pass revisiting every reused login on every launch. */
  const taggingReused = useRef(false);
  useEffect(() => {
    if (vault.status !== 'unlocked' || !prefs.autoTagReused || duplicateIds.size === 0) return;
    if (taggingReused.current) return;
    const existing = prefs.tags.find((tag) => tag.name.trim().toLowerCase() === REUSED_TAG_NAME.toLowerCase());
    const targets = vault.items.filter(
      (item) =>
        item.password !== '' &&
        duplicateIds.has(item.password) &&
        !(existing && item.tags.includes(existing.id)),
    );
    if (targets.length === 0) return;
    taggingReused.current = true;
    void (async () => {
      try {
        let tagId = existing?.id;
        if (!tagId) {
          const created = createTag(REUSED_TAG_NAME, prefs.tags);
          tagId = created.id;
          await vault.updatePrefs({ tags: [...prefs.tags, created] });
        }
        const id = tagId;
        await vault.mutate(async () => {
          for (const item of targets) {
            if (item.tags.includes(id)) continue;
            await vault.service.updateItem(item.id, { tags: [...item.tags, id] });
          }
        }, { log: false });
      } finally {
        taggingReused.current = false;
      }
    })();
    // `vault`'s actions are stable callbacks, so the effect keys off the data
    // it reads rather than the object the hook returns each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status, vault.items, prefs.autoTagReused, prefs.tags, duplicateIds]);

  /**
   * The folder a channel sits in, if any.
   *
   * Needed wherever a channel is filtered, not just where it is drawn: a
   * channel inside a folder is scoped by the folder's main tags, so a count or
   * a list computed without the parent answers a different question.
   */
  const getParentFolderForChannel = useCallback(
    (id: string) => parentFolderFor(sidebarBase, folders, id),
    [sidebarBase, folders],
  );

  /** How long a password may go unchanged before the weak/stale view counts it. */
  const staleDays = prefs.passwordAgeDays;

  /** Keyed by channel id, for the sidebar badges. The dashboard is a summary
   *  screen rather than a filtered list, so it gets no count. A folder badge is
   *  its own scope, not the sum of its children. */
  const channelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const channel of channelLookup) {
      if (channel.kind === 'dashboard') continue;
      // History counts what it *lists* — the logged changes — not the logins
      // they refer to, so the badge matches the number of rows in the pane.
      counts[channel.id] =
        channel.kind === 'history'
          ? prefs.history.length
          // The parent folder goes in, because a channel inside one is scoped by
          // the folder's tags: without it the badge counts logins the channel
          // does not list, and a folder child reads as far larger than it is.
          : applyChannel(channel, vault.items, staleDays, getParentFolderForChannel(channel.id)).length;
    }
    for (const folder of folders) {
      const entry = sidebarBase.find((row) => row.kind === 'folder' && row.id === folder.id);
      if (!entry || entry.kind !== 'folder') continue;
      // One row per login over the folder's whole scope: everything carrying its
      // main tags, plus whatever its channels add. Summing the children instead
      // double-counts a login two channels share, and misses one that carries
      // the folder's tag and no channel's own.
      const seen = new Set<string>();
      if (folder.tagIds.length > 0) {
        for (const item of vault.items) {
          if (folder.tagIds.every((tagId) => item.tags.includes(tagId))) seen.add(item.id);
        }
      }
      for (const child of entry.children) {
        if (child.kind !== 'channel') continue;
        const channel = channelLookup.find((candidate) => candidate.id === child.id);
        if (!channel) continue;
        for (const item of applyChannel(channel, vault.items, staleDays, folder)) seen.add(item.id);
      }
      counts[`folder:${folder.id}`] = seen.size;
    }
    return counts;
  }, [channelLookup, vault.items, staleDays, folders, sidebarBase, prefs.history, getParentFolderForChannel]);

  /* ---- Picking several channels at once ------------------------------------
     Ctrl/Cmd+click toggles one row in and out of the selection, Shift+click
     takes the run between the last row touched and this one, and a plain click
     clears the selection and just opens the channel as it always did — so
     nothing about the everyday gesture changes, and the bulk bar appears only
     while something is actually picked.

     The anchor is a ref: it is bookkeeping for the next Shift+click, never
     something the rail paints, and putting it in state would re-render the whole
     shell on every click of a run. */
  const [channelSelection, setChannelSelection] = useState<ReadonlySet<string>>(new Set());
  const selectionAnchor = useRef<string | null>(null);
  const selectionOrder = useMemo(() => selectableIds(sidebarBase), [sidebarBase]);

  const clearChannelSelection = useCallback(() => setChannelSelection(new Set()), []);

  const clickChannelRow = useCallback(
    (id: string, event: React.MouseEvent) => {
      if (event.shiftKey && selectionAnchor.current) {
        const from = selectionOrder.indexOf(selectionAnchor.current);
        const to = selectionOrder.indexOf(id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          setChannelSelection(new Set(selectionOrder.slice(start, end + 1)));
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        selectionAnchor.current = id;
        setChannelSelection((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      selectionAnchor.current = id;
      clearChannelSelection();
      // Through openChannel rather than setActiveId so the merged sections reset:
      // clicking All logins in the rail means the whole list, not whichever
      // section was left open last time.
      openChannel(id);
    },
    [clearChannelSelection, openChannel, selectionOrder],
  );

  /** The ids behind the selection, split into channels and folders. */
  const selectedChannelIds = useMemo(
    () => [...channelSelection].filter((id) => channelLookup.some((channel) => channel.id === id)),
    [channelSelection, channelLookup],
  );
  const selectedFolderIds = useMemo(
    () => [...channelSelection]
      .filter((id) => id.startsWith('folder:'))
      .map((id) => id.slice('folder:'.length)),
    [channelSelection],
  );

  /**
   * Hide/show/delete for a whole selection.
   *
   * Deletion skips the locked rows instead of refusing outright, and says which
   * ones it kept: Dashboard, Mail and History are structural (see
   * normaliseChannels) and "delete 6 channels" should not silently take one of
   * them, nor fail as a whole because one row was in the selection.
   */
  const runBulkChannelAction = useCallback(
    (action: 'hide' | 'show' | 'delete' | 'clear') => {
      if (action === 'clear') {
        clearChannelSelection();
        return;
      }
      if (action === 'hide') {
        void vault
          .updatePrefs({
            hiddenChannels: [...new Set([...prefs.hiddenChannels, ...selectedChannelIds])],
            hiddenFolders: [...new Set([...prefs.hiddenFolders, ...selectedFolderIds])],
          })
          .then(() =>
            notify(
              `Hid ${selectedChannelIds.length + selectedFolderIds.length} rows — bring them back in Settings › Hidden`,
            ),
          );
        clearChannelSelection();
        return;
      }
      if (action === 'show') {
        const channels = new Set(selectedChannelIds);
        const foldersToShow = new Set(selectedFolderIds);
        void vault
          .updatePrefs({
            hiddenChannels: prefs.hiddenChannels.filter((id) => !channels.has(id)),
            hiddenFolders: prefs.hiddenFolders.filter((id) => !foldersToShow.has(id)),
          })
          .then(() => notify('Selection is visible again'));
        clearChannelSelection();
        return;
      }
      // Delete.
      const locked = selectedChannelIds.filter(
        (id) => channelLookup.find((channel) => channel.id === id)?.locked,
      );
      const doomed = selectedChannelIds.filter((id) => !locked.includes(id));
      if (doomed.length === 0) {
        notify('Those rows are part of the app — they can be hidden, not deleted', 'error');
        return;
      }
      const gone = new Set(doomed);
      const goneFolders = new Set(selectedFolderIds);
      // Strips the *stored* tree rather than the rendered one: the rail appends
      // Unassigned and pins Dashboard, and writing that back would bake the
      // pseudo-channel into the tree (so it would appear twice on next load).
      const strip = (list: SidebarEntry[]): SidebarEntry[] =>
        list
          .filter((entry) => !(entry.kind === 'channel' && gone.has(entry.id)))
          .filter((entry) => !(entry.kind === 'folder' && goneFolders.has(entry.id)))
          .map((entry) => (entry.kind === 'folder' ? { ...entry, children: strip(entry.children) } : entry));
      // A deleted channel's id is dropped from every list that referred to it:
      // leaving it in `hiddenChannels` or `manualOrder` would make a later
      // channel that reuses the id inherit the old row's state.
      void vault
        .updatePrefs({
          channels: channels.filter((channel) => !gone.has(channel.id)),
          folders: prefs.folders.filter((folder) => !goneFolders.has(folder.id)),
          sidebar: strip(normaliseSidebar(prefs.sidebar, channels, folders)),
          hiddenChannels: prefs.hiddenChannels.filter((id) => !gone.has(id)),
          hiddenFolders: prefs.hiddenFolders.filter((id) => !goneFolders.has(id)),
          manualOrder: prefs.manualOrder.filter((id) => !gone.has(id)),
        })
        .then(() => {
          if (gone.has(activeId)) setActiveId('all');
          notify(
            `Deleted ${doomed.length} channel${doomed.length === 1 ? '' : 's'}` +
              (goneFolders.size > 0 ? ` and ${goneFolders.size} folder${goneFolders.size === 1 ? '' : 's'}` : '') +
              (locked.length > 0 ? ` — kept ${locked.length} built-in row${locked.length === 1 ? '' : 's'}` : ''),
          );
        });
      clearChannelSelection();
    },
    [
      activeId,
      channelLookup,
      channels,
      clearChannelSelection,
      folders,
      notify,
      prefs.folders,
      prefs.hiddenChannels,
      prefs.hiddenFolders,
      selectedChannelIds,
      selectedFolderIds,
      sidebarBase,
      vault,
    ],
  );

  // A channel carries its own accent and image, so the app re-skins while it is
  // selected. Anything the channel leaves blank falls back to the preference.
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

  /**
   * A channel with its own factor, gated the same way at the same point: the
   * list behind it is what is protected, so the sidebar row stays visible and
   * asks on arrival rather than disappearing.
   */
  const channelLocked = Boolean(
    !activeFolder &&
      activeChannel &&
      isSecured(activeChannel.security) &&
      !channelsUnlocked.has(activeChannel.id),
  );

  /* ---- The tab strip, configured per scope ---------------------------------
      `prefs.listTabs` is a record keyed by scope — 'all', a channel id, or
      'folder:<id>' — whose values are tab ids: built-ins are 'tab:all',
      'tab:favorites', 'tab:attention' and 'tab:weak', and any channel id adds
      that channel as a tab. A scope with no record inherits the shipped four
      tabs, so every channel and folder shows a strip without having to be
      configured first; an empty array is the explicit "hide it here" value.
      Right-clicking a tab (or the strip) opens the configuration menu. */
  const configuredStrip = useCallback(
    (scope: string): string[] => listTabsFor(prefs.listTabs, scope),
    [prefs.listTabs],
  );

  const stripTabs = useMemo(() => {
    if (folderLocked || channelLocked) return [];
    const config = configuredStrip(scopeId);
    const builtIn = new Map(ALL_LOGIN_TABS.map((tab) => [`tab:${tab.kind}`, tab.label]));
    const tabs: { id: string; label: string; kind?: AllLoginTab; channel?: Channel; active: boolean }[] = [];
    for (const id of config) {
      const builtLabel = builtIn.get(id);
      if (builtLabel) {
        const kind = id.slice(4) as AllLoginTab;
        // On All logins the current section is a tab; elsewhere a built-in tab
        // is a jump target. A tag channel also has kind 'all', so comparing
        // kinds alone would light up "All" on every channel; compare the
        // channel the tab actually opens instead.
        const targetId = sectionTarget(channels, kind).channelId;
        const active = activeChannel?.id === 'all' ? allTab === kind : activeChannel?.id === targetId;
        tabs.push({ id, label: builtLabel, kind, active });
        continue;
      }
      const own = channelLookup.find((channel) => channel.id === id);
      if (own) {
        tabs.push({ id, label: own.name, channel: own, active: own.id === activeChannel?.id });
      }
    }
    return tabs;
  }, [configuredStrip, scopeId, channelLookup, channels, folderLocked, channelLocked, activeChannel, allTab]);

  /** Counts for every tab the strip shows. */
  const stripCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (folderLocked || channelLocked) return counts;
    if (activeChannel) {
      const parent = getParentFolderForChannel(activeChannel.id);
      for (const tab of ALL_LOGIN_TABS) {
        counts[`tab:${tab.kind}`] = applyChannel(
          { ...activeChannel, kind: tab.kind },
          vault.items,
          staleDays,
          parent,
        ).length;
      }
    }
    for (const entry of stripTabs) {
      if (entry.channel) {
        counts[entry.id] = applyChannel(
          entry.channel,
          vault.items,
          staleDays,
          getParentFolderForChannel(entry.channel.id),
        ).length;
      }
    }
    return counts;
  }, [folderLocked, channelLocked, activeChannel, stripTabs, vault.items, staleDays, getParentFolderForChannel]);

  /**
   * Keeps the strip alive across a strip jump.
   *
   * A tab that opens another channel used to land on a scope with a different
   * strip — or on All logins, whose shipped four tabs know nothing about the
   * channel tabs the jump came from — so tabs vanished under the pointer. The
   * destination strip is now the union of the source strip and whatever it
   * already had, with the source order first so the visible row does not
   * reshuffle. Nothing that was on screen can disappear; at most a tab the
   * destination already owned is appended after the source ones. The channel
   * the jump came from is appended as a back-tab, and the channel just opened
   * is rendered as the current one rather than being filtered out.
   */
  const carryStripTo = useCallback(
    (to: string, via?: string) => {
      if (to === scopeId) return;
      const stored = vault.prefs.listTabs;
      const source = configuredStrip(scopeId);
      // The destination's effective strip, not merely its stored record: an
      // unconfigured scope inherits the shipped four tabs, and those must be
      // part of the union rather than silently dropped by the first jump.
      const existing = configuredStrip(to);
      // All logins and folders are not channels, so they cannot be tabs.
      const back = scopeId !== 'all' && !scopeId.startsWith('folder:') ? scopeId : undefined;
      const merged = mergeListTabs(source, existing, via, back);
      // Skip the write when the union is exactly what is already stored;
      // otherwise every jump would save the whole preference object.
      if (
        merged.length === existing.length &&
        merged.every((id, index) => id === existing[index])
      ) {
        return;
      }
      void vault.updatePrefs({ listTabs: { ...stored, [to]: merged } });
    },
    [configuredStrip, scopeId, vault],
  );

  /** What pressing a strip tab does. */
  const openStripTab = useCallback(
    (id: string) => {
      if (id.startsWith('tab:')) {
        const kind = id.slice(4) as AllLoginTab;
        // From All logins the tab swaps the section in place; from anywhere
        // else it jumps to the section's channel — the user's own row if they
        // made one, the All logins tab otherwise.
        if (activeChannel?.id === 'all') setAllTab(kind);
        else {
          const target = sectionTarget(channels, kind);
          carryStripTo(target.channelId, id);
          openChannel(target.channelId, target.tab);
        }
        return;
      }
      carryStripTo(id, id);
      openChannel(id);
    },
    [activeChannel, channels, carryStripTo, openChannel],
  );

  /** Writes one scope's strip configuration back to the preferences. */
  const setStripTabs = useCallback(
    (scope: string, tabs: string[]) => {
      const next = { ...vault.prefs.listTabs, [scope]: tabs };
      // An empty list means "hide the strip here", stored as an empty array so
      // an explicit hide survives the round-trip.
      void vault.updatePrefs({ listTabs: next });
    },
    [vault],
  );

  /** Drops a dragged tab before or after another one in the visible strip. */
  const reorderStripTab = useCallback(
    (from: string, to: string, after: boolean) => {
      // Reordering an inherited strip writes the whole effective order into
      // this scope, so the drag persists without disturbing any other scope.
      const current = configuredStrip(scopeId);
      const next = moveListTab(current, from, to, after);
      if (next.length === current.length && next.every((id, index) => id === current[index])) return;
      setStripTabs(scopeId, next);
    },
    [configuredStrip, scopeId, setStripTabs],
  );

  /** Whether a scope already shows the shipped strip, so Reset would do nothing. */
  const stripIsDefault = useCallback(
    (scope: string) => {
      const tabs = vault.prefs.listTabs[scope];
      // A channel or folder with no record inherits the shipped strip already.
      if (scope !== 'all') return tabs === undefined;
      const fallback = DEFAULT_LIST_TABS.all ?? [];
      return !tabs || (tabs.length === fallback.length && tabs.every((id, index) => id === fallback[index]));
    },
    [vault.prefs.listTabs],
  );

  /** The strip's right-click menu: hide a tab, add tabs, reset the strip. */
  const stripMenu = useCallback(
    (tabId: string | null): MenuItem[] => {
      const current = configuredStrip(scopeId).filter((id) => id !== tabId);
      const addableLabels: { id: string; label: string }[] = [
        ...ALL_LOGIN_TABS.map((tab) => ({ id: `tab:${tab.kind}`, label: tab.label })),
        // The current scope's own channel is addable too: a tab pointing at
        // where you already are now renders as the current tab instead of
        // being filtered out, so it is a marker rather than a dead button.
        ...channelLookup.map((channel) => ({ id: channel.id, label: channel.name })),
      ];
      const missing = addableLabels.filter((tab) => !current.includes(tab.id));
      const items: MenuItem[] = [];
      if (tabId) {
        items.push({
          kind: 'item',
          label: 'Hide this tab',
          onSelect: () => {
            setStripTabs(scopeId, current);
            notify('Tab hidden — right-click the strip to bring tabs back');
          },
        });
        items.push({ kind: 'separator' });
      }
      items.push({
        kind: 'submenu',
        label: 'Add tabs…',
        icon: <PlusIcon />,
        heading: 'Add to this strip',
        disabled: missing.length === 0 || current.length >= 8,
        items: missing.map((tab) => ({
          kind: 'item' as const,
          label: tab.label,
          icon: tab.id === 'tab:favorites' ? <StarIcon /> : tab.id === 'tab:attention' ? <FlagIcon /> : tab.id === 'tab:weak' ? <ShieldIcon /> : <LayersIcon />,
          onSelect: () => {
            setStripTabs(scopeId, [...configuredStrip(scopeId), tab.id]);
            notify(`"${tab.label}" added to this strip`);
          },
        })),
      });
      items.push({
        kind: 'item',
        label: 'Reset this strip',
        icon: <RowsIcon />,
        disabled: stripIsDefault(scopeId),
        onSelect: () => {
          const next = { ...vault.prefs.listTabs };
          if (scopeId in DEFAULT_LIST_TABS) next[scopeId] = [...DEFAULT_LIST_TABS[scopeId]!];
          else delete next[scopeId];
          void vault.updatePrefs({ listTabs: next });
          notify('Strip reset');
        },
      });
      return items;
    },
    [channelLookup, configuredStrip, scopeId, setStripTabs, notify, stripIsDefault, vault.prefs.listTabs, vault],
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
      // The folder row is the folder's whole scope, not merely the sum of its
      // channels. A channel narrows its own tags within the folder, so a login
      // carrying the folder's main tags but none of a channel's own would
      // otherwise be listed nowhere — present in the vault, invisible in the
      // folder it is filed under. Unioning the children on top keeps channels
      // that narrow by tags the folder itself does not carry (see
      // channelTagFilter for when the narrowing set is the channel's own).
      if (activeFolder.tagIds.length > 0) {
        for (const item of vault.items) {
          if (activeFolder.tagIds.every((tagId) => item.tags.includes(tagId))) {
            seen.add(item.id);
            list.push(item);
          }
        }
      }
      if (entry && entry.kind === 'folder') {
        for (const child of entry.children) {
          if (child.kind !== 'channel') continue;
          const channel = channelLookup.find((candidate) => candidate.id === child.id);
          if (!channel) continue;
          // Folder tags scope each child channel: the folder's main tags are
          // required and the child's own tags are the narrowing set.
          for (const item of applyChannel(channel, vault.items, staleDays, activeFolder)) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              list.push(item);
            }
          }
        }
      }
    } else {
      // Channel-scoped (and folder-scoped above): the channel filters first,
      // the text query filters second. Searching the whole vault is what the
      // explicit "entire vault" scope is for.
      // `listChannel` rather than `activeChannel`: on the All logins channel
      // that carries the selected tab's kind, so Favorites lists favorites.
      const parent = getParentFolderForChannel(listChannel!.id);
      list = applyChannel(listChannel!, vault.items, staleDays, parent);
    }

    // The drag order, as an index map. Each workspace has its own list, so
    // arranging one channel does not rearrange another; a workspace with no
    // list of its own follows the global order, which is what an existing
    // vault already has. Ids never dragged stay after every placed id in
    // title order, so new logins need no bookkeeping.
    const orderForScope = prefs.manualOrderByScope[scopeKey] ?? prefs.manualOrder;
    const manualIndex = new Map(orderForScope.map((id, index) => [id, index] as const));
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

    // Tags chosen from the search bar. Applied before the text query so the two
    // narrow together: a picked tag plus a typed word is "that tag AND this
    // text", which is what the two controls sitting in one bar imply.
    const tagged = tagFilters.length === 0
      ? sorted
      : sorted.filter((item) => tagFilters.some((id) => item.tags.includes(id)));

    if (!needle) return tagged;
    // Tag names count as searchable text too, so typing "work" finds a login
    // carrying that tag even when its title and username say nothing about it.
    const tagNames = (item: VaultItem) =>
      item.tags.map((id) => prefs.tags.find((tag) => tag.id === id)?.name ?? '').join(' ');
    return tagged.filter((item) =>
      [item.title, item.username, item.url, item.notes, tagNames(item)].some((field) =>
        (field ?? '').toLowerCase().includes(needle),
      ),
    );
  }, [
    vault.items,
    // `listChannel`, not `activeChannel`: on All logins the tabs swap the kind
    // on `listChannel` while `activeChannel` stays the same object, so without
    // this the memo never recomputed and the tabs visibly stopped filtering.
    listChannel,
    activeFolder,
    sidebarBase,
    channelLookup,
    getParentFolderForChannel,
    query,
    searchScope,
    prefs.sort,
    prefs.pinFavorites,
    prefs.manualOrder,
    prefs.manualOrderByScope,
    prefs.tags,
    scopeKey,
    tagFilters,
    staleDays,
  ]);



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
      const current = prefs.manualOrderByScope[scopeKey] ?? prefs.manualOrder;
      const next = moveManualOrder(current, flatIds, byTitle, loginId, toIndex);
      const firstManual = prefs.sort !== 'manual';
      // A drop that changes nothing (onto itself, or before its own successor)
      // saves nothing — least of all a toast claiming something happened.
      if (!firstManual && next.join('\n') === current.join('\n')) return;
      void vault
        .updatePrefs({
          manualOrderByScope: { ...prefs.manualOrderByScope, [scopeKey]: next },
          // The all-logins order doubles as the fallback every other scope
          // follows, so keeping it in step with a drop made there is what lets
          // a brand-new channel open in the arrangement the user knows.
          ...(scopeKey === 'all' ? { manualOrder: next } : {}),
          ...(firstManual ? { sort: 'manual' as const } : {}),
        })
        .then(() => {
          if (firstManual) notify('Custom order saved — sorting switched to Custom');
        });
    },
    [vault, notify, prefs.manualOrder, prefs.manualOrderByScope, prefs.sort, scopeKey, vault.items],
  );

  /* ---- Channel editing -------------------------------------------------- */

  /**
   * Opens the editor for a brand new channel at the root. Clearing the folder
   * first matters: "New channel in this folder…" sets it, and cancelling that
   * editor used to leave it set, so the next plain "New channel" quietly landed
   * in a folder the user had walked away from.
   */
  const startNewChannel = useCallback(() => {
    setNewChannelFolder(null);
    setEditingChannel('new');
  }, []);

  /**
   * Writes a channel. `announce` is what separates Add/Save from the live
   * autosave the editor runs while you type: the write is identical, but a
   * toast per keystroke-debounce would be noise, so only deliberate saves speak.
   */
  const writeChannel = useCallback(
    (next: Channel, announce: boolean) => {
      // Unassigned is a synthetic row, not a stored channel. Writing it used to
      // append a real copy to `channels` while the tree kept the synthetic entry
      // — the rail then drew two Unassigned rows that no reload could heal.
      if (next.id === UNASSIGNED.id) return;
      const exists = channels.some((channel) => channel.id === next.id);
      const nextChannels = exists
        ? channels.map((channel) => (channel.id === next.id ? next : channel))
        : [...channels, next];
      // A new channel appears at the end of the sidebar tree — or inside the
      // folder it was created from. The folder menu sets `newChannelFolder`;
      // creating one while a folder is open implies the same thing, which is
      // what makes "new channel" inside a folder land in that folder.
      let nextSidebar = exists ? sidebarBase : [...sidebarBase, { kind: 'channel', id: next.id } as SidebarEntry];
      const targetFolder = newChannelFolder ?? activeFolder?.id ?? null;
      if (!exists && targetFolder) {
        nextSidebar = moveChannelToFolder(nextSidebar, next.id, targetFolder);
        if (newChannelFolder) setNewChannelFolder(null);
      }
      void vault.updatePrefs({ channels: nextChannels, sidebar: nextSidebar });
      if (!exists) {
        setActiveId(next.id);
        notify(`Channel "${next.name}" added`);
      } else if (announce) {
        notify(`Channel "${next.name}" updated`);
      }
    },
    [channels, vault, notify, sidebarBase, newChannelFolder, activeFolder],
  );

  const saveChannel = useCallback((next: Channel) => writeChannel(next, true), [writeChannel]);
  const autosaveChannel = useCallback((next: Channel) => writeChannel(next, false), [writeChannel]);

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

  /** Same announce/quiet split as `writeChannel`, for the folder editor. */
  const writeFolder = useCallback(
    (next: Folder, announce: boolean) => {
      const exists = folders.some((folder) => folder.id === next.id);
      const nextFolders = exists ? folders.map((folder) => (folder.id === next.id ? next : folder)) : [...folders, next];
      const nextSidebar = exists
        ? sidebarBase
        : [...sidebarBase, { kind: 'folder', id: next.id, children: [] } as SidebarEntry];
      void vault.updatePrefs({ folders: nextFolders, sidebar: nextSidebar });
      if (announce) notify(exists ? `Folder "${next.name}" updated` : `Folder "${next.name}" added`);
    },
    [folders, sidebarBase, vault, notify],
  );

  const saveFolder = useCallback((next: Folder) => writeFolder(next, true), [writeFolder]);
  const autosaveFolder = useCallback((next: Folder) => writeFolder(next, false), [writeFolder]);

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
      {
        // The group label used to be a disabled row, which reads as a button
        // that does nothing. A submenu gives the heading somewhere to go.
        kind: 'submenu',
        label: 'Channels',
        icon: <LayersIcon />,
        heading: 'Channels, folders and separators',
        items: [
          {
            kind: 'item' as const,
            label: 'New channel…',
            icon: <PlusIcon />,
            onSelect: () => startNewChannel(),
          },
          {
            kind: 'item' as const,
            label: 'New folder…',
            icon: <PlusIcon />,
            onSelect: () => setEditingFolder('new'),
          },
          {
            kind: 'item' as const,
            label: 'New separator',
            icon: <RowsIcon />,
            onSelect: () => void vault.updatePrefs({ sidebar: addSeparatorAtEnd(sidebarBase) }),
          },
          { kind: 'separator' as const },
          {
            kind: 'item' as const,
            label: 'Manage channels…',
            icon: <RowsIcon />,
            onSelect: () => openSettings('channels'),
          },
        ],
      },
      {
        kind: 'submenu',
        label: 'Bars',
        icon: <GridIcon />,
        heading: 'Detached bars',
        items: [
          {
            kind: 'item' as const,
            label: prefs.docks.length >= MAX_DOCKS ? `New bar (at most ${MAX_DOCKS})` : 'New bar',
            icon: <PlusIcon />,
            disabled: prefs.docks.length >= MAX_DOCKS,
            // A bar is a second sidebar: the same slots, the same keys, dragged
            // anywhere on screen like a docked panel in an editor. This used to be
            // reachable only by right-clicking an existing bar, which is no use to
            // anyone who has not found one yet.
            onSelect: () => {
              const fresh: DockState = {
                id: newDockId(),
                slots: DEFAULT_DOCK_SLOTS.map((slot) => ({ ...slot })),
                pos: freeDockSpot(prefs.docks),
                enabled: true,
              };
              void vault
                .updatePrefs({ docks: [...prefs.docks, fresh] })
                .then(() => notify('New bar added — drag it anywhere by its grip'));
            },
          },
          {
            kind: 'item' as const,
            label: 'Configure bars…',
            icon: <SettingsIcon />,
            onSelect: () => openSettings('layout'),
          },
        ],
      },
      { kind: 'item', label: 'Show hidden items…', icon: <EyeOffIcon />, onSelect: () => openSettings('hidden') },
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
        // This is the "rail placement" the sidebar menu used to offer per row.
        // It is one setting for the whole run of channels, not a pin on a row.
        kind: 'submenu',
        label: 'Rail alignment',
        icon: <RowsIcon />,
        heading: 'Where the channel list sits',
        items: (
          [
            { id: 'top', label: 'Top', hint: 'Rows start at the top edge' },
            { id: 'middle', label: 'Middle', hint: 'The list floats in the middle' },
            { id: 'bottom', label: 'Bottom', hint: 'The list sits above the footer' },
          ] as const
        ).map((option) => ({
          kind: 'item' as const,
          label: option.label,
          checked: prefs.railAlign === option.id,
          onSelect: () => void vault.updatePrefs({ railAlign: option.id }),
        })),
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
        // Favorites, Needs attention and Weak or reused are tabs of All logins
        // now, so this jumps to the section instead of making a channel for it.
        // A channel of the user's own with one of those kinds still wins — see
        // sectionTarget.
        kind: 'submenu',
        label: 'Sections',
        icon: <StarIcon />,
        items: ALL_LOGIN_TABS.filter((tab) => tab.kind !== 'all').map((tab) => ({
          kind: 'item' as const,
          label: tab.label,
          icon:
            tab.kind === 'favorites' ? <StarIcon /> : tab.kind === 'attention' ? <FlagIcon /> : <ShieldIcon />,
          checked: activeChannel?.id === sectionTarget(channels, tab.kind).channelId && allTab === tab.kind,
          onSelect: () => openSection(tab.kind),
        })),
      },
    ];
  }, [
    sidebarBase,
    channels,
    saveChannel,
    vault,
    prefs,
    setEditingChannel,
    setEditingFolder,
    openSettings,
    openSection,
    activeChannel,
    allTab,
  ]);

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
  /** Moves every picked channel into one folder (or out to the root). */
  const moveSelectionTo = useCallback(
    (folderId: string | null) => {
      let next = sidebarBase;
      for (const id of selectedChannelIds) next = moveChannelToFolder(next, id, folderId);
      void vault
        .updatePrefs({ sidebar: next })
        .then(() =>
          notify(
            folderId
              ? `Moved ${selectedChannelIds.length} channels into ${folders.find((f) => f.id === folderId)?.name ?? 'a folder'}`
              : 'Moved the selection to the top level',
          ),
        );
      clearChannelSelection();
    },
    [clearChannelSelection, folders, notify, selectedChannelIds, sidebarBase, vault],
  );

  /**
   * The menu for a whole selection, opened by right-clicking any picked row.
   *
   * The same actions the bar under the rail offers, plus the move picker — two
   * ways in, one implementation each, so neither can drift from the other.
   */
  const bulkChannelMenu = useCallback((): MenuItem[] => {
    const picked = selectedChannelIds.length + selectedFolderIds.length;
    return [
      { kind: 'item', label: `${picked} rows picked`, heading: true },
      { kind: 'separator' },
      { kind: 'item', label: 'Hide', onSelect: () => runBulkChannelAction('hide') },
      { kind: 'item', label: 'Show (unhide)', onSelect: () => runBulkChannelAction('show') },
      {
        kind: 'submenu',
        label: 'Move to folder',
        heading: 'Put every picked channel in',
        disabled: selectedChannelIds.length === 0,
        items: [
          {
            kind: 'item',
            label: 'Top level',
            // Only reads as the current home when none of the picked rows is
            // inside a folder.
            checked: selectedChannelIds.every((id) => !parentFolderIdOf(id)),
            onSelect: () => moveSelectionTo(null),
          },
          ...folders.map((folder): MenuItem => ({
            kind: 'item',
            label: folder.name,
            onSelect: () => moveSelectionTo(folder.id),
          })),
        ],
      },
      { kind: 'item', label: 'Delete', danger: true, onSelect: () => runBulkChannelAction('delete') },
      { kind: 'separator' },
      { kind: 'item', label: 'Clear selection', onSelect: clearChannelSelection },
    ];
  }, [
    clearChannelSelection,
    folders,
    moveSelectionTo,
    runBulkChannelAction,
    selectedChannelIds.length,
    selectedFolderIds.length,
  ]);

  const channelMenu = useCallback(
    (channel: Channel): MenuItem[] => {
      // The Unassigned row is synthetic: it has no stored channel to edit,
      // recolour, move or pin. Offering those actions produced clicks that
      // silently did nothing (and, before the write guard, duplicated the row).
      if (channel.id === UNASSIGNED.id) {
        return [
          { kind: 'item', label: 'Unassigned', icon: <InboxIcon />, heading: true },
          { kind: 'item', label: 'Logins with no tags at all', heading: true },
          { kind: 'separator' },
          { kind: 'item', label: 'Open', icon: <InboxIcon />, onSelect: () => openChannel(channel.id) },
        ];
      }
      const label = channel.name;
      return [
        { kind: 'item', label, icon: <LayersIcon />, heading: true },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Open',
          icon: <InboxIcon />,
          onSelect: () => openChannel(channel.id),
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
          onSelect: () => startNewChannel(),
        },
        // Hiding is not deleting: every channel — the built-ins included —
        // can be taken off the rail and brought back from Settings › Hidden
        // (or the eye in Settings › Channels). Deletion stays locked below.
        {
          kind: 'item' as const,
          label: prefs.hiddenChannels.includes(channel.id) ? 'Show channel' : 'Hide channel',
          icon: <EyeOffIcon />,
          onSelect: () => {
            const hidden = prefs.hiddenChannels.includes(channel.id)
              ? prefs.hiddenChannels.filter((id) => id !== channel.id)
              : [...prefs.hiddenChannels, channel.id];
            void vault.updatePrefs({ hiddenChannels: hidden }).then(() => {
              if (hidden.includes(channel.id)) notify('Hidden - bring it back in Settings › Hidden');
            });
          },
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
    [prefs.tags, prefs.hiddenChannels, folders, saveChannel, deleteChannel, notify, moveChannel, addSeparator, openChannel, vault],
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
      { kind: 'item', label: folder.name, icon: <LayersIcon />, heading: true },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Open',
        icon: <InboxIcon />,
        onSelect: () => setActiveId(`folder:${folder.id}`),
      },
      {
        kind: 'item',
        label: 'Edit tags & notes…',
        icon: <TagIcon />,
        onSelect: () => setEditingFolder(folder.id),
      },
      {
        kind: 'item',
        label: folder.notesHidden ? 'Show notes button' : 'Hide notes button',
        icon: <EyeOffIcon />,
        disabled: !folder.notes.trim(),
        onSelect: () => {
          void vault.updatePrefs({
            folders: folders.map((entry) =>
              entry.id === folder.id ? { ...entry, notesHidden: !entry.notesHidden } : entry,
            ),
          });
          notify(folder.notesHidden ? 'Notes button shown' : 'Notes button hidden — the notes are still saved');
        },
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
    [deleteFolder, toggleFolderCollapse, prefs.hiddenFolders, saveFolder, vault, notify],
  );

  const separatorMenu = useCallback(
    (entryId: string): MenuItem[] => [
      { kind: 'item', label: 'Separator', icon: <RowsIcon />, heading: true },
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
   * "Flow" while editing another view's numbers.
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

  /* ---- Messages: linked logins only ----------------------------------------
     Once per vault: the previous build switched the Messages button on for
     every login, so a mailbox connected for one login put mail on all of them.
     This switches it off for the logins that are not linked to a connected
     mailbox — the linked one keeps its mail — and stamps the vault so it never
     runs again. A login switched back on afterwards stays on.

     Runs only while a usable mailbox is connected (with none, there is nothing
     to be linked to and nothing to decide). setShowMail stamps no dates, so
     sort order and the untouched scan above are unaffected. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    if (prefs.mailLinkedOnly) return;
    if (!prefs.gmailAccounts.some(mailboxUsable)) return;
    const ids = planMailLinkedOnly(vault.items, prefs.gmailAccounts);
    if (ids.length === 0) {
      void vault.updatePrefs({ mailLinkedOnly: true });
      return;
    }
    void vault
      .mutate(async () => {
        for (const id of ids) await vault.service.setShowMail(id, false);
      })
      .then(() => vault.updatePrefs({ mailLinkedOnly: true }))
      .then(() =>
        notify(
          `Messages now show only on the login linked to a mailbox (${ids.length} switched off). Turn one back on in its editor › Inbox.`,
        ),
      );
    // Once per unlock by depending on status alone; the persisted flag stops
    // every later run. Depending on items/prefs would re-run after the write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status]);

  /* ---- One folder for the channels, once -----------------------------------
     Files every channel except Dashboard and Mail into a single "Channels"
     folder, so the top of the rail stays the two screens that are not a
     filtered list. Runs once per vault (stamped in preferences) because a
     migration that runs every launch would silently undo a rail the user had
     since rearranged. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    if (prefs.sidebarGrouped) return;
    const grouped = groupChannelsIntoFolder(
      normaliseChannels(prefs.channels),
      prefs.folders,
      normaliseSidebar(prefs.sidebar, normaliseChannels(prefs.channels), prefs.folders),
    );
    void vault.updatePrefs({ sidebarGrouped: true, ...(grouped ?? {}) });
    // Once per unlock by design; the stamp it writes stops the next run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status]);

  /* ---- Look preset, once ---------------------------------------------------
     Instant animation, full motion and glow, high contrast, transparency and
     floating chrome are what the app ships with now. A vault stored before
     them would never see any of it, because stored preferences always win over
     defaults — so they are written in once and stamped. Only the six look
     fields are touched: text size, roundness, accent, density and the rest are
     left exactly as the user set them. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    if (prefs.lookPresetMigrated) return;
    void vault.updatePrefs({
      motion: DEFAULT_PREFERENCES.motion,
      motionSpeed: DEFAULT_PREFERENCES.motionSpeed,
      ambient: DEFAULT_PREFERENCES.ambient,
      reduceTransparency: DEFAULT_PREFERENCES.reduceTransparency,
      highContrast: DEFAULT_PREFERENCES.highContrast,
      floatingChrome: DEFAULT_PREFERENCES.floatingChrome,
      lookPresetMigrated: true,
    });
    // Once per unlock by design; the stamp it writes stops the next run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.status]);

  /* ---- Desktop spellchecker ------------------------------------------------
     Pushed to the shell whenever the preference changes, and again on unlock
     (the shell is fresh each launch, so the saved choice has to be re-applied
     rather than assumed). A browser build has no runtime seam and silently
     skips this. */
  useEffect(() => {
    getPlatform().runtime?.setSpellcheck(!prefs.disableSpellcheck);
  }, [prefs.disableSpellcheck, vault.status]);

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
   * Picking a login: the fast path is "copy the password", and nothing else.
   *
   * A single click must never open the editor. It used to, whenever the
   * "Expand on select" preference was on: one click on a card threw the whole
   * edit form up over the list you were scanning, which is not what a click on
   * a card means anywhere else in the app. Opening the editor is now the
   * double-click gesture it is everywhere else (Flow, List and Grid all
   * bind onDoubleClick to it), and this handler is left doing one job: copy the
   * password. The preference itself is retired below — see the note beside it in
   * storage, and Settings no longer offers it. The reuse warning is still a
   * modal of its own and takes precedence over the copy.
   */
  const openItem = useCallback(
    (item: VaultItem) => {
      // A vault can opt out of the fast path entirely. The card buttons and
      // menu still copy, and double-click still opens the editor; this only
      // makes a plain click on the login itself inert.
      if (!prefs.clickToCopy) return;
      const warnAboutReuse =
        prefs.warnOnReuse && item.password !== '' && duplicateIds.has(item.password) && vault.items.length > 1;
      if (!item.password) {
        notify(`${item.title || 'That login'} has no password saved`, 'error');
        return;
      }
      // Warn, then do what the click asked for. The notice is tappable and
      // leads to the Dashboard; it never blocks the copy, which is the whole
      // point of a single click on a card.
      if (warnAboutReuse) notifyReusedPasswords();
      void copy(item.password, 'Password');
      touchLogin(item.id);
    },
    [
      copy,
      notify,
      notifyReusedPasswords,
      prefs.clickToCopy,
      prefs.warnOnReuse,
      duplicateIds,
      vault.items.length,
      touchLogin,
      vault,
    ],
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
      // Empty reads and duplicate reads never touch the store: every poll
      // would otherwise rewrite prefs and re-render the app for no reason.
      if (messages.length === 0) return;
      const current = vault.prefs.mailCache ?? {};
      const next = mergeMailCache(current, accountId, messages);
      if (next === current) return;
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

  /**
   * Everything the change log needs, wired once.
   *
   * The History channel and the Dashboard's History tab show the same panel, so
   * restore/forget/clear live here rather than being spelled out at both call
   * sites — two copies of the restore path is exactly how the two screens would
   * start disagreeing about what a restore does.
   */
  const historyPanel: HistoryPanelProps = {
    events: prefs.history,
    items: vault.items,
    busy: historyBusy,
    onRestore: (event) => {
      if (!event.before) return;
      const snapshot = event.before;
      setHistoryBusy(true);
      void vault
        .mutate(
          async () => {
            if (vault.items.some((item) => item.id === snapshot.id)) {
              // An edit, or a delete followed by a re-add: put the old
              // fields back but keep the current `updatedAt` so the
              // restore reads as the most recent change, which it is.
              const { updatedAt: _when, ...patch } = snapshot;
              await vault.service.updateItem(snapshot.id, patch);
            } else {
              await vault.service.restoreItem(snapshot);
            }
          },
          // A restore is the log acting on itself: recording it
          // would append a row for every row you press Restore on.
          { log: false },
        )
        .then(() =>
          notify(
            event.action === 'deleted'
              ? `Restored “${event.title || 'login'}” exactly as it was`
              : `Put the earlier version of “${event.title || 'login'}” back`,
          ),
        )
        .catch((cause: unknown) =>
          notify(cause instanceof Error ? cause.message : 'Could not restore that version', 'error'),
        )
        .finally(() => setHistoryBusy(false));
    },
    onOpenLogin: (item) => requestEdit(item),
    onCopy: viewActions.onCopy,
    onForget: (id) =>
      void vault.updatePrefs({ history: prefs.history.filter((entry) => entry.id !== id) }),
    onClear: () =>
      void vault
        .updatePrefs({ history: [] })
        .then(() => notify('History cleared — the log is empty, nothing in the vault changed')),
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
          // Only advertise the shortcut when a single click still copies.
          shortcut: prefs.clickToCopy ? 'click' : undefined,
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
    [copy, duplicateIds, toggleFavorite, toggleAttention, openUrl, requestDelete, requestEdit, cardSizeMenu, touchLogin, prefs.clickToCopy],
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
     is reported instead of duplicated — pasting twice must not fork the login.

     Pasted logins inherit the active channel's tags. Pasting into "Work" and
     then finding the login only under All logins was the complaint: the channel
     you are looking at is the context you pasted into, so it is the context the
     new logins belong to. A folder's own tags are the ones *every* channel
     inside it narrows by (an intersection) — tagging with a tag only some
     children filter by would drop the new login out of them. */
  useEffect(() => {
    if (vault.status !== 'unlocked') return;
    const pasteTags = (() => {
      if (activeFolder) {
        const entry = sidebarBase.find((row) => row.kind === 'folder' && row.id === activeFolder.id);
        if (!entry || entry.kind !== 'folder') return [];
        const children = entry.children
          .filter((child): child is { kind: 'channel'; id: string } => child.kind === 'channel')
          .map((child) => channelLookup.find((channel) => channel.id === child.id)?.tagIds ?? [])
          .filter((tagIds) => tagIds.length > 0);
        if (children.length === 0) return [];
        return children.reduce((shared, tagIds) => shared.filter((tag) => tagIds.includes(tag)));
      }
      return activeChannel?.tagIds ?? [];
    })();
    /** Where the new logins landed, named the way the user sees it. */
    const where =
      pasteTags.length > 0
        ? `${activeFolder ? activeFolder.name : activeChannel?.name ?? 'this channel'} (${pasteTags
            .map((id) => prefs.tags.find((tag) => tag.id === id)?.name)
            .filter(Boolean)
            .join(', ')})`
        : 'Unassigned';
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
            const ids: string[] = [];
            for (const creds of fresh) {
              const added = await vault.service.addItem({
                title: creds.title?.trim() || creds.username.split('@')[0] || 'Pasted login',
                username: creds.username,
                password: creds.password,
                url: creds.url ?? '',
                notes: creds.notes ?? '',
                tags: pasteTags,
              });
              ids.push(added.id);
            }
            return ids;
          })
          .then((ids) => {
            appendToOrder(ids);
            notify(
              fresh.length === 1
                ? `Created login in ${where}`
                : `Created ${fresh.length} logins in ${where}`,
            );
          });
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
            tags: pasteTags,
          }),
        )
        .then((added) => {
          appendToOrder([added.id]);
          notify(`Created login in ${where}`);
        });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [vault, notify, activeChannel, activeFolder, sidebarBase, channelLookup, prefs.tags, appendToOrder]);

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
          onJump: () => openChannel(channel.id),
        });
      }
    }
    return resolved;
    },
    [prefs.gmailAccounts, channelLookup, folders, view, activeChannel, activeFolder, activeId, openChannel, selection, vault, viewActions, copy, mailboxFor, requestEdit],
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
                    // An empty dock renders as nothing at all, so "New dock"
                    // looked like a dead button. Start it with the shipped
                    // slot set; Settings › Layout edits it from there.
                    slots: DEFAULT_DOCK_SLOTS.map((slot) => ({ ...slot })),
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
      openChannel(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [vault.status, sidebarBase, prefs.hiddenChannels, prefs.hiddenFolders, openChannel]);

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

  /**
   * Creates a tag from wherever one is being picked — a bulk edit, a channel
   * or a folder — and returns it so the caller can select it immediately.
   *
   * Exact names only: this is an explicit "make this tag" action, so unlike
   * the automatic suggestion path it must not adopt a merely similar existing
   * tag. A name that already exists is returned as-is rather than duplicated.
   */
  const createTagNow = useCallback(
    (name: string): Tag | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const existing = prefs.tags.find(
        (tag) => tag.name.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (existing) return existing;
      const created = createTag(trimmed, prefs.tags);
      void vault.updatePrefs({ tags: [...prefs.tags, created] });
      return created;
    },
    [prefs.tags, vault],
  );

  const applySelectionEdit = useCallback(
    async (edit: BulkEdit) => {
      const target = selectedItems;
      if (target.length === 0) return;
      const changed = await vault.mutate(() =>
        applyBulkEdit(target, edit, (id, patch) => vault.service.updateItem(id, patch)),
      );
      const loginWord = target.length === 1 ? 'login' : 'logins';
      // The changed count, not the selected one: a field that already held the
      // value is not a change, and saying "12 updated" when three were identical
      // is the sort of claim that makes a user distrust the whole dialog.
      notify(
        changed === target.length
          ? `${changed} ${loginWord} updated`
          : `${changed} of ${target.length} ${loginWord} updated`,
        'ok',
      );
    },
    [notify, selectedItems, vault],
  );

  const selectionMenu = useMemo(
    () =>
      bulkMenu({
        items: selectedItems,
        icon: { share: <ShareIcon />, edit: <EditIcon />, shield: <ShieldIcon />, trash: <TrashIcon />, all: <CheckIcon /> },
        onShare: () => void shareSelection(),
        // The field travels with the menu entry now. Before this, all four
        // entries opened the Title form, so choosing Tags or Theme looked like
        // a broken dialog rather than the wrong one.
        onEditFields: (field) => setBulkField(field),
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
        <Toasts toasts={rawToasts} />
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
        <Toasts toasts={rawToasts} />
      </>
    );
  }

  const showEmpty = visible.length === 0;
  // A reuse warning masquerades as a delete dialog; treat it separately.
  const pendingDelete = confirmDelete;

  /**
   * True only for the Flow *list* view, which owns an inner scroller
   * and needs the pane's overflow frozen so the two do not fight over the wheel.
   *
   * Everything else — List, Grid, the empty state, and the purpose-built
   * screens (Dashboard, Mail, History) — is an ordinary scrolling page and must
   * keep `.content`'s scroll. Excluding only the Dashboard is what froze the
   * History channel: its log rendered into a pane with `overflow: hidden` and it
   * has no scroller of its own, so nothing below the fold could be reached.
   */
  const selfScrollingView =
    view === 'animated' &&
    !activeFolder &&
    !showEmpty &&
    !(activeChannel && CHANNEL_SCREEN_KINDS.includes(activeChannel.kind));

  const commonProps = {
    items: visible,
    duplicateIds,
    showHealthBadges: prefs.showHealthBadges,
    showUrls: prefs.showUrls,
    showNotes: prefs.showNotes,
    staleDays,
    showLetterGroups: prefs.showLetterGroups,
    // Each view reads its own slice, so tuning one view never resizes another.
    cardSize: prefs.cardSize[view],
    selectedIds: selection.ids,
    onSelectForEdit,
    // Mail scope follows the active channel: a channel that hides mail, or one
    // pinned to a single account, scopes every card it shows. Anything else —
    // All logins, folders, search — shows everything.
    gmailAccounts: prefs.gmailAccounts,
    mailCache: prefs.mailCache,
    mailInlineImages: prefs.mailInlineImages,
    mailScope: {
      show: activeChannel?.showMail !== false,
      account:
        activeChannel &&
        activeChannel.mailAccount !== 'all' &&
        prefs.gmailAccounts.some((entry) => entry.id === activeChannel.mailAccount)
          ? activeChannel.mailAccount
          : 'all',
    },
    // Drag-reorder for the Flow, List and Grid views (press and hold a login,
    // then move). The custom order applies through sorting everywhere.
    onReorderLogins: moveLogin,
    // Card buttons hidden by right-click, everywhere they render.
    hiddenButtons: prefs.hiddenButtons,
    maskEmails: prefs.maskEmails,
    ...viewActions,
  };

  // Tag chips are passed only to the views that read them (all of them).
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
        // Set while the window is minimized, hidden in the tray or behind
        // another app: CSS pauses the ambient drift, the grain and the list
        // entrances, and the polling loops above stop as well. Everything
        // resumes on the next focus, so nothing about the app is lost.
        data-quiet={appActive ? undefined : true}
        data-rail={prefs.sidebarPosition}
        data-rail-align={prefs.railAlign}
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
          onSelect={openChannel}
          onReorder={(next) => void vault.updatePrefs({ sidebar: next })}
          onToggleFolder={toggleFolderCollapse}
          selectedRows={channelSelection}
          onRowClick={clickChannelRow}
          onBulkAction={runBulkChannelAction}
          onBulkMove={(event) => {
            setMenu({ x: event.clientX, y: event.clientY, items: bulkChannelMenu() });
          }}
          onChannelMenu={(event, channel) => {
            event.preventDefault();
            // A right-click inside a live selection acts on the whole selection:
            // the menu describes what the click meant, and clicking a row that is
            // part of "these six" to act on six is what the user expects.
            const items =
              channelSelection.size > 1 && channelSelection.has(channel.id)
                ? bulkChannelMenu()
                : channelMenu(channel);
            setMenu({ x: event.clientX, y: event.clientY, items });
          }}
          onFolderMenu={(event, folder) => {
            event.preventDefault();
            const items =
              channelSelection.size > 1 && channelSelection.has(`folder:${folder.id}`)
                ? bulkChannelMenu()
                : folderMenu(folder);
            setMenu({ x: event.clientX, y: event.clientY, items });
          }}
          onSeparatorMenu={(event, entryId) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: separatorMenu(entryId) });
          }}
          onBackgroundMenu={(event) => {
            setMenu({ x: event.clientX, y: event.clientY, items: newChannelMenu() });
          }}
          onNewChannel={() => startNewChannel()}
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
              <div className="search-cluster" ref={tagPicker}>
                <div className="search">
                  <SearchIcon className="search__icon" width="15" height="15" />
                  <input
                    ref={search}
                    className="search__input"
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search logins or tags"
                    aria-label="Search logins or tags"
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
                <button
                  type="button"
                  className="search__tagbtn"
                  aria-label="Filter by tags"
                  aria-expanded={tagPickerOpen}
                  data-on={tagFilters.length > 0 || tagPickerOpen || undefined}
                  title="Filter by tags"
                  onClick={() => setTagPickerOpen((open) => !open)}
                >
                  <TagIcon width="14" height="14" />
                  {tagFilters.length > 0 ? <span className="search__tagcount">{tagFilters.length}</span> : null}
                </button>

                {tagPickerOpen ? (
                  <div className="tag-picker tag-picker--popover" role="dialog" aria-label="Filter by tags">
                    <input
                      className="input tag-picker__search"
                      value={tagPickerQuery}
                      autoFocus
                      placeholder="Find a tag or type a new one…"
                      aria-label="Find a tag or type a new one"
                      onChange={(event) => setTagPickerQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        const name = tagPickerQuery.trim();
                        if (!name) return;
                        const existing = prefs.tags.find(
                          (tag) => tag.name.trim().toLowerCase() === name.toLowerCase(),
                        );
                        const tag = existing ?? createTagNow(name);
                        if (!tag) return;
                        setTagFilters((current) =>
                          current.includes(tag.id) ? current : [...current, tag.id],
                        );
                        setTagPickerQuery('');
                      }}
                    />
                    <div className="tag-picker__list">
                      {prefs.tags.length === 0 ? (
                        <p className="field__hint">No tags yet — type a name to create one.</p>
                      ) : null}
                      {prefs.tags
                        .filter((tag) =>
                          tagPickerQuery.trim()
                            ? tag.name.toLowerCase().includes(tagPickerQuery.trim().toLowerCase())
                            : true,
                        )
                        .map((tag) => {
                          const on = tagFilters.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              className="tag-chip"
                              aria-pressed={on}
                              style={{ ['--tag-h' as string]: String(tag.hue) }}
                              onClick={() =>
                                setTagFilters((current) =>
                                  on ? current.filter((id) => id !== tag.id) : [...current, tag.id],
                                )
                              }
                            >
                              <span className="tag-chip__dot" />
                              {tag.name}
                            </button>
                          );
                        })}
                    </div>
                    <div className="tag-picker__foot">
                      <span className="field__hint" style={{ margin: 0 }}>
                        {tagFilters.length === 0
                          ? 'Pick any tag to narrow the list'
                          : `${tagFilters.length} tag${tagFilters.length === 1 ? '' : 's'} on`}
                      </span>
                      {tagFilters.length > 0 ? (
                        <button type="button" className="btn btn--quiet btn--sm" onClick={() => setTagFilters([])}>
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
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
              {/* Bulk add used to sit here. Paste-to-create and the New login
                  dialog cover the same ground without a second button in the
                  header, so the control is gone. The bulk-add dialog is still
                  reachable where it belongs: the empty state and the paste
                  offer. */}
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
          </header>            {/* Flow manages its own overflow: its inner list scrolls,
              so it needs its height pinned here so the flex chain is definite.
              List, Grid and the dashboard
              are normal scrolling pages, so they must not inherit that. Hiding
              overflow here for Grid is what froze Grid scrolling: Grid has no
              inner scroller, so there was nowhere left to scroll. */}
          <div
            className="content"
            ref={contentRef}
            style={{
              ...(selfScrollingView ? { overflow: 'hidden' } : undefined),
              // A dock floats over the page: without clearance on its edge the
              // content ends scroll underneath it. One rule per edge, since
              // bars roam freely now.
              ...(prefs.docks.some((dock) => dock.enabled && dock.pos.edge === 'bottom')
                ? { paddingBottom: 96 }
                : undefined),
              ...(prefs.docks.some((dock) => dock.enabled && dock.pos.edge === 'top')
                ? { paddingTop: 72 }
                : undefined),
              ...(prefs.docks.some((dock) => dock.enabled && dock.pos.edge === 'left')
                ? { paddingLeft: 96 }
                : undefined),
              ...(prefs.docks.some((dock) => dock.enabled && dock.pos.edge === 'right')
                ? { paddingRight: 96 }
                : undefined),
            }}
          >
            {/* The merged sections of All logins. Favorites, Needs attention and
                Weak or reused were three rows in the rail; they are four views
                of one list, so they are tabs of it instead. The strip is the
                first child of the scroll container and sticky, so a long list
                scrolls under it rather than carrying it away, and Flow — which
                pins its own height — simply gets it as the row above. */}
            {/* The scope's configured tab strip (Configurable in prefs.listTabs).
                The strip is the first child of the scroll container and sticky,
                so a long list scrolls under it rather than carrying it away,
                and Flow — which pins its own height — simply gets it as the
                row above. Right-click a tab to hide it or open the config menu. */}
            {stripTabs.length > 0 ? (
              <div className="list-tabs">
                <div
                  className="list-tabs__group"
                  role="tablist"
                  aria-label="Sections"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ x: event.clientX, y: event.clientY, items: stripMenu(null) });
                  }}
                >
                  {stripTabs.map((tab) => {
                    const active = tab.active;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-pressed={active}
                        className="list-tabs__option"
                        draggable
                        data-dragging={stripDrag?.id === tab.id || undefined}
                        data-drop={
                          stripDrag && stripDrag.id !== tab.id && stripDrag.over === tab.id
                            ? stripDrag.after ? 'after' : 'before'
                            : undefined
                        }
                        title={
                          tab.kind
                            ? `${describeChannel({ kind: tab.kind, tagIds: [] }, prefs.tags)} · drag to reorder`
                            : `Open "${tab.channel!.name}" (right-click to configure, drag to reorder)`
                        }
                        onClick={() => openStripTab(tab.id)}
                        onDragStart={(event) => {
                          event.stopPropagation();
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', tab.id);
                          setStripDrag({ id: tab.id, over: tab.id, after: false });
                        }}
                        onDragOver={(event) => {
                          if (!stripDrag || stripDrag.id === tab.id) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          const rect = event.currentTarget.getBoundingClientRect();
                          const after = event.clientX > rect.left + rect.width / 2;
                          if (stripDrag.over !== tab.id || stripDrag.after !== after) {
                            setStripDrag({ ...stripDrag, over: tab.id, after });
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (stripDrag && stripDrag.id !== tab.id) {
                            const rect = event.currentTarget.getBoundingClientRect();
                            reorderStripTab(stripDrag.id, tab.id, event.clientX > rect.left + rect.width / 2);
                          }
                          setStripDrag(null);
                        }}
                        onDragEnd={() => setStripDrag(null)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setMenu({ x: event.clientX, y: event.clientY, items: stripMenu(tab.id) });
                        }}
                      >
                        {tab.label}
                        <span className="list-tabs__count">
                          {(stripCounts[tab.id] ?? 0).toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* The folder's notes live behind one small pill, not a permanent
                panel: they are reference material, not part of the list. The
                panel sits in the flow when open, so the list moves down to
                make room instead of being covered. Right-click files the pill
                away; the folder menu and editor bring it back. */}
            {activeFolder && !folderLocked && !activeFolder.notesHidden && activeFolder.notes.trim() ? (
              <div className="folder-notes">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm folder-notes__toggle"
                  aria-expanded={notesOpen}
                  title={notesOpen ? 'Collapse notes' : 'Show folder notes (right-click to hide this button)'}
                  onClick={() => setNotesOpen((open) => !open)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setNotesOpen(false);
                    void vault.updatePrefs({
                      folders: folders.map((entry) =>
                        entry.id === activeFolder.id ? { ...entry, notesHidden: true } : entry,
                      ),
                    });
                    notify('Notes button hidden — right-click the folder to show it again');
                  }}
                >
                  <TagIcon width="14" height="14" />
                  Notes
                </button>
                {notesOpen ? (
                  <div className="folder-notes__panel">
                    <div className="folder-notes__head">
                      <span>
                        {activeFolder.name} · notes
                      </span>
                      <button
                        type="button"
                        className="btn btn--quiet btn--icon"
                        aria-label="Collapse notes"
                        onClick={() => setNotesOpen(false)}
                      >
                        <XIcon width="14" height="14" />
                      </button>
                    </div>
                    <div className="folder-notes__body">{activeFolder.notes}</div>
                  </div>
                ) : null}
              </div>
            ) : null}

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
            ) : channelLocked && activeChannel ? (
              <SecurityGate
                security={activeChannel.security}
                title={`Open "${activeChannel.name}"`}
                hint="This channel has its own second factor."
                onVerified={() =>
                  setChannelsUnlocked((current) => new Set(current).add(activeChannel.id))
                }
                onCancel={() => setActiveId('all')}
              />
            ) : activeChannel?.kind === 'mail' ? (
              <div className="content__inner content__inner--dash">
                <MailCenter
                  accounts={prefs.gmailAccounts}
                  cache={prefs.mailCache}
                  maskEmails={prefs.maskEmails}
                  onCacheMessages={viewActions.onCacheMail}
                  onOpenExternal={(url) => getPlatform().openExternal(url)}
                  onAddMailbox={() => setEditing('new')}
                  onOpenSettings={(tab) => openSettings(tab)}
                  pageSize={prefs.mailPageSize}
                  inlineImages={prefs.mailInlineImages}
                />
              </div>
            ) : activeChannel?.kind === 'history' ? (
              <HistoryPanel {...historyPanel} />
            ) : activeChannel?.kind === 'dashboard' ? (
              <div className="content__inner content__inner--dash">
                <Dashboard
                  channels={channels}
                  tags={prefs.tags}
                  items={vault.items}
                  prefs={prefs}
                  usage={prefs.usage}
                  focus={dashboardFocus}
                  onFocusHandled={() => setDashboardFocus(null)}
                  history={historyPanel}
                  onSelectChannel={openChannel}
                  onOpenLogin={(item) => requestEdit(item)}
                  // Same window the dock's mailbox slot opens, so the two are
                  // genuinely the same screen rather than two mail views.
                  onOpenMailbox={(accountId) => {
                    const account = prefs.gmailAccounts.find((entry) => entry.id === accountId);
                    if (account) setMailboxFor(account);
                  }}
                  onOpenSettings={(tab) => openSettings(tab)}
                  onAddLogin={() => setEditing('new')}
                  onNewChannel={() => startNewChannel()}
                  onBulkAdd={() => setBulkAdding(true)}
                />
              </div>
            ) : showEmpty ? (
              <div className="content__inner">
                <ViewEmptyState
                  query={query}
                  // On All logins the tab is what the empty state is about: an
                  // empty Favorites tab must say "no favorites", not "your vault
                  // is empty".
                  screen={activeChannel ? (activeChannel.id === 'all' ? allTab : activeChannel.id) : `folder:${activeFolder?.id ?? ''}`}
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

            {/* The way into a bulk edit. Right-clicking a member of a selection
                opens the same menu, but a gesture nobody is told about is not a
                feature: this appears the moment more than one login is picked
                and leads with what a selection is actually for — rotating the
                credentials of a set of accounts. Sticky to the foot of the pane
                so it never covers a dock and never scrolls out of reach. */}
            {selection.ids.size > 1 ? (
              <div className="selection-bar" role="toolbar" aria-label={`${selection.ids.size} logins selected`}>
                <span className="selection-bar__count">{selection.ids.size} selected</span>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setBulkField('password')}>
                  New password
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setBulkField('username')}>
                  Email / username
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void shareSelection()}>
                  Copy
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  title="Title, notes, tags, theme and security"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.left, y: rect.top - 6, items: selectionMenu });
                  }}
                >
                  More…
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => selection.clear()}>
                  Clear
                </button>
              </div>
            ) : null}
          </div>
        </main>
      </div>

      {bulkField && selectedItems.length > 0 ? (
        <BulkEditDialog
          items={selectedItems}
          field={bulkField}
          tags={prefs.tags}
          generatorOptions={prefs.passwordGenerator}
          onCreateTag={createTagNow}
          onApply={(edit) => void applySelectionEdit(edit)}
          onCancel={() => setBulkField(null)}
          onNotify={notify}
        />
      ) : null}

      {bulkAdding ? (
        <BulkAddDialog
          existingUsernames={new Set(vault.items.map((item) => item.username.trim().toLowerCase()).filter(Boolean))}
          onAdd={(entries) => {
            void (async () => {
              // Tags are resolved up front, against one running catalogue: every
              // login in the paste is filed by what it is for (its email provider,
              // its site) plus the open channel's tags, and a tag created for the
              // first entry is reused by the rest rather than duplicated.
              let catalogue = prefs.tags;
              const planned = entries.map((entry) => {
                // The shared rule, with the running catalogue so a tag created
                // for the first entry is reused by the rest rather than
                // duplicated — including in All logins, where there is no channel
                // tag to inherit and the site and provider do the filing.
                const { tagIds, catalogue: next } = tagsForNewLogin(entry, catalogue);
                catalogue = next;
                return { entry, tagIds };
              });
              const addedTags = catalogue !== prefs.tags;
              if (addedTags) await vault.updatePrefs({ tags: catalogue });
              const created = await vault.mutate(async () => {
                const saved = new Set(vault.items.map((item) => item.username.trim().toLowerCase()).filter(Boolean));
                const ids: string[] = [];
                for (const { entry, tagIds } of planned) {
                  // Re-checked at write time, so an address saved while the
                  // dialog was open still cannot duplicate.
                  if (saved.has(entry.username.toLowerCase())) continue;
                  saved.add(entry.username.toLowerCase());
                  const added = await vault.service.addItem({
                    title: entry.username.split('@')[0] || entry.username,
                    username: entry.username,
                    password: entry.password,
                    tags: tagIds,
                  });
                  ids.push(added.id);
                }
                return ids;
              });
              // New logins go to the bottom of the workspace they were added
              // to, so a bulk paste reads in the order it was pasted.
              appendToOrder(created);
              notify(
                (created.length === 1 ? 'Added 1 login' : `Added ${created.length} logins`) +
                  (planned.some((row) => row.tagIds.length > 0) ? ' — tagged by what they are for' : ''),
              );
            })();
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
        onCreateTag={createTagNow}
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
          tags={prefs.tags}
          onCreateTag={createTagNow}
          onSave={saveFolder}
          onAutosave={autosaveFolder}
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
                  // Same rule as the auto-save path — literally the same helper,
                  // so a login saved from this prompt cannot be filed differently
                  // from one the watcher saved without asking.
                  const { tagIds, catalogue } = tagsForNewLogin(clipPending);
                  void (async () => {
                    if (catalogue !== prefs.tags) await vault.updatePrefs({ tags: catalogue });
                    const created = await vault.mutate(() =>
                      vault.service.addItem({
                        title: clipPending.title?.trim() || clipPending.username.split('@')[0] || 'Clipboard login',
                        username: clipPending.username,
                        password: clipPending.password,
                        url: clipPending.url ?? '',
                        notes: clipPending.notes ?? '',
                        tags: tagIds,
                      }),
                    );
                    appendToOrder([created.id]);
                    notify('Saved from the clipboard');
                  })();
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
          <p className="capture__note">
            {focusedTagIds.length > 0
              ? 'Saves with this channel’s tags, so it lands where you are.'
              : prefs.autoTagDomain
                ? 'Saves tagged by its site and address, so it does not wait in Unassigned.'
                : 'Saves untagged, so it waits in Unassigned until you file it.'}
          </p>
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
            maskEmails={prefs.maskEmails}
            onCacheMessages={viewActions.onCacheMail}
            onOpenExternal={(url) => getPlatform().openExternal(url)}
            onClose={() => setMailboxFor(null)}
            pageSize={prefs.mailPageSize}
            inlineImages={prefs.mailInlineImages}
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
              // A login whose own address is a connected mailbox reads exactly
              // that one - the same narrowing the card expander applies, so the
              // window and the expander can never disagree.
              accountScope={mailboxOwnedBy(liveItem.username, prefs.gmailAccounts)?.id ?? 'all'}
              cache={prefs.mailCache}
              maskEmails={prefs.maskEmails}
              onCacheMessages={viewActions.onCacheMail}
              onOpenExternal={(url) => getPlatform().openExternal(url)}
              defaultOpen
              inlineImages={prefs.mailInlineImages}
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
          seed={channelSeed}
          onCreateTag={createTagNow}
          accounts={prefs.gmailAccounts}
          itemCount={
            // A new channel in a folder starts as the folder's scope, so the
            // preview counts that rather than the whole vault.
            editingChannel === 'new'
              ? pendingChannelFolder
                ? applyChannel(
                    createChannel('', channelSeed ?? {}),
                    vault.items,
                    staleDays,
                    pendingChannelFolder,
                  ).length
                : vault.items.length
              : applyChannel(
                  channels.find((entry) => entry.id === editingChannel) ?? channels[0]!,
                  vault.items,
                  staleDays,
                  getParentFolderForChannel(editingChannel),
                ).length
          }
          onSave={saveChannel}
          onAutosave={autosaveChannel}
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
              // Tags for a login created here, by the same rule as every other
              // arrival: the open channel or folder is the context it belongs to,
              // and outside a folder the site and email provider file it too — so
              // a login made in All logins lands tagged instead of in Unassigned.
              const { tagIds, catalogue } = tagsForNewLogin(draft);
              if (catalogue !== prefs.tags) await vault.updatePrefs({ tags: catalogue });
              draft = { ...draft, tags: [...new Set([...(draft.tags ?? []), ...tagIds])] };
              const created = await vault.mutate(() => vault.service.addItem(draft));
              appendToOrder([created.id]);
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
                {!prefs.autoTagDomain
                  ? 'Auto-tagging is off'
                  : capture.pending.insight.suggestedTags.length > 0
                    ? 'Tags'
                    : 'No matching tag'}
              </span>
              {prefs.autoTagDomain
                ? capture.pending.insight.suggestedTags.map((tag) => (
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
                  ))
                : null}
            </div>

            <p className="capture__note">
              Nothing is stored until you choose Save. Dismissing remembers the site and stops asking.
            </p>
          </div>
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

      <Toasts toasts={rawToasts} />
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
