/**
 * Preference normalisation. Preferences are stored unencrypted, so they can be
 * stale, hand-edited or written by an older build; every value is coerced here
 * rather than trusted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { normalisePreferences, DEFAULT_PREFERENCES, ACCENT_PRESETS, MemoryVaultStorage, } = await import('../src/vault/storage.ts');
const { accentOf, hueFor, isAllowedImageSrc, MAX_BACKGROUND_BYTES, MAX_APP_BACKGROUND_BYTES, MAX_IMAGE_EDGE, emptyItem } = await import('../src/vault/types.ts');
test('an empty store yields the defaults', () => {
    const prefs = normalisePreferences(undefined);
    assert.equal(prefs.theme, DEFAULT_PREFERENCES.theme);
    assert.equal(prefs.view, DEFAULT_PREFERENCES.view);
    assert.equal(prefs.accent, 'slate');
});
test('legacy accent names migrate onto the calm palette', () => {
    // An earlier version shipped six louder accents. They must not break loading.
    const legacy = {
        aurora: 'slate',
        mint: 'sage',
        nebula: 'dusk',
        orchid: 'dusk',
        sunset: 'clay',
        ember: 'clay',
    };
    for (const [oldName, expected] of Object.entries(legacy)) {
        assert.equal(normalisePreferences({ accent: oldName }).accent, expected, `${oldName} should map to ${expected}`);
    }
});
test('unknown enum values fall back instead of throwing', () => {
    const prefs = normalisePreferences({
        theme: 'neon',
        view: 'hologram',
        sort: 'vibes',
        density: 'enormous',
        accent: 'chartreuse',
    });
    assert.equal(prefs.theme, DEFAULT_PREFERENCES.theme);
    assert.equal(prefs.view, DEFAULT_PREFERENCES.view);
    assert.equal(prefs.sort, DEFAULT_PREFERENCES.sort);
    assert.equal(prefs.density, DEFAULT_PREFERENCES.density);
    assert.equal(prefs.accent, DEFAULT_PREFERENCES.accent);
});
test('numeric scales are clamped to their supported range', () => {
    const prefs = normalisePreferences({
        motion: 99,
        ambient: -5,
        roundness: 100,
        textScale: 3,
        clearClipboardSeconds: 100000,
        passwordGenerator: { ...DEFAULT_PREFERENCES.passwordGenerator, length: 9999 },
    });
    assert.equal(prefs.motion, 1);
    assert.equal(prefs.ambient, 0);
    assert.equal(prefs.roundness, 1.4);
    assert.equal(prefs.textScale, 85);
    assert.equal(prefs.clearClipboardSeconds, 300);
    assert.equal(prefs.passwordGenerator.length, 64);
});
test('non-numeric junk falls back to the default', () => {
    const prefs = normalisePreferences({ motion: 'lots', ambient: NaN });
    assert.equal(prefs.motion, DEFAULT_PREFERENCES.motion);
    assert.equal(prefs.ambient, DEFAULT_PREFERENCES.ambient);
});
test('an auto-lock value outside the offered list is reset', () => {
    assert.equal(normalisePreferences({ autoLockMinutes: 7 }).autoLockMinutes, DEFAULT_PREFERENCES.autoLockMinutes);
    assert.equal(normalisePreferences({ autoLockMinutes: 15 }).autoLockMinutes, 15);
    assert.equal(normalisePreferences({ autoLockMinutes: 0 }).autoLockMinutes, 0, 'Never is valid');
});
test('a generator with every character set off is repaired', () => {
    const prefs = normalisePreferences({
        passwordGenerator: { length: 20, lower: false, upper: false, digits: false, symbols: false, avoidAmbiguous: true },
    });
    const enabled = ['lower', 'upper', 'digits', 'symbols'].filter((k) => prefs.passwordGenerator[k]);
    assert.ok(enabled.length > 0, 'at least one character set must stay on');
    assert.equal(prefs.passwordGenerator.length, 20, 'the chosen length is kept');
});
test('the accent palette is small and calm', () => {
    assert.ok(ACCENT_PRESETS.length <= 5, 'palette should stay small');
    for (const preset of ACCENT_PRESETS) {
        // Chroma is applied in CSS; these hues should be reasonably close together.
        assert.ok(preset.from >= 0 && preset.from < 360);
        assert.ok(preset.to >= 0 && preset.to < 360);
    }
});
test('preferences round-trip through storage', async () => {
    const storage = new MemoryVaultStorage();
    const custom = normalisePreferences({ view: 'carousel', accent: 'dusk', motion: 0.5 });
    await storage.savePreferences(custom);
    const loaded = await storage.loadPreferences();
    assert.equal(loaded.view, 'carousel');
    assert.equal(loaded.accent, 'dusk');
    assert.equal(loaded.motion, 0.5);
});
test('a per-login accent hue falls back to a stable hash of the name', () => {
    const item = emptyItem('id');
    assert.equal(item.accentHue, null, 'new logins start on auto');
    assert.equal(accentOf({ ...item, title: 'GitHub' }), hueFor('GitHub'));
    assert.equal(accentOf({ ...item, title: 'GitHub' }), hueFor('GitHub'), 'stable across loads');
    // An explicit choice always wins.
    assert.equal(accentOf({ ...item, title: 'GitHub', accentHue: 268 }), 268);
    // Negative and overflowing hues wrap rather than break.
    assert.equal(accentOf({ ...item, accentHue: -30 }), 330);
    assert.equal(accentOf({ ...item, accentHue: 400 }), 40);
});
test('background sources are restricted to images', () => {
    assert.equal(isAllowedImageSrc('https://example.com/a.jpg'), true);
    assert.equal(isAllowedImageSrc('http://example.com/a.jpg'), true);
    assert.equal(isAllowedImageSrc('data:image/png;base64,AAA'), true);
    assert.equal(isAllowedImageSrc('javascript:alert(1)'), false);
    assert.equal(isAllowedImageSrc('data:text/html,<script>'), false);
    assert.equal(isAllowedImageSrc(''), false);
    assert.equal(isAllowedImageSrc('   '), false);
});
test('upload limits allow real photos now that uploads are downscaled', () => {
    // Uploads are re-encoded before storage, so the caps apply to the compressed
    // result and can be generous.
    assert.ok(MAX_IMAGE_EDGE >= 1200, 'should keep enough detail for a card background');
    assert.ok(MAX_BACKGROUND_BYTES >= 1_000_000, 'per-login limit should be at least 1 MB');
    assert.ok(MAX_APP_BACKGROUND_BYTES >= 4_000_000, 'app background limit should be several MB');
    assert.ok(MAX_APP_BACKGROUND_BYTES > MAX_BACKGROUND_BYTES, 'app background should allow more than a login');
    assert.ok(MAX_APP_BACKGROUND_BYTES < 20_000_000, 'but still bounded');
});
