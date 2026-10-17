//! OAuth2 for mailboxes: presets, the pure URL/token helpers, PKCE, and the
//! loopback listener the browser is redirected back to (Task 9.5).
//!
//! Port of `E:\\acc2\\src\\lib\\oauth.ts` and the shape-only half of
//! `E:\\acc2\\electron\\oauth.ts`. Connecting a mailbox should not require an
//! app password: any provider that speaks OAuth2 can grant a token through the
//! standard authorization-code flow, and the token then authenticates IMAP
//! over SASL XOAUTH2. The flow is provider-agnostic -- only three URLs and a
//! scope differ -- so the presets and the pure helpers live here.
//!
//! What is *not* here: the HTTPS token exchange and the browser launch. Both
//! need a TLS stack and a shell (`ureq` + `webbrowser` in the plan); the
//! listener, the PKCE material and everything that can be tested without a
//! network is here. `MailOAuth`'s tokens are stored in the encrypted vault
//! item, never in `shell.json`.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// How long the browser has to come back with a code. Generous: people read
/// consent screens.
pub const FLOW_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// One prefilled provider in the sign-in form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OAuthPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub scopes: &'static str,
    /// Fixed extra query parameters some providers demand.
    pub extra_params: &'static [(&'static str, &'static str)],
    /// Where the user creates a client id.
    pub console_url: &'static str,
    /// One line under the fields: what to create, and of what type.
    pub hint: &'static str,
}

/// The presets offered in the Inbox section. "Custom" starts blank: the form is
/// the same three URLs and a scope, so any provider that speaks standard OAuth2
/// can be wired up by hand.
pub const OAUTH_PRESETS: &[OAuthPreset] = &[
    OAuthPreset {
        id: "google",
        label: "Google",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        // The full-mail scope: it is the one Google accepts for IMAP XOAUTH2.
        scopes: "https://mail.google.com/",
        // offline+consent is the only combination Google reliably answers with
        // a refresh token for a desktop client.
        extra_params: &[("access_type", "offline"), ("prompt", "consent")],
        console_url: "https://console.cloud.google.com/apis/credentials",
        hint: "In Google Cloud: enable the Gmail API, create an OAuth client ID of type “Desktop app”, and paste its client ID below.",
    },
    OAuthPreset {
        id: "microsoft",
        label: "Microsoft",
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
        // Microsoft's v2 endpoint defaults to form_post for some client types;
        // query keeps the redirect a plain GET the loopback server can answer.
        extra_params: &[("response_mode", "query")],
        console_url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
        hint: "In the Azure portal: register an app, add a desktop redirect URI of http://127.0.0.1 (any port), grant IMAP.AccessAsUser.All, and paste the Application (client) ID.",
    },
    OAuthPreset {
        id: "custom",
        label: "Custom OAuth2",
        auth_url: "",
        token_url: "",
        scopes: "",
        extra_params: &[],
        console_url: "",
        hint: "Paste the provider’s authorize URL, token URL and the IMAP scope. The app adds the standard code flow with PKCE.",
    },
];

/// An unknown id falls back to custom rather than silently becoming Google.
pub fn oauth_preset_by_id(id: &str) -> &'static OAuthPreset {
    OAUTH_PRESETS
        .iter()
        .find(|preset| preset.id == id)
        .unwrap_or(&OAUTH_PRESETS[OAUTH_PRESETS.len() - 1])
}

/// True for an absolute http(s) URL. Loopback OAuth is http; everything else
/// should be https.
pub fn is_http_url(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    // `new URL` needs a scheme and an authority; `javascript:alert(1)` has no
    // `//` at all, and `file:///etc` names a scheme we do not accept.
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return false;
    };
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return false;
    }
    !rest.is_empty() && !rest.starts_with('/')
}

/// One mailbox's OAuth2 configuration and tokens, stored on the account.
///
/// The config fields are the user's own -- pasted from their provider's
/// developer console -- and never change once sign-in works. The token fields
/// are what the sign-in produced; a stale access token is normal and harmless
/// as long as the refresh token survives.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailOAuth {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "clientSecret", default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(rename = "authUrl")]
    pub auth_url: String,
    #[serde(rename = "tokenUrl")]
    pub token_url: String,
    #[serde(default)]
    pub scopes: String,
    /// Fixed extra query parameters some providers demand. Preset-supplied, not
    /// user-edited.
    #[serde(rename = "extraParams", default, skip_serializing_if = "Option::is_none")]
    pub extra_params: Option<BTreeMap<String, String>>,
    #[serde(rename = "accessToken", default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(rename = "refreshToken", default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Epoch ms when `access_token` expires. Absent means "no expiry known".
    #[serde(rename = "expiresAt", default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// Sanitises a stored (or hand-edited) oauth record into the app's shape, or
/// `None` when the config cannot drive a sign-in -- so a corrupt record degrades
/// to "needs reconnecting" instead of poisoning every read.
pub fn normalise_mail_oauth(value: &Value) -> Option<MailOAuth> {
    let record = value.as_object()?;
    let string = |field: &str, max: usize| -> String {
        record
            .get(field)
            .and_then(Value::as_str)
            .map(|value| value.trim().chars().take(max).collect())
            .unwrap_or_default()
    };
    let client_id = string("clientId", 200);
    let auth_url = string("authUrl", 400);
    let token_url = string("tokenUrl", 400);
    if client_id.is_empty() || !is_http_url(Some(&auth_url)) || !is_http_url(Some(&token_url)) {
        return None;
    }
    let mut oauth = MailOAuth {
        client_id,
        auth_url,
        token_url,
        scopes: string("scopes", 400),
        ..Default::default()
    };
    let client_secret = string("clientSecret", 400);
    if !client_secret.is_empty() {
        oauth.client_secret = Some(client_secret);
    }
    let access_token = string("accessToken", 8000);
    if !access_token.is_empty() {
        oauth.access_token = Some(access_token);
    }
    let refresh_token = string("refreshToken", 2000);
    if !refresh_token.is_empty() {
        oauth.refresh_token = Some(refresh_token);
    }
    if let Some(expires_at) = record.get("expiresAt").and_then(Value::as_f64) {
        if expires_at.is_finite() && expires_at > 0.0 {
            oauth.expires_at = Some(expires_at.round() as i64);
        }
    }
    if let Some(Value::Object(extra)) = record.get("extraParams") {
        let mut cleaned = BTreeMap::new();
        for (key, value) in extra {
            let Some(value) = value.as_str() else { continue };
            if key.is_empty() {
                continue;
            }
            cleaned.insert(
                key.trim().chars().take(60).collect::<String>(),
                value.chars().take(300).collect(),
            );
        }
        if !cleaned.is_empty() {
            oauth.extra_params = Some(cleaned);
        }
    }
    Some(oauth)
}

/// A stored record whose config could drive a sign-in (tokens optional).
pub fn oauth_config_usable(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let non_empty = |field: &str| {
        record
            .get(field)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    };
    non_empty("clientId")
        && is_http_url(record.get("authUrl").and_then(Value::as_str))
        && is_http_url(record.get("tokenUrl").and_then(Value::as_str))
}

/// True when a stored record carries any token at all -- enough to attempt a
/// read.
pub fn has_oauth_tokens(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let present = |field: &str| {
        record
            .get(field)
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    };
    present("accessToken") || present("refreshToken")
}

/// The three per-flow values `build_authorize_url` needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizeFlow {
    pub redirect_uri: String,
    pub state: String,
    pub code_challenge: String,
}

/// Builds the browser authorization URL, or `""` when the config cannot
/// produce a safe one.
///
/// PKCE (S256) and a random state ride along on every flow: the state is checked
/// on the way back, and the code verifier never leaves the app, so a stolen
/// authorization code cannot be redeemed without the app itself.
pub fn build_authorize_url(config: &MailOAuth, flow: &AuthorizeFlow) -> String {
    if config.client_id.trim().is_empty()
        || !is_http_url(Some(&config.auth_url))
        || !is_http_url(Some(&flow.redirect_uri))
    {
        return String::new();
    }
    let target = config.auth_url.trim();
    // Keep the fragment out of the way: `searchParams.set` writes into the
    // query, which sits before it.
    let (target, fragment) = match target.split_once('#') {
        Some((head, tail)) => (head, format!("#{tail}")),
        None => (target, String::new()),
    };
    let (path, existing) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    // The provider's own parameters survive the rewrite, and a parameter that
    // was already there keeps its place (`URLSearchParams.set`).
    let mut params: Vec<(String, Option<String>)> = existing
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (key.to_string(), Some(value.to_string())),
            None => (pair.to_string(), None),
        })
        .collect();
    let mut set = |key: &str, value: &str| {
        if let Some(slot) = params
            .iter_mut()
            .find(|(existing, _)| decode_form(existing) == key)
        {
            slot.1 = Some(encode_form(value));
        } else {
            params.push((encode_form(key), Some(encode_form(value))));
        }
    };

    set("client_id", config.client_id.trim());
    set("redirect_uri", &flow.redirect_uri);
    set("response_type", "code");
    set("state", &flow.state);
    set("code_challenge", &flow.code_challenge);
    set("code_challenge_method", "S256");
    if !config.scopes.trim().is_empty() {
        set("scope", config.scopes.trim());
    }
    if let Some(extra) = &config.extra_params {
        for (key, value) in extra {
            if !key.is_empty() {
                set(key, value);
            }
        }
    }

    let query = params
        .into_iter()
        .map(|(key, value)| match value {
            Some(value) => format!("{key}={value}"),
            None => key,
        })
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        format!("{path}{fragment}")
    } else {
        format!("{path}?{query}{fragment}")
    }
}

/// What a token endpoint's JSON answer means to this app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Epoch ms of expiry, when the endpoint said so.
    pub expires_at: Option<i64>,
}

/// Parses a token endpoint's JSON answer, or `None` when it carries no usable
/// access token. Unreadable fields are dropped one by one rather than failing
/// the whole exchange -- a provider that omits expiry still works.
pub fn parse_token_response(json: &Value, now: i64) -> Option<OAuthTokens> {
    let record = json.as_object()?;
    let access_token = record.get("access_token").and_then(Value::as_str)?;
    if access_token.is_empty() {
        return None;
    }
    let mut tokens = OAuthTokens {
        access_token: access_token.to_string(),
        refresh_token: None,
        expires_at: None,
    };
    if let Some(refresh) = record.get("refresh_token").and_then(Value::as_str) {
        if !refresh.is_empty() {
            tokens.refresh_token = Some(refresh.to_string());
        }
    }
    if let Some(expires_in) = record.get("expires_in").and_then(Value::as_f64) {
        if expires_in.is_finite() && expires_in > 0.0 {
            tokens.expires_at = Some(now + (expires_in * 1000.0).round() as i64);
        }
    }
    Some(tokens)
}

/// Whether an access token can still be used as-is.
///
/// The one-minute skew matters: a token that expires mid-handshake fails as a
/// confusing IMAP auth error, so anything expiring within the next minute is
/// treated as already dead and refreshed first.
pub fn access_token_usable(access_token: Option<&str>, expires_at: Option<i64>, now: i64) -> bool {
    if access_token.map(str::is_empty).unwrap_or(true) {
        return false;
    }
    match expires_at {
        None => true,
        Some(expires_at) => now < expires_at - 60_000,
    }
}

/// The SASL XOAUTH2 initial client response, base64-encoded: what a mail
/// client sends for `AUTHENTICATE XOAUTH2`. The token stays inside this
/// module's caller -- nothing here logs or stores it.
pub fn xoauth2_initial_response(user: &str, access_token: &str) -> String {
    let raw = format!("user={user}\x01auth=Bearer {access_token}\x01\x01");
    base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A fresh PKCE code verifier: 32 random bytes, base64url, no padding.
pub fn new_code_verifier() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64url(&bytes)
}

/// A fresh `state`, 16 random bytes: checked on the way back so a redirect that
/// was not opened by this app cannot complete a sign-in.
pub fn new_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64url(&bytes)
}

/// The S256 challenge for a verifier: base64url(SHA-256(verifier)).
pub fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64url(&digest)
}

/// `application/x-www-form-urlencoded` encoding, as `URLSearchParams` writes it:
/// a space becomes `+`, alphanumerics and `*-._` stay, everything else is a
/// percent escape of its UTF-8 bytes.
fn encode_form(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(*byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The reverse: `+` back to a space, percent escapes back to bytes.
fn decode_form(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The loopback server the provider redirects back to.
///
/// Only `127.0.0.1` -- never a wildcard bind, so nothing on the network can see
/// the redirect -- and a random port, so two sign-ins never collide. One
/// request is answered and the listener is dropped.
pub struct Loopback {
    listener: TcpListener,
}

impl Loopback {
    /// Binds a random loopback port.
    pub fn open() -> std::io::Result<Loopback> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        Ok(Loopback { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .map(|address| address.port())
            .unwrap_or(0)
    }

    /// What the app hands the provider as `redirect_uri`.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port())
    }

    /// Waits for the browser to come back with a code (or an error).
    ///
    /// Returns the code; an error the provider described, a redirect that does
    /// not match `expected_state`, or the timeout comes back as `Err` with the
    /// exact message the TS uses.
    pub fn wait_for_code(&self, expected_state: &str, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err("The sign-in was not finished in time. Try again.".to_string());
            }
            match self.listener.accept() {
                Ok((stream, _)) => return self.answer(stream, expected_state),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    fn answer(&self, mut stream: TcpStream, expected_state: &str) -> Result<String, String> {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = [0u8; 8192];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
        // The request line is `GET /?code=..&state=.. HTTP/1.1`.
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/")
            .to_string();
        let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");

        let params: Vec<(String, String)> = query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| match pair.split_once('=') {
                Some((key, value)) => (decode_form(key), decode_form(value)),
                None => (decode_form(pair), String::new()),
            })
            .collect();
        let get = |name: &str| {
            params
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };

        let respond = |stream: &mut TcpStream, status: u16, body: String| {
            let reason = if status == 200 { "OK" } else { "Bad Request" };
            let head = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        };

        if let Some(error) = get("error") {
            respond(
                &mut stream,
                200,
                page("Sign-in refused", "You can close this tab and return to Colax."),
            );
            let description = get("error_description").unwrap_or(error).to_string();
            return Err(description);
        }
        let state = get("state").unwrap_or("");
        let code = get("code").unwrap_or("");
        if state != expected_state || code.is_empty() {
            respond(
                &mut stream,
                400,
                page(
                    "Unexpected redirect",
                    "This tab was not opened by Colax. You can close it.",
                ),
            );
            return Err("The sign-in redirect did not match. Try again.".to_string());
        }
        respond(
            &mut stream,
            200,
            page("Signed in", "Return to Colax — this tab can be closed."),
        );
        Ok(code.to_string())
    }
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><body style=\"font:15px system-ui;margin:3em;max-width:36em\"><h1>{title}</h1><p>{body}</p></body>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn google() -> &'static OAuthPreset {
        OAUTH_PRESETS
            .iter()
            .find(|preset| preset.id == "google")
            .unwrap()
    }

    fn query_of(url: &str) -> BTreeMap<String, String> {
        let query = url
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("");
        query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| match pair.split_once('=') {
                Some((key, value)) => (decode_form(key), decode_form(value)),
                None => (decode_form(pair), String::new()),
            })
            .collect()
    }

    #[test]
    fn the_authorize_url_carries_the_whole_code_flow_pkce_included() {
        let config = MailOAuth {
            client_id: "my-client-id".to_string(),
            auth_url: "https://provider.test/authorize?existing=1".to_string(),
            scopes: "mail.read mail.write".to_string(),
            extra_params: Some(BTreeMap::from([
                ("access_type".to_string(), "offline".to_string()),
                ("prompt".to_string(), "consent".to_string()),
            ])),
            ..Default::default()
        };
        let url = build_authorize_url(
            &config,
            &AuthorizeFlow {
                redirect_uri: "http://127.0.0.1:51234/".to_string(),
                state: "state-123".to_string(),
                code_challenge: "challenge-abc".to_string(),
            },
        );
        assert!(url.starts_with("https://provider.test/authorize?"));
        let query = query_of(&url);
        assert_eq!(query.get("client_id").map(String::as_str), Some("my-client-id"));
        assert_eq!(
            query.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:51234/")
        );
        assert_eq!(query.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(query.get("state").map(String::as_str), Some("state-123"));
        assert_eq!(query.get("code_challenge").map(String::as_str), Some("challenge-abc"));
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(
            query.get("scope").map(String::as_str),
            Some("mail.read mail.write")
        );
        assert_eq!(query.get("access_type").map(String::as_str), Some("offline"));
        assert_eq!(query.get("prompt").map(String::as_str), Some("consent"));
        // A provider's own query parameters survive the rewrite.
        assert_eq!(query.get("existing").map(String::as_str), Some("1"));
        // ...and a space is written the way a form is.
        assert!(url.contains("scope=mail.read+mail.write"), "{url}");
    }

    #[test]
    fn the_authorize_url_refuses_anything_that_is_not_a_real_http_address() {
        let flow = AuthorizeFlow {
            redirect_uri: "http://127.0.0.1:1/".to_string(),
            state: "s".to_string(),
            code_challenge: "c".to_string(),
        };
        let with = |client_id: &str, auth_url: &str, scopes: &str| MailOAuth {
            client_id: client_id.to_string(),
            auth_url: auth_url.to_string(),
            scopes: scopes.to_string(),
            ..Default::default()
        };
        assert_eq!(
            build_authorize_url(&with("x", "javascript:alert(1)", ""), &flow),
            ""
        );
        assert_eq!(build_authorize_url(&with("x", "not a url", ""), &flow), "");
        assert_eq!(
            build_authorize_url(&with("", "https://x.test/a", ""), &flow),
            ""
        );
        assert_eq!(
            build_authorize_url(
                &with("x", "https://x.test/a", ""),
                &AuthorizeFlow {
                    redirect_uri: "file:///etc".to_string(),
                    ..flow
                }
            ),
            ""
        );
    }

    #[test]
    fn a_token_response_is_parsed_field_by_field_junk_tolerated() {
        let now = 1_000_000;
        let full = parse_token_response(
            &json!({
                "access_token": "at",
                "refresh_token": "rt",
                "expires_in": 3600,
                "token_type": "Bearer",
                "scope": "mail",
            }),
            now,
        )
        .unwrap();
        assert_eq!(
            full,
            OAuthTokens {
                access_token: "at".to_string(),
                refresh_token: Some("rt".to_string()),
                expires_at: Some(now + 3_600_000),
            }
        );
        // No expiry is normal for some providers; the token still works.
        assert_eq!(
            parse_token_response(&json!({ "access_token": "at" }), now),
            Some(OAuthTokens {
                access_token: "at".to_string(),
                refresh_token: None,
                expires_at: None,
            })
        );
        assert_eq!(parse_token_response(&json!({ "refresh_token": "rt" }), now), None);
        assert_eq!(parse_token_response(&Value::Null, now), None);
        assert_eq!(parse_token_response(&json!("nope"), now), None);
        assert_eq!(parse_token_response(&json!({ "access_token": "" }), now), None);
        // A nonsensical expiry is dropped rather than making the token look dead.
        assert_eq!(
            parse_token_response(&json!({ "access_token": "at", "expires_in": -5 }), now),
            Some(OAuthTokens {
                access_token: "at".to_string(),
                refresh_token: None,
                expires_at: None,
            })
        );
    }

    #[test]
    fn an_access_token_is_usable_until_close_to_its_expiry() {
        let now = 10_000_000;
        assert!(access_token_usable(Some("at"), None, now));
        assert!(access_token_usable(Some("at"), Some(now + 120_000), now));
        // Inside the one-minute skew the token is treated as dead.
        assert!(!access_token_usable(Some("at"), Some(now + 30_000), now));
        assert!(!access_token_usable(Some("at"), Some(now - 1), now));
        assert!(!access_token_usable(None, None, now));
        assert!(!access_token_usable(Some(""), None, now));
    }

    #[test]
    fn a_stored_oauth_record_is_clamped_never_trusted() {
        let cleaned = normalise_mail_oauth(&json!({
            "clientId": "  cid  ",
            "clientSecret": " secret ",
            "authUrl": "https://provider.test/authorize",
            "tokenUrl": "https://provider.test/token",
            "scopes": " mail.read ",
            "accessToken": " at ",
            "refreshToken": " rt ",
            "expiresAt": 123.7,
            "extraParams": { "access_type": "offline", "bad": 42, "": "x" },
            "host": "javascript:alert(1)",
        }))
        .unwrap();
        assert_eq!(cleaned.client_id, "cid");
        assert_eq!(cleaned.client_secret.as_deref(), Some("secret"));
        assert_eq!(cleaned.scopes, "mail.read");
        assert_eq!(cleaned.access_token.as_deref(), Some("at"));
        assert_eq!(cleaned.refresh_token.as_deref(), Some("rt"));
        assert_eq!(cleaned.expires_at, Some(124), "rounded, never fractional");
        assert_eq!(
            cleaned.extra_params,
            Some(BTreeMap::from([(
                "access_type".to_string(),
                "offline".to_string()
            )])),
            "non-string extras are dropped"
        );
        // Unknown fields (a smuggled host, say) never ride along: the struct
        // has nowhere to put them.
        let serialized = serde_json::to_value(&cleaned).unwrap();
        assert!(serialized.get("host").is_none());
        // A config that cannot drive a sign-in becomes null, not a half-record.
        assert_eq!(
            normalise_mail_oauth(&json!({
                "clientId": "x",
                "authUrl": "nope",
                "tokenUrl": "https://x.test/t",
            })),
            None
        );
        assert_eq!(
            normalise_mail_oauth(&json!({
                "authUrl": "https://x.test/a",
                "tokenUrl": "https://x.test/t",
            })),
            None
        );
        assert_eq!(normalise_mail_oauth(&Value::Null), None);
        assert_eq!(normalise_mail_oauth(&json!("junk")), None);
    }

    #[test]
    fn tokens_and_config_are_detected_independently() {
        assert!(has_oauth_tokens(&json!({ "accessToken": "at" })));
        assert!(has_oauth_tokens(&json!({ "refreshToken": "rt" })));
        assert!(!has_oauth_tokens(&json!({ "accessToken": "", "refreshToken": "" })));
        assert!(!has_oauth_tokens(&Value::Null));
        assert!(oauth_config_usable(&json!({
            "clientId": "x",
            "authUrl": "https://a.test",
            "tokenUrl": "https://b.test",
        })));
        assert!(!oauth_config_usable(&json!({
            "clientId": "x",
            "authUrl": "nope",
            "tokenUrl": "https://b.test",
        })));
        assert!(!oauth_config_usable(&json!({
            "clientId": "",
            "authUrl": "https://a.test",
            "tokenUrl": "https://b.test",
        })));
    }

    #[test]
    fn the_presets_are_the_two_providers_people_ask_for_plus_custom() {
        assert_eq!(OAUTH_PRESETS.len(), 3);
        for preset in &OAUTH_PRESETS[..2] {
            assert!(is_http_url(Some(preset.auth_url)), "{} authorize URL", preset.id);
            assert!(is_http_url(Some(preset.token_url)), "{} token URL", preset.id);
            assert!(!preset.scopes.trim().is_empty(), "{} carries a scope", preset.id);
            assert!(!preset.hint.trim().is_empty(), "{} tells the user what to create", preset.id);
        }
        // Google's refresh token needs offline+consent on a desktop client.
        let google = google();
        assert_eq!(
            google
                .extra_params
                .iter()
                .find(|(key, _)| *key == "access_type")
                .map(|(_, value)| *value),
            Some("offline")
        );
        assert_eq!(
            google
                .extra_params
                .iter()
                .find(|(key, _)| *key == "prompt")
                .map(|(_, value)| *value),
            Some("consent")
        );
        // The Gmail full-mail scope is the one Google accepts for IMAP XOAUTH2.
        assert_eq!(google.scopes, "https://mail.google.com/");
        // Custom starts blank -- the form is the same, nothing is guessed.
        let custom = oauth_preset_by_id("custom");
        assert_eq!(custom.auth_url, "");
        assert_eq!(custom.token_url, "");
        // An unknown id falls back to custom rather than silently becoming Google.
        assert_eq!(oauth_preset_by_id("nope").id, "custom");
    }

    #[test]
    fn http_urls_are_accepted_only_as_http_and_loopback_included() {
        assert!(is_http_url(Some("https://x.test/a")));
        assert!(is_http_url(Some("http://127.0.0.1:9/")));
        assert!(!is_http_url(Some("file:///x")));
        assert!(!is_http_url(Some("javascript:alert(1)")));
        assert!(!is_http_url(Some("")));
        assert!(!is_http_url(None));
    }

    #[test]
    fn a_normalised_record_keeps_a_shape_the_mailer_accepts() {
        let record = normalise_mail_oauth(&json!({
            "clientId": "cid",
            "authUrl": google().auth_url,
            "tokenUrl": google().token_url,
            "scopes": google().scopes,
            "extraParams": { "access_type": "offline", "prompt": "consent" },
            "accessToken": "at",
            "refreshToken": "rt",
            "expiresAt": 4_000_000_000_000i64,
        }))
        .unwrap();
        assert_eq!(record.client_id, "cid");
        assert!(has_oauth_tokens(
            &serde_json::to_value(&record).unwrap()
        ));
        assert!(access_token_usable(
            record.access_token.as_deref(),
            record.expires_at,
            1_000_000_000_000
        ));
        // The record round-trips through JSON without gaining fields.
        let again = normalise_mail_oauth(&serde_json::to_value(&record).unwrap()).unwrap();
        assert_eq!(again, record);
    }

    #[test]
    fn pkce_challenge_is_the_s256_digest_in_base64url() {
        // RFC 7636's own worked example.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        // S256 has no padding and no `+`/`/`.
        let verifier = new_code_verifier();
        let challenge = pkce_challenge(&verifier);
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains('='));
        assert!(!challenge.contains('+') && !challenge.contains('/'));
        assert_ne!(new_state(), new_state());
    }

    #[test]
    fn xoauth2_carries_the_user_and_token_the_way_imap_expects() {
        let response = xoauth2_initial_response("me@example.com", "ya29.token");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(response.as_bytes())
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&decoded),
            "user=me@example.com\u{1}auth=Bearer ya29.token\u{1}\u{1}"
        );
    }

    #[test]
    fn the_loopback_answers_one_redirect_and_checks_the_state() {
        let loopback = Loopback::open().unwrap();
        assert!(loopback.port() > 0);
        assert_eq!(
            loopback.redirect_uri(),
            format!("http://127.0.0.1:{}/", loopback.port())
        );
        let redirect = loopback.redirect_uri();
        let state = new_state();
        let expected = state.clone();
        let browser = std::thread::spawn(move || {
            // Stand in for the browser's redirect.
            let address = redirect
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
            let mut stream = TcpStream::connect(&address).unwrap();
            stream
                .write_all(
                    format!("GET /?code=the-code&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
            let mut body = String::new();
            stream.read_to_string(&mut body).unwrap();
            body
        });
        let code = loopback
            .wait_for_code(&expected, Duration::from_secs(5))
            .unwrap();
        assert_eq!(code, "the-code");
        let body = browser.join().unwrap();
        assert!(body.contains("200 OK"), "{body}");
        assert!(body.contains("Signed in"), "{body}");
    }

    #[test]
    fn a_redirect_with_the_wrong_state_is_refused() {
        let loopback = Loopback::open().unwrap();
        let redirect = loopback.redirect_uri();
        std::thread::spawn(move || {
            let address = redirect
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
            if let Ok(mut stream) = TcpStream::connect(&address) {
                let _ = stream
                    .write_all(b"GET /?code=x&state=somebody-else HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            }
        });
        let error = loopback
            .wait_for_code("mine", Duration::from_secs(5))
            .unwrap_err();
        assert_eq!(error, "The sign-in redirect did not match. Try again.");
    }

    #[test]
    fn a_provider_error_comes_back_verbatim() {
        let loopback = Loopback::open().unwrap();
        let redirect = loopback.redirect_uri();
        std::thread::spawn(move || {
            let address = redirect
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
            if let Ok(mut stream) = TcpStream::connect(&address) {
                let _ = stream.write_all(
                    b"GET /?error=access_denied&error_description=The+user+refused HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                );
            }
        });
        let error = loopback
            .wait_for_code("mine", Duration::from_secs(5))
            .unwrap_err();
        assert_eq!(error, "The user refused");
    }

    #[test]
    fn a_silent_browser_times_out_with_the_ts_message() {
        let loopback = Loopback::open().unwrap();
        let error = loopback
            .wait_for_code("mine", Duration::from_millis(60))
            .unwrap_err();
        assert_eq!(error, "The sign-in was not finished in time. Try again.");
    }
}
