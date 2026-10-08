/**
 * Frequently used: the top 5 logins by copy/edit count, scrollable to 20.
 *
 * A topbar button with a clock glyph; hovering opens a big menu, clicking
 * toggles it for touch and keyboard users. Hover alone would strand touch
 * users with no way in, click alone would bury a one-glance feature behind a
 * press — both gestures work and both land in the same place. Escape, an
 * outside pointer, or picking a login closes it.
 *
 * Ranking is count first, recency second, so a login used fifty times last
 * year still outranks one used twice today — frequency is the point, not
 * recency. Logins deleted since (their usage entries pruned on write, but a
 * record restored from backup can reference ghosts) are skipped rather than
 * rendered as dead rows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { VaultItem } from '../vault/types.ts';
import { ClockIcon } from './icons.tsx';
import { labelOf } from './views.tsx';

export function FrequentPanel({
  items,
  usage,
  onPick,
}: {
  items: VaultItem[];
  usage: Record<string, { count: number; at: number }>;
  onPick: (item: VaultItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return Object.entries(usage)
      .sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at)
      .map(([id]) => byId.get(id))
      .filter((item): item is VaultItem => Boolean(item))
      .slice(0, 20);
  }, [items, usage]);

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
  }, [open ]);

  // No history yet: no button at all rather than an empty menu that explains
  // itself. A fresh vault has nothing frequent by definition.
  if (ranked.length === 0) return null;

  return (
    <div
      className="view-menu frequent"
      ref={wrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className="btn btn--secondary"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Frequently used logins"
        onClick={() => setOpen((value) => !value)}
      >
        <ClockIcon width="15" height="15" />
        <span>Frequent</span>
      </button>

      {open ? (
        <div className="view-menu__panel frequent__panel" role="menu" aria-label="Frequently used logins">
          {ranked.slice(0, 5).map((item) => (
            <FrequentRow key={item.id} item={item} count={usage[item.id]?.count ?? 0} onPick={onPick} onDone={() => setOpen(false)} />
          ))}
          {ranked.length > 5 ? (
            <div className="frequent__more">
              {ranked.slice(5).map((item) => (
                <FrequentRow key={item.id} item={item} count={usage[item.id]?.count ?? 0} onPick={onPick} onDone={() => setOpen(false)} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FrequentRow({
  item,
  count,
  onPick,
  onDone,
}: {
  item: VaultItem;
  count: number;
  onPick: (item: VaultItem) => void;
  onDone: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="view-menu__option"
      title={`${labelOf(item)} — used ${count} time${count === 1 ? '' : 's'}`}
      onClick={() => {
        onPick(item);
        onDone();
      }}
    >
      <span className="view-menu__text">
        <span className="view-menu__label">{labelOf(item)}</span>
        <span className="view-menu__hint">
          {count} use{count === 1 ? '' : 's'}
        </span>
      </span>
    </button>
  );
}
