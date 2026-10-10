/**
 * Plain-text plumbing for full message bodies.
 *
 * Lives in src/lib (not in electron/) so the pure helpers stay unit-testable
 * and renderer-safe: no sockets, no DOM, no Node APIs. The IMAP fetch itself
 * lives in electron/mail-imap.ts and calls back into these.
 */

/**
 * A message listed over IMAP carries `imap:<uid>` instead of a feed id.
 * UIDs address INBOX directly; everything else (deep links, id search) falls
 * back to subject matching for these.
 */
export function imapUidOf(id: string | undefined | null): number | null {
  if (!id) return null;
  const match = /^imap:(\d+)$/.exec(id.trim());
  if (!match) return null;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

/**
 * Whether a failure looks like a dead socket rather than a refusal: the
 * server culling an idle connection, a network blip, a DNS wobble. Those are
 * worth one reconnect + retry; auth errors and missing messages are not.
 */
export function isConnectionError(cause: unknown): boolean {
  const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  const text = `${cause instanceof Error ? cause.message : String(cause ?? '')} ${typeof code === 'string' ? code : ''}`;
  return /connection (not available|closed|lost|ended|reset|refused)|socket (closed|ended|hang up)|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(
    text,
  );
}

/** The hex tail of a feed id is the Gmail message id (`tag:...,2004:<hex>`). */
export function gmailHexOf(id: string | undefined | null): string | null {
  if (!id) return null;
  const tail = id.includes(':') ? (id.split(':').pop() ?? '') : id;
  return /^[0-9a-f]+$/i.test(tail) ? tail : null;
}

/** Minimal shape of an imapflow bodyStructure node — structural, not imported. */
export interface MailPartNode {
  type?: string;
  part?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  /** Content id, for matching `cid:` image references. */
  id?: string;
  parameters?: Record<string, string>;
  childNodes?: MailPartNode[];
}

/** First text/html part that is not an attachment, for rich rendering. */
export function pickHtmlPart(node: MailPartNode | null | undefined): { part: string } | null {
  if (!node) return null;
  const type = (node.type ?? '').toLowerCase();
  const isAttachment = (node.disposition ?? '').toLowerCase() === 'attachment';
  if (!isAttachment && type === 'text/html' && node.part) return { part: node.part };
  for (const child of node.childNodes ?? []) {
    const found = pickHtmlPart(child);
    if (found) return found;
  }
  return null;
}

/** Inline (non-attachment) image parts with content ids, for `cid:` rendering. */
export function collectInlineImages(
  node: MailPartNode | null | undefined,
  out: { part: string; cid: string; mime: string; size: number }[] = [],
): { part: string; cid: string; mime: string; size: number }[] {
  if (!node) return out;
  const type = (node.type ?? '').toLowerCase();
  const isAttachment = (node.disposition ?? '').toLowerCase() === 'attachment';
  if (!isAttachment && type.startsWith('image/') && node.part) {
    const cid = (node.id ?? '').replace(/^<|>$/g, '').trim();
    if (cid) out.push({ part: node.part, cid, mime: type, size: node.size ?? 0 });
  }
  for (const child of node.childNodes ?? []) collectInlineImages(child, out);
  return out;
}

/**
 * Picks the part to read: the first text/plain that is not an attachment,
 * else the first text/html (stripped later). Attachments are never "the body",
 * even when they are text.
 */
export function pickTextPart(node: MailPartNode | null | undefined): { part: string; html: boolean } | null {
  if (!node) return null;
  const type = (node.type ?? '').toLowerCase();
  const isAttachment = (node.disposition ?? '').toLowerCase() === 'attachment';
  if (!isAttachment && type === 'text/plain' && node.part) return { part: node.part, html: false };
  const children = node.childNodes ?? [];
  for (const child of children) {
    const found = pickTextPart(child);
    if (found && !found.html) return found;
  }
  if (!isAttachment && type === 'text/html' && node.part) return { part: node.part, html: true };
  for (const child of children) {
    const found = pickTextPart(child);
    if (found) return found;
  }
  return null;
}

/** Decodes quoted-printable bytes. Small and strict enough for mail bodies. */
export function decodeQuotedPrintable(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const byte = input[i]!;
    if (byte === 0x3d) {
      // Soft break ("=\r\n" / "=\n") melts away; otherwise two hex digits.
      const a = input[i + 1];
      const b = input[i + 2];
      if (a === 0x0d && b === 0x0a) {
        i += 3;
        continue;
      }
      if (a === 0x0a) {
        i += 2;
        continue;
      }
      const hex =
        a !== undefined && b !== undefined ? String.fromCharCode(a, b) : '';
      const code = /^[0-9a-fA-F]{2}$/.test(hex) ? parseInt(hex, 16) : NaN;
      if (Number.isNaN(code)) {
        out.push(byte);
        i += 1;
      } else {
        out.push(code);
        i += 3;
      }
    } else {
      out.push(byte);
      i += 1;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Turns one fetched part into text. Transfer-decoding first (base64,
 * quoted-printable), then charset decoding — Arabic and other non-Latin mail
 * arrives as windows-1256 or iso-8859-6, and reading those bytes as UTF-8
 * mangles every word.
 */
export function decodePartBytes(
  bytes: Uint8Array,
  encoding: string | undefined,
  charset: string | undefined,
): string {
  const normalized = (encoding ?? '7bit').toLowerCase().replace(/[^a-z0-9-]/g, '');
  let raw = bytes;
  if (normalized === 'base64' || normalized === 'base64mime') {
    try {
      const text = new TextDecoder('ascii').decode(bytes).replace(/\s+/g, '');
      const bin = atob(text);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      raw = out;
    } catch {
      raw = bytes;
    }
  } else if (normalized === 'quoted-printable' || normalized === 'quotedprintable') {
    raw = decodeQuotedPrintable(bytes);
  }
  const label = (charset ?? 'utf-8').trim().toLowerCase() || 'utf-8';
  // The constructor itself throws on unknown labels — not just the decode —
  // so even garbage charset names fall back instead of killing the read.
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: false });
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: false });
  }
  try {
    return decoder.decode(raw);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(raw);
  }
}

/** Strips HTML to readable text. Regex-based on purpose: no DOM in main. */
export function stripHtml(html: string): string {
  return (
    html
      // Scripts, styles and comments never reach the reader.
      .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Images carry no readable text: the tag goes whole, alt text included.
      // Otherwise every logo and tracking pixel leaves stray words ("logo",
      // "spacer") scattered through the message.
      .replace(/<img\b[^>]*>/gi, '')
      // Links unwrap to their text — unless the text IS a bare long URL, in
      // which case the link was a tracking or redirect hop and the URL alone
      // reads as garbage. Short links stay; labelled links keep their label.
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, inner: string) => {
        const text = String(inner).replace(/<[^>]+>/g, '').trim();
        if (!text) return '';
        if (/^https?:\/\/\S+$/i.test(text) && text.length > 60) return '';
        return text;
      })
      // Block boundaries become line breaks before the tags go.
      .replace(/<\/(p|div|tr|table|ul|ol|li|h[1-6]|blockquote|br|hr)[^>]*>/gi, '\n')
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      // fromCodePoint throws on out-of-range values, and real-world mail
      // carries garbage entities (`&#99999999;`) — those drop out instead of
      // killing the whole read.
      .replace(/&#(\d+);/g, (_, code: string) => {
        const point = Number(code);
        return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
        const point = parseInt(code, 16);
        return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
      })
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
