/**
 * Mail over IMAP, in the main process.
 *
 * One persistent connection per mailbox, not one handshake per click. The old
 * design opened a fresh connection for every list and every full read, and
 * Gmail culls short-lived and idle connections aggressively — commands issued
 * on a culled socket fail with `NoConnection` ("Connection not available"),
 * which is what made full reads flaky while listings (quick, first on the
 * socket) usually survived. Here each mailbox holds a single client that is
 * connected lazily, reused across lists and reads, and reconnected
 * transparently when it dies. Work runs through `runMail`, which retries once
 * on a reconnected client after a connection error and lets every other
 * failure surface with its own message.
 *
 * Rows address messages by INBOX UID (`imap:<uid>`): the full read locks
 * INBOX and fetches the UID directly. There is no id search, no All-Mail
 * path resolution, no sender/subject fallback — the round-trips that made
 * reads miss. Credentials live only in the clients themselves (memory, for
 * the app's lifetime); nothing is written anywhere.
 */

import { ImapFlow } from 'imapflow';
import {
  collectInlineImages,
  decodePartBytes,
  imapUidOf,
  isConnectionError,
  pickHtmlPart,
  pickTextPart,
  stripHtml,
  type MailPartNode,
} from '../src/lib/mail-text.ts';

export interface FullMailInput {
  address: string;
  appPassword: string;
  /** Message id: `imap:<uid>`, from the inbox listing. */
  feedId: string;
  /** Kept for IPC compatibility; unused — reads address the UID directly. */
  subject?: string;
  /** Kept for IPC compatibility; unused. */
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

/** A connection unused this long is logged out, so the vault does not squat
    on Gmail sessions the user walked away from. */
const MAIL_IDLE_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;

interface ManagedMailbox {
  client: ImapFlow;
  pass: string;
  ready: boolean;
  lastUsed: number;
  connecting: Promise<ImapFlow> | null;
}

const mailboxes = new Map<string, ManagedMailbox>();

function mailboxKey(address: string): string {
  return address.trim().toLowerCase();
}

function makeClient(address: string, pass: string): ImapFlow {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    logger: false,
    auth: { user: address, pass },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
}

type MailEvents = { on(event: string, listener: () => void): void };

function watch(client: ImapFlow, key: string, held: ManagedMailbox): void {
  // imapflow types its client narrowly; events are stable API regardless.
  const events = client as unknown as MailEvents;
  events.on('close', () => {
    if (mailboxes.get(key) === held) held.ready = false;
  });
  // Failures surface through the command promises. Without a listener, a
  // stray 'error' event would crash the process instead.
  events.on('error', () => undefined);
}

async function dropMailbox(key: string): Promise<void> {
  const old = mailboxes.get(key);
  if (!old) return;
  mailboxes.delete(key);
  await old.client.logout().catch(() => undefined);
  try {
    old.client.close();
  } catch {
    // Already gone — logout is what mattered.
  }
}

/** The connected client for a mailbox, connecting (once, shared between
    concurrent callers) when needed. Throws the raw connection error. */
async function ensureConnected(address: string, pass: string, force = false): Promise<ImapFlow> {
  const key = mailboxKey(address);
  const current = mailboxes.get(key);
  if (current && (force || current.pass !== pass)) await dropMailbox(key);
  let managed = mailboxes.get(key);
  if (!managed) {
    const client = makeClient(address, pass);
    managed = { client, pass, ready: false, lastUsed: Date.now(), connecting: null };
    mailboxes.set(key, managed);
    watch(client, key, managed);
  }
  if (managed.ready) {
    managed.lastUsed = Date.now();
    return managed.client;
  }
  if (!managed.connecting) {
    const held = managed;
    managed.connecting = held.client.connect().then(() => held.client);
  }
  try {
    const client = await managed.connecting;
    managed.ready = true;
    managed.lastUsed = Date.now();
    return client;
  } catch (cause) {
    // A failed handshake leaves nothing usable behind for the next caller.
    await dropMailbox(key);
    throw cause;
  }
}

function staged(stage: string, text: string): Error {
  const error = new Error(text);
  (error as { stage?: string }).stage = stage;
  return error;
}

export function stageOf(cause: unknown): string | null {
  if (cause instanceof Error) {
    const stage = (cause as { stage?: unknown }).stage;
    if (typeof stage === 'string') return stage;
  }
  return null;
}

/**
 * Runs IMAP work on a mailbox's persistent connection: connect if needed,
 * then one transparent retry on a reconnected client after a connection
 * error. Non-connection failures propagate untouched, so every failure mode
 * keeps its own message.
 */
async function runMail<T>(address: string, pass: string, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  let client: ImapFlow;
  try {
    client = await ensureConnected(address, pass);
  } catch (cause) {
    throw staged(
      'signin',
      `Could not sign in to Gmail. Check the address and the app password. (${causeText(cause)})`,
    );
  }
  try {
    return await work(client);
  } catch (cause) {
    if (!isConnectionError(cause)) throw cause;
    try {
      client = await ensureConnected(address, pass, true);
    } catch (cause2) {
      throw staged('reconnect', `The connection dropped and would not come back (${causeText(cause2)}).`);
    }
    return work(client);
  }
}

/** Graceful shutdown hook for app quit: log every mailbox out. */
export async function closeMailConnections(): Promise<void> {
  const keys = [...mailboxes.keys()];
  await Promise.all(keys.map((key) => dropMailbox(key)));
}

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, managed] of mailboxes) {
    if (now - managed.lastUsed > MAIL_IDLE_MS) void dropMailbox(key);
  }
}, SWEEP_EVERY_MS);
// The sweep must never hold the app open on its own.
sweepTimer.unref();

function invalid(message: string): FullMailResult {
  return { ok: false, error: message };
}

/** One-line cause text for error answers — never throws, never leaks a stack. */
function causeText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'unexpected error';
}

/**
 * Recent headers from INBOX, newest first, capped — read or not, since users
 * expect their inbox, not an unread slice.
 *
 * Headers only; bodies still load per opened message, so polling stays cheap.
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

  try {
    return await runMail(address, appPassword, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const found = await client.search({ all: true }, { uid: true });
        const uids = (Array.isArray(found) ? [...found] : []).sort((a, b) => a - b).slice(-limit);
        if (uids.length === 0) return { ok: true, messages: [] };
        const messages: InboxListMessage[] = [];
        for await (const fetched of client.fetch(uids, { envelope: true }, { uid: true })) {
          if (!fetched.uid) continue;
          const from = fetched.envelope?.from?.[0];
          messages.push({
            uid: fetched.uid,
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
    });
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error && cause.message ? cause.message : 'The inbox could not be read.',
    };
  }
}

/**
 * One message's envelope, text, HTML and inline images out of INBOX,
 * addressed by UID straight from the listing. No search, no fallback path:
 * the UID the list returned is the UID that is read back.
 */
async function readOne(client: ImapFlow, box: string, uid: number): Promise<FullMailResult> {
  const lock = await client.getMailboxLock(box);
  try {
    const meta = await client
      .fetchOne(uid, { bodyStructure: true, envelope: true }, { uid: true })
      .catch((cause: unknown): never => {
        throw new Error(`Could not fetch that message (${causeText(cause)}). Open it in Gmail instead.`);
      });
    if (!meta || !meta.bodyStructure) throw new Error('Message not found on the server.');
    const structure = meta.bodyStructure as MailPartNode;
    const pick = pickTextPart(structure);
    if (!pick) throw new Error('That message has no readable text part.');
    const fetched = await client
      .fetchOne(uid, { bodyParts: [pick.part] }, { uid: true })
      .catch((cause: unknown): never => {
        throw new Error(`Could not fetch the message body (${causeText(cause)}). Open it in Gmail instead.`);
      });
    const buffer = fetched && fetched.bodyParts?.get(pick.part);
    if (!buffer || buffer.length === 0) throw new Error('The text part came back empty.');
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
    // The rich body never sinks the plain one: anything failing here drops
    // back to text, which is already decoded above.
    let html: string | undefined;
    const images: { cid: string; mime: string; dataUrl: string }[] = [];
    const htmlPick = pickHtmlPart(structure);
    if (htmlPick) {
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
  // Listings address INBOX UIDs directly; anything else is a row saved before
  // the rebuild, which no longer addresses anything.
  const uid = imapUidOf(typeof input?.feedId === 'string' ? input.feedId : null);
  if (uid === null) {
    return invalid('That saved message is from an older version. Refresh the list and open it again.');
  }
  try {
    return await runMail(address, appPassword, (client) => readOne(client, 'INBOX', uid));
  } catch (cause) {
    // Sign-in and reconnect texts arrive final; anything else already carries
    // its own stage message from the read.
    return invalid(
      cause instanceof Error && cause.message ? cause.message : 'Could not read that message. Open it in Gmail instead.',
    );
  }
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
