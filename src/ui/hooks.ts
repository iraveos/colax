import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { VaultService } from '../vault/vault-service.ts';
import {
  IndexedDbVaultStorage,
  MemoryVaultStorage,
  normalisePreferences,
  DEFAULT_PREFERENCES,
  type ThemeMode,
  type VaultPreferences,
  type VaultStorage,
} from '../vault/storage.ts';
import type { VaultItem } from '../vault/types.ts';
import type { Channel } from '../vault/channels.ts';
import type { VaultProtection } from '../crypto/vault-crypto.ts';

function pickStorage(): VaultStorage {
  // IndexedDB is the real store. The in-memory fallback keeps the app usable
  // (with an explicit warning) where storage is blocked, e.g. private windows.
  return IndexedDbVaultStorage.isSupported()
    ? new IndexedDbVaultStorage()
    : new MemoryVaultStorage();
}

export type Screen = 'all' | 'favorites' | 'weak' | 'settings';

export interface VaultBoot {
  kind: 'loading' | 'ready' | 'failed';
  message?: string;
}

/** One reversible point: the items and preferences as they were. */
interface HistoryEntry {
  items: VaultItem[];
  prefs: VaultPreferences;
}

export function useVault() {
  const service = useMemo(() => new VaultService(pickStorage()), []);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [prefs, setPrefs] = useState<VaultPreferences>(DEFAULT_PREFERENCES);
  // Mirrors `prefs` so preference patches compose instead of racing.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /**
   * Undo/redo history.
   *
   * Refs rather than state: the stacks are only ever read by the keyboard
   * handlers, and putting them in state would re-render the whole vault on every
   * keystroke. Snapshots are the decrypted items plus preferences, which are
   * already in memory, so this costs nothing but a bounded number of array copies.
   */
  const past = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);

  const pushHistory = useCallback(() => {
    past.current.push({ items: [...(service.items ?? [])], prefs: prefsRef.current });
    // Bounded so a long session cannot grow without limit.
    if (past.current.length > 50) past.current.shift();
    // Any new edit invalidates the redo branch.
    future.current = [];
  }, [service]);
  const [status, setStatus] = useState<'loading' | 'absent' | 'locked' | 'unlocked'>('loading');
  const [protection, setProtection] = useState<VaultProtection | null>(null);
  const [boot, setBoot] = useState<VaultBoot>({ kind: 'loading' });
  const [persistent, setPersistent] = useState(true);

  useEffect(() => {
    setPersistent(IndexedDbVaultStorage.isSupported());
    void (async () => {
      try {
        const loaded = await service.preferences();
        setPrefs(loaded);
        applyAppearance(loaded);
        const found = await service.protection();
        setProtection(found);

        if (found === null) {
          setStatus('absent');
        } else if (found === 'device') {
          // A vault with no password has nothing to ask for, so opening the app
          // opens the vault. An explicit Lock still shows the tap-to-open screen.
          await service.unlock();
          setItems([...(service.items ?? [])]);
          setStatus('unlocked');
        } else {
          setStatus('locked');
        }
        setBoot({ kind: 'ready' });
      } catch (cause) {
        // Without this the app would sit on the spinner forever.
        setBoot({
          kind: 'failed',
          message: cause instanceof Error ? cause.message : 'Could not open local vault storage.',
        });
      }
    })();
  }, [service]);

  useSystemThemeSync(prefs.theme);

  const sync = useCallback(() => {
    setItems(service.isUnlocked ? [...(service.items ?? [])] : []);
  }, [service]);

  const unlock = useCallback(
    async (masterPassword?: string) => {
      const ok = await service.unlock(masterPassword);
      if (ok) {
        sync();
        setStatus('unlocked');
        setProtection(await service.protection());
      }
      return ok;
    },
    [service, sync],
  );

  /** Password is optional; omitting it creates a vault that opens without one. */
  const create = useCallback(
    async (masterPassword?: string) => {
      await service.create(masterPassword);
      sync();
      setProtection(await service.protection());
      setStatus('unlocked');
    },
    [service, sync],
  );

  const lock = useCallback(() => {
    service.lock();
    sync();
    setStatus('locked');
  }, [service, sync]);

  /**
   * Wraps a mutation so the view always reflects the new ciphertext-backed state.
   *
   * Returns the action's result, so callers that create something (a login id,
   * a channel id) can use it afterwards. Callers that ignore the return value
   * behave exactly as before.
   */
const mutate = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      // Snapshot before the change, so undo has somewhere to go back to.
      pushHistory();
      const result = await action();
      sync();
      return result;
    },
    [sync, pushHistory],
  );

/** Restores a snapshot and pushes the current state onto the opposite stack. */
const restore = useCallback(
    async (snapshot: HistoryEntry) => {
      await service.replaceItems(snapshot.items);
      setPrefs(snapshot.prefs);
      prefsRef.current = snapshot.prefs;
      applyAppearance(snapshot.prefs);
      await service.savePreferences(snapshot.prefs);
      sync();
    },
    [service, sync],
  );

const undo = useCallback(async () => {
    const previous = past.current.pop();
    if (!previous) return false;
    future.current.push({ items: [...(service.items ?? [])], prefs: prefsRef.current });
    await restore(previous);
    return true;
  }, [service, restore]);

const redo = useCallback(async () => {
    const next = future.current.pop();
    if (!next) return false;
    past.current.push({ items: [...(service.items ?? [])], prefs: prefsRef.current });
    await restore(next);
    return true;
  }, [service, restore]);

  /** Drops the history, e.g. after the vault is replaced wholesale. */
const clearHistory = useCallback(() => {
    past.current = [];
    future.current = [];
  }, []);

  /**
   * Records one use of a login (copied or edited).
   *
   * Deliberately outside mutate(): use counts must not push undo history —
   * undoing "copy password" makes no sense — and must not touch appearance.
   * Prunes entries for deleted logins and caps at 200 by recency; the service
   * owns the items, but only the hook sees both prefs and the moment.
   */
  const recordUse = useCallback(
    async (id: string, knownIds?: ReadonlySet<string>) => {
      const prev = prefsRef.current.usage ?? {};
      const at = Date.now();
      const next: Record<string, { count: number; at: number }> = {};
      next[id] = { count: (prev[id]?.count ?? 0) + 1, at };
      const entries = Object.entries(prev)
        .filter(([key]) => key !== id && (!knownIds || knownIds.has(key)))
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 199);
      for (const [key, value] of entries) next[key] = value;
      const prefs = { ...prefsRef.current, usage: next };
      prefsRef.current = normalisePreferences(prefs);
      setPrefs(prefsRef.current);
      await service.savePreferences(prefsRef.current);
    },
    [service],
  );

  /**
   * Wipes the vault and returns the app to the create screen.
   *
   * This has to live here rather than calling `service.reset()` from App: the
   * service holds the ciphertext, but this hook holds the React state (items,
   * status, prefs, undo stacks). Resetting only the service wipes the disk and
   * leaves every login on screen — status stays 'unlocked', items stay
   * populated, and the user watches a "vault deleted" toast over a vault that
   * is visibly still there.
   */
  const resetVault = useCallback(async () => {
    await service.reset();
    past.current = [];
    future.current = [];
    prefsRef.current = DEFAULT_PREFERENCES;
    setPrefs(DEFAULT_PREFERENCES);
    applyAppearance(DEFAULT_PREFERENCES);
    setProtection(null);
    setItems([]);
    setStatus('absent');
  }, [service]);

  /**
 * Merges a patch into the stored preferences.
 *
 * Reads through a ref rather than the `prefs` captured in this callback's closure:
 * two updates fired in the same tick (dragging a slider, or flipping two switches
 * quickly) would otherwise both start from the same snapshot and the second would
 * silently discard the first.
 */
const updatePrefs = useCallback(
    async (patch: Partial<VaultPreferences>) => {
      const next = normalisePreferences({ ...prefsRef.current, ...patch });
      prefsRef.current = next;
      setPrefs(next);
      applyAppearance(next);
      await service.savePreferences(next);
    },
    [service],
  );

  return {
    service,
    items,
    prefs,
    status,
    protection,
    boot,
    persistent,
    unlock,
    create,
    lock,
    mutate,
    undo,
    redo,
    clearHistory,
    resetVault,
    recordUse,
    updatePrefs,
  };
}

export function applyAppearance(prefs: VaultPreferences): void {
  const root = document.documentElement;
  const resolved =
    prefs.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : prefs.theme;

  root.dataset.theme = resolved;
  root.dataset.accent = prefs.accent;
  root.dataset.density = prefs.density;
  root.dataset.transparency = prefs.reduceTransparency ? 'reduced' : 'full';
  root.dataset.contrast = prefs.highContrast ? 'high' : 'normal';

  // The ambient slider only scales opacity, so 0 truly removes the background.
  root.style.setProperty('--ambient-strength', String(prefs.ambient));
  // Glass alpha 0 collapses every translucent surface to a solid one.
  root.style.setProperty('--glass-alpha', prefs.reduceTransparency ? '0' : '1');
  root.style.setProperty('--ui-scale', String(prefs.textScale / 100));
  root.dataset.motion = prefs.motion === 0 ? 'off' : 'on';
  // One scalar every transition divides by, so the speed control is immediate
  // and consistent rather than per-component.
  root.style.setProperty('--motion-speed', String(prefs.motionSpeed));

  // Corner radii are all derived from one scalar so they stay in proportion.
  const round = prefs.roundness;
  root.style.setProperty('--radius-sm', `${8 * round}px`);
  root.style.setProperty('--radius-md', `${12 * round}px`);
  root.style.setProperty('--radius-lg', `${18 * round}px`);
  root.style.setProperty('--radius-xl', `${26 * round}px`);
  root.style.setProperty('--radius-2xl', `${34 * round}px`);
  // Card shadow depth. The CSS multiplies every term by this one scalar, so the
  // slider is continuous and 0 genuinely means no shadow at all.
  root.style.setProperty('--card-depth', String(prefs.cardDepth));

  // Density feeds a multiplier the layout actually reads, rather than a token
  // that nothing consumed.
  root.style.setProperty('--density', String(DENSITY_SCALE[prefs.density]));

  if (prefs.backgroundImage) {
    root.style.setProperty('--bg-image', `url("${cssUrl(prefs.backgroundImage)}")`);
    root.style.setProperty('--bg-image-opacity', String(prefs.backgroundOpacity));
    root.style.setProperty('--bg-image-blur', String(prefs.backgroundBlur));
    // Dimming keeps text legible over an arbitrary photo.
    root.style.setProperty('--bg-dim', String(prefs.backgroundDim));
  } else {
    root.style.setProperty('--bg-image', 'none');
    root.style.setProperty('--bg-image-opacity', '0');
    root.style.setProperty('--bg-image-blur', '0');
    root.style.setProperty('--bg-dim', '0');
  }

  try {
    localStorage.setItem('aegis.theme', prefs.theme);
    localStorage.setItem('aegis.accent', prefs.accent);
  } catch {
    // Private mode: the dataset attributes are enough.
  }
}

/**
 * Applies the selected channel's own background image over the global one.
 *
 * Deliberately does NOT touch the accent. Channels used to re-skin the whole app
 * from their own `accent` field, which meant the accent picker in Settings and
 * the appearance panel appeared to do nothing: every built-in channel ships with
 * an accent (channels.ts), so a channel was almost always "custom" and the
 * channel's colour won over the one the user had just picked. Worse, the test
 * for whether a channel counts as custom was `channel.accent !== prefs.accent`,
 * so the two fought each other — whichever value you set last was the one that
 * lost.
 *
 * A background image has no such conflict, because there is no global "no
 * background" preference competing with it in the other direction. So the image
 * stays per-channel and the accent is global, which is what both the label and
 * the picker say it is.
 */
export function applyChannelAppearance(prefs: VaultPreferences, channel: Channel): void {
  const root = document.documentElement;

  const image = channel.backgroundImage || prefs.backgroundImage;
  if (image) {
    root.style.setProperty('--bg-image', `url("${cssUrl(image)}")`);
    root.style.setProperty('--bg-image-opacity', String(prefs.backgroundOpacity));
    root.style.setProperty('--bg-image-blur', String(prefs.backgroundBlur));
    root.style.setProperty('--bg-dim', String(prefs.backgroundDim));
  } else {
    root.style.setProperty('--bg-image', 'none');
    root.style.setProperty('--bg-image-opacity', '0');
    root.style.setProperty('--bg-image-blur', '0');
    root.style.setProperty('--bg-dim', '0');
  }
}

/** Escapes the few characters that would break out of a CSS url() token. */
function cssUrl(value: string): string {
  return value.replace(/["'()\\\n\r]/g, '\\$&');
}

/** Layout multiplier behind the density setting. */
const DENSITY_SCALE = { compact: 0.74, comfortable: 1, spacious: 1.24 } as const;

/** Keeps "system" theme mode live when the OS flips light/dark. */
export function useSystemThemeSync(theme: ThemeMode): void {
  useEffect(() => {
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => {
      document.documentElement.dataset.theme = query.matches ? 'light' : 'dark';
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [theme]);
}

export interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, tone: Toast['tone'] = 'ok', duration = 2200) => {
      const id = (nextId.current += 1);
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}

/**
 * Ctrl/Cmd+A selects every login currently in view, and Escape clears it.
 *
 * Both are scoped to a guard the caller supplies, because the app has several
 * text inputs and a global Ctrl+A there would select a login instead of an
 * email address. The guard returns false when focus is somewhere a text
 * selection is the sensible meaning.
 */
export function useSelectAllShortcuts(
  selectAll: () => void,
  clear: () => void,
  guard: () => boolean,
): void {
  const selectRef = useRef(selectAll);
  selectRef.current = selectAll;
  const clearRef = useRef(clear);
  clearRef.current = clear;
  const guardRef = useRef(guard);
  guardRef.current = guard;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearRef.current();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'a') return;
      if (!guardRef.current()) return;
      event.preventDefault();
      selectRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/**
 * True when focus is somewhere a plain Ctrl+A should mean "select the text",
 * not "select every login".
 *
 * Contenteditable elements are included because several of the app's surfaces
 * (the notes field, the filter input) are inputs rather than text nodes, and
 * guessing wrong here means the user loses a text selection mid-edit.
 */
export function typingHasFocus(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Copy with an optional auto-clear.
 *
 * `notify` is injected rather than created here. This hook used to spin up its
 * own `useToasts()`, which meant every "Password copied" message went into a
 * state array the app never rendered — the copy silently did nothing visible.
 */
export function useClipboard(
  clearAfterSeconds: number,
  notify: (message: string, tone?: Toast['tone']) => void,
  toasts = true,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (value: string, label: string) => {
      if (!value) return;
      if (!(await writeClipboard(value))) {
        notify('Could not reach the clipboard', 'error');
        return;
      }
      if (toasts) notify(`${label} copied`);
      if (timer.current) clearTimeout(timer.current);
      if (clearAfterSeconds > 0) {
        timer.current = setTimeout(() => {
          void writeClipboard('');
        }, clearAfterSeconds * 1000);
      }
    },
    [clearAfterSeconds, notify, toasts],
  );

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return { copy };
}

/**
 * Writes to the clipboard, falling back to a selection-based copy.
 *
 * The async API is unavailable on insecure origins and can be refused when a
 * permission prompt is suppressed, which is exactly when a user most needs to
 * know the copy failed.
 */
async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const scratch = document.createElement('textarea');
    scratch.value = value;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '0';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Re-locks after a period of inactivity. Any real interaction resets the timer. */
export function useAutoLock(minutes: number, enabled: boolean, onLock: () => void) {
  const reset = useRef(onLock);
  reset.current = onLock;

  useEffect(() => {
    if (!enabled || minutes <= 0) return;
    let timer = setTimeout(fire, minutes * 60_000);

    function fire() {
      reset.current();
    }

    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, minutes * 60_000);
    };

    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (const event of events) window.addEventListener(event, bump, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, bump);
    };
  }, [minutes, enabled]);
}

/** Runs `handler` when the event matches, ignoring keystrokes inside form fields. */
export function useHotkeys(
  map: Record<string, (event: KeyboardEvent) => void>,
  options: { enabled?: boolean; allowInInputs?: boolean } = {},
): void {
  const { enabled = true, allowInInputs = false } = options;
  const handlers = useRef(map);
  handlers.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (inField && !allowInInputs) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      const combo = [event.shiftKey ? 'shift' : '', key].filter(Boolean).join('+');
      const handler = handlers.current[combo] ?? handlers.current[key];
      if (!handler) return;
      event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, allowInInputs]);
}

/** Ticks once a second; drives TOTP codes and countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Calls `handler` on Escape and on a click outside the ref'd element. */
export function useDismissable(open: boolean, handler: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handlerRef.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) handlerRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return ref;
}