import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendHistory,
  DEFAULT_PREFERENCES,
  historyEventsFor,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_EVENTS,
  normaliseHistory,
  normalisePreferences,
  type HistoryEvent,
} from '../src/vault/storage.ts';
import { emptyItem } from '../src/vault/types.ts';
import { BUILTIN_CHANNELS, normaliseBackgroundLook, normaliseChannels } from '../src/vault/channels.ts';

/**
 * The History channel, and the preferences it reads.
 *
 * The log is the only thing in the app that keeps a login after it has been
 * deleted, so the two rules that matter are: a delete records enough to put the
 * login back, and nothing a user typed can make the log unbounded. Both are
 * checked here against the same functions the app calls.
 */

function item(id: string, patch: Record<string, unknown> = {}) {
  return { ...emptyItem(id, 1_000), ...patch };
}

test('an addition, an edit and a delete each record the right thing', () => {
  const before = [item('a', { title: 'A', updatedAt: 10 }), item('b', { title: 'B', updatedAt: 10 })];
  const after = [
    item('a', { title: 'A renamed', updatedAt: 30 }),
    item('c', { title: 'C', updatedAt: 30 }),
  ];
  const events = historyEventsFor(before, after, 999);

  assert.deepEqual(
    events.map((event) => [event.action, event.itemId]),
    [
      ['edited', 'a'],
      ['added', 'c'],
      ['deleted', 'b'],
    ],
  );
  // Ordering is the after-list first so a paste reads top to bottom, then the
  // deletions — and every event carries the same clock reading.
  assert.ok(events.every((event) => event.at === 999));
  // The edit kept the version it replaced: without it there is nothing to
  // restore, and the newer title would be the only copy left.
  assert.equal(events[0]?.before?.title, 'A');
  assert.equal(events[0]?.title, 'A', 'the row is labelled with what it was called then');
  // A delete keeps the login itself, password included — that snapshot is the
  // only copy once the record is gone from storage.
  assert.equal(events[2]?.before?.id, 'b');
  assert.equal(events[2]?.before?.title, 'B');
  // An addition has nothing to go back to.
  assert.equal(events[1]?.before, null);
});

test('an untouched item is not logged at all', () => {
  const same = [item('a', { title: 'A', updatedAt: 10 })];
  assert.deepEqual(historyEventsFor(same, [...same]), []);
  // A write that only re-saves identical data must not fill the log with noise,
  // which is why the comparison is on `updatedAt` rather than on identity.
  assert.equal(historyEventsFor(same, [{ ...same[0]! }]).length, 0);
});

test('a re-save that changes nothing but the clock is not a change', () => {
  // Saving an editor without touching a field bumps `updatedAt` (and the two
  // per-field clocks with it). That is not an edit, and the log must not grow
  // a row for it.
  const before = [item('a', { title: 'A', updatedAt: 10, password: 'hunter2' })];
  const after = [
    item('a', {
      title: 'A',
      updatedAt: 99,
      password: 'hunter2',
      passwordUpdatedAt: 99,
      usernameUpdatedAt: 99,
    }),
  ];
  assert.deepEqual(historyEventsFor(before, after, 999), []);

  // A real change alongside the clock bump is still logged, with the old
  // version kept for Restore.
  const renamed = [item('a', { title: 'A renamed', updatedAt: 99, password: 'hunter2' })];
  const events = historyEventsFor(before, renamed, 999);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, 'edited');
  assert.equal(events[0]?.before?.title, 'A');
});

test('the log is bounded by count and by size', () => {
  const many = Array.from({ length: MAX_HISTORY_EVENTS + 25 }, (_, index) => ({
    id: `he_${index}`,
    at: index,
    action: 'added' as const,
    itemId: `item_${index}`,
    title: `Login ${index}`,
    username: 'me@x.com',
    before: null,
  }));
  const trimmed = appendHistory([], many);
  assert.equal(trimmed.length, MAX_HISTORY_EVENTS, 'the oldest entries fall off the end');
  // The tail of the block is what gets evicted: one mutation's entries share a
  // timestamp, so the order inside it is just the order the diff produced.
  assert.equal(trimmed[trimmed.length - 1]?.itemId, `item_${MAX_HISTORY_EVENTS - 1}`);

  // Between changes, the newest block goes on top — that is what makes the
  // channel read newest-first rather than sorted by anything.
  const older: HistoryEvent = {
    id: 'he_older', at: 1, action: 'added', itemId: 'i_old', title: 'Old', username: 'me@x.com', before: null,
  };
  const newer: HistoryEvent = {
    id: 'he_newer', at: 2, action: 'added', itemId: 'i_new', title: 'New', username: 'me@x.com', before: null,
  };
  assert.deepEqual(
    appendHistory(appendHistory([], [older]), [newer]).map((event) => event.id),
    ['he_newer', 'he_older'],
  );

  // A single login can be megabytes (an uploaded card image), so the count cap
  // alone cannot bound the record: the whole log has to fit too.
  const heavy = Array.from({ length: 20 }, (_, index) => ({
    id: `he_big_${index}`,
    at: index,
    action: 'deleted' as const,
    itemId: `item_${index}`,
    title: 'Big',
    username: 'me@x.com',
    before: item(`item_${index}`, { notes: 'x'.repeat(40_000) }),
  }));
  const bounded = appendHistory([], heavy);
  assert.ok(bounded.length < heavy.length, 'the size budget evicted entries');
  assert.ok(JSON.stringify(bounded).length <= MAX_HISTORY_CHARS);
});

test('a corrupt log is dropped rather than trusted', () => {
  const good: HistoryEvent = {
    id: 'he_ok',
    at: 5,
    action: 'deleted',
    itemId: 'i1',
    title: 'Keep',
    username: 'me@x.com',
    before: item('i1', { title: 'Keep', password: 'hunter2' }),
  };
  const out = normaliseHistory([
    good,
    { id: 'he_bad_action', at: 6, action: 'exploded', itemId: 'i2' },
    { id: 'he_no_item', at: 7, action: 'added', itemId: '' },
    null,
    'not an object',
    // A half-written snapshot is the shape a partial write leaves behind; no
    // restore is better than a login restored from half a record.
    { id: 'he_half', at: 8, action: 'deleted', itemId: 'i3', before: 'nope' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.id, 'he_ok');
  assert.equal(out[0]?.before?.password, 'hunter2', 'the snapshot survives a reload');
  assert.equal(out[1]?.before, null, 'an unreadable snapshot becomes "nothing to restore"');
  assert.deepEqual(normaliseHistory('not a list'), []);
  assert.deepEqual(normaliseHistory(undefined), []);
});

test('preferences carry the log, and a hand-edited record cannot break the load', () => {
  assert.deepEqual(DEFAULT_PREFERENCES.history, []);
  // No `before` field: that is exactly what a stored addition looks like, and
  // the partial record is the point of the test.
  const prefs = normalisePreferences({
    history: [
      { id: 'he_1', at: 4, action: 'added', itemId: 'i1', title: 'GitHub', username: 'me@x.com' },
    ],
  } as never);
  assert.equal(prefs.history.length, 1);
  assert.equal(prefs.history[0]?.title, 'GitHub');
  assert.deepEqual(normalisePreferences({ history: 'nonsense' } as never).history, []);
});

test('the animation-speed floor moved up so "Languid" cannot come back', () => {
  // The scale used to start at 0.25 and label it Languid; every transition
  // divided by it, so the whole app crawled. A stored vault, a saved profile and
  // a slider drag all have to be pulled up to Normal.
  assert.equal(normalisePreferences({ motionSpeed: 0.25 }).motionSpeed, 1);
  assert.equal(normalisePreferences({ motionSpeed: 0.5 }).motionSpeed, 1);
  assert.equal(normalisePreferences({ motionSpeed: 2 }).motionSpeed, 2);
  assert.equal(DEFAULT_PREFERENCES.motionSpeed, 2, 'and the shipped default stays at Instant');
});

test('micro-animations default on, and only an explicit no turns them off', () => {
  assert.equal(DEFAULT_PREFERENCES.microMotion, true);
  // A record saved before the switch existed has no field at all: it keeps the
  // animations rather than silently losing them on the first launch after the
  // update.
  assert.equal(normalisePreferences({}).microMotion, true);
  assert.equal(normalisePreferences({ microMotion: false }).microMotion, false);
  assert.equal(normalisePreferences({ microMotion: 'no' } as never).microMotion, true, 'only a real boolean counts');
});

test('a channel gained its own background look, and old records keep the app one', () => {
  const viaDefaults = normaliseBackgroundLook({});
  assert.deepEqual(viaDefaults, { backgroundOpacity: 0.35, backgroundBlur: 0, backgroundDim: 0.25 });
  // Hostile input is clamped field by field, like every other stored number.
  assert.deepEqual(normaliseBackgroundLook({ backgroundOpacity: 9, backgroundBlur: -4, backgroundDim: 5 }), {
    backgroundOpacity: 1,
    backgroundBlur: 0,
    backgroundDim: 0.9,
  });
  assert.deepEqual(normaliseBackgroundLook({ backgroundOpacity: NaN, backgroundBlur: 'x' as never }), viaDefaults);

  // The built-ins and any channel read from an old vault come back with the
  // three fields filled in, because applyChannelAppearance reads them directly.
  const [first] = normaliseChannels([{ id: 'all', kind: 'all', backgroundImage: 'https://x/y.jpg' } as never]);
  assert.equal(first?.backgroundOpacity, 0.35);
  assert.equal(first?.backgroundBlur, 0);
  assert.ok(BUILTIN_CHANNELS.every((channel) => typeof channel.backgroundDim === 'number'));
});

test('the History channel ships as a real, protected row', () => {
  const history = BUILTIN_CHANNELS.find((channel) => channel.kind === 'history');
  assert.ok(history, 'there is a History channel');
  assert.equal(history.locked, true, 'it cannot be deleted — it is part of the app, like Dashboard and Mail');
  assert.equal(history.icon, 'clock');
  // It can still be renamed, recoloured or hidden like any other row: `locked`
  // guards deletion, not customisation.
  const [custom] = normaliseChannels([
    { ...history, name: 'Log', hue: 12, locked: false } as never,
  ]);
  assert.equal(custom?.name, 'Log');
  assert.equal(custom?.kind, 'history', 'a renamed history channel stays the history channel');
  assert.equal(custom?.locked, true, 'and cannot be talked out of being locked');

  // A channel somebody made and named History is adopted rather than duplicated.
  const adopted = normaliseChannels([
    { id: 'ch_h', name: 'History', kind: 'all', tagIds: [], icon: 'layers', hue: 28, accent: 'clay', backgroundImage: '', builtin: false, locked: false, showMail: false, mailAccount: 'all' } as never,
  ]);
  assert.equal(adopted.filter((channel) => channel.kind === 'history').length, 1);
  assert.equal(adopted.find((channel) => channel.id === 'ch_h')?.kind, 'history');
});
