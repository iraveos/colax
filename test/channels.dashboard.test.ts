import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseChannels, applyChannel, BUILTIN_CHANNELS, type Channel } from '../src/vault/channels.ts';
import type { VaultItem } from '../src/vault/types.ts';

const item = (id: string): VaultItem => ({ id } as VaultItem);

test('a stored dashboard channel keeps kind=dashboard', () => {
  const out = normaliseChannels(BUILTIN_CHANNELS);
  const dash = out.find((c) => c.id === 'dashboard');
  assert.equal(dash?.kind, 'dashboard');
});

test('a legacy dashboard stored with a generated id still renders the dashboard', () => {
  // Pre-fix: 'dashboard' was not an accepted persisted kind, so this normalised
  // to 'all' and App.tsx rendered the login list instead of the summary screen.
  const stored = [
    { id: 'all', name: 'All logins', kind: 'all', tagIds: [], icon: 'inbox', hue: 212, accent: 'slate', backgroundImage: '', builtin: true, locked: true },
    { id: 'ch_legacy1', name: 'Dashboard', kind: 'dashboard', tagIds: [], icon: 'grid', hue: 268, accent: 'dusk', backgroundImage: '', builtin: false, locked: false },
  ] as Channel[];
  const out = normaliseChannels(stored);
  const dash = out.find((c) => c.kind === 'dashboard');
  assert.ok(dash, 'a dashboard-kind channel must survive normalisation');
  assert.equal(dash.id, 'ch_legacy1');
});

test('an old channel literally named Dashboard is adopted as the dashboard', () => {
  // The shape produced before `dashboard` became a kind at all.
  const stored = [
    { id: 'all', name: 'All logins', kind: 'all', tagIds: [], icon: 'inbox', hue: 212, accent: 'slate', backgroundImage: '', builtin: true, locked: true },
    { id: 'ch_old', name: 'Dashboard', kind: 'all', tagIds: [], icon: 'layers', hue: 268, accent: 'slate', backgroundImage: '', builtin: false, locked: false },
  ] as Channel[];
  const out = normaliseChannels(stored);
  assert.equal(out.find((c) => c.id === 'ch_old')?.kind, 'dashboard');
});

test('auto-created tag channels keep kind=tags across a reload', () => {
  const stored = [
    { id: 'all', name: 'All logins', kind: 'all', tagIds: [], icon: 'inbox', hue: 212, accent: 'slate', backgroundImage: '', builtin: true, locked: true },
    { id: 'ch_tag1', name: 'work', kind: 'tags', tagIds: ['tg_1'], icon: 'layers', hue: 100, accent: 'slate', backgroundImage: '', builtin: false, locked: false },
  ] as Channel[];
  assert.equal(normaliseChannels(stored).find((c) => c.id === 'ch_tag1')?.kind, 'tags');
});

test('the dashboard is locked so it cannot be deleted or dragged away', () => {
  const out = normaliseChannels([
    { id: 'ch_x', name: 'Dashboard', kind: 'dashboard', tagIds: [], icon: 'grid', hue: 268, accent: 'dusk', backgroundImage: '', builtin: false, locked: false },
  ] as Channel[]);
  assert.equal(out.find((c) => c.kind === 'dashboard')?.locked, true);
});

test('applyChannel(dashboard) yields every login, for the sidebar count', () => {
  const dash = BUILTIN_CHANNELS.find((c) => c.kind === 'dashboard')!;
  const items = [item('a'), item('b'), item('c')] as VaultItem[];
  assert.equal(applyChannel(dash, items).length, 3);
});