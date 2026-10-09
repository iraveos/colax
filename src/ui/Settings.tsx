import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ACCENT_PRESETS,
  DEFAULT_PREFERENCES,
  MAX_DOCKS,
  newDockId,
  type CardSizePrefs,
  type Density,
  type SortMode,
  type ThemeMode,
  type VaultPreferences,
  type VaultView,
} from '../vault/storage.ts';
import { downloadBackup, parseBackup, pickBackupFile } from '../vault/backup.ts';
import { verifyBackupPassword, type BackupFile, type VaultService } from '../vault/vault-service.ts';
import type { VaultProtection } from '../crypto/vault-crypto.ts';
import { openVaultKey, PBKDF2_ITERATIONS, rewrapVaultKey } from '../crypto/vault-crypto.ts';
import { estimateStrength } from '../crypto/passwords.ts';
import { MAX_APP_BACKGROUND_BYTES, MAX_IMAGE_EDGE, type VaultItem } from '../vault/types.ts';
import { readImageFile } from './card-art.ts';
import { SettingsWindow, type SettingsTab } from './SettingsWindow.tsx';
import { SecurityForm } from './SecurityForm.tsx';
import { ChannelManager } from './ChannelManager.tsx';
import { AlarmsPanel } from './AlarmsPanel.tsx';

import { Alert, Modal, Select, Toggle } from './primitives.tsx';
import { buildStamp, getPlatform } from '../lib/platform.ts';
import { DockSlotsEditor } from './DockSettings.tsx';
import {
  AlertIcon,
  BellIcon,
  CheckIcon,
  CloudIcon,
  DatabaseIcon,
  DownloadIcon,
  EyeOffIcon,
  GridIcon,
  ImageIcon,
  InfoIcon,
  LayersIcon,
  LockIcon,
  MoonIcon,
  PaletteIcon,
  RowsIcon,
  ShieldIcon,
  SquaresIcon,
  SunIcon,
  TrashIcon,
  UploadIcon,
  WrenchIcon,
} from './icons.tsx';
import type { Toast } from './hooks.ts';

const AUTO_LOCK_CHOICES = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 0, label: 'Never' },
];

/** Shared option lists, so the settings and dashboard reminders cannot drift. */
const CLIPBOARD_CHOICES = [
  { value: '0', label: 'Never' },
  { value: '15', label: '15 seconds' },
  { value: '30', label: '30 seconds' },
  { value: '60', label: '60 seconds' },
  { value: '120', label: '2 minutes' },
];

const PASSWORD_AGE_CHOICES = [
  { value: '0', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
  { value: '730', label: '2 years' },
];

const EMAIL_AGE_CHOICES = [
  { value: '0', label: 'Never' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
  { value: '730', label: '2 years' },
];

const EMAIL_CHECK_CHOICES = [
  { value: '0', label: 'Never' },
  { value: '30', label: 'Every month' },
  { value: '60', label: 'Every 2 months' },
  { value: '90', label: 'Every 3 months' },
  { value: '180', label: 'Every 6 months' },
  { value: '365', label: 'Every year' },
];

export const REMINDER_OPTIONS = {
  passwordAge: PASSWORD_AGE_CHOICES,
  emailAge: EMAIL_AGE_CHOICES,
  emailCheck: EMAIL_CHECK_CHOICES,
};

const VIEWS: { id: VaultView; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'animated', label: 'Flow', hint: 'Spring-animated cards', icon: <LayersIcon /> },
  { id: 'carousel', label: 'Orbit', hint: '3D carousel ring', icon: <GridIcon /> },
  { id: 'basic', label: 'List', hint: 'Plain grouped list', icon: <RowsIcon /> },
  { id: 'grid', label: 'Grid', hint: 'Responsive card grid', icon: <SquaresIcon /> },
];

const SORTS: { id: SortMode; label: string }[] = [
  { id: 'title', label: 'Name (A–Z)' },
  { id: 'recent', label: 'Recently updated' },
  { id: 'oldest', label: 'Least recently updated' },
  { id: 'strength', label: 'Weakest first' },
  { id: 'username', label: 'Username' },
  { id: 'manual', label: 'Custom (drag order)' },
];

/**
 * What a view's card is currently sized to, in one line.
 *
 * Every view multiplies its geometry by `scale`, so the numbers here are
 * multiplied by it too — otherwise the menu and the panel would disagree about
 * what a card looks like. Flow, List and Grid treat width as a cap and height as
 * a floor, so they read differently from Orbit, whose card is a fixed
 * width × aspect.
 *
 * Shared between Settings and the context menu, which had drifted into two
 * different formats for the same value.
 */
export function cardSizeSummary(view: VaultView, size: CardSizePrefs): string {
  const width = Math.round(size.width * size.scale);
  if (view === 'carousel') return `${width} × ${Math.round(width * size.aspect)}px`;
  return `${width}px wide, ${Math.round(size.minHeight)}px min`;
}

export function Settings(props: {
  open: boolean;
  onClose: () => void;
  /** Jump straight to a tab when set, e.g. from a sidebar shortcut. */
  tab?: string;
  /** Removes the hairline rules inside the window. */
  hideDividers?: boolean;
  prefs: VaultPreferences;
  service: VaultService;
  protection: VaultProtection | null;
  items: VaultItem[];
  onUpdate: (patch: Partial<VaultPreferences>) => Promise<void>;
  onNotify: (message: string, tone?: Toast['tone']) => void;
  onLock: () => void;
  onReset: () => Promise<void>;
  /** Opens the channel editor for one channel, or a blank one. */
  onEditChannel?: (channelId: string | 'new') => void;
  onScrubTag?: (tagId: string) => void;
  /**
   * Opens the appearance panel, optionally switching to a view first so the
   * sliders act on the view the user just clicked rather than the one that
   * happened to be open.
   */
  onOpenTuner?: (view?: VaultView) => void;
}) {
  const {
    open, onClose, tab, hideDividers, prefs, service, protection, items, onUpdate, onNotify, onLock, onReset,
    onEditChannel, onScrubTag, onOpenTuner,
  } = props;
  const [changing, setChanging] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [restoring, setRestoring] = useState<{ text: string; name: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);

  const hasPassword = protection === 'password';
  const set = (patch: Partial<VaultPreferences>) => void onUpdate(patch);

  /* ---- Data helpers --------------------------------------------------- */

  async function exportVault(password?: string) {
    setBusy(true);
    try {
      const backup = await service.exportBackup();
      // A password-confirmed export re-wraps the vault key so the file itself is
      // protected by that password rather than the device's current state.
      if (password) {
        // Re-wrapping is enough: the vault key never changes, so item
        // ciphertexts stay valid and the file becomes password-protected.
        const handle = await openVaultKey(backup.header, '');
        backup.header = await rewrapVaultKey(handle, password);
      }
      await downloadBackup(backup);
      onNotify('Encrypted backup downloaded');
      setConfirmExport(false);
      setExportPassword('');
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    // Deliberately plaintext: the point is to move logins into another tool.
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const header = ['name', 'url', 'username', 'password', 'notes', 'favorite', 'created'];
    const rows = items.map((item) =>
      [
        item.title,
        item.url,
        item.username,
        item.password,
        item.notes,
        String(item.favorite),
        new Date(item.createdAt).toISOString(),
      ]
        .map(escape)
        .join(','),
    );
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `colax-vault-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    onNotify('Plaintext CSV exported — delete it once imported elsewhere');
  }

  async function importCsv(file: File | undefined) {
    if (!file) return;
    setImportingCsv(true);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      const parsed = lines.slice(1).map((line) => {
        const cells: string[] = [];
        let current = '';
        let quoted = false;
        for (let i = 0; i < line.length; i += 1) {
          const char = line[i];
          if (char === '"') {
            if (quoted && line[i + 1] === '"') {
              current += '"';
              i += 1;
            } else quoted = !quoted;
          } else if (char === ',' && !quoted) {
            cells.push(current);
            current = '';
          } else current += char;
        }
        cells.push(current);
        return cells;
      });
      for (const [index, cells] of parsed.entries()) {
        await service.addItem({
          title: cells[0] ?? '',
          url: cells[1] ?? '',
          username: cells[2] ?? '',
          password: cells[3] ?? '',
          notes: cells[4] ?? '',
          favorite: cells[5] === 'true',
        });
        if (index % 25 === 0) setImportingCsv(true);
      }
      onNotify(`Imported ${parsed.length} logins`);
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : 'Import failed', 'error');
    } finally {
      setImportingCsv(false);
    }
  }

  const storageKb = useMemo(
    () => Math.max(1, Math.round((JSON.stringify(items).length * 1.35) / 1024)),
    [items],
  );

  /* ---- Tabs ------------------------------------------------------------ */

  const tabs: SettingsTab[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      icon: <PaletteIcon />,
      render: () => (
        <>
          <Row label="Theme" hint="System follows your device and updates live.">
            <div className="option-cards">
              {(
                [
                  { id: 'light', label: 'Light', icon: <SunIcon /> },
                  { id: 'dark', label: 'Dark', icon: <MoonIcon /> },
                  { id: 'system', label: 'System', icon: <CloudIcon /> },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  className="option-card"
                  aria-pressed={prefs.theme === option.id}
                  onClick={() => set({ theme: option.id as ThemeMode })}
                >
<ThemePreview mode={option.id} />
                  {/* Glyph and label sit inline beside the swatch: a compact
                      chip that matches the accent row, not a stacked card. */}
                  <span className="option-card__glyph">{option.icon}</span>
                  <span className="option-card__label">{option.label}</span>
                </button>
              ))}
            </div>
          </Row>

          <Row label="Accent" hint="A small, calm palette on purpose.">
            <div className="accent-grid">
              {ACCENT_PRESETS.map((accent) => (
                <button
                  key={accent.id}
                  className="accent-swatch"
                  aria-pressed={prefs.accent === accent.id}
                  onClick={() => set({ accent: accent.id })}
                >
<span
                    className="accent-swatch__chip"
                    style={{ background: `linear-gradient(135deg, hsl(${accent.from} 40% 56%), hsl(${accent.to} 36% 46%))` }}
                  />
                  <span className="option-card__label">{accent.label}</span>
                </button>
              ))}
            </div>
          </Row>

<Slider
            label="Animation intensity"
            hint="Scales every transition. Your device's reduced-motion setting still wins."
            value={prefs.motion}
            min={0}
            max={1}
            step={0.25}
            format={(v) => (v === 0 ? 'Off' : v < 0.6 ? 'Calm' : 'Full')}
            onChange={(motion) => set({ motion })}
          />
          <Slider
            label="Animation speed"
            hint="How quickly panels, menus and settings tabs move."
            value={prefs.motionSpeed}
            min={0.25}
            max={2}
            step={0.25}
            format={(v) => (v <= 0.5 ? 'Languid' : v < 0.9 ? 'Slow' : v <= 1.2 ? 'Normal' : v < 1.7 ? 'Fast' : 'Instant')}
            onChange={(motionSpeed) => set({ motionSpeed })}
          />
          <Slider
            label="Glow"
            hint="Strength of the ambient gradient behind everything."
            value={prefs.ambient}
            min={0}
            max={1}
            step={0.25}
            format={(v) => (v === 0 ? 'Off' : v < 0.6 ? 'Subtle' : 'Full')}
            onChange={(ambient) => set({ ambient })}
          />
          <Slider
            label="Text size"
            hint="Scales the whole interface."
            value={prefs.textScale}
            min={85}
            max={130}
            step={5}
            format={(v) => `${v}%`}
            onChange={(textScale) => set({ textScale })}
          />
<Slider
            label="Corner roundness"
            hint="How soft or sharp every surface looks."
            value={prefs.roundness}
            min={0.6}
            max={1.4}
            step={0.1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(roundness) => set({ roundness })}
          />
          <Slider
            label="Card shadow"
            hint="The shadow under each login. Off keeps them flat; deep lifts them clear of the page."
            value={prefs.cardDepth}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v === 0 ? 'Off' : v < 0.3 ? 'Faint' : v < 0.7 ? 'Soft' : 'Deep')}
            onChange={(cardDepth) => set({ cardDepth })}
          />
          <Row label="Density" hint="Row height and spacing.">
            <div className="segmented">
              {(['compact', 'comfortable', 'spacious'] as Density[]).map((density) => (
                <button
                  key={density}
                  className="segmented__option"
                  aria-pressed={prefs.density === density}
                  onClick={() => set({ density })}
                >
                  {density[0]?.toUpperCase()}
                  {density.slice(1)}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Transparency" hint="Turn off the frosted-glass effect for a flatter, faster surface.">
            <Toggle
              label="Reduce transparency"
              checked={prefs.reduceTransparency}
              onChange={(reduceTransparency) => set({ reduceTransparency })}
            />
          </Row>
          <Row label="High contrast" hint="Stronger borders and dimmer greys.">
            <Toggle
              label="High contrast"
              checked={prefs.highContrast}
              onChange={(highContrast) => set({ highContrast })}
            />
          </Row>
        </>
      ),
    },

    {
      id: 'layout',
      label: 'Layout',
      icon: <GridIcon />,
      render: () => (
        <>
          <Row label="Group list by first letter" hint="In the List view, rows sit under a letter heading. Off flattens it into one run.">
            <Toggle
              label="Group by letter"
              checked={prefs.showLetterGroups}
              onChange={(showLetterGroups) => set({ showLetterGroups })}
            />
          </Row>
          <Row label="Auto-tag new logins" hint="Reads the site and email-provider domain and attaches the matching tag, creating it when needed.">
            <Toggle
              label="Auto-tag new logins"
              checked={prefs.autoTagDomain}
              onChange={(autoTagDomain) => set({ autoTagDomain })}
            />
          </Row>
          <Row label="Show unassigned channel" hint="A sidebar entry for every login that has no tag yet.">
            <Toggle
              label="Show unassigned channel"
              checked={prefs.showUnassignedChannel}
              onChange={(showUnassignedChannel) => set({ showUnassignedChannel })}
            />
          </Row>
          <Row label="New tags become channels" hint="Every tag you create also gets its own sidebar channel.">
            <Toggle
              label="Auto-create tag channels"
              checked={prefs.autoTagChannel}
              onChange={(autoTagChannel) => set({ autoTagChannel })}
            />
          </Row>

          {/* Rail presentation. Both controls are duplicated in the sidebar's
              right-click menu, because the rail is the thing being described and
              the user is usually looking at it rather than in Settings. */}
          <Row
            label="Channel labels"
            hint="The sidebar rail — not the view picker below, which has its own setting. Icons only collapses the rail to a narrow strip you read by shape. Names only drops the glyphs but keeps the colour dot, which is what tells two similar names apart. (Compact mode in the sidebar footer also hides names.)"
            stacked
          >
            <div className="option-cards">
              {(
                [
                  { id: 'both', label: 'Icons and names', hint: 'Both, as it is by default' },
                  { id: 'icon', label: 'Icons only', hint: 'A narrow rail' },
                  { id: 'name', label: 'Names only', hint: 'A plain list' },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  className="option-card"
                  aria-pressed={prefs.sidebarLabels === option.id}
                  onClick={() => set({ sidebarLabels: option.id })}
                >
                  <span>{option.label}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>{option.hint}</span>
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Rail position"
            hint="Where the channel rail sits in the window. Docked top or bottom turns it into a horizontal strip, so folders open inline rather than nesting."
            stacked
          >
            <div className="option-cards">
              {(
                [
                  { id: 'left', label: 'Left edge', hint: 'A vertical rail' },
                  { id: 'right', label: 'Right edge', hint: 'A vertical rail' },
                  { id: 'top', label: 'Top tabs', hint: 'A horizontal strip' },
                  { id: 'bottom', label: 'Bottom dock', hint: 'A horizontal strip' },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  className="option-card"
                  aria-pressed={prefs.sidebarPosition === option.id}
                  onClick={() => set({ sidebarPosition: option.id })}
                >
                  <span>{option.label}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>{option.hint}</span>
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Card size"
            hint="Each view is tuned separately, because a ring card and a list row have different geometry. The appearance panel edits the same values live."
            stacked
          >
            <div className="option-cards">
              {VIEWS.map((view) => (
                <button
                  key={view.id}
                  className="option-card"
                  aria-pressed={false}
                  onClick={() => onOpenTuner?.(view.id)}
                >
                  <span>{view.label}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                    {cardSizeSummary(view.id, prefs.cardSize[view.id])}
                  </span>
                </button>
              ))}
            </div>
          </Row>
          <Row
            label="Quick-launch docks"
            hint="Jump targets on bars, one keypress away — have one bar or several, each dragged anywhere. Keys work bare (no Ctrl) whenever you are not typing or in a dialog; the first bar wins a key two bars claim."
            stacked
          >
            {prefs.docks.map((dock, index) => (
              <div className="dock-manager" key={dock.id}>
                <div className="dock-manager__head">
                  <span className="dock-manager__name">Dock {index + 1}</span>
                  <Toggle
                    label={`Show dock ${index + 1}`}
                    checked={dock.enabled}
                    onChange={(enabled) =>
                      set({ docks: prefs.docks.map((entry) => (entry.id === dock.id ? { ...entry, enabled } : entry)) })
                    }
                  />
                  {prefs.docks.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      onClick={() => set({ docks: prefs.docks.filter((entry) => entry.id !== dock.id) })}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
                {dock.enabled ? (
                  <DockSlotsEditor
                    slots={dock.slots}
                    channels={prefs.channels}
                    folders={prefs.folders}
                    logins={items}
                    mailboxes={prefs.gmailAccounts}
                    onChange={(slots) =>
                      set({ docks: prefs.docks.map((entry) => (entry.id === dock.id ? { ...entry, slots } : entry)) })
                    }
                    onNotify={onNotify}
                  />
                ) : null}
              </div>
            ))}
            {prefs.docks.length < MAX_DOCKS ? (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() =>
                  set({
                    docks: [
                      ...prefs.docks,
                      { id: newDockId(), slots: [], pos: { edge: 'bottom', fx: 0.5, fy: 0.78 }, enabled: true },
                    ],
                  })
                }
              >
                + New dock
              </button>
            ) : null}
          </Row>
          <Row label="Default view" hint="Remembered the next time you open the app." stacked>
            <div className="option-cards">
              {VIEWS.map((view) => (
                <button
                  key={view.id}
                  className="option-card"
                  aria-pressed={prefs.view === view.id}
                  onClick={() => set({ view: view.id })}
                >
                  {view.icon}
                  <span>{view.label}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>{view.hint}</span>
                </button>
              ))}
            </div>
          </Row>
          <Row label="Sort by" hint="Applies to the Flow and List views." stacked>
            <div className="segmented segmented--wrap">
              {SORTS.map((sort) => (
                <button
                  key={sort.id}
                  className="segmented__option"
                  aria-pressed={prefs.sort === sort.id}
                  onClick={() => set({ sort: sort.id })}
                >
                  {sort.label}
                </button>
              ))}
            </div>
          </Row>
<Row label="Show websites" hint="Display the site under each login.">
            <Toggle label="Show websites" checked={prefs.showUrls} onChange={(showUrls) => set({ showUrls })} />
          </Row>
          <Row label="Label orbit nodes" hint="Puts each login's title and email inside its own card in the Orbit ring.">
            <Toggle
              label="Label orbit nodes"
              checked={prefs.showOrbitLabels}
              onChange={(showOrbitLabels) => set({ showOrbitLabels })}
            />
          </Row>
          <Row label="Pin favorites" hint="Keep favorites in their own section at the top.">
            <Toggle
              label="Pin favorites"
              checked={prefs.pinFavorites}
              onChange={(pinFavorites) => set({ pinFavorites })}
            />
          </Row>
          <Row label="Expand on select" hint="Open a login's details when you pick it.">
            <Toggle
              label="Expand on select"
              checked={prefs.expandOnOpen}
              onChange={(expandOnOpen) => set({ expandOnOpen })}
            />
          </Row>
<Row label="Health badges" hint="Flag reused and long-untouched passwords.">
            <Toggle
              label="Health badges"
              checked={prefs.showHealthBadges}
              onChange={(showHealthBadges) => set({ showHealthBadges })}
            />
          </Row>
          <Row label="Shortcuts in sidebar" hint="Off leaves the shortcut sheet in Settings only.">
            <Toggle
              label="Shortcuts in sidebar"
              checked={prefs.showShortcuts}
              onChange={(showShortcuts) => set({ showShortcuts })}
            />
          </Row>
          <Row label="Lock button" hint="The lock control on the main screen. Settings always keeps its own.">
            <Toggle
              label="Lock button"
              checked={prefs.showLockButton}
              onChange={(showLockButton) => set({ showLockButton })}
            />
          </Row>
          <Row label="New channel button" hint="The shortcut at the end of the sidebar. Hiding it changes nothing — channels are still one right-click away.">
            <Toggle
              label="New channel button"
              checked={prefs.showNewChannelButton}
              onChange={(showNewChannelButton) => set({ showNewChannelButton })}
            />
          </Row>
          <Row label="Compact button" hint="The sidebar footer's narrow-rail toggle.">
            <Toggle
              label="Compact button"
              checked={prefs.showCompactButton}
              onChange={(showCompactButton) => set({ showCompactButton })}
            />
          </Row>
          <Row label="New login button" hint="The topbar shortcut. Right-click it to hide it without coming here.">
            <Toggle
              label="New login button"
              checked={prefs.showNewLoginButton}
              onChange={(showNewLoginButton) => set({ showNewLoginButton })}
            />
          </Row>
          <Row label="Bulk add button" hint="The topbar shortcut beside New login. Right-click it to hide it without coming here.">
            <Toggle
              label="Bulk add button"
              checked={prefs.showBulkAddButton}
              onChange={(showBulkAddButton) => set({ showBulkAddButton })}
            />
          </Row>
          <Row label="Settings button" hint="The sidebar footer's own shortcut here. Right-click it to hide it; the Hidden tab brings it back.">
            <Toggle
              label="Settings button"
              checked={prefs.showSettingsButton}
              onChange={(showSettingsButton) => set({ showSettingsButton })}
            />
          </Row>
          <Row label="Hide sidebar button" hint="The sidebar footer's Hide control. Right-click it to hide it.">
            <Toggle
              label="Hide sidebar button"
              checked={prefs.showHideSidebarButton}
              onChange={(showHideSidebarButton) => set({ showHideSidebarButton })}
            />
          </Row>
          <Row label="Show sidebar" hint="Hides the whole channel rail. A button appears in the topbar to bring it back, so Settings stays reachable.">
            <Toggle
              label="Show sidebar"
              checked={prefs.showSidebar}
              onChange={(showSidebar) => set({ showSidebar })}
            />
          </Row>
          <Row
            label="Floating controls"
            hint="Detaches the sidebar channels, the view menu and New login into their own pills."
          >
            <Toggle
              label="Floating controls"
              checked={prefs.floatingChrome}
              onChange={(floatingChrome) => set({ floatingChrome })}
            />
          </Row>
          <Row label="Hide dividers" hint="Removes the hairline rules inside this settings window.">
            <Toggle
              label="Hide dividers"
              checked={prefs.hideDividers}
              onChange={(hideDividers) => set({ hideDividers })}
            />
          </Row>
        </>
      ),
    },

    // Hidden items: everything right-clicked away (or toggled off in Layout),
    // in one place with a way back each. This tab is the reason hiding can
    // never strand anyone: every hidden button is listed here with its Show.
    {
      id: 'hidden',
      label: 'Hidden',
      icon: <EyeOffIcon />,
      render: () => {
        const rows: { key: string; label: string; where: string; show: () => void }[] = [];
        if (prefs.showNewLoginButton === false)
          rows.push({ key: 'new-login', label: 'New login button', where: 'Topbar', show: () => set({ showNewLoginButton: true }) });
        if (prefs.showBulkAddButton === false)
          rows.push({ key: 'bulk-add', label: 'Bulk add button', where: 'Topbar', show: () => set({ showBulkAddButton: true }) });
        prefs.docks.forEach((dock, index) => {
          if (!dock.enabled)
            rows.push({
              key: `dock:${dock.id}`,
              label: prefs.docks.length > 1 ? `Dock ${index + 1}` : 'Quick-launch dock',
              where: 'Floating bar',
              show: () =>
                set({ docks: prefs.docks.map((entry) => (entry.id === dock.id ? { ...entry, enabled: true } : entry)) }),
            });
        });
        if (!prefs.showNewChannelButton)
          rows.push({ key: 'sidebar-add', label: 'New channel button', where: 'Sidebar', show: () => set({ showNewChannelButton: true }) });
        if (prefs.showSettingsButton === false)
          rows.push({ key: 'footer-settings', label: 'Settings button', where: 'Sidebar footer', show: () => set({ showSettingsButton: true }) });
        if (!prefs.showLockButton)
          rows.push({ key: 'footer-lock', label: 'Lock button', where: 'Sidebar footer', show: () => set({ showLockButton: true }) });
        if (!prefs.showShortcuts)
          rows.push({ key: 'footer-shortcuts', label: 'Shortcuts button', where: 'Sidebar footer', show: () => set({ showShortcuts: true }) });
        if (!prefs.showCompactButton)
          rows.push({ key: 'footer-compact', label: 'Compact button', where: 'Sidebar footer', show: () => set({ showCompactButton: true }) });
        if (prefs.showHideSidebarButton === false)
          rows.push({ key: 'footer-hide', label: 'Hide-sidebar button', where: 'Sidebar footer', show: () => set({ showHideSidebarButton: true }) });
        if (prefs.showSidebar === false)
          rows.push({ key: 'sidebar', label: 'Sidebar', where: 'Channel rail', show: () => set({ showSidebar: true }) });
        for (const id of prefs.hiddenChannels) {
          const channel = prefs.channels.find((entry) => entry.id === id);
          rows.push({
            key: `channel:${id}`,
            label: `Channel: ${channel?.name ?? id}`,
            where: 'Sidebar',
            show: () => set({ hiddenChannels: prefs.hiddenChannels.filter((entry) => entry !== id) }),
          });
        }
        for (const id of prefs.hiddenFolders) {
          const folder = prefs.folders.find((entry) => entry.id === id);
          rows.push({
            key: `folder:${id}`,
            label: `Folder: ${folder?.name ?? id}`,
            where: 'Sidebar',
            show: () => set({ hiddenFolders: prefs.hiddenFolders.filter((entry) => entry !== id) }),
          });
        }
        if (rows.length === 0)
          return <p className="field__hint">Nothing is hidden. Right-click any topbar, sidebar or dock button to hide it straight from where it lives.</p>;
        return (
          <>
            {rows.length > 1 ? (
              <Row label="Show everything" hint="Brings back every hidden button and bar at once.">
                <button
                  className="btn btn--secondary"
                  onClick={() =>
                    set({
                      showNewLoginButton: true,
                      showBulkAddButton: true,
                      docks: prefs.docks.map((entry) => ({ ...entry, enabled: true })),
                      showNewChannelButton: true,
                      showSettingsButton: true,
                      showLockButton: true,
                      showShortcuts: true,
                      showCompactButton: true,
                      showHideSidebarButton: true,
                      showSidebar: true,
                      hiddenChannels: [],
                      hiddenFolders: [],
                    })
                  }
                >
                  Show all {rows.length}
                </button>
              </Row>
            ) : null}
            {rows.map((row) => (
              <Row key={row.key} label={row.label} hint={row.where}>
                <button className="btn btn--secondary" onClick={row.show}>
                  Show
                </button>
              </Row>
            ))}
          </>
        );
      },
    },

    // Background and Channels sit beneath Layout now: appearance first, then
    // how logins are laid out, then the backdrop and the rail that holds them.
    {
      id: 'background',
      label: 'Background',
      icon: <ImageIcon />,
      render: () => (
        <BackgroundSection
          prefs={prefs}
          onUpdate={set}
          onNotify={onNotify}
          maxBytes={MAX_APP_BACKGROUND_BYTES}
        />
      ),
    },

    {
      id: 'channels',
      label: 'Channels',
      icon: <RowsIcon />,
      render: () => (
        <ChannelManager
          channels={prefs.channels}
          tags={prefs.tags}
          items={items}
          staleDays={prefs.passwordAgeDays}
          hiddenChannels={prefs.hiddenChannels}
          onEditChannel={(channelId) => {
            if (onEditChannel) onEditChannel(channelId);
            else onNotify('Right-click a channel in the sidebar to edit it', 'error');
          }}
          onTagsChange={(tags) => void onUpdate({ tags })}
          onHiddenChannelsChange={(hiddenChannels) => void onUpdate({ hiddenChannels })}
          onScrubTag={onScrubTag}
          onNotify={onNotify}
        />
      ),
    },

    {
      id: 'generator',
      label: 'Generator',
      icon: <WrenchIcon />,
      render: () => {
        const gen = prefs.passwordGenerator;
        return (
          <>
            <Row label="Default length" hint="Used when the generator opens.">
              <div className="slider-row" style={{ width: 200 }}>
                <input
                  className="slider"
                  type="range"
                  min={8}
                  max={64}
                  value={gen.length}
                  onChange={(event) => set({ passwordGenerator: { ...gen, length: Number(event.target.value) } })}
                  aria-label="Default password length"
                />
                <span className="slider-row__value">{gen.length}</span>
              </div>
            </Row>
            <Row label="Character sets" hint="At least one must stay on." stacked>
              {(
                [
                  ['lower', 'Lowercase  a–z'],
                  ['upper', 'Uppercase  A–Z'],
                  ['digits', 'Digits  0–9'],
                  ['symbols', 'Symbols  !@#'],
                  ['avoidAmbiguous', 'Avoid look-alikes  l 1 I O 0'],
                ] as const
              ).map(([key, label]) => (
                <div className="toggle-row" key={key}>
                  <span className="toggle-row__text">{label}</span>
                  <Toggle
                    label={label}
                    checked={gen[key]}
                    onChange={(next) => set({ passwordGenerator: { ...gen, [key]: next } })}
                  />
                </div>
              ))}
            </Row>
          </>
        );
      },
    },

    {
      id: 'security',
      label: 'Security',
      icon: <ShieldIcon />,
      render: () => (
        <>
          <Row label="Key derivation" hint="Rounds applied to your password before it can derive the vault key.">
            <span className="chip chip--accent">
              <CheckIcon width="11" height="11" />
              PBKDF2-SHA256 · {PBKDF2_ITERATIONS.toLocaleString()} rounds
            </span>
          </Row>
          <Row label="Encryption" hint="Every login is sealed individually with a fresh nonce.">
            <span className="chip chip--accent">
              <CheckIcon width="11" height="11" />
              AES-256-GCM
            </span>
          </Row>
<Row label="Auto-lock" hint="Lock after a period without activity.">
            <Select
              label="Auto-lock"
              value={String(prefs.autoLockMinutes)}
              options={AUTO_LOCK_CHOICES.map((choice) => ({ value: String(choice.value), label: choice.label }))}
              onChange={(next) => set({ autoLockMinutes: Number(next) })}
              align="right"
            />
          </Row>
<Row label="Clear clipboard" hint="Wipe the clipboard after copying.">
            <Select
              label="Clear clipboard"
              value={String(prefs.clearClipboardSeconds)}
              options={CLIPBOARD_CHOICES}
              onChange={(next) => set({ clearClipboardSeconds: Number(next) })}
              align="right"
            />
          </Row>
          <Row label="Clear clipboard on lock" hint="Adds a wipe to the lock action itself.">
            <Toggle
              label="Clear clipboard on lock"
              checked={prefs.clearClipboardOnLock}
              onChange={(clearClipboardOnLock) => set({ clearClipboardOnLock })}
            />
          </Row>
<Row label="Warn on reused passwords" hint="Tell you before opening a site whose password is shared.">
            <Toggle
              label="Warn on reuse"
              checked={prefs.warnOnReuse}
              onChange={(warnOnReuse) => set({ warnOnReuse })}
            />
          </Row>
          <Row
            label="Flag stale passwords"
            hint="A password unchanged for this long counts as stale in the health views."
          >
            <Select
              label="Flag stale passwords"
              value={String(prefs.passwordAgeDays)}
              options={PASSWORD_AGE_CHOICES}
              onChange={(next) => set({ passwordAgeDays: Number(next) })}
              align="right"
            />
          </Row>
          <Row label="Flag stale emails" hint="An address unchanged for this long is flagged for review.">
            <Select
              label="Flag stale emails"
              value={String(prefs.emailAgeDays)}
              options={EMAIL_AGE_CHOICES}
              onChange={(next) => set({ emailAgeDays: Number(next) })}
              align="right"
            />
          </Row>
          <Row
            label="Email check reminder"
            hint="How often you are asked to review the addresses you have saved."
          >
            <Select
              label="Email check reminder"
              value={String(prefs.emailCheckDays)}
              options={EMAIL_CHECK_CHOICES}
              onChange={(next) => set({ emailCheckDays: Number(next) })}
              align="right"
            />
          </Row>
          <Row label="Confirm before export" hint="Ask for a password to protect the backup file.">
            <Toggle
              label="Confirm before export"
              checked={prefs.confirmBeforeExport}
              onChange={(confirmBeforeExport) => set({ confirmBeforeExport })}
            />
          </Row>
          <Row label="Confirm deletions" hint="Ask before removing a login.">
            <Toggle
              label="Confirm deletions"
              checked={prefs.confirmDeletes}
              onChange={(confirmDeletes) => set({ confirmDeletes })}
            />
          </Row>
          <Row label="Copy toasts" hint="Show a small confirmation after copying.">
            <Toggle
              label="Copy toasts"
              checked={prefs.copyToasts}
              onChange={(copyToasts) => set({ copyToasts })}
            />
          </Row>
          <Row
            label="Vault second factor"
            hint="After the vault opens, require an authenticator code or a recovery answer too. Optional, and per-device."
            stacked
          >
            <SecurityForm
              security={prefs.vaultSecurity}
              onChange={(vaultSecurity) => set({ vaultSecurity })}
              onNotify={onNotify}
              label="Colax Vault"
            />
          </Row>
          <Row label="Detect logins on the clipboard" hint="Watches for an email and a password copied together, and offers to save them.">
            <Toggle
              label="Clipboard detection"
              checked={prefs.clipboardCapture}
              onChange={(clipboardCapture) => set({ clipboardCapture })}
            />
          </Row>
          <Row label="Save clipboard logins straight away" hint="Skips the confirmation prompt from clipboard detection.">
            <Toggle
              label="Auto-save clipboard logins"
              checked={prefs.clipboardAutoSave}
              onChange={(clipboardAutoSave) => set({ clipboardAutoSave })}
            />
          </Row>
          <Row label="Lock now" hint="Clears the decryption key from memory straight away.">
            <button
              className="btn btn--secondary"
              onClick={() => {
                onLock();
                onClose();
              }}
            >
              <LockIcon width="14" height="14" />
              Lock
            </button>
          </Row>
        </>
      ),
    },

    {
      id: 'alarms',
      label: 'Alarms',
      icon: <BellIcon />,
      render: () => (
        <AlarmsPanel
          alarms={prefs.alarms}
          onChange={(alarms) => set({ alarms })}
          onNotify={onNotify}
        />
      ),
    },

    // Integrations used to be a tab here. Connecting a mailbox is something done
    // for a login while editing it, so the form moved to the login editor's
    // Inbox section; a global tab nobody visited was where it went to be forgotten.
    {
      id: 'data',
      label: 'Data',
      icon: <DatabaseIcon />,
      render: () => (
        <>
          <Row label="Stored logins" hint="Everything lives in this browser's local database.">
            <span className="chip chip--muted">
              {items.length} · about {storageKb} KB
            </span>
          </Row>
          <Row
            label="App version"
            hint="The exact build running right now. If a fix you expected is missing, this tells you the install is stale."
          >
            <span className="chip chip--accent">
              {getPlatform().name} · {buildStamp()}
            </span>
          </Row>
          <Row label="Export as CSV" hint="Plaintext, for moving to another tool. Delete it afterwards.">
            <button className="btn btn--secondary" onClick={exportCsv} disabled={items.length === 0}>
              <DownloadIcon width="14" height="14" />
              Export CSV
            </button>
          </Row>
          <Row label="Import from CSV" hint="Expects the columns name, url, username, password, notes.">
            <label className="btn btn--secondary">
              <UploadIcon width="14" height="14" />
              {importingCsv ? 'Importing…' : 'Import CSV'}
              <input
                type="file"
                accept="text/csv,.csv"
                className="sr-only"
                onChange={(event) => void importCsv(event.target.files?.[0])}
              />
            </label>
          </Row>
          <Row
            label="Delete all data"
            hint="Removes every login, tag, channel, folder, alarm, connected mailbox, setting and usage record from this device, and clears the clipboard. There is no undo."
          >
            <button className="btn btn--danger" onClick={() => setConfirmReset(true)}>
              <TrashIcon width="14" height="14" />
              Delete everything
            </button>
          </Row>
        </>
      ),
    },

    {
      id: 'backup',
      label: 'Backup',
      icon: <CloudIcon />,
      render: () => (
        <>
          <Row
            label="Encrypted backup"
            hint={`Downloads ${items.length} ${items.length === 1 ? 'login' : 'logins'} as ciphertext.${
              hasPassword ? '' : ' Without a vault password, anyone with the file can read it once restored.'
            }`}
          >
            <button
              className="btn btn--secondary"
              onClick={() => (prefs.confirmBeforeExport ? setConfirmExport(true) : void exportVault())}
            >
              <DownloadIcon width="14" height="14" />
              Export
            </button>
          </Row>
          <Row label="Restore from backup" hint="Replaces everything currently in this vault.">
            <button
              className="btn btn--secondary"
              onClick={() =>
                void (async () => {
                  const file = await pickBackupFile();
                  if (file) setRestoring(file);
                })()
              }
            >
              <UploadIcon width="14" height="14" />
              Restore
            </button>
          </Row>
        </>
      ),
    },

    // Desktop shell settings. Rendered only inside Electron: on web there is no
    // tray, autostart or window chrome, so these toggles would be dead controls
    // that promise something the page cannot do.
    ...(getPlatform().name === 'electron'
      ? [
          {
            id: 'desktop',
            label: 'Desktop',
            icon: <LayersIcon />,
            render: () => (
              <>
                <Row label="Run at startup" hint="Launch Colax when you sign in to Windows.">
                  <Toggle
                    label="Run at startup"
                    checked={prefs.launchAtLogin}
                    onChange={(launchAtLogin) => set({ launchAtLogin })}
                  />
                </Row>
                <Row label="System tray" hint="Keep an icon by the clock. Right-click it to show, lock, mute, restart or quit.">
                  <Toggle
                    label="System tray"
                    checked={prefs.trayEnabled}
                    onChange={(trayEnabled) => set({ trayEnabled })}
                  />
                </Row>
                <Row
                  label="Minimise to tray on close"
                  hint="The X button hides the window instead of quitting. Needs the tray above."
                >
                  <Toggle
                    label="Minimise to tray on close"
                    checked={prefs.closeToTray && prefs.trayEnabled}
                    onChange={(closeToTray) => set({ closeToTray })}
                  />
                </Row>
                <Row label="Mute all sounds" hint="Silences alarms and chimes. Toasts still appear. Also in the tray menu.">
                  <Toggle
                    label="Mute all sounds"
                    checked={prefs.soundsMuted}
                    onChange={(soundsMuted) => set({ soundsMuted })}
                  />
                </Row>
              </>
            ),
          },
        ]
      : []),

    {
      id: 'about',
      label: 'About',
      icon: <InfoIcon />,
      render: () => (
        <>
          <Row label="Version" hint="Colax — local-first password vault. The exact running build.">
            <span className="chip chip--accent">
              {getPlatform().name} · {buildStamp()}
            </span>
          </Row>
          <Row label="Where your data goes" hint="Nowhere. There is no server and no network call.">
            <span className="chip chip--accent">
              <CheckIcon width="11" height="11" />
              offline only
            </span>
          </Row>
          <Row label="Copy diagnostics" hint="Version, preferences and item counts. No secrets.">
            <button
              className="btn btn--secondary"
              onClick={() => {
                const report = {
                  app: 'colax',
                  version: buildStamp(),
                  protection,
                  itemCount: items.length,
                  prefs,
                  userAgent: navigator.userAgent,
                };
                void navigator.clipboard
                  .writeText(JSON.stringify(report, null, 2))
                  .then(() => onNotify('Diagnostics copied'))
                  .catch(() => onNotify('Clipboard blocked by the browser', 'error'));
              }}
            >
              Copy report
            </button>
          </Row>
          <Row label="Keyboard shortcuts" hint="Press ? anywhere in the vault.">
            <button className="btn btn--secondary" onClick={() => onClose()}>
              View in app
            </button>
          </Row>
          <Row label="Reset preferences" hint="Keeps your logins, restores every setting to its default.">
            <button className="btn btn--danger" onClick={() => set(DEFAULT_PREFERENCES)}>
              Reset settings
            </button>
          </Row>
          <Row label="Created by" hint="Behind every pixel of this vault.">
            <span className="chip chip--muted">iraveos</span>
          </Row>
        </>
      ),
    },
  ];

  return (
    <>
      <SettingsWindow
        open={open}
        tabs={tabs}
        onClose={onClose}
        tab={tab}
        speed={prefs.motionSpeed}
        hideDividers={hideDividers}
      />

      {changing ? (
        <ChangePasswordModal
          onClose={() => setChanging(false)}
          onSubmit={async (current, next) => {
            await service.changeMasterPassword(current, next);
            onNotify('Vault password changed');
          }}
        />
      ) : null}

      {enabling ? (
        <SetPasswordModal
          onClose={() => setEnabling(false)}
          onSubmit={async (next) => {
            await service.enablePassword(next);
            onNotify('Vault password enabled');
          }}
        />
      ) : null}

      {disabling ? (
        <DisablePasswordModal
          onClose={() => setDisabling(false)}
          onSubmit={async (current) => {
            setBusy(true);
            try {
              await service.disablePassword(current);
              onNotify('Vault password removed');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {restoring ? (
        <RestoreModal
          file={restoring}
          onClose={() => setRestoring(null)}
          onDone={async (text, password, next) => {
            await service.restoreBackup(parseBackup(text) as BackupFile, password, next);
            onNotify('Vault restored from backup');
          }}
        />
      ) : null}

      {confirmExport ? (
        <Modal
          title="Protect this backup"
          onClose={() => setConfirmExport(false)}
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setConfirmExport(false)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void exportVault(exportPassword)}
                disabled={busy || estimateStrength(exportPassword).score < 2}
              >
                {busy ? <span className="spinner" /> : null}
                Export
              </button>
            </>
          }
        >
          <Alert tone="info">
            The backup is re-wrapped with this password, so the file is protected even if it leaves this
            device. Remember it: there is no way to recover a lost backup password.
          </Alert>
          <div className="field">
            <label className="field__label" htmlFor="export-password">
              Backup password
            </label>
            <input
              id="export-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={exportPassword}
              onChange={(event) => setExportPassword(event.target.value)}
            />
          </div>
        </Modal>
      ) : null}

      {confirmReset ? (
        <Modal
          title="Delete all data?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button className="btn btn--danger" onClick={() => void onReset().then(() => setConfirmReset(false))}>
                Delete everything
              </button>
            </>
          }
        >
          <Alert tone="danger">
            All {items.length} logins, every tag, channel, folder, alarm, connected mailbox, setting and
            usage record will be erased from this device, and the clipboard will be cleared. The app
            returns to first-run setup. This cannot be undone, and nobody — including whoever built
            this — can recover any of it.
          </Alert>
        </Modal>
      ) : null}
    </>
  );
}

/* ---- Sections ---------------------------------------------------------- */

function BackgroundSection({
  prefs,
  onUpdate,
  onNotify,
  maxBytes,
}: {
  prefs: VaultPreferences;
  onUpdate: (patch: Partial<VaultPreferences>) => Promise<void> | void;
  onNotify: (message: string, tone?: Toast['tone']) => void;
  maxBytes: number;
}) {
  const [url, setUrl] = useState(prefs.backgroundImage?.startsWith('http') ? prefs.backgroundImage : '');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readImageFile(file, maxBytes);
      await onUpdate({ backgroundImage: dataUrl });
      setUrl('');
      onNotify('Background image added');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that image.');
    }
  }

  return (
    <>
      <Row label="Background image" hint="A URL is fetched by your browser. An upload stays on this device." stacked>
        <div className="field-row">
          <input
            className="input"
            value={url}
            placeholder="https://example.com/photo.jpg"
            inputMode="url"
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              setUrl(value);
              const valid = value.trim() === '' || /^https?:\/\//i.test(value.trim());
              if (valid) void onUpdate({ backgroundImage: value.trim() });
            }}
          />
          <button className="btn btn--secondary" onClick={() => fileInput.current?.click()}>
            Upload
          </button>
          {prefs.backgroundImage ? (
            <button
              className="btn btn--ghost btn--icon"
              aria-label="Remove background"
              onClick={() => {
                setUrl('');
                void onUpdate({ backgroundImage: '' });
              }}
            >
              <XIcon />
            </button>
          ) : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => void onPick(event.target.files?.[0])}
        />
        {error ? <p className="field__error">{error}</p> : null}
        <p className="field__hint">
          Uploads are resized to at most {MAX_IMAGE_EDGE}px and re-encoded, then capped at{' '}
          {Math.round(maxBytes / 1024)} MB &mdash; so almost any photo fits. This one is stored unencrypted in
          preferences, so prefer a URL for anything you would rather not keep on disk.
        </p>
      </Row>

      <Slider
        label="Image opacity"
        hint="How strongly the photo shows through."
        value={prefs.backgroundOpacity}
        min={0}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(backgroundOpacity) => void onUpdate({ backgroundOpacity })}
      />
      <Slider
        label="Blur"
        hint="Softens the photo so text stays readable."
        value={prefs.backgroundBlur}
        min={0}
        max={40}
        step={2}
        format={(v) => `${v}px`}
        onChange={(backgroundBlur) => void onUpdate({ backgroundBlur })}
      />
      <Slider
        label="Dim"
        hint="Darks or lightens everything behind the interface."
        value={prefs.backgroundDim}
        min={0}
        max={0.9}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(backgroundDim) => void onUpdate({ backgroundDim })}
      />
    </>
  );
}

/* ---- Small building blocks -------------------------------------------- */

function Row({
  label,
  hint,
  children,
  stacked,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? 'setting setting--stack' : 'setting'}>
      <div className="setting__text">
        <div className="setting__label">{label}</div>
        {hint ? <div className="setting__hint">{hint}</div> : null}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__label">{label}</div>
        {hint ? <div className="setting__hint">{hint}</div> : null}
      </div>
      <div className="slider-row" style={{ width: 200, flexShrink: 0 }}>
        <input
          className="slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
        />
        <span className="slider-row__value">{format(value)}</span>
      </div>
    </div>
  );
}

/**
 * A small swatch per theme, matching the accent row's dot in size. The
 * full-size preview it replaced was the tallest thing in the Appearance panel
 * and made the three options read as cards rather than choices.
 *
 * System gets a half-light, half-dark swatch of its own. It used to reuse the
 * dark gradient verbatim, so the row read as light | dark | dark and there was
 * no way to tell the two apart without reading the labels.
 */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  const background =
    mode === 'dark'
      ? 'linear-gradient(140deg, hsl(220 18% 22%), hsl(220 24% 9%))'
      : mode === 'system'
        ? 'linear-gradient(90deg, #fff 0 50%, hsl(220 18% 22%) 50% 100%)'
        : 'linear-gradient(140deg, #fff, hsl(210 30% 88%))';
  return (
    <span className="option-card__preview" style={{ background }}>
      <span
        style={{
          position: 'absolute',
          inset: 'auto 2px 2px 2px',
          height: 3,
          borderRadius: 2,
          background: 'var(--grad-primary)',
          opacity: 0.95,
        }}
      />
    </span>
  );
}

/* ---- Modals ----------------------------------------------------------- */

function ChangePasswordModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (a: string, b: string) => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (next !== confirm) return setError('The new passwords do not match.');
    if (estimateStrength(next).score < 2) return setError('Use a longer password.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(current, next);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the vault password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change vault password"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !current || !next}>
            {busy ? <span className="spinner" /> : null} Change password
          </button>
        </>
      }
    >
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <Alert tone="info">
        Only the vault key is re-wrapped, so your logins are not re-encrypted and this is instant.
      </Alert>
      <PasswordFields
        current={current} next={next} confirm={confirm}
        setCurrent={setCurrent} setNext={setNext} setConfirm={setConfirm}
      />
    </Modal>
  );
}

function SetPasswordModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (next: string) => Promise<void> }) {
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (next !== confirm) return setError('The two passwords do not match.');
    if (estimateStrength(next).score < 2) return setError('Use a longer password.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not enable a vault password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a vault password"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !next}>
            {busy ? <span className="spinner" /> : null} Enable password
          </button>
        </>
      }
    >
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <Alert tone="warn">
        There is no recovery. If you forget this password the vault cannot be decrypted by anyone.
      </Alert>
      <PasswordFields next={next} confirm={confirm} setNext={setNext} setConfirm={setConfirm} showStrength />
    </Modal>
  );
}

function DisablePasswordModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (current: string) => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(current);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the vault password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Remove the vault password?"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn--danger" onClick={() => void submit()} disabled={busy || !current}>
            {busy ? <span className="spinner" /> : null} Remove password
          </button>
        </>
      }
    >
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <Alert tone="danger">
        The vault key will be stored directly in this browser. Your logins stay encrypted, but anyone who can
        read this profile can open them.
      </Alert>
      <div className="field">
        <label className="field__label" htmlFor="verify-password">Confirm with your current password</label>
        <input
          id="verify-password" className="input" type="password" autoComplete="current-password"
          value={current} onChange={(event) => setCurrent(event.target.value)}
        />
      </div>
    </Modal>
  );
}

function RestoreModal({
  file, onClose, onDone,
}: {
  file: { text: string; name: string };
  onClose: () => void;
  onDone: (text: string, password?: string, next?: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');
  const [rekey, setRekey] = useState(false);
  const [passwordless, setPasswordless] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const backup = parseBackup(file.text);
      if (!(await verifyBackupPassword(backup, password))) {
        setError('That password does not unlock this backup file.');
        return;
      }
      await onDone(file.text, password, passwordless ? '' : rekey ? next : undefined);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore that file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Restore from backup"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary" onClick={() => void submit()}
            disabled={busy || (password.length === 0) || (rekey && next.length < 10)}
          >
            {busy ? <span className="spinner" /> : null} Restore vault
          </button>
        </>
      }
    >
      <Alert tone="warn">
        <strong>{file.name}</strong> will replace every login currently stored in this vault.
      </Alert>
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <div className="field">
        <label className="field__label" htmlFor="backup-password">Backup vault password</label>
        <input
          id="backup-password" className="input" type="password" autoComplete="off"
          value={password} onChange={(event) => setPassword(event.target.value)}
        />
        <p className="field__note">Leave empty if the backup has no vault password.</p>
      </div>
      <div className="toggle-row">
        <span className="toggle-row__text">Restore without a vault password</span>
        <Toggle label="Restore passwordless" checked={passwordless} onChange={setPasswordless} />
      </div>
      {!passwordless ? (
        <>
          <div className="toggle-row">
            <span className="toggle-row__text">Use a different password on this device</span>
            <Toggle label="Re-key on restore" checked={rekey} onChange={setRekey} />
          </div>
          {rekey ? (
            <div className="field">
              <label className="field__label" htmlFor="rekey-password">New vault password</label>
              <input
                id="rekey-password" className="input" type="password" autoComplete="new-password"
                value={next} onChange={(event) => setNext(event.target.value)}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

function PasswordFields({
  current, next, confirm, setCurrent, setNext, setConfirm, showStrength,
}: {
  current?: string;
  next: string;
  confirm: string;
  setCurrent?: (value: string) => void;
  setNext: (value: string) => void;
  setConfirm: (value: string) => void;
  showStrength?: boolean;
}) {
  return (
    <>
      {setCurrent ? (
        <div className="field">
          <label className="field__label" htmlFor="current-password">Current vault password</label>
          <input
            id="current-password" className="input" type="password" autoComplete="current-password"
            value={current} onChange={(event) => setCurrent(event.target.value)}
          />
        </div>
      ) : null}
      <div className="field">
        <label className="field__label" htmlFor="new-password">New vault password</label>
        <input
          id="new-password" className="input" type="password" autoComplete="new-password"
          value={next} onChange={(event) => setNext(event.target.value)}
        />
        {showStrength ? (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <StrengthInline password={next} />
          </div>
        ) : null}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="repeat-password">Repeat new password</label>
        <input
          id="repeat-password" className="input" type="password" autoComplete="new-password"
          value={confirm} onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
    </>
  );
}

function StrengthInline({ password }: { password: string }) {
  const strength = estimateStrength(password);
  if (!password) return null;
  const colors = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--accent)', 'var(--accent)'];
  return (
    <div className="strength">
      <div className="strength__bar">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index} className="strength__seg"
            style={{ background: index <= strength.score ? colors[strength.score] : 'var(--border)' }}
          />
        ))}
      </div>
      <div className="strength__meta">
        <span className="strength__label" style={{ color: colors[strength.score] }}>{strength.label}</span>
        <span className="strength__time">~{strength.bits} bits</span>
      </div>
    </div>
  );
}

function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert tone="danger">
      <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertIcon width="16" height="16" style={{ marginTop: 2, flexShrink: 0 }} />
        {children}
      </span>
    </Alert>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}