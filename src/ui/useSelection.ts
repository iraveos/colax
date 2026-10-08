/**
 * Multi-select for logins.
 *
 * Kept out of App and out of the views because the selection rules are fiddly
 * enough to be worth testing and worth stating in one place: a plain click is
 * not a selection gesture at all (it copies the password, which is what every
 * other row does), so selection needs a modifier, and a modifier click has to
 * toggle rather than replace or it is useless for building a set.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { VaultItem } from '../vault/types.ts';

export interface Selection {
  /** Ids currently selected. Empty means nothing is selected. */
  ids: ReadonlySet<string>;
  /** True when more than one login is selected, so menus can say "3 logins". */
  isMulti: boolean;
  /** Ctrl/Cmd+click: add or remove this one. */
  toggle: (item: VaultItem) => void;
  /** Shift+click: select everything from the anchor to here, inclusive. */
  extendTo: (item: VaultItem, ordered: readonly VaultItem[]) => void;
  /** Ctrl/Cmd+A: everything currently in view. */
  selectAll: (ordered: readonly VaultItem[]) => void;
  clear: () => void;
  /** The selected logins, in the order given. Empty ids yields an empty array. */
  resolve: (ordered: readonly VaultItem[]) => VaultItem[];
}

const NOTHING: ReadonlySet<string> = new Set();

export function useSelection(): Selection {
  const [ids, setIds] = useState<ReadonlySet<string>>(NOTHING);
  // The last row the user clicked without a modifier. Shift extends from here,
  // and it has to survive a plain click changing the selection, so it is stored
  // separately rather than derived from `ids`.
  const anchorRef = useRef<string | null>(null);

  const toggle = useCallback((item: VaultItem) => {
    setIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    anchorRef.current = item.id;
  }, []);

  const extendTo = useCallback((item: VaultItem, ordered: readonly VaultItem[]) => {
    setIds((current) => {
      const next = new Set(current);
      // No anchor yet, or a single row selected: extend from that row. Failing
      // that, from here, which makes a lone shift-click a plain selection.
      const from = anchorRef.current ?? (current.size === 1 ? [...current][0] : undefined) ?? item.id;
      const a = ordered.findIndex((entry) => entry.id === from);
      const b = ordered.findIndex((entry) => entry.id === item.id);
      if (a < 0 || b < 0) {
        // The anchor is no longer in the filtered list (the search changed, or
        // the row was deleted). Falling back to a plain selection beats
        // selecting nothing and leaving the user unsure why.
        next.clear();
        next.add(item.id);
        return next;
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i += 1) {
        const entry = ordered[i];
        if (entry) next.add(entry.id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ordered: readonly VaultItem[]) => {
    setIds(new Set(ordered.map((entry) => entry.id)));
  }, []);

  const clear = useCallback(() => setIds(NOTHING), []);

  const resolve = useCallback(
    (ordered: readonly VaultItem[]) => ordered.filter((entry) => ids.has(entry.id)),
    [ids],
  );

  const isMulti = ids.size > 1;

  // A new object only when something actually changed, so the views do not
  // re-render on every parent render just because this hook ran.
  return useMemo(
    () => ({ ids, isMulti, toggle, extendTo, selectAll, clear, resolve }),
    [ids, isMulti, toggle, extendTo, selectAll, clear, resolve],
  );
}
