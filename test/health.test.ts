import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePreferences, DEFAULT_PREFERENCES } from '../src/vault/storage.ts';
import { emptyItem, findWeakItems, isWeakPassword, normaliseItem, staleDaysFor } from '../src/vault/types.ts';
import type { VaultItem } from '../src/vault/types.ts';

/** A mutable copy of the defaults, so a test can corrupt one field. */
const base = () => structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;

const login = (over: Partial<VaultItem> = {}): VaultItem => ({
  ...emptyItem(`id-${Math.random().toString(36).slice(2, 8)}`, 1000),
  password: 'correct horse battery staple extra words here',
  passwordUpdatedAt: Date.now(),
  ...over,
});

test('usage keeps only well-shaped entries, capped by recency', () => {
  const stored = base();
  stored.usage = {
    good: { count: 3, at: 3000 },
    zeroed: { count: 0, at: 0 },
    malformed: { count: 'many', at: null },
    negative: { count: -2, at: 1000 },
  };
  const out = normalisePreferences(stored);
  assert.deepEqual(Object.keys(out.usage), ['good', 'negative']);
  assert.deepEqual(out.usage.good, { count: 3, at: 3000 });
  // A negative count is meaningless; it normalises rather than throwing.
  assert.equal(out.usage.negative?.count, 0);
});

test('usage caps at 200 entries, newest first', () => {
  const stored = base();
  const usage: Record<string, { count: number; at: number }> = {};
  for (let i = 0; i < 250; i += 1) usage[`id-${i}`] = { count: 1, at: i };
  stored.usage = usage;
  const out = normalisePreferences(stored);
  assert.equal(Object.keys(out.usage).length, 200);
  assert.ok('id-249' in out.usage, 'newest survives');
  assert.ok(!('id-0' in out.usage), 'oldest pruned');
});

test('a low-strength password is weak even when unique and fresh', () => {
  const weak = login({ password: 'password1', passwordUpdatedAt: Date.now() });
  assert.ok(isWeakPassword(weak));
  assert.ok(findWeakItems([weak], 36500).includes(weak));
});

test('a strong unique fresh password is not weak', () => {
  const strong = login();
  assert.equal(isWeakPassword(strong), false);
  assert.equal(findWeakItems([strong], 36500).length, 0);
});

test('an empty password is never weak', () => {
  // Otherwise every login-in-progress would flash warnings while being typed.
  assert.equal(isWeakPassword({ password: '' }), false);
  assert.equal(findWeakItems([login({ password: '' })], 36500).length, 0);
});

test('same-pattern passwords group together', () => {
  const a = login({ password: 'Summer2023!' });
  const b = login({ password: 'summer2024!' });
  const weak = findWeakItems([a, b], 36500);
  assert.ok(weak.includes(a) && weak.includes(b), 'rotations that only bump a number group up');
});

test('short shared stems do not group', () => {
  // Both reduce to the stem "ab", which is too short to mean a pattern — and
  // both are long enough to be strong on their own, so neither path may flag.
  const a = login({ password: `ab${'1'.repeat(30)}` });
  const b = login({ password: `ab${'2'.repeat(30)}` });
  assert.ok(!isWeakPassword(a) && !isWeakPassword(b), 'fixtures must be individually strong');
  const weak = findWeakItems([a, b], 36500);
  assert.ok(!weak.includes(a) && !weak.includes(b));
});

test('messages are on per login unless switched off, old records keep showing mail', () => {
  assert.equal(emptyItem('x', 1000).showMail, true, 'new logins start opted in');
  assert.equal(normaliseItem({ ...emptyItem('x', 1000), showMail: true }).showMail, true);
  assert.equal(normaliseItem({ ...emptyItem('x', 1000), showMail: false }).showMail, false);
  const { showMail: _dropped, ...legacy } = emptyItem('x', 1000);
  assert.equal(normaliseItem({ ...legacy }).showMail, true, 'records predating the toggle keep mail');
});

test('a per-login reminder overrides the global stale threshold', () => {
  assert.equal(staleDaysFor({ reminderDays: 0 }, 180), 180);
  assert.equal(staleDaysFor({ reminderDays: 30 }, 180), 30);
  // Fractional days carry minutes and hours: 15 minutes survives the round trip.
  assert.equal(staleDaysFor({ reminderDays: 15 / 1440 }, 180), 15 / 1440);
  assert.equal(normaliseItem({ ...emptyItem('x', 1000) }).reminderDays, 0);
  assert.equal(normaliseItem({ ...emptyItem('x', 1000), reminderDays: 45.7 }).reminderDays, 45.7);
  assert.equal(normaliseItem({ ...emptyItem('x', 1000), reminderDays: -5 }).reminderDays, 0);
});

test('a minutes-scale reminder flags within the hour', () => {
  const old = Date.now() - 20 * 60_000;
  const quick = login({ passwordUpdatedAt: old, reminderDays: 15 / 1440 });
  const slow = login({ passwordUpdatedAt: old, reminderDays: 0 });
  assert.ok(findWeakItems([quick], 180).includes(quick), '15-minute reminder flags a 20-minute password');
  assert.ok(!findWeakItems([slow], 180).includes(slow), 'global 180 days spares it');
});

test('stale flagging follows the login reminder, not just the global', () => {
  const old = Date.now() - 40 * 86_400_000;
  const strict = login({ passwordUpdatedAt: old, reminderDays: 30 });
  const lax = login({ passwordUpdatedAt: old, reminderDays: 0 });
  // Strong unique passwords: only age can flag them.
  assert.ok(findWeakItems([strict], 180).includes(strict), '30-day reminder flags a 40-day password');
  assert.ok(!findWeakItems([lax], 180).includes(lax), 'global 180 days spares it');
});
