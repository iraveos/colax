//! Plain-text plumbing for full message bodies (Task 9.3).
//!
//! Port of `E:\acc2\src\lib\mail-text.ts`. Everything here is pure: no
//! sockets, no UI. The IMAP fetch (Task 9.2) hands these bytes and asks for
//! text; the body renderer (Task 9.4) asks for blocks.
//!
//! The transfer decoders and the charset table are the parts that actually
//! matter in the field: Arabic and other non-Latin mail arrives as
//! `windows-1256` or `iso-8859-6`, and reading those bytes as UTF-8 mangles
//! every word. `encoding_rs` implements the same WHATWG label table
//! `TextDecoder` does, so the labels behave identically.
//!
//! `strip_html` is regex-based on purpose, exactly like the TS: the fixtures
//! in `test/mail-text.test.ts` are its spec, and a DOM parser would need a DOM
//! this app deliberately does not have.

use std::sync::OnceLock;

use base64::Engine as _;
use regex::Regex;

/// A message listed over IMAP carries `imap:<uid>` instead of a feed id.
/// UIDs address INBOX directly; everything else falls back to subject matching
/// for these ids.
pub fn imap_uid_of(id: Option<&str>) -> Option<u64> {
    let id = id?.trim();
    let rest = id.strip_prefix("imap:")?;
    if rest.is_empty() || !rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let uid: u64 = rest.parse().ok()?;
    // `Number.isSafeInteger(uid) && uid > 0`.
    if uid == 0 || uid > 9_007_199_254_740_991 {
        return None;
    }
    Some(uid)
}

/// Whether a failure looks like a dead socket rather than a refusal: the server
/// culling an idle connection, a network blip, a DNS wobble. Those are worth
/// one reconnect + retry; auth errors and missing messages are not.
///
/// Callers pass the message and error code together, as the TS builds
/// `` `${message} ${code}` ``.
pub fn is_connection_error(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)connection (not available|closed|lost|ended|reset|refused)|socket (closed|ended|hang up)|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN",
        )
        .expect("connection-error pattern")
    });
    re.is_match(text)
}

/// The hex tail of a feed id is the Gmail message id
/// (`tag:...,2004:<hex>`).
pub fn gmail_hex_of(id: Option<&str>) -> Option<String> {
    let id = id?;
    let tail = match id.rfind(':') {
        Some(at) => &id[at + 1..],
        None => id,
    };
    if tail.is_empty() || !tail.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(tail.to_string())
}

/// Minimal shape of an IMAP body-structure node — structural, not imported
/// (`MailPartNode`). `content_type` is the TS's `type`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MailPartNode {
    pub content_type: Option<String>,
    pub part: Option<String>,
    pub encoding: Option<String>,
    pub size: Option<u64>,
    pub disposition: Option<String>,
    /// Content id, for matching `cid:` image references.
    pub id: Option<String>,
    pub parameters: Vec<(String, String)>,
    pub child_nodes: Vec<MailPartNode>,
}

impl MailPartNode {
    fn kind(&self) -> String {
        self.content_type
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
    }

    fn is_attachment(&self) -> bool {
        self.disposition
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            == "attachment"
    }
}

/// The part to read and whether it is HTML.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextPart {
    pub part: String,
    pub html: bool,
}

/// First text/html part that is not an attachment, for rich rendering.
pub fn pick_html_part(node: Option<&MailPartNode>) -> Option<TextPart> {
    let node = node?;
    if !node.is_attachment() && node.kind() == "text/html" {
        if let Some(part) = &node.part {
            return Some(TextPart {
                part: part.clone(),
                html: true,
            });
        }
    }
    for child in &node.child_nodes {
        if let Some(found) = pick_html_part(Some(child)) {
            return Some(found);
        }
    }
    None
}

/// An inline (non-attachment) image part with a content id, for `cid:`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineImage {
    pub part: String,
    pub cid: String,
    pub mime: String,
    pub size: u64,
}

/// Inline image parts, in tree order (`collectInlineImages`).
pub fn collect_inline_images(node: Option<&MailPartNode>) -> Vec<InlineImage> {
    let mut out = Vec::new();
    collect_inline_images_into(node, &mut out);
    out
}

fn collect_inline_images_into(node: Option<&MailPartNode>, out: &mut Vec<InlineImage>) {
    let Some(node) = node else {
        return;
    };
    let kind = node.kind();
    if !node.is_attachment() && kind.starts_with("image/") {
        if let Some(part) = &node.part {
            let id = node.id.as_deref().unwrap_or("");
            let id = id.strip_prefix('<').unwrap_or(id);
            let id = id.strip_suffix('>').unwrap_or(id);
            let cid = id.trim();
            if !cid.is_empty() {
                out.push(InlineImage {
                    part: part.clone(),
                    cid: cid.to_string(),
                    mime: kind,
                    size: node.size.unwrap_or(0),
                });
            }
        }
    }
    for child in &node.child_nodes {
        collect_inline_images_into(Some(child), out);
    }
}

/// Picks the part to read: the first `text/plain` that is not an attachment,
/// else the first `text/html` (stripped later). Attachments are never "the
/// body", even when they are text.
pub fn pick_text_part(node: Option<&MailPartNode>) -> Option<TextPart> {
    let node = node?;
    if !node.is_attachment() && node.kind() == "text/plain" {
        if let Some(part) = &node.part {
            return Some(TextPart {
                part: part.clone(),
                html: false,
            });
        }
    }
    // Plain text anywhere in the tree wins over an HTML part that sits
    // *before* it; the second pass only runs once no plain text was found.
    for child in &node.child_nodes {
        if let Some(found) = pick_text_part(Some(child)) {
            if !found.html {
                return Some(found);
            }
        }
    }
    if !node.is_attachment() && node.kind() == "text/html" {
        if let Some(part) = &node.part {
            return Some(TextPart {
                part: part.clone(),
                html: true,
            });
        }
    }
    for child in &node.child_nodes {
        if let Some(found) = pick_text_part(Some(child)) {
            return Some(found);
        }
    }
    None
}

/// Decodes quoted-printable bytes. Small and strict enough for mail bodies.
pub fn decode_quoted_printable(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let byte = input[i];
        if byte == 0x3d {
            // A soft break (`=\r\n` / `=\n`) melts away; otherwise two hex
            // digits name a byte.
            let a = input.get(i + 1).copied();
            let b = input.get(i + 2).copied();
            if a == Some(0x0d) && b == Some(0x0a) {
                i += 3;
                continue;
            }
            if a == Some(0x0a) {
                i += 2;
                continue;
            }
            let hex = match (a, b) {
                (Some(a), Some(b)) => {
                    let ok = a.is_ascii_hexdigit() && b.is_ascii_hexdigit();
                    ok.then(|| [a, b])
                }
                _ => None,
            };
            match hex {
                Some([a, b]) => {
                    let digit = |byte: u8| match byte {
                        b'0'..=b'9' => byte - b'0',
                        b'a'..=b'f' => byte - b'a' + 10,
                        _ => byte - b'A' + 10,
                    };
                    out.push(digit(a) * 16 + digit(b));
                    i += 3;
                }
                None => {
                    out.push(byte);
                    i += 1;
                }
            }
        } else {
            out.push(byte);
            i += 1;
        }
    }
    out
}

/// Turns one fetched part into text. Transfer-decoding first (base64,
/// quoted-printable), then charset decoding.
pub fn decode_part_bytes(bytes: &[u8], encoding: Option<&str>, charset: Option<&str>) -> String {
    let normalized: String = encoding
        .unwrap_or("7bit")
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect();
    let raw: Vec<u8> = if normalized == "base64" || normalized == "base64mime" {
        // `atob` is fed the text with its whitespace stripped; an invalid body
        // leaves the bytes alone rather than losing the message.
        let text: String = String::from_utf8_lossy(bytes)
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(text.as_bytes())
            .unwrap_or_else(|_| bytes.to_vec())
    } else if normalized == "quoted-printable" || normalized == "quotedprintable" {
        decode_quoted_printable(bytes)
    } else {
        bytes.to_vec()
    };

    let label = charset.unwrap_or("utf-8").trim().to_lowercase();
    let label = if label.is_empty() { "utf-8".to_string() } else { label };
    // An unknown label falls back to UTF-8 instead of killing the read, which
    // is what the TS's constructor try/catch does.
    let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = enc.decode(&raw);
    text.into_owned()
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("html pattern"))
}

static SCRIPT: OnceLock<Regex> = OnceLock::new();
static STYLE: OnceLock<Regex> = OnceLock::new();
static COMMENT: OnceLock<Regex> = OnceLock::new();
static IMG: OnceLock<Regex> = OnceLock::new();
static ANCHOR: OnceLock<Regex> = OnceLock::new();
static INNER_TAGS: OnceLock<Regex> = OnceLock::new();
static BLOCK_END: OnceLock<Regex> = OnceLock::new();
static BR: OnceLock<Regex> = OnceLock::new();
static TAGS: OnceLock<Regex> = OnceLock::new();
static SPACES: OnceLock<Regex> = OnceLock::new();
static BLANK_LINES: OnceLock<Regex> = OnceLock::new();
static DEC_ENTITY: OnceLock<Regex> = OnceLock::new();
static HEX_ENTITY: OnceLock<Regex> = OnceLock::new();
static BARE_URL: OnceLock<Regex> = OnceLock::new();

/// Strips HTML to readable text. Regex-based on purpose: no DOM.
pub fn strip_html(html: &str) -> String {
    // Scripts, styles and comments never reach the reader. The TS uses a
    // backreference for the closing tag; the Rust regex engine has none, so
    // the two tags are two passes -- the same result for well-formed mail.
    let text = re(&SCRIPT, r"(?is)<script\b[\s\S]*?</script\s*>").replace_all(html, "");
    let text = re(&STYLE, r"(?is)<style\b[\s\S]*?</style\s*>").replace_all(&text, "");
    let text = re(&COMMENT, r"(?s)<!--[\s\S]*?-->").replace_all(&text, "");
    // Images carry no readable text: the tag goes whole, alt text included,
    // or every logo and tracking pixel leaves stray words behind.
    let text = re(&IMG, r"(?i)<img\b[^>]*>").replace_all(&text, "");
    // Links unwrap to their text -- unless the text IS a bare long URL, in
    // which case the link was a tracking hop and the URL alone reads as
    // garbage. Short links stay; labelled links keep their label.
    let text = re(&ANCHOR, r"(?is)<a\b[^>]*>([\s\S]*?)</a\s*>").replace_all(&text, |caps: &regex::Captures<'_>| {
        let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let label = re(&INNER_TAGS, r"<[^>]+>").replace_all(inner, "");
        let label = label.trim();
        if label.is_empty() {
            return String::new();
        }
        let bare = re(&BARE_URL, r"(?i)^https?://\S+$").is_match(label);
        if bare && label.chars().count() > 60 {
            return String::new();
        }
        label.to_string()
    });
    // Block boundaries become line breaks before the tags go.
    let text = re(
        &BLOCK_END,
        r"(?i)</(p|div|tr|table|ul|ol|li|h[1-6]|blockquote|br|hr)[^>]*>",
    )
    .replace_all(&text, "\n");
    let text = re(&BR, r"(?i)<br[^>]*>").replace_all(&text, "\n");
    let text = re(&TAGS, r"<[^>]+>").replace_all(&text, "");
    // Named entities. The TS runs seven case-insensitive passes in this order,
    // so `&amp;lt;` unwraps twice; one pass over all of them, repeated until
    // the string stops changing, is the same result without seven regexes.
    static NAMED: OnceLock<Regex> = OnceLock::new();
    let named = re(&NAMED, r"(?i)&(nbsp|amp|lt|gt|quot|apos|#39);");
    let mut text = text.into_owned();
    for _ in 0..8 {
        let next = named.replace_all(&text, |caps: &regex::Captures<'_>| {
            let name = caps.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
            match name.as_str() {
                "nbsp" => " ",
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" | "#39" => "'",
                _ => "",
            }
        });
        if next.as_ref() == text.as_str() {
            break;
        }
        text = next.into_owned();
    }
    // A numeric entity out of range drops out instead of throwing (real mail
    // carries garbage like `&#99999999;`).
    let text = re(&DEC_ENTITY, r"&#(\d+);").replace_all(&text, |caps: &regex::Captures<'_>| {
        caps.get(1)
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .filter(|point| *point <= 0x10ffff)
            .and_then(char::from_u32)
            .map(|ch| ch.to_string())
            .unwrap_or_default()
    });
    let text = re(&HEX_ENTITY, r"&#x([0-9a-fA-F]+);").replace_all(&text, |caps: &regex::Captures<'_>| {
        caps.get(1)
            .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
            .filter(|point| *point <= 0x10ffff)
            .and_then(char::from_u32)
            .map(|ch| ch.to_string())
            .unwrap_or_default()
    });
    let text = text
        .split('\n')
        .map(|line| {
            let line = re(&SPACES, r"[ \t]+").replace_all(line, " ");
            line.trim_end().to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = re(&BLANK_LINES, r"\n{3,}").replace_all(&text, "\n\n");
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(content_type: &str, part: &str, disposition: Option<&str>) -> MailPartNode {
        MailPartNode {
            content_type: Some(content_type.to_string()),
            part: (!part.is_empty()).then(|| part.to_string()),
            disposition: disposition.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn the_feed_id_tail_is_the_gmail_hex_id() {
        assert_eq!(
            gmail_hex_of(Some("tag:gmail.google.com,2004:18f3ab02cd")),
            Some("18f3ab02cd".to_string())
        );
        assert_eq!(gmail_hex_of(Some("plain-hex")), None);
        assert_eq!(gmail_hex_of(Some("")), None);
        assert_eq!(gmail_hex_of(None), None);
    }

    #[test]
    fn plain_text_wins_over_html_and_attachments_never_count() {
        let tree = MailPartNode {
            content_type: Some("multipart/mixed".to_string()),
            child_nodes: vec![
                node("text/html", "1", None),
                node("text/plain", "2", None),
                node("text/plain", "3", Some("attachment")),
            ],
            ..Default::default()
        };
        assert_eq!(
            pick_text_part(Some(&tree)),
            Some(TextPart {
                part: "2".to_string(),
                html: false
            })
        );
        assert_eq!(
            pick_text_part(Some(&node("text/html", "1", None))),
            Some(TextPart {
                part: "1".to_string(),
                html: true
            })
        );
        assert_eq!(pick_text_part(None), None);
    }

    #[test]
    fn quoted_printable_decodes_soft_breaks_and_hex_escapes() {
        let bytes = b"Hello=\r\nWorld=21=C3=A9";
        assert_eq!(
            String::from_utf8_lossy(&decode_quoted_printable(bytes)),
            "HelloWorld!é"
        );
        // A lone `=` is kept; a truncated escape keeps the `=`.
        assert_eq!(decode_quoted_printable(b"a=z"), b"a=z");
        assert_eq!(decode_quoted_printable(b"a="), b"a=");
        assert_eq!(decode_quoted_printable(b"=\n"), b"");
    }

    #[test]
    fn base64_parts_decode_with_their_charset_not_as_utf8() {
        // "café" with é as windows-1256 0xE9 (invalid UTF-8 on its own).
        let raw = [0x63u8, 0x61, 0x66, 0xe9];
        let wrapped = base64::engine::general_purpose::STANDARD.encode(raw);
        assert_eq!(
            decode_part_bytes(wrapped.as_bytes(), Some("base64"), Some("windows-1256")),
            "café"
        );
        assert_eq!(
            decode_part_bytes(b"caf=C3=A9", Some("quoted-printable"), Some("utf-8")),
            "café"
        );
        assert_eq!(
            decode_part_bytes(b"hello", Some("7bit"), Some("utf-8")),
            "hello"
        );
        // Garbage in the labels must not lose the body.
        assert_eq!(
            decode_part_bytes(b"hello", Some("base64!"), Some("not-a-charset")),
            "hello"
        );
    }

    #[test]
    fn imap_ids_parse_to_uids_and_everything_else_does_not() {
        assert_eq!(imap_uid_of(Some("imap:4821")), Some(4821));
        assert_eq!(imap_uid_of(Some("tag:gmail.google.com,2004:18f3ab02cd")), None);
        assert_eq!(imap_uid_of(Some("imap:0")), None);
        assert_eq!(imap_uid_of(Some("imap:abc")), None);
        assert_eq!(imap_uid_of(Some("")), None);
        assert_eq!(imap_uid_of(None), None);
        assert_eq!(imap_uid_of(Some("imap:9007199254740992")), None);
        assert_eq!(imap_uid_of(Some(" imap:7 ")), Some(7));
    }

    #[test]
    fn html_part_and_inline_images_are_picked_out_of_the_structure() {
        let tree = MailPartNode {
            content_type: Some("multipart/related".to_string()),
            child_nodes: vec![
                MailPartNode {
                    content_type: Some("multipart/alternative".to_string()),
                    child_nodes: vec![node("text/plain", "1.1", None), node("text/html", "1.2", None)],
                    ..Default::default()
                },
                MailPartNode {
                    size: Some(42000),
                    ..node("image/png", "2", None)
                },
                node("image/jpeg", "3", Some("attachment")),
            ],
            ..Default::default()
        };
        let mut tree = tree;
        tree.child_nodes[1].id = Some("<logo123>".to_string());
        assert_eq!(
            pick_html_part(Some(&tree)),
            Some(TextPart {
                part: "1.2".to_string(),
                html: true
            })
        );
        assert_eq!(
            collect_inline_images(Some(&tree)),
            vec![InlineImage {
                part: "2".to_string(),
                cid: "logo123".to_string(),
                mime: "image/png".to_string(),
                size: 42000
            }]
        );
        assert_eq!(pick_html_part(Some(&node("text/plain", "1", None))), None);
    }

    #[test]
    fn html_strips_to_readable_text_without_scripts() {
        let out = strip_html(
            "<style>.x{}</style><p>Hello <b>World</b></p><!-- c --><p>Line&nbsp;2 &amp; co</p>",
        );
        assert_eq!(out, "Hello World\nLine 2 & co");
    }

    #[test]
    fn images_vanish_whole_alt_text_included() {
        let out = strip_html("<p>Hi</p><img src=\"cid:logo\" alt=\"Company logo\"><p>Bye</p>");
        assert_eq!(out, "Hi\nBye");
        assert!(!out.contains("logo"));
    }

    #[test]
    fn only_dead_sockets_count_as_connection_errors() {
        assert!(is_connection_error("Connection not available"));
        assert!(is_connection_error("socket hang up"));
        assert!(is_connection_error("read failed ETIMEDOUT"));
        assert!(!is_connection_error("Invalid credentials"));
        assert!(!is_connection_error("Message not found"));
        assert!(!is_connection_error(""));
    }

    #[test]
    fn out_of_range_entities_drop_out_instead_of_throwing() {
        assert_eq!(strip_html("<p>A&#99999999;B&#x110000;C&#65;D</p>"), "ABCAD");
    }

    #[test]
    fn links_unwrap_to_text_and_bare_long_urls_drop_out() {
        let long = format!("https://tracker.example.com/click?{}", "x".repeat(80));
        assert_eq!(
            strip_html(&format!("<p>Read <a href=\"{long}\">the report</a> today</p>")),
            "Read the report today"
        );
        assert_eq!(
            strip_html(&format!("<p>Visit <a href=\"{long}\">{long}</a> now</p>")),
            "Visit now"
        );
        assert_eq!(
            strip_html("<p>See <a href=\"https://x.co/a\">https://x.co/a</a></p>"),
            "See https://x.co/a"
        );
        assert_eq!(strip_html("<p>Go <a href=\"https://x.co\"></a> home</p>"), "Go home");
    }
}
