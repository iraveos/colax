/**
 * Editor for a single sidebar channel.
 *
 * Every channel is editable, built-ins included: name, icon, colour, accent
 * theme, background image, the base filter, and which tags narrow it. Opened by
 * right-clicking the sidebar, from the Channels settings tab, or by adding one.
 */

import { useRef, useState } from 'react';
import {
  CHANNEL_ACCENTS,
  CHANNEL_ICONS,
  createChannel,
  newChannelId,
  type Channel,
  type ChannelKind,
  type Tag,
} from '../vault/channels.ts';
import { MAX_APP_BACKGROUND_BYTES } from '../vault/types.ts';
import { readImageFile } from './card-art.ts';
import { Modal, Toggle } from './primitives.tsx';
import type { GmailAccount } from '../vault/storage.ts';
import {
  CloudIcon,
  FlagIcon,
  GridIcon,
  InboxIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  ShieldIcon,
  StarIcon,
  TrashIcon,
} from './icons.tsx';

const KIND_OPTIONS: { id: ChannelKind; label: string; hint: string }[] = [
  { id: 'all', label: 'Everything', hint: 'Every login' },
  { id: 'favorites', label: 'Favorites', hint: 'Starred only' },
  { id: 'attention', label: 'Needs attention', hint: 'Flagged' },
  { id: 'weak', label: 'Weak or reused', hint: 'Reused or old' },
];

/** Starting hue for each accent, matching the presets in storage.ts, so the chips
 *  reflect the real theme rather than an arbitrary colour. */
const ACCENT_HUES: Record<string, number> = {
  slate: 212,
  sage: 152,
  dusk: 268,
  clay: 28,
};

function accentHue(accent: string): number {
  return ACCENT_HUES[accent] ?? 212;
}

const ICON_SET: Record<string, typeof InboxIcon> = {
  inbox: InboxIcon,
  star: StarIcon,
  flag: FlagIcon,
  shield: ShieldIcon,
  layers: LayersIcon,
  key: KeyIcon,
  lock: LockIcon,
  cloud: CloudIcon,
  grid: GridIcon,
};

export function ChannelEditor({
  channel,
  tags,
  itemCount,
  accounts,
  onSave,
  onDelete,
  onClose,
  onNotify,
}: {
  /** null means "create a new channel". */
  channel: Channel | null;
  tags: Tag[];
  /** How many logins the current draft matches, for the live preview. */
  itemCount: number;
  /** Connected mailboxes, for the per-channel mail account picker. */
  accounts: GmailAccount[];
  onSave: (next: Channel) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Channel>(() => channel ?? createChannel(''));
  const [imageUrl, setImageUrl] = useState(
    channel?.backgroundImage?.startsWith('http') ? channel.backgroundImage : '',
  );
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const patch = (next: Partial<Channel>) => setDraft((current) => ({ ...current, ...next }));

  function toggleTag(tagId: string) {
    patch({
      tagIds: draft.tagIds.includes(tagId)
        ? draft.tagIds.filter((id) => id !== tagId)
        : [...draft.tagIds, tagId],
    });
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readImageFile(file, MAX_APP_BACKGROUND_BYTES);
      patch({ backgroundImage: dataUrl });
      setImageUrl('');
      onNotify('Channel image added');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that image.');
    }
  }

  function save() {
    if (!draft.name.trim()) {
      setError('Give the channel a name.');
      return;
    }
    // A draft with no id would be dropped on the next read, so mint one here
    // rather than relying on the caller.
    onSave({ ...draft, id: draft.id || newChannelId(), name: draft.name.trim() });
    onClose();
  }

  const Icon = ICON_SET[draft.icon] ?? LayersIcon;

  return (
    <Modal
      title={channel ? `Edit ${channel.name}` : 'New channel'}
      onClose={onClose}
      wide
      footer={
        <>
          {channel && onDelete && !channel.locked ? (
            <button
              className="btn btn--danger"
              onClick={() => {
                onDelete(channel.id);
                onClose();
              }}
            >
              <TrashIcon width="14" height="14" />
              Delete
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={!draft.name.trim()}>
            {channel ? 'Save' : 'Add channel'}
          </button>
        </>
      }
    >
      {error ? <p className="field__error">{error}</p> : null}

      {/* Live preview of how the sidebar row will look. */}
      <div className="channel-preview" data-hue={draft.hue}>
        <span className="channel-preview__dot" />
        <Icon />
        <span className="channel-preview__name">{draft.name.trim() || 'Channel name'}</span>
        <span className="channel-preview__count">{itemCount}</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="channel-name">
          Name
        </label>
        <input
          id="channel-name"
          className="input"
          value={draft.name}
          placeholder="Work logins"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </div>

      <div className="field">
        <span className="field__label">Show</span>
        <div className="segmented segmented--wrap">
          {KIND_OPTIONS.map((option) => (
            <button
              key={option.id}
              className="segmented__option"
              aria-pressed={draft.kind === option.id}
              title={option.hint}
              onClick={() => patch({ kind: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Tags</span>
        {tags.length === 0 ? (
          <p className="field__hint">
            No tags yet. Add them from a login&apos;s editor and they will appear here.
          </p>
        ) : (
          <div className="tag-cloud">
            {tags.map((tag) => (
              <button
                key={tag.id}
                className="tag-chip"
                aria-pressed={draft.tagIds.includes(tag.id)}
                style={{ ['--tag-h' as string]: String(tag.hue) }}
                onClick={() => toggleTag(tag.id)}
              >
                <span className="tag-chip__dot" />
                {tag.name}
              </button>
            ))}
          </div>
        )}
        <p className="field__hint">
          {draft.tagIds.length === 0
            ? 'No tag filter — this channel shows everything the filter above returns.'
            : `Only logins carrying ${draft.tagIds.length === 1 ? 'this tag' : 'these tags'} appear here.`}
        </p>
      </div>

      <div className="field">
        <span className="field__label">Icon</span>
        <div className="icon-picker">
          {CHANNEL_ICONS.map((key) => {
            const Glyph = ICON_SET[key] ?? LayersIcon;
            return (
              <button
                key={key}
                className="icon-picker__option"
                aria-pressed={draft.icon === key}
                aria-label={key}
                onClick={() => patch({ icon: key })}
              >
                <Glyph />
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="channel-hue">
          Colour
        </label>
        <div className="slider-row" style={{ width: '100%' }}>
          <input
            id="channel-hue"
            className="slider"
            type="range"
            min={0}
            max={359}
            value={draft.hue}
            onChange={(event) => patch({ hue: Number(event.target.value) })}
          />
          <span className="slider-row__value">{Math.round(draft.hue)}°</span>
        </div>
      </div>

      <div className="field">
        <span className="field__label">Theme</span>
        <div className="segmented segmented--wrap">
          {CHANNEL_ACCENTS.map((accent) => (
            <button
              key={accent}
              className="segmented__option"
              aria-pressed={draft.accent === accent}
              onClick={() => patch({ accent })}
            >
              {/* Every option gets the same treatment: a colour chip. Previously
                  only Slate and Dusk had icons, so the row looked broken. */}
              <span
                className="accent-swatch__chip"
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  background: `linear-gradient(135deg, hsl(${accentHue(accent)} 44% 58%), hsl(${(accentHue(accent) + 22) % 360} 38% 46%))`,
                }}
              />
              {accent[0]?.toUpperCase()}
              {accent.slice(1)}
            </button>
          ))}
        </div>
        <p className="field__hint">Applied to the whole app while this channel is selected.</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="channel-image">
          Image
        </label>
        <div className="field-row">
          <input
            id="channel-image"
            className="input"
            value={imageUrl}
            placeholder="https://example.com/photo.jpg"
            inputMode="url"
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              setImageUrl(value);
              if (value.trim() === '' || /^https?:\/\//i.test(value.trim())) {
                patch({ backgroundImage: value.trim() });
              }
            }}
          />
          <button className="btn btn--secondary" onClick={() => fileInput.current?.click()}>
            Upload
          </button>
          {draft.backgroundImage ? (
            <button
              className="btn btn--ghost btn--icon"
              aria-label="Remove channel image"
              onClick={() => {
                setImageUrl('');
                patch({ backgroundImage: '' });
              }}
            >
              <XIcon />
            </button>
          ) : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => void onPick(event.target.files?.[0])}
        />
        <p className="field__hint">A backdrop for this channel, behind the logins it shows.</p>
      </div>

      <div className="field">
        <span className="field__label">Messages</span>
        <p className="field__note" style={{ marginTop: 0 }}>
          Whether logins show their message expander while this channel is selected, and from which mailbox.
        </p>
        <Toggle
          label="Show messages in this channel"
          checked={draft.showMail !== false}
          onChange={(showMail) => patch({ showMail })}
        />
        {draft.showMail !== false && accounts.length > 1 ? (
          <div className="field" style={{ marginTop: 'var(--space-2)' }}>
            <label className="field__label" htmlFor="channel-mail-account">
              Read mail from
            </label>
            <select
              id="channel-mail-account"
              className="select__trigger"
              value={accounts.some((account) => account.id === draft.mailAccount) ? draft.mailAccount : 'all'}
              onChange={(event) => patch({ mailAccount: event.target.value })}
            >
              <option value="all">All connected mailboxes</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.address || '(no address)'}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}