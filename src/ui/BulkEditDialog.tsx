/**
 * Bulk edit dialog for a multi-selection of logins.
 *
 * Built around the one rule that matters: nothing is applied unless the user
 * typed it. Every text field starts empty with a placeholder showing what is
 * already there, and an empty field means "leave it alone" rather than "clear
 * it". That is the difference between this being safe and the obvious version
 * being destructive.
 *
 * See bulk-edit.ts for why the form must not be seeded from the first login.
 */

import { useMemo, useState } from 'react';
import type { VaultItem } from '../vault/types.ts';
import type { Tag } from '../vault/channels.ts';
import { extractEmails } from '../vault/site-intel.ts';
import { detectBulk, markClipboardSelfWritten } from './useClipboardWatcher.ts';
import { countAffected, type BulkEdit } from './bulk-edit.ts';
import { formatLoginForClipboard, formatLoginsForClipboard } from './login-format.ts';
import { Modal } from './primitives.tsx';
import { CopyIcon } from './icons.tsx';
import { HUE_PRESETS } from './ItemEditor.tsx';

type Field = 'title' | 'notes' | 'tags' | 'theme';

const FIELD_TITLES: Record<Field, string> = {
  title: 'Title',
  notes: 'Notes',
  tags: 'Tags',
  theme: 'Theme',
};

/**
 * Describes what the selection currently holds, so the placeholder can say what
 * will be kept rather than leaving the field looking like it is about to be
 * blanked.
 */
function summary(items: readonly VaultItem[], field: Field): string {
  const values = new Set<string>();
  for (const item of items) {
    if (field === 'title') values.add(item.title || '(empty)');
    else if (field === 'notes') values.add(item.notes ? 'has notes' : '(empty)');
    else if (field === 'tags') values.add(item.tags.map((id) => id).sort().join(', ') || '(no tags)');
    else values.add(String(item.accentHue ?? 'auto'));
  }
  if (values.size === 0) return '';
  if (values.size === 1) return [...values][0]!;
  // More than one distinct value: say so, because this is exactly the case where
  // overwriting would be the destructive move and leaving it alone is correct.
  return `${values.size} different values`;
}

export function BulkEditDialog({
  items,
  field,
  tags,
  onApply,
  onCancel,
  onNotify,
}: {
  items: readonly VaultItem[];
  field: Field;
  tags: readonly Tag[];
  onApply: (edit: BulkEdit) => void;
  onCancel: () => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [value, setValue] = useState('');
  const [tagIds, setTagIds] = useState<string[] | null>(null);
  const [hue, setHue] = useState<number | null | undefined>(undefined);

  // Built only from fields the user touched. `value` is left as '' rather than
  // being defaulted, and it is only included when non-empty, so an untouched
  // field never appears in the edit at all.
  const edit = useMemo<BulkEdit>(() => {
    const next: BulkEdit = {};
    if (field === 'title' && value.trim()) next.title = value.trim();
    if (field === 'notes' && value.trim()) next.notes = value.trim();
    if (field === 'tags' && tagIds) next.tags = tagIds;
    if (field === 'theme' && hue !== undefined) next.accentHue = hue;
    return next;
  }, [field, value, tagIds, hue]);

  const affected = countAffected(items, edit);
  const nothingToDo = Object.keys(edit).length === 0 || affected === 0;

  const share = async () => {
    const text = formatLoginsForClipboard(items);
    markClipboardSelfWritten(text);
    try {
      await navigator.clipboard.writeText(text);
      onNotify(items.length === 1 ? 'Login copied' : `${items.length} logins copied`);
    } catch {
      onNotify('Could not reach the clipboard', 'error');
    }
  };

  return (
    <Modal
      title={`Edit ${items.length} ${items.length === 1 ? 'login' : 'logins'}`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={nothingToDo}
            onClick={() => {
              onApply(edit);
              onCancel();
            }}
          >
            {affected > 0 ? `Apply to ${affected}` : 'Apply'}
          </button>
        </>
      }
    >
      <div className="bulk">
        <p className="bulk__lead">
          Only what you fill in is changed. Everything you leave blank keeps its current value.
        </p>

        <div className="field">
          <label className="field__label" htmlFor="bulk-value">
            {FIELD_TITLES[field]}
          </label>
          {field === 'tags' ? (
            <div className="bulk__tags">
              {tags.length === 0 ? <p className="field__hint">No tags defined yet.</p> : null}
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="chip"
                  data-on={tagIds?.includes(tag.id) || undefined}
                  aria-pressed={tagIds?.includes(tag.id) ?? false}
                  onClick={() => {
                    const current = tagIds ?? [];
                    setTagIds(
                      current.includes(tag.id)
                        ? current.filter((id) => id !== tag.id)
                        : [...current, tag.id],
                    );
                  }}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          ) : field === 'theme' ? (
            <div className="hue-grid">
              <button
                type="button"
                className="hue-swatch"
                data-on={hue === null || undefined}
                aria-pressed={hue === null}
                onClick={() => setHue(null)}
              >
                Auto
              </button>
              {HUE_PRESETS.map((preset) => (
                <button
                  key={preset.hue}
                  type="button"
                  className="hue-swatch"
                  data-on={hue === preset.hue || undefined}
                  aria-pressed={hue === preset.hue}
                  onClick={() => setHue(preset.hue)}
                >
                  <span
                    aria-hidden="true"
                    style={{ background: `hsl(${preset.hue} 58% 56%)`, width: 14, height: 14, borderRadius: 4 }}
                  />
                </button>
              ))}
            </div>
          ) : (
            <input
              id="bulk-value"
              className="input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={summary(items, field)}
            />
          )}
          <p className="field__hint">
            Currently: {summary(items, field) || '—'}
          </p>
        </div>

        <button type="button" className="btn btn--secondary bulk__share" onClick={() => void share()}>
          <ShareGlyph />
          Copy {items.length === 1 ? 'this login' : `all ${items.length}`}
        </button>

        {items.length === 1 && field === 'title' ? (
          <button
            type="button"
            className="btn btn--quiet bulk__share"
            onClick={() => {
              const text = formatLoginForClipboard(items[0]!);
              markClipboardSelfWritten(text);
              void navigator.clipboard
                .writeText(text)
                .then(() => onNotify('Login copied'))
                .catch(() => onNotify('Could not reach the clipboard', 'error'));
            }}
          >
            <CopyIcon width="14" height="14" />
            Copy as email and password
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Bulk-add dialog: paste addresses — or whole address+password dumps — and get
 * one login each.
 *
 * Two modes, picked automatically:
 *
 * - Address list (no `-` lines): one login per address, empty password. Copy a
 *   column of addresses from anywhere — one per line, or comma/space
 *   separated, wrapping and junk tolerated.
 * - Credential blocks (entries divided by `-` lines): each block becomes a
 *   login *with its password*. Glued (`me@x.comhunter2`), spaced
 *   (`me@x.com hunter2`), two-line, wrapped-across-lines and labelled shapes
 *   are all read; line breaks inside a block join into the password.
 *
 * Addresses already saved in the vault are skipped rather than duplicated, and
 * each row can be dropped before committing. New logins land untagged (so they
 * wait in Unassigned).
 */
export function BulkAddDialog({
  existingUsernames,
  onAdd,
  onCancel,
  onNotify,
}: {
  /** Lowercased usernames already in the vault, for skip-not-duplicate. */
  existingUsernames: ReadonlySet<string>;
  onAdd: (items: { username: string; password: string }[]) => void;
  onCancel: () => void;
  onNotify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  // Credential-block mode when `-` lines divide the paste; otherwise plain
  // address-list mode. First pasted spelling of an address wins, so a repeated
  // address never mints two logins.
  const parsed = useMemo(() => {
    const bulk = detectBulk(text);
    if (bulk !== null) {
      const seen = new Set<string>();
      const out: { username: string; password: string }[] = [];
      for (const creds of bulk) {
        const key = creds.username.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ username: creds.username, password: creds.password });
      }
      return out;
    }
    return extractEmails(text).map((email) => ({ username: email, password: '' }));
  }, [text]);
  const isPairs = useMemo(() => detectBulk(text) !== null, [text]);
  const fresh = useMemo(
    () =>
      parsed.filter(
        (entry) => !existingUsernames.has(entry.username.toLowerCase()) && !removed.has(entry.username.toLowerCase()),
      ),
    [parsed, existingUsernames, removed],
  );
  const skipped = removed.size;
  const alreadySaved = useMemo(
    () => parsed.filter((entry) => existingUsernames.has(entry.username.toLowerCase())),
    [parsed, existingUsernames],
  );

  async function pasteFromClipboard() {
    try {
      setText(await navigator.clipboard.readText());
    } catch {
      onNotify('Could not read the clipboard — paste with Ctrl+V instead', 'error');
    }
  }

  return (
    <Modal
      title="Bulk add logins"
      onClose={onCancel}
      wide
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={fresh.length === 0}
            onClick={() => {
              onAdd(fresh);
              onCancel();
            }}
          >
            {fresh.length > 0 ? `Add ${fresh.length} login${fresh.length === 1 ? '' : 's'}` : 'Add'}
          </button>
        </>
      }
    >
      <div className="bulk">
        <p className="bulk__lead">
          Paste addresses — one per line — and each becomes its own login. Passwords come along
          too when they follow their address line by line, or in blocks divided by <code>-</code> lines
          (glued, spaced, two-line, wrapped or labelled). Saved addresses are skipped, junk ignored.
        </p>
        <div className="field">
          <label className="field__label" htmlFor="bulk-emails">
            {isPairs ? 'Addresses + passwords' : 'Email addresses'}
          </label>
          <textarea
            id="bulk-emails"
            className="input"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setRemoved(new Set());
            }}
            placeholder={'ana@example.comhunter2\n-\nben@example.org\ns3cr3t'}
            rows={6}
            spellCheck={false}
          />
        </div>
        <div className="field-row">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void pasteFromClipboard()}>
            Paste from clipboard
          </button>
          {text ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => { setText(''); setRemoved(new Set()); }}>
              Clear
            </button>
          ) : null}
        </div>
        {parsed.length > 0 ? (
          <p className="field__hint">
            {fresh.length} new{alreadySaved.length > 0 ? ` · ${alreadySaved.length} already saved (skipped)` : ''}
            {skipped > 0 ? ` · ${skipped} removed` : ''} · junk ignored
          </p>
        ) : text.trim() ? (
          <p className="field__hint">
            {isPairs ? 'No address + password pairs found in those blocks yet.' : 'No addresses found in that text yet.'}
          </p>
        ) : null}
        {fresh.length > 0 ? (
          <ul className="inbox__list" style={{ maxHeight: 220 }}>
            {fresh.map((entry) => (
              <li key={entry.username.toLowerCase()} className="inbox__message" style={{ flexDirection: 'row', alignItems: 'center' }}>
                <span className="inbox__meta" style={{ flex: 1 }}>
                  {entry.username}
                  {entry.password ? (
                    <span className="inbox__summary inbox__summary--full" style={{ fontFamily: 'var(--font-mono)' }}>
                      {entry.password}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  aria-label={`Drop ${entry.username}`}
                  onClick={() => setRemoved((current) => new Set(current).add(entry.username.toLowerCase()))}
                >
                  Drop
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {alreadySaved.length > 0 ? (
          <p className="field__hint">Skipped (already in the vault): {alreadySaved.map((entry) => entry.username).join(', ')}</p>
        ) : null}
      </div>
    </Modal>
  );
}

function ShareGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="8.6" cy="9.2" r="3.1" />
      <path d="M2.6 19.4c0-2.6 2.7-4.4 6-4.4 1 0 2 .15 2.8.45" />
      <path d="M14.4 6.1a2.9 2.9 0 1 1 2.5 4.3" />
      <path d="M15.6 14.6c2.6.2 4.4 1.8 4.4 4" />
    </svg>
  );
}
