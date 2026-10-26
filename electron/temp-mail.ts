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
  MOHMAL_LIFETIME_MS,
  isEmailLike,
  normaliseTempMailbox,
  type TempMailCreateResult,
  type TempMailDetail,
  type TempMailListResult,
  type TempMailMessage,
  type TempMailReadResult,
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

/** Called when the app quits; partitions stay on disk so inboxes survive a restart. */
export function destroyTempMailWindows(): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  windows.clear();
}
