import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SECURITY,
  generateTotpSeed,
  isSecured,
  normaliseSecurity,
  verifyTotp,
  totpCodeAt,
} from '../src/crypto/security.ts';
import { normalisePreferences, DEFAULT_PREFERENCES } from '../src/vault/storage.ts';
import { emptyItem, normaliseItem } from '../src/vault/types.ts';
import { normaliseFolders } from '../src/vault/channels.ts';

/**
 * Two bugs around second factors:
 *
 * 1. The normalizers rebuilt the security block by hand as {totp, questions},
 *    dropping `passcode`. A passcode-only factor silently stopped protecting
 *    anything on reload — no message, gate simply never rendered again.
 * 2. Generating or attaching an authenticator key saved it immediately, before
 *    any code was confirmed. Clicking "Generate" out of curiosity armed a gate
 *    demanding codes from an authenticator that was never configured.
 *
 * The second is a UI-state rule (staged until confirmed) rather than something
 * this file can execute, so what is pinned here is the contract it depends on:
 * an unconfirmed seed must be indistinguishable from no seed as far as
 * isSecured is concerned, i.e. nothing below writes a seed without proof.
 */

test('normaliseSecurity preserves a passcode', () => {
  const out = normaliseSecurity({
    totp: null,
    questions: [],
    passcode: { hash: 'h', salt: 's' },
  });
  assert.deepEqual(out.passcode, { hash: 'h', salt: 's' });
  assert.ok(isSecured(out), 'a passcode alone counts as secured');
});

test('normaliseSecurity keeps every factor together', () => {
  const out = normaliseSecurity({
    totp: { seed: 'ABC' },
    questions: [{ id: 'q', prompt: 'p?', hash: 'h', salt: 's' }],
    passcode: { hash: 'h2', salt: 's2' },
  });
  assert.equal(out.totp?.seed, 'ABC');
  assert.deepEqual(out.passcode, { hash: 'h2', salt: 's2' });
  assert.equal(out.questions.length, 1);
});

test('normaliseSecurity rejects a malformed passcode rather than keeping it', () => {
  assert.equal(normaliseSecurity({ totp: null, questions: [], passcode: { hash: '', salt: 's' } }).passcode, null);
  assert.equal(normaliseSecurity({ totp: null, questions: [] }).passcode, null);
  assert.equal(normaliseSecurity(undefined).passcode, null);
  assert.equal(normaliseSecurity(null).passcode, null);
});

test('an empty block normalises to the empty shape', () => {
  assert.deepEqual(normaliseSecurity(undefined), EMPTY_SECURITY);
  assert.deepEqual(normaliseSecurity({}), { totp: null, passcode: null, questions: [] });
});

test('vault preferences keep a passcode-only second factor', () => {
  const base = () => structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
  const stored = base();
  stored.vaultSecurity = { totp: null, questions: [], passcode: { hash: 'h', salt: 's' } };
  const out = normalisePreferences(stored);
  assert.deepEqual(out.vaultSecurity.passcode, { hash: 'h', salt: 's' });
  assert.ok(isSecured(out.vaultSecurity), 'the vault gate still renders after reload');
});

test('login items keep a passcode-only second factor', () => {
  const item = normaliseItem({
    ...emptyItem('x', 1000),
    security: { totp: null, questions: [], passcode: { hash: 'h', salt: 's' } },
  });
  assert.deepEqual(item.security.passcode, { hash: 'h', salt: 's' });
  assert.ok(isSecured(item.security));
});

test('folders keep a passcode-only second factor', () => {
  const out = normaliseFolders([
    {
      id: 'f',
      name: 'F',
      icon: 'layers',
      hue: 1,
      accent: 'slate',
      backgroundImage: '',
      collapsed: false,
      security: { totp: null, questions: [], passcode: { hash: 'h', salt: 's' } },
    },
  ]);
  assert.deepEqual(out[0]?.security.passcode, { hash: 'h', salt: 's' });
  assert.ok(isSecured(out[0]?.security));
});

test('a generated seed verifies against its own codes', async () => {
  // The staged-until-confirmed contract rests on this: confirmation means a
  // code produced by the seed verifies, so only run this if that holds.
  const seed = generateTotpSeed();
  const step = Math.floor(Date.now() / 30_000);
  const code = await totpCodeAt(seed, step);
  assert.equal(await verifyTotp(seed, code), true);
  assert.equal(await verifyTotp(seed, '000000'), code === '000000');
});
