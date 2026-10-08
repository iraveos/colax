/*
 * AnimatedList
 * Vendored from @react-bits/AnimatedList-JS-CSS (shadcn registry).
 * Source: npx shadcn@latest view @react-bits/AnimatedList-JS-CSS
 *
 * Upstream changes here:
 *   - JSX -> TSX with generics, so it can render vault items instead of strings
 *   - the demo's fixed 500x400 box and hardcoded #120F17/#2F293A palette are
 *     replaced with the app's tokens, so it follows the active theme
 *   - items render through a render prop rather than <p>{item}</p>
 *   - arrow-key navigation is scoped to the list instead of hijacking the window
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { motion, useInView } from 'motion/react';
import './AnimatedList.css';

/** Drop/drag attributes for one row wrapper: stock handlers plus data flags. */
export interface AnimatedRowProps extends HTMLAttributes<HTMLDivElement> {
  [key: `data-${string}`]: string | undefined;
  ref?: Ref<HTMLDivElement>;
}

export interface AnimatedListProps<T> {
  items: T[];
  /** Stable React key for an item. Defaults to its index. */
  itemKey?: (item: T, index: number) => string;
  renderItem: (item: T, index: number, selected: boolean) => ReactNode;
  onItemSelect?: (item: T, index: number) => void;
  /** Per-row drag/drop attributes (login reorder). Spread onto the row wrapper. */
  rowProps?: (item: T, index: number) => AnimatedRowProps;
  /** List-level drop (append past the last row). Spread onto the scroller. */
  listProps?: HTMLAttributes<HTMLDivElement>;
  showGradients?: boolean;
  enableArrowNavigation?: boolean;
  className?: string;
  itemClassName?: string;
  displayScrollbar?: boolean;
  initialSelectedIndex?: number;
}

interface AnimatedItemProps {
  children: ReactNode;
  delay: number;
  index: number;
  selected: boolean;
  onMouseEnter: () => void;
  onClick: (event: React.MouseEvent) => void;
}

function AnimatedItem({ children, delay, index, selected, onMouseEnter, onClick }: AnimatedItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  // A low threshold gets the animation started, and a latch stops it ever
  // running backwards. Without the latch, a row that is only partly scrolled
  // into view can sit permanently half-faded, which reads as broken text.
  const inView = useInView(ref, { amount: 0.15 });
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (inView) setEntered(true);
  }, [inView]);

  const shown = entered || inView;

  return (
    <motion.div
      ref={ref}
      className="rb-animated-list__row"
      data-index={index}
      data-selected={selected ? '' : undefined}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      // Layout glides rows to their new slots on reorder. The enter stagger
      // must not delay it, so the delay only applies before first paint.
      layout
      initial={{ scale: 0.96, opacity: 0, y: 10 }}
      animate={shown ? { scale: 1, opacity: 1, y: 0 } : { scale: 0.96, opacity: 0, y: 10 }}
      transition={{ type: 'spring', stiffness: 340, damping: 32, mass: 0.7, delay: shown ? 0 : delay }}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedList<T>({
  items,
  itemKey,
  renderItem,
  onItemSelect,
  rowProps,
  listProps,
  showGradients = true,
  enableArrowNavigation = true,
  className = '',
  itemClassName = '',
  displayScrollbar = true,
  initialSelectedIndex = -1,
}: AnimatedListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [topGradientOpacity, setTopGradientOpacity] = useState(0);
  const [bottomGradientOpacity, setBottomGradientOpacity] = useState(0);

  const select = useCallback(
    (index: number) => {
      setSelectedIndex(index);
      onItemSelect?.(items[index] as T, index);
    },
    [items, onItemSelect],
  );

  /**
   * The edge fades only exist to hint that more content continues past the
   * viewport, so their opacity is a function of the scroll position alone.
   *
   * This used to live only in the scroll handler, which left two visible bugs:
   * the bottom fade booted at full opacity and painted a hard band of --bg
   * across the end of the list until the first scroll event corrected it, and
   * any content change (items added, images loading, the window resizing) left
   * a stale opacity behind. Deriving it in one place and calling that from a
   * ResizeObserver plus an items effect keeps it honest at all times.
   */
  const syncGradients = useCallback(() => {
    const container = listRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    setTopGradientOpacity(Math.min(scrollTop / 56, 1));
    const bottomDistance = scrollHeight - (scrollTop + clientHeight);
    setBottomGradientOpacity(scrollHeight <= clientHeight ? 0 : Math.min(bottomDistance / 56, 1));
  }, []);

  const handleScroll = useCallback(() => {
    syncGradients();
  }, [syncGradients]);

  useEffect(() => {
    syncGradients();
    const container = listRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    // The list is the scroll container, so observing it catches both its own
    // box changing and its content growing or shrinking.
    const observer = new ResizeObserver(() => syncGradients());
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [syncGradients, items.length]);

  // Images inside the cards settle after first paint and change the scroll
  // height, so the fades have to be re-derived once they land.
  useEffect(() => {
    if (typeof Image === 'undefined') return;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      syncGradients();
    };
    const timer = window.setTimeout(check, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [syncGradients, items.length]);

  useEffect(() => {
    if (!enableArrowNavigation) return;
    const container = listRef.current;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Only take over when focus is already inside the list, so the arrow keys
      // keep working normally everywhere else in the app.
      if (!container.contains(document.activeElement)) return;
      event.preventDefault();
      setKeyboardNav(true);
      setSelectedIndex((prev) => {
        const base = prev < 0 ? -1 : prev;
        return event.key === 'ArrowDown'
          ? Math.min(base + 1, items.length - 1)
          : Math.max(base - 1, 0);
      });
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [items.length, enableArrowNavigation]);

  useEffect(() => {
    if (!keyboardNav || selectedIndex < 0 || !listRef.current) return;
    const container = listRef.current;
    const selectedItem = container.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (selectedItem) {
      const margin = 24;
      const { scrollTop, clientHeight } = container;
      const top = selectedItem.offsetTop;
      const bottom = top + selectedItem.offsetHeight;
      if (top < scrollTop + margin) container.scrollTo({ top: top - margin, behavior: 'smooth' });
      else if (bottom > scrollTop + clientHeight - margin) {
        container.scrollTo({ top: bottom - clientHeight + margin, behavior: 'smooth' });
      }
    }
    setKeyboardNav(false);
  }, [selectedIndex, keyboardNav]);

  return (
    <div className={`rb-animated-list ${className}`.trim()}>
      <div
        ref={listRef}
        className={`rb-animated-list__scroll ${displayScrollbar ? '' : 'no-scrollbar'}`.trim()}
        onScroll={handleScroll}
        tabIndex={enableArrowNavigation ? 0 : -1}
        role="listbox"
        aria-label="Vault entries"
        {...listProps}
      >
        {items.map((item, index) => (
          <AnimatedItem
            key={itemKey ? itemKey(item, index) : index}
            delay={Math.min(index, 8) * 0.035}
            index={index}
            selected={selectedIndex === index}
            onMouseEnter={() => setSelectedIndex(index)}
            // Modifier-clicks belong to multi-selection (handled on the card
            // below): opening here as well would both open and select at once.
            onClick={(event: React.MouseEvent) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              select(index);
            }}
          >
            <div className={`rb-animated-list__item ${itemClassName}`.trim()} {...rowProps?.(item, index)}>
              {renderItem(item, index, selectedIndex === index)}
            </div>
          </AnimatedItem>
        ))}
      </div>

      {showGradients ? (
        <>
          <div className="rb-animated-list__fade rb-animated-list__fade--top" style={{ opacity: topGradientOpacity }} />
          <div className="rb-animated-list__fade rb-animated-list__fade--bottom" style={{ opacity: bottomGradientOpacity }} />
        </>
      ) : null}
    </div>
  );
}

export default AnimatedList;