/**
 * Mohmal temporary inboxes.
 *
 * Mohmal has no public mail API and sits behind a Cloudflare browser check.
 * A plain HTTP client is refused, so this service uses a hidden Chromium
 * window with a persistent partition per inbox: the challenge runs once, the
 * site's own session cookie stays in that partition, and every later refresh
 * is the same page a person would see.
 *
 * Nothing here touches the vault. The renderer stores only the address, the
 * partition key and timestamps; the session cookie remains in Electron's
 * partition storage.
 */

import { BrowserWindow, session } from 'electron';
import { randomBytes } from 'node:crypto';
import {
  MOHMAL_DEFAULT_RENEW_MINUTES,
  MOHMAL_LIFETIME_MS,
  isEmailLike,
  normaliseTempMailbox,
  type TempMailCreateResult,
  type TempMailDetail,
  type TempMailListResult,
  type TempMailMessage,
  type TempMailReadResult,
  type TempMailRenewResult,
  type TempMailSchedule,
  type TempMailScheduleError,
  type TempMailScheduleResult,
  type TempMailRenewUpdate,
  type TempMailbox,
} from '../src/lib/temp-mail.ts';

const BASE = 'https://www.mohmal.com';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const windows = new Map<string, BrowserWindow>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One operation at a time: two loads in one hidden window would race. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sessionKeyIsValid(value: string): boolean {
  return /^[a-f0-9]{16,64}$/i.test(value);
}

function windowFor(sessionKey: string): BrowserWindow {
  const existing = windows.get(sessionKey);
  if (existing && !existing.isDestroyed()) return existing;
  const partition = `persist:colax-temp-${sessionKey}`;
  const partitionSession = session.fromPartition(partition);
  partitionSession.setUserAgent(CHROME_UA);
  partitionSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    skipTaskbar: true,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setAudioMuted(true);
  win.webContents.setUserAgent(CHROME_UA);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => windows.delete(sessionKey));
  windows.set(sessionKey, win);
  return win;
}

async function navigate(win: BrowserWindow, url: string, postData?: unknown): Promise<void> {
  try {
    // A dead connection must not leave the editor's spinner up forever. The
    // page-level wait below is still authoritative; this only bounds the
    // initial navigation.
    await Promise.race([
      win.loadURL(url, postData ? { postData: postData as never } : undefined),
      sleep(20_000),
    ]);
  } catch {
    // Cloudflare often aborts the first navigation while it redirects. The
    // wait below is the real readiness check.
  }
}

/**
 * Waits until the page is a real Mohmal page, not the interstitial. The
 * interstitial's own JavaScript needs a few seconds, so a fixed sleep would
 * either be too short or waste time on a fast connection.
 */
async function waitForPage(win: BrowserWindow, timeoutMs = 35_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (win.isDestroyed()) throw new Error('The temporary-mail window closed.');
    const state = await win.webContents
      .executeJavaScript(
        `(() => ({
          ready: document.readyState,
          text: (document.body && document.body.innerText || '').slice(0, 120),
        }))()`,
        true,
      )
      .catch(() => null);
    if (
      state &&
      state.ready === 'complete' &&
      !/just a moment|checking your browser|verify you are human/i.test(state.text)
    ) {
      return;
    }
    await sleep(450);
  }
  throw new Error('Mohmal did not finish loading. Check your internet connection and try again.');
}

async function waitForExpression<T>(
  win: BrowserWindow,
  expression: string,
  timeoutMs = 20_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (win.isDestroyed()) throw new Error('The temporary-mail window closed.');
    const value = await win.webContents.executeJavaScript(expression, true).catch(() => null);
    if (value) return value as T;
    await sleep(450);
  }
  throw new Error('Mohmal did not answer in time. Try again, or create a new temporary inbox.');
}

const addressExpression = `(() => {
  const el = document.querySelector('#email .email');
  const text = (el && el.textContent || '').trim();
  const match = text.match(/[^\\s@]+@[^\\s@]+\\.[^\\s@]+/);
  if (!match) return null;
  const mins = Number((document.querySelector('#timeMin') || {}).value);
  const secs = Number((document.querySelector('#timeSec') || {}).value);
  const left = Math.max(0, (Number.isFinite(mins) ? mins : 45) * 60 + (Number.isFinite(secs) ? secs : 0));
  return { address: match[0].toLowerCase(), leftSeconds: left };
})()`;

type AddressState = { address: string; leftSeconds: number };

function expiryFrom(leftSeconds: number, now: number): number {
  // A freshly-created page says 45:xx. If the timer is missing, use the
  // documented lifetime rather than handing back an inbox that never expires.
  const left = leftSeconds > 5 ? leftSeconds : MOHMAL_LIFETIME_MS / 1000;
  return now + left * 1000;
}

export async function createMohmalMailbox(): Promise<TempMailCreateResult> {
  return enqueue(async () => {
    const sessionKey = randomBytes(16).toString('hex');
    const win = windowFor(sessionKey);
    try {
      await navigate(win, `${BASE}/en/create/random`, []);
      await waitForPage(win);
      const state = await waitForExpression<AddressState>(win, addressExpression);
      if (!state || !isEmailLike(state.address)) {
        throw new Error('Mohmal created a page without an address. Try again.');
      }
      const createdAt = Date.now();
      const mailbox = normaliseTempMailbox({
        provider: 'mohmal',
        address: state.address,
        sessionKey,
        createdAt,
        expiresAt: expiryFrom(state.leftSeconds, createdAt),
        autoRenewMinutes: MOHMAL_DEFAULT_RENEW_MINUTES,
        lastRenewedAt: createdAt,
      });
      if (!mailbox) throw new Error('Mohmal returned an address Colax could not read.');
      return { ok: true, mailbox };
    } catch (cause) {
      const key = windows.get(sessionKey);
      windows.delete(sessionKey);
      key?.destroy();
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : 'Could not create a temporary inbox.',
      };
    }
  });
}

export async function listMohmalMessages(
  address: string,
  sessionKey: string,
): Promise<TempMailListResult> {
  return enqueue(async () => {
    const cleanAddress = address.trim().toLowerCase();
    if (!isEmailLike(cleanAddress) || !sessionKeyIsValid(sessionKey)) {
      return { ok: false, error: 'That temporary inbox is not valid.' };
    }
    const win = windowFor(sessionKey);
    try {
      await navigate(win, `${BASE}/en/inbox`);
      await waitForPage(win);
      const state = await waitForExpression<AddressState>(win, addressExpression);
      if (state.address !== cleanAddress) {
        return {
          ok: false,
          error: 'This temporary inbox expired or was replaced. Create a new one.',
        };
      }
      const messages = await win.webContents.executeJavaScript(
        `(() => [...document.querySelectorAll('tr[data-msg-id]')].map((row) => ({
          id: row.getAttribute('data-msg-id') || '',
          subject: ((row.querySelector('.subject') || {}).textContent || '').trim(),
          from: ((row.querySelector('.sender') || {}).textContent || '').trim(),
          time: ((row.querySelector('.time') || {}).textContent || '').trim(),
          unread: row.classList.contains('unseen') || !row.classList.contains('seen'),
        })).filter((row) => row.id))()`,
        true,
      ) as TempMailMessage[];
      return {
        ok: true,
        messages,
        expiresAt: expiryFrom(state.leftSeconds, Date.now()),
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : 'Could not read the temporary inbox.',
      };
    }
  });
}

/**
 * Calls Mohmal's own "Renew" route. `/en/extend` resets the site's validity
 * timer to the full lifetime and redirects back to the inbox, so the ordinary
 * page extraction can read the new countdown.
 */
export async function renewMohmalMailbox(
  address: string,
  sessionKey: string,
): Promise<TempMailRenewResult> {
  return enqueue(async () => {
    const cleanAddress = address.trim().toLowerCase();
    if (!isEmailLike(cleanAddress) || !sessionKeyIsValid(sessionKey)) {
      return { ok: false, error: 'That temporary inbox is not valid.' };
    }
    const win = windowFor(sessionKey);
    try {
      await navigate(win, `${BASE}/en/extend`);
      await waitForPage(win);
      const state = await waitForExpression<AddressState>(win, addressExpression);
      if (state.address !== cleanAddress) {
        return {
          ok: false,
          error: 'This temporary inbox expired or was replaced. Create a new one.',
        };
      }
      const renewedAt = Date.now();
      return {
        ok: true,
        expiresAt: expiryFrom(state.leftSeconds, renewedAt),
        renewedAt,
      };
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof Error ? cause.message : 'Could not renew the temporary inbox.',
      };
    }
  });
}

export async function readMohmalMessage(
  address: string,
  sessionKey: string,
  id: string,
): Promise<TempMailReadResult> {
  return enqueue(async () => {
    const cleanAddress = address.trim().toLowerCase();
    const cleanId = id.trim();
    if (
      !isEmailLike(cleanAddress) ||
      !sessionKeyIsValid(sessionKey) ||
      !/^[a-zA-Z0-9._-]{1,160}$/.test(cleanId)
    ) {
      return { ok: false, error: 'That message is not valid.' };
    }
    const win = windowFor(sessionKey);
    try {
      await navigate(win, `${BASE}/en/message/${encodeURIComponent(cleanId)}`);
      await waitForPage(win);
      const detail = await waitForExpression<TempMailDetail>(
        win,
        `(() => {
          const root = document.querySelector('#read .body') || document.querySelector('#read') || document.body;
          const text = (root && root.innerText || '').trim();
          const html = (root && root.innerHTML || '').trim();
          if (!text && !html) return null;
          if (/just a moment|checking your browser/i.test(text)) return null;
          const header = document.querySelector('#read .header') || document;
          const textOf = (node) => (node && node.textContent || '').trim();
          return {
            id: ${JSON.stringify(cleanId)},
            subject: textOf(header.querySelector('.subject')),
            from: textOf(header.querySelector('.sender .value')) || textOf(header.querySelector('.sender')),
            time: textOf(header.querySelector('.time .value')) || textOf(header.querySelector('.time')),
            text: text.slice(0, 250000),
            html: html.slice(0, 750000),
            unread: false,
          };
        })()`,
      );
      return {
        ok: true,
        message: {
          ...detail,
          id: cleanId,
          subject: detail.subject || '(no subject)',
        },
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : 'Could not open the temporary message.',
      };
    }
  });
}

/**
 * Auto-renewal schedules.
 *
 * The renderer registers its saved inboxes while the vault is unlocked, but
 * this scheduler lives in the main process so it keeps running when auto-lock
 * hides the vault. That is the point of the feature: the default app lock is
 * five minutes, shorter than the ten-minute renewal interval. Schedules are
 * dropped when the app quits or the item is removed; they are not persisted,
 * because the session keys live in the encrypted vault and are re-registered
 * on the next unlock.
 */
interface AutoRenewEntry {
  itemId: string;
  mailbox: TempMailbox;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastError: string;
  /**
   * A saved item's expiry only reaches the vault while the renderer is
   * unlocked. If the app quits while locked after a main-process renewal, the
   * stored expiry looks older than the live Mohmal session on next launch.
   * Try one catch-up renewal before treating the vault's timestamp as final.
   */
  catchUpAttempted: boolean;
  /** Backoff after a failed auto-renew, so a 30s sync cannot hammer Mohmal. */
  nextAttemptAt: number;
}

const autoRenewals = new Map<string, AutoRenewEntry>();
const AUTO_RENEW_RETRY_MS = 2 * 60_000;

function clearAutoRenewTimer(entry: AutoRenewEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function scheduleAutoRenew(entry: AutoRenewEntry): void {
  if (entry.mailbox.autoRenewMinutes <= 0) {
    clearAutoRenewTimer(entry);
    return;
  }
  const now = Date.now();
  if (entry.mailbox.expiresAt <= now) {
    // One catch-up attempt per registration, never an endless retry loop for
    // a genuinely dead inbox. Leave an already-pending attempt alone: a sync
    // can arrive inside its one-second delay.
    if (entry.catchUpAttempted) return;
    clearAutoRenewTimer(entry);
    entry.catchUpAttempted = true;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void runAutoRenew(entry);
    }, 1_000);
    return;
  }
  clearAutoRenewTimer(entry);
  entry.catchUpAttempted = false;
  const due = entry.mailbox.lastRenewedAt + entry.mailbox.autoRenewMinutes * 60_000;
  const when = Math.max(due, entry.nextAttemptAt || 0);
  entry.timer = setTimeout(
    () => {
      entry.timer = null;
      void runAutoRenew(entry);
    },
    Math.max(1_000, when - now),
  );
}

async function runAutoRenew(entry: AutoRenewEntry): Promise<void> {
  if (entry.running) return;
  const key = entry.mailbox.sessionKey;
  if (autoRenewals.get(key) !== entry) return;
  if (entry.mailbox.autoRenewMinutes <= 0) return;
  // A timer that fired after a sleep may now be past the stored expiry. Make
  // one attempt anyway, then stop if it fails instead of retrying forever.
  if (entry.mailbox.expiresAt <= Date.now()) entry.catchUpAttempted = true;
  entry.running = true;
  try {
    const result = await renewMohmalMailbox(entry.mailbox.address, key);
    if (autoRenewals.get(key) !== entry) return;
    if (result.ok) {
      entry.mailbox = {
        ...entry.mailbox,
        expiresAt: result.expiresAt,
        lastRenewedAt: result.renewedAt,
      };
      entry.lastError = '';
      entry.catchUpAttempted = false;
      entry.nextAttemptAt = 0;
    } else {
      entry.lastError = result.error;
      entry.nextAttemptAt = Date.now() + AUTO_RENEW_RETRY_MS;
    }
  } catch (cause) {
    if (autoRenewals.get(key) === entry) {
      entry.lastError =
        cause instanceof Error ? cause.message : 'Could not renew the temporary inbox.';
      entry.nextAttemptAt = Date.now() + AUTO_RENEW_RETRY_MS;
    }
  } finally {
    entry.running = false;
    if (autoRenewals.get(key) !== entry) return;
    scheduleAutoRenew(entry);
  }
}

/**
 * Replaces the main-process renewal set with the renderer's current saved
 * inboxes. Returns states the renderer missed while it was locked, plus any
 * one-shot auto-renew errors to surface in a toast.
 */
export function syncTempMailSchedules(schedules: TempMailSchedule[]): TempMailScheduleResult {
  if (!Array.isArray(schedules)) {
    return { ok: false, error: 'Bad temporary-mail schedule.' };
  }
  const incoming = new Map<string, { itemId: string; mailbox: TempMailbox }>();
  for (const schedule of schedules) {
    if (!schedule || typeof schedule.itemId !== 'string' || schedule.itemId === '') continue;
    const mailbox = normaliseTempMailbox(schedule.mailbox);
    if (!mailbox) continue;
    incoming.set(mailbox.sessionKey, { itemId: schedule.itemId, mailbox });
  }

  // Only prune against a non-empty authoritative set. A lock can briefly
  // clear the renderer's decrypted items, and an empty sync must never stop
  // the schedules that are supposed to keep running through that lock.
  if (incoming.size > 0) {
    for (const [key, entry] of autoRenewals) {
      if (incoming.has(key)) continue;
      clearAutoRenewTimer(entry);
      autoRenewals.delete(key);
    }
  }

  const updates: TempMailRenewUpdate[] = [];
  const errors: TempMailScheduleError[] = [];
  for (const [key, next] of incoming) {
    let entry = autoRenewals.get(key);
    if (!entry) {
      entry = {
        itemId: next.itemId,
        mailbox: next.mailbox,
        timer: null,
        running: false,
        lastError: '',
        catchUpAttempted: false,
        nextAttemptAt: 0,
      };
      autoRenewals.set(key, entry);
    } else {
      const current = entry.mailbox;
      const newer = current.lastRenewedAt > next.mailbox.lastRenewedAt;
      entry.itemId = next.itemId;
      // A newer timestamp from the renderer is a manual Renew now that has
      // already succeeded; clear any stale automatic-renew failure with it.
      if (next.mailbox.lastRenewedAt > current.lastRenewedAt) {
        entry.lastError = '';
        entry.catchUpAttempted = false;
        entry.nextAttemptAt = 0;
      }
      entry.mailbox = {
        ...next.mailbox,
        expiresAt: newer ? current.expiresAt : next.mailbox.expiresAt,
        lastRenewedAt: newer ? current.lastRenewedAt : next.mailbox.lastRenewedAt,
      };
    }
    if (!entry.running) scheduleAutoRenew(entry);
    if (entry.mailbox.lastRenewedAt > next.mailbox.lastRenewedAt) {
      updates.push({
        itemId: entry.itemId,
        address: entry.mailbox.address,
        sessionKey: key,
        expiresAt: entry.mailbox.expiresAt,
        lastRenewedAt: entry.mailbox.lastRenewedAt,
      });
    }
    if (entry.lastError) {
      errors.push({
        itemId: entry.itemId,
        address: entry.mailbox.address,
        error: entry.lastError,
      });
      entry.lastError = '';
    }
  }
  return { ok: true, updates, errors };
}

function stopTempMailAutoRenew(): void {
  for (const entry of autoRenewals.values()) clearAutoRenewTimer(entry);
  autoRenewals.clear();
}

/** Explicit reset (vault removed / no disposable inboxes left). */
export function clearTempMailSchedules(): void {
  stopTempMailAutoRenew();
}

/** Called when the app quits; partitions stay on disk so inboxes survive a restart. */
export function destroyTempMailWindows(): void {
  stopTempMailAutoRenew();
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  windows.clear();
}
