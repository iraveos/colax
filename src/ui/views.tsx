import { useEffect, useState } from 'react';
import { AnimatedList } from '../components/react-bits/AnimatedList.tsx';
import { CircularCarousel, type CarouselItem } from '../components/react-bits/CircularCarousel.tsx';
import { backgroundSrc, itemBackgroundStyle, itemStyle, toCarouselItems } from './card-art.ts';
import { EmptyState } from './primitives.tsx';
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  EditIcon,
  ExternalIcon,
  EyeIcon,
  EyeOffIcon,
  FlagIcon,
  InboxIcon,
  KeyShieldIcon,
  StarIcon,
  TrashIcon,
} from './icons.tsx';
import { hostnameOf, relativeTime, type VaultItem } from '../vault/types.ts';
import { isSecured } from '../crypto/security.ts';
import type { CardSizePrefs } from '../vault/storage.ts';
import { SecurityGate } from './SecurityGate.tsx';
import type { Tag } from '../vault/channels.ts';


/** `days` of 0 switches the stale check off entirely. */
function isStale(item: VaultItem, days: number): boolean {
  if (days <= 0) return false;
  return Date.now() - item.passwordUpdatedAt > days * 86_400_000;
}

/** Shared label so every view agrees on what a login is called. */
export function labelOf(item: VaultItem): string {
  return item.title || item.username || hostnameOf(item.url) || 'Untitled';
}

function maskOf(item: VaultItem): string {
  return '•'.repeat(Math.min(item.password.length || 10, 26));
}

export interface ViewActions {
  onCopy: (value: string, label: string) => void;
  onEdit: (item: VaultItem) => void;
  onDelete: (item: VaultItem) => void;
  onToggleFavorite: (item: VaultItem) => void;
  onToggleAttention: (item: VaultItem) => void;
  onOpenUrl: (item: VaultItem) => void;
  /** Activating a card (click or Enter). */
  onSelect: (item: VaultItem) => void;
  /** Right-click on a specific login. */
  onItemMenu: (event: React.MouseEvent, item: VaultItem) => void;
/** Global tag catalogue, for the chips on each card. */
  tags: Tag[];
  /** Draws those chips; off hides them without losing the tags themselves. */
  showTagChips: boolean;
  /** Orbit only: labels each node with the login's title and email. */
  showOrbitLabels?: boolean;
  /** List only: group rows under their first letter. */
  showLetterGroups?: boolean;
}

interface CommonViewProps extends ViewActions {
  items: VaultItem[];
  duplicateIds: Set<string>;
  showHealthBadges: boolean;
  showUrls: boolean;
  staleDays: number;
  /** This view's own card geometry and colour, from Settings or the panel. */
  cardSize: CardSizePrefs;
}

/** Tag chips for a login, resolved against the catalogue. */
function TagChips({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="chip chip--tag"
          style={{ '--tag-h': String(tag.hue) } as React.CSSProperties}
        >
          {tag.name}
        </span>
      ))}
    </>
  );
}

/** "Password changed 3 days ago · email changed 2 months ago" */
function ModifiedNote({ item }: { item: VaultItem }) {
  return (
    <div className="card-row__dates">
      <span title={new Date(item.passwordUpdatedAt).toLocaleString()}>
        Password {relativeTime(item.passwordUpdatedAt)}
      </span>
      <span title={new Date(item.usernameUpdatedAt).toLocaleString()}>
        Email {relativeTime(item.usernameUpdatedAt)}
      </span>
    </div>
  );
}

/* ==========================================================================
   View 1 (default) — Flow
   ========================================================================== */

export function AnimatedListView({
  items,
  duplicateIds,
  showHealthBadges,
  staleDays,
  showTagChips,
  cardSize,
  onCopy,
  onEdit,
  onDelete,
  onToggleFavorite,
  onToggleAttention,
  onOpenUrl,
  onSelect,
  onItemMenu,
  tags,
}: CommonViewProps) {
  // Ids whose password has been explicitly revealed. Everything else is masked, so
  // opening the vault never puts every credential on screen at once.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // A login with its own second factor has to clear it before its password shows.
  const [gateItem, setGateItem] = useState<VaultItem | null>(null);
  const itemTagsFor = (item: VaultItem) => tags.filter((tag) => item.tags.includes(tag.id));

  if (items.length === 0) return null;

  const toggle = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    const showing = revealed.has(id);
    if (!showing && item && isSecured(item.security)) {
      setGateItem(item);
      return;
    }
    setRevealed((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
  <>
    <div
      className="flow-scale"
      style={
        {
          '--card-scale': String(cardSize.scale),
          '--card-surface': String(cardSize.surface),
          '--card-radius': `${cardSize.radius}px`,
          '--card-max': `${Math.round(cardSize.width)}px`,
          '--card-min-height': `${Math.round(cardSize.minHeight)}px`,
        } as React.CSSProperties
      }
    >
    <AnimatedList
      items={items}
      itemKey={(item) => item.id}
      onItemSelect={(item) => onSelect(item)}
      renderItem={(item, _index, selected) => {
        const label = labelOf(item);
        // Masked unless this row's eye has been clicked.
        const show = revealed.has(item.id);
        const stale = isStale(item, staleDays);
        const reused = duplicateIds.has(item.password) && item.password !== '';
        const photo = backgroundSrc(item);
        // Website name in place of the avatar glyph: the domain is already
        // stored, so this needs no favicon fetch and no network round trip.
        const site = hostnameOf(item.url);
        const secured = isSecured(item.security);
      
        return (
          <div
            data-vault-item={item.id}
            className="card-row"
            data-photo={photo ? '' : undefined}
            style={{ ...itemStyle(item), ...itemBackgroundStyle(item) }}
            data-flagged={item.needsAttention || undefined}
            onContextMenu={(event) => onItemMenu(event, item)}
            onDoubleClick={(event) => {
              event.preventDefault();
              onEdit(item);
            }}
          >
{selected ? <div className="rb-animated-list__glow" aria-hidden="true" /> : null}
              {photo ? <div className="item__art" aria-hidden="true" /> : null}
              {photo ? <div className="card-row__scrim" aria-hidden="true" /> : null}

            {secured ? (
              <span className="card-row__secured" title="This login has a second factor">
                <KeyShieldIcon width="15" height="15" />
              </span>
            ) : null}


            <div className="card-row__head">
              {/* The avatar is replaced by the site's own name. It is what the user actually
                recognises, it is already stored, and dropping it also removes
                the letter-tile that was reading as a stray icon. */}
              {site ? <span className="card-row__site">{site}</span> : null}

              <div className="card-row__body">
                <div className="card-row__title">
                  {/* The site is named by its own domain rather than an icon:
                      the domain is what the user recognises, and it is already
                      stored, so nothing has to be fetched. */}
                  <span className="card-row__name">{label}</span>
                  {secured ? null : item.favorite ? (
                    <StarIcon width="13" height="13" filled style={{ color: 'var(--warn)' }} />
                  ) : null}
                  {showHealthBadges && reused ? <span className="chip chip--warn">reused</span> : null}
                  {showHealthBadges && stale ? (
                    <span className="chip chip--muted">
                      <ClockIcon width="11" height="11" />
                      old
                    </span>
                  ) : null}
                  {showTagChips ? <TagChips tags={itemTagsFor(item)} /> : null}
                </div>
                {/* The email under the title is gone; the username now lives in
                    the credential block below, on the same row as the password. */}
              </div>
              <div className="card-row__actions">
                <button
                  className="btn btn--icon"
                  data-action="attention"
                  aria-label={item.needsAttention ? 'Clear needs attention' : 'Mark as needing attention'}
                  aria-pressed={item.needsAttention}
                  style={item.needsAttention ? { color: 'var(--warn)' } : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleAttention(item);
                  }}
                >
                  <FlagIcon filled={item.needsAttention} />
                </button>
                <button
                  className="btn btn--icon"
                  data-action="favorite"
                  aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={item.favorite}
                  style={item.favorite ? { color: 'var(--warn)' } : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(item);
                  }}
                >
                  <StarIcon filled={item.favorite} />
                </button>
                <button
                  className="btn btn--icon"
                  data-action="edit"
                  aria-label="Edit login"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(item);
                  }}
                >
                  <EditIcon />
                </button>
              </div>
            </div>

{/* Username and password share one row, as asked: the password is masked by
                default and the username stays readable beside it, so you can
                tell two cards apart without revealing anything. */}
            <div className="card-row__secret">
              <div className="card-row__secret-row">
                <span className="card-row__username">{item.username || hostnameOf(item.url) || 'No username'}</span>
                {item.username ? (
                  <button
                    className="btn btn--icon"
                    aria-label="Copy username"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCopy(item.username, 'Username');
                    }}
                  >
                    <CopyIcon />
                  </button>
                ) : null}
              </div>
              <div className="card-row__secret-row">
                <code className="card-row__password">{show ? item.password || '—' : maskOf(item)}</code>
                <button
                  className="btn btn--icon"
                  aria-label="Copy password"
                  disabled={!item.password}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopy(item.password, 'Password');
                  }}
                >
                  <CopyIcon />
                </button>
                <button
                  className="btn btn--icon"
                  aria-label={show ? 'Hide password' : 'Reveal password'}
                  aria-pressed={show}
                  data-active={show || undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(item.id);
                  }}
>
                {show ? <EyeOffIcon /> : <EyeIcon />}
              </button>
              </div>
            </div>

            {item.notes ? (
              <div className="card-row__foot">
                <span className="card-row__label">Notes</span>
                <span className="card-row__notes">{item.notes}</span>
              </div>
            ) : null}

            <ModifiedNote item={item} />

            {item.url ? (
              <div className="card-row__actions-row">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenUrl(item);
                  }}
                >
                  <ExternalIcon width="13" height="13" />
                  Open site
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(item);
                  }}
                >
                  <TrashIcon width="13" height="13" />
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        );
      }}
    />
    </div>
    {gateItem ? (
      <SecurityGate
        security={gateItem.security}
        title={`Unlock ${labelOf(gateItem)}`}
        hint="This login has its own second factor. Clear it to reveal the password."
        onVerified={() => {
          setRevealed((current) => new Set(current).add(gateItem.id));
          setGateItem(null);
        }}
        onCancel={() => setGateItem(null)}
      />
    ) : null}
  </>
  );
}

/* ==========================================================================
   View 2 — Orbit
   ========================================================================== */

export function CarouselView({
  items,
  onCopy,
  onEdit,
  onDelete,
  onOpenUrl,
onSelect,
  onItemMenu,
  tags,
  showTagChips,
  showOrbitLabels,
  cardSize,
}: CommonViewProps) {
  const [active, setActive] = useState(0);
  // The one login whose password the user has chosen to reveal. Null means every
  // password is masked, which is the default.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  // A login with its own second factor has to clear it before its password shows.
  const [gateItem, setGateItem] = useState<VaultItem | null>(null);

  const index = Math.min(active, Math.max(items.length - 1, 0));
  const current = items[index] as VaultItem | undefined;

  useEffect(() => {
    if (revealedId && !items.some((item) => item.id === revealedId)) setRevealedId(null);
  }, [items, revealedId]);

  if (!current) return null;

  const cards: CarouselItem[] = toCarouselItems(items);
  const show = revealedId === current.id;
  const itemTags = tags.filter((tag) => current.tags.includes(tag.id));
  const photo = backgroundSrc(current);

  return (
    <div className="carousel-view">
      <div className="carousel-view__stage">
        <CircularCarousel
          items={cards}
          preset="orbit"
          intro="rise"
          cardWidth={Math.round(cardSize.width * cardSize.scale)}
          aspectRatio={cardSize.aspect}
          cornerRadius={cardSize.radius}
          autoplay="drift"
          speed={9}
          depthFade={0.22}
          innerShade={0.92}
          cardLabels={showOrbitLabels}
          ariaLabel="Logins"
          onChange={setActive}
          onItemClick={(_, picked) => onSelect(items[picked] as VaultItem)}
        />
      </div>

<div
        // Remounting per login replays the entrance animation each time the
        // ring lands on a different card.
        key={current.id}
        className="carousel-view__panel"
        data-vault-item={current.id}
        data-photo={photo ? '' : undefined}
        style={{
          ...itemStyle(current),
          ...itemBackgroundStyle(current),
          '--card-radius': `${cardSize.radius}px`,
          '--card-surface': String(cardSize.surface),
        } as React.CSSProperties}
        onContextMenu={(event) => onItemMenu(event, current)}
        onDoubleClick={(event) => {
          // Same gesture as Flow and List: double-click anywhere on the panel
          // opens the editor.
          event.preventDefault();
          onEdit(current);
        }}
      >
        {photo ? <div className="item__art" aria-hidden="true" /> : null}
        {photo ? <div className="carousel-view__scrim" aria-hidden="true" /> : null}

<div className="carousel-view__head">
          <span className="card-row__site">{hostnameOf(current.url) ?? labelOf(current)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="carousel-view__name">{labelOf(current)}</div>
          </div>
          {isSecured(current.security) ? (
            <span title="This login has a second factor">
              <KeyShieldIcon width="16" height="16" style={{ color: 'var(--accent-text)' }} />
            </span>
          ) : null}
          {current.favorite ? <StarIcon width="16" height="16" filled style={{ color: 'var(--warn)' }} /> : null}
        </div>

        {/* Tags, matching the Flow and List cards. */}
        {showTagChips && itemTags.length > 0 ? <TagChips tags={itemTags} /> : null}

        <div className="carousel-view__secret">
          <div className="card-row__secret-row">
            <span className="card-row__username">{current.username || hostnameOf(current.url) || 'No username'}</span>
            {current.username ? (
              <button
                className="btn btn--icon"
                aria-label="Copy username"
                onClick={() => onCopy(current.username, 'Username')}
              >
                <CopyIcon />
              </button>
            ) : null}
          </div>
          {/* Re-keyed on the reveal state so the swap animates instead of cutting. */}
          <div className="card-row__secret-row">
            <code key={show ? 'shown' : 'masked'} className="carousel-view__pw">
              {show ? current.password || '—' : maskOf(current)}
            </code>
            <button
              className="btn btn--icon"
              aria-label="Copy password"
              disabled={!current.password}
              onClick={() => onCopy(current.password, 'Password')}
            >
              <CopyIcon />
            </button>
            <button
              className="btn btn--icon"
              aria-label={show ? 'Hide password' : 'Reveal password'}
              aria-pressed={show}
              data-active={show || undefined}
              onClick={() => {
                if (!show && isSecured(current.security)) {
                  setGateItem(current);
                  return;
                }
                setRevealedId(show ? null : current.id);
              }}
            >
              {show ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>

        <div className="carousel-view__meta">
          <button
            className="btn btn--primary"
            onClick={() => onCopy(current.password, 'Password')}
            disabled={!current.password}
          >
            <CheckIcon width="14" height="14" />
            Copy password
          </button>
          <button className="btn btn--secondary" onClick={() => onEdit(current)}>
            <EditIcon width="14" height="14" />
            Edit
          </button>
          {current.url ? (
            <button className="btn btn--ghost" onClick={() => onOpenUrl(current)}>
              <ExternalIcon width="14" height="14" />
              Open site
            </button>
          ) : null}
          <button className="btn btn--ghost btn--icon" aria-label="Delete" onClick={() => onDelete(current)}>
            <TrashIcon width="14" height="14" />
          </button>
        </div>
      </div>

      {gateItem ? (
        <SecurityGate
          security={gateItem.security}
          title={`Unlock ${labelOf(gateItem)}`}
          hint="This login has its own second factor. Clear it to reveal the password."
          onVerified={() => {
            setRevealedId(gateItem.id);
            setGateItem(null);
          }}
          onCancel={() => setGateItem(null)}
        />
      ) : null}

      <p className="carousel-view__hint">
        Drag or scroll to spin the ring · <span className="kbd">←</span> <span className="kbd">→</span> to step · right
        click for more
      </p>
    </div>
  );
}

/* ==========================================================================
   View 3 — List
   ========================================================================== */

export function BasicView({
  items,
  duplicateIds,
  showHealthBadges,
  staleDays,
showTagChips,
  tags,
  showLetterGroups,
  cardSize,
  onEdit,
  onDelete,
  onToggleFavorite,
  onSelect,
  onItemMenu,
}: CommonViewProps) {
  // Ids whose password has been explicitly revealed. Everything else is masked, so
  // opening the vault never puts every credential on screen at once.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // A login with its own second factor has to clear it before its password shows.
  const [gateItem, setGateItem] = useState<VaultItem | null>(null);
  const itemTagsFor = (item: VaultItem) => tags.filter((tag) => item.tags.includes(tag.id));
  const showGroups = showLetterGroups !== false;

  if (items.length === 0) return null;

  const toggle = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    const showing = revealed.has(id);
    if (!showing && item && isSecured(item.security)) {
      setGateItem(item);
      return;
    }
    setRevealed((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const groups = showGroups ? groupByLetter(items) : [['', items] as [string, VaultItem[]]];

  return (
    <div
      className="content__inner list-scale"
      style={
        {
          '--card-scale': String(cardSize.scale),
          '--card-surface': String(cardSize.surface),
          '--card-radius': `${cardSize.radius}px`,
          '--card-max': `${Math.round(cardSize.width)}px`,
          '--card-min-height': `${Math.round(cardSize.minHeight)}px`,
        } as React.CSSProperties
      }
    >
      {groups.map(([letter, group]) => (
        <section className="list-group" key={letter || 'all'}>
          {letter ? <h2 className="list-group__title">{letter}</h2> : null}
          <div className="list">
            {group.map((item) => {
              const label = labelOf(item);
              const show = revealed.has(item.id);
              const photo = backgroundSrc(item);
              return (
                <div
                  className="item"
                  data-vault-item={item.id}
                  data-photo={photo ? '' : undefined}
                  key={item.id}
style={{ ...itemStyle(item), ...itemBackgroundStyle(item) }}
                  onContextMenu={(event) => onItemMenu(event, item)}
                  onDoubleClick={(event) => {
                    // Matches Flow and Orbit.
                    event.preventDefault();
                    onEdit(item);
                  }}
                >
                  {photo ? <div className="item__art" aria-hidden="true" /> : null}
                {photo ? <div className="item__scrim" aria-hidden="true" /> : null}

<button className="item__trigger" onClick={() => onSelect(item)}>
                    <span className="card-row__site">{hostnameOf(item.url) ?? labelOf(item)}</span>
                    <span className="item__body">
                      <span className="item__title">
                        {label}
                        {item.favorite ? (
                          <StarIcon width="13" height="13" filled style={{ color: 'var(--warn)' }} />
                        ) : null}
                        {showHealthBadges && duplicateIds.has(item.password) && item.password ? (
                          <span className="chip chip--warn">reused</span>
                        ) : null}
                        {showHealthBadges && isStale(item, staleDays) ? (
                          <span className="chip chip--muted">
                            <ClockIcon width="11" height="11" />
                            old
                          </span>
                        ) : null}
                        {/* Tags sit on the title line, matching the Flow card. */}
                        {showTagChips ? <TagChips tags={itemTagsFor(item)} /> : null}
                      </span>
                    </span>
                  </button>

                  <div className="item__actions">
                    <button
                      className="btn btn--icon"
                      data-action="favorite"
                  aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-pressed={item.favorite}
                      style={item.favorite ? { color: 'var(--warn)' } : undefined}
                      onClick={() => onToggleFavorite(item)}
                    >
                      <StarIcon filled={item.favorite} />
                    </button>
                    <button className="btn btn--icon" aria-label="Edit login" onClick={() => onEdit(item)}>
                      <EditIcon />
                    </button>
                    <button className="btn btn--icon" aria-label="Delete login" onClick={() => onDelete(item)}>
                      <TrashIcon />
                    </button>
                    <button
                      className="btn btn--icon"
                      aria-label="Copy password"
                      disabled={!item.password}
                      onClick={() => onSelect(item)}
                    >
                      <CopyIcon />
                    </button>
                    <button
                      className="btn btn--icon"
                      data-active={show || undefined}
                      aria-label={show ? 'Hide password' : 'Reveal password'}
                      aria-pressed={show}
                      onClick={() => toggle(item.id)}
                    >
                      {show ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>

                  {show ? (
                    <div className="item__peek">
                      <span className="item__peek-user">{item.username || hostnameOf(item.url) || 'No username'}</span>
                      <code>{item.password || '—'}</code>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {gateItem ? (
        <SecurityGate
          security={gateItem.security}
          title={`Unlock ${labelOf(gateItem)}`}
          hint="This login has its own second factor. Clear it to reveal the password."
          onVerified={() => {
            setRevealed((current) => new Set(current).add(gateItem.id));
            setGateItem(null);
          }}
          onCancel={() => setGateItem(null)}
        />
      ) : null}
    </div>
  );
}

function groupByLetter(items: VaultItem[]) {
  const groups = new Map<string, VaultItem[]>();
  for (const item of items) {
    const key = labelOf(item).trim()[0]?.toUpperCase() ?? '~';
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function ViewEmptyState({
  query,
  screen,
  onAdd,
}: {
  query: string;
  screen: string;
  onAdd: () => void;
}) {
  const title = query
    ? 'No matches'
    : screen === 'favorites'
      ? 'No favorites yet'
      : screen === 'weak'
        ? 'Nothing needs attention'
        : 'Your vault is empty';

  const text = query
    ? `Nothing matches "${query}". Try a different search.`
    : screen === 'favorites'
      ? 'Star a login to pin it to the top of every view.'
      : screen === 'weak'
        ? 'No reused or long-untouched passwords. Nice.'
        : 'Add your first login and it will be encrypted on this device straight away.';

  return (
    <EmptyState
      icon={<InboxIcon width="26" height="26" />}
      title={title}
      text={text}
      action={
        screen === 'all' && !query ? (
          <button className="btn btn--primary" onClick={onAdd}>
            Add a login
          </button>
        ) : undefined
      }
    />
  );
}
