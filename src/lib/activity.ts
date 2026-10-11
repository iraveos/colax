/**
 * Is the app being used right now?
 *
 * The vault is a desktop window, and a window that is minimized, hidden in the
 * tray, or simply behind another app is not being watched. This module answers
 * that question in one place so every background loop can ask it instead of each
 * one keeping its own idea of "visible":
 *
 *  - `document.visibilityState` covers minimizing, hiding to the tray and
 *    switching desktops/virtual screens (Chromium reports a hidden document for
 *    all three, and background timers are throttled to once a minute with it);
 *  - window focus covers the case visibility cannot see, which is a window that
 *    is *visible on screen but behind another app* — still painting, still
 *    running every interval, and completely unwatched.
 *
 * The value is deliberately not React state at the source: polling loops (mail,
 * clipboard, alarms) are not components and must be able to read it without a
 * re-render. `useAppActive` is the component-facing edge, and it is the only
 * thing that installs the listeners, so a page that never uses it never pays for
 * them.
 */

let active = true;
let watching = 0;
let stop: (() => void) | null = null;
const listeners = new Set<(value: boolean) => void>();

function publish(next: boolean): void {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener(next);
}

/** The current answer, for loops that cannot wait for a change event. */
export function appActiveNow(): boolean {
  return active;
}

/** Called back whenever the answer changes. Returns an unsubscribe. */
export function onAppActiveChange(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Starts watching, once per caller. Returns a stop function.
 *
 * Reference-counted rather than a boolean: two components may mount this, and
 * the first to unmount must not tear the listeners out from under the second.
 */
export function watchAppActivity(): () => void {
  watching += 1;
  if (watching === 1 && typeof document !== 'undefined') {
    const read = () => publish(!document.hidden && (document.hasFocus?.() ?? true));
    read();
    document.addEventListener('visibilitychange', read);
    window.addEventListener('focus', read);
    window.addEventListener('blur', read);
    stop = () => {
      document.removeEventListener('visibilitychange', read);
      window.removeEventListener('focus', read);
      window.removeEventListener('blur', read);
    };
  }
  return () => {
    watching = Math.max(0, watching - 1);
    if (watching === 0) {
      stop?.();
      stop = null;
      // Back to "in use" so a later mount starts from the truth rather than
      // from a stale quiet flag.
      active = true;
    }
  };
}
