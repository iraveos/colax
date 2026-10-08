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
  decodePartBytes,
  gmailDecimalsOf,
  gmailHexOf,
  gmailRawFallback,
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
  error?: string;
}

/** Upper bound on a fetched text part: mail, not attachments. */
const MAX_TEXT_BYTES = 400_000;
/** What the UI ever sees of a body. */
const MAX_TEXT_CHARS = 200_000;

function invalid(message: string): FullMailResult {
  return { ok: false, error: message };
}

export async function fetchFullMail(input: FullMailInput): Promise<FullMailResult> {
  const address = typeof input?.address === 'string' ? input.address.trim().slice(0, 320) : '';
  const appPassword = typeof input?.appPassword === 'string' ? input.appPassword.replace(/\s+/g, '').slice(0, 200) : '';
  if (!address || !appPassword) return invalid('Missing mailbox credentials.');
  const decimals = gmailDecimalsOf(gmailHexOf(input?.feedId) ?? input?.feedId ?? null);
  if (decimals.length === 0) return invalid('That message has no addressable id.');

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
      const lock = await client.getMailboxLock(box);
      try {
        const meta = await client.fetchOne(uids[0]!, { bodyStructure: true, envelope: true }, { uid: true });
        if (!meta || !meta.bodyStructure) return invalid('Could not read that message.');
        const pick = pickTextPart(meta.bodyStructure as MailPartNode);
        if (!pick) return invalid('That message has no readable text part.');
        const fetched = await client.fetchOne(uids[0]!, { bodyParts: [pick.part] }, { uid: true });
        const buffer = fetched && fetched.bodyParts?.get(pick.part);
        if (!buffer || buffer.length === 0) return invalid('The text part came back empty.');
        const bytes = buffer.length > MAX_TEXT_BYTES ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer;
        const node = findNode(meta.bodyStructure as MailPartNode, pick.part);
        const text = decodePartBytes(
          bytes,
          node?.encoding,
          node?.parameters?.charset ?? node?.parameters?.CHARSET,
        );
        const body = (pick.html ? stripHtml(text) : text).slice(0, MAX_TEXT_CHARS);
        const from = meta.envelope?.from?.[0];
        return {
          ok: true,
          subject: meta.envelope?.subject ?? '',
          from: from ? `${from.name ?? ''}${from.name && from.address ? ' · ' : ''}${from.address ?? ''}` : '',
          date: meta.envelope?.date ? new Date(meta.envelope.date).toLocaleString() : '',
          text: body || '(No readable text in this message.)',
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  })();

  // Never hang the UI on a dead socket: answer within 45s either way.
  const timeout = new Promise<FullMailResult>((resolve) =>
    setTimeout(() => resolve(invalid('Gmail took too long to answer. Try again.')), 45000),
  );
  return Promise.race([run, timeout]);
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
