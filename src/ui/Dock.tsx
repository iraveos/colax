/**
 * Quick-launch dock: the four views plus the inbox, one keypress away.
 *
 * A fixed bar at the bottom of the vault screen. Each slot shows its glyph, a
 * key badge, and the active state; clicking jumps, and pressing the slot's key
 * jumps without the pointer. The inbox slot selects the dashboard channel,
 * which is where connected-mail messages already render.
 *
 * Keys are bare single characters (no modifier) matched only when `guard`
 * allows — no text field focused, no menu, dialog, editor or settings open. A
 * bare-key shortcut that fires while typing an email address is not fast, it
 * is data loss, so the guard is the feature as much as the keys.
 */

import { useEffect, useRef, useState } from 'react';
import type { ComponentType, MouseEvent as ReactMouseEvent } from 'react';
import type { DockPlacement, DockPosition } from '../vault/storage.ts';

export interface DockSlot {
  id: string;
  label: string;
  hint: string;
  Icon: ComponentType<{ width?: number | string; height?: number | string }>;
  /** Uploaded or remote image overriding the glyph, when the user set one. */
  imageUrl?: string;
  /** Channel/folder hue, for the signature dot on navigation slots. */
  hue?: number;
  /** The key that jumps here, as shown on the badge. */
  key: string;
  active: boolean;
  onJump: () => void;
}

/**
 * Which family a slot belongs to, read off its `kind:ref` id. Families render
 * separated by dividers, so views, navigation, logins and mailboxes read as
 * groups rather than one undifferentiated row.
 */
function slotFamily(id: string): string {
  const kind = id.split(':')[0];
  if (kind === 'view') return 'views';
  if (kind === 'login') return 'logins';
  if (kind === 'mailbox') return 'mail';
  return 'go';
}

/**
 * Which screen edge the pointer is nearest to, for snap-to-edge dragging.
 * Corners resolve to the nearer edge rather than refusing, so dropping in a
 * corner still lands somewhere predictable.
 */
function edgeAt(x: number, y: number): DockPosition {
  const distances = {
    left: x,
    right: window.innerWidth - x,
    top: y,
    bottom: window.innerHeight - y,
  };
  let best: DockPosition = 'bottom';
  let bestValue = Infinity;
  for (const [edge, value] of Object.entries(distances)) {
    if (value < bestValue) {
      bestValue = value;
      best = edge as DockPosition;
    }
  }
  return best;
}

export function Dock({
  slots,
  pos,
  onPosChange,
  onMenu,
  onSlotMenu,
}: {
  slots: DockSlot[];
  pos: DockPlacement;
  onPosChange: (next: DockPlacement) => void;
  /** Right-click: the dock's own settings menu. */
  onMenu: (event: ReactMouseEvent) => void;
  /** Right-click on one slot: its own menu (customize, …). */
  onSlotMenu?: (event: ReactMouseEvent, slotId: string) => void;
}) {
  // Free placement: press anywhere on the bar's chrome and the bar follows the
  // pointer live; release drops it exactly there, clamped on screen. The
  // nearest edge only decides row-vs-column orientation, never the spot. A
  // press without movement is not a drag, so slot clicks are unaffected — the
  // threshold is what keeps the two gestures from fighting. Moves are folded
  // through one rAF slot, so a fast pointer cannot queue more position writes
  // than frames can paint (that backlog was the visible lag).
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const raf = useRef(0);
  const clamp01 = (value: number) => Math.min(0.94, Math.max(0.06, value));
  // Free placement: the bar sits exactly where it was dropped, centred on the
  // pointer. The snapped edge only decides row-vs-column orientation, never
  // pins the bar to a margin — every dock roams the whole screen.

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const moveTo = (x: number, y: number) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      onPosChange({ edge: edgeAt(x, y), fx: clamp01(x / window.innerWidth), fy: clamp01(y / window.innerHeight) });
    });
  };

  const endDrag = () => {
    dragFrom.current = null;
    dragging.current = false;
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    }
  };

  return (
    <nav
      className="dock"
      data-edge={pos.edge}
      aria-label="Quick launch"
      style={{
        left: `${pos.fx * 100}%`,
        top: `${pos.fy * 100}%`,
        translate: '-50% -50%',
      } as React.CSSProperties}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event);
      }}
      onPointerDown={(event) => {
        // Slot buttons own their own press; the bar only tracks drags that
        // start on chrome (grip or gaps), never on a button.
        if ((event.target as HTMLElement).closest('button')) return;
        // Capture keeps move/up events coming to the bar even when the pointer
        // outruns it mid-drag.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Older engines drag fine without capture; release still lands.
        }
        dragFrom.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const from = dragFrom.current;
        if (!from) return;
        // Below the threshold this is still a click, not a drag.
        if (!dragging.current && Math.hypot(event.clientX - from.x, event.clientY - from.y) < 6) return;
        dragging.current = true;
        moveTo(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        const from = dragFrom.current;
        const wasDrag = dragging.current;
        endDrag();
        // A press without movement is a click on chrome, not a drag: no write.
        if (!from || !wasDrag) return;
        const fx = clamp01(event.clientX / window.innerWidth);
        const fy = clamp01(event.clientY / window.innerHeight);
        onPosChange({ edge: edgeAt(event.clientX, event.clientY), fx, fy });
      }}
      onPointerCancel={endDrag}
    >
      {slots.flatMap((slot, index) => {
        const Icon = slot.Icon;
        const divider =
          index > 0 && slotFamily(slots[index - 1]!.id) !== slotFamily(slot.id) ? (
            <span key={`${slot.id}__div`} className="dock__div" aria-hidden="true" />
          ) : null;
        return [
          divider,
          <button
            key={slot.id}
            type="button"
            className="dock__slot"
            aria-pressed={slot.active}
            title={`${slot.label} (${slot.key}) — ${slot.hint}`}
            onClick={slot.onJump}
            onContextMenu={
              onSlotMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSlotMenu(event, slot.id);
                  }
                : undefined
            }
          >
            {typeof slot.hue === 'number' ? (
              <span
                className="dock__dot"
                aria-hidden="true"
                style={{ background: `hsl(${slot.hue} 55% 60%)` }}
              />
            ) : null}
            {slot.imageUrl ? (
              <img className="dock__image" src={slot.imageUrl} alt="" aria-hidden="true" draggable={false} />
            ) : (
              <Icon width="17" height="17" />
            )}
            <span className="dock__label">{slot.label}</span>
          </button>,
        ];
      })}
    </nav>
  );
}

/**
 * Records one dock key: click, then press the key.
 *
 * Only single printable characters are accepted — chords belong to the global
 * hotkeys, not to bare-key jumps. Escape cancels. A key already used by another
 * slot is refused rather than stolen, so two slots can never fight over one press.
 */
export function KeyRecorder({
  value,
  taken,
  onRecord,
  onError,
}: {
  value: string;
  taken: string[];
  onRecord: (key: string) => void;
  onError: (message: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="segmented__option key-recorder"
      data-armed={armed || undefined}
      onClick={() => setArmed(true)}
      onKeyDown={(event) => {
        if (!armed) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          setArmed(false);
          return;
        }
        // Modifiers, navigation and function keys are not single characters;
        // accepting them would create a shortcut that can never fire.
        if (event.key.length !== 1) {
          onError('Press a single letter, digit or symbol — not a modifier or function key.');
          return;
        }
        if (taken.some((other) => other.toLowerCase() === event.key.toLowerCase())) {
          onError(`“${event.key}” already jumps somewhere else.`);
          return;
        }
        setArmed(false);
        onRecord(event.key);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? 'Press a key…' : <kbd className="kbd">{value}</kbd>}
    </button>
  );
}

/**
 * Fires a slot jump when its key is pressed bare.
 *
 * Modifiers are excluded outright: Ctrl/Alt/Meta combinations belong to the
 * global hotkeys, and mixing the two systems on one key is how shortcuts get
 * claimed twice. Comparison is case-insensitive for letters so Caps Lock does
 * not silently disable the dock.
 */
export function useDockShortcuts(slots: DockSlot[], guard: () => boolean): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1) return;
      if (!guard()) return;
      const slot = slots.find((entry) => entry.key.toLowerCase() === event.key.toLowerCase());
      if (!slot) return;
      event.preventDefault();
      slot.onJump();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [slots, guard]);
}
