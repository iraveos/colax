/**
 * The dock's slot manager: reorder, add, remove, rekey and re-icon every slot.
 *
 * Rows drag to reorder with a grip handle. Reordering is by index swap on drop
 * rather than live insertion-mark sorting: with at most eight rows, press-drag
 * precision matters less than the operation being obvious and undoable by
 * dragging back.
 *
 * Deleting a channel does not delete its slot from prefs (normalization cannot
 * see the channel list), so a slot whose channel is gone renders here as
 * "missing" with only a Remove button — visible and fixable, instead of a
 * silent gap in the bar.
 */

import { useRef, useState } from 'react';
import { VIEW_OPTIONS } from './ViewMenu.tsx';
import { CHANNEL_ICONS_MAP } from './Sidebar.tsx';
import { KeyRecorder } from './Dock.tsx';
import { KeyIcon, LayersIcon, MailIcon } from './icons.tsx';
import { readImageFile } from './card-art.ts';
import { isAllowedImageSrc, MAX_AVATAR_BYTES, type VaultItem } from '../vault/types.ts';
import type { Channel, Folder } from '../vault/channels.ts';
import { DOCK_LOGIN_ACTIONS, MAX_DOCK_SLOTS, type DockLoginAction, type DockSlotConfig, type GmailAccount, type VaultView } from '../vault/storage.ts';

const LOGIN_ACTION_LABELS: Record<DockLoginAction, string> = {
  password: 'Copy password',
  email: 'Copy email',
  both: 'Copy email + password',
  edit: 'Edit login',
  messages: 'Show messages',
};

function defaultLabel(
  slot: DockSlotConfig,
  channels: Channel[],
  folders: Folder[],
  logins: VaultItem[],
  mailboxes: GmailAccount[],
): string {
  if (slot.kind === 'view') return VIEW_OPTIONS.find((option) => option.id === slot.ref)?.label ?? slot.ref;
  if (slot.kind === 'inbox') return 'Inbox';
  if (slot.kind === 'mailbox') return mailboxes.find((account) => account.id === slot.ref)?.address ?? '(missing mailbox)';
  if (slot.kind === 'folder') return folders.find((folder) => folder.id === slot.ref)?.name ?? '(missing folder)';
  if (slot.kind === 'login') {
    const item = logins.find((entry) => entry.id === slot.ref);
    return item ? item.title || item.username || 'Login' : '(missing login)';
  }
  return channels.find((channel) => channel.id === slot.ref)?.name ?? '(missing channel)';
}

function missingLabel(slot: DockSlotConfig): string {
  if (slot.kind === 'login') return 'Login deleted';
  if (slot.kind === 'mailbox') return 'Mailbox disconnected';
  if (slot.kind === 'folder') return 'Folder deleted';
  return 'Channel deleted';
}

function SlotGlyph({ slot, channels, folders }: { slot: DockSlotConfig; channels: Channel[]; folders: Folder[] }) {
  if (slot.icon) {
    return <img className="dock-slot__image" src={slot.icon} alt="" aria-hidden="true" draggable={false} />;
  }
  if (slot.kind === 'view') {
    const Icon = VIEW_OPTIONS.find((option) => option.id === slot.ref)?.Icon ?? LayersIcon;
    return <Icon width="16" height="16" />;
  }
  if (slot.kind === 'inbox' || slot.kind === 'mailbox') return <MailIcon width="16" height="16" />;
  if (slot.kind === 'folder') {
    const folder = folders.find((entry) => entry.id === slot.ref);
    const Icon = (folder && CHANNEL_ICONS_MAP[folder.icon]) ?? LayersIcon;
    return <Icon width="16" height="16" />;
  }
  if (slot.kind === 'login') return <KeyIcon width="16" height="16" />;
  const channel = channels.find((entry) => entry.id === slot.ref);
  const Icon = (channel && CHANNEL_ICONS_MAP[channel.icon]) ?? LayersIcon;
  return <Icon width="16" height="16" />;
}

export function DockSlotsEditor({
  slots,
  channels,
  folders,
  logins,
  mailboxes,
  onChange,
  onNotify,
}: {
  slots: DockSlotConfig[];
  channels: Channel[];
  folders: Folder[];
  logins: VaultItem[];
  mailboxes: GmailAccount[];
  onChange: (next: DockSlotConfig[]) => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [iconFor, setIconFor] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return;
    const next = [...slots];
    const [slot] = next.splice(from, 1);
    next.splice(to, 0, slot!);
    onChange(next);
  };

  const setKey = (index: number, key: string) => {
    const next = [...slots];
    next[index] = { ...next[index]!, key };
    onChange(next);
  };

  const setLabel = (index: number, label: string) => {
    const next = [...slots];
    const trimmed = label.trim().slice(0, 24);
    const { label: _dropped, ...rest } = next[index]!;
    next[index] = trimmed ? { ...rest, label: trimmed } : rest;
    onChange(next);
  };

  const setIcon = (index: number, icon: string | undefined) => {
    const next = [...slots];
    const { icon: _dropped, ...rest } = next[index]!;
    next[index] = icon ? { ...rest, icon } : rest;
    onChange(next);
  };

  const setAction = (index: number, action: DockLoginAction) => {
    const next = [...slots];
    next[index] = { ...next[index]!, action };
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(slots.filter((_, i) => i !== index));
    if (iconFor === index) setIconFor(null);
  };

  const add = (slot: DockSlotConfig) => {
    if (slots.length >= MAX_DOCK_SLOTS) {
      onNotify(`The dock holds at most ${MAX_DOCK_SLOTS} slots.`, 'error');
      return;
    }
    onChange([...slots, slot]);
    setAdding(false);
  };

  // Anything not already on the bar, in a stable order: views first, then the
  // inbox, then folders and channels alphabetically. Logins go through the
  // filter below instead — listing a whole vault here would bury everything.
  const present = new Set(slots.map((slot) => `${slot.kind}:${slot.ref || slot.kind}`));
  const addableViews = (['animated', 'carousel', 'basic', 'grid'] as VaultView[]).filter(
    (view) => !present.has(`view:${view}`),
  );
  const addableInbox = present.has('inbox:') ? [] : ['inbox'];
  const addableMailboxes = mailboxes
    .filter((account) => account.address && !present.has(`mailbox:${account.id}`))
    .sort((a, b) => a.address.localeCompare(b.address));
  const addableFolders = folders
    .filter((folder) => !present.has(`folder:${folder.id}`))
    .sort((a, b) => a.name.localeCompare(b.name));
  const addableChannels = channels
    .filter((channel) => !present.has(`channel:${channel.id}`))
    .sort((a, b) => a.name.localeCompare(b.name));
  const [loginFilter, setLoginFilter] = useState('');
  const addableLogins = logins
    .filter((item) => {
      if (present.has(`login:${item.id}`)) return false;
      const needle = loginFilter.trim().toLowerCase();
      if (!needle) return false;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.username.toLowerCase().includes(needle) ||
        (item.url || '').toLowerCase().includes(needle)
      );
    })
    .slice(0, 20);

  async function onPickFile(index: number, file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await readImageFile(file, MAX_AVATAR_BYTES);
      setIcon(index, dataUrl);
    } catch {
      onNotify('Could not read that image.', 'error');
    }
  }

  function onPickUrl(index: number, url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      setIcon(index, undefined);
      return;
    }
    // Same allowlist the login editor enforces: uploaded images and https.
    // Anything else is rejected rather than stored, so a pasted javascript:
    // URL can never become an <img src>.
    if (!isAllowedImageSrc(trimmed)) {
      onNotify('Use an uploaded image or an https:// link.', 'error');
      return;
    }
    setIcon(index, trimmed);
  }

  return (
    <div className="dock-slots">
      {slots.length === 0 ? (
        <p className="field__hint">Empty — the bar is hidden until a slot is added below.</p>
      ) : null}
      <ul className="dock-slots__list">
        {slots.map((slot, index) => {
          const missing =
            (slot.kind === 'channel' && !channels.some((channel) => channel.id === slot.ref)) ||
            (slot.kind === 'folder' && !folders.some((folder) => folder.id === slot.ref)) ||
            (slot.kind === 'login' && !logins.some((item) => item.id === slot.ref)) ||
            (slot.kind === 'mailbox' && !mailboxes.some((account) => account.id === slot.ref));
          const display = slot.label || defaultLabel(slot, channels, folders, logins, mailboxes);
          const taken = slots.filter((_, i) => i !== index).map((entry) => entry.key);
          return (
            <li
              key={`${slot.kind}:${slot.ref || slot.kind}:${index}`}
              className="dock-slots__row"
              data-missing={missing || undefined}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDragIndex(index);
              }}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(event) => {
                // Must cancel the default or drop never fires.
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
            >
              <span className="dock-slots__grip" title="Drag to reorder" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="dock-slots__preview" aria-hidden="true">
                <SlotGlyph slot={slot} channels={channels} folders={folders} />
              </span>
              {missing ? (
                <span className="dock-slots__missing">
                  {missingLabel(slot)}
                  <button type="button" className="btn btn--quiet btn--sm" onClick={() => remove(index)}>
                    Remove
                  </button>
                </span>
              ) : (
                <>
                  <input
                    className="input dock-slots__name"
                    value={slot.label ?? ''}
                    placeholder={defaultLabel(slot, channels, folders, logins, mailboxes)}
                    maxLength={24}
                    aria-label={`Label for ${display}`}
                    onChange={(event) => setLabel(index, event.target.value)}
                  />
                  {slot.kind === 'login' ? (
                    <select
                      className="select__trigger dock-slots__action"
                      value={slot.action ?? 'both'}
                      aria-label={`Action for ${display}`}
                      title="What pressing this slot does"
                      onChange={(event) => setAction(index, event.target.value as DockLoginAction)}
                    >
                      {DOCK_LOGIN_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {LOGIN_ACTION_LABELS[action]}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <KeyRecorder
                    value={slot.key}
                    taken={taken}
                    onRecord={(key) => setKey(index, key)}
                    onError={(message) => onNotify(message, 'error')}
                  />
                  <button
                    type="button"
                    className="btn btn--icon btn--sm"
                    aria-label={`Change icon for ${display}`}
                    aria-pressed={iconFor === index}
                    onClick={() => setIconFor(iconFor === index ? null : index)}
                  >
                    <LayersIcon width="14" height="14" />
                  </button>
                  <button
                    type="button"
                    className="btn btn--icon btn--sm"
                    aria-label={`Remove ${display} from the dock`}
                    onClick={() => remove(index)}
                  >
                    ×
                  </button>
                </>
              )}
              {iconFor === index && !missing ? (
                <DockIconEditor
                  current={slot.icon}
                  onPickFile={(file) => void onPickFile(index, file)}
                  onPickUrl={(url) => onPickUrl(index, url)}
                  onClear={() => {
                    setIcon(index, undefined);
                    setIconFor(null);
                  }}
                  onDone={() => setIconFor(null)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="dock-slots__add">
          {addableViews.map((view) => {
            const option = VIEW_OPTIONS.find((entry) => entry.id === view)!;
            return (
              <button
                key={view}
                type="button"
                className="segmented__option"
                onClick={() => add({ kind: 'view', ref: view, key: String(slots.length + 1) })}
              >
                {option.label}
              </button>
            );
          })}
          {addableInbox.map(() => (
            <button
              key="inbox"
              type="button"
              className="segmented__option"
              onClick={() => add({ kind: 'inbox', ref: '', key: String(slots.length + 1) })}
            >
              Inbox
            </button>
          ))}
          {addableMailboxes.map((account) => (
            <button
              key={account.id}
              type="button"
              className="segmented__option"
              onClick={() => add({ kind: 'mailbox', ref: account.id, key: String(slots.length + 1) })}
              title={`Open ${account.address} in a window`}
            >
              {account.address} (mailbox)
            </button>
          ))}
          {addableFolders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="segmented__option"
              onClick={() => add({ kind: 'folder', ref: folder.id, key: String(slots.length + 1) })}
            >
              {folder.name} (folder)
            </button>
          ))}
          {addableChannels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              className="segmented__option"
              onClick={() => add({ kind: 'channel', ref: channel.id, key: String(slots.length + 1) })}
            >
              {channel.name}
            </button>
          ))}
          <div className="dock-slots__login-add">
            <input
              className="input"
              value={loginFilter}
              onChange={(event) => setLoginFilter(event.target.value)}
              placeholder="Type to find a login…"
              aria-label="Find a login to add"
            />
            {addableLogins.map((item) => (
              <button
                key={item.id}
                type="button"
                className="segmented__option"
                onClick={() => add({ kind: 'login', ref: item.id, key: String(slots.length + 1) })}
              >
                {item.title || item.username || 'Untitled'}
              </button>
            ))}
          </div>
          {addableViews.length + addableInbox.length + addableMailboxes.length + addableChannels.length + addableFolders.length === 0 &&
          addableLogins.length === 0 &&
          !loginFilter.trim() ? (
            <p className="field__hint">Everything available is already on the bar.</p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={slots.length >= MAX_DOCK_SLOTS}
          onClick={() => setAdding(true)}
        >
          + Add slot
        </button>
      )}
    </div>
  );
}

/** Icon picker for one slot: remote URL, file upload, or back to the glyph. */
function DockIconEditor({
  current,
  onPickFile,
  onPickUrl,
  onClear,
  onDone,
}: {
  current?: string;
  onPickFile: (file: File | undefined) => void;
  onPickUrl: (url: string) => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const [url, setUrl] = useState(current?.startsWith('https://') ? current : '');
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="dock-slots__icon-editor">
      {current ? <img className="dock-slots__icon-preview" src={current} alt="" aria-hidden="true" /> : null}
      <input
        className="input"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://… image link"
        inputMode="url"
        spellCheck={false}
        aria-label="Image link"
      />
      <div className="field-row">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => onPickUrl(url)}>
          Use link
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => fileInput.current?.click()}>
          Upload…
        </button>
        {current ? (
          <button type="button" className="btn btn--quiet btn--sm" onClick={onClear}>
            Back to glyph
          </button>
        ) : null}
        <button type="button" className="btn btn--quiet btn--sm" onClick={onDone}>
          Done
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onPickFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}
