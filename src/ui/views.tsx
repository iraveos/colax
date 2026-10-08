import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { AnimatedList } from '../components/react-bits/AnimatedList.tsx';
import { CircularCarousel, type CarouselItem } from '../components/react-bits/CircularCarousel.tsx';
import { avatarSrc, backgroundSrc, itemBackgroundStyle, itemStyle, toCarouselItems } from './card-art.ts';
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
import { accentOf, hostnameOf, isWeakPassword, relativeTime, type VaultItem } from '../vault/types.ts';
import { isSecured } from '../crypto/security.ts';
import type { CachedMailMessage, CardSizePrefs, GmailAccount } from '../vault/storage.ts';
import type { GmailMessage } from './useGmail.ts';
import { SecurityGate } from './SecurityGate.tsx';
import { LoginMessages } from './LoginMessages.tsx';
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
  /**
   * Copies a value. The item is passed wherever one is at hand so the copy
   * counts as use; callers without an item (bulk dialogs) copy untracked.
   */
  onCopy: (value: string, label: string, item?: VaultItem) => void;
  onEdit: (item: VaultItem) => void;
  onDelete: (item: VaultItem) => void;
  onToggleFavorite: (item: VaultItem) => void;
  onToggleAttention: (item: VaultItem) => void;
  onOpenUrl: (item: VaultItem) => void;
  /** Activating a card (click or Enter). */
  onSelect: (item: VaultItem) => void;
  /** Right-click on a specific login. */
  onItemMenu: (event: React.MouseEvent, item: VaultItem) => void;
  /** Persists one account's fresh inbox read into the message cache. */
  onCacheMail?: (accountId: string, messages: GmailMessage[]) => void;
  /** Opens a URL in the real browser. Message links use this, never window.open. */
  onOpenExternal?: (url: string) => void;
/** Global tag catalogue, for the chips on each card. */
  tags: Tag[];
  /** Draws those chips; off hides them without losing the tags themselves. */
  showTagChips: boolean;
  /** Orbit only: labels each node with the login's title and email. */
  showOrbitLabels?: boolean;
  /** List only: group rows under their first letter. */
  showLetterGroups?: boolean;
  /**
   * Drag a login to a flat position in the current view, switching sorting to
   * the custom drag order. Only the List and Grid views offer handles — Flow
   * and Orbit still follow the custom order through sorting, they just do not
   * start drags themselves. Absent means no reordering here.
   */
  onReorderLogins?: (activeId: string, toIndex: number, flatIds: string[]) => void;
}

interface CommonViewProps extends ViewActions {
  items: VaultItem[];
  duplicateIds: Set<string>;
  showHealthBadges: boolean;
  showUrls: boolean;
  staleDays: number;
  /** This view's own card geometry and colour, from Settings or the panel. */
  cardSize: CardSizePrefs;
  /** Currently selected ids, so a card can show it is selected. */
  selectedIds?: ReadonlySet<string>;
  /**
   * Modifier-click on a card. `extend` is true for shift, which selects a range
   * rather than toggling one.
   */
  onSelectForEdit?: (item: VaultItem, extend: boolean) => void;
  /** Connected mailboxes, for the per-login message expander. */
  gmailAccounts?: GmailAccount[];
  /**
   * Mail scope of the active channel: whether its logins show the expander at
   * all, and which account it reads ('all' or one id). Absent means show from
   * every account, which is also the pre-channel-settings behavior.
   */
  mailScope?: { show: boolean; account: string };
  /** Previously fetched messages, per account id. Lets the expander reach past one feed read. */
  mailCache?: Record<string, CachedMailMessage[]>;
}

/**
 * Whether a login gets its message expander: the channel must allow mail, the
 * login itself must not have opted out, and at least one account must be
 * connected. Checked in one place so the three views cannot disagree.
 */
function mailFor(item: VaultItem, scope: CommonViewProps['mailScope'], accounts: CommonViewProps['gmailAccounts']): boolean {
  if (scope?.show === false) return false;
  if (item.showMail === false) return false;
  return (accounts ?? []).some((account) => account.enabled && account.address && account.appPassword);
}

/**
 * Wires a card's click handler to the selection gesture.
 *
 * Returns a handler that does nothing when selection is unavailable, so a view
 * rendered without it still behaves exactly as before.
 */
function selectionClick(
  item: VaultItem,
  onSelectForEdit: CommonViewProps['onSelectForEdit'],
): ((event: { preventDefault: () => void; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void) | undefined {
  if (!onSelectForEdit) return undefined;
  return (event) => {
    // Ctrl/Cmd and shift both enter selection mode; neither does on its own,
    // because a plain click is the open-and-copy fast path.
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      onSelectForEdit(item, event.shiftKey);
    }
  };
}

/**
 * Login drag-reorder shared by the List and Grid views.
 *
 * Only the grip starts a drag (whole-row dragging would fight text selection
 * and buttons); every row is a drop target showing a before/after indicator
 * from the pointer's half, and the container itself appends to the end. Rows
 * render as motion `layout` elements upstream, so the reorder animates
 * smoothly instead of snapping. Touch screens get no drag — HTML5 dragging is
 * mouse-only — the sort menu still orders everything there.
 */
function useLoginReorder(
  flatIds: string[],
  onReorder?: (activeId: string, toIndex: number, flatIds: string[]) => void,
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const enabled = typeof onReorder === 'function';

  const gripProps = (item: VaultItem) => ({
    draggable: enabled,
    onDragStart: (event: React.DragEvent) => {
      if (!enabled) return;
      event.dataTransfer.setData('text/plain', item.id);
      event.dataTransfer.effectAllowed = 'move';
      const row = (event.target as HTMLElement).closest('[data-vault-item]');
      if (row instanceof HTMLElement) {
        try {
          event.dataTransfer.setDragImage(row, 24, 24);
        } catch {
          // Older engines ignore custom drag images; the default ghost works.
        }
      }
      setDragId(item.id);
      setOver(null);
    },
    onDragEnd: () => {
      setDragId(null);
      setOver(null);
    },
  });

  const rowProps = (item: VaultItem) => ({
    'data-dragging': dragId === item.id ? '' : undefined,
    'data-drop-before': over?.id === item.id && !over.after ? '' : undefined,
    'data-drop-after': over?.id === item.id && over.after ? '' : undefined,
    onDragOver: (event: React.DragEvent) => {
      if (!enabled || !dragId) return;
      if (dragId === item.id) {
        setOver(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const after = event.clientY - rect.top > rect.height / 2;
      setOver((current) =>
        current && current.id === item.id && current.after === after ? current : { id: item.id, after },
      );
    },
    onDragLeave: (event: React.DragEvent) => {
      const to = event.relatedTarget as Node | null;
      if (to && (event.currentTarget as HTMLElement).contains(to)) return;
      setOver((current) => (current?.id === item.id ? null : current));
    },
    onDrop: (event: React.DragEvent) => {
      if (!enabled || !dragId || !onReorder) return;
      event.preventDefault();
      event.stopPropagation();
      const targetId = item.id;
      const after = over?.id === targetId ? over.after : false;
      const active = dragId;
      setDragId(null);
      setOver(null);
      if (active === targetId) return;
      const rest = flatIds.filter((id) => id !== active);
      const ti = rest.indexOf(targetId);
      onReorder(active, ti === -1 ? rest.length : ti + (after ? 1 : 0), flatIds);
    },
  });

  /** Dropping past the last row appends to the end of the view. */
  const listProps = {
    onDragOver: (event: React.DragEvent) => {
      if (enabled && dragId) event.preventDefault();
    },
    onDrop: (event: React.DragEvent) => {
      if (!enabled || !dragId || !onReorder) return;
      event.preventDefault();
      const active = dragId;
      setDragId(null);
      setOver(null);
      onReorder(active, flatIds.filter((id) => id !== active).length, flatIds);
    },
  };

  return { enabled, dragId, gripProps, rowProps, listProps };
}

/** The six-dot grip that starts a login drag. Mouse-only, silent otherwise. */
function DragGrip({ grip }: { grip: { draggable: boolean; onDragStart: (event: React.DragEvent) => void; onDragEnd: () => void } }) {
  return (
    <span
      className="drag-grip"
      title="Drag to reorder"
      aria-hidden="true"
      draggable={grip.draggable}
      onDragStart={grip.onDragStart}
      onDragEnd={grip.onDragEnd}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
        <circle cx="2.5" cy="3" r="1.4" />
        <circle cx="7.5" cy="3" r="1.4" />
        <circle cx="2.5" cy="8" r="1.4" />
        <circle cx="7.5" cy="8" r="1.4" />
        <circle cx="2.5" cy="13" r="1.4" />
        <circle cx="7.5" cy="13" r="1.4" />
      </svg>
    </span>
  );
}

/** Tag chips for a login, resolved against the catalogue. */
/**
 * The login's image, or a letter tile when there is none.
 *
 * This was the missing piece behind "I changed the picture and saw no icon".
 * `avatarSrc` has existed the whole time and is used by nothing: the card art,
 * the editor's preview and the security-gate all read the image, but no login
 * card ever rendered it. So the editor let you pick an avatar, showed it back to
 * you in the preview, saved it, and then no view displayed it.
 *
 * Falls back through explicit avatar → card background → a hue tile derived from
 * the label, matching avatarSrc's own order so the two cannot disagree.
 */
function LoginMark({ item, site, size = 34 }: { item: VaultItem; site?: string | null; size?: number }) {
  const src = avatarSrc(item);
  const label = labelOf(item);
  const initial = (site || label).trim().slice(0, 1).toUpperCase() || '?';
  const hue = accentOf(item);
  const style = {
    '--mark-h': String(hue),
    width: size,
    height: size,
  } as React.CSSProperties;
  if (src) {
    return (
      <span
        className="login-mark"
        style={{
          ...style,
          backgroundImage: `url("${src.replace(/["'()\\]/g, '\\$&')}")`,
        }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="login-mark login-mark--letter" style={style} aria-hidden="true">
      {initial}
    </span>
  );
}

/**
 * Tag chips, rendered as a compact dotted row rather than pills.
 *
 * Pills were the problem in Grid: a cell is ~300px wide and each pill is padded
 * and rounded, so three tags wrapped onto three lines and pushed the username
 * out of the cell entirely. Grid passes `compact`, which drops the text to a
 * swatch plus the tag's initial — enough to say "this is tagged" and to
 * distinguish two tags at a glance, with the full names in the title attribute.
 */
function TagChips({ tags, compact = false }: { tags: Tag[]; compact?: boolean }) {
  if (tags.length === 0) return null;
  if (compact) {
    return (
      <span className="tag-dots" aria-label={`Tagged ${tags.map((tag) => tag.name).join(', ')}`}>
        {tags.slice(0, 5).map((tag) => (
          <span
            key={tag.id}
            className="tag-dots__dot"
            title={tag.name}
            style={{ '--tag-h': String(tag.hue) } as React.CSSProperties}
          >
            {tag.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {tags.length > 5 ? <span className="tag-dots__more">+{tags.length - 5}</span> : null}
      </span>
    );
  }
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

/**
 * Health + attention badges in their own clear row, shared by every view.
 *
 * They used to sit inline inside the title line, where a login with two tags
 * and a reused password wrapped onto three lines and pushed the username out
 * of the card. One dedicated row below the title keeps them legible: reused,
 * weak and old only when health badges are on, needs-attention always (it is
 * the user's own flag, not a health guess), plus the tag chips when enabled.
 */
export function HealthBadges({
  item,
  reused,
  stale,
  showHealthBadges,
  tags,
  showTagChips,
  compact = false,
  secured = false,
}: {
  item: VaultItem;
  reused: boolean;
  stale: boolean;
  showHealthBadges: boolean;
  tags: Tag[];
  showTagChips: boolean;
  compact?: boolean;
  /** Renders the 2FA pill first, inline in the row — never floating. */
  secured?: boolean;
}) {
  const weak = !reused && isWeakPassword(item);
  if (!secured && !showHealthBadges && !item.needsAttention && !(showTagChips && tags.length > 0)) return null;
  if (!secured && showHealthBadges && !reused && !weak && !stale && !item.needsAttention && !(showTagChips && tags.length > 0)) return null;
  return (
    <div className="card-badges">
      {secured ? <SecuredBadge secured inline /> : null}
      {showHealthBadges && reused ? <span className="chip chip--warn">reused</span> : null}
      {showHealthBadges && weak ? <span className="chip chip--warn">weak</span> : null}
      {showHealthBadges && stale ? (
        <span className="chip chip--muted">
          <ClockIcon width="11" height="11" />
          old
        </span>
      ) : null}
      {item.needsAttention ? (
        <span className="chip chip--danger">
          <FlagIcon width="11" height="11" />
          needs attention
        </span>
      ) : null}
      {showTagChips ? <TagChips tags={tags} compact={compact} /> : null}
    </div>
  );
}

/**
 * When the login's fields last changed.
 *
 * Both stamps are set at creation, so a new login would otherwise read
 * "Password just now · Username just now" — two facts saying the same thing.
 * When they match (to the second), one "Created …" replaces both. When they
 * differ each is named after the field it actually tracks; the second one used
 * to say "Email" while tracking `usernameUpdatedAt`, which mislabels every
 * login whose username is not an address.
 */
function ModifiedNote({ item }: { item: VaultItem }) {
  const sameSecond =
    Math.floor(item.passwordUpdatedAt / 1000) === Math.floor(item.usernameUpdatedAt / 1000);
  if (sameSecond) {
    return (
      <div className="card-row__dates">
        <span title={new Date(item.passwordUpdatedAt).toLocaleString()}>
          Created {relativeTime(item.passwordUpdatedAt)}
        </span>
      </div>
    );
  }
  return (
    <div className="card-row__dates">
      <span title={new Date(item.passwordUpdatedAt).toLocaleString()}>
        Password {relativeTime(item.passwordUpdatedAt)}
      </span>
      <span title={new Date(item.usernameUpdatedAt).toLocaleString()}>
        Username {relativeTime(item.usernameUpdatedAt)}
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
  selectedIds,
  onSelectForEdit,
  gmailAccounts,
  mailScope,
  mailCache,
  onCacheMail,
  onOpenExternal,
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
      // No edge fades: the top and bottom gradients read as shadow lines baked
      // onto the first and last cards rather than as scroll hints.
      showGradients={false}
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
            data-selected={selectedIds?.has(item.id) || undefined}
            onClick={selectionClick(item, onSelectForEdit)}
            onContextMenu={(event) => onItemMenu(event, item)}
            onDoubleClick={(event) => {
              event.preventDefault();
              onEdit(item);
            }}
          >
{selected ? <div className="rb-animated-list__glow" aria-hidden="true" /> : null}
              {photo ? <div className="item__art" aria-hidden="true" /> : null}
              {photo ? <div className="card-row__scrim" aria-hidden="true" /> : null}

            <div className="card-row__head">
              {/* Image only, no site pill: the domain label is gone on purpose,
                  so the head is just the mark and the login itself. */}
              <LoginMark item={item} site={site} />

              <div className="card-row__body">
                <HealthBadges
                  item={item}
                  reused={reused}
                  stale={stale}
                  showHealthBadges={showHealthBadges}
                  tags={itemTagsFor(item)}
                  showTagChips={showTagChips}
                  secured={secured}
                />
                <div className="card-row__title">
                  {/* The site is named by its own domain rather than an icon:
                      the domain is what the user recognises, and it is already
                      stored, so nothing has to be fetched. */}
                  <span className="card-row__name">{label}</span>
                  {secured ? null : item.favorite ? (
                    <StarIcon width="13" height="13" filled style={{ color: 'var(--warn)' }} />
                  ) : null}
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
                      onCopy(item.username, 'Username', item);
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
                    onCopy(item.password, 'Password', item);
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

            {/* Delete is always available: it used to sit inside the `item.url`
                branch below, so a login with no website had no way to be
                removed from its own card. Only "Open site" needs a URL. */}
            <div className="card-row__actions-row">
              {mailFor(item, mailScope, gmailAccounts) ? (
                <LoginMessages item={item} accounts={gmailAccounts ?? []} accountScope={mailScope?.account ?? 'all'} cache={mailCache} onCacheMessages={onCacheMail} onOpenExternal={onOpenExternal} />
              ) : null}
              {item.url ? (
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
              ) : null}
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
  duplicateIds,
  showHealthBadges,
  staleDays,
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
  const secured = isSecured(current.security);

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

        {/* Badges sit above the name, matching Flow, List and Grid. */}
        <HealthBadges
          item={current}
          reused={duplicateIds.has(current.password) && current.password !== ''}
          stale={isStale(current, staleDays)}
          showHealthBadges={showHealthBadges}
          tags={itemTags}
          showTagChips={showTagChips}
          secured={secured}
        />

<div className="carousel-view__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="carousel-view__name">{labelOf(current)}</div>
          </div>
          {current.favorite ? <StarIcon width="16" height="16" filled style={{ color: 'var(--warn)' }} /> : null}
        </div>

        <div className="carousel-view__secret">
          <div className="card-row__secret-row">
            <span className="card-row__username">{current.username || hostnameOf(current.url) || 'No username'}</span>
            {current.username ? (
              <button
                className="btn btn--icon"
                aria-label="Copy username"
                onClick={() => onCopy(current.username, 'Username', current)}
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
              onClick={() => onCopy(current.password, 'Password', current)}
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
            onClick={() => onCopy(current.password, 'Password', current)}
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
  selectedIds,
  onSelectForEdit,
  gmailAccounts,
  mailScope,
  mailCache,
  onCacheMail,
  onOpenExternal,
  onEdit,
  onDelete,
  onToggleFavorite,
  onSelect,
  onItemMenu,
  onReorderLogins,
}: CommonViewProps) {
  // Ids whose password has been explicitly revealed. Everything else is masked, so
  // opening the vault never puts every credential on screen at once.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // A login with its own second factor has to clear it before its password shows.
  const [gateItem, setGateItem] = useState<VaultItem | null>(null);
  const itemTagsFor = (item: VaultItem) => tags.filter((tag) => item.tags.includes(tag.id));
  const showGroups = showLetterGroups !== false;
  const groups = showGroups ? groupByLetter(items) : [['', items] as [string, VaultItem[]]];
  // Flat render order, across letter groups, so a drop lands globally.
  const reorder = useLoginReorder(
    groups.flatMap(([, group]) => group.map((entry) => entry.id)),
    onReorderLogins,
  );

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
          <div className="list" {...reorder.listProps}>
            {group.map((item) => {
              const label = labelOf(item);
              const show = revealed.has(item.id);
              const photo = backgroundSrc(item);
              return (
          <motion.div
            layout
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            whileHover={{ y: -2 }}
            className="item"
            data-vault-item={item.id}
            data-photo={photo ? '' : undefined}
            data-selected={selectedIds?.has(item.id) || undefined}
            key={item.id}
style={{ ...itemStyle(item), ...itemBackgroundStyle(item) }}
            onContextMenu={(event) => onItemMenu(event, item)}
            onDoubleClick={(event) => {
              // Matches Flow and Orbit.
              event.preventDefault();
              onEdit(item);
            }}
            onClick={selectionClick(item, onSelectForEdit)}
            {...reorder.rowProps(item)}
          >
                  {reorder.enabled ? <DragGrip grip={reorder.gripProps(item)} /> : null}
                  {photo ? <div className="item__art" aria-hidden="true" /> : null}
                {photo ? <div className="item__scrim" aria-hidden="true" /> : null}

<button className="item__trigger" onClick={() => onSelect(item)}>
                    <LoginMark item={item} site={hostnameOf(item.url)} size={32} />
                    <span className="item__body">
                      <HealthBadges
                        item={item}
                        reused={duplicateIds.has(item.password) && item.password !== ''}
                        stale={isStale(item, staleDays)}
                        showHealthBadges={showHealthBadges}
                        tags={itemTagsFor(item)}
                        showTagChips={showTagChips}
                        secured={isSecured(item.security)}
                      />
                      <span className="item__title">
                        {label}
                        {item.favorite ? (
                          <StarIcon width="13" height="13" filled style={{ color: 'var(--warn)' }} />
                        ) : null}
                      </span>
                    </span>
                  </button>

                  <div className="item__actions">
                    {mailFor(item, mailScope, gmailAccounts) ? (
                      <LoginMessages item={item} accounts={gmailAccounts ?? []} accountScope={mailScope?.account ?? 'all'} cache={mailCache} onCacheMessages={onCacheMail} onOpenExternal={onOpenExternal} />
                    ) : null}
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
                </motion.div>
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

/* ==========================================================================
   View 4 — Grid
   ========================================================================== */

/**
 * A responsive grid of login cards.
 *
 * Columns are not a stored preference. The track is `auto-fill` against a cap
 * derived from the width slider, so the card count follows the window instead of
 * a number the user has to revisit every time they resize it. That is the whole
 * difference from Flow: same cards, same controls, no scroll animation, and a
 * whole screen of them at once.
 *
 * Deliberately does not group by letter. Grouping exists to make a long single
 * column navigable; in a grid the eye scans spatially instead, so the headings
 * would add structure the layout no longer needs.
 */
export function GridView({
  items,
  duplicateIds,
  showHealthBadges,
  staleDays,
  showTagChips,
  tags,
  cardSize,
  selectedIds,
  onSelectForEdit,
  gmailAccounts,
  mailScope,
  mailCache,
  onCacheMail,
  onOpenExternal,
  onEdit,
  onDelete,
  onToggleFavorite,
  onToggleAttention,
  onCopy,
  onSelect,
  onItemMenu,
  onReorderLogins,
}: CommonViewProps) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [gateItem, setGateItem] = useState<VaultItem | null>(null);
  const itemTagsFor = (item: VaultItem) => tags.filter((tag) => item.tags.includes(tag.id));
  const reorder = useLoginReorder(
    items.map((entry) => entry.id),
    onReorderLogins,
  );

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
    <div
      className="content__inner grid-scale"
      style={
        {
          '--card-scale': String(cardSize.scale),
          '--card-surface': String(cardSize.surface),
          '--card-radius': `${cardSize.radius}px`,
          // The width slider is the widest one cell may become. The track keeps
          // filling the pane below that, so shrinking the window narrows the
          // cards and then the column count follows on its own.
          '--card-max': `${Math.round(cardSize.width)}px`,
          '--card-min-height': `${Math.round(cardSize.minHeight)}px`,
        } as React.CSSProperties
      }
    >
      <div className="grid" {...reorder.listProps}>
        {items.map((item) => {
          const label = labelOf(item);
          const show = revealed.has(item.id);
          const photo = backgroundSrc(item);
          const secured = isSecured(item.security);
          return (
          <motion.div
            layout
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            whileHover={{ y: -2 }}
            key={item.id}
            className="grid-cell"
            data-vault-item={item.id}
            data-photo={photo ? '' : undefined}
            data-flagged={item.needsAttention || undefined}
            data-selected={selectedIds?.has(item.id) || undefined}
            style={{ ...itemStyle(item), ...itemBackgroundStyle(item) }}
            onClick={selectionClick(item, onSelectForEdit)}
            onContextMenu={(event) => onItemMenu(event, item)}
              onDoubleClick={(event) => {
                event.preventDefault();
                onEdit(item);
              }}
            {...reorder.rowProps(item)}
            >
              {reorder.enabled ? <DragGrip grip={reorder.gripProps(item)} /> : null}
              {photo ? <div className="item__art" aria-hidden="true" /> : null}
              {photo ? <div className="card-row__scrim" aria-hidden="true" /> : null}

              <div className="grid-cell__head">
                <LoginMark item={item} site={hostnameOf(item.url)} />
              </div>

              <div className="grid-cell__body">
                <HealthBadges
                  item={item}
                  reused={duplicateIds.has(item.password) && item.password !== ''}
                  stale={isStale(item, staleDays)}
                  showHealthBadges={showHealthBadges}
                  tags={itemTagsFor(item)}
                  showTagChips={showTagChips}
                  compact
                  secured={secured}
                />
                <div className="grid-cell__title">
                  <span className="card-row__name">{label}</span>
                  {!secured && item.favorite ? (
                    <StarIcon width="13" height="13" filled style={{ color: 'var(--warn)' }} />
                  ) : null}
                </div>
                <div className="grid-cell__meta">
                  <span className="card-row__username">
                    {item.username || hostnameOf(item.url) || 'No username'}
                  </span>
                </div>
                {/* A cell is a summary, not a document, but clicking the body
                    should still do the thing a click does everywhere else. */}
                <button
                  type="button"
                  className="grid-cell__open"
                  aria-label={`Open ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(item);
                  }}
                />
              </div>

              {/* Same credential block as Flow: the eye in the action row below
                  toggles `revealed`, and without this block it toggled nothing
                  visible — the button flipped state and the card did not move. */}
              <div className="card-row__secret grid-cell__secret">
                <div className="card-row__secret-row">
                  <span className="card-row__username">
                    {item.username || hostnameOf(item.url) || 'No username'}
                  </span>
                  {item.username ? (
                    <button
                      className="btn btn--icon"
                      aria-label="Copy username"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCopy(item.username, 'Username', item);
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
                      onCopy(item.password, 'Password', item);
                    }}
                  >
                    <CopyIcon />
                  </button>
                </div>
              </div>

              <div className="grid-cell__actions">
                {mailFor(item, mailScope, gmailAccounts) ? (
                  <LoginMessages item={item} accounts={gmailAccounts ?? []} accountScope={mailScope?.account ?? 'all'} cache={mailCache} onCacheMessages={onCacheMail} onOpenExternal={onOpenExternal} />
                ) : null}
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
                  <FlagIcon />
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
                  aria-label="Edit login"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(item);
                  }}
                >
                  <EditIcon />
                </button>
                <button
                  className="btn btn--icon"
                  aria-label="Delete login"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(item);
                  }}
                >
                  <TrashIcon />
                </button>
                <button
                  className="btn btn--icon"
                  data-action="password"
                  data-active={show || undefined}
                  aria-label={show ? 'Hide password' : 'Reveal password'}
                  aria-pressed={show}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(item.id);
                  }}
                >
                  {show ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </motion.div>
          );
        })}
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
    </div>
  );
}

/**
 * The second-factor badge, shared by every view so it reads identically
 * wherever it appears.
 *
 * It used to be a bare glyph floating above the card's top edge, clipped in
 * half by the container, at the same 15px as the icons beside it. Sitting on the
 * edge it read as a rendering artefact rather than a status, and at that size
 * the shield's inner detail was too fine to identify at a glance. It is now a
 * pill in the card's own top corner, which keeps it fully inside the card, gives
 * it room for a legible glyph, and pairs the glyph with the word so the meaning
 * does not depend on recognising an icon.
 */
export function SecuredBadge({ secured, compact = false, inline = false }: { secured: boolean; compact?: boolean; inline?: boolean }) {
  if (!secured) return null;
  return (
    <span className={inline ? 'secured-badge secured-badge--inline' : 'secured-badge'} data-compact={compact || undefined}>
      <KeyShieldIcon width={13} height={13} />
      {!compact ? <span className="secured-badge__text">2FA</span> : null}
    </span>
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
