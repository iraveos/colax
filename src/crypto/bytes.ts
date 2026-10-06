/** Binary <-> text helpers. Base64url everywhere so values are URL- and filename-safe. */

/**
 * Web Crypto requires views backed by a real `ArrayBuffer`, not the default
 * `ArrayBufferLike` (which could be a `SharedArrayBuffer`). Narrowing to
 * `ArrayBuffer` here keeps every call site free of casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ToBytes(value: string): Bytes {
  return encoder.encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Bytes {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}