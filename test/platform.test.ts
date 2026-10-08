import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlatform } from '../src/lib/platform.ts';

/**
 * The platform seam is the contract that makes shells swappable: the UI calls
 * getPlatform() and never imports a shell framework. These pin the fallback
 * behavior — a missing or foreign host must degrade to working web behavior,
 * never throw, because every call site relies on that guarantee instead of
 * writing its own guards.
 */

test('with no window at all, the web fallback is returned', () => {
  // Under node --test there is no global window.
  assert.equal(typeof (globalThis as Record<string, unknown>).window, 'undefined');
  const platform = getPlatform();
  assert.equal(platform.name, 'web');
  assert.equal(typeof platform.openExternal, 'function');
});

test('versions() always returns printable strings', () => {
  const { app, host } = getPlatform().versions();
  assert.ok(app.length > 0);
  assert.ok(host.length > 0);
});
