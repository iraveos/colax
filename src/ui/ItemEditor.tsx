/**
 * Login editor, laid out like Settings: a rail of sections down the side and one
 * panel at a time.
 *
 * Six labelled cards stacked in a scrolling column buried the fields that matter
 * and made the dialog much taller than it needed to be. The rail keeps every
 * section one click away and the height stable as fields are added.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { generatePassphrase, generatePassword, type GeneratorOptions } from '../crypto/passwords.ts';
import { EMPTY_SECURITY, requiresVerification } from '../crypto/security.ts';
import { SecurityForm } from './SecurityForm.tsx';
import {
  MAX_AVATAR_BYTES,
  MAX_BACKGROUND_BYTES,
  MAX_IMAGE_EDGE,
  fromDateInput,
  hueFor,
  isAllowedImageSrc,
  relativeTime,
  toDateInput,
  type VaultItem,
} from '../vault/types.ts';
import { createTag, type Tag } from '../vault/channels.ts';
import { readImageFile } from './card-art.ts';
import { Alert, Modal, StrengthMeter, Toggle } from './primitives.tsx';
import {
  CopyIcon,
  DiceIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  FlagIcon,
  KeyIcon,
  LockIcon,
  PaletteIcon,
  ShieldIcon,
  TagIcon,
  XIcon,
} from './icons.tsx';
import type { Toast } from './hooks.ts';

export function Generator({
  options,
  onOptionsChange,
  onUse,
}: {
  options: GeneratorOptions;
  onOptionsChange: (next: GeneratorOptions) => void;
  onUse: (password: string) => void;
}) {
  const [mode, setMode] = useState<'random' | 'passphrase'>('random');
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);

  const roll = (nextMode = mode) => {
    try {
      setValue(
        nextMode === 'random' ? generatePassword(options) : generatePassphrase(Math.ceil(options.length / 7)),
      );
    } catch {
      setValue('');
    }
  };

  useEffect(roll, [options, mode]);

  const sets: [keyof GeneratorOptions, string][] = [
    ['lower', 'aâ€“z'],
    ['upper', 'Aâ€“Z'],
    ['digits', '0â€“9'],
    ['symbols', '!@#'],
  ];

  return (
    <>
      <div className="field-row" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="segmented">
          <button
            type="button"
            className="segmented__option"
            aria-pressed={mode === 'random'}
            onClick={() => setMode('random')}
          >
            Random
          </button>
          <button
            type="button"
            className="segmented__option"
            aria-pressed={mode === 'passphrase'}
            onClick={() => setMode('passphrase')}
          >
            Words
          </button>
        </div>
      </div>

      <div className="gen__preview">
        <span className="gen__value">{revealed ? value : 'â€¢'.repeat(value.length)}</span>
        <button type="button" className="btn btn--icon" onClick={() => setRevealed((r) => !r)} aria-label="Toggle visibility">
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        <button type="button" className="btn btn--icon" onClick={() => roll()} aria-label="Generate again">
          <DiceIcon />
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => navigator.clipboard.writeText(value).catch(() => {})}
        >
          <CopyIcon width="14" height="14" />
          Copy
        </button>
      </div>

      <div className="field">
        <div className="slider-row">
          <input
            className="slider"
            type="range"
            min={mode === 'random' ? 8 : 3}
            max={mode === 'random' ? 64 : 10}
            value={options.length}
            onChange={(event) =>
              onOptionsChange({
                ...options,
                length:
                  mode === 'random'
                    ? Number(event.target.value)
                    : Math.max(3, Math.round(Number(event.target.value) / 7)),
              })
            }
            aria-label="Length"
          />
          <span className="slider-row__value">
            {mode === 'random' ? options.length : `${Math.max(3, Math.round(options.length / 7))} words`}
          </span>
        </div>
      </div>

      {mode === 'random' ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          {sets.map(([key, label]) => (
            <div className="toggle-row" key={key}>
              <span className="toggle-row__text">{label}</span>
              <Toggle
                label={label}
                checked={options[key] as boolean}
                onChange={(next) => onOptionsChange({ ...options, [key]: next })}
              />
            </div>
          ))}
          <div className="toggle-row">
            <span className="toggle-row__text">Avoid look-alikes (l, 1, O, 0)</span>
            <Toggle
              label="Avoid look-alikes"
              checked={options.avoidAmbiguous}
              onChange={(next) => onOptionsChange({ ...options, avoidAmbiguous: next })}
            />
          </div>
        </div>
      ) : (
        <div className="field__note" style={{ marginBottom: 'var(--space-4)' }}>
          A passphrase of {Math.max(3, Math.round(options.length / 7))} words from this list gives far more
          entropy than a short random string, and is easier to type.
        </div>
      )}

      <StrengthMeter password={value} />

      {value ? (
        <button
          type="button"
          className="btn btn--primary btn--block"
          style={{ marginTop: 'var(--space-6)' }}
          onClick={() => onUse(value)}
        >
          Use this password
        </button>
      ) : (
        <Alert tone="warn">Turn on at least one character set.</Alert>
      )}
    </>
  );
}

const SECTIONS = [
  { id: 'identity', label: 'Identity', hint: 'What this login is called and where it lives.', Icon: KeyIcon },
  { id: 'credentials', label: 'Credentials', hint: 'The secrets. Nothing here leaves this device.', Icon: LockIcon },
  { id: 'security', label: 'Security', hint: 'Optional second factor for this login alone.', Icon: ShieldIcon },
  { id: 'organise', label: 'Organise', hint: 'Tags and the dates behind the health warnings.', Icon: TagIcon },
  { id: 'appearance', label: 'Appearance', hint: 'Icon, colours and images.', Icon: PaletteIcon },
  { id: 'notes', label: 'Notes', hint: 'Anything else worth remembering.', Icon: EditIcon },
  { id: 'flags', label: 'Flags', hint: 'Sorting, favourites and warnings.', Icon: FlagIcon },
] as const;

export function ItemEditor({
  item,
  tags: tagCatalogue,
  generatorOptions,
  onGeneratorOptionsChange,
  onSave,
  onClose,
  onRequestUnlock,
  verified = true,
  onNotify,
  onCommitTags,
}: {
  item: VaultItem | null;
  /** Global tag catalogue, so new tags can be created inline. */
  tags: Tag[];
  generatorOptions: GeneratorOptions;
  onGeneratorOptionsChange: (next: GeneratorOptions) => void;
  onSave: (draft: Partial<VaultItem>) => Promise<void>;
  onClose: () => void;
  /**
   * Asks for this login's second factor. Used only when the editor is reached
   * for a secured login without the gate having been cleared, so the password
   * field can demand verification instead of simply showing the secret.
   */
  onRequestUnlock?: () => void;
  /**
   * True once this login's second factor has been cleared this session.
   *
   * The editor is meant to be unreachable for a secured login until its factor
   * is cleared, and App gates that. This is the second lock on the same door: if
   * the editor is ever reached for an unverified login by a route that bypassed
   * the gate, the password stays masked and the reveal button asks instead of
   * handing the secret over.
   */
  verified?: boolean;
  onNotify: (message: string) => void;
  /** Persists any tags the user created while editing. */
  onCommitTags: (tags: Tag[]) => void;
}) {
  const [draft, setDraft] = useState<Partial<VaultItem>>(item ?? {});
  const [revealed, setRevealed] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<string>('identity');

  /** True when this login has a factor that has not been cleared for the form. */
  const passwordLocked = Boolean(item && requiresVerification(item.security) && !verified);

  useEffect(() => {
    setDraft(item ?? {});
    setRevealed(false);
    setShowGenerator(false);
    // A different login means a different set of fields worth looking at.
    setSection('identity');
  }, [item]);

  const patch = (next: Partial<VaultItem>) => setDraft((current) => ({ ...current, ...next }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  const panels: Record<string, ReactNode> = {
    identity: (
      <>
        <div className="field">
          <label className="field__label" htmlFor="title">
            Name
          </label>
          <input
            id="title"
            className="input"
            value={draft.title ?? ''}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder="GitHub"
            autoFocus
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="url">
            Website
          </label>
          <input
            id="url"
            className="input"
            value={draft.url ?? ''}
            onChange={(event) => patch({ url: event.target.value })}
            placeholder="github.com"
            inputMode="url"
            spellCheck={false}
          />
          <p className="field__note">
            The domain is what &ldquo;Open site&rdquo; uses, and it drives the icon and accent when those are left
            on automatic.
          </p>
        </div>
      </>
    ),

    credentials: (
      <>
        <div className="field">
          <label className="field__label" htmlFor="username">
            Email or username
          </label>
          <input
            id="username"
            className="input"
            value={draft.username ?? ''}
            onChange={(event) => patch({ username: event.target.value })}
            placeholder="you@example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <div className="field-row">
            <input
              id="password"
              className="input input--mono"
              type={revealed ? 'text' : 'password'}
              value={draft.password ?? ''}
              onChange={(event) => patch({ password: event.target.value })}
              autoComplete="new-password"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => {
                // A secured login asks before it shows anything, even here.
                if (passwordLocked) {
                  onRequestUnlock?.();
                  return;
                }
                setRevealed((r) => !r);
              }}
              aria-label={passwordLocked ? 'Unlock to show password' : revealed ? 'Hide password' : 'Show password'}
              title={passwordLocked ? 'This login has a second factor' : undefined}
            >
              {passwordLocked ? <LockIcon /> : revealed ? <EyeOffIcon /> : <EyeIcon />}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setShowGenerator((g) => !g)}>
              <DiceIcon width="14" height="14" />
              Generate
            </button>
          </div>
          {passwordLocked ? (
            <p className="field__note">Clear this login&apos;s second factor to reveal its password.</p>
          ) : null}
        </div>

        {draft.password ? (
          <div className="field">
            <StrengthMeter password={draft.password} />
          </div>
        ) : null}

        {showGenerator ? (
          <div className="editor-embed">
            <Generator
              options={generatorOptions}
              onOptionsChange={onGeneratorOptionsChange}
              onUse={(password) => {
                patch({ password });
                setShowGenerator(false);
                onNotify('Generated password applied');
              }}
            />
          </div>
        ) : null}

        </>
    ),

    security: (
      <SecurityForm
        security={draft.security ?? EMPTY_SECURITY}
        onChange={(security) => patch({ security })}
        onNotify={onNotify}
        label={draft.title || 'login'}
      />
    ),

    organise: (
      <>
        <div className="field">
          <span className="field__label">Tags</span>
          <TagPicker
            selected={draft.tags ?? []}
            catalogue={tagCatalogue}
            onChange={(next) => patch({ tags: next })}
            onCreate={(tag) => onCommitTags([...tagCatalogue, tag])}
          />
        </div>

        <div className="field">
          <span className="field__label">Last changed</span>
          <div className="date-grid">
            <div>
              <label className="date-grid__label" htmlFor="password-date">
                Password
              </label>
              <input
                id="password-date"
                className="input input--mono"
                type="date"
                value={toDateInput(draft.passwordUpdatedAt ?? Date.now())}
                max={toDateInput(Date.now())}
                onChange={(event) => {
                  const parsed = fromDateInput(event.target.value);
                  if (parsed) patch({ passwordUpdatedAt: parsed });
                }}
              />
              <span className="date-grid__hint">{relativeTime(draft.passwordUpdatedAt ?? Date.now())}</span>
            </div>
            <div>
              <label className="date-grid__label" htmlFor="email-date">
                Email
              </label>
              <input
                id="email-date"
                className="input input--mono"
                type="date"
                value={toDateInput(draft.usernameUpdatedAt ?? Date.now())}
                max={toDateInput(Date.now())}
                onChange={(event) => {
                  const parsed = fromDateInput(event.target.value);
                  if (parsed) patch({ usernameUpdatedAt: parsed });
                }}
              />
              <span className="date-grid__hint">{relativeTime(draft.usernameUpdatedAt ?? Date.now())}</span>
            </div>
          </div>
          <p className="field__note">
            These update on their own when the password or email changes. Set them by hand if you rotated or
            updated something elsewhere.
          </p>
        </div>
      </>
    ),

    appearance: <ThemePicker draft={draft} patch={patch} onNotify={onNotify} />,

    notes: (
      <div className="field">
        <label className="field__label" htmlFor="notes">
          Notes
        </label>
        <textarea
          id="notes"
          className="input"
          value={draft.notes ?? ''}
          onChange={(event) => patch({ notes: event.target.value })}
          placeholder="Recovery codes, security questions, anything else"
        />
      </div>
    ),

    flags: (
      <>
        <div className="toggle-row">
          <span className="toggle-row__text">Add to favorites</span>
          <Toggle
            label="Add to favorites"
            checked={draft.favorite ?? false}
            onChange={(next) => patch({ favorite: next })}
          />
        </div>
        <div className="toggle-row">
          <span className="toggle-row__text">Needs attention</span>
          <Toggle
            label="Needs attention"
            checked={draft.needsAttention ?? false}
            onChange={(next) => patch({ needsAttention: next })}
          />
        </div>
      </>
    ),
  };

  return (
    <Modal
      title={item?.title ? `Edit ${item.title}` : 'New login'}
      onClose={onClose}
      wide
      bodyClassName="editor-window__body"
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={saving}>
            {saving ? <span className="spinner" /> : null}
            {item ? 'Save changes' : 'Add to vault'}
          </button>
        </>
      }
    >
      <div className="editor-window">
        <nav className="editor-window__rail" aria-label="Editor sections">
          {SECTIONS.map((entry) => {
            const Icon = entry.Icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="settings-tab editor-window__tab"
                aria-selected={entry.id === section}
                aria-controls={`editor-panel-${entry.id}`}
                id={`editor-tab-${entry.id}`}
                onClick={() => setSection(entry.id)}
              >
                <span className="settings-tab__icon">
                  <Icon />
                </span>
                <span className="settings-tab__label">{entry.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="editor-window__main">
          <header className="editor-window__head">
            <h3 className="editor-window__title">{active.label}</h3>
            <p className="editor-window__hint">{active.hint}</p>
          </header>
          <form
            className="editor-window__panel"
            id={`editor-panel-${section}`}
            role="tabpanel"
            aria-labelledby={`editor-tab-${section}`}
            onSubmit={submit}
          >
            {panels[section]}
          </form>
        </div>
      </div>
    </Modal>
  );
}


/* ---- Tag picker -------------------------------------------------------- */

function TagPicker({
  selected,
  catalogue,
  onChange,
  onCreate,
}: {
  selected: string[];
  catalogue: Tag[];
  onChange: (next: string[]) => void;
  onCreate: (tag: Tag) => void;
}) {
  const [name, setName] = useState('');
  const all = catalogue;

  function addTag() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = all.find((tag) => tag.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      if (!selected.includes(existing.id)) onChange([...selected, existing.id]);
    } else {
      const created = createTag(trimmed, all);
      // Persist immediately so the tag survives even if the login is cancelled.
      onCreate(created);
      onChange([...selected, created.id]);
    }
    setName('');
  }

  return (
    <div className="tag-picker">
      <div className="field-row">
        <input
          className="input"
          value={name}
          placeholder="Add a tag and press Enter"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addTag();
            }
          }}
        />
        <button type="button" className="btn btn--secondary" onClick={addTag} disabled={!name.trim()}>
          Add
        </button>
      </div>

      {all.length > 0 ? (
        <div className="tag-cloud">
          {all.map((tag) => {
            const on = selected.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                className="tag-chip"
                aria-pressed={on}
                style={{ '--tag-h': String(tag.hue) } as React.CSSProperties}
                onClick={() => onChange(on ? selected.filter((id) => id !== tag.id) : [...selected, tag.id])}
              >
                <span className="tag-chip__dot" />
                {tag.name}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="field__note">No tags yet. Add one above to group and filter logins.</p>
      )}
    </div>
  );
}

/* ---- Per-login appearance ---------------------------------------------- */

const HUE_PRESETS = [
  { label: 'Auto', hue: null },
  { label: 'Slate', hue: 212 },
  { label: 'Sage', hue: 152 },
  { label: 'Dusk', hue: 268 },
  { label: 'Clay', hue: 28 },
  { label: 'Sea', hue: 196 },
  { label: 'Moss', hue: 118 },
  { label: 'Plum', hue: 316 },
];

function ThemePicker({
  draft,
  patch,
  onNotify,
}: {
  draft: Partial<VaultItem>;
  patch: (next: Partial<VaultItem>) => void;
  onNotify: (message: string, tone?: Toast['tone']) => void;
}) {
  const [hue, setHue] = useState<number | null>(draft.accentHue ?? null);
  const [customHue, setCustomHue] = useState<number | null>(draft.accentHue ?? null);
  const [url, setUrl] = useState(draft.backgroundImage?.startsWith('http') ? draft.backgroundImage : '');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState(
    draft.avatarImage?.startsWith('http') ? draft.avatarImage : '',
  );
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  // Mirrors accentOf() for the in-progress draft, without needing a full item.
  const autoHue = hueFor(draft.title || draft.username || draft.url || 'aegis');
  const effectiveHue = hue ?? autoHue;

  const photo = draft.backgroundImage?.startsWith('data:image/') ? draft.backgroundImage : url;
  // The preview shows whichever icon the card would actually use, so an explicit
  // avatar is visible before saving rather than only after.
  const avatarPreview = draft.avatarImage?.startsWith('data:image/')
    ? draft.avatarImage
    : avatarUrl && isAllowedImageSrc(avatarUrl)
      ? avatarUrl
      : null;
  const blur = Math.max(0, draft.backgroundBlur ?? 0);
  const gradient = `linear-gradient(135deg, hsl(${effectiveHue} 40% 54%), hsl(${(effectiveHue + 34) % 360} 36% 42%))`;
  const previewStyle: Record<string, string> = { background: gradient };
  // The photo goes on its own layer, matching the card, so previewing a blur here
  // does not blur the initial letter behind it.
  const artStyle: Record<string, string> = {};
  if (photo && isAllowedImageSrc(photo)) {
    artStyle.backgroundImage = `url("${photo.replace(/["'()\\]/g, '\\$&')}")`;
    artStyle.filter = blur > 0 ? `blur(${blur}px)` : '';
    // Pull the layer out by the blur radius so the soft edges fall outside the
    // preview and get clipped.
    artStyle.inset = `${-blur}px`;
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    try {
      const dataUrl = await readImageFile(file, MAX_BACKGROUND_BYTES);
      patch({ backgroundImage: dataUrl });
      setUrl('');
      onNotify(`Background set (${Math.round(dataUrl.length / 1024)} KB stored)`);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : 'Could not read that image.');
    }
  }

  /** Icons are small, so a tighter cap keeps the encrypted record lean. */
  async function onPickAvatar(file: File | undefined) {
    if (!file) return;
    setAvatarError(null);
    try {
      const dataUrl = await readImageFile(file, MAX_AVATAR_BYTES);
      patch({ avatarImage: dataUrl });
      setAvatarUrl('');
      onNotify(`Icon set (${Math.round(dataUrl.length / 1024)} KB stored)`);
    } catch (cause) {
      setAvatarError(cause instanceof Error ? cause.message : 'Could not read that image.');
    }
  }

  return (
    <div className="theme-picker">
      <div className="field">
        <label className="field__label" htmlFor="accent">
          Colour theme
        </label>
        <div className="hue-grid" id="accent">
          {HUE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="hue-swatch"
              aria-pressed={hue === preset.hue}
              onClick={() => {
                setHue(preset.hue);
                setCustomHue(preset.hue);
                patch({ accentHue: preset.hue });
              }}
            >
              <span
                className="hue-swatch__chip"
                style={
                  preset.hue === null
                    ? { background: 'conic-gradient(from 210deg, hsl(212 40% 58%), hsl(152 40% 58%), hsl(268 40% 58%), hsl(28 40% 58%), hsl(212 40% 58%))' }
                    : { background: `linear-gradient(135deg, hsl(${preset.hue} 40% 56%), hsl(${(preset.hue + 34) % 360} 36% 44%))` }
                }
              />
              {preset.label}
            </button>
          ))}
        </div>
        <div className="slider-row" style={{ marginTop: 'var(--space-2)' }}>
          <input
            className="slider"
            type="range"
            min={0}
            max={359}
            value={customHue ?? effectiveHue}
            onChange={(event) => {
              const next = Number(event.target.value);
              setHue(next);
              setCustomHue(next);
              patch({ accentHue: next });
            }}
            aria-label="Custom accent hue"
          />
          <span className="slider-row__value">{customHue ?? effectiveHue}&deg;</span>
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="bg-url">
          Background image
        </label>
        <div className="theme-picker__preview" style={previewStyle}>
          {photo && isAllowedImageSrc(photo) ? (
            <span className="theme-picker__art" style={artStyle} aria-hidden="true" />
          ) : null}
          {avatarPreview ? (
            <span
              className="theme-picker__avatar"
              style={{ backgroundImage: `url("${avatarPreview.replace(/["'()\\]/g, '\\$&')}")` }}
              aria-hidden="true"
            />
          ) : (
            <span className="theme-picker__initial">{draft.title?.trim()[0]?.toUpperCase() ?? '?'}</span>
          )}
        </div>
        <div className="field-row" style={{ marginTop: 'var(--space-2)' }}>
          <input
            id="bg-url"
            className="input"
            value={url}
            placeholder="https://example.com/photo.jpg"
            inputMode="url"
            spellCheck={false}
            onChange={(event) => {
              setUrl(event.target.value);
              const valid = isAllowedImageSrc(event.target.value.trim());
              patch({ backgroundImage: valid ? event.target.value.trim() : '' });
            }}
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => fileInput.current?.click()}
          >
            Upload
          </button>
          {draft.backgroundImage ? (
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              aria-label="Remove background"
              onClick={() => {
                setUrl('');
                patch({ backgroundImage: '' });
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
          onChange={(event) => void onPickFile(event.target.files?.[0])}
        />
        {uploadError ? <p className="field__error">{uploadError}</p> : null}
        <p className="field__note">
          A URL is fetched by your browser when the card renders. An upload is resized to {MAX_IMAGE_EDGE}px,
          re-encoded and stored inside this encrypted record, so it never leaves the device &mdash; most photos
          fit well under the {Math.round(MAX_BACKGROUND_BYTES / 1024)} MB limit.
        </p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="avatar-url">
          Icon image
        </label>
        <div className="field-row">
          <input
            id="avatar-url"
            className="input"
            value={avatarUrl}
            placeholder="https://example.com/logo.png"
            inputMode="url"
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              setAvatarUrl(value);
              const valid = value.trim() === '' || isAllowedImageSrc(value.trim());
              if (valid) patch({ avatarImage: value.trim() });
            }}
          />
          <button type="button" className="btn btn--secondary" onClick={() => avatarInput.current?.click()}>
            Upload
          </button>
          {draft.avatarImage ? (
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              aria-label="Remove icon image"
              onClick={() => {
                setAvatarUrl('');
                patch({ avatarImage: '' });
              }}
            >
              <XIcon />
            </button>
          ) : null}
        </div>
        <input
          ref={avatarInput}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => void onPickAvatar(event.target.files?.[0])}
        />
        <p className="field__note">
          Separate from the card background, so a logo stays readable at 40px while the card keeps its photo.
          Leave it empty to fall back to the background image.
        </p>
        {avatarError ? <p className="field__error">{avatarError}</p> : null}
      </div>

      {draft.backgroundImage ? (
        <div className="field">
          <label className="field__label" htmlFor="bg-blur">
            Background blur
          </label>
          <div className="slider-row">
            <input
              id="bg-blur"
              className="slider"
              type="range"
              min={0}
              max={8}
              value={draft.backgroundBlur ?? 0}
              onChange={(event) => patch({ backgroundBlur: Number(event.target.value) })}
              aria-label="Background blur"
            />
            <span className="slider-row__value">{draft.backgroundBlur ?? 0}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
