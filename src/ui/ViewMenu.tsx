/**
 * View picker for the top bar.
 *
 * A button plus a panel that unfurls beneath it, so the choice sits next to the
 * "New login" action it sits beside rather than in the sidebar.
 */

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { VaultView } from '../vault/storage.ts';
import { GridIcon, LayersIcon, RowsIcon } from './icons.tsx';

export const VIEW_OPTIONS: { id: VaultView; label: string; hint: string; Icon: typeof LayersIcon }[] = [
  { id: 'animated', label: 'Flow', hint: 'Spring-animated cards', Icon: LayersIcon },
  { id: 'carousel', label: 'Orbit', hint: '3D carousel ring', Icon: GridIcon },
  { id: 'basic', label: 'List', hint: 'Plain grouped list', Icon: RowsIcon },
];

export function ViewMenu({
  value,
  onChange,
}: {
  value: VaultView;
  onChange: (view: VaultView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<'left' | 'right'>('right');
  const wrap = useRef<HTMLDivElement>(null);
  const current = VIEW_OPTIONS.find((option) => option.id === value) ?? VIEW_OPTIONS[0]!;
  const CurrentIcon = current.Icon;

  // Flip to the left edge when there is not enough room on the right.
  useEffect(() => {
    if (!open) return;
    const rect = wrap.current?.getBoundingClientRect();
    if (rect) setAlign(rect.right > window.innerWidth - 280 ? 'left' : 'right');
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

  return (
    <div className="view-menu" ref={wrap}>
      <button
        className="btn btn--secondary"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
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

      <AnimatePresence>
        {open ? (
          <motion.div
            className="view-menu__panel"
            role="listbox"
            aria-label="Vault view"
            data-align={align}
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.6 }}
          >
            {VIEW_OPTIONS.map((option, index) => {
              const Icon = option.Icon;
              return (
                <motion.button
                  key={option.id}
                  role="option"
                  aria-selected={option.id === value}
                  className="view-menu__option"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.03 * index, type: 'spring', stiffness: 500, damping: 34 }}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <span className="view-menu__icon">
                    <Icon width="15" height="15" />
                  </span>
                  <span className="view-menu__text">
                    <span className="view-menu__label">{option.label}</span>
                    <span className="view-menu__hint">{option.hint}</span>
                  </span>
                </motion.button>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}