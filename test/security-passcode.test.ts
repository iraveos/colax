import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SECURITY,
  hashPasscode,
  isSecured,
  passcodeTooWeak,
  requiresVerification,
  securityLevel,
  verifyPasscode,
  type LoginSecurity,
} from '../src/crypto/security.ts';

const withPasscode = (): LoginSecurity => ({ ...EMPTY_SECURITY, passcode: { hash: 'h', salt: 's' } });

test('a login with no factor is neither secured nor requiring verification', () => {
  assert.equal(isSecured(EMPTY_SECURITY), false);
  assert.equal(requiresVerification(EMPTY_SECURITY), false);
  assert.equal(securityLevel(EMPTY_SECURITY), 'none');
  assert.equal(isSecured(undefined), false);
});

test('a passcode alone counts as a second factor and gates the login', () => {
  const security = withPasscode();
  assert.equal(isSecured(security), true);
  assert.equal(requiresVerification(security), true);
  assert.equal(securityLevel(security), 'partial');
});

test('every single factor on its own is enough to gate the login', () => {
  // The user's requirement: no factor combination may show the password or the
  // editor without a check, so each factor alone has to be sufficient.
  const factors: LoginSecurity[] = [
    { totp: { seed: 'JBSWY3DPEHPK3PXP' }, questions: [], passcode: null },
    { totp: null, questions: [], passcode: { hash: 'h', salt: 's' } },
  ];
  for (const security of factors) {
    assert.equal(requiresVerification(security), true);
  }
});

test('two factors report full protection', () => {
  const security: LoginSecurity = {
    totp: { seed: 'JBSWY3DPEHPK3PXP' },
    questions: [],
    passcode: { hash: 'h', salt: 's' },
  };
  assert.equal(securityLevel(security), 'full');
});

test('a passcode round-trips', async () => {
  const stored = await hashPasscode('correct horse battery');
  assert.equal(await verifyPasscode(stored, 'correct horse battery'), true);
  assert.equal(await verifyPasscode(stored, 'wrong horse battery'), false);
});

test('a passcode is compared verbatim, not case-folded', async () => {
  // Recovery answers are normalised so "New York" matches "new-york". A
  // passcode must NOT be: it is typed exactly, so folding case would accept a
  // password the user never set.
  const stored = await hashPasscode('PassWord123');
  assert.equal(await verifyPasscode(stored, 'PassWord123'), true);
  assert.equal(await verifyPasscode(stored, 'password123'), false);
  assert.equal(await verifyPasscode(stored, 'PASSWORD123'), false);
});

test('passcode whitespace and punctuation are significant', async () => {
  const stored = await hashPasscode('  spaces matter  ');
  assert.equal(await verifyPasscode(stored, '  spaces matter  '), true);
  assert.equal(await verifyPasscode(stored, 'spaces matter'), false);
  assert.equal(await verifyPasscode(stored, 'spaces  matter'), false);
});

test('each stored passcode gets its own salt', async () => {
  const a = await hashPasscode('same password');
  const b = await hashPasscode('same password');
  assert.notEqual(a.salt, b.salt, 'identical passcodes must not produce identical records');
  assert.notEqual(a.hash, b.hash);
});

test('weak passcodes are refused', () => {
  for (const weak of ['', 'short', 'password', 'Password1', '12345678', 'aaaaaaaa', 'qwertyui']) {
    assert.equal(passcodeTooWeak(weak), true, `${weak} should be refused`);
  }
});

test('reasonable passcodes are accepted', () => {
  for (const ok of ['correct horse', 'Tr0ub4dor&3', 'a-long-one-9x', 'J8#kq2!vLz']) {
    assert.equal(passcodeTooWeak(ok), false, `${ok} should be accepted`);
  }
});

test('a record with no passcode key at all is treated as unsecured', () => {
  // Stored before passcodes existed, so `passcode` is undefined rather than
  // null. It must not be mistaken for a configured factor.
  const legacy: LoginSecurity = { totp: null, questions: [] };
  assert.equal(isSecured(legacy), false);
  assert.equal(requiresVerification(legacy), false);
});