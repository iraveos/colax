import type { SealedBlob } from '../crypto/vault-crypto.ts';
import { normaliseSecurity, type LoginSecurity } from '../crypto/security.ts';
import { estimateStrength } from '../crypto/passwords.ts';
import { normaliseSharedLink, type SharedLink } from '../lib/shares.ts';
import { normaliseTempMailbox, type TempMailbox } from '../lib/temp-mail.ts';

/** What actually sits in storage: the id in the clear, everything else as ciphertext. */
export interface StoredItem {
  id: string;
  blob: SealedBlob;
  updatedAt: number;
}

/** A decrypted credential. Only ever held in memory while the vault is unlocked. */
export interface VaultItem {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  /**
   * Plain-text form of the notes. Always present, even when `notesHtml` holds
   * the formatted version: cards, search, clipboard exports and the history
   * list all read this field and must never see markup.
   */
  notes: string;
  /**
   * The formatted notes as sanitised HTML, when the user pasted or typed
   * formatting. Absent on records written before rich notes existed; those
   * fall back to the plain `notes` text.
   */
  notesHtml: string;
  totpSecret: string;
  favorite: boolean;

  /**
   * Marks the login as needing attention. Separate from `favorite`: a favorite
   * is something you like, this is something you should deal with.
   */
  needsAttention: boolean;

  /**
   * Whether this login shows its message expander. Opt-in per login: new
   * logins start with it off, so connecting a mailbox for one login does not
   * put a Messages button on every other login. Older records that predate
   * the toggle keep showing mail (see normaliseItem) rather than silently
   * losing it.
   */
  showMail: boolean;

  /**
   * Which messages the expander shows. 'auto' matches the login's email and
   * falls back to recent mail; 'matched' shows only matches (possibly none);
   * 'recent' skips matching and shows everything recent. Chosen per login in
   * its editor. Older records default to 'auto', preserving their behavior.
   */
  mailFilter: 'auto' | 'matched' | 'recent';

  /**
   * A Mohmal disposable inbox created from this login's email field. The
   * address, its lifetime and the hidden browser-session key ride in the
   * encrypted item blob; the actual site cookie stays in Electron's partition
   * storage. Absent on logins without a temporary address.
   */
  tempMail: TempMailbox | null;

  /**
   * Present when this login was imported from someone else's share. It keeps
   * the source link so later syncs can update the copy, and so the UI can say
   * where it came from and whether the share has ended.
   */
  shareLink: SharedLink | null;

  /** Ids from the global tag catalogue. Ids rather than names so a tag can be renamed or recoloured everywhere at once. */
  tags: string[];

  /**
   * Media pasted or dropped into the login's notes: photos, GIFs, short
   * screen recordings. Rides inside the encrypted item blob like the rest of
   * the fields — unlike card art, pasted media is kept verbatim, because
   * re-encoding through a canvas would flatten animated GIFs. See the caps
   * below, and `historySnapshot` in storage.ts for why it never copies into
   * the history log.
   */
  attachments: VaultAttachment[];

  /**
   * Optional second factor for this one credential: a TOTP seed and/or
   * recovery questions. Entirely opt-in per login.
   *
   * Lives inside the encrypted blob, so a question's hashed answer and the TOTP
   * seed are as protected as the password itself.
   */
  security: LoginSecurity;

  /**
   * Per-login accent hue. When null the colour is derived from the title, so a
   * login keeps the same identity without anyone having to pick one.
   */
  accentHue: number | null;

  /**
   * Card background: either a remote https URL or a data URL from an upload.
   * Stored inside the encrypted item, so it never leaves the device unencrypted.
   */
  backgroundImage: string;
  backgroundBlur: number;

  /**
   * Avatar image, independent of the card background. A logo reads far better at
   * 40px than a photo, and keeping the two separate lets a login have both.
   */
  avatarImage: string;

  createdAt: number;
  updatedAt: number;
  /** When the password last changed. Drives the "old password" warning. */
  passwordUpdatedAt: number;
  /** When the email or username last changed. */
  usernameUpdatedAt: number;
  /**
   * Rotation reminder for this login alone, in days — fractional, so minutes
   * and hours work too (15 minutes is 15/1440). 0 follows the global "flag
   * stale passwords" setting; anything else overrides it here only. Set in
   * the login editor's Reminders section — presets or any manual count.
   */
  reminderDays: number;
}

/**
 * Uploads are re-encoded before storage (see readImageFile), so these caps apply
 * to the *compressed* result. They are generous because a downscaled photo is
 * only tens of kilobytes, but still bounded so a vault cannot be filled with
 * megabytes of base64.
 */
export const MAX_BACKGROUND_BYTES = 2_000_000;
/** Icons render at 40-52px, so a much smaller cap is plenty. */
export const MAX_AVATAR_BYTES = 120_000;
export const MAX_APP_BACKGROUND_BYTES = 8_000_000;

/** Longest edge kept when downscaling an upload, in CSS pixels. */
export const MAX_IMAGE_EDGE = 1600;

/**
 * One piece of media or file attached to a login's notes. `dataUrl` is always
 * `data:<mime>;base64,…`, which is what the renderer can show or download
 * directly. `name` is present on files attached by newer builds; older media
 * records have only the mime to go on.
 */
export interface VaultAttachment {
  id: string;
  mime: string;
  dataUrl: string;
  name?: string;
}

/**
 * Notes-attachment caps. Pasted media is stored verbatim — canvas re-encoding
 * destroys animated GIFs — so these bind the data URLs instead: base64 adds a
 * third again to the raw bytes, which `attachmentBytes` accounts for. The
 * generous budgets are bounded by the item being re-sealed and re-synced as a
 * whole on every edit, so one login with attachments must not become the vault.
 */
export const MAX_NOTE_ATTACHMENT_BYTES = 4_000_000;
export const MAX_NOTE_ATTACHMENTS = 12;
/** The whole item's media budget, so no single login can hold the vault. */
export const MAX_NOTE_MEDIA_BYTES = 20_000_000;

/** Images (GIFs included) and short videos; these get a preview, other files a download chip. */
export function isNoteMediaMime(mime: string): boolean {
  if (typeof mime !== 'string') return false;
  return mime.startsWith('image/') || mime.startsWith('video/');
}

/** Approximate original size of a `data:<mime>;base64,…` URL, in bytes. */
export function attachmentBytes(dataUrl: string): number {
  const base64Start = dataUrl.indexOf(',') + 1;
  if (dataUrl.indexOf(';base64,') === -1 || base64Start < 1) return 0;
  // Base64 turns three bytes into four chars; the padding correction is not
  // worth the round-trip on an approximate budget.
  return Math.floor(((dataUrl.length - base64Start) * 3) / 4);
}

/** The media budget one more attachment has room for on top of `current`. */
export function noteMediaBudget(
  current: readonly VaultAttachment[],
): { slots: number; bytes: number } | null {
  const used = current.reduce((sum, attachment) => sum + attachmentBytes(attachment.dataUrl), 0);
  const slots = MAX_NOTE_ATTACHMENTS - current.length;
  const bytes = MAX_NOTE_MEDIA_BYTES - used;
  return slots > 0 && bytes > 0 ? { slots, bytes } : null;
}

/**
 * Drops malformed, unsupported or over-budget attachments when a record is
 * read back (normaliseItem). An old build, a hand-edited vault or a future
 * format change can smuggle anything into the array — this is the one place
 * every load walks through, so the renderer below it only ever sees shapes it
 * can show or download.
 */
export function normaliseNoteAttachments(raw: unknown): VaultAttachment[] {
  if (!Array.isArray(raw)) return [];
  const kept: VaultAttachment[] = [];
  let used = 0;
  for (const entry of raw) {
    if (kept.length >= MAX_NOTE_ATTACHMENTS) break;
    const candidate = entry as Partial<VaultAttachment> | null;
    const dataUrl = typeof candidate?.dataUrl === 'string' ? candidate.dataUrl : '';
    const mime = typeof candidate?.mime === 'string' ? candidate.mime : '';
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mime) ||
      !dataUrl.startsWith(`data:${mime};base64,`)
    ) {
      continue;
    }
    const bytes = attachmentBytes(dataUrl);
    if (bytes === 0 || bytes > MAX_NOTE_ATTACHMENT_BYTES || used + bytes > MAX_NOTE_MEDIA_BYTES) {
      continue;
    }
    const name =
      typeof candidate.name === 'string'
        ? candidate.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180)
        : '';
    kept.push({ id: candidate.id, mime, dataUrl, ...(name ? { name } : {}) });
    used += bytes;
  }
  return kept;
}

export function emptyItem(id: string, now: number = Date.now()): VaultItem {
  return {
    id,
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    notesHtml: '',
    totpSecret: '',
    // Opt-in: a login with no security block is not nagged, and does not have
    // to stop working without one.
    security: { totp: null, questions: [] },
    favorite: false,
    needsAttention: false,
    // Off by default, and deliberately so. Mail is per login: connecting a
    // mailbox for one login used to switch the Messages button on for every
    // login, so five unrelated logins all loaded the same mailbox's messages.
    // The login a mailbox belongs to still shows its mail without asking —
    // `loginShowsMail` reads the linked case as on — so the connection the
    // user actually made keeps working; everything else is opted in by hand in
    // the editor's Inbox section, next to the control that connected it.
    showMail: false,
    mailFilter: 'auto',
    tempMail: null,
    shareLink: null,
    tags: [],
    attachments: [],
    accentHue: null,
    backgroundImage: '',
    backgroundBlur: 0,
    avatarImage: '',
    createdAt: now,
    updatedAt: now,
    passwordUpdatedAt: now,
    usernameUpdatedAt: now,
    reminderDays: 0,
  };
}

/** Coerces a stored record from an older build into the current shape. */
export function normaliseItem(raw: Partial<VaultItem> & { id: string }, now: number = Date.now()): VaultItem {
  const created = typeof raw.createdAt === 'number' ? raw.createdAt : now;
  return {
    ...emptyItem(raw.id, created),
    ...raw,
    createdAt: created,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : created,
    passwordUpdatedAt: typeof raw.passwordUpdatedAt === 'number' ? raw.passwordUpdatedAt : created,
    usernameUpdatedAt: typeof raw.usernameUpdatedAt === 'number' ? raw.usernameUpdatedAt : created,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    notesHtml: typeof raw.notesHtml === 'string' ? raw.notesHtml : '',
    shareLink: normaliseSharedLink(raw.shareLink),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    // Pasted notes-media is validated rather than trusted: old builds and
    // hand-edited vaults can carry anything in the array.
    attachments: normaliseNoteAttachments(raw.attachments),
    needsAttention: Boolean(raw.needsAttention),
    // Opt-out for the *linked* login (its username is a connected mailbox's
    // address), opt-in for everything else — see `loginShowsMail`. A record
    // saved before the field existed reads as on: that record predates the
    // per-login idea entirely, and the one-time linked-only pass is what
    // switches the unrelated logins off, so a legacy `true` is never re-read as
    // a choice. Only *new* logins start switched off (see emptyItem).
    showMail: typeof raw.showMail === 'boolean' ? raw.showMail : true,
    mailFilter: raw.mailFilter === 'matched' || raw.mailFilter === 'recent' ? raw.mailFilter : 'auto',
    tempMail: normaliseTempMailbox(raw.tempMail),
    accentHue: typeof raw.accentHue === 'number' ? raw.accentHue : null,
    reminderDays:
      typeof raw.reminderDays === 'number' && Number.isFinite(raw.reminderDays)
        ? Math.max(0, Math.round(raw.reminderDays * 1e6) / 1e6)
        : 0,
    // Records saved before security existed have none. Normalised to the empty
    // shape rather than left undefined so callers never branch on it.
    // Shared helper, so a new factor cannot be forgotten here the way passcode
    // was: it used to be rebuilt inline without passcode, silently unprotecting
    // passcode-only logins on reload.
    security: normaliseSecurity(raw.security),
  };
}

/** Human-friendly relative age, e.g. "3 days ago". */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  // Mail feeds and hand-edited dates can carry unparseable timestamps, and
  // every comparison below is false for NaN — without this the function falls
  // through to "NaN minutes ago" territory. Empty renders as nothing, which is
  // what an unknown date should look like.
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const units: [number, string][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86_400, 'hour'],
    [604_800, 'day'],
    [2_629_800, 'week'],
    [31_557_600, 'month'],
    [315_576_000, 'year'],
  ];
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  // Hours, not minutes. "120 minutes ago" is the same fact as "2 hours ago"
  // written in a way nobody says.
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  // Past a day, round "3 days ago" down to two units: knowing it is three days
  // old is the useful part, and the hour only matters when it is close enough
  // to be worth acting on.
  if (seconds >= 86_400) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const dayPart = `${days} day${days === 1 ? '' : 's'}`;
    if (days < 30) {
      if (hours === 0) return `${dayPart} ago`;
      return `${dayPart} ${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    // A month as a flat 30 days rather than the average 30.44. Averaging leaves
    // a remainder that is off by one against how people count months, which
    // reads as a bug in a value the user is meant to trust.
    const months = Math.floor(days / 30);
    const restDays = days - months * 30;
    return `${months} month${months === 1 ? '' : 's'}${restDays > 0 ? ` ${restDays} day${restDays === 1 ? '' : 's'}` : ''} ago`;
  }

  let chosen: [number, string] = units[0]!;
  for (const unit of units) if (seconds >= unit[0]) chosen = unit;
  const divisor = chosen === units[0] ? 1 : units[units.indexOf(chosen) - 1]![0];
  const value = Math.round(seconds / divisor);
  return `${value} ${chosen[1]}${value === 1 ? '' : 's'} ago`;
}

/** `YYYY-MM-DD` in local time, for `<input type="date">`. */
export function toDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function fromDateInput(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T12:00:00`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Stable hue for a label, so a login's colour never changes between loads. */
export function hueFor(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** The accent hue to render this login with, preferring an explicit choice. */
export function accentOf(item: VaultItem): number {
  if (typeof item.accentHue === 'number' && Number.isFinite(item.accentHue)) {
    return ((item.accentHue % 360) + 360) % 360;
  }
  return hueFor(item.title || item.username || item.url || 'aegis');
}

/** Only http(s) and inline images are allowed, so a login cannot smuggle in markup. */
export function isAllowedImageSrc(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('data:image/')) return true;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Hostname for favicon lookups and the "open site" link. */
export function hostnameOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname || null;
  } catch {
    return null;
  }
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`;
}

/** Reused passwords and long-untouched passwords are the two things worth surfacing. */
/**
 * Logins with a password problem: reused, stale, low-strength, or following
 * the same pattern (summer2023/summer2024 and friends).
 *
 * Strength and pattern are checked here — not just reuse and age — because a
 * unique, fresh "Password1" is still a bad password and the Weak channel
 * should say so. Pattern matching strips digits and case first, so rotations
 * that only bump a number still group together; stems under 4 characters are
 * skipped so "a1"/"a2" do not flag every short password as a family.
 */
export function findWeakItems(items: VaultItem[], staleAfterDays = 180): VaultItem[] {
  const usage = new Map<string, number>();
  const patterns = new Map<string, number>();
  for (const item of items) {
    if (!item.password) continue;
    usage.set(item.password, (usage.get(item.password) ?? 0) + 1);
    const stem = patternStem(item.password);
    if (stem) patterns.set(stem, (patterns.get(stem) ?? 0) + 1);
  }
  return items.filter((item) => {
    if (item.password === '') return false;
    if ((usage.get(item.password) ?? 0) > 1) return true;
    const threshold = staleDaysFor(item, staleAfterDays);
    if (threshold > 0 && item.passwordUpdatedAt < Date.now() - threshold * 86_400_000) return true;
    if (estimateStrength(item.password).score <= 1) return true;
    const stem = patternStem(item.password);
    if (stem && (patterns.get(stem) ?? 0) > 1) return true;
    return false;
  });
}

/** Lowercased digits-stripped stem, or '' when too short to mean anything. */
function patternStem(password: string): string {
  const stem = password.toLowerCase().replace(/[0-9]+/g, '');
  return stem.length >= 4 ? stem : '';
}

/**
 * True when the password itself is guessable, regardless of reuse or age.
 * Empty means "no password", not "weak" — an empty field must never earn a
 * badge, or every login-in-progress would flash warnings while being typed.
 */
export function isWeakPassword(item: Pick<VaultItem, 'password'>): boolean {
  return item.password !== '' && estimateStrength(item.password).score <= 1;
}

/**
 * Days before this login's password counts as stale: its own reminder when
 * set, else the global setting. Every stale check in the app goes through
 * here so the editor's per-login choice is honored everywhere at once.
 */
export function staleDaysFor(item: Pick<VaultItem, 'reminderDays'>, globalDays: number): number {
  return item.reminderDays > 0 ? item.reminderDays : globalDays;
}

/** Passwords used by more than one login. Keyed by password so callers can match on `item.password`. */
export function findReusedPasswords(items: VaultItem[]): Set<string> {
  const usage = new Map<string, number>();
  for (const item of items) {
    if (!item.password) continue;
    usage.set(item.password, (usage.get(item.password) ?? 0) + 1);
  }
  return new Set([...usage.entries()].filter(([, count]) => count > 1).map(([password]) => password));
}