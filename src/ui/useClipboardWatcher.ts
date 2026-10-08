import { useEffect, useRef, useState } from 'react';

export interface ClipCredentials {
  username: string;
  password: string;
  /** Present when the clipboard text named a website. */
  url?: string;
  /** Present when the clipboard text named the login. */
  title?: string;
  /** Present when the clipboard text carried notes. */
  notes?: string;
}

/**
 * Watches the clipboard for what looks like a copied login and offers to save
 * it. Off by default; the user turns it on in Settings.
 *
 * Detection is deliberately conservative: an email-shaped line followed by a
 * non-trivial second line, or `email: password` on one line. Reading the
 * clipboard can be refused by the browser, which we treat as "nothing to do".
 */
export function useClipboardWatcher({
  enabled,
  unlocked,
  autoSave,
  onAutoSave,
}: {
  enabled: boolean;
  unlocked: boolean;
  autoSave: boolean;
  onAutoSave: (creds: ClipCredentials) => void;
}) {
  const [pending, setPending] = useState<ClipCredentials | null>(null);
  // The clipboard text we have already offered for, so the same copy does not
  // re-prompt until it changes.
  const seen = useRef<string>('');

  useEffect(() => {
    if (!enabled || !unlocked) return;
    let cancelled = false;

    const tick = async () => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return; // Permission denied or document not focused: nothing to offer.
      }
      if (cancelled || !text || text === seen.current) return;
      const creds = detect(text);
      if (!creds) return;
      seen.current = text;
      // Email-only detections never auto-save: a passwordless offer is worth a
      // dialog, not a silent write. With a password, auto-save behaves as before.
      if (autoSave && creds.password) onAutoSave(creds);
      else setPending(creds);
    };

    const id = setInterval(() => void tick(), 2500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, unlocked, autoSave, onAutoSave]);

  return {
    pending,
    dismiss: () => setPending(null),
  };
}

/**
 * Extracts credentials from arbitrary clipboard text.
 *
 * Recognises, in order of confidence:
 *
 *   1. Labelled lines. `email: ...` / `password: ...`, optionally alongside
 *      `title:`, `url:`, `notes:`. This is the format Colax itself writes when
 *      you copy a whole login or hit Share, so copying out of the app and
 *      copying back in now round-trips. The previous version only understood a
 *      bare two-line pair, which meant Colax's own output was not recognised —
 *      copy a login, paste it back, and nothing was offered.
 *   2. A bare two-line pair, either order: an email-shaped line and a
 *      password-shaped one.
 *   3. A single `email: password` line.
 *
 * Labelled parsing is the reason a copy of a *whole login* (title, email, url,
 * notes, password) works, so the url and title are returned too when present:
 * a login restored from the clipboard should not lose its website just because
 * the detector only asked about the password.
 *
 * Deliberately refuses anything that looks like prose, a URL alone, or a long
 * block: creating a login nobody asked for is worse than missing one, and this
 * runs on a timer against whatever happens to be on the clipboard.
 */
export function detect(text: string): ClipCredentials | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return null;

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // A block that uses any recognised label is a *labelled* block, and is judged
  // only by the labelled rules. Falling through to the bare-pair heuristic when
  // the labelled rules decline was the more serious of the two bugs: a login
  // whose notes read "title: GitHub" and "email: me@x.com" was detected as
  // username "email: me@x.com", password "title: GitHub" — the label text itself
  // saved as a credential. Same for a too-short password, which the labelled
  // rules correctly reject and the pair rules then accepted as
  // "password: 123" being the password.
  const hasLabel = lines.some((line) => splitLabelled(line) !== null);
  if (hasLabel) return detectLabelled(lines);

  if (lines.length === 2) {
    const [first, second] = lines as [string, string];
    if (looksLikeLogin(first) && looksLikePassword(second)) {
      return { username: first, password: second };
    }
    if (looksLikePassword(first) && looksLikeLogin(second)) {
      return { username: second, password: first };
    }
  }

  // Single line "email: password" or "email password". The username is matched
  // as an address specifically, so the separator cannot be swallowed into it and
  // saved as "me@x.com:" with the colon attached.
  const match = /^([^\s:]+@[^\s:]+)[\s:]+(\S{6,})$/.exec(trimmed);
  if (match) return { username: match[1]!, password: match[2]! };

  // A lone address with no password at all. Weak signal on purpose: an email
  // alone is worth an offer, never an auto-save (gated in the tick below), so
  // copying an address cannot silently mint logins.
  const bare = /^([^\s:]+@[^\s:]+)$/.exec(trimmed);
  if (bare) return { username: bare[1]!, password: '' };

  return null;
}

/** The labels the app writes, plus the ones people type by hand. */
const LABELS = {
  username: ['email', 'username', 'user', 'login', 'e-mail', 'mail', 'account'],
  password: ['password', 'pass', 'passwd', 'pwd', 'secret'],
  title: ['title', 'name', 'site', 'service'],
  url: ['url', 'website', 'link', 'site url', 'address'],
  notes: ['notes', 'note', 'comment'],
} as const;

type LabelKind = keyof typeof LABELS;

/** Splits `label: value`, tolerating spaces and full-width colons. */
function splitLabelled(line: string): { kind: LabelKind; value: string } | null {
  const m = /^([A-Za-z][A-Za-z -]{0,12})\s*[:：]\s*(.+)$/.exec(line);
  if (!m) return null;
  const label = m[1]!.trim().toLowerCase();
  const value = m[2]!.trim();
  if (!value) return null;
  for (const kind of Object.keys(LABELS) as LabelKind[]) {
    if ((LABELS[kind] as readonly string[]).includes(label)) return { kind, value };
  }
  return null;
}

function detectLabelled(lines: string[]): ClipCredentials | null {
  const found: Partial<Record<LabelKind, string>> = {};
  for (const line of lines) {
    // A labelled line only counts if it is one of the few we know. An
    // unrecognised `something: value` is ignored rather than guessed at, so a
    // block of notes with a colon in it cannot invent a password.
    const parsed = splitLabelled(line);
    if (parsed && found[parsed.kind] === undefined) found[parsed.kind] = parsed.value;
  }

  const username = found.username;
  const password = found.password ?? '';
  // A username alone still counts: an email with no password is half a login,
  // and offering to save the half beats ignoring it. The password half keeps
  // its plausibility check, but an absent password is not implausible — it is
  // just absent. (Auto-save callers must still require a password; see the
  // hook below. Detection and auto-saving have different bars.)
  if (!username) return null;
  if (password && !looksLikePassword(password)) return null;

  const creds: ClipCredentials = { username, password };
  // A bare leading line is the compact share format's title ("GitHub" above
  // the labelled pair). Only the first line, only when it is the only
  // unlabelled one, and only when it is short: two stray lines is prose with a
  // credential block inside it, and the title is a convenience, never the
  // credential, so restraint here costs nothing.
  const bare = lines.filter((line) => splitLabelled(line) === null);
  if (bare.length === 1 && lines[0] === bare[0]) {
    const candidate = bare[0]!.trim();
    if (candidate.length > 0 && candidate.length <= 120) creds.title = candidate;
  }
  // A labelled url is taken as-is; an unlabelled one is not guessed at, because
  // adding a website the user did not copy is a worse mistake than omitting one.
  if (found.url && /^https?:\/\/\S+$/i.test(found.url)) creds.url = found.url;
  else if (found.url && /^\S+\.\S{2,}$/.test(found.url)) creds.url = `https://${found.url}`;
  const title = found.title;
  if (title && title.length <= 120 && !title.includes('\n')) creds.title = title;
  if (found.notes && found.notes.length <= 2000) creds.notes = found.notes;
  return creds;
}

function looksLikeLogin(value: string): boolean {
  return /\S+@\S+\.\S+/.test(value) || (!/\s/.test(value) && value.length >= 3 && value.length <= 64 && !/\s/.test(value));
}

function looksLikePassword(value: string): boolean {
  return value.length >= 6 && value.length <= 128 && !/^https?:\/\//i.test(value) && !value.includes('@');
}
