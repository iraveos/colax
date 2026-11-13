import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChannel, BUILTIN_CHANNELS } from '../src/vault/channels.ts';
import { buildEmailRoadmap, isEmailLike } from '../src/vault/email-roadmap.ts';
import { emptyItem } from '../src/vault/types.ts';
import type { GmailAccount } from '../src/vault/storage.ts';

const account = (id: string, address: string): GmailAccount => ({
  id,
  address,
  appPassword: 'app-password',
  enabled: true,
  refreshSeconds: 60,
  provider: 'gmail',
});

test('an address merges its logins, mailbox and saved flag into one identity', () => {
  const items = [
    { ...emptyItem('i1', 10), title: 'Bank', username: 'Me@Example.com', url: 'https://bank.example.com', updatedAt: 20 },
    { ...emptyItem('i2', 10), title: 'Shop', username: 'me@example.com', url: 'https://shop.example.com', updatedAt: 30 },
  ];
  const roadmap = buildEmailRoadmap(
    items,
    [account('gm_1', 'me@example.com')],
    ['me@example.com', 'spare@example.com'],
    {},
  );

  const identity = roadmap.identities.find((entry) => entry.key === 'me@example.com');
  assert.ok(identity, 'the address is present');
  assert.deepEqual(identity.logins.map((item) => item.id), ['i1', 'i2']);
  assert.deepEqual(identity.statuses, ['connected', 'saved', 'vault']);
  assert.equal(identity.primary, 'connected');
  assert.equal(identity.lastUpdated, 30);
  assert.deepEqual(identity.domains.sort(), ['bank.example.com', 'shop.example.com']);
  assert.equal(roadmap.linkedLogins, 2);
  assert.equal(roadmap.counts.connected, 1);
  assert.equal(roadmap.counts.saved, 2);
});

test('the address owner is the first login saved with it, not the newest edit', () => {
  const items = [
    // i2 was edited most recently but i1 arrived first: arrival is what makes
    // i1 the address's main login, so the click target cannot drift every save.
    { ...emptyItem('i2', 30), title: 'Shop', username: 'me@example.com', updatedAt: 99 },
    { ...emptyItem('i1', 10), title: 'Bank', username: 'me@example.com', updatedAt: 20 },
  ];
  const roadmap = buildEmailRoadmap(items, [], [], {});
  const identity = roadmap.identities.find((entry) => entry.key === 'me@example.com');
  assert.ok(identity);
  assert.equal(identity.mainLogin?.id, 'i1');
});

test('an address with no own login falls back to the disposable inbox holder', () => {
  const item = {
    ...emptyItem('i1', 10),
    title: 'Trial',
    username: 'trialuser',
    tempMail: {
      provider: 'mohmal' as const,
      address: 'temp@mohmal.com',
      sessionKey: '0123456789abcdef',
      createdAt: 10,
      expiresAt: 20,
      autoRenewMinutes: 10,
      lastRenewedAt: 10,
    },
  };
  const roadmap = buildEmailRoadmap([item], [], [], {});
  const identity = roadmap.identities.find((entry) => entry.key === 'temp@mohmal.com');
  assert.ok(identity);
  assert.equal(identity.mainLogin?.id, 'i1');
});

test('a connected mailbox with no login has no main login to open', () => {
  const roadmap = buildEmailRoadmap([], [account('gm_1', 'quiet@example.com')], [], {});
  assert.equal(roadmap.identities[0]!.mainLogin, null);
});

test('a disposable inbox links its login even when the username is not an address', () => {
  const item = {
    ...emptyItem('i1', 10),
    title: 'Trial',
    username: 'trialuser',
    tempMail: {
      provider: 'mohmal' as const,
      address: 'temp@mohmal.com',
      sessionKey: '0123456789abcdef',
      createdAt: 10,
      expiresAt: 20,
      autoRenewMinutes: 10,
      lastRenewedAt: 10,
    },
  };
  const roadmap = buildEmailRoadmap([item], [], [], {});
  const identity = roadmap.identities.find((entry) => entry.key === 'temp@mohmal.com');
  assert.ok(identity);
  assert.deepEqual(identity.statuses, ['disposable']);
  assert.deepEqual(identity.logins.map((entry) => entry.id), ['i1']);
  assert.equal(roadmap.unlinked.length, 0);
});

test('a login with no address is reported as unlinked', () => {
  const item = { ...emptyItem('i1', 10), title: 'Router', username: 'admin' };
  const roadmap = buildEmailRoadmap([item], [], [], {});
  assert.deepEqual(roadmap.unlinked.map((entry) => entry.id), ['i1']);
  assert.equal(roadmap.identities.length, 0);
});

test('connected accounts with no login still appear as identities', () => {
  const roadmap = buildEmailRoadmap([], [account('gm_1', 'quiet@example.com')], [], {});
  const identity = roadmap.identities.find((entry) => entry.key === 'quiet@example.com');
  assert.ok(identity);
  assert.equal(identity.logins.length, 0);
  assert.deepEqual(identity.statuses, ['connected']);
});

test('mail cache is counted per connected account', () => {
  const roadmap = buildEmailRoadmap(
    [],
    [account('gm_1', 'me@example.com')],
    [],
    {
      gm_1: [
        { id: 'm1', title: 'One', author: 'A', email: 'a@x.com', summary: '', issued: '2025-01-01T00:00:00Z', alternate: '', accountId: 'gm_1' },
        { id: 'm2', title: 'Two', author: 'B', email: 'b@x.com', summary: '', issued: '2025-02-01T00:00:00Z', alternate: '', accountId: 'gm_1' },
      ],
    },
  );
  const identity = roadmap.identities[0]!;
  assert.equal(identity.mailCount, 2);
  assert.equal(identity.latestMail?.id, 'm2');
});

test('the roadmap channel lists only logins that carry an address', () => {
  const roadmap = BUILTIN_CHANNELS.find((channel) => channel.kind === 'roadmap');
  assert.ok(roadmap, 'the channel ships as a built-in');
  const items = [
    { ...emptyItem('email', 1), username: 'me@example.com' },
    { ...emptyItem('plain', 1), username: 'admin' },
    {
      ...emptyItem('temp', 1),
      username: 'player',
      tempMail: {
        provider: 'mohmal' as const,
        address: 'temp@mohmal.com',
        sessionKey: '0123456789abcdef',
        createdAt: 1,
        expiresAt: 2,
        autoRenewMinutes: 10,
        lastRenewedAt: 1,
      },
    },
  ];
  assert.deepEqual(
    applyChannel(roadmap, items).map((item) => item.id),
    ['email', 'temp'],
  );
});

test('email shape is loose enough for a vault address', () => {
  assert.equal(isEmailLike('me@example.com'), true);
  assert.equal(isEmailLike('not-an-address'), false);
  assert.equal(isEmailLike('@example.com'), false);
  assert.equal(isEmailLike('me@'), false);
  assert.equal(isEmailLike('me @example.com'), false);
});
