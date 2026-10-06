/**
 * Password generation and strength estimation.
 *
 * Generation uses rejection sampling over `crypto.getRandomValues` so every
 * character is uniformly distributed. A plain `% pool.length` would skew toward
 * the low indices whenever the pool size is not a power of two.
 */

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/';

/** Ordered worst-first so a match anywhere in the string disqualifies it. */
const COMMON_PASSWORDS = [
  'password', '123456', '123456789', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou',
  'monkey', 'dragon', 'abc123', 'football', 'sunshine', 'princess', 'login', 'master',
  'hello', 'freedom', 'whatever', 'trustno1', 'passw0rd', 'starwars', 'zaq12wsx', 'changeme',
];

export interface GeneratorOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

function poolFor(options: GeneratorOptions): string[] {
  const pools: string[] = [];
  const add = (set: string, enabled: boolean) => {
    if (!enabled) return;
    pools.push(options.avoidAmbiguous ? set.replace(/[l1IO0o]/g, '') : set);
  };
  add(LOWER, options.lower);
  add(UPPER, options.upper);
  add(DIGITS, options.digits);
  add(SYMBOLS, options.symbols);
  return pools.filter((pool) => pool.length > 0);
}

/**
 * Uniform integer in [0, max) via rejection sampling.
 *
 * `Math.floor(256 / max) * max` is the largest usable multiple of `max` in a
 * byte. If `max` exceeds 256 that product is 0, nothing would ever be accepted
 * and this would spin forever, so widen to 32 bits instead.
 */
function randomInt(max: number): number {
  if (max <= 0 || !Number.isInteger(max)) throw new Error('randomInt needs a positive integer bound.');
  if (max === 1) return 0;

  if (max <= 256) {
    const limit = Math.floor(256 / max) * max;
    const buffer = new Uint8Array(1);
    for (;;) {
      crypto.getRandomValues(buffer);
      const value = buffer[0] as number;
      if (value < limit) return value % max;
    }
  }

  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < limit) return value % max;
  }
}

function shuffle(chars: string[]): void {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
}

export function generatePassword(options: GeneratorOptions): string {
  const pools = poolFor(options);
  if (pools.length === 0) throw new Error('Select at least one character set.');

  const length = Math.max(4, Math.min(128, Math.trunc(options.length)));
  const chars: string[] = [];
  // Guarantee at least one character from each selected set, then fill.
  for (const pool of pools) chars.push(pool[randomInt(pool.length)] as string);
  const all = pools.join('');
  while (chars.length < length) chars.push(all[randomInt(all.length)] as string);

  shuffle(chars);
  return chars.join('');
}

/**
 * Master-password suggestion for vault creation.
 *
 * Uses the same CSPRNG as the rest of this module. An earlier version drew from
 * `Math.random`, which is not a cryptographic source and would have been the
 * weakest link in the entire vault.
 *
 * The result is a passphrase rather than a random string because a master
 * password has to survive being remembered for years without being written down.
 */
/**
 * Word list for passphrases. Deliberately larger than a typical UI list so that
 * a six-word master suggestion carries useful entropy (~7 bits per word) rather
 * than the ~4 bits a 30-word list would give.
 */
const WORDS = (
  'acorn adobe amber anchor apple arrow aspen atlas autumn awake badge basin batch beacon beetle '
  + 'birch bishop bison blossom bluff bonus braid brass brick brook bronze buckle bundle canyon cedar '
  + 'chalk cherry cinder cliff clover cobalt cocoa comet copper coral cotton cove cradle crater crimson '
  + 'crystal dawn delta desert dome drift dune eagle ember fabric falcon feather fern field flame fleet '
  + 'flint forest fossil frost galaxy garden garnet ginger glacier granite gravel harbor hazel hollow '
  + 'honey indigo iris island ivory jade jasper jungle kettle lagoon lantern ledger lemon lilac linen '
  + 'lotus lumber magnet mango maple marble marsh meadow meteor mineral mosaic nectar nickel oasis '
  + 'obsidian olive onyx opal orbit otter oyster pebble pepper pine pivot plaza pollen prism pumpkin '
  + 'quartz quill rapid raven ribbon ridge river saffron sapphire shadow shell silk silver slate '
  + 'spark spruce summit thunder timber topaz trail tulip tundra velvet violet walnut whistle willow '
  + 'winter zenith zinc'
).split(' ');

export const PASSPHRASE_WORD_COUNT = WORDS.length;

export function generatePassphrase(words = 5, separator = '-'): string {
  const count = Math.max(3, Math.min(12, Math.trunc(words)));
  const chosen: string[] = [];
  // Draw without replacement so a phrase never repeats a word, which reads as a
  // mistake and costs a little entropy.
  const pool = [...WORDS];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    chosen.push(pool.splice(randomInt(pool.length), 1)[0] as string);
  }
  return chosen.join(separator);
}

/**
 * Master-password suggestion for vault creation.
 *
 * Uses the same CSPRNG as the rest of this module. An earlier version drew from
 * `Math.random`, which is not a cryptographic source and would have been the
 * weakest link in the entire vault.
 *
 * The result is a passphrase rather than a random string because a master
 * password has to survive being remembered for years without being written down.
 */
export function suggestMasterPassword(words = 7): string {
  const count = Math.max(4, Math.min(8, Math.trunc(words)));
  const digits = 1000 + randomInt(9000);
  return `${generatePassphrase(count, '-')}-${digits}`;
}

export type StrengthLabel = 'empty' | 'very weak' | 'weak' | 'fair' | 'strong' | 'very strong';

export interface Strength {
  /** Shannon-style entropy estimate after pattern penalties, in bits. */
  bits: number;
  score: 0 | 1 | 2 | 3 | 4;
  label: StrengthLabel;
  /** Human-readable time to crack assuming ~1e11 guesses/second, offline attack. */
  crackTime: string;
  hints: string[];
}

function poolSizeOf(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  return pool;
}

function hasSequence(password: string): boolean {
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < password.length; i += 1) {
    const delta = password.charCodeAt(i) - password.charCodeAt(i - 1);
    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;
    if (ascending >= 4 || descending >= 4) return true;
  }
  return false;
}

function hasRepeat(password: string): boolean {
  return /(.)\1{2,}/.test(password) || /(.{2,4})\1+/.test(password);
}

const SECONDS_PER_YEAR = 31_557_600;

function formatDuration(seconds: number): string {
  if (seconds < 1) return 'instantly';
  const units: [number, string][] = [
    [SECONDS_PER_YEAR, 'year'],
    [2_592_000, 'month'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const value = seconds / size;
      // A strong password produces astronomically large numbers, so switch to
      // exponent notation once the digits stop being readable.
      if (value >= 1e6) return `${value.toExponential(1)} ${name}s`;
      const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
      return `${rounded} ${name}${rounded === 1 ? '' : 's'}`;
    }
  }
  return 'instantly';
}

/**
 * Recognises a dictionary-style passphrase such as `marble-drift-haze-2502` and
 * scores it by word-list size instead of raw character count.
 *
 * Without this, treating a six-word phrase as 45 random characters over a 36
 * symbol alphabet reports ~226 bits, when the real figure is about 55. Overstating
 * this is worse than useless: it tells the user a memorable passphrase is
 * unbreakable when it is merely decent.
 */
function passphraseEntropy(password: string): { bits: number; words: number } | null {
  const tokens = password.split(/[-_. ]+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const wordTokens = tokens.filter((token) => /^[a-z]{3,}$/.test(token));
  if (wordTokens.length < 2) return null;

  let bits = wordTokens.length * Math.log2(PASSPHRASE_WORD_COUNT);
  for (const token of tokens) {
    if (wordTokens.includes(token)) continue;
    const pool = /^\d+$/.test(token) ? 10 : /\d/.test(token) ? 62 : 26;
    bits += token.length * Math.log2(pool);
  }
  return { bits: Math.round(bits), words: wordTokens.length };
}

const GUESSES_PER_SECOND = 1e11;

export function estimateStrength(password: string): Strength {
  const hints: string[] = [];
  if (!password) {
    return { bits: 0, score: 0, label: 'empty', crackTime: 'instantly', hints: ['Enter a password to see its strength.'] };
  }

  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.some((common) => lowered.includes(common))) {
    return {
      bits: 4,
      score: 0,
      label: 'very weak',
      crackTime: 'instantly',
      hints: ['Contains a very common password. Attackers try these first.'],
    };
  }

  let effectiveLength = password.length;
  if (hasRepeat(password)) {
    effectiveLength -= 2;
    hints.push('Repeated characters or blocks add almost no strength.');
  }
  if (hasSequence(password)) {
    effectiveLength -= 2;
    hints.push('Sequences like "abcd" or "4321" are guessed early.');
  }

  // Uniqueness matters more than raw length: 8 distinct letters beats "aaaaaaaa".
  const distinct = new Set(password).size;
  if (distinct <= 2) {
    effectiveLength = Math.min(effectiveLength, distinct * 2);
    hints.push('Only a couple of distinct characters.');
  }

  const pool = poolSizeOf(password);
  const naiveBits = Math.max(1, Math.round(effectiveLength * Math.log2(pool)));
  const phrase = passphraseEntropy(password);
  // Always trust the lower of the two readings.
  const bits = phrase ? Math.min(naiveBits, phrase.bits) : naiveBits;
  const score = (bits >= 100 ? 4 : bits >= 70 ? 3 : bits >= 45 ? 2 : bits >= 28 ? 1 : 0) as
    | 0
    | 1
    | 2
    | 3
    | 4;
  const labels: StrengthLabel[] = ['very weak', 'weak', 'fair', 'strong', 'very strong'];

  if (phrase) {
    hints.push(`${phrase.words} words from a ${PASSPHRASE_WORD_COUNT}-word list. Add words to make it stronger.`);
  }
  if (password.length < 12) hints.push('Aim for 16+ characters, or use a passphrase.');
  if (!/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    hints.push('Mixing in numbers and symbols widens the search space.');
  }

  return {
    bits,
    score,
    label: labels[score] as StrengthLabel,
    crackTime: formatDuration((2 ** bits) / GUESSES_PER_SECOND),
    hints,
  };
}