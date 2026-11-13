/**
 * Password-protected text exports.
 *
 * The encrypted backup already protects itself (the vault key is re-wrapped with
 * the export password), but the CSV and theme exports were plain files: useful
 * for moving data between tools, and readable by anyone who found the file. This
 * wraps any text export in the same idea — PBKDF2-SHA-256 for the key,
 * AES-256-GCM for the payload — while staying a plain JSON file, so it can be
 * stored, mailed or synced like any other export.
 *
 * The wrapper is deliberately independent of the vault: an export must be
 * openable on a device that has never seen the vault it came from.
 */

import {
  bytesToUtf8,
  fromBase64,
  randomBytes,
  toBase64,
  utf8ToBytes,
  type Bytes,
} from '../crypto/bytes.ts';

export const ENCRYPTED_EXPORT_FORMAT = 'colax-encrypted-export' as const;

/** Serde shape of a protected export on disk. */
export interface EncryptedExportFile {
  format: typeof ENCRYPTED_EXPORT_FORMAT;
  version: 1;
  /** What is inside: 'csv', 'theme', or a caller's own name. */
  kind: string;
  createdAt: string;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

/** NIST SP 800-63B (2024) floor for PBKDF2-HMAC-SHA256, as the vault itself uses. */
const ITERATIONS = 210_000;

async function deriveKey(
  password: string,
  salt: Bytes,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8ToBytes(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Returns a JSON document holding `text`, encrypted under `password`. */
export async function sealText(kind: string, text: string, password: string): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8ToBytes(text)),
  );
  const file: EncryptedExportFile = {
    format: ENCRYPTED_EXPORT_FORMAT,
    version: 1,
    kind,
    createdAt: new Date().toISOString(),
    iterations: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
  return JSON.stringify(file, null, 2);
}

/** True when a file was written by {@link sealText}. Never throws on junk. */
export function isEncryptedExport(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Partial<EncryptedExportFile> | null;
    return Boolean(
      parsed &&
        parsed.format === ENCRYPTED_EXPORT_FORMAT &&
        typeof parsed.salt === 'string' &&
        typeof parsed.iv === 'string' &&
        typeof parsed.ciphertext === 'string',
    );
  } catch {
    return false;
  }
}

/** What a protected export holds, for the import prompt. */
export function encryptedExportKind(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Partial<EncryptedExportFile> | null;
    return parsed?.format === ENCRYPTED_EXPORT_FORMAT && typeof parsed.kind === 'string'
      ? parsed.kind
      : null;
  } catch {
    return null;
  }
}

/**
 * Decrypts a protected export.
 *
 * A wrong password and a tampered file are deliberately the same message: AES-GCM
 * cannot tell them apart, and saying which would be a guess.
 */
export async function openText(text: string, password: string): Promise<string> {
  let parsed: EncryptedExportFile;
  try {
    parsed = JSON.parse(text) as EncryptedExportFile;
  } catch {
    throw new Error('That file is not readable.');
  }
  if (parsed.format !== ENCRYPTED_EXPORT_FORMAT) {
    throw new Error('That file is not a protected Colax export.');
  }
  try {
    const key = await deriveKey(password, fromBase64(parsed.salt), parsed.iterations || ITERATIONS);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(parsed.iv) },
      key,
      fromBase64(parsed.ciphertext),
    );
    return bytesToUtf8(new Uint8Array(plain));
  } catch {
    throw new Error('Wrong password, or the file was changed.');
  }
}
