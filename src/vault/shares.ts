/**
 * Renderer-side sharing helpers.
 *
 * A share record is public metadata: a salted hash of the short code, the ids
 * of the source logins, its rules and its device/access lists. The logins
 * themselves are never copied into preferences; the server receives a snapshot
 * from the unlocked vault and forgets it on lock or quit.
 */

import {
  DEFAULT_SHARE_FIELDS,
  formatShareCode,
  generateShareCode,
  normaliseShareCode,
  type ShareFields,
  type ShareSnapshot,
  type ShareSyncTarget,
  type SharedAttachment,
  type SharedLink,
  type SharedLogin,
  type VaultShare,
} from '../lib/shares.ts';
import type { VaultAttachment, VaultItem } from './types.ts';

/** PBKDF2 is deliberately slow: a six-digit PIN must not fall to a hash dump. */
export const PBKDF2_PIN_ITERATIONS = 210_000;
const PIN_SALT_BYTES = 16;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newShareId(): string {
  return `share_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function newDeviceId(): string {
  return `dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hashShareCode(code: string): Promise<string> {
  return sha256Hex(normaliseShareCode(code));
}

async function derivePin(pin: string, saltHex: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashPin(
  pin: string,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = new Uint8Array(PIN_SALT_BYTES);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToHex(saltBytes);
  return {
    hash: await derivePin(pin, salt, PBKDF2_PIN_ITERATIONS),
    salt,
    iterations: PBKDF2_PIN_ITERATIONS,
  };
}

/** Used by tests and by any future in-renderer PIN check. */
export async function verifyPinHash(
  pin: string,
  hash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  if (!pin || !hash || !salt || !Number.isFinite(iterations)) return false;
  return (await derivePin(pin, salt, iterations)) === hash;
}

export function normalisePin(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 12);
}

export async function createShareRecord(input: {
  name: string;
  code: string;
  pin: string;
  itemIds: string[];
  tagIds?: string[];
  fields?: Partial<ShareFields>;
  expiresAt?: number | null;
  maxUses?: number | null;
}): Promise<VaultShare> {
  const now = Date.now();
  const pin = normalisePin(input.pin);
  const pinRecord = pin ? await hashPin(pin) : { hash: '', salt: '', iterations: 0 };
  const maxUses =
    input.maxUses === null || input.maxUses === undefined
      ? null
      : Math.max(1, Math.round(input.maxUses));
  return {
    id: newShareId(),
    name: input.name.trim().slice(0, 120) || 'Shared logins',
    codeHash: await hashShareCode(input.code),
    createdAt: now,
    updatedAt: now,
    expiresAt:
      input.expiresAt === null || input.expiresAt === undefined ? null : Number(input.expiresAt),
    maxUses,
    uses: 0,
    revokedAt: null,
    auth: pin ? 'pin' : 'code',
    pinHash: pinRecord.hash,
    pinSalt: pinRecord.salt,
    pinIterations: pinRecord.iterations,
    itemIds: [...new Set(input.itemIds)].slice(0, 500),
    tagIds: [...new Set(input.tagIds ?? [])].slice(0, 100),
    fields: { ...DEFAULT_SHARE_FIELDS, ...input.fields },
    revision: 1,
    devices: [],
    access: [],
  };
}

export function nextShareRevision(share: VaultShare): VaultShare {
  return { ...share, revision: share.revision + 1, updatedAt: Date.now() };
}

export function makeShareCode(): { code: string; display: string } {
  const code = generateShareCode();
  return { code, display: formatShareCode(code) };
}

function sharedAttachments(item: VaultItem): SharedAttachment[] {
  return item.attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name ?? '',
    mime: attachment.mime,
    dataUrl: attachment.dataUrl,
  }));
}

export function sharedLoginFromItem(
  item: VaultItem,
  fields: ShareFields,
): SharedLogin {
  return {
    id: item.id,
    title: item.title,
    username: item.username,
    password: item.password,
    url: item.url,
    notes: fields.notes ? item.notes : '',
    totpSecret: fields.totp ? item.totpSecret : '',
    attachments: fields.attachments ? sharedAttachments(item) : [],
    accentHue: item.accentHue,
    backgroundImage: item.backgroundImage,
    backgroundBlur: item.backgroundBlur,
    avatarImage: item.avatarImage,
    updatedAt: item.updatedAt,
  };
}

/**
 * Builds exactly what the server may hold. Logins that no longer exist simply
 * drop out; the share's next sync tells recipients that they have ended.
 */
export function buildShareSnapshots(shares: VaultShare[], items: VaultItem[]): ShareSnapshot[] {
  return shares.map((share) => {
    const tagIds = new Set(share.tagIds);
    const selected = items.filter(
      (item) =>
        share.itemIds.includes(item.id) ||
        (tagIds.size > 0 && item.tags.some((tagId) => tagIds.has(tagId))),
    );
    const selectedIds = new Set(selected.map((item) => item.id));
    // Keep explicit ids that still exist even if an item has no tags; then the
    // tag members. This is the effective set the server may serve.
    const effectiveIds = [
      ...share.itemIds.filter((id) => selectedIds.has(id)),
      ...selected.map((item) => item.id).filter((id) => !share.itemIds.includes(id)),
    ];
    return {
      share: { ...share, itemIds: effectiveIds },
      items: selected.map((item) => sharedLoginFromItem(item, share.fields)),
    };
  });
}

export function sharedLoginPatch(
  shared: SharedLogin,
  fields: ShareFields = { notes: true, totp: false, attachments: false },
): Partial<VaultItem> {
  const patch: Partial<VaultItem> = {
    title: shared.title,
    username: shared.username,
    password: shared.password,
    url: shared.url,
    accentHue: shared.accentHue ?? null,
    backgroundImage: shared.backgroundImage ?? '',
    backgroundBlur: shared.backgroundBlur ?? 0,
    avatarImage: shared.avatarImage ?? '',
  };
  // A field the owner chose not to expose is not authority over the copy. The
  // recipient may have added their own notes, TOTP seed or attachment, and an
  // owner edit to the password must not erase them.
  if (fields.notes) {
    patch.notes = shared.notes;
    patch.notesHtml = '';
  }
  if (fields.totp) patch.totpSecret = shared.totpSecret;
  if (fields.attachments) {
    patch.attachments = shared.attachments.map(
      (attachment): VaultAttachment => ({
        id: attachment.id,
        name: attachment.name || attachment.mime,
        mime: attachment.mime,
        dataUrl: attachment.dataUrl,
      }),
    );
  }
  return patch;
}

export function makeShareLink(input: {
  shareId: string;
  sourceItemId: string;
  shareName: string;
  ownerUrl: string;
  code: string;
  deviceToken: string;
  revision: number;
  fields: ShareFields;
  sourceUpdatedAt: number;
}): SharedLink {
  return {
    shareId: input.shareId,
    sourceItemId: input.sourceItemId,
    shareName: input.shareName,
    ownerUrl: input.ownerUrl,
    code: normaliseShareCode(input.code),
    deviceToken: input.deviceToken,
    revision: input.revision,
    fields: input.fields,
    sourceUpdatedAt: input.sourceUpdatedAt,
    lastSyncAt: Date.now(),
    endedAt: null,
  };
}

/** One target per share, however many copied logins it owns. */
export function linkedTargets(items: VaultItem[]): ShareSyncTarget[] {
  const targets = new Map<string, ShareSyncTarget>();
  for (const item of items) {
    const link = item.shareLink;
    if (!link || link.endedAt !== null) continue;
    targets.set(link.shareId, {
      shareId: link.shareId,
      ownerUrl: link.ownerUrl,
      code: link.code,
      deviceToken: link.deviceToken,
    });
  }
  return [...targets.values()];
}

export function linkedItems(items: VaultItem[]): VaultItem[] {
  return items.filter((item) => item.shareLink !== null);
}
