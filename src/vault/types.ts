import type { SealedBlob } from '../crypto/vault-crypto.ts';
import { normaliseSecurity, type LoginSecurity } from '../crypto/security.ts';
import { estimateStrength } from '../crypto/passwords.ts';

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
  notes: string;
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

  /** Ids from the global tag catalogue. Ids rather than names so a tag can be renamed or recoloured everywhere at once. */
  tags: string[];

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

export function emptyItem(id: string, now: number = Date.now()): VaultItem {
  return {
    id,
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    totpSecret: '',
    // Opt-in: a login with no security block is not nagged, and does not have
    // to stop working without one.
    security: { totp: null, questions: [] },
    favorite: false,
    needsAttention: false,
    // On by default: a connected mailbox is no use if no login offers a way
    // into it. A login that should stay quiet is switched off in the editor.
    showMail: true,
    mailFilter: 'auto',
    tags: [],
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
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    needsAttention: Boolean(raw.needsAttention),
    // Per-login *opt-out*: every login shows the Messages button, and only an
    // explicit false hides it. Records saved before the toggle existed carry no
    // field at all, which now means the same thing as on.
    showMail: typeof raw.showMail === 'boolean' ? raw.showMail : true,
    mailFilter: raw.mailFilter === 'matched' || raw.mailFilter === 'recent' ? raw.mailFilter : 'auto',
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