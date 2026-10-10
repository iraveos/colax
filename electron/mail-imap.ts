/**
 * Full message bodies over IMAP, in the main process.
 *
 * The renderer's feed only carries subjects and snippets and cannot open a
 * socket, so bodies are fetched here with the mailbox's own app password and
 * handed back as plain text. Nothing is stored: one connection per request,
 * always logged out, credentials never written anywhere. HTML is stripped to
 * text before it crosses IPC, so a malicious message cannot smuggle markup
 * into the renderer.
 */

import { ImapFlow } from 'imapflow';
import {
  collectInlineImages,
  decodePartBytes,
  gmailDecimalsOf,
  gmailHexOf,
  gmailRawFallback,
  imapUidOf,
  pickHtmlPart,
  pickTextPart,
  stripHtml,
  type MailPartNode,
} from '../src/lib/mail-text.ts';

export interface FullMailInput {
  address: string;
  appPassword: string;
  /** Feed message id (`tag:...,2004:<hex>`); the hex tail addresses the mail. */
  feedId: string;
  /** Subject/sender, for the best-effort fallback when the id misses. */
  subject?: string;
  from?: string;
}

export interface FullMailResult {
  ok: boolean;
  subject?: string;
  from?: string;
  date?: string;
  /** Plain text body, capped. */
  text?: string;
  /** Raw HTML body, when the message carries one. Sanitized in the renderer. */
  html?: string;
  /** Inline images referenced by the HTML, by content id. */
  images?: { cid: string; mime: string; dataUrl: string }[];
  error?: string;
}

export interface InboxListMessage {
  /** IMAP UID within INBOX. */
  uid: number;
  /** Gmail X-GM-MSGID when the server reports it; else the UID addresses it. */
  gmailId: string | null;
  subject: string;
  fromName: string;
  fromAddress: string;
  /** ISO date, possibly empty. */
  date: string;
}

/** Upper bound on inline images per message: mail, not an album. Small enough
    that the transfer back to the renderer stays quick on slow links. */
const MAX_INLINE_IMAGES = 4;
/** Largest single inline image fetched. */
const MAX_IMAGE_BYTES = 524_288;
/** What the UI ever sees of an HTML body. */
const MAX_HTML_CHARS = 300_000;

/** Upper bound on a fetched text part: mail, not attachments. */
const MAX_TEXT_BYTES = 400_000;
/** What the UI ever sees of a body. */
const MAX_TEXT_CHARS = 200_000;

function invalid(message: string): FullMailResult {
  return { ok: false, error: message };
}

/**
 * Recent unread headers over IMAP: the listing behind every message list when
 * the Atom feed refuses (401/403/empty — Google shut Basic-auth feed access
 * down, so the feed is the fallback now, not the source of truth).
 *
 * Headers only, newest first, capped — bodies still load per opened message,
 * exactly like the feed path, so polling stays cheap.
 */
export async function listInboxMail(input: {
  address: unknown;
  appPassword: unknown;
  limit?: unknown;
}): Promise<{ ok: boolean; messages?: InboxListMessage[]; error?: string }> {
  const address = typeof input?.address === 'string' ? input.address.trim().slice(0, 320) : '';
  const appPassword =
    typeof input?.appPassword === 'string' ? input.appPassword.replace(/\s+/g, '').slice(0, 200) : '';
  if (!address || !appPassword) return { ok: false, error: 'Missing mailbox credentials.' };
  const limit =
    typeof input?.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(50, Math.floor(input.limit)))
      : 20;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    logger: false,
    auth: { user: address, pass: appPassword },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });

  const run = (async (): Promise<{ ok: boolean; messages?: InboxListMessage[]; error?: string }> => {
    try {
      await client.connect();
    } catch {
      return { ok: false, error: 'Could not sign in to Gmail. Check the address and the app password.' };
    }
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Everything recent, read or not: users expect their inbox, not just
        // the unread slice the old feed showed.
        const found = await client.search({ all: true }, { uid: true });
        const uids = (Array.isArray(found) ? [...found] : []).sort((a, b) => a - b).slice(-limit);
        if (uids.length === 0) return { ok: true, messages: [] };
        const messages: InboxListMessage[] = [];
        for await (const fetched of client.fetch(uids, { envelope: true }, { uid: true })) {
          if (!fetched.uid) continue;
          const from = fetched.envelope?.from?.[0];
          messages.push({
            uid: fetched.uid,
            // Gmail hands over X-GM-MSGID for free on fetch: with it the row
            // gets a real feed-style id and everything downstream (deep
            // links, id search, cache keys) works untouched.
            gmailId: typeof fetched.emailId === 'string' && /^\d+$/.test(fetched.emailId) ? fetched.emailId : null,
            subject: fetched.envelope?.subject ?? '',
            fromName: from?.name ?? '',
            fromAddress: from?.address ?? '',
            date: fetched.envelope?.date ? new Date(fetched.envelope.date).toISOString() : '',
          });
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { ok: true, messages };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  })();

  const timeout = new Promise<{ ok: boolean; messages?: InboxListMessage[]; error?: string }>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: 'Gmail took too long to answer. Try again.' }), 30000),
  );
  const contained = run.catch(
    (cause): { ok: boolean; messages?: InboxListMessage[]; error?: string } => ({
      ok: false,
      error: `Could not list the inbox (${cause instanceof Error && cause.message ? cause.message : 'unexpected error'}).`,
    }),
  );
  return Promise.race([contained, timeout]);
}

/**
 * Reads one message's envelope, text, HTML and inline images out of an
 * already-open mailbox. Shared by the Gmail-id search and the direct UID
 * path, so both render identically downstream.
 */
/** One-line cause text for error answers — never throws, never leaks a stack. */
function causeText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'unexpected error';
}

async function readOne(client: ImapFlow, box: string, uid: number): Promise<FullMailResult> {
  const lock = await client.getMailboxLock(box);
  try {
    let meta;
    try {
      meta = await client.fetchOne(uid, { bodyStructure: true, envelope: true }, { uid: true });
    } catch (cause) {
      return invalid(`Could not fetch that message (${causeText(cause)}). Open it in Gmail instead.`);
    }
    if (!meta || !meta.bodyStructure) return invalid('Message not found on the server.');
    const structure = meta.bodyStructure as MailPartNode;
    const pick = pickTextPart(structure);
    if (!pick) return invalid('That message has no readable text part.');
    let fetched;
    try {
      fetched = await client.fetchOne(uid, { bodyParts: [pick.part] }, { uid: true });
    } catch (cause) {
      return invalid(`Could not fetch the message body (${causeText(cause)}). Open it in Gmail instead.`);
    }
    const buffer = fetched && fetched.bodyParts?.get(pick.part);
    if (!buffer || buffer.length === 0) return invalid('The text part came back empty.');
    const bytes = buffer.length > MAX_TEXT_BYTES ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer;
    const node = findNode(structure, pick.part);
    const text = decodePartBytes(
      bytes,
      node?.encoding,
      node?.parameters?.charset ?? node?.parameters?.CHARSET,
    );
    const body = (pick.html ? stripHtml(text) : text).slice(0, MAX_TEXT_CHARS);
    // Rich body for Gmail-like rendering downstream, plus the inline images
    // its `cid:` references point at. Plain-text-only mail skips all of this.
    let html: string | undefined;
    const images: { cid: string; mime: string; dataUrl: string }[] = [];
    const htmlPick = pickHtmlPart(structure);
    if (htmlPick) {
      // Never let the rich body sink the plain one: anything failing here
      // drops back to text, which is already decoded above.
      try {
        let raw = htmlPick.part === pick.part ? bytes : undefined;
        if (!raw) {
          const htmlFetched = await client.fetchOne(uid, { bodyParts: [htmlPick.part] }, { uid: true });
          raw = htmlFetched && htmlFetched.bodyParts ? htmlFetched.bodyParts.get(htmlPick.part) : undefined;
        }
        if (raw && raw.length > 0) {
          const hnode = findNode(structure, htmlPick.part);
          html = decodePartBytes(
            raw.length > MAX_TEXT_BYTES ? raw.subarray(0, MAX_TEXT_BYTES) : raw,
            hnode?.encoding,
            hnode?.parameters?.charset ?? hnode?.parameters?.CHARSET,
          ).slice(0, MAX_HTML_CHARS);
        }
      } catch {
        html = undefined;
      }
    }
    if (html) {
      for (const image of collectInlineImages(structure).slice(0, MAX_INLINE_IMAGES)) {
        if (image.size > MAX_IMAGE_BYTES) continue;
        try {
          const got = await client.fetchOne(uid, { bodyParts: [image.part] }, { uid: true });
          const data = got && got.bodyParts ? got.bodyParts.get(image.part) : undefined;
          if (!data || data.length === 0 || data.length > MAX_IMAGE_BYTES) continue;
          images.push({
            cid: image.cid,
            mime: image.mime,
            dataUrl: `data:${image.mime};base64,${Buffer.from(data).toString('base64')}`,
          });
        } catch {
          // One bad image never sinks the message.
        }
      }
    }
    const from = meta.envelope?.from?.[0];
    return {
      ok: true,
      subject: meta.envelope?.subject ?? '',
      from: from ? `${from.name ?? ''}${from.name && from.address ? ' · ' : ''}${from.address ?? ''}` : '',
      date: meta.envelope?.date ? new Date(meta.envelope.date).toLocaleString() : '',
      text: body || '(No readable text in this message.)',
      ...(html ? { html } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
  } finally {
    lock.release();
  }
}

export async function fetchFullMail(input: FullMailInput): Promise<FullMailResult> {
  const address = typeof input?.address === 'string' ? input.address.trim().slice(0, 320) : '';
  const appPassword = typeof input?.appPassword === 'string' ? input.appPassword.replace(/\s+/g, '').slice(0, 200) : '';
  if (!address || !appPassword) return invalid('Missing mailbox credentials.');
  // `imap:<uid>` addresses INBOX directly; anything else goes through the
  // Gmail-id search plus the sender/subject fallback below.
  const directUid = imapUidOf(typeof input?.feedId === 'string' ? input.feedId : null);
  const decimals =
    directUid === null ? gmailDecimalsOf(gmailHexOf(input?.feedId) ?? input?.feedId ?? null) : [];
  if (directUid === null && decimals.length === 0) return invalid('That message has no addressable id.');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    logger: false,
    auth: { user: address, pass: appPassword },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });

  const run = (async (): Promise<FullMailResult> => {
    try {
      await client.connect();
    } catch {
      return invalid('Could not sign in to Gmail. Check the address and the app password.');
    }
    try {
      if (directUid !== null) return readOne(client, 'INBOX', directUid);
      // All Mail covers inbox and archive alike, but its path is
      // locale-dependent — resolve it by special-use flag, not by guessing
      // English. INBOX stays as the fallback.
      const mailboxes = ['INBOX'];
      try {
        const boxes = await client.list();
        const all = boxes.find((box) => (box.specialUse ?? '').toLowerCase().includes('all'));
        if (all?.path && !mailboxes.includes(all.path)) mailboxes.unshift(all.path);
      } catch {
        mailboxes.push('[Gmail]/All Mail');
      }
      let uids: number[] | false = false;
      let box = '';
      const triedBoxes: string[] = [];
      found: for (const candidate of mailboxes) {
        let lock: { release: () => void } | null = null;
        try {
          lock = await client.getMailboxLock(candidate);
        } catch {
          continue;
        }
        triedBoxes.push(candidate);
        try {
          for (const decimal of decimals) {
            const hit = await client.search({ emailId: decimal }, { uid: true });
            if (hit && hit.length > 0) {
              uids = hit;
              box = candidate;
              break found;
            }
          }
          // Id missed: fall back to sender + subject and take the newest.
          // Less exact than the id, but it shows the message instead of an error.
          const raw = gmailRawFallback(
            typeof input?.from === 'string' ? input.from : '',
            typeof input?.subject === 'string' ? input.subject : '',
          );
          if (raw) {
            const fallback = await client.search({ gmraw: raw }, { uid: true });
            if (fallback && fallback.length > 0) {
              uids = [fallback[fallback.length - 1]!];
              box = candidate;
              break found;
            }
          }
        } catch {
          continue;
        } finally {
          lock.release();
        }
      }
      if (!uids || uids.length === 0) {
        const where = triedBoxes.length > 0 ? triedBoxes.join(', ') : 'no mailbox';
        return invalid(
          `Message not found on the server (signed in OK; tried ${decimals.length} id(s) in ${where}).`,
        );
      }
      return readOne(client, box, uids[0]!);
    } finally {
      await client.logout().catch(() => undefined);
    }
  })();

  // Never hang the UI on a dead socket: answer within 45s either way.
  const timeout = new Promise<FullMailResult>((resolve) =>
    setTimeout(() => resolve(invalid('Gmail took too long to answer. Try again.')), 45000),
  );
  // And never reject: a thrown error would surface in the UI as a bare
  // transport failure. Every failure mode answers with a reason instead.
  const contained = run.catch(
    (cause): FullMailResult =>
      invalid(
        `Could not read that message (${cause instanceof Error && cause.message ? cause.message : 'unexpected error'}). Open it in Gmail instead.`,
      ),
  );
  return Promise.race([contained, timeout]);
}

/** Finds one structure node by its part id. */
function findNode(node: MailPartNode | null | undefined, part: string): MailPartNode | null {
  if (!node) return null;
  if (node.part === part) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, part);
    if (found) return found;
  }
  return null;
}
