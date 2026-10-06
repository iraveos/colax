/**
 * Login security questions.
 *
 * A second factor for a single credential, independent of the vault-level one.
 * Two kinds, deliberately:
 *
 *   - TOTP, the standard shared secret an authenticator app reads. The seed is
 *     stored encrypted like any other field, and codes are verified with a
 *     window rather than an exact match, because phone clocks drift.
 *   - Recovery questions, hashed. The answer is never stored, so it cannot be
 *     read out of the database even if the vault were unlocked on another
 *     machine. Verification is a hash comparison, which is why answers are
 *     normalised hard before hashing.
 *
 * Why questions and not a second password: a second password is one more
 * secret to forget, whereas a question the user can reconstruct from their own
 * life is recoverable. The trade-off is that answers are guessable, so the
 * normalisation below deliberately refuses near-trivial input like "yes".
 */

import { bytesEqual, randomBytes, toBase64Url, utf8ToBytes } from './bytes.ts';

export interface TotpSecret {
  /** base32 seed, as an authenticator app expects it. */
  seed: string;
}

export interface SecurityQuestion {
  id: string;
  prompt: string;
  /** PBKDF2 hash of the normalised answer. The answer itself is never stored. */
  hash: string;
  /** Per-question salt, so identical answers do not produce identical records. */
  salt: string;
}

/**
 * A password of the user's own choosing, gating this one login.
 *
 * Deliberately separate from the login's own password: this is a secret about
 * *access*, not the credential being protected, so it must never be the same
 * string. Stored as a PBKDF2 hash with its own salt, exactly like a recovery
 * answer, so the plaintext is never written to disk.
 */
export interface SecurityPasscode {
  hash: string;
  salt: string;
}

export interface LoginSecurity {
  totp: TotpSecret | null;
  questions: SecurityQuestion[];
  /** Optional extra password. Absent on anything stored before this existed. */
  passcode?: SecurityPasscode | null;
}

export const EMPTY_SECURITY: LoginSecurity = { totp: null, questions: [], passcode: null };

/* ---- TOTP ---------------------------------------------------------------
   RFC 6238, SHA-1, 6 digits, 30-second step. SHA-1 is not a weakness here:
   it is what every authenticator app in existence implements, so anything else
   would just make codes unusable. The seed is what actually protects the
   account; this only proves possession of it.
   ---------------------------------------------------------------------- */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encodes bytes as base32, unpadded, which is the format authenticator apps read. */
export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Decodes unpadded base32, tolerating the spaces and casing users paste in. */
export function fromBase32(value: string): Uint8Array {
  const clean = value.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** A fresh 160-bit TOTP seed, as a base32 string. */
export function generateTotpSeed(): string {
  return toBase32(randomBytes(20));
}

/** Accepts a bare seed or a full otpauth:// URI and returns the seed. */
export function extractTotpSeed(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!trimmed.toLowerCase().startsWith('otpauth://')) return extractBareSeed(trimmed);
  try {
    const url = new URL(trimmed);
    const seed = url.searchParams.get('secret');
    return seed ? extractBareSeed(seed) : null;
  } catch {
    return null;
  }
}

/**
 * Validates a pasted bare seed.
 *
 * `fromBase32` silently drops anything outside the base32 alphabet, so
 * "not a seed!" would otherwise decode to "NOTASEED" and be accepted as if the
 * user had pasted a real key — a silent failure that would leave the login
 * believing it had a second factor it could never use. So the input is
 * validated against the alphabet first, and must be long enough to be a
 * plausible seed.
 */
function extractBareSeed(value: string): string | null {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(compact)) return null;
  // A real 160-bit seed decodes to 20 bytes; refuse anything far below 80 bits.
  if (fromBase32(compact).length < 10) return null;
  return toBase32(fromBase32(compact));
}

/** The 8-digit code for a given counter step. Exported so tests can pin time. */
export async function totpCodeAt(seed: string, counter: number, digits = 6): Promise<string> {
  const key = fromBase32(seed);
  if (key.length === 0) throw new Error('That is not a valid authenticator seed.');
  const buffer = new Uint8Array(8);
  // The counter is written big-endian, per RFC 4226.
  const view = new DataView(buffer.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buffer as BufferSource));
  const offset = signature[signature.length - 1]! & 0x0f;
  const binary =
    ((signature[offset]! & 0x7f) << 24) |
    ((signature[offset + 1]! & 0xff) << 16) |
    ((signature[offset + 2]! & 0xff) << 8) |
    (signature[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for right now. */
export function currentTotpCode(seed: string, at: number = Date.now()): Promise<string> {
  return totpCodeAt(seed, Math.floor(at / 30_000));
}

/**
 * Checks a code the user typed.
 *
 * `window` is 1 either side, which covers clock drift between the phone and
 * this machine without meaningfully widening the attack surface.
 */
export async function verifyTotp(seed: string, code: string, at: number = Date.now()): Promise<boolean> {
  const cleaned = code.replace(/\D/g, '');
  if (cleaned.length !== 6) return false;
  const step = Math.floor(at / 30_000);
  for (const offset of [-1, 0, 1]) {
    try {
      const expected = await totpCodeAt(seed, step + offset);
      // Constant-time compare: the loop is what avoids an early exit on a
      // matching prefix.
      if (bytesEqual(utf8ToBytes(expected), utf8ToBytes(cleaned))) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/* ---- Recovery questions -------------------------------------------------- */

/** Long enough that PBKDF2 is meaningful, cheap enough to run per keystroke-ish. */
const QUESTION_ITERATIONS = 210_000;

/**
 * Normalises an answer before hashing.
 *
 * Case, accents, punctuation and spacing are all removed, so "New York" and
 * "new-york" match. Accent stripping via NFKD rather than a lookup table.
 */
export function normaliseAnswer(answer: string): string {
  return answer
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rejects answers that would make the question worthless. */
export function answerTooWeak(answer: string): boolean {
  const normalised = normaliseAnswer(answer);
  // Three characters is short but legitimate — plenty of pet names and surnames
  // are that long. The trivial-word list below is what catches the guesses that
  // actually matter, so length only has to rule out single characters.
  if (normalised.length < 3) return true;
  const trivial = new Set([
    'yes',
    'no',
    'none',
    'test',
    'password',
    'qwerty',
    'asdfgh',
    'unknown',
    'nothing',
    'same',
    'other',
  ]);
  if (trivial.has(normalised)) return true;
  // A single repeated character carries almost no entropy either.
  if (/^(.)\1{3,}$/.test(normalised)) return true;
  // A trivial word followed by filler is still a trivial word: "yes please",
  // "no thanks". Checked against the trivial set after dropping filler words,
  // so a user cannot smuggle one past by padding it.
  const meaningful = normalised
    .split(' ')
    .filter((word) => word !== 'a' && word !== 'an' && word !== 'the' && word !== 'my' && word !== 'please' && word !== 'thanks' && word !== 'and');
  if (meaningful.length === 1 && trivial.has(meaningful[0]!)) return true;
  // Two words that are both trivial, e.g. "no idea".
  if (meaningful.length > 0 && meaningful.every((word) => trivial.has(word))) return true;
  return false;
}

async function answerHash(normalised: string, salt: Uint8Array, iterations = QUESTION_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8ToBytes(normalised) as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

/** Hashes an answer. The plaintext is not retained anywhere. */
export async function hashAnswer(answer: string): Promise<{ hash: string; salt: string }> {
  const normalised = normaliseAnswer(answer);
  const salt = randomBytes(16);
  return { hash: await answerHash(normalised, salt), salt: toBase64Url(salt) };
}

/** Checks an answer against a stored question. */
export async function verifyAnswer(question: SecurityQuestion, answer: string): Promise<boolean> {
  const salt = base64UrlToBytes(question.salt);
  if (salt.length === 0) return false;
  const computed = await answerHash(normaliseAnswer(answer), salt);
  return bytesEqual(utf8ToBytes(computed), utf8ToBytes(question.hash));
}

/* ---- Passcode ------------------------------------------------------------
   A user-chosen password that gates one login. Hashed with the same PBKDF2
   construction as a recovery answer, and compared the same constant-time way.
   Unlike an answer it is NOT case-folded or stripped of punctuation: a password
   is typed verbatim, so normalising it would quietly accept the wrong one.
   ---------------------------------------------------------------------- */

/** Hashes a passcode. The plaintext is never retained. */
export async function hashPasscode(passcode: string): Promise<SecurityPasscode> {
  const salt = randomBytes(16);
  return { hash: await answerHash(passcode, salt), salt: toBase64Url(salt) };
}

/** Checks a typed passcode against the stored hash. */
export async function verifyPasscode(stored: SecurityPasscode, passcode: string): Promise<boolean> {
  const salt = base64UrlToBytes(stored.salt);
  if (salt.length === 0) return false;
  const computed = await answerHash(passcode, salt);
  return bytesEqual(utf8ToBytes(computed), utf8ToBytes(stored.hash));
}

/** Refuses a passcode too short or too trivial to be worth setting. */
export function passcodeTooWeak(passcode: string): boolean {
  if (passcode.length < 8) return true;
  const lower = passcode.toLowerCase();
  const trivial = new Set([
    'password',
    'password1',
    'passw0rd',
    '12345678',
    '123456789',
    'qwertyui',
    'iloveyou',
    'letmein1',
    'welcome1',
    'administrator',
  ]);
  if (trivial.has(lower)) return true;
  // A single repeated character, or one class only ("aaaaaaaa", "12345678").
  if (/^(.)\1+$/.test(passcode)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(passcode)).length;
  return classes < 2;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * How complete a login's second factor is.
 *
 * Used to decide whether to show the shield badge: any one factor counts, so a
 * user who only wants TOTP is not nagged for also writing recovery questions.
 */
export function securityLevel(security: LoginSecurity | undefined): 'none' | 'partial' | 'full' {
  const totp = Boolean(security?.totp?.seed);
  const passcode = Boolean(security?.passcode?.hash);
  const factors = (totp ? 1 : 0) + (passcode ? 1 : 0) + (security?.questions.length ?? 0 ? 1 : 0);
  if (factors === 0) return 'none';
  return factors > 1 ? 'full' : 'partial';
}

/** True when this login has any second factor at all. */
export function isSecured(security: LoginSecurity | undefined): boolean {
  return securityLevel(security) !== 'none';
}

/**
 * True when the user must clear a factor to reach the password or the editor.
 *
 * Deliberately identical to `isSecured`: any factor gates the login, so there
 * is no factor combination that shows the password without a check. Kept as a
 * separate name because the call sites mean something different — "is this
 * login protected" versus "must I ask before showing this" — and collapsing
 * them would hide that decision behind one boolean.
 */
export function requiresVerification(security: LoginSecurity | undefined): boolean {
  return isSecured(security);
}

/* ---- Passkeys ------------------------------------------------------------
   WebAuthn registration needs a server to attest the credential against, which
   a local-first vault has no way to provide honestly. Rather than ship a stored
   "passkey" field that would not actually be a passkey, this is unimplemented
   and reported as such — a field that claims to be a passkey but is not is
   worse than no field, because the user would trust it.
   ---------------------------------------------------------------------- */

export const PASSKEY_SUPPORTED = false;

export const PASSKEY_REASON =
  'Passkeys need a server to register the credential against. This vault has no server, so a real passkey cannot be issued here.';