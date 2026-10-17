//! The mail engine's pure half (Phase 9): providers (9.1) and body plumbing
//! (9.3). Nothing here opens a socket or touches a screen.
//!
//! The worker that speaks IMAP (9.2), the body renderer (9.4) and OAuth (9.5)
//! build on these; keeping the tables and the decoders in the vault crate means
//! they can be tested without a UI, the same reason the crypto and the
//! normalisers live here.

pub mod oauth;
pub mod providers;
pub mod sanitize;
pub mod text;

pub use sanitize::{
    bullet, is_empty, render, Block, BlockKind, Span, BLOCK_TAGS, DROP_CONTENT_TAGS, KEPT_ATTRS,
};

pub use oauth::{
    access_token_usable, build_authorize_url, has_oauth_tokens, is_http_url, new_code_verifier,
    new_state, normalise_mail_oauth, oauth_config_usable, oauth_preset_by_id, parse_token_response,
    pkce_challenge, xoauth2_initial_response, AuthorizeFlow, Loopback, MailOAuth, OAuthPreset,
    OAuthTokens, FLOW_TIMEOUT_MS, OAUTH_PRESETS,
};
pub use providers::{
    account_label, is_custom_provider, provider_by_id, provider_for_address, resolve_connection,
    AccountRef, Connection, MailProvider, DEFAULT_PROVIDER_ID, MAIL_PROVIDERS,
};
pub use text::{
    collect_inline_images, decode_part_bytes, decode_quoted_printable, gmail_hex_of, imap_uid_of,
    is_connection_error, pick_html_part, pick_text_part, strip_html, InlineImage, MailPartNode,
    TextPart,
};
