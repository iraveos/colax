/**
 * RFC 6238 TOTP, so an item's authenticator seed can produce live codes
 * alongside its password. Uses Web Crypto HMAC, so no library dependency and
 * the same code path ports to a native app.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('That authenticator key has invalid characters.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

export function isValidTotpSecret(secret: string): boolean {
  try {
    return base32Decode(secret).length > 0;
  } catch {
    return false;
  }
}

async function hmacSha1(key: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message));
}

export async function totpCode(secret: string, timestampMs: number, digits = 6, period = 30): Promise<string> {
  const counter = Math.floor(timestampMs / 1000 / period);
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32), false);
  view.setUint32(4, counter >>> 0, false);

  const digest = await hmacSha1(base32Decode(secret), message);
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpSecondsRemaining(timestampMs: number, period = 30): number {
  return period - (Math.floor(timestampMs / 1000) % period);
}

/** Accepts the otpauth:// URI that authenticator apps offer on screen. */
export function extractTotpSecret(uri: string): string | null {
  if (!uri.startsWith('otpauth://')) return null;
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}