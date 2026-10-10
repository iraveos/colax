/**
 * Crypto round-trip checks against the real Web Crypto implementation.
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto as unknown as Crypto;

const { fromBase64Url, toBase64Url, utf8ToBytes } = await import('../src/crypto/bytes.ts');
const {
  createPasswordHeader,
  createDeviceHeader,
  destroyVaultKey,
  generateVaultKey,
  openItems,
  openVaultKey,
  rewrapVaultKey,
  resolveHeader,
  sealItems,
  VaultAuthError,
} = await import('../src/crypto/vault-crypto.ts');
const { generatePassword, generatePassphrase, estimateStrength, suggestMasterPassword } = await import('../src/crypto/passwords.ts');
const { totpCode } = await import('../src/crypto/totp.ts');
const { MemoryVaultStorage } = await import('../src/vault/storage.ts');
const { VaultService, verifyBackupPassword } = await import('../src/vault/vault-service.ts');

const MASTER = 'correct horse battery staple 42';

test('base64url round-trips arbitrary bytes', () => {
  for (let length = 0; length < 40; length += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  }
});

test('unlocking with the right password yields the same vault key', async () => {
  const original = await generateVaultKey();
  const header = await createPasswordHeader(MASTER, original);
  const reopened = await openVaultKey(header, MASTER);
  assert.deepEqual(reopened.raw, original.raw);
});

test('the wrong password is rejected', async () => {
  const handle = await generateVaultKey();
  const header = await createPasswordHeader(MASTER, handle);
  await assert.rejects(() => openVaultKey(header, `${MASTER}x`), VaultAuthError);
});

test('the master password is never stored in the header', async () => {
  const handle = await generateVaultKey();
  const header = await createPasswordHeader(MASTER, handle);
  const serialized = JSON.stringify(header);
  assert.ok(!serialized.includes(MASTER), 'header must not contain the master password');
  assert.equal(header.salt?.length, 22, '16-byte salt in base64url');
});

test('each encryption uses a fresh nonce, so identical items differ on disk', async () => {
  const handle = await generateVaultKey();
  const item = { id: 'a', title: 'same', password: 'same' };
  const first = await sealItems(handle, 'a', item);
  const second = await sealItems(handle, 'a', item);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ct, second.ct);
});

test('a ciphertext cannot be moved to another item id', async () => {
  const handle = await generateVaultKey();
  const blob = await sealItems(handle, 'item-a', { secret: 'alpha' });
  await assert.rejects(() => openItems(handle, 'item-b', blob), VaultAuthError);
});

test('tampered ciphertext fails authentication', async () => {
  const handle = await generateVaultKey();
  const blob = await sealItems(handle, 'a', { secret: 'alpha' });
  const bytes = fromBase64Url(blob.ct);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  await assert.rejects(
    () => openItems(handle, 'a', { iv: blob.iv, ct: toBase64Url(bytes) }),
    VaultAuthError,
  );
});

test('rewrapping keeps existing item ciphertext valid', async () => {
  const handle = await generateVaultKey();
  const blob = await sealItems(handle, 'a', { title: 'GitHub' });

  const rewrapped = await rewrapVaultKey(handle, 'a brand new master password');
  const reopened = await openVaultKey(rewrapped, 'a brand new master password');

  assert.deepEqual(await openItems(reopened, 'a', blob), { title: 'GitHub' });
  await assert.rejects(() => openVaultKey(rewrapped, MASTER), VaultAuthError);
});

test('destroying the key scrubs the raw bytes', async () => {
  const handle = await generateVaultKey();
  assert.ok(handle.raw.some((byte) => byte !== 0));
  destroyVaultKey(handle);
  assert.ok(handle.raw.every((byte) => byte === 0));
});

/* ---- Optional vault password ----------------------------------------- */

test('a passwordless vault opens without a password', async () => {
  const handle = await generateVaultKey();
  const header = createDeviceHeader(handle);
  assert.equal(resolveHeader(header).protection, 'device');

  // No password is consulted, and a wrong one is irrelevant.
  const opened = await openVaultKey(header);
  assert.deepEqual(opened.raw, handle.raw);
  assert.deepEqual((await openVaultKey(header, 'anything at all')).raw, handle.raw);
});

test('a passwordless header stores the key directly', async () => {
  const handle = await generateVaultKey();
  const header = createDeviceHeader(handle);
  assert.equal(header.deviceKey, toBase64Url(handle.raw));
  assert.equal(header.wrapped, null);
});

test('legacy headers with no protection field are treated as password vaults', async () => {
  // Vaults written before the password became optional have no `protection`
  // key and always had a wrapped vault key.
  const handle = await generateVaultKey();
  const modern = await createPasswordHeader(MASTER, handle);
  const legacy = {
    v: modern.v,
    kdf: modern.kdf,
    iterations: modern.iterations,
    salt: modern.salt,
    wrapped: modern.wrapped,
  };

  assert.equal('protection' in legacy, false);
  assert.equal(resolveHeader(legacy).protection, 'password');
  assert.deepEqual((await openVaultKey(legacy, MASTER)).raw, handle.raw);
  await assert.rejects(() => openVaultKey(legacy, 'wrong'), VaultAuthError);
});

test('a damaged header is rejected rather than silently treated as passwordless', () => {
  assert.throws(
    () => resolveHeader({ v: 1, protection: 'password', kdf: 'PBKDF2-SHA256', iterations: 1, salt: 'x' }),
    /damaged/,
  );
  assert.throws(() => resolveHeader({ v: 1, protection: 'device' }), /damaged/);
});

test('vault service: passwordless create, open, and adding a password later', async () => {
  const storage = new MemoryVaultStorage();
  const vault = new VaultService(storage);

  await vault.create(); // no password
  assert.equal(await vault.protection(), 'device');

  const item = await vault.addItem({ title: 'Bank', username: 'me@example.com', password: 'secret-value' });
  vault.lock();
  assert.equal(await vault.unlock(), true, 'opens with no password at all');
  assert.equal((vault.items ?? [])[0]?.password, 'secret-value');

  // Enabling a password must not disturb existing ciphertexts.
  await vault.enablePassword(MASTER);
  assert.equal(await vault.protection(), 'password');
  vault.lock();

  assert.equal(await vault.unlock(''), false, 'an empty password no longer works');
  assert.equal(await vault.unlock(MASTER), true);
  assert.equal((vault.items ?? [])[0]?.password, 'secret-value');
  assert.equal((vault.items ?? [])[0]?.id, item.id);
});

test('vault service: setShowMail flips without touching timestamps', async () => {
  const vault = new VaultService(new MemoryVaultStorage());
  await vault.create(); // no password: fast device key, no PBKDF2
  const item = await vault.addItem({ title: 'Mail', username: 'me@gmail.com', password: 'x'.repeat(20), showMail: true });
  const before = (vault.items ?? []).find((entry) => entry.id === item.id)!;
  const updatedAt = before.updatedAt;
  const passwordAt = before.passwordUpdatedAt;

  await vault.setShowMail(item.id, false);
  const after = (vault.items ?? []).find((entry) => entry.id === item.id)!;
  assert.equal(after.showMail, false);
  assert.equal(after.updatedAt, updatedAt, 'scoping must not reorder "recently updated"');
  assert.equal(after.passwordUpdatedAt, passwordAt, 'scoping must not reset the age clocks');

  await vault.setShowMail(item.id, false);
  assert.equal((vault.items ?? []).find((entry) => entry.id === item.id)?.showMail, false);
});

test('vault service: removing the password requires the current one', async () => {
  const vault = new VaultService(new MemoryVaultStorage());
  await vault.create(MASTER);
  await vault.addItem({ title: 'GitHub', password: 'keep-me' });

  await assert.rejects(() => vault.disablePassword('wrong password'));
  assert.equal(await vault.protection(), 'password', 'still protected after a failed attempt');

  await vault.disablePassword(MASTER);
  assert.equal(await vault.protection(), 'device');

  vault.lock();
  assert.equal(await vault.unlock(), true);
  assert.equal((vault.items ?? [])[0]?.password, 'keep-me');
});

test('changing the password is refused on a passwordless vault', async () => {
  const vault = new VaultService(new MemoryVaultStorage());
  await vault.create();
  await assert.rejects(() => vault.changeMasterPassword('', 'irrelevant'), /no password/);
});

test('vault service: create, unlock, CRUD, lock, re-unlock', async () => {
  const storage = new MemoryVaultStorage();
  const vault = new VaultService(storage);

  assert.equal(await vault.exists(), false);
  await vault.create(MASTER);
  assert.equal(await vault.exists(), true);

  const item = await vault.addItem({
    title: 'GitHub',
    username: 'me@example.com',
    password: 'hunter2',
    url: 'github.com',
  });
  assert.equal(item.url, 'https://github.com', 'bare hostnames get a scheme');

  await vault.updateItem(item.id, { password: 'new-password' });
  await vault.updateItem(item.id, { favorite: true });

  vault.lock();
  assert.equal(vault.isUnlocked, false);
  const lockedItems = vault.items;
  assert.equal(lockedItems, null);

  assert.equal(await vault.unlock('wrong password'), false);
  assert.equal(await vault.unlock(MASTER), true);
  const reloaded = vault.items ?? [];
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.password, 'new-password');
  assert.equal(reloaded[0]?.favorite, true);

  await vault.deleteItem(item.id);
  assert.equal((vault.items ?? []).length, 0);
});

test('stored records never contain plaintext', async () => {
  const storage = new MemoryVaultStorage();
  const vault = new VaultService(storage);
  await vault.create(MASTER);
  await vault.addItem({ title: 'Bank', username: 'me@example.com', password: 'super-secret-value' });

  const raw = JSON.stringify(await storage.loadItems()) + JSON.stringify(await storage.loadHeader());
  assert.ok(!raw.includes('super-secret-value'), 'password must not be in storage');
  assert.ok(!raw.includes('me@example.com'), 'username must not be in storage');
  assert.ok(!raw.includes('Bank'), 'title must not be in storage');
});

test('a passwordless backup restores without a password', async () => {
  const source = new VaultService(new MemoryVaultStorage());
  await source.create(); // passwordless
  await source.addItem({ title: 'Solo', password: 'alpha' });
  const backup = await source.exportBackup();
  assert.equal(resolveHeader(backup.header).protection, 'device');

  // Any password must still verify, because none is required.
  assert.equal(await verifyBackupPassword(backup), true);
  assert.equal(await verifyBackupPassword(backup, 'irrelevant'), true);

  const target = new VaultService(new MemoryVaultStorage());
  await target.restoreBackup(backup);
  assert.equal(target.items?.length, 1);
  assert.equal(target.items?.[0]?.title, 'Solo');

  // Restoring it passwordless is also possible.
  const third = new VaultService(new MemoryVaultStorage());
  await third.restoreBackup(backup, undefined, '');
  assert.equal(await third.protection(), 'device');
  assert.equal(third.items?.[0]?.password, 'alpha');
});

test('a protected backup still refuses a wrong password', async () => {
  const source = new VaultService(new MemoryVaultStorage());
  await source.create(MASTER);
  await source.addItem({ title: 'Locked', password: 'alpha' });
  const backup = await source.exportBackup();

  assert.equal(await verifyBackupPassword(backup, MASTER), true);
  assert.equal(await verifyBackupPassword(backup, 'wrong'), false);
  await assert.rejects(() => new VaultService(new MemoryVaultStorage()).restoreBackup(backup, 'wrong'));
});

test('backup export/verify/restore preserves every item', async () => {
  const source = new VaultService(new MemoryVaultStorage());
  await source.create(MASTER);
  await source.addItem({ title: 'One', password: 'alpha' });
  await source.addItem({ title: 'Two', password: 'beta' });

  const backup = await source.exportBackup();

  const target = new VaultService(new MemoryVaultStorage());
  await target.restoreBackup(backup, MASTER);

  assert.equal(target.items?.length, 2);
  assert.deepEqual(
    target.items?.map((item) => item.title).sort(),
    ['One', 'Two'],
  );

  // A backup re-keyed on restore must still unlock with the new password.
  const third = new VaultService(new MemoryVaultStorage());
  await third.restoreBackup(backup, MASTER, 'totally different master');
  assert.equal(await third.unlock('totally different master'), true);
  assert.equal(third.items?.length, 2);
});

test('corrupt records are skipped instead of blocking unlock', async () => {
  const storage = new MemoryVaultStorage();
  const vault = new VaultService(storage);
  await vault.create(MASTER);
  const keep = await vault.addItem({ title: 'Good', password: 'x' });
  await storage.putItem({ id: 'broken', blob: { iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }, updatedAt: 0 });

  vault.lock();
  assert.equal(await vault.unlock(MASTER), true);
  assert.deepEqual(vault.items?.map((item) => item.id), [keep.id]);
});

test('password generator honours length and character sets', () => {
  const base = { length: 24, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true };
  const value = generatePassword(base);
  assert.equal(value.length, 24);
  assert.match(value, /[a-z]/);
  assert.match(value, /[A-Z]/);
  assert.match(value, /[0-9]/);
  assert.doesNotMatch(value, /[l1IO0o]/, 'ambiguous glyphs excluded');

  const digitsOnly = generatePassword({ ...base, lower: false, upper: false, symbols: false });
  assert.match(digitsOnly, /^[0-9]{24}$/);

  const seen = new Set(Array.from({ length: 40 }, () => generatePassword(base)));
  assert.ok(seen.size > 38, 'generator should not repeat');
});

test('passphrase mode returns whole words, not stray characters', () => {
  // Regression: a missing pair of parentheses once made .split() bind to only the
  // final string literal, so WORDS became one long string and every "word" was
  // a single character.
  const phrase = generatePassphrase(5);
  const words = phrase.split('-');
  assert.equal(words.length, 5);
  for (const word of words) {
    assert.ok(word.length >= 4, `"${word}" should be a real word, got ${word.length} chars`);
    assert.match(word, /^[a-z]+$/);
  }
  assert.equal(generatePassphrase(3).split('-').length, 3);
  assert.equal(generatePassphrase(12).split('-').length, 12);
});

test('randomInt handles bounds wider than one byte without hanging', () => {
  // Rejection sampling over a byte loops forever when max > 256, so exercise a
  // passphrase (whose word list is larger than 256) under a hard timeout.
  const started = Date.now();
  const phrase = generatePassphrase(8);
  assert.ok(Date.now() - started < 2000, 'generation must not spin');
  assert.equal(phrase.split('-').length, 8);
});

test('the suggested master password is strong and well formed', () => {
  // Regression: this used to be built from Math.random, which is not a
  // cryptographic source. It is the most important password in the app.
  const seen = new Set<string>();
  for (let i = 0; i < 25; i += 1) {
    const suggestion = suggestMasterPassword();
    const parts = suggestion.split('-');
    assert.equal(parts.length, 8, 'seven words plus a digit group');
    assert.match(suggestion, /^[a-z]+(-[a-z]+){6}-\d{4}$/);
    const words = parts.slice(0, -1);
    assert.equal(new Set(words).size, words.length, 'no word should repeat');
    const strength = estimateStrength(suggestion);
    assert.ok(strength.bits >= 60, `expected real entropy, got ${strength.bits} bits`);
    seen.add(suggestion);
  }
  assert.equal(seen.size, 25, 'suggestions must not repeat');
});

test('passphrase strength is not overstated', () => {
  // Regression: scoring a phrase as raw random characters reported ~226 bits for
  // a six-word passphrase whose real entropy is around 55.
  const phrase = generatePassphrase(6);
  const naive = phrase.length * Math.log2(36);
  const scored = estimateStrength(phrase).bits;
  assert.ok(scored < naive / 2, `expected word-list scoring, got ${scored} vs naive ${Math.round(naive)}`);
  assert.ok(scored > 30 && scored < 60, `expected a plausible passphrase score, got ${scored}`);
});

test('a long random password still scores as very strong', () => {
  const value = generatePassword({
    length: 24, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true,
  });
  const strength = estimateStrength(value);
  assert.equal(strength.score, 4);
  assert.ok(strength.bits >= 140, `expected high entropy, got ${strength.bits}`);
});

test('strength estimation separates weak from strong', () => {
  assert.equal(estimateStrength('').label, 'empty');
  assert.equal(estimateStrength('password1').score, 0);
  assert.ok(estimateStrength('password123').score <= 1);
  assert.ok(estimateStrength('Tr0ub4dor&3').score >= 1);
  // Scored by word-list size: four short words is genuinely modest, not "strong".
  assert.ok(estimateStrength('correct-horse-battery-staple').bits < 40);
  assert.ok(estimateStrength('correct-horse-battery-staple').score <= 2);
  assert.ok(estimateStrength(generatePassphrase(8)).score >= 2);
  assert.ok(estimateStrength(generatePassphrase(10)).score >= 3);
  assert.equal(estimateStrength(generatePassword({
    length: 32, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: false,
  })).score, 4);
});

test('TOTP matches RFC 6238 test vectors', async () => {
  // Base32 of the ASCII secret "12345678901234567890".
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(await totpCode(secret, 59_000), '287082');
  assert.equal(await totpCode(secret, 1_111_111_109_000), '081804');
  assert.equal(await totpCode(secret, 1_234_567_890_000), '005924');
});

test('utf8 helper survives multi-byte characters', () => {
  const text = 'pässwörd-日本語-🔐';
  assert.equal(new TextDecoder().decode(utf8ToBytes(text)), text);
});