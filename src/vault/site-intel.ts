/**
 * Turning a raw form submission into something worth saving.
 *
 * The browser side hands over only what a content script can legally read: the
 * page's origin, and whatever was typed into fields it recognised. Everything
 * clever happens here, in the vault, so it stays testable and so the same rules
 * apply to a manually pasted capture.
 *
 * Nothing here touches the network. Site knowledge is a small static table of
 * well-known services, because guessing "this is Google" from a hostname is
 * what turns `mail.google.com` into a tag called `Google` rather than one called
 * `mail.google.com`.
 */

import { hostnameOf } from './types.ts';

/** A login captured from a page. */
export interface Capture {
  /** The page URL at the moment of submission. */
  url: string;
  /** Hostname, pre-parsed by the caller when known. */
  host?: string;
  /** Page title, used only as a fallback for the login's name. */
  pageTitle?: string;
  /** Values from fields the content script believed were an identifier. */
  username?: string;
  password?: string;
  /** A second password field, for the confirm-password pattern. */
  passwordConfirm?: string;
}

/** What we worked out about a capture, before the user decides anything. */
export interface CaptureInsight {
  /** The host, lowercased and stripped of a leading `www.`. */
  host: string;
  /** Best guess at a human-readable site name, e.g. "Google". */
  siteName: string;
  /** The email, when the identifier field held one. */
  email: string | null;
  /** True when the two password fields disagree, which means do not save yet. */
  passwordsMismatch: boolean;
  /** True when the password looks like a placeholder rather than a real one. */
  passwordLooksFake: boolean;
  /** Why this capture is or is not worth offering to save. */
  verdict: CaptureVerdict;
  /** The tags we would apply, existing ids where we could match. */
  suggestedTags: TagSuggestion[];
}

export type CaptureVerdict =
  /** A real account creation or sign-in. Worth offering. */
  | 'save'
  /** Nothing usable came through. */
  | 'empty'
  /** Two password fields that do not match: the user has not finished typing. */
  | 'mismatch'
  /** Every value is an obvious placeholder from the page's own markup. */
  | 'placeholder';

export interface TagSuggestion {
  /** An existing catalogue entry, when one matched. */
  id: string | null;
  /** The name to show and, for a new tag, to create. */
  name: string;
  /** Why we think this belongs. */
  reason: 'site' | 'existing' | 'domain';
  /** 0 to 1. Callers can threshold on this. */
  confidence: number;
}

/* ---- Known sites ---------------------------------------------------------
   Only entries where a *better* name than the hostname is worth having. A long
   table of every site on the internet would rot; this covers the accounts people
   actually create most, and everything else falls back to the domain rule.
   ---------------------------------------------------------------------- */

interface SiteEntry {
  /** Registrable-ish suffix; the match is on any host ending with this. */
  match: string;
  name: string;
  /** What kind of account this is, used as the tag. */
  tag: string;
  /** Some services use a non-email identifier, so the email rule must relax. */
  allowsUsername?: boolean;
}

const KNOWN_SITES: SiteEntry[] = [
  { match: 'google.com', name: 'Google', tag: 'Google', allowsUsername: true },
  // Mail and password accounts share a login, but they are separate products and
  // people file them separately, so both get their own entry. Neither host ends
  // in the other, which is why both must be listed rather than relying on the
  // longest-match rule.
  { match: 'gmail.com', name: 'Gmail', tag: 'Email' },
  { match: 'mail.google.com', name: 'Gmail', tag: 'Email' },
  { match: 'youtube.com', name: 'YouTube', tag: 'Google', allowsUsername: true },
  { match: 'microsoft.com', name: 'Microsoft', tag: 'Microsoft', allowsUsername: true },
  { match: 'outlook.com', name: 'Outlook', tag: 'Email' },
  { match: 'live.com', name: 'Microsoft', tag: 'Microsoft', allowsUsername: true },
  { match: 'appleid.apple.com', name: 'Apple', tag: 'Apple', allowsUsername: true },
  { match: 'icloud.com', name: 'iCloud', tag: 'Apple', allowsUsername: true },
  { match: 'amazon.com', name: 'Amazon', tag: 'Shopping' },
  { match: 'paypal.com', name: 'PayPal', tag: 'Payments' },
  { match: 'github.com', name: 'GitHub', tag: 'Development', allowsUsername: true },
  { match: 'gitlab.com', name: 'GitLab', tag: 'Development', allowsUsername: true },
  { match: 'stackoverflow.com', name: 'Stack Overflow', tag: 'Development', allowsUsername: true },
  { match: 'npmjs.com', name: 'npm', tag: 'Development', allowsUsername: true },
  { match: 'spotify.com', name: 'Spotify', tag: 'Media' },
  { match: 'netflix.com', name: 'Netflix', tag: 'Media' },
  { match: 'disneyplus.com', name: 'Disney+', tag: 'Media' },
  { match: 'twitch.tv', name: 'Twitch', tag: 'Media' },
  { match: 'linkedin.com', name: 'LinkedIn', tag: 'Social' },
  { match: 'facebook.com', name: 'Facebook', tag: 'Social' },
  { match: 'instagram.com', name: 'Instagram', tag: 'Social' },
  { match: 'x.com', name: 'X', tag: 'Social', allowsUsername: true },
  { match: 'twitter.com', name: 'X', tag: 'Social', allowsUsername: true },
  { match: 'reddit.com', name: 'Reddit', tag: 'Social', allowsUsername: true },
  { match: 'discord.com', name: 'Discord', tag: 'Social', allowsUsername: true },
  { match: 'steamcommunity.com', name: 'Steam', tag: 'Games', allowsUsername: true },
  { match: 'epicgames.com', name: 'Epic Games', tag: 'Games', allowsUsername: true },
  { match: 'chase.com', name: 'Chase', tag: 'Finance' },
  { match: 'bankofamerica.com', name: 'Bank of America', tag: 'Finance' },
  { match: 'coinbase.com', name: 'Coinbase', tag: 'Finance' },
  { match: 'binance.com', name: 'Binance', tag: 'Finance' },
  { match: 'ebay.com', name: 'eBay', tag: 'Shopping' },
  { match: 'aliexpress.com', name: 'AliExpress', tag: 'Shopping' },
  { match: 'alibaba.com', name: 'Alibaba', tag: 'Shopping' },
  { match: 'booking.com', name: 'Booking.com', tag: 'Travel' },
  { match: 'airbnb.com', name: 'Airbnb', tag: 'Travel' },
  { match: 'uber.com', name: 'Uber', tag: 'Travel' },
  { match: 'netflix.net', name: 'Netflix', tag: 'Media' },
];

/** Values pages put in `placeholder` or `value` that are not real credentials. */
const PLACEHOLDER_VALUES = new Set([
  '',
  '••••••••',
  '********',
  'password',
  'your password',
  'enter password',
  'confirm password',
  're-enter password',
  'new password',
  'choose a password',
  'type your password',
  'username',
  'your username',
  'email',
  'your email',
  'e-mail',
  'name',
  'search',
  'todo',
  'example',
  'test',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Strips a leading `www.` and lowercases, which is all a tag name cares about. */
export function normaliseHost(host: string | null | undefined): string {
  if (!host) return '';
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * The registrable part of a host.
 *
 * Mirrors the two-label rule in `siteNameFor`, including the common two-word
 * public suffixes, so two hosts that produce the same site name also produce the
 * same registrable part.
 */
export function hostOnlyOf(host: string | null | undefined): string {
  const normalised = normaliseHost(host);
  if (!normalised) return '';
  const twoWord = ['co.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'co.in'].find((suffix) =>
    normalised.endsWith(`.${suffix}`),
  );
  const take = twoWord ? 3 : 2;
  return normalised.split('.').slice(-take).join('.');
}

/** Looks a host up in the known-sites table, matching on any parent domain. */
export function knownSite(host: string | null | undefined): SiteEntry | null {
  const normalised = normaliseHost(host);
  if (!normalised) return null;
  // Longest match wins, so `mail.google.com` prefers the Gmail entry over Google.
  let best: SiteEntry | null = null;
  for (const entry of KNOWN_SITES) {
    if (normalised === entry.match || normalised.endsWith(`.${entry.match}`)) {
      if (!best || entry.match.length > best.match.length) best = entry;
    }
  }
  return best;
}

/**
 * A readable name for a site.
 *
 * Falls back to the registrable part of the domain, so `login.acmecorp.co.uk`
 * becomes "Acmecorp" rather than the whole hostname.
 */
export function siteNameFor(host: string | null | undefined, pageTitle?: string): string {
  const known = knownSite(host);
  if (known) return known.name;

  const normalised = normaliseHost(host);
  if (!normalised) {
    // No host at all: fall back to the page title, cleaned up.
    const title = pageTitle?.trim();
    return title ? title.split(/[|\-–—:·]/)[0]!.trim() || 'Untitled' : 'Untitled';
  }

  const parts = normalised.split('.').filter(Boolean);
  // Two-label public suffixes get one extra label: acmecorp.co.uk, not co.uk.
  const suffix = ['co.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'co.in'].find((s) => normalised.endsWith(`.${s}`));
  const take = suffix ? 3 : 2;
  const label = parts.length > take ? parts[parts.length - take]! : parts[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** True when the value is shaped like an email address. */
export function looksLikeEmail(value: string | null | undefined): boolean {
  return Boolean(value) && EMAIL_PATTERN.test(value!.trim());
}

/**
 * Masks an address for display: the first two letters stay, the rest of the
 * local part becomes dots, the domain stays readable. Copying still copies
 * the full address — this only ever changes what shoulders can surf.
 */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const keep = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${keep}${'•'.repeat(Math.max(1, local.length - keep.length))}@${domain}`;
}

/** True when a message is from the login: same address, or the name carries it. */
export function matchesLogin(
  message: { email: string; author: string },
  username: string,
): boolean {
  const needle = username.trim().toLowerCase();
  if (!needle) return false;
  return (
    message.email.trim().toLowerCase() === needle || message.author.toLowerCase().includes(needle)
  );
}

/**
 * The connected mailbox a login owns, if any: a login whose username IS a
 * mailbox address reads that mailbox, not mail from a sender of the same
 * name. Without this a Gmail login matched only mail it had sent itself —
 * which is why adding a mailbox seemingly showed nothing.
 */
export function mailboxOwnedBy<T extends { address: string }>(
  username: string,
  accounts: T[],
): T | null {
  const needle = username.trim().toLowerCase();
  if (!needle) return null;
  return accounts.find((account) => account.address.trim().toLowerCase() === needle) ?? null;
}

/** The shape of a connected mailbox this decision needs. Kept structural so it
 *  works for stored accounts and for test doubles alike. */
export interface MailboxLike {
  address: string;
  appPassword?: string;
  enabled?: boolean;
}

/** An account that can actually be read: switched on, address and app password present. */
export function mailboxUsable(account: MailboxLike): boolean {
  return (
    account.enabled !== false &&
    account.address.trim() !== '' &&
    (account.appPassword ?? '').replace(/\s+/g, '') !== ''
  );
}

/**
 * Whether one login shows its Messages button — the single rule every view
 * reads, so the three views and the App-level Messages window cannot disagree.
 *
 * The rule is: the button belongs to the login that is *linked* to a connected
 * mailbox — its username is that mailbox's address — plus any login switched on
 * by hand in its editor. Nothing else shows it.
 *
 * This is deliberately the opposite of the build before it, which spread the
 * button across every login. That looked generous and read as wrong: a mailbox
 * connected for one login put a Messages button on every unrelated login, each
 * of which then had to be switched off one by one. The linkage is the scoping,
 * so there is nothing left to switch off.
 *
 * `mailboxOwnedBy` normalises whitespace and case, so "Me@Gmail.com " and
 * "me@gmail.com" are the same login for this purpose — the same comparison the
 * expander uses to decide whose mail it is reading.
 */
export function loginShowsMail(
  item: { username: string; showMail: boolean; mailFilter?: string },
  accounts: MailboxLike[],
  channelAllowsMail = true,
): boolean {
  if (!channelAllowsMail) return false;
  const usable = accounts.filter(mailboxUsable);
  if (usable.length === 0) return false;
  // Linked: shown unless switched off by hand. Not linked: hidden unless
  // switched on by hand. `!== false` rather than `=== true` for the linked case
  // so a record predating the switch (no field at all) still reads as on.
  return mailboxOwnedBy(item.username, usable) !== null ? item.showMail !== false : item.showMail === true;
}

/**
 * One-time pass that puts the Messages button back where it belongs.
 *
 * The previous build switched the button on for every login. This returns the
 * ids of the logins that are *not* linked to a connected mailbox and are still
 * switched on, so the caller can switch exactly those off and stamp the vault.
 * The login the mailbox was connected for is untouched, so the one link the
 * user actually made keeps its mail.
 *
 * Returns ids rather than writing: pure, so it is unit-testable, and the caller
 * owns the writes and the one-time stamp. A login switched back on by hand
 * afterwards stays on, because the stamp stops this from ever running twice.
 */
export function planMailLinkedOnly<TItem extends { id: string; username: string; showMail: boolean }>(
  items: TItem[],
  accounts: MailboxLike[],
): string[] {
  const usable = accounts.filter(mailboxUsable);
  if (usable.length === 0) return [];
  return items
    .filter((item) => item.showMail !== false && mailboxOwnedBy(item.username, usable) === null)
    .map((item) => item.id);
}

/**
 * Pulls every email address out of a pasted block — one per line, comma- or
 * space-separated, or prose with addresses in it.
 *
 * Splits on whitespace, commas and semicolons, strips surrounding wrapping
 * (`<a@b.co>`, `"a@b.co",`), keeps what looks like an address, and dedupes
 * case-insensitively keeping the first-seen casing. Order is the paste order,
 * so the created logins read the way the list did.
 */
export function extractEmails(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const cleaned = raw.trim().replace(/^["'<(\[]+|["'>)\].,;:]+$/g, '').trim();
    if (!cleaned || !looksLikeEmail(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * Whether a captured value is one of the page's own placeholders.
 *
 * Length is ignored on purpose: a one-character password is far more likely to
 * a stray keystroke than a real credential, but the caller decides that by
 * weight, not by rejecting the capture outright.
 */
export function looksLikePlaceholder(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return true;
  const lowered = trimmed.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lowered)) return true;
  // Runs of bullets, asterisks or the same character repeated are masking UI.
  if (/^(.)\1{3,}$/.test(trimmed)) return true;
  // A long run of plain lowercase words with no digits or symbols is nearly
  // always a sentence the page shipped in the DOM, e.g. "forgot your password".
  // Spaces are allowed because that is the usual shape of the real thing.
  return /^[a-z\s]+$/i.test(trimmed) && trimmed.length > 18;
}

/* ---- Tag matching -------------------------------------------------------- */

/** Normalises a tag name for comparison: case, spacing and punctuation. */
function tagKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Finds an existing tag that is close enough to reuse.
 *
 * Substring and prefix matching on purpose: "Email" should be found for
 * "emails", and "work stuff" for "Work". Exact normalised equality wins outright.
 */
export function findSimilarTag(name: string, catalogue: { id: string; name: string }[]): { id: string; name: string } | null {
  const key = tagKey(name);
  if (!key) return null;
  for (const tag of catalogue) {
    if (tagKey(tag.name) === key) return tag;
  }
  let partial: { id: string; name: string } | null = null;
  for (const tag of catalogue) {
    const other = tagKey(tag.name);
    if (!other) continue;
    if (other.startsWith(key) || key.startsWith(other)) {
      // Prefer the closest length, so "mail" does not jump to "email rules".
      if (!partial || Math.abs(other.length - key.length) < Math.abs(tagKey(partial.name).length - key.length)) {
        partial = tag;
      }
    }
  }
  return partial;
}

/**
 * Works out what a capture is and which tags it deserves.
 *
 * The catalogue is passed in so an existing tag is reused rather than duplicated,
 * which is what stops the tag list filling with near-identical names after a
 * burst of signups.
 */
export function inspectCapture(capture: Capture, catalogue: { id: string; name: string }[] = []): CaptureInsight {
  const host = normaliseHost(capture.host ?? hostnameOf(capture.url));
  const siteName = siteNameFor(host, capture.pageTitle);
  const site = knownSite(host);

  const rawUsername = capture.username?.trim() ?? '';
  const email = looksLikeEmail(rawUsername) ? rawUsername : null;
  const password = capture.password ?? '';
  const confirm = capture.passwordConfirm;
  // Only treat it as a mismatch when there was a second field to disagree with.
  const passwordsMismatch = confirm !== undefined && confirm !== '' && confirm !== password;
  const passwordLooksFake = looksLikePlaceholder(password) || looksLikePlaceholder(rawUsername);

  let verdict: CaptureVerdict = 'save';
  if (!password && !rawUsername) verdict = 'empty';
  else if (passwordsMismatch) verdict = 'mismatch';
  else if (passwordLooksFake) verdict = 'placeholder';

  const suggestedTags: TagSuggestion[] = [];

  // The site's own tag first, since it is the strongest signal we have.
  if (site) {
    const existing = findSimilarTag(site.tag, catalogue);
    suggestedTags.push({
      id: existing?.id ?? null,
      name: existing?.name ?? site.tag,
      reason: 'site',
      confidence: 1,
    });
  }

  // An email address is a strong hint the account lives on a mail provider.
  if (email) {
    const provider = emailProvider(email);
    if (provider) {
      const existing = findSimilarTag(provider.tag, catalogue);
      suggestedTags.push({
        id: existing?.id ?? null,
        name: existing?.name ?? provider.tag,
        reason: 'site',
        confidence: 0.9,
      });
    } else {
      // Unknown provider. When the address belongs to the site we are already on
      // its registrable name is the useful tag; otherwise the domain itself is.
      const domain = email.split('@')[1];
      const onSameHost = domain && normaliseHost(domain) === hostOnlyOf(host);
      const fallback = onSameHost ? siteName : domain;
      if (fallback) {
        const existing = findSimilarTag(fallback, catalogue);
        suggestedTags.push({
          id: existing?.id ?? null,
          name: existing?.name ?? fallback,
          reason: 'domain',
          confidence: onSameHost ? 0.6 : 0.55,
        });
      }
    }
  }

  // Anything the site is already grouped under gets carried over.
  const hostOnly = host.split('.').slice(-2).join('.');
  if (!site && hostOnly) {
    const existing = findSimilarTag(hostOnly, catalogue);
    if (existing) {
      suggestedTags.push({ id: existing.id, name: existing.name, reason: 'existing', confidence: 0.7 });
    }
  }

  // De-duplicate on the final name so one tag is never offered twice.
  const seen = new Set<string>();
  const tags = suggestedTags.filter((suggestion) => {
    const key = tagKey(suggestion.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { host, siteName, email, passwordsMismatch, passwordLooksFake, verdict, suggestedTags: tags };
}

/** Common consumer mail providers, so `...@gmail.com` files under Email. */
const EMAIL_PROVIDERS: { domain: string; tag: string }[] = [
  { domain: 'gmail.com', tag: 'Google' },
  { domain: 'googlemail.com', tag: 'Google' },
  { domain: 'outlook.com', tag: 'Microsoft' },
  { domain: 'hotmail.com', tag: 'Microsoft' },
  { domain: 'live.com', tag: 'Microsoft' },
  { domain: 'yahoo.com', tag: 'Email' },
  { domain: 'icloud.com', tag: 'Apple' },
  { domain: 'me.com', tag: 'Apple' },
  { domain: 'proton.me', tag: 'Email' },
  { domain: 'protonmail.com', tag: 'Email' },
  { domain: 'tutanota.com', tag: 'Email' },
  { domain: 'zoho.com', tag: 'Email' },
  { domain: 'aol.com', tag: 'Email' },
];

/** The tag an address's own provider implies, if it is one we know. */
export function emailProvider(email: string): { domain: string; tag: string } | null {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  return EMAIL_PROVIDERS.find((entry) => domain === entry.domain) ?? null;
}

/** A login draft built from an accepted capture. */
export function captureToDraft(capture: Capture, insight: CaptureInsight): {
  title: string;
  username: string;
  password: string;
  url: string;
} {
  const url = insight.host ? `https://${insight.host}` : capture.url;
  return {
    title: insight.siteName,
    username: capture.username?.trim() ?? '',
    password: capture.password ?? '',
    url,
  };
}
/**
 * Tags worth attaching to a freshly saved login, derived from its website and
 * the provider of its email address. Names only; the caller resolves them
 * against the catalogue.
 */
export function suggestTagsForDraft(draft: { url?: string; username?: string }): { name: string; reason: 'site' | 'domain' }[] {
  const suggestions: { name: string; reason: 'site' | 'domain' }[] = [];
  const host = hostnameOf(draft.url ?? '');
  if (host) {
    const site = knownSite(host);
    if (site) suggestions.push({ name: site.tag, reason: 'site' });
  }
  const username = (draft.username ?? '').trim();
  if (looksLikeEmail(username)) {
    const provider = emailProvider(username);
    if (provider && !suggestions.some((entry) => entry.name === provider.tag)) {
      suggestions.push({ name: provider.tag, reason: 'domain' });
    }
  }
  return suggestions;
}
