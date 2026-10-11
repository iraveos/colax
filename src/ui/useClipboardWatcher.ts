import { useEffect, useRef, useState } from 'react';
import { appActiveNow } from '../lib/activity.ts';

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
 * Clipboard texts the app itself just wrote (Share, bulk share). Copying a
 * login out and offering to save it straight back is how Share minted
 * duplicates — with auto-save it did not even ask first. Call sites mark what
 * they write; the watcher consumes the mark on first sight instead of
 * detecting. Marks expire after 15 seconds, well past the 2.5s poll cadence,
 * so a user re-copying the same text later is still detected normally.
 */
const selfWrites: { text: string; at: number }[] = [];

export function markClipboardSelfWritten(text: string): void {
  selfWrites.push({ text, at: Date.now() });
  if (selfWrites.length > 8) selfWrites.shift();
}

/** True once for marked text: consumes the mark so a later copy counts again. */
export function takeClipboardSelfWrite(text: string): boolean {
  const now = Date.now();
  const index = selfWrites.findIndex((entry) => entry.text === text && now - entry.at < 15_000);
  if (index === -1) return false;
  selfWrites.splice(index, 1);
  return true;
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
      // A window nobody is using needs nothing from the clipboard: skip the
      // read, the parse and any waking of the renderer on its behalf. Focus
      // counts as well as visibility — a vault open behind another app was
      // reading the clipboard every 2.5 seconds for a user who was elsewhere.
      if (document.hidden || !appActiveNow()) return;
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return; // Permission denied or document not focused: nothing to offer.
      }
      if (cancelled || !text || text === seen.current) return;
      // Our own share, coming back around: never offer to save it.
      if (takeClipboardSelfWrite(text)) {
        seen.current = text;
        return;
      }
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

  // Three lines or more, no labels: `name / address / password`. This is how a
  // login gets sent between people by hand, and the line before the address is
  // the name it should be saved under — the user's "the title is main or the
  // words that are before the email". Tried before the two-line pair rules it
  // generalises, and only for three-plus lines so nothing about a plain pair
  // (either order, either shape) changes.
  const bareBlock = detectBareBlock(lines);
  if (bareBlock) return bareBlock;

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

/**
 * A line that reads as a name rather than as a credential.
 *
 * Deliberately loose — "main", "Work Gmail", "the shared one" are all titles —
 * and bounded where it has to be: no address (that is the username line), no
 * `label:` (a labelled line is a different format with its own reader), no URL,
 * and short enough to fit a name.
 */
function looksLikeTitle(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (trimmed.includes('@') || trimmed.includes(':')) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return true;
}

/**
 * A line that names the login rather than being part of the credential.
 *
 * A title must look like a name *and* not be a single-token password: `hunter2`
 * above an address is a password that was written first, while `main` and
 * `Work Gmail` are names. Spaces settle it — a password fragment never has any
 * (the pair readers require single tokens), so a name with a space in it can
 * never be mistaken for one.
 */
function looksLikeName(value: string): boolean {
  if (!looksLikeTitle(value)) return false;
  return /\s/.test(value) || !looksLikePassword(value);
}

/**
 * Reads a bare block: an optional name line, exactly one address, then the
 * password (which may wrap over several lines, and may be absent).
 *
 * Refuses anything with a second address or with prose after the address, so a
 * note pasted under a login does not become its password: a line after the
 * address has to be a single token to count, exactly as the bulk reader
 * requires.
 */
function detectBareBlock(lines: string[]): ClipCredentials | null {
  if (lines.length < 3) return null;
  const addresses = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => /^[^\s:]+@[^\s:]+$/.test(entry.line));
  if (addresses.length !== 1) return null;
  const { line: username, index } = addresses[0]!;
  const before = lines.slice(0, index);
  if (before.length > 1) return null;
  // A name, and not a password that happens to sit above the address: without
  // the second half, the block "hunter2 / me@x.com / pw" titled itself
  // "hunter2" — a wrong title is worse than no match, since the reader leaves
  // the block alone and nothing is created at all.
  const title = before[0]?.trim();
  if (title !== undefined && !looksLikeName(title)) return null;
  const after = lines.slice(index + 1);
  if (after.some((line) => /\s/.test(line) || /^https?:\/\/\S+$/i.test(line))) return null;
  const creds: ClipCredentials = { username, password: after.join('').slice(0, 256) };
  if (title) creds.title = title;
  return creds;
}

function looksLikeLogin(value: string): boolean {
  return /\S+@\S+\.\S+/.test(value) || (!/\s/.test(value) && value.length >= 3 && value.length <= 64 && !/\s/.test(value));
}

function looksLikePassword(value: string): boolean {
  return value.length >= 6 && value.length <= 128 && !/^https?:\/\//i.test(value) && !value.includes('@');
}

/** A line that separates credential blocks in a bulk paste: `-` alone. */
export function isBulkSeparator(line: string): boolean {
  return /^[-–—]+\s*$/.test(line.trim());
}

/** Splits a bulk paste into blocks on separator lines. Empty blocks are dropped. */
export function splitBulkBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (isBulkSeparator(line)) {
      if (current.join('\n').trim()) blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.join('\n').trim()) blocks.push(current.join('\n'));
  return blocks;
}

/**
 * The common top-level domains, longest first. Used to split a glued
 * `addresspassword` token: `me@x.comhunter2` must read as `me@x.com` plus
 * `hunter2`, never as the "address" `me@x.comhunter2`. Anything exotic falls
 * through to the longest-plausible-prefix heuristic below.
 */
const GLUED_TLDS = [
  'museum', 'travel', 'info', 'biz', 'dev', 'app', 'cloud', 'mail', 'email', 'online', 'store',
  'blog', 'tech', 'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'me', 'tv', 'cc',
  'ai', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'ru', 'br', 'in', 'jp', 'cn', 'au', 'ca', 'us',
  'se', 'no', 'dk', 'fi', 'pl', 'cz', 'at', 'ch', 'be', 'ie', 'nz', 'za', 'ae', 'sa', 'eg',
  'tr', 'gr', 'pt', 'hu', 'ro', 'il', 'ua', 'kr', 'tw', 'hk', 'sg', 'my', 'id', 'ph', 'th',
  'vn', 'mx', 'ar', 'cl',
];

/**
 * Splits one glued token — `me@x.comhunter2` — into address and password.
 *
 * Dots are scanned right to left because the TLD lives at the end:
 * `a@b.co.ukEF12` reads as `a@b.co.uk` + `EF12`, never split at an inner
 * label. Within one label the list order decides (`com` before `co`, so
 * `a@gmail.comxxxx` reads as `a@gmail.com` + `xxxx`). The password half must
 * be at least 4 characters: shorter than that, and the "password" is likelier
 * the tail of an exotic domain — in which case this returns null and the token
 * stays an address, never a mangled pair. Exotic-TLD glued pairs therefore
 * come out as email-only logins rather than wrong ones.
 */
export function splitGluedEmail(token: string): { username: string; password: string } | null {
  if (!token || /\s/.test(token) || !token.includes('@') || !token.includes('.')) return null;
  const lower = token.toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0) return null;
  const dots: number[] = [];
  for (let i = at + 1; i < lower.length; i += 1) {
    if (lower[i] === '.') dots.push(i);
  }
  for (let d = dots.length - 1; d >= 0; d -= 1) {
    const run = /^[a-z]+/.exec(lower.slice(dots[d]! + 1))?.[0] ?? '';
    for (const tld of GLUED_TLDS) {
      if (!run.startsWith(tld)) continue;
      const end = dots[d]! + 1 + tld.length;
      const username = token.slice(0, end);
      const password = token.slice(end);
      if (!/^[^@\s]+@[^@\s]+$/.test(username)) continue;
      // A remainder starting with a dot means this TLD matched a mid-domain
      // label (`user@mail.io` hitting `.mail`): keep scanning other TLDs.
      if (password.startsWith('.')) continue;
      if (password.length >= 4) return { username, password };
      // A known TLD with nothing (or almost nothing) behind it is just an
      // address — stop this label rather than inventing a password.
      if (password.length === 0) return null;
      break;
    }
  }
  return null;
}

/**
 * Reads one bulk block — the text between two `-` lines — as a credential.
 *
 * In order: labelled lines (reusing the single-paste rules, so titles and urls
 * survive), an `address password` line, a bare two-line pair in either order, a
 * glued `addresspassword` token, then a wrapped password spread over the lines
 * after the address (line breaks inside a password are removed, so a password
 * that wrapped when copied reassembles). A block with an address but no
 * password half becomes an email-only login; a block with no address at all is
 * junk and returns null.
 */
export function detectBulkBlock(block: string): ClipCredentials | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.some((line) => splitLabelled(line) !== null)) return detectLabelled(lines);

  let username: string | null = null;
  let title: string | null = null;
  const fragments: string[] = [];
  for (const line of lines) {
    const spaced = /^([^\s:]+@[^\s:]+)[\s:]+(\S.*)$/.exec(line);
    if (spaced) {
      username ??= spaced[1]!;
      fragments.push(spaced[2]!);
      continue;
    }
    const glued = splitGluedEmail(line);
    if (glued) {
      username ??= glued.username;
      fragments.push(glued.password);
      continue;
    }
    if (!username && /^[^\s:]+@[^\s:]+$/.test(line)) {
      username = line;
      continue;
    }
    // A short line *before* the address is the login's name — the same rule the
    // single-paste reader applies. Without this it fell through to the password
    // fragments and "main" ended up glued onto the front of the password.
    if (!username && fragments.length === 0 && looksLikeName(line)) {
      title ??= line;
      continue;
    }
    fragments.push(line);
  }
  if (!username) return null;
  // URL-looking fragments are junk, not passwords — same bar as single pastes.
  const password = fragments
    .filter((fragment) => !/^https?:\/\/\S+$/i.test(fragment))
    .join('')
    .slice(0, 256);
  return title ? { username, password, title } : { username, password };
}

/**
 * Reads separator-less lines as alternating `address / password / address /
 * password …`. Every line must be consumed — an address starts a group, and
 * the single-token lines after it join its password — otherwise this is not a
 * pairs paste at all and null sends the caller back to plain address-list
 * mode. A prose line with spaces can never be a password here: one stray
 * sentence must not turn the whole paste into wrong logins.
 */
export function detectBulkLines(text: string): ClipCredentials[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const out: ClipCredentials[] = [];
  let current: { username: string; fragments: string[]; title: string | null } | null = null;
  // A name line waiting for the address it belongs to. Held rather than pushed
  // straight onto the entry being built, because a name arrives *before* the
  // address and there is no entry yet at that point.
  let pendingTitle: string | null = null;
  const flush = () => {
    if (current) {
      const creds: ClipCredentials = {
        username: current.username,
        password: current.fragments.join('').slice(0, 256),
      };
      if (current.title) creds.title = current.title;
      out.push(creds);
      current = null;
    }
  };
  for (const line of lines) {
    if (/^[^\s:]+@[^\s:]+$/.test(line)) {
      flush();
      current = { username: line, fragments: [], title: pendingTitle };
      pendingTitle = null;
      continue;
    }
    const glued = splitGluedEmail(line);
    if (glued) {
      flush();
      current = { username: glued.username, fragments: [glued.password], title: pendingTitle };
      pendingTitle = null;
      continue;
    }
    // A name for the next address — `main` above `me@x.com`. Only possible
    // before an entry has started, so a name can never be read as a password.
    if (!current && looksLikeName(line)) {
      pendingTitle = line;
      continue;
    }
    // A password fragment: one token, no spaces, not a URL, not an address.
    if (!current || /\s/.test(line) || line.length < 1 || line.length > 128 || /^https?:\/\/\S+$/i.test(line)) {
      return null;
    }
    current.fragments.push(line);
  }
  // A trailing name with no address behind it means this was not a pairs paste.
  if (pendingTitle) return null;
  flush();
  // Pairs mode only when at least one password actually showed up — otherwise
  // this is a plain address list wearing no disguise.
  return out.some((entry) => entry.password) ? out : null;
}

/**
 * Reads a whole bulk paste into one credential per entry, in paste order.
 *
 * Two shapes: blocks of `address + password` divided by `-` lines (glued,
 * spaced, two-line, wrapped or labelled), or — with no separator lines —
 * alternating `address / password` lines. Junk blocks are skipped. Returns
 * null for a plain address list (or prose): the caller falls back to one
 * login per address instead of inventing passwords.
 */
export function detectBulk(text: string): ClipCredentials[] | null {
  if (!text || !text.trim()) return null;
  if (text.split(/\r?\n/).some(isBulkSeparator)) {
    const out: ClipCredentials[] = [];
    for (const block of splitBulkBlocks(text)) {
      const creds = detectBulkBlock(block);
      if (creds) out.push(creds);
    }
    return out;
  }
  return detectBulkLines(text);
}
