/**
 * The Optimize tab's vocabulary, kept out of the UI on purpose.
 *
 * The panel, its one-click profiles, the saved profiles below and the counter
 * that reads "n of 10" all used to be three separate lists of the same thing,
 * which is how a counter ends up disagreeing with the switches it counts. Here
 * there is exactly one definition of each: `OPTIMISATIONS` is the single source
 * for what the rows read, `styleFromPrefs`/`stylePatch` convert between a
 * preference record and a profile, and the preset styles are the named buttons.
 *
 * Everything a profile holds is a real, existing preference. Nothing here is a
 * parallel "performance mode" flag, so applying a profile cannot leave the app
 * in a state the rest of the app does not already understand.
 */

// Type-only on purpose: this module is imported *by* storage.ts to normalise
// the stored profiles, so a runtime import back into storage.ts would be a
// cycle whose module-level constants could evaluate before the defaults exist.
import type { Density, VaultPreferences } from './storage.ts';

/** The shipped card depth. Mirrored from storage's defaults, which import the
 *  full-detail style below for these same fields, so the two cannot drift. */
const DEFAULT_CARD_DEPTH = 0.4;
const DEFAULT_BACKGROUND = { opacity: 0.35, blur: 0, dim: 0.25 };

/**
 * The preference fields the Optimize tab and its profiles own.
 *
 * A profile stores these and nothing else: applying one can change how the app
 * looks and how often it polls mail, never a login, tag, channel or mailbox.
 */
export interface OptimizeStyle {
  motion: number;
  motionSpeed: number;
  /** The small transitions on buttons, chips, tabs, rows and badges. */
  microMotion: boolean;
  ambient: number;
  reduceTransparency: boolean;
  density: Density;
  cardDepth: number;
  backgroundImage: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundDim: number;
  /**
   * Seconds between automatic mail checks for every connected mailbox, or null
   * to leave polling exactly as the user set it. A profile that always wrote a
   * number would silently rewrite mailboxes the user had deliberately set to
   * "Off".
   */
  mailRefreshSeconds: number | null;
  /**
   * Whether opening an HTML message also fetches its inline images.
   *
   * The largest per-message memory saving available: the reader skips up to
   * four images of 512 KB each. Counted as its own optimisation for the same
   * reason `disableSpellcheck` is — a profile that did not carry it would
   * leave the saving behind every time it was applied.
   */
  mailInlineImages: boolean;
  /**
   * Switches Chromium's spellchecker (and its per-language dictionaries) off.
   * Not appearance, but it is the same kind of trade, and a profile that did
   * not carry it would leave one saving behind every time it was applied.
   */
  disableSpellcheck: boolean;
}

export interface OptimizeProfile {
  id: string;
  name: string;
  createdAt: number;
  style: OptimizeStyle;
}

/** What the app looks like with nothing traded away. Also the "restore" target. */
export const FULL_DETAIL_STYLE: OptimizeStyle = {
  motion: 1,
  // The shipped animation speed, at the top of its slider ("Instant"). Kept in
  // step with DEFAULT_PREFERENCES so "restore my look" restores the speed the
  // app ships with rather than half-speed.
  motionSpeed: 2,
  microMotion: true,
  ambient: 1,
  reduceTransparency: false,
  density: 'comfortable',
  cardDepth: DEFAULT_CARD_DEPTH,
  backgroundImage: '',
  backgroundOpacity: DEFAULT_BACKGROUND.opacity,
  backgroundBlur: DEFAULT_BACKGROUND.blur,
  backgroundDim: DEFAULT_BACKGROUND.dim,
  mailRefreshSeconds: null,
  mailInlineImages: true,
  disableSpellcheck: false,
};

/** Halfway: less motion, flatter, and mail on a 5-minute cadence. */
export const BALANCED_STYLE: OptimizeStyle = {
  ...FULL_DETAIL_STYLE,
  motion: 0.4,
  // 1 — the app's normal pace. This used to be 0.6, which stretched every
  // transition *at the same time as* cutting animation: the profile was called
  // "Balanced" and felt like a slow-motion mode.
  motionSpeed: 1,
  // The small transitions stay: they are what the profile is trading down from,
  // and they cost a few frames per interaction rather than per second.
  microMotion: true,
  ambient: 0.3,
  reduceTransparency: true,
  cardDepth: 0.4,
  mailRefreshSeconds: 300,
};

/**
 * Everything off: no motion at all, no ambient gradient, no blur, flat compact
 * cards, 15-minute mail.
 *
 * `motionSpeed` is pinned at the fastest setting rather than the slowest — with
 * `motion: 0` there is nothing left to slow down, but the value is what a user
 * sees if they switch motion back on from here, and it used to be 0.25
 * ("Languid"), so the profile could hand back a slower app than it found.
 */
export const MAX_SAVINGS_STYLE: OptimizeStyle = {
  ...FULL_DETAIL_STYLE,
  motion: 0,
  motionSpeed: 2,
  microMotion: false,
  ambient: 0,
  reduceTransparency: true,
  density: 'compact',
  cardDepth: 0,
  mailRefreshSeconds: 900,
  mailInlineImages: false,
  disableSpellcheck: true,
};

/** How long a mailbox may go between automatic checks and still count as leaned on. */
const SLOW_MAIL_SECONDS = 300;

/**
 * The switches the panel renders, in the order it renders them.
 *
 * `on` reads the preference its row writes, and `visible` decides whether the
 * row exists at all — so the readout, the toggles and the presets cannot drift
 * apart. `background` is visible whenever there is a picture to remove AND when
 * there is not, because "no full-bleed photo is being repainted every frame" is
 * a real saving either way and hiding the row made the counter look broken.
 */
export const OPTIMISATIONS = [
  { id: 'motion', on: (prefs: VaultPreferences) => prefs.motion <= 0.001 },
  // Micro-animations are counted here as their own saving: they are the only
  // animation left when `motion` is off, so a profile cannot call itself "max"
  // while still painting transitions on every hover.
  { id: 'micro', on: (prefs: VaultPreferences) => !prefs.microMotion },
  { id: 'ambient', on: (prefs: VaultPreferences) => prefs.ambient <= 0.05 },
  { id: 'transparency', on: (prefs: VaultPreferences) => prefs.reduceTransparency },
  { id: 'density', on: (prefs: VaultPreferences) => prefs.density === 'compact' },
  { id: 'cards', on: (prefs: VaultPreferences) => prefs.cardDepth <= 0.05 },
  {
    // Either nothing polls (no mailbox connected), or everything polls slowly.
    // Counting "no mailboxes" as *off* was the last way the total stayed out of
    // reach on a fresh install: there is no background mail cost to save, so the
    // saving is real and the row says so — switched on and locked.
    id: 'mail',
    on: (prefs: VaultPreferences) =>
      prefs.gmailAccounts.length === 0 ||
      prefs.gmailAccounts.every((account) => account.refreshSeconds >= SLOW_MAIL_SECONDS),
  },
  { id: 'background', on: (prefs: VaultPreferences) => prefs.backgroundImage === '' },
  {
    // Skipped inline images are the biggest per-message saving on offer — a
    // couple of megabytes of base64 that would otherwise sit in memory for
    // the rest of the session — so the switch counts like any other.
    id: 'mailImages',
    on: (prefs: VaultPreferences) => !prefs.mailInlineImages,
  },
  { id: 'spellcheck', on: (prefs: VaultPreferences) => prefs.disableSpellcheck },
] as const;

export const OPTIMISATION_COUNT = OPTIMISATIONS.length;

/** How many of those switches are on right now. */
export function optimisationsOn(prefs: VaultPreferences): number {
  return OPTIMISATIONS.filter((entry) => entry.on(prefs)).length;
}

/** The style a preference record currently describes. */
export function styleFromPrefs(prefs: VaultPreferences): OptimizeStyle {
  return {
    motion: prefs.motion,
    motionSpeed: prefs.motionSpeed,
    microMotion: prefs.microMotion,
    ambient: prefs.ambient,
    reduceTransparency: prefs.reduceTransparency,
    density: prefs.density,
    cardDepth: prefs.cardDepth,
    backgroundImage: prefs.backgroundImage,
    backgroundOpacity: prefs.backgroundOpacity,
    backgroundBlur: prefs.backgroundBlur,
    backgroundDim: prefs.backgroundDim,
    mailRefreshSeconds: null,
    mailInlineImages: prefs.mailInlineImages,
    disableSpellcheck: prefs.disableSpellcheck,
  };
}

/**
 * A style that describes the whole current look, including the mail cadence
 * when every mailbox shares one. Used to snapshot what was there *before* a
 * savings preset, so "Restore my look" puts the cadence back too instead of
 * leaving mailboxes stretched to a cadence the user never chose.
 */
export function snapshotStyle(prefs: VaultPreferences): OptimizeStyle {
  const style = styleFromPrefs(prefs);
  const cadences = prefs.gmailAccounts.map((account) => account.refreshSeconds);
  const first = cadences[0];
  style.mailRefreshSeconds =
    cadences.length > 0 && typeof first === 'number' && cadences.every((value) => value === first) ? first : null;
  return style;
}

/**
 * The preference patch that puts a style back.
 *
 * The mail cadence is applied to the accounts that exist rather than stored as
 * a number the app would have to consult on every poll, so what the Optimize
 * panel shows in the mailbox rows is what actually happens.
 */
export function stylePatch(prefs: VaultPreferences, style: OptimizeStyle): Partial<VaultPreferences> {
  const patch: Partial<VaultPreferences> = {
    motion: style.motion,
    motionSpeed: style.motionSpeed,
    microMotion: style.microMotion,
    ambient: style.ambient,
    reduceTransparency: style.reduceTransparency,
    density: style.density,
    cardDepth: style.cardDepth,
    backgroundImage: style.backgroundImage,
    backgroundOpacity: style.backgroundOpacity,
    backgroundBlur: style.backgroundBlur,
    backgroundDim: style.backgroundDim,
    mailInlineImages: style.mailInlineImages,
    disableSpellcheck: style.disableSpellcheck,
  };
  if (style.mailRefreshSeconds !== null && prefs.gmailAccounts.length > 0) {
    patch.gmailAccounts = prefs.gmailAccounts.map((account) => ({
      ...account,
      refreshSeconds: style.mailRefreshSeconds as number,
    }));
  }
  return patch;
}

/** Two styles are the same when every field a profile owns matches. */
export function sameStyle(a: OptimizeStyle, b: OptimizeStyle): boolean {
  return (
    a.motion === b.motion &&
    a.motionSpeed === b.motionSpeed &&
    a.microMotion === b.microMotion &&
    a.ambient === b.ambient &&
    a.reduceTransparency === b.reduceTransparency &&
    a.density === b.density &&
    a.cardDepth === b.cardDepth &&
    a.backgroundImage === b.backgroundImage &&
    a.backgroundOpacity === b.backgroundOpacity &&
    a.backgroundBlur === b.backgroundBlur &&
    a.backgroundDim === b.backgroundDim &&
    a.mailRefreshSeconds === b.mailRefreshSeconds &&
    a.mailInlineImages === b.mailInlineImages &&
    a.disableSpellcheck === b.disableSpellcheck
  );
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Reads one stored style, field by field.
 *
 * Every number is clamped to the range its slider allows and every enum is
 * checked, so a hand-edited or truncated record restores a usable look instead
 * of a broken one. A style written by an older build that lacks a field still
 * loads: the missing field falls back to full detail.
 */
export function readStyle(raw: unknown): OptimizeStyle | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<Record<keyof OptimizeStyle, unknown>>;
  const density: Density =
    record.density === 'compact' || record.density === 'spacious' ? record.density : 'comfortable';
  const mailRaw = record.mailRefreshSeconds;
  return {
    motion: clamp(record.motion, 0, 1, FULL_DETAIL_STYLE.motion),
    motionSpeed: clamp(record.motionSpeed, 1, 2, FULL_DETAIL_STYLE.motionSpeed),
    // A profile saved before this switch existed has no field; it restores the
    // full-detail behavior (on) rather than silently turning animations off.
    microMotion: record.microMotion !== false,
    ambient: clamp(record.ambient, 0, 1, FULL_DETAIL_STYLE.ambient),
    reduceTransparency: record.reduceTransparency === true,
    density,
    cardDepth: clamp(record.cardDepth, 0, 1, FULL_DETAIL_STYLE.cardDepth),
    // Only ever a data URL or an https URL: the same rule the appearance
    // settings enforce, re-checked here because a profile travels in backups.
    backgroundImage:
      typeof record.backgroundImage === 'string' &&
      (record.backgroundImage === '' ||
        record.backgroundImage.startsWith('data:image/') ||
        /^https?:\/\//i.test(record.backgroundImage))
        ? record.backgroundImage
        : '',
    backgroundOpacity: clamp(record.backgroundOpacity, 0, 1, FULL_DETAIL_STYLE.backgroundOpacity),
    backgroundBlur: clamp(record.backgroundBlur, 0, 40, FULL_DETAIL_STYLE.backgroundBlur),
    backgroundDim: clamp(record.backgroundDim, 0, 0.9, FULL_DETAIL_STYLE.backgroundDim),
    mailRefreshSeconds:
      typeof mailRaw === 'number' && Number.isFinite(mailRaw) && mailRaw >= 0
        ? Math.min(3600, Math.round(mailRaw))
        : null,
    // A profile saved before this switch existed has no field; it restores
    // the full-detail behaviour (images fetched) rather than silently
    // stripping the pictures out of every message.
    mailInlineImages: record.mailInlineImages !== false,
    disableSpellcheck: record.disableSpellcheck === true,
  };
}

/** Up to this many profiles; the list is a menu, not an archive. */
export const MAX_OPTIMIZE_PROFILES = 12;
const MAX_PROFILE_NAME = 40;

export function newOptimizeProfileId(): string {
  return `opt_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;
}

/** Trims and bounds a profile name, refusing to return an empty one. */
export function cleanProfileName(name: string, fallback = 'Untitled look'): string {
  const trimmed = name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROFILE_NAME);
  return trimmed || fallback;
}

/**
 * Every stored profile, cleaned and deduplicated by name (newest wins). A
 * profile whose style cannot be read at all is dropped rather than restored as
 * a mystery.
 */
export function normaliseOptimizeProfiles(raw: unknown): OptimizeProfile[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, OptimizeProfile>();
  for (const entry of raw.slice(-MAX_OPTIMIZE_PROFILES * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const style = readStyle(record.style);
    if (!style) continue;
    const name = cleanProfileName(typeof record.name === 'string' ? record.name : '');
    const profile: OptimizeProfile = {
      id: typeof record.id === 'string' && record.id ? record.id : newOptimizeProfileId(),
      name,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
      style,
    };
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || existing.createdAt <= profile.createdAt) byName.set(key, profile);
  }
  return [...byName.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_OPTIMIZE_PROFILES);
}
