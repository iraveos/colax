import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseReusableEmails,
  normaliseTempMailbox,
  pickReusableEmail,
  tempMailRemainingLabel,
} from '../src/lib/temp-mail.ts';
import { loginShowsMail, planMailLinkedOnly } from '../src/vault/site-intel.ts';
import { emptyItem, normaliseItem } from '../src/vault/types.ts';

const rawMailbox = {
  provider: 'mohmal' as const,
  address: '  Temp.User@Emailnox.live ',
  sessionKey: 'A1B2C3D4E5F60708',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000,
};

test('temporary mailbox metadata is normalised and capped', () => {
  const mailbox = normaliseTempMailbox(rawMailbox);
  assert.ok(mailbox);
  assert.equal(mailbox.address, 'temp.user@emailnox.live');
  assert.equal(mailbox.sessionKey, 'a1b2c3d4e5f60708');
  assert.equal(mailbox.expiresAt, rawMailbox.expiresAt);

  assert.equal(normaliseTempMailbox({ ...rawMailbox, sessionKey: '' }), null);
  assert.equal(normaliseTempMailbox({ ...rawMailbox, address: 'not-an-address' }), null);
  assert.equal(normaliseTempMailbox({ ...rawMailbox, provider: 'other' }), null);

  const tooLong = normaliseTempMailbox({
    ...rawMailbox,
    expiresAt: rawMailbox.createdAt + 7 * 24 * 60 * 60 * 1000,
  });
  assert.ok(tooLong);
  assert.equal(tooLong.expiresAt, rawMailbox.createdAt + 24 * 60 * 60 * 1000);
});

test('saved emails are deduplicated and reject non-addresses', () => {
  assert.deepEqual(
    normaliseReusableEmails([' a@example.com ', 'A@Example.com', 'b@example.com', 'nope']),
    ['a@example.com', 'b@example.com'],
  );
  assert.deepEqual(normaliseReusableEmails('a@example.com'), []);
});

test('random saved email avoids the address already shown', () => {
  assert.equal(pickReusableEmail(['a@example.com', 'b@example.com'], 'a@example.com', () => 0), 'b@example.com');
  assert.equal(pickReusableEmail(['a@example.com'], 'a@example.com', () => 0), 'a@example.com');
  assert.equal(pickReusableEmail([], 'a@example.com'), '');
});

test('a disposable inbox keeps its Messages button without an IMAP account', () => {
  const item = {
    username: 'temp@example.com',
    showMail: true,
    tempMail: rawMailbox,
  };
  assert.equal(loginShowsMail(item, []), true);
  assert.equal(loginShowsMail({ ...item, showMail: false }, []), false);
  assert.equal(loginShowsMail(item, [], false), false);
});

test('the linked-only mail migration leaves disposable inboxes alone', () => {
  const account = { address: 'owner@gmail.com', appPassword: 'x', enabled: true };
  const items = [
    { id: 'temp', username: 'temp@example.com', showMail: true, tempMail: rawMailbox },
    { id: 'other', username: 'other@example.com', showMail: true },
    { id: 'owner', username: 'owner@gmail.com', showMail: true },
  ];
  assert.deepEqual(planMailLinkedOnly(items, [account]), ['other']);
});

test('vault items round-trip temporary mailbox metadata', () => {
  const empty = emptyItem('one', 1_700_000_000_000);
  assert.equal(empty.tempMail, null);
  const item = normaliseItem({ id: 'one', tempMail: rawMailbox }, 1_700_000_000_000);
  assert.equal(item.tempMail?.address, 'temp.user@emailnox.live');
  assert.equal(tempMailRemainingLabel(item.tempMail!, 1_700_000_300_000), '5 min left');
  assert.equal(tempMailRemainingLabel(item.tempMail!, 1_700_000_700_000), 'expired');
});
