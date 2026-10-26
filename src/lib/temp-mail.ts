/**
 * Temporary inbox metadata and the small, pure rules around it.
 *
 * Mohmal keeps the mailbox itself; Colax stores only the address, when it was
 * made and which hidden browser session owns it. Everything here is
 * renderer-safe so the editor, the login card and the vault normaliser can
 * agree without importing Electron.
 */

export const MOHMAL_LIFETIME_MS = 45 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;
const MAX_REUSABLE_EMAILS = 100;
const SESSION_KEY_RE = /^[a-f0-9]{16,64}$/i;

/** A disposable inbox attached to one login. */
export interface TempMailbox {
  provider: 'mohmal';
  address: string;
  /** Random id for the hidden browser partition that holds the Mohmal session. */
  sessionKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface TempMailMessage {
  id: string;
  subject: string;
  from: string;
  time: string;
  unread: boolean;
}

export interface TempMailDetail extends TempMailMessage {
  text: string;
  html: string;
}

export type TempMailCreateResult =
  | { ok: true; mailbox: TempMailbox }
  | { ok: false; error: string };

export type TempMailListResult =
  | { ok: true; messages: TempMailMessage[]; expiresAt: number | null }
  | { ok: false; error: string };

export type TempMailReadResult =
  | { ok: true; message: TempMailDetail }
  | { ok: false; error: string };

/** A deliberately small check: this is a mailbox address, not a validator. */
export function isEmailLike(value: string): boolean {
  const address = value.trim();
  return address.length > 3 && address.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalises a stored temp mailbox. A record from before this feature reads as
 * absent; a half-written one keeps its address and gets a safe lifetime rather
 * than breaking the whole vault load.
 */
export function normaliseTempMailbox(raw: unknown): TempMailbox | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.provider !== 'mohmal') return null;
  const address = typeof record.address === 'string' ? record.address.trim().toLowerCase() : '';
  if (!isEmailLike(address)) return null;
  const createdAt = finite(record.createdAt) ?? Date.now();
  const suggestedExpiry = finite(record.expiresAt) ?? createdAt + MOHMAL_LIFETIME_MS;
  // Never trust a hand-edited record to keep an inbox alive forever.
  const expiresAt = Math.min(
    Math.max(suggestedExpiry, createdAt),
    createdAt + 24 * 60 * 60 * 1000,
  );
  const sessionKey =
    typeof record.sessionKey === 'string' && SESSION_KEY_RE.test(record.sessionKey.trim())
      ? record.sessionKey.trim().toLowerCase()
      : '';
  if (!sessionKey) return null;
  return { provider: 'mohmal', address, sessionKey, createdAt, expiresAt };
}

export function tempMailIsExpired(mailbox: TempMailbox, now = Date.now()): boolean {
  return mailbox.expiresAt <= now;
}

/** Makes a compact "24 min left" label for the editor/status line. */
export function tempMailRemainingLabel(mailbox: TempMailbox, now = Date.now()): string {
  const left = mailbox.expiresAt - now;
  if (left <= 0) return 'expired';
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return `${minutes} min left`;
}

/**
 * Reusable email addresses: deduplicated case-insensitively, trimmed and
 * capped. The first spelling wins so a user's capitalisation is preserved.
 */
export function normaliseReusableEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const address = value.trim();
    if (!isEmailLike(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
    if (out.length >= MAX_REUSABLE_EMAILS) break;
  }
  return out;
}

/** Picks a saved address, preferring not to hand back the one already shown. */
export function pickReusableEmail(
  emails: readonly string[],
  current = '',
  random: () => number = Math.random,
): string {
  const pool = normaliseReusableEmails(emails);
  if (pool.length === 0) return '';
  const currentKey = current.trim().toLowerCase();
  const fresh = pool.filter((address) => address.toLowerCase() !== currentKey);
  const choices = fresh.length > 0 ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)));
  return choices[index] ?? '';
}
