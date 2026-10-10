import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BALANCED_STYLE,
  cleanProfileName,
  FULL_DETAIL_STYLE,
  MAX_OPTIMIZE_PROFILES,
  MAX_SAVINGS_STYLE,
  newOptimizeProfileId,
  normaliseOptimizeProfiles,
  optimisationsOn,
  OPTIMISATION_COUNT,
  readStyle,
  sameStyle,
  snapshotStyle,
  styleFromPrefs,
  stylePatch,
} from '../src/vault/optimize.ts';
import { DEFAULT_PREFERENCES, normalisePreferences, newGmailAccountId } from '../src/vault/storage.ts';

const prefs = () => normalisePreferences(undefined);

test('the counter can reach its own total, and shipped defaults score honest', () => {
  assert.equal(OPTIMISATION_COUNT, 8, 'eight switches, eight countable savings');
  const base = prefs();
  // Shipped defaults score exactly two, and both are facts the panel shows as
  // locked switches: no full-bleed photo is being repainted, and no mailbox is
  // connected so nothing polls in the background. The old panel could not say
  // that — it hid the rows, or counted a saving it had not made.
  assert.equal(optimisationsOn(base), 2, 'no picture to repaint, no mailbox polling');
  const saved = { ...base, ...stylePatch(base, MAX_SAVINGS_STYLE) };
  assert.equal(optimisationsOn(saved), OPTIMISATION_COUNT, 'maximum savings reaches the total');
  assert.equal(optimisationsOn({ ...base, ...stylePatch(base, FULL_DETAIL_STYLE) }), 2);
  assert.equal(optimisationsOn({ ...base, ...stylePatch(base, BALANCED_STYLE) }) > 2, true);
});

test('a style round-trips through the preferences it describes', () => {
  const base = prefs();
  const max = { ...base, ...stylePatch(base, MAX_SAVINGS_STYLE) };
  const snapshot = styleFromPrefs(max);
  for (const key of [
    'motion',
    'motionSpeed',
    'ambient',
    'reduceTransparency',
    'density',
    'cardDepth',
    'disableSpellcheck',
  ] as const) {
    assert.deepEqual(snapshot[key], MAX_SAVINGS_STYLE[key], `${key} survives the round trip`);
  }
  assert.equal(snapshot.mailRefreshSeconds, null, 'a plain snapshot never claims a mail cadence');
});

test('a profile never rewrites the mail cadence it did not measure', () => {
  const account = { id: newGmailAccountId(), address: 'me@gmail.com', appPassword: 'x', enabled: true, refreshSeconds: 0 };
  const base = normalisePreferences({ gmailAccounts: [account] });
  // "Off" is a deliberate choice; a profile carrying null must leave it alone,
  // which the old panel got wrong by always writing a number back.
  assert.equal(stylePatch(base, FULL_DETAIL_STYLE).gmailAccounts, undefined);
  assert.equal(optimisationsOn(base), 1, 'an account set to Off is a real, deliberate saving');
  const stretched = stylePatch(base, MAX_SAVINGS_STYLE);
  assert.equal(stretched.gmailAccounts?.[0]?.refreshSeconds, 900);
});

test('the snapshot captures a shared mail cadence and refuses a mixed one', () => {
  const account = { id: newGmailAccountId(), address: 'me@gmail.com', appPassword: 'x', enabled: true, refreshSeconds: 60 };
  const second = { ...account, id: newGmailAccountId(), address: 'you@gmail.com', refreshSeconds: 60 };
  assert.equal(snapshotStyle(normalisePreferences({ gmailAccounts: [account] })).mailRefreshSeconds, 60);
  assert.equal(snapshotStyle(normalisePreferences({ gmailAccounts: [account, second] })).mailRefreshSeconds, 60);
  // Mixed cadences are the user's own arrangement; guessing one would flatten it.
  assert.equal(
    snapshotStyle(normalisePreferences({ gmailAccounts: [account, { ...second, refreshSeconds: 900 }] }))
      .mailRefreshSeconds,
    null,
  );
  assert.equal(snapshotStyle(normalisePreferences({})).mailRefreshSeconds, null);
});

test('a stored style is clamped field by field, never trusted', () => {
  const hostile = readStyle({
    motion: -5,
    motionSpeed: 99,
    ambient: 42,
    reduceTransparency: 'yes',
    density: 'enormous',
    cardDepth: -1,
    backgroundImage: 'javascript:alert(1)',
    backgroundOpacity: 9,
    backgroundBlur: 1000,
    backgroundDim: 5,
    mailRefreshSeconds: 99999,
    disableSpellcheck: 'true',
  });
  assert.ok(hostile);
  assert.equal(hostile!.motion, 0);
  assert.equal(hostile!.motionSpeed, 2, 'the top of the animation-speed slider');
  assert.equal(
    FULL_DETAIL_STYLE.motionSpeed,
    DEFAULT_PREFERENCES.motionSpeed,
    'restoring the look restores the speed the app ships with',
  );
  assert.equal(hostile!.ambient, 1);
  assert.equal(hostile!.reduceTransparency, false, 'only a real boolean counts');
  assert.equal(hostile!.density, 'comfortable');
  assert.equal(hostile!.cardDepth, 0);
  assert.equal(hostile!.backgroundImage, '', 'a script URL can never become a background');
  assert.equal(hostile!.backgroundOpacity, 1);
  assert.equal(hostile!.backgroundBlur, 40);
  assert.equal(hostile!.backgroundDim, 0.9);
  assert.equal(hostile!.mailRefreshSeconds, 3600);
  assert.equal(hostile!.disableSpellcheck, false);
  assert.equal(readStyle(null), null);
  assert.equal(readStyle('nonsense'), null);
  // Data URLs and https URLs are the two forms the appearance settings accept.
  assert.equal(readStyle({ backgroundImage: 'data:image/png;base64,AAAA' })?.backgroundImage, 'data:image/png;base64,AAAA');
  assert.equal(readStyle({ backgroundImage: 'https://x.test/a.png' })?.backgroundImage, 'https://x.test/a.png');
});

test('profiles are deduplicated by name, newest first, and bounded', () => {
  const make = (name: string, createdAt: number) => ({
    id: newOptimizeProfileId(),
    name,
    createdAt,
    style: MAX_SAVINGS_STYLE,
  });
  const cleaned = normaliseOptimizeProfiles([make('Night', 1), make('night', 5), make('Day', 3), null, 7, { name: 'broken' }]);
  assert.equal(cleaned.length, 2, 'the unreadable record is dropped, not guessed at');
  assert.equal(cleaned[0]?.name, 'night', 'the newer of two names wins, keeping the user its spelling');
  assert.equal(cleaned[1]?.name, 'Day');
  const many = normaliseOptimizeProfiles(Array.from({ length: MAX_OPTIMIZE_PROFILES + 6 }, (_, i) => make(`p${i}`, i)));
  assert.equal(many.length, MAX_OPTIMIZE_PROFILES);
  assert.equal(many[0]?.name, `p${MAX_OPTIMIZE_PROFILES + 5}`, 'the most recent survive');
  assert.deepEqual(normaliseOptimizeProfiles(undefined), []);
  assert.deepEqual(normaliseOptimizeProfiles('nope'), []);
});

test('profile names are trimmed, collapsed and never empty', () => {
  assert.equal(cleanProfileName('  Evening   focus  '), 'Evening focus');
  assert.equal(cleanProfileName(''), 'Untitled look');
  assert.equal(cleanProfileName('   ', 'Fallback'), 'Fallback');
  assert.equal(cleanProfileName('x'.repeat(80)).length, 40);
});

test('a preference record repairs its profiles, snapshot and active name', () => {
  const stored = normalisePreferences({
    optimizeProfiles: [
      { id: 'a', name: 'Night', createdAt: 2, style: MAX_SAVINGS_STYLE },
      { id: 'b', name: 'Broken', createdAt: 3, style: { motion: 1 } as unknown as typeof MAX_SAVINGS_STYLE },
    ],
    optimizeSnapshot: {
      motion: 0.4,
      density: 'spacious',
      backgroundImage: 'https://x.test/a.png',
    } as unknown as typeof MAX_SAVINGS_STYLE,
    activeOptimizeProfile: 'Night',
    disableSpellcheck: true,
  });
  assert.equal(stored.optimizeProfiles.length, 2, 'a partial style still loads; missing fields fall back');
  const partial = stored.optimizeProfiles.find((profile) => profile.name === 'Broken');
  assert.ok(partial);
  assert.equal(partial!.style.reduceTransparency, false);
  assert.equal(partial!.style.motion, 1, 'the one field it did carry is kept');
  assert.equal(stored.optimizeProfiles[0]?.name, 'Broken', 'newest first');
  assert.equal(stored.optimizeSnapshot?.density, 'spacious');
  assert.equal(stored.optimizeSnapshot?.backgroundImage, 'https://x.test/a.png');
  assert.equal(stored.activeOptimizeProfile, 'Night');
  assert.equal(stored.disableSpellcheck, true);
  // The active name must point at a profile that exists, or the tick lies.
  assert.equal(normalisePreferences({ activeOptimizeProfile: 'Gone' }).activeOptimizeProfile, '');
  assert.equal(normalisePreferences({ activeOptimizeProfile: 42 as never }).activeOptimizeProfile, '');
  assert.equal(normalisePreferences(undefined).optimizeProfiles.length, 0);
  assert.equal(normalisePreferences(undefined).optimizeSnapshot, null);
  assert.equal(DEFAULT_PREFERENCES.disableSpellcheck, false);
});

test('sameStyle compares every field a profile owns', () => {
  assert.equal(sameStyle(FULL_DETAIL_STYLE, { ...FULL_DETAIL_STYLE }), true);
  assert.equal(sameStyle(MAX_SAVINGS_STYLE, FULL_DETAIL_STYLE), false);
  assert.equal(sameStyle(FULL_DETAIL_STYLE, { ...FULL_DETAIL_STYLE, mailRefreshSeconds: 60 }), false);
});
