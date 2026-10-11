import { useRef, useState } from 'react';
import { CHANNEL_ACCENTS, CHANNEL_ICONS, createFolder, type ChannelAccent, type Folder } from '../vault/channels.ts';
import { MAX_APP_BACKGROUND_BYTES } from '../vault/types.ts';
import { readImageFile } from './card-art.ts';
import { useDraftAutoSave } from './hooks.ts';
import { Modal } from './primitives.tsx';
import { SecurityForm } from './SecurityForm.tsx';
import {
  CloudIcon,
  FlagIcon,
  FolderIcon,
  GridIcon,
  InboxIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  ShieldIcon,
  StarIcon,
  TrashIcon,
} from './icons.tsx';

const ICON_SET: Record<string, typeof InboxIcon> = {
  inbox: InboxIcon,
  star: StarIcon,
  flag: FlagIcon,
  shield: ShieldIcon,
  layers: LayersIcon,
  key: KeyIcon,
  lock: LockIcon,
  cloud: CloudIcon,
  grid: GridIcon,
  folder: FolderIcon,
};

const ACCENT_HUES: Record<string, number> = { slate: 212, sage: 152, dusk: 268, clay: 28 };

/* * Editor for a sidebar folder: name, icon, hue, theme, image and its own lock.
 *
 * Every field lands as it is changed. There is no Save step on an existing
 * folder: the name, colour, picture and image controls write themselves a
 * moment after the last edit, so what you see in the rail while the editor is
 * open is already the stored folder. A brand new folder still needs its Add
 * button — there is nothing to update until it exists and has a name.
 */
export function FolderEditor({
  folder,
  onSave,
  onAutosave,
  onDelete,
  onClose,
  onNotify,
}: {
  /** null means "create a new folder". */
  folder: Folder | null;
  onSave: (next: Folder) => void;
  /** Writes a change to an existing folder without announcing it. */
  onAutosave?: (next: Folder) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Folder>(() => folder ?? createFolder(''));
  const [imageUrl, setImageUrl] = useState(folder?.backgroundImage?.startsWith('http') ? folder.backgroundImage : '');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'appearance' | 'security'>('appearance');
  const fileInput = useRef<HTMLInputElement>(null);

  const patch = (next: Partial<Folder>) => setDraft((current) => ({ ...current, ...next }));

  // Only an existing, named folder autosaves: a half-typed new one would
  // otherwise create itself the moment a letter was pressed.
  useDraftAutoSave(draft, Boolean(folder && onAutosave && draft.name.trim()), (next) =>
    onAutosave?.({ ...next, name: next.name.trim() }),
  );

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readImageFile(file, MAX_APP_BACKGROUND_BYTES);
      patch({ backgroundImage: dataUrl });
      setImageUrl('');
      onNotify('Folder image added');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that image.');
    }
  }

  function save() {
    if (!draft.name.trim()) {
      setError('Give the folder a name.');
      return;
    }
    onSave({ ...draft, name: draft.name.trim() });
    onClose();
  }

  const Icon = ICON_SET[draft.icon] ?? FolderIcon;

  return (
    <Modal
      title={folder ? `Edit ${folder.name}` : 'New folder'}
      onClose={onClose}
      wide
      footer={
        <>
          {folder && onDelete ? (
            <button
              className="btn btn--danger"
              onClick={() => {
                onDelete(folder.id);
                onClose();
              }}
            >
              <TrashIcon width="14" height="14" />
              Delete
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          {folder ? (
            // Already written as it was edited; this only closes the window.
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button className="btn btn--secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn--primary" onClick={save} disabled={!draft.name.trim()}>
                Add folder
              </button>
            </>
          )}
        </>
      }
    >
      {error ? <p className="field__error">{error}</p> : null}

      <div className="channel-preview" data-hue={draft.hue}>
        <span className="channel-preview__dot" />
        <Icon />
        <span className="channel-preview__name">{draft.name.trim() || 'Folder name'}</span>
      </div>

      <div className="field-row" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="segmented">
          <button className="segmented__option" aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}>
            Appearance
          </button>
          <button className="segmented__option" aria-pressed={tab === 'security'} onClick={() => setTab('security')}>
            Security
          </button>
        </div>
      </div>

      {tab === 'appearance' ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="folder-name">
              Name
            </label>
            <input id="folder-name" className="input" value={draft.name} placeholder="Work" onChange={(event) => patch({ name: event.target.value })} />
          </div>

          <div className="field">
            <span className="field__label">Icon</span>
            <div className="icon-picker">
              {[...CHANNEL_ICONS, 'folder' as const].map((key) => {
                const Glyph = ICON_SET[key] ?? FolderIcon;
                return (
                  <button key={key} className="icon-picker__option" aria-pressed={draft.icon === key} aria-label={key} onClick={() => patch({ icon: key })}>
                    <Glyph />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="folder-hue">
              Colour
            </label>
            <div className="slider-row" style={{ width: '100%' }}>
              <input id="folder-hue" className="slider" type="range" min={0} max={359} value={draft.hue} onChange={(event) => patch({ hue: Number(event.target.value) })} />
              <span className="slider-row__value">{Math.round(draft.hue)}°</span>
            </div>
          </div>

          <div className="field">
            <span className="field__label">Theme</span>
            <div className="segmented segmented--wrap">
              {CHANNEL_ACCENTS.map((accent) => (
                <button key={accent} className="segmented__option" aria-pressed={draft.accent === accent} onClick={() => patch({ accent: accent as ChannelAccent })}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: `linear-gradient(135deg, hsl(${ACCENT_HUES[accent] ?? 212} 44% 58%), hsl(${((ACCENT_HUES[accent] ?? 212) + 22) % 360} 38% 46%))`,
                    }}
                  />
                  {accent[0]?.toUpperCase()}
                  {accent.slice(1)}
                </button>
              ))}
            </div>
            <p className="field__hint">Applied to the whole app while this folder is open.</p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="folder-image">
              Background image
            </label>
            <div className="field-row">
              <input
                id="folder-image"
                className="input"
                value={imageUrl}
                placeholder="https://example.com/photo.jpg"
                inputMode="url"
                spellCheck={false}
                onChange={(event) => {
                  const value = event.target.value;
                  setImageUrl(value);
                  if (value.trim() === '' || /^https?:\/\//i.test(value.trim())) patch({ backgroundImage: value.trim() });
                }}
              />
              <button className="btn btn--secondary" onClick={() => fileInput.current?.click()}>
                Upload
              </button>
              {draft.backgroundImage ? (
                <button className="btn btn--ghost btn--icon" aria-label="Remove image" onClick={() => { setImageUrl(''); patch({ backgroundImage: '' }); }}>
                  ×
                </button>
              ) : null}
            </div>
            <input ref={fileInput} type="file" accept="image/*" className="sr-only" onChange={(event) => void onPick(event.target.files?.[0])} />
            <p className="field__hint">
              A backdrop for this folder: it fills the app while the folder is open, and paints the folder's own
              row in the rail.
            </p>
            {/* The same three controls as a channel's, because the two do the
                same thing — a folder's picture is just shown over a subtree. */}
            {draft.backgroundImage ? (
              <div className="bg-look">
                {([
                  { id: 'folder-bg-opacity', label: 'Strength', key: 'backgroundOpacity', min: 0, max: 1, step: 0.05, format: (v: number) => `${Math.round(v * 100)}%` },
                  { id: 'folder-bg-blur', label: 'Blur', key: 'backgroundBlur', min: 0, max: 40, step: 1, format: (v: number) => `${Math.round(v)}px` },
                  { id: 'folder-bg-dim', label: 'Veil', key: 'backgroundDim', min: 0, max: 0.9, step: 0.05, format: (v: number) => `${Math.round(v * 100)}%` },
                ] as const).map((control) => (
                  <div className="bg-look__row" key={control.id}>
                    <label className="field__label" htmlFor={control.id}>
                      {control.label}
                    </label>
                    <div className="slider-row" style={{ flex: 1 }}>
                      <input
                        id={control.id}
                        className="slider"
                        type="range"
                        min={control.min}
                        max={control.max}
                        step={control.step}
                        value={draft[control.key]}
                        onChange={(event) => patch({ [control.key]: Number(event.target.value) })}
                      />
                      <span className="slider-row__value">{control.format(draft[control.key])}</span>
                    </div>
                  </div>
                ))}
                <p className="field__hint" style={{ margin: 0 }}>
                  A veil over the picture keeps row text readable on a bright photo. These are the folder's own
                  values — they do not change the app-wide background.
                </p>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <SecurityForm security={draft.security} onChange={(security) => patch({ security })} onNotify={onNotify} label={draft.name || 'folder'} />
      )}
    </Modal>
  );
}
