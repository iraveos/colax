//! The mail engine's pure half (Phase 9): providers (9.1) and body plumbing
//! (9.3). Nothing here opens a socket or touches a screen.
//!
//! The worker that speaks IMAP (9.2), the body renderer (9.4) and OAuth (9.5)
//! build on these; keeping the tables and the decoders in the vault crate means
//! they can be tested without a UI, the same reason the crypto and the
//! normalisers live here.

pub mod providers;
pub mod text;

pub use providers::{
    account_label, is_custom_provider, provider_by_id, provider_for_address, resolve_connection,
    AccountRef, Connection, MailProvider, DEFAULT_PROVIDER_ID, MAIL_PROVIDERS,
};
pub use text::{
    collect_inline_images, decode_part_bytes, decode_quoted_printable, gmail_hex_of, imap_uid_of,
    is_connection_error, pick_html_part, pick_text_part, strip_html, InlineImage, MailPartNode,
    TextPart,
};
