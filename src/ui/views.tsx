import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AnimatedList } from '../components/react-bits/AnimatedList.tsx';
import { CircularCarousel, type CarouselItem } from '../components/react-bits/CircularCarousel.tsx';
import { avatarSrc, backgroundSrc, itemBackgroundStyle, itemStyle, toCarouselItems } from './card-art.ts';
import { EmptyState } from './primitives.tsx';
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  DotsIcon,
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
import { accentOf, hostnameOf, isWeakPassword, relativeTime, staleDaysFor, type VaultItem } from '../vault/types.ts';
import { isSecured } from '../crypto/security.ts';
import type { CachedMailMessage, CardSizePrefs, GmailAccount } from '../vault/storage.ts';
import type { GmailMessage } from './useGmail.ts';
import { SecurityGate } from './SecurityGate.tsx';
import { LoginMessages } from './LoginMessages.tsx';
import type { Tag } from '../vault/channels.ts';


/** `days` of 0 switches the stale check off entirely. */
function isStale(item: VaultItem, days: number): boolean {
  const effective = staleDaysFor(item, days);
  if (effective <= 0) return false;
  return Date.now() - item.passwordUpdatedAt > effective * 86_400_000;
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
   * the custom drag order. Offered by Flow, List and Grid (press and hold a
   * login, then move); Orbit follows the custom order through sorting but
   * starts no drags itself. Absent means no reordering here.
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
 * Login drag-reorder shared by the Flow, List and Grid views.
 *
 * No grip and no HTML5 backend: press and hold anywhere on a login except its
 * buttons, then move. The short hold is what keeps this from fighting clicks
 * and text selection — quick presses behave exactly as before, selection is
 * locked off from the hold until release, and pressing a button disarms the
 * row, so controls never drag. Past the hold, the pointer is captured, a
 * ghost follows it, the row underneath gets a before/after indicator, list
 * edges auto-scroll, and release commits. Rows render as
 * motion `layout` elements upstream, so the reorder animates smoothly instead
 * of snapping. (HTML5 dragging was tried first and dropped: flipping the
 * `draggable` attribute mid-gesture is timing-sensitive per engine, while
 * pointer capture behaves the same everywhere.)
 */
function useLoginReorder(
  flatIds: string[],
  onReorder?: (activeId: string, toIndex: number, flatIds: string[]) => void,
  /**
   * Grid only: cells sit side by side, so the slot reads both axes (below the
   * middle band inserts after; inside the band, left/right decides) instead of
   * the single vertical half a list row uses.
   */
  twoDimensional = false,
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const armTimer = useRef<number>(0);
  const pending = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragging = useRef<string | null>(null);
  const ghost = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  const enabled = typeof onReorder === 'function';
  // The drop slot aimed at, mirrored for the pointer-up handler.
  const overRef = useRef<{ id: string; after: boolean } | null>(null);
  overRef.current = over;
  // Armed row, mirrored: the move handler must see the hold even if it fires
  // before the re-render that flips the state.
  const armedRef = useRef<string | null>(null);
  // Latest props for the window-level backstop below.
  const liveRef = useRef({ flatIds, onReorder });
  liveRef.current.flatIds = flatIds;
  liveRef.current.onReorder = onReorder;

  /** How long a press must held before it arms a drag. Short enough to feel
      instant, long enough that clicks and text selection win the race. */
  const HOLD_MS = 120;

  /** While armed or dragging, nothing on screen may start a text selection. */
  const setReordering = (on: boolean) => {
    document.body.classList.toggle('is-reordering', on);
  };

  useEffect(
    () => () => {
      if (armTimer.current) window.clearTimeout(armTimer.current);
      ghost.current?.remove();
      ghost.current = null;
      document.body.classList.remove('is-reordering');
    },
    [],
  );

  const killGhost = () => {
    ghost.current?.remove();
    ghost.current = null;
  };

  const disarm = () => {
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = 0;
    }
    pending.current = null;
    armedRef.current = null;
    setArmedId(null);
    setReordering(false);
  };

  // Commits (or cancels) an in-flight drag. Shared by the row's own pointer-up
  // and the window backstop, so a release the row never sees — off-window,
  // capture lost — still ends the drag instead of stranding a ghost. First
  // finisher wins: whoever runs first clears `dragging`, the other sees null.
  const finishDrag = (commit: boolean) => {
    const active = dragging.current;
    dragging.current = null;
    killGhost();
    pending.current = null;
    armedRef.current = null;
    setDragId(null);
    setArmedId(null);
    setOver(null);
    setReordering(false);
    if (!commit || !active) return;
    const slot = overRef.current;
    overRef.current = null;
    // The click that follows a real drop is swallowed by onClickCapture, so
    // dropping never also opens the login.
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 400);
    const { onReorder, flatIds } = liveRef.current;
    if (!onReorder || !slot || active === slot.id) return;
    const rest = flatIds.filter((id) => id !== active);
    const ti = rest.indexOf(slot.id);
    onReorder(active, ti === -1 ? rest.length : ti + (slot.after ? 1 : 0), flatIds);
  };

  const cancelDrag = () => {
    dragging.current = null;
    pending.current = null;
    killGhost();
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = 0;
    }
    armedRef.current = null;
    setDragId(null);
    setArmedId(null);
    setOver(null);
    setReordering(false);
  };

  // Backstop: releases and interruptions the row itself never hears must still
  // end the drag. Without this an off-window release left a ghost behind that
  // looked exactly like a duplicated login — and a press abandoned off-row
  // left a stale armed ring behind.
  useEffect(() => {
    const onUp = () => {
      if (dragging.current) finishDrag(true);
      else disarm();
    };
    const onCancel = () => {
      if (dragging.current || pending.current) cancelDrag();
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
    // finishDrag/cancelDrag only touch refs and setState: safe to hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markOver = (id: string | null, after: boolean) => {
    setOver((current) => {
      if (id === null) return current === null ? current : null;
      return current && current.id === id && current.after === after ? current : { id, after };
    });
  };

  const slotOf = (id: string, x: number, y: number, rect: DOMRect): { id: string; after: boolean } => {
    if (!twoDimensional) return { id, after: y - rect.top > rect.height / 2 };
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    return { id, after: dy > rect.height / 4 || (Math.abs(dy) <= rect.height / 4 && dx > 0) };
  };

  const rowProps = (item: VaultItem) => ({
    'data-armed': enabled && armedId === item.id && dragId !== item.id ? '' : undefined,
    'data-dragging': dragId === item.id ? '' : undefined,
    'data-drop-before': over?.id === item.id && !over.after ? '' : undefined,
    'data-drop-after': over?.id === item.id && over.after ? '' : undefined,
    onPointerDown: (event: React.PointerEvent) => {
      // A fresh gesture clears yesterday's click suppression first.
      suppressClick.current = false;
      if (!enabled || event.button !== 0) return;
      // Buttons and fields opt out: pressing them disarms, so they never drag.
      // The grid's body proxy (.grid-cell__open) is the exception — it stands
      // in for the card body, so holding it must still arm or grid dragging
      // could never start at all.
      if (
        (event.target as HTMLElement).closest(
          'button:not(.grid-cell__open), a, input, textarea, select, [contenteditable="true"]',
        )
      ) {
        disarm();
        return;
      }
      pending.current = { id: item.id, x: event.clientX, y: event.clientY };
      if (armTimer.current) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = 0;
        armedRef.current = item.id;
        setArmedId(item.id);
        // From here until release, selection is off: holding must never
        // select text and drag at once.
        setReordering(true);
      }, HOLD_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (!enabled) return;
      // Already dragging: track the pointer, wherever it roams.
      if (dragging.current) {
        const row = (event.currentTarget as HTMLElement).closest('[data-vault-item]') as HTMLElement | null;
      if (ghost.current && row) {
        // Bounding rect, not offsetWidth: the views zoom their cards, and
        // offsetWidth reports unzoomed layout pixels while the pointer speaks
        // viewport pixels — mixing them sizes the ghost wrong at any scale.
        ghost.current.style.width = `${row.getBoundingClientRect().width}px`;
        ghost.current.style.transform = `translate(${event.clientX - 24}px, ${event.clientY - 20}px)`;
      }
        // Edge auto-scroll so long lists stay reachable mid-drag.
        const box = scroller.current;
        if (box && box.scrollHeight > box.clientHeight + 4) {
          const rect = box.getBoundingClientRect();
          if (event.clientY < rect.top + 56) box.scrollBy({ top: -10 });
          else if (event.clientY > rect.bottom - 56) box.scrollBy({ top: 10 });
        }
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const target = hit?.closest?.('[data-vault-item]');
        const id = target?.getAttribute?.('data-vault-item') ?? null;
        if (!id || id === dragging.current) {
          markOver(null, false);
          return;
        }
        const rect = (target as HTMLElement).getBoundingClientRect();
        markOver(id, event.clientY - rect.top > rect.height / 2);
        return;
      }
      const press = pending.current;
      if (!press) return;
      // Barely moved and not held yet: still a potential click or text
      // selection — native behavior proceeds untouched.
      if (press.id === item.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) return;
      // Moved before the hold elapsed: an ordinary gesture, never a drag.
      if (armedRef.current !== press.id) {
        disarm();
        return;
      }
      // Held, now moving: dragging. Capture keeps every later move coming to
      // this row even when the pointer outruns it.
      dragging.current = press.id;
      pending.current = null;
      setDragId(press.id);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a convenience; the moves still arrive without it.
      }
      const row = (event.currentTarget as HTMLElement).closest('[data-vault-item]') as HTMLElement | null;
      scroller.current = row?.closest(
        '.rb-animated-list__scroll, .content, .modal__body',
      ) as HTMLElement | null;
      if (row) {
        const clone = row.cloneNode(true) as HTMLElement;
        clone.removeAttribute('id');
        clone.style.cssText +=
          ';position:fixed;left:0;top:0;z-index:200;pointer-events:none;opacity:.88;margin:0;';
        document.body.appendChild(clone);
        ghost.current = clone;
        ghost.current.style.width = `${row.getBoundingClientRect().width}px`;
        ghost.current.style.transform = `translate(${event.clientX - 24}px, ${event.clientY - 20}px)`;
      }
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest?.('[data-vault-item]');
      const id = target?.getAttribute?.('data-vault-item') ?? null;
      if (!id || id === dragging.current) {
        markOver(null, false);
        return;
      }
      const slot = slotOf(id, event.clientX, event.clientY, (target as HTMLElement).getBoundingClientRect());
      markOver(slot.id, slot.after);
    },
    onPointerUp: () => {
      if (armTimer.current) {
        window.clearTimeout(armTimer.current);
        armTimer.current = 0;
      }
      pending.current = null;
      // A drag in flight commits here; the window backstop covers releases
      // this row never hears. A plain press just disarms for the click.
      if (dragging.current) finishDrag(true);
      else setArmedId(null);
    },
    onPointerCancel: () => cancelDrag(),
    // Swallows the click that follows a drop. Capture phase, so the card's
    // own open/selection handlers never see it.
    onClickCapture: (event: React.SyntheticEvent) => {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return { enabled, dragId, rowProps };
}

/**
 * The open fast path for a card's click proxy (list trigger, grid overlay).
 *
 * A plain click opens; a click with Ctrl/Cmd/Shift does nothing here and
 * bubbles to the row's selection handler instead. Without the guard, a
 * modifier-click both opened the login AND selected it, and in the grid —
 * whose overlay stops everything — selection by click was impossible at all.
 */
function openClick(
  item: VaultItem,
  onSelect: (item: VaultItem) => void,
): (event: React.MouseEvent) => void {
  return (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.stopPropagation();
    onSelect(item);
  };
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
  onSelect,
  onItemMenu,
  onReorderLogins,
  tags,
}: CommonViewProps) {
  // Ids whose password has been explicitly revealed. Everything else is masked, so
  // opening the vault never puts every credential on screen at once.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // A login with its own second factor has to clear it before its password shows.
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
      // Vault selection lives on the wrapper (which owns the visible border),
      // not on the inner card — one border, drawn where the border is.
      rowProps={(item) => ({
        ...reorder.rowProps(item),
        'data-selected': selectedIds?.has(item.id) ? '' : undefined,
      })}
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
                  data-action="edit"
                  aria-label="Edit login"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(item);
                  }}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className="btn btn--icon"
                  aria-label={`More actions for ${label}`}
                  title="More actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    onItemMenu(event, item);
                  }}
                >
                  <DotsIcon />
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
                {/* No copy button here on purpose: the labelled Copy below is
                    the one obvious copy, and a second one for the same field
                    is exactly the duplication to avoid. */}
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

            {/* One obvious primary (Copy) plus the overflow menu: Open site,
                Delete, favorite and attention all live one click deeper in
                the card menu instead of competing as icons. */}
            <div className="card-row__actions-row">
              {mailFor(item, mailScope, gmailAccounts) ? (
                <LoginMessages item={item} accounts={gmailAccounts ?? []} accountScope={mailScope?.account ?? 'all'} cache={mailCache} onCacheMessages={onCacheMail} onOpenExternal={onOpenExternal} />
              ) : null}
              {item.password ? (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopy(item.password, 'Password', item);
                  }}
                >
                  <CopyIcon width="13" height="13" />
                  Copy
                </button>
              ) : null}
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
  onCopy,
  onEdit,
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
          <div className="list">
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
                  {photo ? <div className="item__art" aria-hidden="true" /> : null}
                {photo ? <div className="item__scrim" aria-hidden="true" /> : null}

<button className="item__trigger" onClick={openClick(item, onSelect)}>
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
                    {item.password ? (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCopy(item.password, 'Password', item);
                        }}
                      >
                        <CopyIcon width="13" height="13" />
                        Copy
                      </button>
                    ) : null}
                    <button className="btn btn--icon" aria-label="Edit login" onClick={() => onEdit(item)}>
                      <EditIcon />
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
                    <button
                      type="button"
                      className="btn btn--icon"
                      aria-label={`More actions for ${label}`}
                      title="More actions"
                      onClick={(event) => {
                        event.stopPropagation();
                        onItemMenu(event, item);
                      }}
                    >
                      <DotsIcon />
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
    // Cells sit side by side: drop slots read both axes.
    true,
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
      <div className="grid">
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
                {/* The site only: the username already lives in the credential
                    block below, and showing it twice is what the meta line did. */}
                {hostnameOf(item.url) ? (
                  <div className="grid-cell__meta">
                    <span className="card-row__username">{hostnameOf(item.url)}</span>
                  </div>
                ) : null}
                {/* A cell is a summary, not a document, but clicking the body
                    should still do the thing a click does everywhere else. */}
                <button
                  type="button"
                  className="grid-cell__open"
                  aria-label={`Open ${label}`}
                  onClick={openClick(item, onSelect)}
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
                <button
                  type="button"
                  className="btn btn--icon"
                  aria-label={`More actions for ${label}`}
                  title="More actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    onItemMenu(event, item);
                  }}
                >
                  <DotsIcon />
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

/**
 * Actionable security summary for the weak channel: what is wrong and a
 * Select-all path straight into bulk review, instead of a bare filter plus
 * badges. Informative by the numbers, not by painting cards red.
 */
export function WeakSummary({
  total,
  reused,
  stale,
  onSelectAll,
}: {
  total: number;
  reused: number;
  stale: number;
  onSelectAll: () => void;
}) {
  return (
    <div className="weak-strip" role="note">
      <span className="weak-strip__text">
        <b>
          {total} to review
        </b>{' '}
        — {reused} reused · {stale} stale. Select them all, then right-click for bulk actions.
      </span>
      <button type="button" className="btn btn--secondary btn--sm" onClick={onSelectAll}>
        Select all {total}
      </button>
    </div>
  );
}

export function ViewEmptyState({
  query,
  screen,
  onAdd,
  onSearchAll,
}: {
  query: string;
  screen: string;
  onAdd: () => void;
  /** Offered when a channel-scoped search finds nothing. */
  onSearchAll?: (() => void) | null;
}) {
  const title = query
    ? 'No matches'
    : screen === 'favorites'
      ? 'No favorites yet'
      : screen === 'weak'
        ? 'Nothing needs attention'
        : 'Your vault is empty';

  const text = query
    ? `Nothing matches "${query}" here. Try a different search.`
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
        ) : query && onSearchAll ? (
          <button className="btn btn--secondary" onClick={onSearchAll}>
            Search entire vault
          </button>
        ) : undefined
      }
    />
  );
}
