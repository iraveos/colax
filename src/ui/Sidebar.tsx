/**
 * Sidebar: channels, folders, separators, drag-to-reorder, compact mode.
 *
 * The tree comes from `prefs.sidebar`: channels sit at the root or inside a
 * folder, separators are their own rows, and a folder expands to show its
 * channels. Dashboard keeps its pinned slot at the top.
 */

import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Channel, Folder, SidebarEntry } from '../vault/channels.ts';
import { moveSidebarEntry } from '../vault/channels.ts';
import type { SidebarLabels } from '../vault/storage.ts';
import {
  CloudIcon,
  EyeOffIcon,
  FlagIcon,
  FolderIcon,
  GridIcon,
  InboxIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  ShieldIcon,
  StarIcon,
  PlusIcon,
} from './icons.tsx';

/**
 * Channel icon glyphs by key. Exported for the dock, which renders channel
 * slots with the same glyphs so the two never disagree about what a channel
 * looks like.
 */
export const CHANNEL_ICONS_MAP: Record<string, typeof InboxIcon> = {
  inbox: InboxIcon,
  star: StarIcon,
  flag: FlagIcon,
  shield: ShieldIcon,
  layers: LayersIcon,
  key: KeyIcon,
  lock: LockIcon,
  cloud: CloudIcon,
  grid: GridIcon,
  folder: FolderIcon,
};

export function Sidebar({
  entries,
  channels,
  folders,
  activeId,
  counts,
  compact,
  labels = 'both',
  showShortcuts,
  showLock,
  floating,
  hiddenChannels = [],
  hiddenFolders = [],
  showNewChannelButton = true,
  showCompactButton = true,
  showSettingsButton = true,
  showHideSidebarButton = true,
  onHideChrome,
  onSelect,
  onReorder,
  onToggleFolder,
  onChannelMenu,
  onFolderMenu,
  onSeparatorMenu,
  onBackgroundMenu,
  onNewChannel,
  onToggleCompact,
  onHideSidebar,
  onOpenSettings,
  onOpenShortcuts,
  onLock,
}: {
  entries: SidebarEntry[];
  /** Lookup by id, including pseudo-channels such as Unassigned. */
  channels: Channel[];
  folders: Folder[];
  activeId: string;
  /** Keyed by channel id, and by `folder:<id>` for folder headers. */
  counts: Record<string, number>;
  compact: boolean;
  /**
   * How much of each row to show. Icon-only collapses to a narrow rail, so it
   * implies compact; name-only drops the glyphs but keeps the hue dot, because
   * that dot is the only thing distinguishing two channels at a glance.
   */
  labels?: SidebarLabels;
  showShortcuts: boolean;
  showLock: boolean;
  floating: boolean;
  /** Channel ids hidden from the rail. They stay editable in Settings. */
  hiddenChannels?: string[];
  /** Folder ids hidden from the rail, subtree included. Settings brings them back. */
  hiddenFolders?: string[];
  /** Shows the "New channel" shortcut at the end of the rail. */
  showNewChannelButton?: boolean;
  /** Shows the Compact toggle in the footer. */
  showCompactButton?: boolean;
  /** Shows the Settings button in the footer. Right-click hides it. */
  showSettingsButton?: boolean;
  /** Shows the Hide-sidebar button in the footer. Right-click hides it. */
  showHideSidebarButton?: boolean;
  /** Right-click on a hideable button: App opens its Hide menu. */
  onHideChrome?: (id: 'sidebar-add' | 'footer-settings' | 'footer-lock' | 'footer-shortcuts' | 'footer-compact' | 'footer-hide', event: ReactMouseEvent) => void;
  onSelect: (id: string) => void;
  onReorder: (next: SidebarEntry[]) => void;
  onToggleFolder: (folderId: string) => void;
  onChannelMenu: (event: ReactMouseEvent, channel: Channel) => void;
  onFolderMenu: (event: ReactMouseEvent, folder: Folder) => void;
  onSeparatorMenu: (event: ReactMouseEvent, entryId: string) => void;
  onBackgroundMenu: (event: ReactMouseEvent) => void;
  onNewChannel: () => void;
  onToggleCompact: () => void;
  /** Hides the whole rail. A topbar button brings it back. */
  onHideSidebar: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onLock: () => void;
}) {
/**
   * The drag source: which entry, and which list it came from.
   *
   * Keyed by entry id rather than by list plus index. The index goes stale the
   * moment anything is removed, and every handler that then had to reason about
   * "which slot is this now" was a chance to move the wrong entry.
   */
  const drag = useRef<{ id: string; from: string } | null>(null);
  const [overZone, setOverZone] = useState<{ list: string; index: number } | null>(null);

  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const hidden = new Set(hiddenChannels);
  const hiddenFolderIds = new Set(hiddenFolders);
  // Every channel hidden (or none present at all): the rail would render just
  // the footer, so say where the channels went instead of looking broken.
  const railEmpty = entries.every((entry) => {
    if (entry.kind === 'separator') return true;
    if (entry.kind === 'channel') return hidden.has(entry.id);
    if (hiddenFolderIds.has(entry.id)) return true;
    return !entry.children.some((child) => child.kind !== 'channel' || !hidden.has(child.id));
  });

  // Icon-only is a rail you read by shape, so it behaves like compact mode even
  // when the separate compact preference says otherwise. Otherwise the user
  // picks "icons only" and still gets a wide empty rail full of padding.
  const iconOnly = labels === 'icon';
  const showLabel = labels !== 'icon' && !compact;
  // Footer buttons and the New-channel row carry text labels of their own, so
  // they check the rail width rather than just the compact preference: with
  // icons-only labels the rail is equally narrow and the words overflow it.
  const narrowRail = compact || iconOnly;
  // Compact is an icon rail, so it keeps its icons. It used to hide them
  // (`&& !compact` on this line) on the reasoning that a narrow rail should be
  // as sparse as possible. The result was a rail with nothing in it at all: the
  // label was gone, the icon was gone, and CSS hid the hue dot too, leaving a
  // column of identical empty pills. The channel's colour is the one thing that
  // still identifies it at that width, so the dot comes back below as well.
  const showIcon = labels !== 'name';

  /** Entry ids in the order they render, per list. Used to read a drop target. */
  const listAt = useCallback(
    (list: string): SidebarEntry[] => {
      if (list === 'root') return entries;
      const folder = entries.find((entry) => entry.kind === 'folder' && entry.id === list);
      return folder && folder.kind === 'folder' ? folder.children : [];
    },
    [entries],
  );

  /**
   * Moves the dragged entry to a list and slot.
   *
   * All the tree surgery lives in `moveSidebarEntry`; this only reads the drop
   * target and hands it over, so dragging and the context menus cannot drift
   * apart the way two hand-rolled copies of the same splice did.
   */
  const dropAt = useCallback(
    (targetList: string, targetIndex: number) => {
      const source = drag.current;
      drag.current = null;
      setOverZone(null);
      if (!source) return;
      if (source.from === targetList && source.id === listAt(targetList)[targetIndex]?.id) return;
      onReorder(moveSidebarEntry(entries, source.id, targetList, targetIndex));
    },
    [entries, listAt, onReorder],
  );

  /** Drops onto a folder's children area, appending into it. */
  const dropIntoFolder = useCallback(
    (folderId: string) => {
      const source = drag.current;
      drag.current = null;
      setOverZone(null);
      if (!source || source.from === folderId) return;
      onReorder(moveSidebarEntry(entries, source.id, folderId, listAt(folderId).length));
    },
    [entries, listAt, onReorder],
  );

  const rowProps = (list: string, index: number, entryId: string) => ({
    draggable: true,
    onDragStart: () => {
      drag.current = { id: entryId, from: list };
    },
    onDragOver: (event: React.DragEvent) => {
      if (!drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      setOverZone({ list, index });
    },
    onDragLeave: () => setOverZone((current) => (current?.list === list && current.index === index ? null : current)),
    onDrop: (event: React.DragEvent) => {
      if (!drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      dropAt(list, index);
    },
    onDragEnd: () => {
      drag.current = null;
      setOverZone(null);
    },
    'data-dragging': drag.current?.id === entryId ? '' : undefined,
    'data-over': overZone?.list === list && overZone.index === index ? '' : undefined,
  });

  const channelRow = (channel: Channel, list: string, index: number) => {
    const Icon = CHANNEL_ICONS_MAP[channel.icon] ?? LayersIcon;
    const count = counts[channel.id] ?? 0;
    return (
      <div
        key={channel.id}
        className="sidebar__row"
        {...rowProps(list, index, channel.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onChannelMenu(event, channel);
        }}
      >
        <button
          className="nav-item"
          style={{ ['--channel-h' as string]: String(channel.hue) }}
          aria-current={activeId === channel.id}
          onClick={() => onSelect(channel.id)}
          title={narrowRail ? channel.name : `${channel.name} — right-click to edit`}
        >
          <span className="nav-item__dot" aria-hidden="true" />
          {showIcon ? (
            <span className="nav-item__icon" aria-hidden="true">
              <Icon />
            </span>
          ) : null}
          {showLabel ? <span className="nav-item__label">{channel.name}</span> : null}
          {!compact && !iconOnly && count > 0 ? <span className="nav-item__count">{count}</span> : null}
        </button>
      </div>
    );
  };

  const separatorRow = (id: string, list: string, index: number) => (
    <div
      key={id}
      className="sidebar__rule sidebar__rule--row"
      role="separator"
      aria-label="Separator — drag to move, right-click for options"
      title="Separator — drag to move, right-click for options"
      {...rowProps(list, index, id)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSeparatorMenu(event, id);
      }}
    />
  );

  const folderRow = (folder: Folder, list: string, index: number) => {
    const Icon = CHANNEL_ICONS_MAP[folder.icon] ?? FolderIcon;
    const expanded = !folder.collapsed;
    const active = activeId === `folder:${folder.id}`;
    const entry = entries.find((row) => row.kind === 'folder' && row.id === folder.id);
    const childCount = entry && entry.kind === 'folder'
      ? entry.children.reduce((total, child) => (child.kind === 'channel' ? total + (counts[child.id] ?? 0) : total), 0)
      : 0;

    return (
      <div key={folder.id} className="sidebar__folder">
        <div
          className="sidebar__row"
          {...rowProps(list, index, folder.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onFolderMenu(event, folder);
          }}
        >
          <div
            className="nav-item nav-item--folder"
            aria-current={active}
            style={{ ['--channel-h' as string]: String(folder.hue) }}
            onClick={() => onSelect(`folder:${folder.id}`)}
            title={narrowRail ? folder.name : `${folder.name} — right-click to edit`}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(`folder:${folder.id}`);
              }
            }}
          >
            <button
              className="nav-item__chevron"
              aria-label={expanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFolder(folder.id);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d={expanded ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
              </svg>
            </button>
            <span className="nav-item__icon" aria-hidden="true">
              <Icon />
            </span>
            {showLabel ? <span className="nav-item__label">{folder.name}</span> : null}
            {!compact && !iconOnly ? <span className="nav-item__count">{childCount}</span> : null}
          </div>
        </div>

        <div
          className="sidebar__folder-children"
          data-collapsed={!expanded || undefined}
          data-folder-drop={folder.id}
          role="group"
          aria-label={folder.name}
          onDragOver={(event: React.DragEvent) => {
            // The children area is the drop target that puts an entry INSIDE the
            // folder. It stays mounted while collapsed and while the folder is
            // empty, which is what makes an empty or collapsed folder reachable
            // by dragging. The header is deliberately left as a plain reorder
            // target: hijacking it swallowed every drop near a folder and stopped
            // anything being reordered past one.
            const source = drag.current;
            if (!source || source.from === folder.id) return;
            // A folder cannot live inside another folder, so offering the drop
            // would be a lie.
            if (source.id === folder.id) return;
            event.preventDefault();
            event.stopPropagation();
            setOverZone({ list: folder.id, index: -1 });
          }}
          onDrop={(event: React.DragEvent) => {
            if (!drag.current) return;
            event.preventDefault();
            event.stopPropagation();
            dropIntoFolder(folder.id);
          }}
        >
          {expanded
            ? (entry && entry.kind === 'folder' ? entry.children : []).map((child, childIndex) => {
                // Hidden channels render nothing but keep their slot: the
                // drop handlers below work on real indexes, so filtering here
                // must not renumber the siblings.
                if (child.kind === 'channel' && hidden.has(child.id)) return null;
                if (child.kind === 'separator') return separatorRow(child.id, folder.id, childIndex);
                const channel = channelById.get(child.id);
                return channel ? channelRow(channel, folder.id, childIndex) : null;
              })
            : null}
        </div>
      </div>
    );
  };

  return (
    <aside
      className="sidebar"
      data-compact={compact || iconOnly || undefined}
      data-labels={labels}
      data-floating={floating || undefined}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('.sidebar__row')) return;
        event.preventDefault();
        onBackgroundMenu(event);
      }}
    >
      <nav className="sidebar__nav" aria-label="Channels">
        {entries.map((entry, index) => {
          if (entry.kind === 'separator') return separatorRow(entry.id, 'root', index);
          if (entry.kind === 'channel' && hidden.has(entry.id)) return null;
          if (entry.kind === 'folder') {
            // A hidden folder hides with its whole subtree. Unhiding happens
            // in Settings › Hidden, which lists every hidden thing at once.
            if (hiddenFolderIds.has(entry.id)) return null;
            const folder = folderById.get(entry.id);
            if (!folder) return null;
            // A folder left with nothing visible hides with its children.
            // Un-hiding happens in Settings, which lists every channel.
            const visible = entry.children.some((child) => child.kind !== 'channel' || !hidden.has(child.id));
            if (!visible) return null;
            return folderRow(folder, 'root', index);
          }
          const channel = channelById.get(entry.id);
          return channel ? channelRow(channel, 'root', index) : null;
        })}

        {railEmpty ? (
          <p className="sidebar__empty" role="note">
            Rail is empty — unhide channels in Settings › Channels.
          </p>
        ) : null}

        {showNewChannelButton ? (
          <button
            className="nav-item nav-item--ghost sidebar__add"
            onClick={onNewChannel}
            title="New channel — right-click to hide"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHideChrome?.('sidebar-add', event);
            }}
          >
            <PlusIcon width="15" height="15" />
            {!narrowRail ? <span className="nav-item__label">New channel</span> : null}
          </button>
        ) : null}
      </nav>

      <div className="sidebar__spacer" />

      <div className="sidebar__footer">
        {/* The compact toggle lives here now, not on an edge tab. The tab sat
            half outside the rail overlapping content, was undiscoverable (a
            22px strip with no label), and had nothing to do with the rail edge
            once the rail could dock to any side. As a footer item it sits with
            the other app-level controls, keeps its label, and stays reachable
            in compact mode as an icon. */}
        {showCompactButton ? (
          <button
            className="nav-item"
            onClick={onToggleCompact}
            title={compact ? 'Expand sidebar — right-click to hide' : 'Compact sidebar — right-click to hide'}
            aria-label={compact ? 'Expand sidebar' : 'Compact sidebar'}
            aria-pressed={compact}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHideChrome?.('footer-compact', event);
            }}
          >
            <CompactGlyph expanded={compact} />
            {!narrowRail ? <span>Compact</span> : null}
          </button>
        ) : null}
        {showHideSidebarButton ? (
          <button
            className="nav-item"
            onClick={onHideSidebar}
            title="Hide sidebar — right-click to hide this button"
            aria-label="Hide sidebar"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHideChrome?.('footer-hide', event);
            }}
          >
            <EyeOffIcon width="16" height="16" />
            {!narrowRail ? <span>Hide</span> : null}
          </button>
        ) : null}
        {showSettingsButton ? (
          <button
            className="nav-item"
            onClick={onOpenSettings}
            title="Settings — right-click to hide"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHideChrome?.('footer-settings', event);
            }}
          >
            <SettingsGlyph />
            {!narrowRail ? <span>Settings</span> : null}
          </button>
        ) : null}
        {showShortcuts ? (
          <button
            className="nav-item"
            onClick={onOpenShortcuts}
            title="Keyboard shortcuts — right-click to hide"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHideChrome?.('footer-shortcuts', event);
            }}
          >
            <KeyboardGlyph />
            {!narrowRail ? <span>Shortcuts</span> : null}
          </button>
        ) : null}
        {showLock ? (
          <button
            className="nav-item"
            onClick={onLock}
            title="Lock vault — right-click to hide"
            aria-label="Lock vault"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHideChrome?.('footer-lock', event);
            }}
          >
            <LockGlyph />
            {!narrowRail ? <span>Lock</span> : null}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function SettingsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.5 1.5l.1.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  );
}

function KeyboardGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function CompactGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={expanded ? 'M9 8v8M15 8l-3 4 3 4' : 'M9 8v8'} />
    </svg>
  );
}
