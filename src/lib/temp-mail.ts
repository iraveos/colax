/**
 * Temporary inbox metadata and the small, pure rules around it.
 *
 * Mohmal keeps the mailbox itself; Colax stores only the address, when it was
 * made and which hidden browser session owns it. Everything here is
 * renderer-safe so the editor, the login card and the vault normaliser can
 * agree without importing Electron.
 */

export const MOHMAL_LIFETIME_MS = 45 * 60 * 1000;
export const MOHMAL_DEFAULT_RENEW_MINUTES = 10;
/** Renewing later than the lifetime would let the inbox lapse between calls. */
export const MOHMAL_MAX_RENEW_MINUTES = 40;
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
  /**
   * How often Colax should call Mohmal's Renew action. 0 turns the automatic
   * renewal off; the user can still press Renew now.
   */
  autoRenewMinutes: number;
  /** The last successful renewal, for restart catch-up and the next-due label. */
  lastRenewedAt: number;
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

export type TempMailRenewResult =
  | { ok: true; expiresAt: number; renewedAt: number }
  | { ok: false; error: string };

/** One saved inbox handed to the main-process renewal scheduler. */
export interface TempMailSchedule {
  itemId: string;
  mailbox: TempMailbox;
}

export interface TempMailRenewUpdate {
  itemId: string;
  address: string;
  sessionKey: string;
  expiresAt: number;
  lastRenewedAt: number;
}

export interface TempMailScheduleError {
  itemId: string;
  address: string;
  error: string;
}

export type TempMailScheduleResult =
  | { ok: true; updates: TempMailRenewUpdate[]; errors: TempMailScheduleError[] }
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
  const sessionKey =
    typeof record.sessionKey === 'string' && SESSION_KEY_RE.test(record.sessionKey.trim())
      ? record.sessionKey.trim().toLowerCase()
      : '';
  if (!sessionKey) return null;
  const autoRenewMinutes =
    typeof record.autoRenewMinutes === 'number' && Number.isFinite(record.autoRenewMinutes)
      ? Math.max(0, Math.min(MOHMAL_MAX_RENEW_MINUTES, Math.round(record.autoRenewMinutes)))
      : MOHMAL_DEFAULT_RENEW_MINUTES;
  const lastRenewedAt = Math.min(
    Math.max(createdAt, finite(record.lastRenewedAt) ?? createdAt),
    Date.now(),
  );
  // A hand-edited record cannot keep an inbox alive forever, while an inbox
  // renewed for weeks can still carry a legitimate expiry far past createdAt.
  // Mohmal's lifetime from the last successful renewal is the real ceiling.
  const rawExpiry = finite(record.expiresAt);
  const expiresAt =
    rawExpiry !== null && rawExpiry >= lastRenewedAt
      ? Math.min(rawExpiry, lastRenewedAt + MOHMAL_LIFETIME_MS)
      : lastRenewedAt + MOHMAL_LIFETIME_MS;
  return {
    provider: 'mohmal',
    address,
    sessionKey,
    createdAt,
    expiresAt,
    autoRenewMinutes,
    lastRenewedAt,
  };
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

/** When the next automatic renewal is due, or null when it is switched off. */
export function tempMailNextRenewAt(mailbox: TempMailbox): number | null {
  if (mailbox.autoRenewMinutes <= 0) return null;
  return mailbox.lastRenewedAt + mailbox.autoRenewMinutes * 60_000;
}

export function tempMailNextRenewLabel(mailbox: TempMailbox, now = Date.now()): string {
  const next = tempMailNextRenewAt(mailbox);
  if (next === null) return 'Auto-renew is off.';
  const left = next - now;
  if (left <= 0) return 'Renewal is due now.';
  return `Next renewal in ${Math.max(1, Math.ceil(left / 60_000))} min.`;
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
