/**
 * Vault cryptography.
 *
 * Zero-knowledge design: the master password never leaves this module, and no
 * verifier derived from it is ever stored. Unlocking works purely by proving
 * you can decrypt the vault key.
 *
 *   master password --PBKDF2--> KEK --unwraps--> VEK --AES-GCM--> items
 *
 * The split matters. `VEK` is a random 256-bit key that does all the real work,
 * so changing the master password only re-wraps 32 bytes instead of
 * re-encrypting every item in the vault.
 *
 * Everything here is plain TypeScript over the Web Crypto API, with no DOM or
 * framework imports, so the same module can back a native app later.
 */

import {
  bytesToUtf8,
  fromBase64Url,
  randomBytes,
  toBase64Url,
  utf8ToBytes,
} from './bytes.ts';

export const VAULT_FORMAT_VERSION = 1;

/** NIST SP 800-63B (2024) floor for PBKDF2-HMAC-SHA256. Stored per-vault so it can be raised later. */
export const PBKDF2_ITERATIONS = 600_000;

const KEY_BITS = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce, the size AES-GCM is specified for.

/** Domain separation: a wrapped key can never be replayed as an item, or vice versa. */
const AAD_WRAP = utf8ToBytes('aegis.vault.v1.wrap');
const AAD_ITEM = utf8ToBytes('aegis.vault.v1.item');

/**
 * Per-item associated data binds a ciphertext to its own id, so a record cannot
 * be silently moved to another row and decrypted there.
 */
function itemAad(id: string): Uint8Array<ArrayBuffer> {
  const suffix = utf8ToBytes(`:${id}`);
  const aad = new Uint8Array(AAD_ITEM.length + suffix.length);
  aad.set(AAD_ITEM, 0);
  aad.set(suffix, AAD_ITEM.length);
  return aad;
}

export interface SealedBlob {
  /** base64url 96-bit nonce */
  iv: string;
  /** base64url ciphertext with the appended GCM tag */
  ct: string;
}

/**
 * How the vault key is protected.
 *
 * - `password`: the key is wrapped with a KEK derived from the master password.
 *   An attacker with the raw database cannot read anything without it.
 * - `device`:   the key is stored as-is, protected only by the origin's
 *   storage sandbox. Nothing is encrypted against someone who can read the
 *   database, but the vault opens without typing anything. This is a
 *   convenience trade, and the UI says so plainly.
 */
export type VaultProtection = 'password' | 'device';

export interface VaultHeader {
  v: number;
  /** Absent on vaults written before protection was optional; treated as 'password'. */
  protection?: VaultProtection;
  /** Present when protection is 'password'. */
  kdf?: 'PBKDF2-SHA256';
  iterations?: number;
  /** base64url 16-byte salt */
  salt?: string;
  /** The vault key, encrypted under a key derived from the master password. */
  wrapped?: SealedBlob | null;
  /** Present when protection is 'device'. base64url raw vault key. */
  deviceKey?: string;
}

/** Header shape after normalisation, with the legacy defaults filled in. */
export interface ResolvedVaultHeader {
  v: number;
  protection: VaultProtection;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  wrapped: SealedBlob | null;
  deviceKey: string | null;
}

/**
 * Fills in defaults and upgrades legacy headers.
 *
 * A header with no `protection` field predates optional passwords and always had
 * a wrapped key, so it resolves to 'password'. Throws on a header that is
 * genuinely unreadable rather than silently treating it as passwordless.
 */
export function resolveHeader(header: VaultHeader): ResolvedVaultHeader {
  const protection: VaultProtection = header.protection ?? 'password';
  const base = {
    v: header.v ?? VAULT_FORMAT_VERSION,
    protection,
    kdf: (header.kdf ?? 'PBKDF2-SHA256') as 'PBKDF2-SHA256',
    iterations: header.iterations ?? PBKDF2_ITERATIONS,
    salt: header.salt ?? '',
    wrapped: header.wrapped ?? null,
    deviceKey: header.deviceKey ?? null,
  };

  if (protection === 'password' && (!base.wrapped || !base.salt)) {
    throw new Error('The vault header is damaged: the wrapped vault key is missing.');
  }
  if (protection === 'device' && !base.deviceKey) {
    throw new Error('The vault header is damaged: the device key is missing.');
  }
  return base;
}

/** Thrown when a password fails to unwrap the vault key. */
export class VaultAuthError extends Error {
  override readonly name = 'VaultAuthError';
  constructor() {
    super('Incorrect master password.');
  }
}

export function isCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

function requireCrypto(): SubtleCrypto {
  if (!isCryptoAvailable()) {
    throw new Error(
      'Web Crypto is unavailable. Open this over https:// or from localhost, and make sure the page is not in an insecure context.',
    );
  }
  return crypto.subtle;
}

async function deriveKek(masterPassword: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const subtle = requireCrypto();
  const material = await subtle.importKey('raw', utf8ToBytes(masterPassword), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function importAesKey(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  return requireCrypto().importKey('raw', raw, { name: 'AES-GCM', length: KEY_BITS }, false, usages);
}

async function seal(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<SealedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ct = await requireCrypto().encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    plaintext,
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

async function open(key: CryptoKey, blob: SealedBlob, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const plaintext = await requireCrypto().decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(blob.iv), additionalData: aad, tagLength: 128 },
      key,
      fromBase64Url(blob.ct),
    );
    return new Uint8Array(plaintext);
  } catch {
    // GCM tag verification failed: wrong key, or the blob was tampered with.
    throw new VaultAuthError();
  }
}

/** Raw 256-bit vault key, held only in memory while the vault is unlocked. */
export interface VaultKeyHandle {
  key: CryptoKey;
  raw: Uint8Array<ArrayBuffer>;
}

export async function generateVaultKey(): Promise<VaultKeyHandle> {
  const raw = randomBytes(KEY_BITS / 8);
  return { raw, key: await importAesKey(raw, ['encrypt', 'decrypt']) };
}

/**
 * Best-effort scrub of the raw vault key on lock. JavaScript gives no guarantee
 * that no copy survives, but it does remove the one buffer we control.
 */
export function destroyVaultKey(handle: VaultKeyHandle | null): void {
  if (!handle) return;
  handle.raw.fill(0);
  handle.key = null as unknown as CryptoKey;
}

export async function sealItems(handle: VaultKeyHandle, itemId: string, value: unknown): Promise<SealedBlob> {
  return seal(handle.key, utf8ToBytes(JSON.stringify(value)), itemAad(itemId));
}

export async function openItems<T>(handle: VaultKeyHandle, itemId: string, blob: SealedBlob): Promise<T> {
  return JSON.parse(bytesToUtf8(await open(handle.key, blob, itemAad(itemId)))) as T;
}

/** Builds a password-protected header. The caller keeps `handle` and must persist the header. */
export async function createPasswordHeader(
  masterPassword: string,
  handle: VaultKeyHandle,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<VaultHeader> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(masterPassword, salt, iterations);
  return {
    v: VAULT_FORMAT_VERSION,
    protection: 'password',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: toBase64Url(salt),
    wrapped: await seal(kek, handle.raw, AAD_WRAP),
  };
}

/** Builds a header that stores the vault key directly, so no password is needed to open it. */
export function createDeviceHeader(handle: VaultKeyHandle): VaultHeader {
  return {
    v: VAULT_FORMAT_VERSION,
    protection: 'device',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: '',
    wrapped: null,
    deviceKey: toBase64Url(handle.raw),
  };
}

/**
 * Opens a vault key from any header shape.
 *
 * For a password vault this is also the password check: unwrapping either
 * succeeds or fails the GCM tag. For a device vault the key is read directly.
 */
export async function openVaultKey(
  header: VaultHeader,
  masterPassword = '',
): Promise<VaultKeyHandle> {
  const resolved = resolveHeader(header);
  if (resolved.protection === 'device') {
    const raw = fromBase64Url(resolved.deviceKey as string);
    return { raw, key: await importAesKey(raw, ['encrypt', 'decrypt']) };
  }
  const kek = await deriveKek(
    masterPassword,
    fromBase64Url(resolved.salt),
    resolved.iterations,
  );
  const raw = await open(kek, resolved.wrapped as SealedBlob, AAD_WRAP);
  return { raw, key: await importAesKey(raw, ['encrypt', 'decrypt']) };
}

/**
 * Re-wraps an already-unwrapped vault key under a new master password.
 * Item ciphertexts are untouched, so this is O(1) regardless of vault size.
 */
export async function rewrapVaultKey(
  handle: VaultKeyHandle,
  newMasterPassword: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<VaultHeader> {
  return createPasswordHeader(newMasterPassword, handle, iterations);
}