//! Mailbox providers: connection details and the copy that explains how to get
//! an app password there (Task 9.1).
//!
//! Port of `E:\acc2\src\lib\mail-providers.ts`. The vault talks IMAP, which
//! every serious host offers, so hardcoding one of them would be arbitrary:
//! a provider is just a host, a port, a TLS flag, the domains that select it
//! automatically, and the page that creates the app password -- the one step
//! every host makes different and most make confusing.
//!
//! Address-based inference means a stored account that only has an address is
//! upgraded on load without the user answering a new question.

/// One shipped provider. `host` is empty only for the custom entry, which asks
/// the user for one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MailProvider {
    pub id: &'static str,
    pub label: &'static str,
    pub host: &'static str,
    pub port: u16,
    pub secure: bool,
    /// Domains that select this provider automatically.
    pub domains: &'static [&'static str],
    /// Where to create an app password.
    pub app_password_url: &'static str,
    /// One line, shown under the credential fields.
    pub hint: &'static str,
}

/// The shipped providers, most common first (`MAIL_PROVIDERS`).
///
/// Every `app_password_url` points at the page that creates an app-specific
/// password rather than a marketing page: two-factor accounts reject the
/// normal password, and the fix is always "create an app password", which each
/// host buries somewhere different.
pub const MAIL_PROVIDERS: &[MailProvider] = &[
    MailProvider {
        id: "gmail",
        label: "Gmail / Google Workspace",
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        domains: &["gmail.com", "googlemail.com"],
        app_password_url: "https://myaccount.google.com/apppasswords",
        hint: "Google Account › Security › 2-Step Verification › App passwords. Needs 2-Step Verification switched on. Your normal password will not work.",
    },
    MailProvider {
        id: "outlook",
        label: "Outlook / Hotmail / Live / Microsoft 365",
        host: "outlook.office365.com",
        port: 993,
        secure: true,
        domains: &[
            "outlook.com",
            "hotmail.com",
            "live.com",
            "msn.com",
            "outlook.co.uk",
            "hotmail.co.uk",
        ],
        app_password_url: "https://account.microsoft.com/security",
        hint: "Microsoft Account › Security › Advanced options › App passwords. Microsoft 365 work accounts usually need IMAP enabled by the administrator.",
    },
    MailProvider {
        id: "yahoo",
        label: "Yahoo Mail",
        host: "imap.mail.yahoo.com",
        port: 993,
        secure: true,
        domains: &[
            "yahoo.com",
            "yahoo.co.uk",
            "yahoo.fr",
            "yahoo.de",
            "ymail.com",
            "rocketmail.com",
        ],
        app_password_url: "https://login.yahoo.com/account/security",
        hint: "Account Security › Generate app password › Other app. Yahoo requires this for every third-party mail client.",
    },
    MailProvider {
        id: "icloud",
        label: "iCloud Mail",
        host: "imap.mail.me.com",
        port: 993,
        secure: true,
        domains: &["icloud.com", "me.com", "mac.com"],
        app_password_url: "https://appleid.apple.com/account/manage",
        hint: "Apple Account › Sign-In and Security › App-Specific Passwords. Your Apple ID password will not work here.",
    },
    MailProvider {
        id: "fastmail",
        label: "Fastmail",
        host: "imap.fastmail.com",
        port: 993,
        secure: true,
        domains: &["fastmail.com", "fastmail.fm"],
        app_password_url: "https://app.fastmail.com/settings/security/apppasswords",
        hint: "Settings › Privacy & Security › App passwords. Fastmail also accepts an account password when 2FA is off.",
    },
    MailProvider {
        id: "zoho",
        label: "Zoho Mail",
        host: "imap.zoho.com",
        port: 993,
        secure: true,
        domains: &["zoho.com", "zohomail.com", "zoho.eu", "zoho.in"],
        app_password_url: "https://accounts.zoho.com/home#security/app_password",
        hint: "Zoho Account › Security › App Passwords. European accounts use imap.zoho.eu — pick Custom if this one is refused.",
    },
    MailProvider {
        id: "yandex",
        label: "Yandex Mail",
        host: "imap.yandex.com",
        port: 993,
        secure: true,
        domains: &["yandex.com", "yandex.ru", "ya.ru"],
        app_password_url: "https://id.yandex.com/security/app-passwords",
        hint: "Yandex ID › Security › App passwords. Yandex asks you to enable IMAP in Mail settings first.",
    },
    MailProvider {
        id: "aol",
        label: "AOL Mail",
        host: "imap.aol.com",
        port: 993,
        secure: true,
        domains: &["aol.com", "aol.co.uk"],
        app_password_url: "https://login.aol.com/account/security",
        hint: "Account Security › Generate app password. AOL blocks normal passwords from third-party clients.",
    },
    MailProvider {
        id: "gmx",
        label: "GMX / mail.com",
        host: "imap.gmx.com",
        port: 993,
        secure: true,
        domains: &["gmx.com", "gmx.net", "gmx.de", "mail.com", "email.com"],
        app_password_url: "https://www.gmx.com/",
        hint: "GMX › Settings › POP3/IMAP access: enable IMAP first, then use that account password here.",
    },
    MailProvider {
        id: "proton",
        label: "Proton Mail (needs Proton Bridge)",
        host: "127.0.0.1",
        port: 1143,
        secure: false,
        domains: &["proton.me", "protonmail.com", "pm.me"],
        app_password_url: "https://proton.me/mail/bridge",
        hint: "Proton does not speak IMAP directly. Run Proton Bridge on this machine and use the bridge password it shows — the host is the bridge on localhost, and STARTTLS is off for it.",
    },
    MailProvider {
        id: "custom",
        label: "Custom IMAP server",
        host: "",
        port: 993,
        secure: true,
        domains: &[],
        app_password_url: "",
        hint: "Any IMAP host works: your work mail, a self-hosted server, a university account. Port 993 with TLS is the standard; 143 with STARTTLS is the other common one — for those, turn secure off and set port 143.",
    },
];

pub const DEFAULT_PROVIDER_ID: &str = "gmail";

/// The provider a stored id names, falling back to the default (`providerById`).
pub fn provider_by_id(id: Option<&str>) -> &'static MailProvider {
    id.and_then(|id| MAIL_PROVIDERS.iter().find(|provider| provider.id == id))
        .unwrap_or(&MAIL_PROVIDERS[0])
}

/// True for the entry that asks the user for a host by hand.
pub fn is_custom_provider(id: Option<&str>) -> bool {
    id.unwrap_or("") == "custom"
}

/// The provider an address implies, or `None` when no domain matches.
///
/// Domain matching walks the tail rather than testing equality, so
/// `mail.example.co.uk` still matches the `co.uk` host that owns it. Ties go to
/// the longest match, which keeps `zoho.eu` from losing to `zoho.com`.
pub fn provider_for_address(address: &str) -> Option<&'static MailProvider> {
    let trimmed = address.trim();
    let at = trimmed.rfind('@')?;
    let domain = trimmed[at + 1..].to_lowercase();
    if domain.is_empty() {
        return None;
    }
    let mut best: Option<&'static MailProvider> = None;
    let mut best_length = 0;
    for provider in MAIL_PROVIDERS {
        for candidate in provider.domains {
            let matches = domain == *candidate || domain.ends_with(&format!(".{candidate}"));
            if matches && candidate.len() > best_length {
                best = Some(provider);
                best_length = candidate.len();
            }
        }
    }
    best
}

/// What a stored account asks to be connected as: the fields that can be
/// missing, and the address they are inferred from.
#[derive(Clone, Copy, Debug, Default)]
pub struct AccountRef<'a> {
    pub provider: Option<&'a str>,
    pub host: Option<&'a str>,
    pub port: Option<i64>,
    pub secure: Option<bool>,
    pub address: &'a str,
}

/// The connection details an account really uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connection {
    pub provider: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub secure: bool,
}

/// The stored connection details for an address, filled in from the provider
/// so callers never have to deal with a half-configured account.
///
/// An address with a hand-set host always keeps it — someone running a custom
/// server must not have it silently rewritten by the preset that happens to
/// match their domain.
pub fn resolve_connection(account: &AccountRef<'_>) -> Connection {
    let preset = provider_by_id(account.provider.or_else(|| {
        provider_for_address(account.address).map(|provider| provider.id)
    }));
    let custom = is_custom_provider(Some(preset.id));
    let host = account
        .host
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(preset.host)
        .to_string();
    Connection {
        provider: if custom { "custom" } else { preset.id }.to_string(),
        label: if custom {
            if host.is_empty() {
                "this server".to_string()
            } else {
                host.clone()
            }
        } else {
            preset.label.to_string()
        },
        host,
        // `typeof account.port === 'number' && Number.isFinite(...)`: a port
        // outside u16 is not a port, so it falls back rather than wrapping.
        port: account
            .port
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or(preset.port),
        secure: account.secure.unwrap_or(preset.secure),
    }
}

/// Human label for a connected account: the provider, not the brand we shipped
/// first (`accountLabel`). Custom accounts name their host.
pub fn account_label(account: &AccountRef<'_>) -> String {
    let address = account.address.trim();
    let preset = provider_by_id(
        account
            .provider
            .or_else(|| provider_for_address(address).map(|provider| provider.id)),
    );
    if is_custom_provider(Some(preset.id)) {
        return account
            .host
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .unwrap_or("Custom IMAP")
            .to_string();
    }
    preset
        .label
        .split(" / ")
        .next()
        .unwrap_or(preset.label)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_provider_is_well_formed() {
        assert_eq!(MAIL_PROVIDERS.len(), 11);
        for provider in MAIL_PROVIDERS {
            assert!(!provider.id.is_empty(), "{provider:?}");
            assert!(!provider.label.is_empty(), "{provider:?}");
            assert!(provider.port > 0, "{provider:?}");
            if provider.id != "custom" {
                assert!(!provider.host.is_empty(), "{provider:?}");
                assert!(!provider.domains.is_empty(), "{provider:?}");
            }
        }
        let last = MAIL_PROVIDERS.last().unwrap();
        assert_eq!(last.id, "custom");
        assert!(last.host.is_empty());
        assert!(last.domains.is_empty());
    }

    #[test]
    fn an_address_selects_its_provider() {
        let id = |address: &str| provider_for_address(address).map(|provider| provider.id);
        assert_eq!(id("me@gmail.com"), Some("gmail"));
        assert_eq!(id("me@googlemail.com"), Some("gmail"));
        assert_eq!(id("me@outlook.com"), Some("outlook"));
        assert_eq!(id("me@hotmail.co.uk"), Some("outlook"));
        assert_eq!(id("me@yahoo.fr"), Some("yahoo"));
        assert_eq!(id("me@icloud.com"), Some("icloud"));
        assert_eq!(id("me@fastmail.fm"), Some("fastmail"));
        assert_eq!(id("me@zoho.eu"), Some("zoho"));
        assert_eq!(id("me@zohomail.com"), Some("zoho"));
        assert_eq!(id("me@yandex.ru"), Some("yandex"));
        assert_eq!(id("me@aol.co.uk"), Some("aol"));
        assert_eq!(id("me@mail.com"), Some("gmx"));
        assert_eq!(id("me@pm.me"), Some("proton"));
        assert_eq!(id("me@protonmail.com"), Some("proton"));
        // Case, whitespace and subdomains: the tail decides.
        assert_eq!(id("  ME@GMail.COM  "), Some("gmail"));
        assert_eq!(id("me@mail.icloud.com"), Some("icloud"));
        assert_eq!(id("me@example.com"), None);
        assert_eq!(id("no-at-sign"), None);
        assert_eq!(id("me@"), None);
        assert_eq!(id(""), None);
    }

    #[test]
    fn an_unknown_id_falls_back_to_the_default() {
        assert_eq!(provider_by_id(None).id, DEFAULT_PROVIDER_ID);
        assert_eq!(provider_by_id(Some("nope")).id, "gmail");
        assert_eq!(provider_by_id(Some("proton")).id, "proton");
        assert!(is_custom_provider(Some("custom")));
        assert!(!is_custom_provider(Some("gmail")));
        assert!(!is_custom_provider(None));
    }

    #[test]
    fn connection_details_are_filled_in_from_the_preset() {
        let gmail = resolve_connection(&AccountRef {
            address: "me@gmail.com",
            ..Default::default()
        });
        assert_eq!(gmail.provider, "gmail");
        assert_eq!(gmail.host, "imap.gmail.com");
        assert_eq!(gmail.port, 993);
        assert!(gmail.secure);
        assert_eq!(gmail.label, "Gmail / Google Workspace");

        // An explicit provider wins over the address.
        let forced = resolve_connection(&AccountRef {
            provider: Some("fastmail"),
            address: "me@gmail.com",
            ..Default::default()
        });
        assert_eq!(forced.provider, "fastmail");
        assert_eq!(forced.host, "imap.fastmail.com");

        // Port and TLS can be overridden; 143 is the STARTTLS pair.
        let starttls = resolve_connection(&AccountRef {
            provider: Some("custom"),
            host: Some("mail.example.com"),
            port: Some(143),
            secure: Some(false),
            address: "me@example.com",
        });
        assert_eq!(starttls.provider, "custom");
        assert_eq!(starttls.host, "mail.example.com");
        assert_eq!(starttls.port, 143);
        assert!(!starttls.secure);
        assert_eq!(starttls.label, "mail.example.com");

        // A host set by hand is never rewritten by a matching preset.
        let kept = resolve_connection(&AccountRef {
            host: Some("  imap.internal  "),
            address: "me@gmail.com",
            ..Default::default()
        });
        assert_eq!(kept.host, "imap.internal");
        assert_eq!(kept.provider, "gmail");

        // A custom provider with no host says so rather than an empty label.
        let bare = resolve_connection(&AccountRef {
            provider: Some("custom"),
            address: "me@example.com",
            ..Default::default()
        });
        assert_eq!(bare.label, "this server");
        assert_eq!(bare.host, "");
        assert_eq!(bare.port, 993);
        assert!(bare.secure);
    }

    #[test]
    fn account_labels_name_the_provider_not_the_brand() {
        assert_eq!(
            account_label(&AccountRef {
                address: "me@gmail.com",
                ..Default::default()
            }),
            "Gmail"
        );
        assert_eq!(
            account_label(&AccountRef {
                address: "me@outlook.com",
                ..Default::default()
            }),
            "Outlook"
        );
        assert_eq!(
            account_label(&AccountRef {
                address: "me@zoho.eu",
                ..Default::default()
            }),
            "Zoho Mail"
        );
        // Custom accounts are named by their host, or generically.
        assert_eq!(
            account_label(&AccountRef {
                provider: Some("custom"),
                host: Some(" mail.example.com "),
                address: "me@example.com",
                ..Default::default()
            }),
            "mail.example.com"
        );
        assert_eq!(
            account_label(&AccountRef {
                provider: Some("custom"),
                address: "me@example.com",
                ..Default::default()
            }),
            "Custom IMAP"
        );
    }
}
