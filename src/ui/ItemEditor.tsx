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
  MAX_NOTE_ATTACHMENTS,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_MEDIA_BYTES,
  attachmentBytes,
  fromDateInput,
  hueFor,
  isAllowedImageSrc,
  isNoteMediaMime,
  relativeTime,
  toDateInput,
  type VaultItem,
} from '../vault/types.ts';
import { createTag, type Tag } from '../vault/channels.ts';
import { mailboxUsable } from '../vault/site-intel.ts';
import { readImageFile } from './card-art.ts';
import { readNoteAttachment } from './note-media.ts';
import { attachmentFileName, attachmentSizeLabel } from './attachment-label.ts';
import { noteHtmlToText, sanitizeNoteHtml } from './note-html.ts';
import { RichNotes } from './RichNotes.tsx';
import { Alert, Modal, StrengthMeter, Toggle } from './primitives.tsx';
import { formatLoginCompact } from './login-format.ts';
import { markClipboardSelfWritten } from './useClipboardWatcher.ts';
import { InboxSection } from './InboxSection.tsx';
import { TempMailMessages } from './TempMailMessages.tsx';
import type { GmailAccount } from '../vault/storage.ts';
import type { GmailMessage } from './useGmail.ts';
import { getPlatform } from '../lib/platform.ts';
import {
  MOHMAL_MAX_RENEW_MINUTES,
  isEmailLike,
  normaliseReusableEmails,
  pickReusableEmail,
  tempMailNextRenewLabel,
  tempMailRemainingLabel,
} from '../lib/temp-mail.ts';
import {
  BellIcon,
  ClockIcon,
  CopyIcon,
  DiceIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FlagIcon,
  KeyIcon,
  LockIcon,
  PaletteIcon,
  ShieldIcon,
  TagIcon,
  TrashIcon,
  DownloadIcon,
  UploadIcon,
  XIcon,
  MailIcon,
  ShareIcon,
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
  // Word count lives beside the character length, not inside it: the two
  // modes measure different things, and sharing one field meant the words
  // slider wrote a word count into the character-length preference (and a
  // later visit to random mode inherited nonsense).
  const [words, setWords] = useState(() => Math.max(3, Math.min(10, Math.round(options.length / 7))));

  useEffect(() => {
    try {
      setValue(mode === 'random' ? generatePassword(options) : generatePassphrase(words));
    } catch {
      setValue('');
    }
  }, [options, mode, words]);

  const roll = () => {
    try {
      setValue(mode === 'random' ? generatePassword(options) : generatePassphrase(words));
    } catch {
      setValue('');
    }
  };

  const sets: [keyof GeneratorOptions, string][] = [
    ['lower', 'a-z'],
    ['upper', 'A-Z'],
    ['digits', '0-9'],
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
        <span className="gen__value">{revealed ? value : '•'.repeat(value.length)}</span>
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

      {value ? (
        <button
          type="button"
          className="btn btn--primary btn--block"
          style={{ margin: 'var(--space-4) 0' }}
          onClick={() => onUse(value)}
        >
          Use this password
        </button>
      ) : (
        <Alert tone="warn">Turn on at least one character set.</Alert>
      )}

      <div className="field">
        <div className="slider-row">
          <input
            className="slider"
            type="range"
            min={mode === 'random' ? 8 : 3}
            max={mode === 'random' ? 64 : 10}
            value={mode === 'random' ? options.length : words}
            onChange={(event) => {
              if (mode === 'random') onOptionsChange({ ...options, length: Number(event.target.value) });
              else setWords(Number(event.target.value));
            }}
            aria-label={mode === 'random' ? 'Length' : 'Words'}
          />
          <span className="slider-row__value">
            {mode === 'random' ? options.length : `${words} words`}
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
            <span className="toggle-row__text">Avoid look-alikes (l, 1, I, O, 0, o)</span>
            <Toggle
              label="Avoid look-alikes"
              checked={options.avoidAmbiguous}
              onChange={(next) => onOptionsChange({ ...options, avoidAmbiguous: next })}
            />
          </div>
        </div>
      ) : (
        <div className="field__note" style={{ marginBottom: 'var(--space-4)' }}>
          A passphrase of {words} words from this list gives far more
          entropy than a short random string, and is easier to type.
        </div>
      )}

      <StrengthMeter password={value} />
    </>
  );
}

/**
 * Rotation reminder picker: presets from minutes to months, plus any manual
 * count in minutes, hours or days. Stored as fractional days — 15 minutes is
 * 15/1440 — so every stale check in the app follows it with no conversion.
 */
type ReminderUnit = 'minute' | 'hour' | 'day';

const UNIT_MINUTES: Record<ReminderUnit, number> = { minute: 1, hour: 60, day: 1440 };

function inferReminderUnit(days: number): ReminderUnit {
  if (days <= 0) return 'day';
  const minutes = days * 1440;
  if (minutes < 60) return 'minute';
  if (minutes < 2880) return 'hour';
  return 'day';
}

const REMINDER_PRESETS: { label: string; days: number; unit: ReminderUnit; hint: string }[] = [
  { label: 'Follow global', days: 0, unit: 'day', hint: 'Uses the global stale-password setting' },
  { label: '15 min', days: 15 / 1440, unit: 'minute', hint: 'Flagged a quarter hour after each change' },
  { label: '1 hour', days: 1 / 24, unit: 'hour', hint: 'Flagged an hour after each change' },
  { label: '12 hours', days: 0.5, unit: 'hour', hint: 'Flagged half a day after each change' },
  { label: '1 day', days: 1, unit: 'day', hint: 'Flagged a day after each change' },
  { label: '7 days', days: 7, unit: 'day', hint: 'Flagged a week after each change' },
  { label: '30 days', days: 30, unit: 'day', hint: 'Flagged a month after each change' },
  { label: '90 days', days: 90, unit: 'day', hint: 'Flagged three months after each change' },
];

function ReminderPanel({
  value,
  passwordUpdatedAt,
  staleDays,
  onChange,
}: {
  value: number;
  passwordUpdatedAt: number;
  staleDays: number;
  onChange: (days: number) => void;
}) {
  const [unit, setUnit] = useState<ReminderUnit>(() => inferReminderUnit(value));
  const shown = Math.round((value / (UNIT_MINUTES[unit] / 1440)) * 100) / 100;
  return (
    <>
      <div className="field">
        <span className="field__label">Rotation reminder</span>
        <div className="segmented segmented--wrap" role="radiogroup" aria-label="Rotation reminder">
          {REMINDER_PRESETS.map((preset) => {
            // Rounded on save, so exact equality cannot spot a preset back.
            const active = Math.abs(value - preset.days) < 1e-6;
            return (
              <button
                key={preset.label}
                type="button"
                role="radio"
                aria-checked={active}
                className="segmented__option"
                aria-pressed={active}
                title={preset.hint}
                onClick={() => {
                  setUnit(preset.unit);
                  onChange(preset.days);
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <p className="field__note">
          Overrides the global stale-password setting for this login only. The stale badge, the
          Weak channel and the dashboard all follow it.
        </p>
      </div>
      <div className="field">
        <span className="field__label">Or set manually</span>
        <div className="field-row">
          <div className="segmented" role="radiogroup" aria-label="Reminder unit">
            {(Object.keys(UNIT_MINUTES) as ReminderUnit[]).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={unit === option}
                className="segmented__option"
                aria-pressed={unit === option}
                onClick={() => setUnit(option)}
              >
                {option === 'minute' ? 'Min' : option === 'hour' ? 'Hours' : 'Days'}
              </button>
            ))}
          </div>
          <input
            className="input input--mono"
            type="number"
            min={0}
            value={shown}
            aria-label={`Reminder every (in ${unit}s)`}
            onChange={(event) => {
              const num = Math.max(0, Number(event.target.value) || 0);
              onChange((num * UNIT_MINUTES[unit]) / 1440);
            }}
          />
        </div>
        <p className="field__note">
          {value <= 0
            ? `Following the global setting (${staleDays} days).`
            : `Flags this password around ${new Date(passwordUpdatedAt + value * 86_400_000).toLocaleString()}.`}
        </p>
      </div>
    </>
  );
}

const SECTIONS = [
  { id: 'identity', label: 'Identity', hint: 'What this login is called and where it lives.', Icon: KeyIcon },
  { id: 'credentials', label: 'Credentials', hint: 'The secrets. Nothing here leaves this device.', Icon: LockIcon },
  { id: 'security', label: 'Security', hint: 'Optional second factor for this login alone.', Icon: ShieldIcon },
  { id: 'reminders', label: 'Reminders', hint: 'When this login asks for a fresh password.', Icon: BellIcon },
  { id: 'organise', label: 'Organise', hint: 'Tags and the dates behind the health warnings.', Icon: TagIcon },
  { id: 'appearance', label: 'Appearance', hint: 'Icon, colours and images.', Icon: PaletteIcon },
  { id: 'notes', label: 'Notes', hint: 'Anything else worth remembering.', Icon: EditIcon },
  { id: 'inbox', label: 'Inbox', hint: 'Connect a mailbox and read recent mail here.', Icon: MailIcon },
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
  emailSuggestions = [],
  reusableEmails = [],
  onReusableEmailsChange,
  /** The saved item's current temp inbox, for renewals that happen while editing. */
  liveTempMail = null,
  gmailAccounts,
  onGmailAccountsChange,
  onCacheMail,
  staleDays = 180,
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
  onNotify: (message: string, tone?: Toast['tone']) => void;
  /** Persists any tags the user created while editing. */
  onCommitTags: (tags: Tag[]) => void;
  /** Email addresses already used in this vault, offered as suggestions. */
  emailSuggestions?: string[];
  /** Addresses saved for random reuse across new logins. */
  reusableEmails?: string[];
  onReusableEmailsChange?: (next: string[]) => void;
  liveTempMail?: VaultItem['tempMail'];
  /** Connected mailboxes, shared across the app rather than per-login. */
  gmailAccounts: GmailAccount[];
  onGmailAccountsChange: (next: GmailAccount[]) => void;
  /** Persists inbox reads into the message cache. */
  onCacheMail?: (accountId: string, messages: GmailMessage[]) => void;
  /** Global stale-password threshold, for the "follow global" hint. */
  staleDays?: number;
}) {
  const [draft, setDraft] = useState<Partial<VaultItem>>(item ?? {});
  const [revealed, setRevealed] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<string>('identity');
  /** Which pasted image/video is open full-size, null when none is. */
  const [viewingNote, setViewingNote] = useState<number | null>(null);
  const [tempMailBusy, setTempMailBusy] = useState(false);
  const [tempRenewBusy, setTempRenewBusy] = useState(false);
  const [savedEmailsOpen, setSavedEmailsOpen] = useState(false);
  const [, setTempMailClock] = useState(0);
  const hasTempMail = Boolean(draft.tempMail);
  const [savedDraft, setSavedDraft] = useState('');
  const noteFileInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLFormElement>(null);

  /** True when this login has a factor that has not been cleared for the form. */
  const passwordLocked = Boolean(item && requiresVerification(item.security) && !verified);
  // An imported copy is a view of someone else's login. Its shared fields are
  // read-only here; local tags, appearance, flags and dates remain the
  // recipient's own. The owner's next sync is the authority.
  const linked = item?.shareLink && item.shareLink.endedAt === null ? item.shareLink : null;
  const notesShared = Boolean(linked?.fields.notes);
  const attachmentsShared = Boolean(linked?.fields.attachments);
  const savedEmails = normaliseReusableEmails(reusableEmails);
  const currentEmail = (draft.username ?? '').trim();
  const currentIsSaved =
    isEmailLike(currentEmail) &&
    savedEmails.some((address) => address.toLowerCase() === currentEmail.toLowerCase());
  const tempMail = draft.tempMail ?? null;
  const emailChoices = [
    ...new Set(
      [
        ...emailSuggestions,
        ...gmailAccounts.map((account) => account.address.trim()),
        ...savedEmails,
      ].filter((address) => address.includes('@')),
    ),
  ].slice(0, 300);

  useEffect(() => {
    setDraft(item ?? {});
    setRevealed(false);
    setShowGenerator(false);
    // A different login means a different set of fields worth looking at.
    setSection('identity');
    setViewingNote(null);
  }, [item]);

  // A new section starts at its top. Without this, switching from a long
  // Credentials panel to Inbox could leave the messages scrolled past the
  // heading, which reads as an empty panel.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [section]);

  // Auto-renewal updates the saved item while this editor is open. Merge the
  // newer timestamps into the draft, keeping the user's unsaved interval and
  // any manual renewal they may have just made.
  // Refresh "minutes left" and "next renewal" while the panel is open. The
  // auto-renewal itself is handled in the main process.
  useEffect(() => {
    if (!hasTempMail) return;
    const timer = window.setInterval(() => setTempMailClock((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [hasTempMail]);

  useEffect(() => {
    if (!liveTempMail) return;
    setDraft((current) => {
      const currentMail = current.tempMail;
      if (!currentMail || currentMail.address !== liveTempMail.address) return current;
      if (liveTempMail.lastRenewedAt <= currentMail.lastRenewedAt) return current;
      return {
        ...current,
        tempMail: {
          ...currentMail,
          expiresAt: liveTempMail.expiresAt,
          lastRenewedAt: liveTempMail.lastRenewedAt,
        },
      };
    });
  }, [liveTempMail]);

  const patch = (next: Partial<VaultItem>) => setDraft((current) => ({ ...current, ...next }));

  function updateSavedEmails(next: string[]): void {
    onReusableEmailsChange?.(normaliseReusableEmails(next));
  }

  function addSavedEmail(address = currentEmail): void {
    if (linked) return;
    if (!isEmailLike(address)) {
      onNotify('Enter a valid email address first.', 'error');
      return;
    }
    if (savedEmails.some((entry) => entry.toLowerCase() === address.trim().toLowerCase())) {
      onNotify('That email is already saved.');
      return;
    }
    updateSavedEmails([...savedEmails, address]);
    onNotify(`Saved ${address.trim()} for reuse`);
  }

  function removeSavedEmail(address: string): void {
    updateSavedEmails(savedEmails.filter((entry) => entry.toLowerCase() !== address.toLowerCase()));
  }

  function useRandomSavedEmail(): void {
    if (linked) return;
    const pick = pickReusableEmail(savedEmails, currentEmail);
    if (!pick) {
      setSavedEmailsOpen(true);
      onNotify('Save an email first, then Colax can pick one at random.');
      return;
    }
    patch({ username: pick });
    onNotify(`Using saved email ${pick}`);
  }

  async function createTempMailbox(): Promise<void> {
    if (linked) return;
    if (tempMail) {
      onNotify('Remove the current temporary inbox before creating another.', 'error');
      return;
    }
    const api = getPlatform().tempMail;
    if (!api) {
      onNotify('Temporary Mohmal inboxes need the Colax desktop app.', 'error');
      return;
    }
    setTempMailBusy(true);
    try {
      const result = await api.create();
      if (!result.ok) {
        onNotify(result.error, 'error');
        return;
      }
      patch({
        username: result.mailbox.address,
        tempMail: result.mailbox,
        showMail: true,
      });
      onNotify(`Temporary inbox ready: ${result.mailbox.address}`);
    } catch (cause) {
      onNotify(
        cause instanceof Error ? cause.message : 'Could not create a temporary inbox.',
        'error',
      );
    } finally {
      setTempMailBusy(false);
    }
  }

  function setTempMailAutoRenew(minutes: number): void {
    const mailbox = draft.tempMail;
    if (!mailbox) return;
    const next = Math.max(0, Math.min(MOHMAL_MAX_RENEW_MINUTES, Math.round(minutes)));
    patch({ tempMail: { ...mailbox, autoRenewMinutes: next } });
  }

  async function renewTempMailbox(): Promise<void> {
    const mailbox = draft.tempMail;
    if (!mailbox) return;
    const api = getPlatform().tempMail;
    if (!api?.renew) {
      onNotify('Temporary Mohmal inboxes need the Colax desktop app.', 'error');
      return;
    }
    setTempRenewBusy(true);
    try {
      const result = await api.renew(mailbox.address, mailbox.sessionKey);
      if (!result.ok) {
        onNotify(result.error, 'error');
        return;
      }
      patch({
        tempMail: {
          ...mailbox,
          expiresAt: result.expiresAt,
          lastRenewedAt: result.renewedAt,
        },
      });
      onNotify('Temporary inbox renewed for another 45 minutes');
    } catch (cause) {
      onNotify(
        cause instanceof Error ? cause.message : 'Could not renew the temporary inbox.',
        'error',
      );
    } finally {
      setTempRenewBusy(false);
    }
  }

  function removeTempMailbox(): void {
    patch({ tempMail: null });
    onNotify('Temporary inbox removed from this login. Messages stay at Mohmal until they expire.');
  }

  const attachments = draft.attachments ?? [];
  const mediaAttachments = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => isNoteMediaMime(attachment.mime));
  const fileAttachments = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => !isNoteMediaMime(attachment.mime));
  const mediaIndexes = mediaAttachments.map(({ index }) => index);
  const viewingPosition = viewingNote === null ? -1 : mediaIndexes.indexOf(viewingNote);

  /**
   * Files pasted, dropped or uploaded into the notes become attachments that
   * the save seals inside the encrypted login, in the order added. Text paste
   * never reaches here: RichNotes keeps its formatting and only sends actual
   * files down this path.
   */
  const collectNoteFiles = async (files: File[]) => {
    const existing = draft.attachments ?? [];
    if (existing.length >= MAX_NOTE_ATTACHMENTS) {
      onNotify(`Notes hold the attachment limit (${MAX_NOTE_ATTACHMENTS}) — remove something first`);
      return;
    }
    let used = existing.reduce((sum, attachment) => sum + attachmentBytes(attachment.dataUrl), 0);
    let working = [...existing];
    let rejected = '';
    for (const file of files) {
      if (working.length >= MAX_NOTE_ATTACHMENTS) {
        rejected = `the ${MAX_NOTE_ATTACHMENTS}-attachment limit was reached first`;
        break;
      }
      try {
        const attachment = await readNoteAttachment(file);
        const bytes = attachmentBytes(attachment.dataUrl);
        if (used + bytes > MAX_NOTE_MEDIA_BYTES) {
          rejected = `the ${Math.round(MAX_NOTE_MEDIA_BYTES / 1_000_000)} MB notes attachment budget was hit first`;
          break;
        }
        working = [...working, attachment];
        used += bytes;
      } catch (cause) {
        rejected = cause instanceof Error ? cause.message : 'one file could not be read';
        break;
      }
    }
    if (working.length > existing.length) {
      onNotify(
        rejected
          ? `${working.length - existing.length} added — ${rejected}`
          : `${working.length - existing.length} added to the notes`,
      );
      patch({ attachments: working });
    } else if (rejected) {
      onNotify(rejected.charAt(0).toUpperCase() + rejected.slice(1));
    }
  };

  /** Removes one attachment, keeping the viewer on a neighbouring picture. */
  const removeNoteMedia = (index: number) => {
    const next = (draft.attachments ?? []).filter((_, kept) => kept !== index);
    patch({ attachments: next });
    if (viewingNote === null || !next.some((attachment) => isNoteMediaMime(attachment.mime))) {
      setViewingNote(null);
      return;
    }
    let nearest = -1;
    for (let after = index; after < next.length; after += 1) {
      if (isNoteMediaMime(next[after]!.mime)) {
        nearest = after;
        break;
      }
    }
    if (nearest < 0) {
      for (let before = Math.min(index - 1, next.length - 1); before >= 0; before -= 1) {
        if (isNoteMediaMime(next[before]!.mime)) {
          nearest = before;
          break;
        }
      }
    }
    setViewingNote(nearest >= 0 ? nearest : null);
  };

  /** Swaps one attached picture with its nearest picture neighbour. */
  const moveNoteMedia = (index: number, direction: -1 | 1) => {
    const list = [...(draft.attachments ?? [])];
    const pictures = list
      .map((attachment, at) => ({ attachment, at }))
      .filter(({ attachment }) => isNoteMediaMime(attachment.mime));
    const position = pictures.findIndex(({ at }) => at === index);
    const target = pictures[position + direction];
    if (position < 0 || !target) return;
    [list[index], list[target.at]] = [list[target.at]!, list[index]!];
    patch({ attachments: list });
    setViewingNote(target.at);
  };

  /** Capture-phase keys: Esc closes only the viewer, arrows step through the
      pictures, and the editor's own Escape handling never sees the keypress. */
  useEffect(() => {
    if (viewingNote === null) return;
    const pictures = (draft.attachments ?? [])
      .map((attachment, index) => ({ attachment, index }))
      .filter(({ attachment }) => isNoteMediaMime(attachment.mime));
    const position = pictures.findIndex(({ index }) => index === viewingNote);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setViewingNote(null);
      } else if (event.key === 'ArrowLeft' && position > 0) {
        setViewingNote(pictures[position - 1]!.index);
      } else if (event.key === 'ArrowRight' && position >= 0 && position < pictures.length - 1) {
        setViewingNote(pictures[position + 1]!.index);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [viewingNote, draft.attachments]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      // Store one sanitised HTML copy and its plain-text counterpart. The
      // plain text is what cards, search and clipboard exports read, so it
      // must be recomputed after sanitising rather than left as whatever the
      // browser's innerText happened to say.
      const notesHtml = draft.notesHtml ? sanitizeNoteHtml(draft.notesHtml) : '';
      const notes = notesHtml ? noteHtmlToText(notesHtml) : (draft.notes ?? '');
      await onSave({ ...draft, notes, notesHtml });
    } finally {
      setSaving(false);
    }
  }

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];
  const activeHint =
    section === 'inbox' && draft.tempMail
      ? 'Read and manage this login’s temporary Mohmal messages.'
      : active.hint;

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
            readOnly={Boolean(linked)}
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
            readOnly={Boolean(linked)}
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
            readOnly={Boolean(linked)}
            list={emailChoices.length > 0 ? 'login-email-suggestions' : undefined}
          />
          {emailChoices.length > 0 ? (
            <>
              <datalist id="login-email-suggestions">
                {emailChoices.map((address) => (
                  <option key={address} value={address} />
                ))}
              </datalist>
              <span className="field__hint">
                Start typing to reuse an email already in this vault.
              </span>
            </>
          ) : null}
          <div className="editor-mail-tools">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={Boolean(linked) || tempMailBusy || Boolean(tempMail)}
              title={
                tempMail
                  ? 'Remove the current temporary inbox first'
                  : 'Create a Mohmal temporary address and fill it in'
              }
              onClick={() => void createTempMailbox()}
            >
              {tempMailBusy ? <span className="spinner" /> : <MailIcon width="13" height="13" />}
              Temp mail
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={Boolean(linked) || savedEmails.length === 0}
              title={
                savedEmails.length === 0
                  ? 'Save some addresses first'
                  : 'Pick one of your saved addresses at random'
              }
              onClick={useRandomSavedEmail}
            >
              <DiceIcon width="13" height="13" />
              Random saved
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              disabled={Boolean(linked)}
              onClick={() => setSavedEmailsOpen(true)}
            >
              Saved emails{savedEmails.length > 0 ? ` (${savedEmails.length})` : ''}
            </button>
            {!currentIsSaved && isEmailLike(currentEmail) && !linked ? (
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => addSavedEmail()}
              >
                Save email
              </button>
            ) : null}
            {currentIsSaved ? <span className="chip chip--muted">Saved</span> : null}
          </div>

          {savedEmailsOpen ? (
            <div className="editor-embed saved-emails">
              <div className="saved-emails__head">
                <span className="field__label">Saved emails</span>
                <button
                  type="button"
                  className="btn btn--icon btn--sm"
                  aria-label="Close saved emails"
                  onClick={() => setSavedEmailsOpen(false)}
                >
                  <XIcon width="13" height="13" />
                </button>
              </div>
              <p className="field__hint">
                These are offered for random reuse in any new login. They are addresses, not
                credentials. A temporary Mohmal address keeps its inbox only on the login where
                it was created.
              </p>
              <div className="field-row">
                <input
                  className="input"
                  value={savedDraft}
                  onChange={(event) => setSavedDraft(event.target.value)}
                  placeholder="another@example.com"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Email address to save"
                  list={emailChoices.length > 0 ? 'saved-email-suggestions' : undefined}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addSavedEmail(savedDraft);
                    setSavedDraft('');
                  }}
                />
                {emailChoices.length > 0 ? (
                  <datalist id="saved-email-suggestions">
                    {emailChoices.map((address) => (
                      <option key={address} value={address} />
                    ))}
                  </datalist>
                ) : null}
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    addSavedEmail(savedDraft);
                    setSavedDraft('');
                  }}
                >
                  Add
                </button>
              </div>
              {isEmailLike(currentEmail) && !currentIsSaved ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => addSavedEmail(currentEmail)}
                >
                  Add the email above
                </button>
              ) : null}
              {savedEmails.length > 0 ? (
                <>
                  <ul className="saved-emails__list">
                    {savedEmails.map((address) => (
                      <li key={address}>
                        <span title={address}>{address}</span>
                        <button
                          type="button"
                          className="btn btn--icon btn--sm"
                          aria-label={`Remove ${address}`}
                          onClick={() => removeSavedEmail(address)}
                        >
                          <TrashIcon width="13" height="13" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => {
                      useRandomSavedEmail();
                      setSavedEmailsOpen(false);
                    }}
                  >
                    <DiceIcon width="13" height="13" />
                    Use a random saved email
                  </button>
                </>
              ) : (
                <p className="field__hint">No saved addresses yet.</p>
              )}
            </div>
          ) : null}

          {tempMail ? (
            <div className="temp-mail-status">
              <div className="temp-mail-status__main">
                <span className="field__label">Mohmal temporary inbox</span>
                <code className="temp-mail-status__address">{tempMail.address}</code>
                <span className="field__hint">
                  {tempMailRemainingLabel(tempMail)} · expires{' '}
                  {new Date(tempMail.expiresAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  . The Messages button on this login opens it, and the Inbox tab shows it here.
                </span>
                <div className="temp-mail-renew">
                  <label className="field__label" htmlFor="temp-mail-auto-renew">
                    Auto-renew every
                  </label>
                  <input
                    id="temp-mail-auto-renew"
                    className="input temp-mail-renew__input"
                    type="number"
                    min={0}
                    max={MOHMAL_MAX_RENEW_MINUTES}
                    step={1}
                    value={tempMail.autoRenewMinutes}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setTempMailAutoRenew(Number(event.target.value))}
                  />
                  <span className="temp-mail-renew__unit">min</span>
                  <span className="field__hint">{tempMailNextRenewLabel(tempMail)}</span>
                </div>
                <span className="field__hint">
                  Save the login to start automatic renewal. 0 turns it off; choose 1–40 minutes.
                  Mohmal resets the inbox to 45 minutes each time. It runs while Colax is open, even
                  when the vault is locked.
                </span>
              </div>
              <div className="temp-mail-status__actions">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setSection('inbox')}
                >
                  <MailIcon width="13" height="13" />
                  Messages
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={tempRenewBusy}
                  onClick={() => void renewTempMailbox()}
                >
                  {tempRenewBusy ? <span className="spinner" /> : <ClockIcon width="13" height="13" />}
                  Renew now
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={removeTempMailbox}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : null}

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
              readOnly={Boolean(linked)}
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
          </div>
          <div className="editor-actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setShowGenerator((g) => !g)}
              disabled={Boolean(linked)}
            >
              <DiceIcon width="14" height="14" />
              Generate
            </button>
            {/* Short share for one login: title, email, password. A friend with
                Colax pastes it straight back into a login. */}
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={Boolean(linked) || (!draft.username && !draft.password)}
              title="Copy a short share block for this login"
              onClick={() => {
                // Marked before writing: without this the clipboard watcher
                // reads our own share back and offers to save a duplicate.
                const text = formatLoginCompact({
                  title: draft.title ?? '',
                  username: draft.username ?? '',
                  password: passwordLocked ? '' : (draft.password ?? ''),
                  totpSecret: draft.totpSecret,
                });
                markClipboardSelfWritten(text);
                void navigator.clipboard
                  .writeText(text)
                  .then(() => onNotify('Login shared — paste it to a friend with Colax'))
                  .catch(() => onNotify('Could not reach the clipboard'));
              }}
            >
              <ShareIcon width="14" height="14" />
              Share
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

    reminders: (
      <ReminderPanel
        value={draft.reminderDays ?? 0}
        passwordUpdatedAt={draft.passwordUpdatedAt ?? Date.now()}
        staleDays={staleDays}
        onChange={(reminderDays) => patch({ reminderDays })}
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

    inbox: draft.tempMail ? (
      <>
        <Alert tone="info">
          Messages from this login live in its Mohmal temporary inbox below. It is disposable
          and expires after about 45 minutes; when it does, remove it in Credentials and create a
          new address. The card&apos;s Messages button opens the same inbox in a window.
        </Alert>
        <div className="field">
          <Toggle
            label="Show messages on this login"
            checked={draft.showMail === true}
            onChange={(showMail) => patch({ showMail })}
          />
          <p className="field__note">
            {draft.showMail === true
              ? 'This login shows its Messages button. '
              : 'Switched off here, so this login shows no Messages button. '}
            A temporary inbox does not read any IMAP account. Remove it when you want the normal
            mailbox controls back.
          </p>
        </div>
        <TempMailMessages
          mailbox={draft.tempMail}
          inline
          onNotify={onNotify}
          onOpenExternal={(url) => getPlatform().openExternal(url)}
        />
        <div className="editor-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={removeTempMailbox}
          >
            Remove temporary inbox
          </button>
        </div>
      </>
    ) : (
      <>
        <div className="field">
          <Toggle
            label="Show messages on this login"
            checked={draft.showMail === true}
            onChange={(showMail) => patch({ showMail })}
          />
          <p className="field__note">
            {draft.showMail === true
              ? 'This login shows its Messages button. '
              : 'Switched off here, so this login shows no Messages button. '}
            A login whose email is a connected mailbox reads that mailbox — the address it was
            connected for, never another login's mail. Other logins stay off: switch this on and
            this one reads the channel's mail scope instead.
          </p>
        </div>
        {draft.showMail === true ? (
          <div className="field">
            <span className="field__label">Which messages</span>
            <div className="segmented" role="radiogroup" aria-label="Which messages to show">
              {(
                [
                  ['auto', 'Auto', 'Its mailbox, else only mail matched to this login'],
                  ['matched', 'Matched only', 'Only mail to this login'],
                  ['recent', 'Recent only', 'Everything recent, unmatched'],
                ] as const
              ).map(([mode, label, hint]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={(draft.mailFilter ?? 'auto') === mode}
                  className="segmented__option"
                  aria-pressed={(draft.mailFilter ?? 'auto') === mode}
                  title={hint}
                  onClick={() => patch({ mailFilter: mode })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <InboxSection
          accounts={gmailAccounts}
          onAccountsChange={(next) => {
            // Connecting a mailbox *for this login* switches its messages on.
            // New logins start with mail off (so one connected mailbox cannot
            // put messages on every other login), and without this the very
            // link the user just made would have arrived switched off.
            const before = new Set(
              gmailAccounts.filter((account) => mailboxUsable(account)).map((account) => account.id),
            );
            const added = next.filter((account) => mailboxUsable(account) && !before.has(account.id));
            const mine = (draft.username ?? '').trim().toLowerCase();
            if (
              draft.showMail !== true &&
              mine !== '' &&
              added.some((account) => account.address.trim().toLowerCase() === mine)
            ) {
              patch({ showMail: true });
            }
            onGmailAccountsChange(next);
          }}
          onNotify={onNotify}
          onCacheMessages={onCacheMail}
        />
      </>
    ),

    notes: (
      <div className="field">
        <div className="field__label" id="notes-label">
          Notes
        </div>
        <RichNotes
          resetKey={item?.id ?? 'new'}
          html={draft.notesHtml}
          text={draft.notes ?? ''}
          placeholder="Recovery codes, security questions, anything else"
          labelledBy="notes-label"
          onChange={({ html, text }) => patch({ notesHtml: html, notes: text })}
          onFiles={(files) => {
            if (!attachmentsShared) void collectNoteFiles(files);
          }}
          readOnly={notesShared}
        />
        <div className="notes-tools">
          {!attachmentsShared ? (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => noteFileInput.current?.click()}
              >
                <UploadIcon width={14} height={14} />
                Attach files
              </button>
              <input
                ref={noteFileInput}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  if (files.length) void collectNoteFiles(files);
                }}
              />
            </>
          ) : null}
          <span className="field__note">
            {attachmentsShared
              ? 'Files in the notes follow the owner’s copy.'
              : `Paste, drop or upload any file — up to ${Math.round(MAX_NOTE_ATTACHMENT_BYTES / 1_000_000)} MB each.`}
          </span>
        </div>
        {mediaAttachments.length ? (
          <div className="notes-media" role="list" aria-label="Pictures and videos in the notes">
            {mediaAttachments.map(({ attachment, index }, position) => (
              <div
                className="notes-media__item"
                key={attachment.id}
                data-video={attachment.mime.startsWith('video/') || undefined}
              >
                <button
                  type="button"
                  className="notes-media__open"
                  onClick={() => setViewingNote(index)}
                  title="View, reorder or download"
                  aria-label={`Open ${attachment.mime.startsWith('video/') ? 'video' : 'image'} ${position + 1} of ${mediaAttachments.length}`}
                >
                  <img className="notes-media__thumb" src={attachment.dataUrl} alt="" loading="lazy" />
                </button>
                {attachment.mime.startsWith('video/') ? <span className="notes-media__play" aria-hidden="true">▶</span> : null}
                {!attachmentsShared ? (
                  <button
                    type="button"
                    className="btn btn--icon notes-media__remove"
                    aria-label={`Remove picture or video ${position + 1} of ${mediaAttachments.length}`}
                    title="Remove from the notes"
                    onClick={() => removeNoteMedia(index)}
                  >
                    <TrashIcon />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {fileAttachments.length ? (
          <div className="notes-files" role="list" aria-label="Files in the notes">
            {fileAttachments.map(({ attachment, index }) => (
              <div className="notes-file" role="listitem" key={attachment.id}>
                <span className="notes-file__icon" aria-hidden="true">
                  <FileIcon />
                </span>
                <span className="notes-file__text">
                  <span className="notes-file__name" title={attachmentFileName(attachment, index)}>
                    {attachmentFileName(attachment, index)}
                  </span>
                  <span className="notes-file__meta">
                    {attachmentSizeLabel(attachment)} · {attachment.mime}
                  </span>
                </span>
                <a
                  className="btn btn--icon"
                  href={attachment.dataUrl}
                  download={attachmentFileName(attachment, index)}
                  title="Download"
                  aria-label={`Download ${attachmentFileName(attachment, index)}`}
                >
                  <DownloadIcon />
                </a>
                {!attachmentsShared ? (
                  <button
                    type="button"
                    className="btn btn--icon"
                    title="Remove from the notes"
                    aria-label={`Remove ${attachmentFileName(attachment, index)}`}
                    onClick={() => removeNoteMedia(index)}
                  >
                    <TrashIcon />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <p className="field__note">
          Formatting is kept when you paste text. Pictures, videos and other files are encrypted with the login and
          never leave the device. History keeps no attachments, so restoring an older version leaves them out.
        </p>
        {/* Full-size viewer with the picture's own actions: download, reorder
            or remove without hunting for the corner chip on the thumbnail. */}
        {viewingNote !== null && viewingPosition >= 0 && draft.attachments?.[viewingNote] ? (
          (() => {
            const attachment = draft.attachments[viewingNote]!;
            const isVideo = attachment.mime.startsWith('video/');
            return (
              <div className="notes-lightbox" role="dialog" aria-label="Notes media" onClick={() => setViewingNote(null)}>
                <button type="button" className="btn btn--icon notes-lightbox__close" aria-label="Close viewer" autoFocus onClick={(event) => { event.stopPropagation(); setViewingNote(null); }}>
                  <XIcon />
                </button>
                <div className="notes-lightbox__stage" onClick={(event) => event.stopPropagation()}>
                  {isVideo ? (
                    <video src={attachment.dataUrl} controls autoPlay muted preload="metadata" />
                  ) : (
                    <img src={attachment.dataUrl} alt="" />
                  )}
                </div>
                <div className="notes-lightbox__bar" onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="btn" disabled={viewingPosition === 0} onClick={() => moveNoteMedia(viewingNote, -1)}>
                    Move earlier
                  </button>
                  <span className="notes-lightbox__count">
                    {viewingPosition + 1} of {mediaAttachments.length}
                  </span>
                  <button type="button" className="btn" disabled={viewingPosition === mediaAttachments.length - 1} onClick={() => moveNoteMedia(viewingNote, 1)}>
                    Move later
                  </button>
                  <a
                    className="btn"
                    href={attachment.dataUrl}
                    download={attachmentFileName(attachment, viewingNote)}
                  >
                    <DownloadIcon width={14} height={14} />
                    Download
                  </a>
                </div>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={(event) => { event.stopPropagation(); removeNoteMedia(viewingNote); }}
                >
                  <TrashIcon />
                  Remove from notes
                </button>
              </div>
            );
          })()
        ) : null}
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
            <p className="editor-window__hint">{activeHint}</p>
          </header>
          <form
            ref={panelRef}
            className="editor-window__panel"
            id={`editor-panel-${section}`}
            role="tabpanel"
            aria-labelledby={`editor-tab-${section}`}
            onSubmit={submit}
          >
            {linked ? (
              <Alert tone="info">
                Shared by {linked.shareName}. The shared fields, including the login’s appearance, follow
                the owner’s latest version. Your tags, flags and dates stay local.
              </Alert>
            ) : null}
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

export const HUE_PRESETS = [
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
