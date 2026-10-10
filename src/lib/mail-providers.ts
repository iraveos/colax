/**
 * Mailbox providers.
 *
 * The vault talks IMAP, which every serious mail host offers, so there is no
 * reason to hardcode one of them. Google was the only host wired in, and that
 * single hardcoded hostname is what made "connect a mailbox" mean "connect a
 * Gmail account" — a Yahoo, Outlook, iCloud or work address simply could not be
 * added.
 *
 * A provider is therefore just connection details plus the copy that tells the
 * user how to obtain an app password there, which is the one step every host
 * makes different and most make confusing. Anything not listed can still be
 * added by hand with the custom entry.
 *
 * Address-based inference (below) means an existing stored account is upgraded
 * on load without the user answering a single new question.
 */

export interface MailProvider {
  id: string;
  label: string;
  /** IMAP hostname. Empty for the custom entry, which asks for one. */
  host: string;
  port: number;
  secure: boolean;
  /** Domains that select this provider automatically. */
  domains: string[];
  /** Where to create an app password, and what to call it there. */
  appPasswordUrl: string;
  /** One line, shown under the credential fields. */
  hint: string;
}

/**
 * The shipped providers, most common first.
 *
 * Every `appPasswordUrl` points at the page that creates an app-specific
 * password rather than a marketing page, because that page is the step people
 * get stuck on: two-factor accounts reject the normal password, and the fix is
 * always "create an app password", which each host buries somewhere different.
 */
export const MAIL_PROVIDERS: MailProvider[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    domains: ['gmail.com', 'googlemail.com'],
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    hint: 'Google Account › Security › 2-Step Verification › App passwords. Needs 2-Step Verification switched on. Your normal password will not work.',
  },
  {
    id: 'outlook',
    label: 'Outlook / Hotmail / Live / Microsoft 365',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.co.uk', 'hotmail.co.uk'],
    appPasswordUrl: 'https://account.microsoft.com/security',
    hint: 'Microsoft Account › Security › Advanced options › App passwords. Microsoft 365 work accounts usually need IMAP enabled by the administrator.',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com'],
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    hint: 'Account Security › Generate app password › Other app. Yahoo requires this for every third-party mail client.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    domains: ['icloud.com', 'me.com', 'mac.com'],
    appPasswordUrl: 'https://appleid.apple.com/account/manage',
    hint: 'Apple Account › Sign-In and Security › App-Specific Passwords. Your Apple ID password will not work here.',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    host: 'imap.fastmail.com',
    port: 993,
    secure: true,
    domains: ['fastmail.com', 'fastmail.fm'],
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apppasswords',
    hint: 'Settings › Privacy & Security › App passwords. Fastmail also accepts an account password when 2FA is off.',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    host: 'imap.zoho.com',
    port: 993,
    secure: true,
    domains: ['zoho.com', 'zohomail.com', 'zoho.eu', 'zoho.in'],
    appPasswordUrl: 'https://accounts.zoho.com/home#security/app_password',
    hint: 'Zoho Account › Security › App Passwords. European accounts use imap.zoho.eu — pick Custom if this one is refused.',
  },
  {
    id: 'yandex',
    label: 'Yandex Mail',
    host: 'imap.yandex.com',
    port: 993,
    secure: true,
    domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
    appPasswordUrl: 'https://id.yandex.com/security/app-passwords',
    hint: 'Yandex ID › Security › App passwords. Yandex asks you to enable IMAP in Mail settings first.',
  },
  {
    id: 'aol',
    label: 'AOL Mail',
    host: 'imap.aol.com',
    port: 993,
    secure: true,
    domains: ['aol.com', 'aol.co.uk'],
    appPasswordUrl: 'https://login.aol.com/account/security',
    hint: 'Account Security › Generate app password. AOL blocks normal passwords from third-party clients.',
  },
  {
    id: 'gmx',
    label: 'GMX / mail.com',
    host: 'imap.gmx.com',
    port: 993,
    secure: true,
    domains: ['gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'email.com'],
    appPasswordUrl: 'https://www.gmx.com/',
    hint: 'GMX › Settings › POP3/IMAP access: enable IMAP first, then use that account password here.',
  },
  {
    id: 'proton',
    label: 'Proton Mail (needs Proton Bridge)',
    host: '127.0.0.1',
    port: 1143,
    secure: false,
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
    appPasswordUrl: 'https://proton.me/mail/bridge',
    hint: 'Proton does not speak IMAP directly. Run Proton Bridge on this machine and use the bridge password it shows — the host is the bridge on localhost, and STARTTLS is off for it.',
  },
  {
    id: 'custom',
    label: 'Custom IMAP server',
    host: '',
    port: 993,
    secure: true,
    domains: [],
    appPasswordUrl: '',
    hint: 'Any IMAP host works: your work mail, a self-hosted server, a university account. Port 993 with TLS is the standard; 143 with STARTTLS is the other common one — for those, turn secure off and set port 143.',
  },
];

export const DEFAULT_PROVIDER_ID = 'gmail';

export function providerById(id: string | undefined): MailProvider {
  return MAIL_PROVIDERS.find((provider) => provider.id === id) ?? MAIL_PROVIDERS[0]!;
}

/** True for the entry that asks the user for a host by hand. */
export function isCustomProvider(id: string | undefined): boolean {
  return (id ?? '') === 'custom';
}

/**
 * The provider an address implies, or null when no domain matches.
 *
 * Domain matching walks the tail rather than testing equality, so
 * `mail.example.co.uk` still matches the `co.uk` host that owns it. Ties go to
 * the longest match, which is what keeps `zoho.eu` from losing to `zoho.com`.
 */
export function providerForAddress(address: string): MailProvider | null {
  const at = address.trim().lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.trim().slice(at + 1).toLowerCase();
  if (!domain) return null;
  let best: MailProvider | null = null;
  let bestLength = 0;
  for (const provider of MAIL_PROVIDERS) {
    for (const candidate of provider.domains) {
      if ((domain === candidate || domain.endsWith(`.${candidate}`)) && candidate.length > bestLength) {
        best = provider;
        bestLength = candidate.length;
      }
    }
  }
  return best;
}

/**
 * The stored connection details for an address, filled in from the provider so
 * callers never have to deal with a half-configured account.
 *
 * An address with a hand-set host always keeps it — someone running a custom
 * server must not have it silently rewritten by the preset that happens to
 * match their domain.
 */
export function resolveConnection(account: {
  provider?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  address: string;
}): { provider: string; label: string; host: string; port: number; secure: boolean } {
  const preset = providerById(account.provider ?? providerForAddress(account.address)?.id);
  const custom = isCustomProvider(preset.id);
  const host = (account.host ?? '').trim() || preset.host;
  return {
    provider: custom ? 'custom' : preset.id,
    label: custom ? host || 'this server' : preset.label,
    host,
    port: typeof account.port === 'number' && Number.isFinite(account.port) ? account.port : preset.port,
    secure: typeof account.secure === 'boolean' ? account.secure : preset.secure,
  };
}

/** Human label for a connected account: the provider, not the brand we shipped first. */
export function accountLabel(account: { provider?: string; host?: string; address: string }): string {
  const address = account.address.trim();
  const preset = providerById(account.provider ?? providerForAddress(address)?.id);
  if (isCustomProvider(preset.id)) return (account.host ?? '').trim() || 'Custom IMAP';
  return preset.label.split(' / ')[0]!;
}
