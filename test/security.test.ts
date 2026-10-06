import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerTooWeak,
  extractTotpSeed,
  fromBase32,
  generateTotpSeed,
  hashAnswer,
  isSecured,
  normaliseAnswer,
  securityLevel,
  toBase32,
  verifyAnswer,
  verifyTotp,
  totpCodeAt,
} from '../src/crypto/security.ts';
import { relativeTime } from '../src/vault/types.ts';

test('base32 round-trips', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...fromBase32(toBase32(bytes))], [...bytes]);
});

test('a generated seed is 32 base32 chars, the size authenticator apps expect', () => {
  const seed = generateTotpSeed();
  assert.equal(seed.length, 32);
  assert.match(seed, /^[A-Z2-7]+$/);
  assert.notEqual(seed, generateTotpSeed());
});

test('a bare seed and an otpauth link both extract', () => {
  assert.equal(extractTotpSeed('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
  assert.equal(
    extractTotpSeed('otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example'),
    'JBSWY3DPEHPK3PXP',
  );
  // Users paste these with spaces and mixed case; both are accepted.
  assert.equal(extractTotpSeed('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
  assert.equal(extractTotpSeed(''), null);
  assert.equal(extractTotpSeed('not a seed!'), null);
});

/* The RFC 6238 reference vectors. Pinning these is the only way to know the
   implementation is interoperable with a real authenticator app rather than
   merely self-consistent. */
test('TOTP matches the RFC 6238 SHA-1 vectors', async () => {
  const seed = toBase32(new TextEncoder().encode('12345678901234567890'));
  const now = 59 * 1000;
  assert.equal(await totpCodeAt(seed, Math.floor(now / 30_000)), '287082');
  assert.equal(await totpCodeAt(seed, Math.floor(1111111109 * 1000 / 30_000)), '081804');
  assert.equal(await totpCodeAt(seed, Math.floor(1234567890 * 1000 / 30_000)), '005924');
});

test('a valid code verifies, and drift either side is tolerated', async () => {
  const seed = generateTotpSeed();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(await verifyTotp(seed, await totpCodeAt(seed, step), now), true);
  assert.equal(await verifyTotp(seed, await totpCodeAt(seed, step - 1), now), true);
  assert.equal(await verifyTotp(seed, await totpCodeAt(seed, step + 1), now), true);
  // Two steps away is outside the window.
  assert.equal(await verifyTotp(seed, await totpCodeAt(seed, step + 2), now), false);
  assert.equal(await verifyTotp(seed, '000000', now), false);
  assert.equal(await verifyTotp(seed, 'abcdef', now), false);
});

test('answers are normalised before hashing', () => {
  assert.equal(normaliseAnswer('  New   York! '), 'new york');
  assert.equal(normaliseAnswer('Café'), 'cafe');
  assert.equal(normaliseAnswer('a-b_c'), 'abc');
});

test('the same answer always verifies, and a different one never does', async () => {
  const question = { id: 'sq_1', prompt: 'First pet', ...(await hashAnswer('Rex')) };
  assert.equal(await verifyAnswer(question, 'Rex'), true);
  assert.equal(await verifyAnswer(question, 'rex'), true);
  assert.equal(await verifyAnswer(question, '  REX '), true);
  assert.equal(await verifyAnswer(question, 'Fido'), false);
});

test('two identical answers hash differently, via per-question salt', async () => {
  const a = await hashAnswer('Rex');
  const b = await hashAnswer('Rex');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  // Both still verify.
  assert.equal(await verifyAnswer({ id: '1', prompt: 'p', ...a }, 'Rex'), true);
  assert.equal(await verifyAnswer({ id: '2', prompt: 'p', ...b }, 'Rex'), true);
});

test('the plaintext answer is never present in the stored record', async () => {
  const stored = await hashAnswer('Rex');
  const serialised = JSON.stringify(stored);
  assert.equal(serialised.includes('Rex'), false);
  assert.equal(serialised.includes('rex'), false);
});

test('guessable answers are refused', () => {
  for (const weak of ['', 'a', 'yes', 'no', 'test', 'password', 'qwerty', 'unknown', 'aaaa', 'yes please']) {
    assert.equal(answerTooWeak(weak), true, `should refuse: ${JSON.stringify(weak)}`);
  }
  assert.equal(answerTooWeak('Rex'), false);
  assert.equal(answerTooWeak('Blue Moon 1987'), false);
});

test('a login is secured by any one factor, and rates its own coverage', () => {
  assert.equal(securityLevel({ totp: null, questions: [] }), 'none');
  assert.equal(isSecured({ totp: null, questions: [] }), false);
  assert.equal(securityLevel({ totp: { seed: 'JBSWY3DPEHPK3PXP' }, questions: [] }), 'partial');
  assert.equal(securityLevel({ totp: null, questions: [{ id: '1', prompt: 'p', hash: 'h', salt: 's' }] }), 'partial');
  assert.equal(
    securityLevel({ totp: { seed: 'JBSWY3DPEHPK3PXP' }, questions: [{ id: '1', prompt: 'p', hash: 'h', salt: 's' }] }),
    'full',
  );
  // A record from before the feature existed has no block at all.
  assert.equal(isSecured(undefined), false);
  assert.equal(securityLevel(undefined), 'none');
});

test('relative time switches to days and hours past a day', () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);
  const ago = (ms: number) => relativeTime(now - ms, now);
  assert.equal(ago(30_000), 'just now');
  assert.equal(ago(5 * 60_000), '5 minutes ago');
  assert.equal(ago(2 * 3_600_000), '2 hours ago');
  // Exactly a day: no hour part when it is a whole number of days.
  assert.equal(ago(86_400_000), '1 day ago');
  assert.equal(ago(86_400_000 + 5 * 3_600_000), '1 day 5 hours ago');
  assert.equal(ago(3 * 86_400_000 + 7 * 3_600_000), '3 days 7 hours ago');
  assert.equal(ago(45 * 86_400_000), '1 month 15 days ago');
});