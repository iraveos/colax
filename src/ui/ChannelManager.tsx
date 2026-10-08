/**
 * Channel and tag management for the settings tab.
 *
 * The list here mirrors the sidebar: every channel, built-ins included, and each
 * one opens the same editor you reach by right-clicking the sidebar. Tags are
 * managed underneath, since a channel is defined by the tags it watches.
 */

import { useState } from 'react';
import { CHANNEL_KIND_LABELS, type Channel, type Tag } from '../vault/channels.ts';
import { EditIcon, EyeIcon, EyeOffIcon, PlusIcon, TagIcon, TrashIcon } from './icons.tsx';

export function ChannelManager({
  channels,
  tags,
  hiddenChannels = [],
  onEditChannel,
  onTagsChange,
  onHiddenChannelsChange,
  onScrubTag,
  onNotify,
}: {
  channels: Channel[];
  tags: Tag[];
  /** Channel ids hidden from the sidebar rail. */
  hiddenChannels?: string[];
  /** Opens the shared channel editor for an id, or 'new'. */
  onEditChannel: (channelId: string | 'new') => void;
  onTagsChange: (next: Tag[]) => void;
  onHiddenChannelsChange?: (next: string[]) => void;
  /** Removes a deleted tag from every login that referenced it. */
  onScrubTag?: (tagId: string) => void;
  onNotify: (message: string) => void;
}) {
  const hidden = new Set(hiddenChannels);

  function toggleHidden(channel: Channel) {
    const next = hidden.has(channel.id)
      ? hiddenChannels.filter((id) => id !== channel.id)
      : [...hiddenChannels, channel.id];
    onHiddenChannelsChange?.(next);
    onNotify(hidden.has(channel.id) ? `"${channel.name}" is back in the sidebar` : `"${channel.name}" hidden from the sidebar`);
  }
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [hueFor, setHueFor] = useState<string | null>(null);

  const tagName = (tagId: string) => tags.find((tag) => tag.id === tagId)?.name ?? 'Missing tag';
  const usesTag = (tagId: string) => channels.filter((channel) => channel.tagIds.includes(tagId));

  function renameTag(tag: Tag, nextName: string) {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    onTagsChange(tags.map((entry) => (entry.id === tag.id ? { ...entry, name: trimmed } : entry)));
    setEditingTag(null);
  }

  function deleteTag(tagId: string) {
    const affected = usesTag(tagId);
    if (affected.length > 0) {
      const names = affected.map((channel) => channel.name).join(', ');
      onNotify(`"${tagName(tagId)}" is used by ${names} — it will be removed from ${affected.length === 1 ? 'that channel' : 'those channels'}`);
    }
    onTagsChange(tags.filter((tag) => tag.id !== tagId));
    // Logins keep their own copy of the tag list, so it has to be stripped there
    // too or the id lingers invisibly forever.
    onScrubTag?.(tagId);
  }

  return (
    <div className="setting setting--stack">
      <div className="setting__text">
        <div className="setting__label">Channels</div>
        <div className="setting__hint">
          Every channel is editable — name, icon, colour, theme, image and tags — and any of them can be
          dragged to a new position in the sidebar. The eye hides one from the rail without deleting it.
          Right-clicking the sidebar does the same thing.
        </div>
      </div>

      <div className="tag-manager">
        {channels.map((channel) => {
          const isHidden = hidden.has(channel.id);
          return (
            <div className="tag-manager__row" key={channel.id} data-hidden={isHidden || undefined}>
              <span className="tag-manager__dot" style={{ background: `hsl(${channel.hue} 46% 54%)` }} />
              <button
                className="tag-manager__name"
                onClick={() => onEditChannel(channel.id)}
                title={`Edit ${channel.name}`}
              >
                {channel.name}
                {channel.builtin ? <span className="tag-manager__badge">built-in</span> : null}
                {isHidden ? <span className="tag-manager__badge">hidden</span> : null}
              </button>
              <span className="tag-manager__count">
                {channel.tagIds.length === 0
                  ? CHANNEL_KIND_LABELS[channel.kind]
                  : channel.tagIds.map(tagName).join(', ')}
              </span>
              <button
                className="btn btn--icon"
                aria-label={isHidden ? `Show ${channel.name} in the sidebar` : `Hide ${channel.name} from the sidebar`}
                aria-pressed={!isHidden}
                title={isHidden ? 'Show in sidebar' : 'Hide from sidebar'}
                onClick={() => toggleHidden(channel)}
              >
                {isHidden ? <EyeOffIcon width="14" height="14" /> : <EyeIcon width="14" height="14" />}
              </button>
              <button
                className="btn btn--icon"
                aria-label={`Edit channel ${channel.name}`}
                onClick={() => onEditChannel(channel.id)}
              >
                <EditIcon width="14" height="14" />
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn--secondary" onClick={() => onEditChannel('new')}>
          <PlusIcon width="14" height="14" />
          New channel
        </button>
        {hidden.size < channels.length ? (
          <button
            className="btn btn--quiet"
            onClick={() => {
              onHiddenChannelsChange?.(channels.map((channel) => channel.id));
              onNotify(`Hid ${channels.length} channel${channels.length === 1 ? '' : 's'} from the sidebar`);
            }}
            title="Hide every channel from the sidebar rail (nothing is deleted)"
          >
            <EyeOffIcon width="14" height="14" />
            Hide all
          </button>
        ) : null}
        {hidden.size > 0 ? (
          <button
            className="btn btn--quiet"
            onClick={() => {
              onHiddenChannelsChange?.([]);
              onNotify('Every channel is back in the sidebar');
            }}
            title="Show every hidden channel again"
          >
            <EyeIcon width="14" height="14" />
            Show all
          </button>
        ) : null}
      </div>

      <div className="setting__label" style={{ marginTop: 'var(--space-2)' }}>
        Tags
      </div>

      {tags.length === 0 ? (
        <div className="alert alert--info">
          <TagIcon width="16" height="16" />
          <span>
            No tags yet. Add one from a login&apos;s editor — then attach it to a channel and only logins
            carrying it will show there.
          </span>
        </div>
      ) : (
        <div className="tag-manager">
          {tags.map((tag) => {
            const editing = editingTag === tag.id;
            const channels = usesTag(tag.id);
            return (
              <div className="tag-manager__row" key={tag.id}>
                <span className="tag-manager__dot" style={{ background: `hsl(${tag.hue} 46% 54%)` }} />
                {editing ? (
                  <input
                    className="input input--mono"
                    defaultValue={tag.name}
                    autoFocus
                    onBlur={(event) => renameTag(tag, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setEditingTag(null);
                    }}
                    aria-label={`Rename ${tag.name}`}
                  />
                ) : (
                  <button className="tag-manager__name" onClick={() => setEditingTag(tag.id)} title="Rename">
                    {tag.name}
                  </button>
                )}
                {hueFor === tag.id ? (
                  <input
                    className="tag-manager__hue"
                    type="range"
                    min={0}
                    max={359}
                    autoFocus
                    defaultValue={tag.hue}
                    onBlur={() => setHueFor(null)}
                    onChange={(event) =>
                      onTagsChange(
                        tags.map((entry) =>
                          entry.id === tag.id ? { ...entry, hue: Number(event.target.value) } : entry,
                        ),
                      )
                    }
                    aria-label={`Colour for ${tag.name}`}
                  />
                ) : (
                  <button
                    className="tag-manager__swatch"
                    style={{ background: `hsl(${tag.hue} 46% 54%)` }}
                    onClick={() => setHueFor(hueFor === tag.id ? null : tag.id)}
                    aria-label={`Change colour for ${tag.name}`}
                    title="Change colour"
                  />
                )}
                <span className="tag-manager__count">
                  {channels.length === 0 ? 'unused' : `${channels.length} channel${channels.length === 1 ? '' : 's'}`}
                </span>
                <button
                  className="btn btn--icon"
                  aria-label={`Delete tag ${tag.name}`}
                  onClick={() => deleteTag(tag.id)}
                >
                  <TrashIcon width="14" height="14" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}