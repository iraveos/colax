/**
 * Formats a login as a block of labelled lines for the clipboard.
 *
 * Split out from App because it is the one part of "copy the whole login" with
 * any real behaviour in it, and behaviour is what needs testing. The rules it
 * has to honour:
 *
 *   - Every line is `label: value`, and empty fields are omitted entirely rather
 *     than written as `password:` with nothing after it. Half a login pasted
 *     into a chat window reads as though the password were blank.
 *   - The password is always last. It is the line people paste, and putting it
 *     at the end means a truncated paste loses the least important field.
 *   - A login with no password at all produces no password line, so this cannot
 *     be mistaken for a way to read an empty password.
 *   - The two-factor seed is included when present, because it is part of what
 *     "the whole login" means, but it is labelled explicitly so it is obvious
 *     what was copied.
 *
 * Newlines are "\n" rather than "\r\n" on purpose: this gets pasted into web
 * forms, terminals and chat boxes, and a stray carriage return ends up inside a
 * password field in a way that is very hard to see and very annoying to fix.
 */

export function formatLoginForClipboard(item: {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totpSecret?: string;
}): string {
  const lines: string[] = [];
  const title = item.title.trim();
  if (title) lines.push(`title: ${title}`);
  const username = item.username.trim();
  if (username) lines.push(`email: ${username}`);
  const url = item.url.trim();
  if (url) lines.push(`url: ${url}`);
  const notes = item.notes.trim();
  if (notes) lines.push(`notes: ${notes}`);
  const seed = item.totpSecret?.trim();
  if (seed) lines.push(`authenticator key: ${seed}`);
  if (item.password) lines.push(`password: ${item.password}`);
  return lines.join('\n');
}

/**
 * The short form, for sharing one login with someone who has Colax too.
 *
 * Three lines at most: a bare title, then the labelled credential pair. Short
 * on purpose — this is pasted into a chat window, not archived — but still
 * labelled where it matters, because a bare `user\npass` pair is
 * indistinguishable from any two lines of prose and the detector refuses to
 * guess. The detector reads this back, title included.
 */
export function formatLoginCompact(item: {
  title: string;
  username: string;
  password: string;
  totpSecret?: string;
}): string {
  const lines: string[] = [];
  const title = item.title.trim();
  // Single line only: a multi-line title would read as extra fields.
  if (title) lines.push(title.split('\n')[0]!.trim());
  const username = item.username.trim();
  if (username) lines.push(`email: ${username}`);
  const seed = item.totpSecret?.trim();
  if (seed) lines.push(`authenticator key: ${seed}`);
  if (item.password) lines.push(`password: ${item.password}`);
  return lines.join('\n');
}

/**
 * The same, for several logins at once.
 *
 * Blocks are separated by a blank line and each is headed by its title, so a
 * multi-login paste is readable rather than a wall of `password:` lines with no
 * way to tell which is which. This is what the Share action copies.
 */
export function formatLoginsForClipboard(items: readonly {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totpSecret?: string;
}[]): string {
  return items
    .map((item) => formatLoginForClipboard(item))
    .filter((block) => block.length > 0)
    .join('\n\n');
}
