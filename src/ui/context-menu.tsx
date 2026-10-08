/**
 * Cascading right-click menu.
 *
 * One root layer plus one layer per open submenu. Arrows move, Right/Left enter and
 * leave submenus, Escape closes one level at a time, and type-ahead jumps to a
 * matching label.
 *
 * Two things this gets right that a naive implementation does not:
 *
 * - Opening a submenu closes its siblings. Without that, hovering across a list of
 *   submenus leaves every one of them stacked on top of each other.
 * - Submenus are anchored to the measured viewport rect of the row that owns them,
 *   not to an assumed row height. Separators and headings are different heights, so
 *   arithmetic drifts and the panel ends up beside the wrong row.
 */

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | {
      kind: 'item';
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      onSelect?: () => void;
    }
  | { kind: 'separator' }
  | {
      kind: 'submenu';
      label: string;
      icon?: ReactNode;
      items: MenuItem[];
      disabled?: boolean;
      /**
       * Rendered as a non-interactive header inside the submenu. Without it a
       * "Switch view" and a "Sort by" submenu are visually identical, so an open
       * panel gives no clue what is being changed.
       */
      heading?: string;
    };

const MENU_WIDTH = 232;
const SUBMENU_WIDTH = 224;
const MARGIN = 8;
/** Fallback row height, only used before a row has been measured. */
const ROW_HEIGHT = 34;
const HEADING_HEIGHT = 26;
/** Assumed height for a submenu before it has been measured. */
const ESTIMATED_SUBMENU = 200;

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

/** Viewport rect of a row, used to anchor the submenu it owns. */
interface Anchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Places the root layer, flipping it back inside the viewport if it would clip. */
function placeRoot(x: number, y: number, width: number, height: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: x + width + MARGIN > vw ? Math.max(MARGIN, x - width - MARGIN) : x,
    top: y + height + MARGIN > vh ? Math.max(MARGIN, vh - height - MARGIN) : y,
  };
}

/**
 * Places a submenu against its anchor row.
 *
 * Opens to the right of the row, or to the left when there is no room, and slides
 * up when it would run past the bottom.
 */
function placeSubmenu(anchor: Anchor, width: number, height: number, heading: boolean) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchor.right - 6;
  if (left + width + MARGIN > vw) left = Math.max(MARGIN, anchor.left - width + 6);

  // Line the first selectable row up with the row that owns the submenu, so the
  // heading sits just above it rather than pushing the list out of line.
  let top = anchor.top - (heading ? HEADING_HEIGHT : 0);
  if (top + height + MARGIN > vh) top = Math.max(MARGIN, vh - height - MARGIN);

  return { left, top };
}

interface MenuLayerProps {
  items: MenuItem[];
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Optional non-interactive title shown above the rows in a submenu. */
  heading?: string;
  /** Root layer only; submenus are placed against their anchor row. */
  anchor?: Anchor;
  isRoot?: boolean;
  onClose: () => void;
  onSubmenuToggle: (path: number[], open: boolean) => void;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  /** Publishes each submenu row's rect so the next layer can be anchored to it. */
  onAnchors: (depth: number, anchors: (Anchor | null)[]) => void;
}

function MenuLayer({
  items,
  x,
  y,
  width,
  depth,
  heading,
  anchor,
  isRoot,
  onClose,
  onSubmenuToggle,
  activeIndex,
  onActiveIndex,
  onAnchors,
}: MenuLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (!ref.current) return;
    setHeight(ref.current.offsetHeight);
    onAnchors(
      depth,
      rows.current.map((row) => {
        if (!row) return null;
        const box = row.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      }),
    );
  });

  // Reset the highlight whenever the layer changes. The callback is held in a ref
  // because it is a fresh closure on every render of the parent; depending on it
  // directly would re-run this effect each render, and since the parent always
  // produced a new state object that turned into an infinite update loop.
  const onActiveIndexRef = useRef(onActiveIndex);
  onActiveIndexRef.current = onActiveIndex;
  useEffect(() => {
    onActiveIndexRef.current(-1);
  }, [depth]);

  const style = isRoot
    ? placeRoot(x, y, width, height || 260)
    : placeSubmenu(anchor ?? { top: y, bottom: y, left: x, right: x + width }, width, height || ESTIMATED_SUBMENU, Boolean(heading));

  return (
    <motion.div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-orientation="vertical"
      data-depth={depth}
      style={{ left: style.left, top: style.top, width, ['--ctx-depth' as string]: depth }}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.08 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {heading ? (
        <div className="ctx-menu__heading" role="presentation">
          {heading}
        </div>
      ) : null}
      {items.map((item, index) => {
        if (item.kind === 'separator') {
          return <div className="ctx-menu__separator" key={`sep-${index}`} role="separator" />;
        }

        const disabled = Boolean('disabled' in item && item.disabled);
        const isActive = activeIndex === index;

        if (item.kind === 'submenu') {
          return (
            <button
              key={item.label}
              ref={(node) => {
                rows.current[index] = node;
              }}
              type="button"
              role="menuitem"
              className="ctx-menu__row"
              aria-haspopup="menu"
              aria-expanded={isActive}
              aria-disabled={disabled || undefined}
              data-active={isActive || undefined}
              onMouseEnter={() => {
                onActiveIndex(index);
                if (!disabled) onSubmenuToggle([index], true);
              }}
              // Idempotent: hover has usually already opened this, so toggling here
              // would close the submenu the pointer is still inside.
              onClick={() => {
                if (!disabled) onSubmenuToggle([index], true);
              }}
            >
              {item.icon ? <span className="ctx-menu__icon">{item.icon}</span> : null}
              <span className="ctx-menu__label">{item.label}</span>
              <span className="ctx-menu__arrow" aria-hidden="true">
                <ArrowIcon />
              </span>
            </button>
          );
        }

        return (
          <button
            key={item.label}
            ref={(node) => {
              rows.current[index] = node;
            }}
            type="button"
            role="menuitemradio"
            className="ctx-menu__row"
            data-danger={item.danger || undefined}
            data-active={isActive || undefined}
            aria-disabled={disabled || undefined}
            aria-checked={item.checked ?? false}
            onMouseEnter={() => onActiveIndex(index)}
            onClick={() => {
              if (disabled) return;
              item.onSelect?.();
              onClose();
            }}
          >
            {item.icon ? (
              <span className="ctx-menu__icon">{item.icon}</span>
            ) : item.checked !== undefined ? (
              <span className="ctx-menu__icon">{item.checked ? <CheckIcon /> : null}</span>
            ) : null}
            <span className="ctx-menu__label">{item.label}</span>
            {item.shortcut ? <span className="ctx-menu__shortcut">{item.shortcut}</span> : null}
          </button>
        );
      })}
    </motion.div>
  );
}

/**
 * Every topbar / sidebar / dock button that can be hidden by right-click.
 *
 * One table so the hide menus (built wherever the button lives) and the
 * Settings › Hidden tab (which brings them back) cannot disagree about what
 * exists or what it is called.
 */
export type ChromeElementId =
  | 'new-login'
  | 'bulk-add'
  | 'dock'
  | 'sidebar-add'
  | 'footer-settings'
  | 'footer-lock'
  | 'footer-shortcuts'
  | 'footer-compact'
  | 'footer-hide';

export const CHROME_ELEMENTS: Record<ChromeElementId, { label: string; where: string }> = {
  'new-login': { label: 'New login button', where: 'Topbar' },
  'bulk-add': { label: 'Bulk add button', where: 'Topbar' },
  dock: { label: 'Quick-launch dock', where: 'Floating bar' },
  'sidebar-add': { label: 'New channel button', where: 'Sidebar' },
  'footer-settings': { label: 'Settings button', where: 'Sidebar footer' },
  'footer-lock': { label: 'Lock button', where: 'Sidebar footer' },
  'footer-shortcuts': { label: 'Shortcuts button', where: 'Sidebar footer' },
  'footer-compact': { label: 'Compact button', where: 'Sidebar footer' },
  'footer-hide': { label: 'Hide-sidebar button', where: 'Sidebar footer' },
};

/**
 * The right-click menu for a hideable button: hide this one thing, plus the
 * way back for everything hidden before. Every hide menu ends with the way
 * back, so hiding can never strand the user.
 */
export function hideChromeMenu(
  id: ChromeElementId,
  onHide: () => void,
  onShowHidden: () => void,
): MenuItem[] {
  return [
    {
      kind: 'item',
      label: `Hide ${CHROME_ELEMENTS[id].label.toLowerCase()}`,
      onSelect: onHide,
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Show hidden items…',
      onSelect: onShowHidden,
    },
  ];
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  // Open submenu indexes, one per depth. Only one is open per level.
  const [openIndexes, setOpenIndexes] = useState<number[]>([]);
  const [activeIndexes, setActiveIndexes] = useState<Record<number, number>>({});
  const [anchors, setAnchors] = useState<Record<number, (Anchor | null)[]>>({});

  const closeAll = useCallback(() => {
    setOpenIndexes([]);
    setActiveIndexes({});
    onClose();
  }, [onClose]);

  const reset = useCallback(() => {
    setOpenIndexes([]);
    setActiveIndexes({});
    setAnchors({});
  }, []);

  // A new right-click starts from a clean slate.
  useEffect(() => {
    if (!state) return;
    reset();
  }, [state, reset]);

  const setActive = useCallback((depth: number, index: number) => {
    setActiveIndexes((current) => {
      // Bail when nothing changed. Returning a new object unconditionally would
      // re-render forever, since the callers below run in effects.
      if (current[depth] === index) return current;
      return { ...current, [depth]: index };
    });
  }, []);

  /**
 * Stores the measured row rects for a layer.
 *
 * Called from a layout effect on every render with a freshly built array, so the
 * comparison is by value. An identity check would always miss and spin the
 * component into an endless update loop.
 */
const publishAnchors = useCallback((depth: number, next: (Anchor | null)[]) => {
  setAnchors((current) => {
    const previous = current[depth];
    if (previous && previous.length === next.length) {
      let identical = true;
      for (let index = 0; index < next.length; index += 1) {
        const before = previous[index];
        const after = next[index];
        if (before === after) continue;
        if (
          !before ||
          !after ||
          before.top !== after.top ||
          before.bottom !== after.bottom ||
          before.left !== after.left ||
          before.right !== after.right
        ) {
          identical = false;
          break;
        }
      }
      if (identical) return current;
    }
    return { ...current, [depth]: next };
  });
}, []);

  /**
   * Opens or closes the submenu at `depth`, index `index`.
   *
   * Opening closes every other submenu at the same depth and at any deeper level,
   * which is what stops sibling panels stacking up.
   */
  const toggleSubmenu = useCallback((depth: number, index: number, open: boolean) => {
    setOpenIndexes((current) => {
      const existing = current[depth];
      if (open) {
        if (existing === index) return current;
        const next = current.slice(0, depth);
        next[depth] = index;
        return next;
      }
      if (existing !== index) return current;
      return current.slice(0, depth);
    });
  }, []);

  const closeAllAt = useCallback(() => {
    setOpenIndexes([]);
    setActiveIndexes({});
  }, []);

  // Close on outside interaction, scroll, resize or focus loss.
  useEffect(() => {
    if (!state) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.ctx-menu')) return;
      closeAll();
    };
    const onWheel = () => closeAll();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('wheel', onWheel, { capture: true });
    window.addEventListener('blur', closeAll);
    window.addEventListener('resize', closeAll);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('blur', closeAll);
      window.removeEventListener('resize', closeAll);
    };
  }, [state, closeAll]);

  // Keyboard navigation across layers.
  useEffect(() => {
    if (!state) return;

    /** Items of the deepest open layer, or the root. */
    const deepest = (): MenuItem[] => {
      let list = state.items;
      for (const index of openIndexes) {
        const next = list[index];
        if (!next || next.kind !== 'submenu') return list;
        list = next.items;
      }
      return list;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const depth = openIndexes.length;
      const items = deepest();
      const active = activeIndexes[depth] ?? -1;
      const selectable = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.kind !== 'separator');

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (openIndexes.length > 0) closeAllAt();
        else closeAll();
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (selectable.length === 0) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const position = selectable.findIndex(({ index }) => index === active);
        const nextPosition =
          position === -1
            ? delta > 0
              ? 0
              : selectable.length - 1
            : (position + delta + selectable.length) % selectable.length;
        setActive(depth, (selectable[nextPosition] as { index: number }).index);
        return;
      }

      if (event.key === 'ArrowRight' && active >= 0) {
        const target = items[active];
        if (target?.kind === 'submenu' && !target.disabled) {
          event.preventDefault();
          toggleSubmenu(depth, active, true);
        }
        return;
      }

      if (event.key === 'ArrowLeft' && openIndexes.length > 0) {
        event.preventDefault();
        closeAllAt();
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        if (active < 0) return;
        const target = items[active];
        if (!target) return;
        event.preventDefault();
        if (target.kind === 'submenu') {
          if (!target.disabled) toggleSubmenu(depth, active, true);
          return;
        }
        if (target.kind === 'item' && !target.disabled) {
          target.onSelect?.();
          closeAll();
        }
        return;
      }

      // Type-ahead: jump to the first label starting with what was typed.
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const match = selectable.find(
          ({ item }) => item.kind !== 'separator' && item.label.toLowerCase().startsWith(event.key.toLowerCase()),
        );
        if (match) {
          event.preventDefault();
          setActive(depth, match.index);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [state, openIndexes, activeIndexes, toggleSubmenu, closeAll, closeAllAt, setActive]);

  /** The layers to render, root first. */
  const layers = useMemo(() => {
    if (!state) return [];
    const built: { items: MenuItem[]; x: number; y: number; width: number; heading?: string; anchor?: Anchor }[] = [
      { items: state.items, x: state.x, y: state.y, width: MENU_WIDTH },
    ];
    let list = state.items;
    for (let depth = 0; depth < openIndexes.length; depth += 1) {
      const target = list[openIndexes[depth] as number];
      if (!target || target.kind !== 'submenu') break;
      const rect = anchors[depth]?.[openIndexes[depth] as number] ?? null;
      built.push({
        items: target.items,
        // `x`/`y` are only a fallback for the first paint, before the anchor row
        // has been measured.
        x: rect ? rect.right - 6 : built[depth]!.x + built[depth]!.width - 6,
        y: rect ? rect.top : built[depth]!.y + (openIndexes[depth] as number) * ROW_HEIGHT,
        width: SUBMENU_WIDTH,
        heading: target.heading,
        anchor: rect ?? undefined,
      });
      list = target.items;
    }
    return built;
  }, [state, openIndexes, anchors]);

  return (
    <AnimatePresence>
      {state
        ? layers.map((layer, depth) => (
            <MenuLayer
              key={depth}
              items={layer.items}
              x={layer.x}
              y={layer.y}
              width={layer.width}
              depth={depth}
              heading={layer.heading}
              anchor={layer.anchor}
              isRoot={depth === 0}
              onClose={closeAll}
              onSubmenuToggle={(path, open) => toggleSubmenu(depth, path[0] as number, open)}
              activeIndex={activeIndexes[depth] ?? -1}
              onActiveIndex={(index) => setActive(depth, index)}
              onAnchors={publishAnchors}
            />
          ))
        : null}
    </AnimatePresence>
  );
}