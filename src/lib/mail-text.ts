/**
 * Plain-text plumbing for full message bodies.
 *
 * Lives in src/lib (not in electron/) so the pure helpers stay unit-testable
 * and renderer-safe: no sockets, no DOM, no Node APIs. The IMAP fetch itself
 * lives in electron/mail-imap.ts and calls back into these.
 */

/** The hex tail of a feed id is the Gmail message id (`tag:...,2004:<hex>`). */
export function gmailHexOf(id: string | undefined | null): string | null {
  if (!id) return null;
  const tail = id.includes(':') ? (id.split(':').pop() ?? '') : id;
  return /^[0-9a-f]+$/i.test(tail) ? tail : null;
}

/**
 * A best-effort Gmail raw query for one message, used when the id search
 * misses. Phrases are quoted and escaped so a subject full of punctuation
 * cannot break the query into something that matches the whole mailbox.
 */
export function gmailRawFallback(from: string | undefined | null, subject: string | undefined | null): string | null {
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const parts: string[] = [];
  const sender = (from ?? '').trim();
  // The sender may be "Name <addr>"; the address halves the matches.
  const address = sender.match(/<([^>]+)>/)?.[1] ?? sender;
  if (address) parts.push(`from:${quote(address)}`);
  if ((subject ?? '').trim()) parts.push(`subject:${quote(subject!.trim().slice(0, 120))}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Decimal form, for IMAP's X-GM-MSGID search. */
export function gmailDecimalOf(hex: string): string | null {
  try {
    return BigInt(`0x${hex}`).toString();
  } catch {
    return null;
  }
}

/**
 * Decimal X-GM-MSGID candidates for a feed id tail, most likely first.
 *
 * Atom feeds carry the decimal id, but a short all-digit tail is also valid
 * hex — and treating a decimal as hex addresses a completely different
 * message (or, usually, nothing at all). So digit tails try decimal first and
 * hex-decoded second; lettered tails only have the hex reading.
 */
export function gmailDecimalsOf(tail: string | null | undefined): string[] {
  if (!tail) return [];
  const out: string[] = [];
  if (/^\d+$/.test(tail)) {
    out.push(tail.replace(/^0+(?=\d)/, ''));
    if (tail.length <= 16) {
      const viaHex = gmailDecimalOf(tail);
      if (viaHex && viaHex !== out[0]) out.push(viaHex);
    }
  } else if (/^[0-9a-f]+$/i.test(tail)) {
    const viaHex = gmailDecimalOf(tail);
    if (viaHex) out.push(viaHex);
  }
  return out;
}

/** Minimal shape of an imapflow bodyStructure node — structural, not imported. */
export interface MailPartNode {
  type?: string;
  part?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  parameters?: Record<string, string>;
  childNodes?: MailPartNode[];
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
  try {
    return new TextDecoder(label, { fatal: false }).decode(raw);
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
      .replace(/&#(\d+);/g, (_, code: string) => {
        const point = Number(code);
        return Number.isFinite(point) ? String.fromCodePoint(point) : '';
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
        const point = parseInt(code, 16);
        return Number.isFinite(point) ? String.fromCodePoint(point) : '';
      })
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
