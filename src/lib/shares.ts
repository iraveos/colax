/**
 * Share types and pure helpers, shared by the renderer and Electron main.
 *
 * Nothing here touches the DOM, Electron or Node, so both sides can import it.
 * The actual crypto lives beside each caller: Web Crypto in the renderer for
 * creating a share, Node's crypto in the server for checking it.
 */

/** Twelve Crockford-style characters: about 60 bits. Hyphens are display only. */
export const SHARE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHARE_CODE_LENGTH = 12;
export const SHARE_CODE_GROUP = 4;
export const MAX_SHARES = 100;
export const MAX_SHARE_DEVICES = 50;
export const MAX_SHARE_ACCESS = 250;
export const DEFAULT_SHARE_PORT = 47821;

export type ShareAuthMode = 'code' | 'pin';
export type ShareServerBind = 'local' | 'lan';
/** Internet exposure is an opt-in tunnel, not a port-forward instruction. */
export type ShareTunnelMode = 'off' | 'cloudflare';
export type ShareTunnelState = 'off' | 'starting' | 'running' | 'error';

/** What a share is allowed to expose. Notes default on; the rest are opt-in. */
export interface ShareFields {
  notes: boolean;
  totp: boolean;
  attachments: boolean;
}

export interface ShareDevice {
  id: string;
  name: string;
  /** SHA-256 hex of the device token. The raw token only exists on the recipient. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  userAgent: string;
  revokedAt: number | null;
}

export type ShareAccessAction = 'redeem' | 'sync' | 'view' | 'open-login';

export interface ShareAccess {
  id: string;
  at: number;
  action: ShareAccessAction;
  deviceId: string;
  deviceName: string;
  ip: string;
  userAgent: string;
  itemId: string;
  itemTitle: string;
}

export interface VaultShare {
  id: string;
  name: string;
  /** SHA-256 hex of the normalised short code. */
  codeHash: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  /** Successful device enrolments. Syncs do not count again. */
  uses: number;
  revokedAt: number | null;
  auth: ShareAuthMode;
  pinHash: string;
  pinSalt: string;
  pinIterations: number;
  /** Explicit source logins, by their local vault id. */
  itemIds: string[];
  /** Every login carrying one of these tags joins the share dynamically. */
  tagIds: string[];
  fields: ShareFields;
  /** Incremented whenever the share's rules or source logins change. */
  revision: number;
  devices: ShareDevice[];
  access: ShareAccess[];
}

export interface ShareServerConfig {
  enabled: boolean;
  port: number;
  bind: ShareServerBind;
  /**
   * `cloudflare` starts a Quick Tunnel from this machine and fills in its
   * ephemeral HTTPS address. `off` keeps sharing on the local network unless
   * a manual public URL is set.
   */
  tunnel: ShareTunnelMode;
  /** Optional manual public URL used in copied links when no tunnel is running. */
  publicUrl: string;
}

export interface SharedAttachment {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
}

/** The only login shape the server ever sees. */
export interface SharedLogin {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totpSecret: string;
  attachments: SharedAttachment[];
  /** Appearance travels with the copy so a shared login still looks like itself. */
  accentHue: number | null;
  backgroundImage: string;
  backgroundBlur: number;
  avatarImage: string;
  updatedAt: number;
}

/** Metadata embedded in an imported login so later syncs can find its source. */
export interface SharedLink {
  shareId: string;
  sourceItemId: string;
  shareName: string;
  ownerUrl: string;
  code: string;
  deviceToken: string;
  revision: number;
  /** Which source fields the owner exposes; local-only fields stay editable. */
  fields: ShareFields;
  /** The source login's updatedAt at the last pull, so content edits propagate even when the share rules did not change. */
  sourceUpdatedAt: number;
  lastSyncAt: number;
  endedAt: number | null;
}

export interface ShareSnapshot {
  share: VaultShare;
  items: SharedLogin[];
}

export interface ShareServerStatus {
  running: boolean;
  port: number;
  host: string;
  /** The owner's machine name, used as the default share/channel label. */
  hostName: string;
  /** Desktop address, or the LAN address when bound to the network. */
  localUrl: string;
  /** Public HTTPS address: tunnel URL when running, else the manual URL. */
  publicUrl: string;
  error: string;
  tunnel: ShareTunnelState;
  tunnelError: string;
}

export interface ShareRedeemInput {
  /** Full link, `code@host`, or just a code. */
  entry: string;
  /** Used with a bare code: `192.168.1.5:47821` or `https://host`. */
  host: string;
  pin: string;
  deviceId: string;
  deviceName: string;
}

export interface ShareRedeemResult {
  ok: boolean;
  error: string;
  shareId: string;
  shareName: string;
  ownerUrl: string;
  code: string;
  deviceToken: string;
  revision: number;
  fields: ShareFields;
  items: SharedLogin[];
}

export interface ShareSyncTarget {
  shareId: string;
  ownerUrl: string;
  code: string;
  deviceToken: string;
}

export interface ShareSyncShareResult {
  shareId: string;
  shareName: string;
  revision: number;
  fields: ShareFields;
  items: SharedLogin[];
  ended: boolean;
  error: string;
}

export interface ShareSyncResult {
  results: ShareSyncShareResult[];
}

export interface ShareServerEvent {
  shareId: string;
  access: ShareAccess;
  device: ShareDevice | null;
  uses: number;
}

export const DEFAULT_SHARE_FIELDS: ShareFields = {
  notes: true,
  totp: false,
  attachments: false,
};

export const DEFAULT_SHARE_SERVER: ShareServerConfig = {
  enabled: false,
  port: DEFAULT_SHARE_PORT,
  bind: 'local',
  tunnel: 'off',
  publicUrl: '',
};

/** Removes display grouping and accepts either case. */
export function normaliseShareCode(value: string): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, SHARE_CODE_LENGTH);
}

export function isShareCode(value: string): boolean {
  const code = normaliseShareCode(value);
  return code.length === SHARE_CODE_LENGTH && [...code].every((char) => SHARE_CODE_ALPHABET.includes(char));
}

export function formatShareCode(value: string): string {
  const code = normaliseShareCode(value);
  return code.replace(new RegExp(`(.{${SHARE_CODE_GROUP}})(?=.)`, 'g'), '$1-');
}

/**
 * Generates a code with rejection sampling, so no character is more likely than
 * another. `crypto` is available in the renderer, in tests, and in Node 20+.
 */
export function generateShareCode(): string {
  const limit = 256 - (256 % SHARE_CODE_ALPHABET.length);
  const bytes = new Uint8Array(SHARE_CODE_LENGTH * 2);
  let code = '';
  while (code.length < SHARE_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += SHARE_CODE_ALPHABET[byte % SHARE_CODE_ALPHABET.length];
      if (code.length === SHARE_CODE_LENGTH) break;
    }
  }
  return code;
}

export function normaliseBaseUrl(value: string): string {
  let text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function shareLinkFor(baseUrl: string, code: string): string {
  const base = normaliseBaseUrl(baseUrl);
  return base ? `${base}/s/${formatShareCode(code)}` : '';
}

/**
 * Reads what a person actually pastes. Accepts:
 *   https://host/s/ABCD-EFGH-JKLM
 *   ABCD-EFGH-JKLM@192.168.1.5:47821
 *   ABCD-EFGH-JKLM
 */
export function parseShareEntry(entry: string, host = ''): { code: string; baseUrl: string } {
  const text = String(entry ?? '').trim();
  if (!text) return { code: '', baseUrl: normaliseBaseUrl(host) };
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const match = url.pathname.match(/\/(?:s|share)\/([^/]+)/i);
      return { code: normaliseShareCode(match?.[1] ?? ''), baseUrl: `${url.protocol}//${url.host}` };
    } catch {
      return { code: '', baseUrl: normaliseBaseUrl(host) };
    }
  }
  const at = text.lastIndexOf('@');
  if (at > 0) {
    return {
      code: normaliseShareCode(text.slice(0, at)),
      baseUrl: normaliseBaseUrl(text.slice(at + 1)),
    };
  }
  return { code: normaliseShareCode(text), baseUrl: normaliseBaseUrl(host) };
}

export function shareIsActive(share: VaultShare, now = Date.now()): boolean {
  if (!share || share.revokedAt !== null) return false;
  if (share.expiresAt !== null && share.expiresAt <= now) return false;
  return share.maxUses === null || share.uses < share.maxUses;
}

export function shareStatus(share: VaultShare, now = Date.now()): 'active' | 'expired' | 'revoked' | 'used' {
  if (share.revokedAt !== null) return 'revoked';
  if (share.expiresAt !== null && share.expiresAt <= now) return 'expired';
  if (share.maxUses !== null && share.uses >= share.maxUses) return 'used';
  return 'active';
}

export function normaliseShareFields(raw: unknown): ShareFields {
  const record = (raw ?? {}) as Partial<ShareFields>;
  return {
    notes: record.notes !== false,
    totp: record.totp === true,
    attachments: record.attachments === true,
  };
}

export function normaliseShareServer(raw: unknown): ShareServerConfig {
  const record = (raw ?? {}) as Partial<ShareServerConfig>;
  const port = Number(record.port);
  return {
    enabled: record.enabled === true,
    port: Number.isFinite(port) && port >= 1024 && port <= 65535 ? Math.round(port) : DEFAULT_SHARE_PORT,
    bind: record.bind === 'lan' ? 'lan' : 'local',
    tunnel: record.tunnel === 'cloudflare' ? 'cloudflare' : 'off',
    publicUrl: normaliseBaseUrl(typeof record.publicUrl === 'string' ? record.publicUrl : ''),
  };
}

function cleanString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function cleanNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normaliseShareDevice(raw: unknown): ShareDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<ShareDevice>;
  const id = cleanString(record.id, 80);
  const tokenHash = cleanString(record.tokenHash, 128);
  if (!id || !tokenHash) return null;
  return {
    id,
    name: cleanString(record.name, 120) || 'Unnamed device',
    tokenHash,
    createdAt: cleanNumber(record.createdAt, Date.now()),
    lastSeenAt: cleanNumber(record.lastSeenAt, Date.now()),
    lastIp: cleanString(record.lastIp, 80),
    userAgent: cleanString(record.userAgent, 300),
    revokedAt: record.revokedAt === null ? null : cleanNumber(record.revokedAt, 0) || null,
  };
}

function normaliseShareAccess(raw: unknown): ShareAccess | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<ShareAccess>;
  const action = record.action;
  if (action !== 'redeem' && action !== 'sync' && action !== 'view' && action !== 'open-login') return null;
  return {
    id: cleanString(record.id, 80) || `sa_${Math.random().toString(36).slice(2, 10)}`,
    at: cleanNumber(record.at, Date.now()),
    action,
    deviceId: cleanString(record.deviceId, 80),
    deviceName: cleanString(record.deviceName, 120),
    ip: cleanString(record.ip, 80),
    userAgent: cleanString(record.userAgent, 300),
    itemId: cleanString(record.itemId, 80),
    itemTitle: cleanString(record.itemTitle, 180),
  };
}

export function normaliseVaultShare(raw: unknown, now = Date.now()): VaultShare | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<VaultShare>;
  const id = cleanString(record.id, 80);
  const codeHash = cleanString(record.codeHash, 128);
  if (!id || !codeHash) return null;
  const itemIds = Array.isArray(record.itemIds)
    ? [...new Set(record.itemIds.filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 500)
    : [];
  const tagIds = Array.isArray(record.tagIds)
    ? [...new Set(record.tagIds.filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 100)
    : [];
  const devices = Array.isArray(record.devices)
    ? record.devices.map(normaliseShareDevice).filter((value): value is ShareDevice => value !== null).slice(0, MAX_SHARE_DEVICES)
    : [];
  const access = Array.isArray(record.access)
    ? record.access.map(normaliseShareAccess).filter((value): value is ShareAccess => value !== null).slice(0, MAX_SHARE_ACCESS)
    : [];
  const maxUses =
    record.maxUses === null || record.maxUses === undefined
      ? null
      : Math.max(1, Math.round(cleanNumber(record.maxUses, 1)));
  return {
    id,
    name: cleanString(record.name, 120) || 'Shared logins',
    codeHash,
    createdAt: cleanNumber(record.createdAt, now),
    updatedAt: cleanNumber(record.updatedAt, now),
    expiresAt: record.expiresAt === null ? null : cleanNumber(record.expiresAt, 0) || null,
    maxUses,
    uses: Math.max(0, Math.round(cleanNumber(record.uses, 0))),
    revokedAt: record.revokedAt === null ? null : cleanNumber(record.revokedAt, 0) || null,
    auth: record.auth === 'pin' ? 'pin' : 'code',
    pinHash: cleanString(record.pinHash, 256),
    pinSalt: cleanString(record.pinSalt, 128),
    pinIterations: Math.max(10_000, Math.round(cleanNumber(record.pinIterations, 210_000))),
    itemIds,
    tagIds,
    fields: normaliseShareFields(record.fields),
    revision: Math.max(1, Math.round(cleanNumber(record.revision, 1))),
    devices,
    access,
  };
}

export function normaliseShares(raw: unknown, now = Date.now()): VaultShare[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normaliseVaultShare(entry, now))
    .filter((entry): entry is VaultShare => entry !== null)
    .slice(0, MAX_SHARES);
}

export function normaliseSharedLink(raw: unknown): SharedLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<SharedLink>;
  const shareId = cleanString(record.shareId, 80);
  const sourceItemId = cleanString(record.sourceItemId, 80);
  const ownerUrl = normaliseBaseUrl(typeof record.ownerUrl === 'string' ? record.ownerUrl : '');
  const code = normaliseShareCode(typeof record.code === 'string' ? record.code : '');
  const deviceToken = cleanString(record.deviceToken, 200);
  if (!shareId || !sourceItemId || !ownerUrl || !isShareCode(code) || !deviceToken) return null;
  return {
    shareId,
    sourceItemId,
    shareName: cleanString(record.shareName, 120) || 'Shared logins',
    ownerUrl,
    code,
    deviceToken,
    revision: Math.max(1, Math.round(cleanNumber(record.revision, 1))),
    fields: normaliseShareFields(record.fields),
    // Older records have no source timestamp; 0 forces one refresh.
    sourceUpdatedAt: cleanNumber(record.sourceUpdatedAt, 0),
    lastSyncAt: cleanNumber(record.lastSyncAt, Date.now()),
    endedAt: record.endedAt === null ? null : cleanNumber(record.endedAt, 0) || null,
  };
}
