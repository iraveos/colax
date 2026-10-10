import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_CACHE_CAP,
  mergeMailCache,
  normalisePreferences,
  type CachedMailMessage,
} from '../src/vault/storage.ts';
import { gmailOpenUrl } from '../src/ui/useGmail.ts';

const message = (over: Partial<CachedMailMessage> = {}): CachedMailMessage => ({
  id: `m-${Math.random().toString(36).slice(2, 8)}`,
  title: 'Subject',
  author: 'Sender',
  email: 'sender@example.com',
  summary: 'snippet',
  issued: new Date(1000).toISOString(),
  alternate: 'https://mail.google.com',
  accountId: 'gm_1',
  ...over,
});

test('fresh reads merge ahead of cached ones, newest first', () => {
  const old = message({ id: 'old', issued: new Date(1000).toISOString() });
  const fresh = message({ id: 'fresh', issued: new Date(2000).toISOString() });
  const next = mergeMailCache({ gm_1: [old] }, 'gm_1', [fresh]);
  assert.deepEqual(next.gm_1?.map((entry) => entry.id), ['fresh', 'old']);
});

test('the same message fetched twice is stored once', () => {
  const one = message({ id: 'same' });
  const next = mergeMailCache({ gm_1: [one] }, 'gm_1', [{ ...one }]);
  assert.equal(next.gm_1?.length, 1);
});

test('a read with nothing new returns the same cache reference', () => {
  const cache = { gm_1: [message({ id: 'a' }), message({ id: 'b' })] };
  assert.equal(mergeMailCache(cache, 'gm_1', [{ ...cache.gm_1![1]! }]), cache);
  assert.equal(mergeMailCache(cache, 'gm_1', []), cache);
  assert.notEqual(mergeMailCache(cache, 'gm_1', [message({ id: 'c' })]), cache);
});

test('other accounts are left untouched', () => {
  const other = message({ id: 'other', accountId: 'gm_2' });
  const next = mergeMailCache({ gm_2: [other] }, 'gm_1', [message({ id: 'new' })]);
  assert.deepEqual(next.gm_2?.map((entry) => entry.id), ['other']);
  assert.equal(next.gm_1?.length, 1);
});

test('the cache caps per account so one mailbox cannot grow prefs forever', () => {
  const incoming = Array.from({ length: MAIL_CACHE_CAP + 50 }, (_, index) =>
    message({ id: `m-${index}`, issued: new Date(1000 + index).toISOString() }),
  );
  const next = mergeMailCache({}, 'gm_1', incoming);
  assert.equal(next.gm_1?.length, MAIL_CACHE_CAP);
  assert.equal(next.gm_1?.[0]?.id, `m-${MAIL_CACHE_CAP + 49}`);
});

test('malformed stored entries are dropped, good ones kept', () => {
  const stored: Record<string, unknown> = {
    gm_1: [message({ id: 'good' }), { id: 42, title: 'junk' }, null, 'nope'],
  };
  const out = normalisePreferences({ mailCache: stored } as never);
  assert.deepEqual(out.mailCache.gm_1?.map((entry) => entry.id), ['good']);
});

test('a missing cache normalises to empty, not undefined', () => {
  const out = normalisePreferences({});
  assert.deepEqual(out.mailCache, {});
});

test('the Gmail link pins the account session and the message id', () => {
  assert.equal(
    gmailOpenUrl({ id: 'tag:gmail.google.com,2004:18f3ab02cd', title: 'Hi', alternate: '' }, 'me@gmail.com'),
    'https://mail.google.com/mail/u/me%40gmail.com/#inbox/18f3ab02cd',
  );
});

test('imap rows link by subject search, never by UID deep link', () => {
  assert.equal(
    gmailOpenUrl({ id: 'imap:48213', title: 'Invoice March', alternate: '' }, 'me@gmail.com'),
    'https://mail.google.com/mail/u/me%40gmail.com/#search/Invoice%20March',
  );
});

test('without a usable id the link falls back to a subject search', () => {
  assert.equal(
    gmailOpenUrl({ id: 'whatever', title: 'Invoice March', alternate: 'https://mail.google.com/x' }, 'me@gmail.com'),
    'https://mail.google.com/mail/u/me%40gmail.com/#search/Invoice%20March',
  );
  assert.equal(
    gmailOpenUrl({ id: '', title: '', alternate: '' }, ''),
    'https://mail.google.com',
  );
});
