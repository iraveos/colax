/**
 * View picker.
 *
 * The topbar switcher is gone on purpose; switching lives where it does not
 * compete with New login for attention:
 *
 *   - right-clicking empty content opens the view list at the pointer, and
 *   - Ctrl+1..4 jumps straight to one, and
 *   - dock view slots jump with one key each.
 *
 * All three render the same options, so they cannot drift apart.
 */

import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VaultView, ViewLabels } from '../vault/storage.ts';
import { GridIcon, LayersIcon, RowsIcon, SquaresIcon } from './icons.tsx';

export const VIEW_OPTIONS: {
  id: VaultView;
  label: string;
  hint: string;
  Icon: typeof LayersIcon;
  shortcut: string;
  /** Tile hue: Flow blue, Orbit violet, List green, Grid amber. */
  hue: number;
}[] = [
  { id: 'animated', label: 'Flow', hint: 'Spring-animated cards', Icon: LayersIcon, shortcut: '1', hue: 212 },
  { id: 'carousel', label: 'Orbit', hint: '3D carousel ring', Icon: GridIcon, shortcut: '2', hue: 268 },
  { id: 'basic', label: 'List', hint: 'Plain grouped list', Icon: RowsIcon, shortcut: '3', hue: 152 },
  { id: 'grid', label: 'Grid', hint: 'Responsive card grid', Icon: SquaresIcon, shortcut: '4', hue: 32 },
];

/**
 * Resolves how one view should be labelled: its own override if the user set
 * one, otherwise the group-wide setting.
 */
export function labelsForView(view: VaultView, global: ViewLabels, byView: Partial<Record<VaultView, ViewLabels>>): ViewLabels {
  return byView[view] ?? global;
}

/**
 * The shared option list, so the dropdown and the context menu cannot disagree.
 *
 * `role` differs between the two callers because their containers do: the topbar
 * panel is a listbox, so its children are options, while the context menu is a
 * menu and its children have to be menuitemradio. Putting role="option" inside a
 * role="menu" is invalid and drops the entries out of the accessibility tree.
 */
function ViewOptionList({
  value,
  labels,
  labelsByView,
  role,
  onPick,
}: {
  value: VaultView;
  labels: ViewLabels;
  labelsByView?: Partial<Record<VaultView, ViewLabels>>;
  role: 'option' | 'menuitemradio';
  onPick: (view: VaultView) => void;
}) {
  return (
    <>
      {VIEW_OPTIONS.map((option) => {
        const Icon = option.Icon;
        const selected = option.id === value;
        // The view rows always show their icon, name and hint: hiding the icon
        // in "name" label mode left a single centred word with dead space where
        // the tile was, which read as a broken menu rather than a setting.
        // The per-view label overrides still govern the vault cards and the
        // topbar button — just not the menu itself.
        void labels;
        void labelsByView;
        return (
          <button
            key={option.id}
            role={role}
            aria-selected={selected}
            aria-checked={selected}
            className="view-menu__option"
            data-selected={selected || undefined}
            title={`${option.label} (Ctrl+${option.shortcut})`}
            onClick={() => onPick(option.id)}
          >
            <span
              className="view-menu__icon"
              style={{
                ['--view-h' as string]: String(option.hue),
              }}
            >
              <Icon width="15" height="15" />
            </span>
            <span className="view-menu__text">
              <span className="view-menu__label">{option.label}</span>
              <span className="view-menu__hint">{option.hint}</span>
            </span>
            {selected ? (
              <span className="view-menu__check" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m4.5 12.5 5 5 10-11" />
                </svg>
              </span>
            ) : (
              <span className="view-menu__kbd" aria-hidden="true">
                ⌃{option.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

export function ViewMenu({
  value,
  labels,
  labelsByView,
  onChange,
}: {
  value: VaultView;
  labels: ViewLabels;
  labelsByView?: Partial<Record<VaultView, ViewLabels>>;
  onChange: (view: VaultView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<'left' | 'right'>('right');
  const wrap = useRef<HTMLDivElement>(null);
  const current = VIEW_OPTIONS.find((option) => option.id === value) ?? VIEW_OPTIONS[0]!;
  const CurrentIcon = current.Icon;
  // The button always names the current view: an icon-only button gave no hint
  // which of the four views was active without opening the menu first.
  void labels;
  void labelsByView;

  // Pin the panel's right edge to the button when the button sits near the
  // right viewport edge, so the 288px panel extends leftwards into the window
  // instead of hanging off-screen. The old ternary had this backwards ('left'
  // when crowded), which is exactly how the open panel ended up cut off.
  useEffect(() => {
    if (!open) return;
    const rect = wrap.current?.getBoundingClientRect();
    if (rect) setAlign(rect.right > window.innerWidth - 320 ? 'right' : 'left');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pick = useCallback(
    (next: VaultView) => {
      onChange(next);
      setOpen(false);
    },
    [onChange],
  );

  // Arrow keys walk the rows; Enter/Space activate the focused row natively.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('.view-menu__option') ?? []);
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? rows[(at + 1) % rows.length]
        : rows[(at - 1 + rows.length) % rows.length];
    next?.focus();
  };

  // Click-only on purpose: hover-opening fired every time the pointer crossed
  // the button on its way to New login beside it, which read as a broken,
  // flickering menu. One click opens, another closes; Escape, an outside
  // click, or picking a view also closes it.
  return (
    <div className="view-menu" ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="btn btn--secondary"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((previous) => !previous)}
        title="Change view"
      >
        <CurrentIcon width="15" height="15" />
        <span>{current.label}</span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 28 }}
          style={{ display: 'flex' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </motion.span>
      </button>

      {open ? (
        <div className="view-menu__panel" role="listbox" aria-label="Vault view" data-align={align}>
          <p className="view-menu__heading">Vault view</p>
          <ViewOptionList value={value} labels={labels} labelsByView={labelsByView} role="option" onPick={pick} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Right-click menu over the vault content.
 *
 * Mounted once by App and toggled by a contextmenu listener on the content area
 * rather than on each card, because a card's own context menu (edit, copy, set
 * flag) is the one you want most of the time. The view list only appears where
 * there is no card under the pointer, which is the empty space beside the list.
 */
export function ViewContextMenu({
  open,
  x,
  y,
  value,
  labels,
  labelsByView,
  onPick,
  onClose,
}: {
  open: boolean;
  x: number;
  y: number;
  value: VaultView;
  labels: ViewLabels;
  labelsByView?: Partial<Record<VaultView, ViewLabels>>;
  onPick: (view: VaultView) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  // Keep the panel on screen when the click lands near the right or bottom edge.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFlip(rect.right > window.innerWidth - 8 || rect.bottom > window.innerHeight - 8);
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label="Vault view"
      style={{ left: flip ? undefined : x, right: flip ? window.innerWidth - x : undefined, top: flip ? undefined : y, bottom: flip ? window.innerHeight - y : undefined }}
    >
      <div className="ctx-menu__heading" role="presentation">
        View
      </div>
      <ViewOptionList
        value={value}
        labels={labels}
        labelsByView={labelsByView}
        role="menuitemradio"
        onPick={(next) => {
          onPick(next);
          onClose();
        }}
      />
    </div>
  );
}

/**
 * Ctrl/Cmd + 1..4 selects a view.
 *
 * Returns the listener's cleanup so App can scope it to the vault screen rather
 * than binding it for the lifetime of the page, which would steal the keys from
 * Settings and the editors.
 */
export function useViewShortcuts(onPick: (view: VaultView) => void): void {
  const views = useMemo(() => VIEW_OPTIONS, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const index = Number(event.key) - 1;
      const option = views[index];
      if (!option) return;
      event.preventDefault();
      onPick(option.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onPick, views]);
}
