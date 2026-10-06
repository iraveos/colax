import type { SealedBlob } from '../crypto/vault-crypto.ts';
import type { LoginSecurity } from '../crypto/security.ts';

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
    tags: [],
    accentHue: null,
backgroundImage: '',
  backgroundBlur: 0,
  avatarImage: '',
  createdAt: now,
    updatedAt: now,
    passwordUpdatedAt: now,
    usernameUpdatedAt: now,
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
    accentHue: typeof raw.accentHue === 'number' ? raw.accentHue : null,
    // Records saved before security existed have none. Normalised to the empty
    // shape rather than left undefined so callers never branch on it.
    security: {
      totp: raw.security?.totp?.seed ? { seed: String(raw.security.totp.seed) } : null,
      questions: Array.isArray(raw.security?.questions)
        ? raw.security.questions
            .filter((question): question is NonNullable<typeof question> => Boolean(question && question.hash))
            .map((question) => ({
              id: String(question.id ?? randomId()),
              prompt: String(question.prompt ?? ''),
              hash: String(question.hash),
              salt: String(question.salt ?? ''),
            }))
        : [],
    },
  };
}

/** Fallback id for a question saved before questions carried one. */
function randomId(): string {
  return `sq_${Math.random().toString(36).slice(2, 10)}`;
}

/** Human-friendly relative age, e.g. "3 days ago". */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
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
export function findWeakItems(items: VaultItem[], staleAfterDays = 180): VaultItem[] {
  const cutoff = Date.now() - staleAfterDays * 86_400_000;
  const usage = new Map<string, number>();
  for (const item of items) {
    if (!item.password) continue;
    usage.set(item.password, (usage.get(item.password) ?? 0) + 1);
  }
  return items.filter(
    (item) =>
      (item.password !== '' && (usage.get(item.password) ?? 0) > 1) ||
      (item.password !== '' && item.passwordUpdatedAt < cutoff),
  );
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