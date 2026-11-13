/**
 * The email roadmap model.
 *
 * A vault knows three things that never met in one place: the address on each
 * login, the mailboxes connected for reading, and the addresses saved for
 * reuse or created as disposable inboxes. This module folds them into one
 * identity per address, so the screen can answer the question the vault
 * otherwise makes you reconstruct by hand — *which logins live under this
 * address, and what is it connected to?*
 *
 * Pure and framework-free, like the rest of `vault/`: the renderer only reads
 * the shapes below, and the tests can build them without a DOM.
 */

import { isSecured } from '../crypto/security.ts';
import type { CachedMailMessage, GmailAccount } from './storage.ts';
import { hostnameOf, isWeakPassword, type VaultItem } from './types.ts';

/** Why an address exists in the roadmap. An address can have several. */
export type EmailIdentityStatus = 'connected' | 'saved' | 'disposable' | 'vault';

/** Display copy for the four statuses, used by chips and group headings. */
export const EMAIL_IDENTITY_LABELS: Record<EmailIdentityStatus, string> = {
  connected: 'Connected mailbox',
  saved: 'Saved address',
  disposable: 'Disposable inbox',
  vault: 'Vault address',
};

/** One address, with everything the vault knows that points at it. */
export interface EmailIdentity {
  /** Lowercased address; the stable key for selection and expansion. */
  key: string;
  /** The address as first stored, preserving the user's casing. */
  address: string;
  statuses: EmailIdentityStatus[];
  /** The status that decides which group the roadmap row sits in. */
  primary: EmailIdentityStatus;
  /** Connected mailboxes reading this address (normally one). */
  accounts: GmailAccount[];
  /** Every login carrying this address, in title order. */
  logins: VaultItem[];
  /** Logins whose own username is this address. */
  ownLogins: VaultItem[];
  /** Logins whose disposable inbox is this address. */
  tempLogins: VaultItem[];
  /**
   * The login this address "belongs" to: the first one saved that carried it
   * as its own address (or, failing that, the first one that created this
   * disposable inbox).
   *
   * The roadmap otherwise reads as a flat list of logins under an address, and
   * there was no way to tell which of them a mailbox was connected for. The
   * earliest `createdAt` is the one that existed when the address entered the
   * vault, so it is the natural owner — the click target for opening the
   * address's mail.
   */
  mainLogin: VaultItem | null;
  /** The address is in the reusable-emails list. */
  saved: boolean;
  /** Hostnames of the services those logins open. */
  domains: string[];
  /** Tag ids carried by those logins. */
  tagIds: string[];
  /** Newest `updatedAt` among the logins, or 0 when none. */
  lastUpdated: number;
  /** Logins whose password is weak, reused, stale or patterned. */
  weakCount: number;
  /** Logins with a second factor (legacy TOTP or the security block). */
  securedCount: number;
  /** Cached messages read from any connected mailbox for this address. */
  mailCount: number;
  /** The newest cached message, for the hover card and mailbox cards. */
  latestMail: CachedMailMessage | null;
}

export interface EmailRoadmap {
  identities: EmailIdentity[];
  /** Logins that carry no address at all. */
  unlinked: VaultItem[];
  /** How many identities carry each status (an identity can count twice). */
  counts: Record<EmailIdentityStatus, number>;
  /** Unique logins mapped to at least one address. */
  linkedLogins: number;
}

/** Loose email shape: the roadmap must not drop an odd address the vault kept. */
export function isEmailLike(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1 && !/\s/.test(trimmed);
}

const STATUS_ORDER: EmailIdentityStatus[] = ['connected', 'saved', 'disposable', 'vault'];

interface Bucket {
  key: string;
  address: string;
  accounts: Map<string, GmailAccount>;
  own: Map<string, VaultItem>;
  temp: Map<string, VaultItem>;
  saved: boolean;
  mail: Map<string, CachedMailMessage>;
}

/**
 * Builds the roadmap.
 *
 * Everything is deduplicated by address (case-insensitively) and by id, so the
 * same login cannot appear twice under one address, and two stored accounts
 * for the same address collapse into one identity rather than two rows.
 */
export function buildEmailRoadmap(
  items: readonly VaultItem[],
  accounts: readonly GmailAccount[] = [],
  reusableEmails: readonly string[] = [],
  mailCache: Record<string, CachedMailMessage[]> = {},
): EmailRoadmap {
  const buckets = new Map<string, Bucket>();
  const unlinked: VaultItem[] = [];

  const bucketFor = (rawAddress: string | null | undefined): Bucket | null => {
    const address = rawAddress?.trim() ?? '';
    if (!isEmailLike(address)) return null;
    const key = address.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        address,
        accounts: new Map(),
        own: new Map(),
        temp: new Map(),
        saved: false,
        mail: new Map(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const item of items) {
    let linked = false;
    const own = bucketFor(item.username);
    if (own) {
      own.own.set(item.id, item);
      linked = true;
    }
    const temp = bucketFor(item.tempMail?.address);
    if (temp) {
      temp.temp.set(item.id, item);
      linked = true;
    }
    if (!linked) unlinked.push(item);
  }

  for (const account of accounts) {
    const bucket = bucketFor(account.address);
    if (bucket) bucket.accounts.set(account.id, account);
  }

  for (const address of reusableEmails) {
    const bucket = bucketFor(address);
    if (bucket) bucket.saved = true;
  }

  for (const bucket of buckets.values()) {
    for (const account of bucket.accounts.values()) {
      for (const message of mailCache[account.id] ?? []) {
        bucket.mail.set(`${account.id}:${message.id}`, message);
      }
    }
  }

  const identities: EmailIdentity[] = [];
  const linkedIds = new Set<string>();
  const counts: Record<EmailIdentityStatus, number> = {
    connected: 0,
    saved: 0,
    disposable: 0,
    vault: 0,
  };

  for (const bucket of buckets.values()) {
    // One login can be both the owner of an address and the holder of a
    // disposable inbox on it; the map makes that a single stop, not two.
    const byId = new Map<string, VaultItem>();
    for (const item of bucket.own.values()) byId.set(item.id, item);
    for (const item of bucket.temp.values()) byId.set(item.id, item);
    const logins = [...byId.values()].sort(
      (a, b) =>
        (a.title || a.username || hostnameOf(a.url) || '').localeCompare(
          b.title || b.username || hostnameOf(b.url) || '',
        ),
    );

    const statuses: EmailIdentityStatus[] = [];
    if (bucket.accounts.size > 0) statuses.push('connected');
    if (bucket.saved) statuses.push('saved');
    if (bucket.temp.size > 0) statuses.push('disposable');
    if (bucket.own.size > 0) statuses.push('vault');
    if (statuses.length === 0) statuses.push('vault');

    for (const status of statuses) counts[status] += 1;

    // Sets, not `includes` on arrays: a login with many tags used to rescan the
    // whole collected list per tag, and the roadmap rebuilds on every change.
    const domainSet = new Set<string>();
    const tagSet = new Set<string>();
    let lastUpdated = 0;
    let weakCount = 0;
    let securedCount = 0;
    for (const item of logins) {
      linkedIds.add(item.id);
      const host = hostnameOf(item.url);
      if (host) domainSet.add(host.replace(/^www\./i, '').toLowerCase());
      for (const tagId of item.tags) tagSet.add(tagId);
      if (item.updatedAt > lastUpdated) lastUpdated = item.updatedAt;
      if (isWeakPassword(item)) weakCount += 1;
      if (item.totpSecret || isSecured(item.security)) securedCount += 1;
    }
    const domains = [...domainSet];
    const tagIds = [...tagSet];

    // One pass instead of sorting the whole cache: the only question is which
    // message is newest, and a mailbox can hold hundreds of them.
    let latestMail: CachedMailMessage | null = null;
    let latestStamp = Number.NEGATIVE_INFINITY;
    for (const message of bucket.mail.values()) {
      const stamp = Date.parse(message.issued || '');
      if (latestMail === null || stamp > latestStamp) {
        latestMail = message;
        latestStamp = stamp;
      }
    }

    /**
     * The first login saved with this address owns it. Own-address logins win
     * over disposable-inbox holders, because the address in the vault column is
     * what a user means by "the login for this email"; a disposable address
     * only ever has the one login that created it.
     *
     * Ties are broken by id so the result is stable across renders and tests.
     */
    const firstSaved = (candidates: VaultItem[]): VaultItem | null =>
      candidates.length === 0
        ? null
        : [...candidates].sort(
            (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )[0] ?? null;
    const mainLogin = firstSaved([...bucket.own.values()]) ?? firstSaved([...bucket.temp.values()]);
    // The owner leads its own route: the first login saved with the address is
    // the one its mail belongs to, so it reads first and the rest follow as
    // stops. Nothing is dropped; only the order changes.
    const orderedLogins =
      mainLogin === null ? logins : [mainLogin, ...logins.filter((item) => item.id !== mainLogin.id)];

    identities.push({
      key: bucket.key,
      address: bucket.address,
      statuses,
      primary: STATUS_ORDER.find((status) => statuses.includes(status)) ?? 'vault',
      accounts: [...bucket.accounts.values()],
      logins: orderedLogins,
      ownLogins: [...bucket.own.values()],
      tempLogins: [...bucket.temp.values()],
      mainLogin,
      saved: bucket.saved,
      domains,
      tagIds,
      lastUpdated,
      weakCount,
      securedCount,
      mailCount: bucket.mail.size,
      latestMail,
    });
  }

  identities.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.primary) - STATUS_ORDER.indexOf(b.primary) ||
      b.logins.length - a.logins.length ||
      a.address.localeCompare(b.address),
  );
  unlinked.sort(
    (a, b) =>
      (a.title || a.username || hostnameOf(a.url) || '').localeCompare(
        b.title || b.username || hostnameOf(b.url) || '',
      ),
  );

  return {
    identities,
    unlinked,
    counts,
    linkedLogins: linkedIds.size,
  };
}
