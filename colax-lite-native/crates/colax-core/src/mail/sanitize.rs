//! Mail bodies: the scrubber and the rich-text model (Task 9.4).
//!
//! Port of `E:\\acc2\\src\\ui\\FullMail.tsx`. HTML mail is hostile by default:
//! scripts, tracking pixels, remote images that phone home. The web build hands
//! its HTML to DOMPurify and then to the DOM; Slint has no HTML widget, so the
//! same contract is met by *not having a DOM to sanitise into*: the tokenizer
//! below is the allowlist, and nothing but an allowed tag with an allowed
//! attribute can reach a `Block` or a `Span`. There is no string of HTML to
//! smuggle anything through, so there is nothing to run.
//!
//! The one place the model must be explicit is images, because the fetch has
//! already happened by then:
//!
//! * an inline `cid:` image that was fetched becomes `BlockKind::Image` with
//!   `resolved: true`, and the UI draws the bytes it holds;
//! * anything else -- a remote `http(s)` src, an unresolvable cid, a `data:`
//!   URL -- becomes the same block with `resolved: false` and the TS's label:
//!   `Image blocked: <alt>`, or the generic line when there is no alt. No
//!   network call is ever made on the user's behalf.
//!
//! Links are carried as `Span::link` and opened through `open_external` by the
//! UI, so a click never navigates in place (there is nowhere to navigate to).

use std::collections::BTreeSet;

use crate::mail::text::InlineImage;

/// Block-level tags the model understands. Anything block-shaped in real mail
/// that is not here (`table` is, `o:p` is not) still reads normally: an
/// unknown tag only carries style, and the text inside it lands in whatever
/// block is open.
pub const BLOCK_TAGS: &[&str] = &[
    "p", "div", "section", "article", "header", "footer", "main", "aside", "figure",
    "figcaption", "blockquote", "pre", "address", "center", "dl", "dt", "dd", "table",
    "caption", "tr", "td", "th", "thead", "tbody", "tfoot", "form", "fieldset", "legend",
    "details", "summary", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
    "hr", "br", "img",
];

/// Tags whose *content* is dropped whole: never text, never a placeholder.
/// This is DOMPurify's `FORBID_CONTENTS` set, which is deliberately shorter
/// than the forbidden-tag set: a `<button>` loses the tag but keeps the word,
/// a `<style>` loses everything. Forbidden *tags* that are not in this list
/// need no arm at all -- they are not block tags and not format tags, so they
/// fall through to the "unknown tag" path and only carry style.
pub const DROP_CONTENT_TAGS: &[&str] = &[
    "script", "style", "noscript", "noembed", "noframes", "template", "title", "head",
    "iframe", "svg", "math", "annotation-xml", "desc", "foreignobject", "mi", "mn", "mo",
    "ms", "mtext", "plaintext", "xmp", "video", "audio", "colgroup", "thead",
];

/// Tags whose content is kept and whose name carries meaning to the model.
const FORMAT_TAGS: &[&str] = &[
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "kbd", "samp",
    "var", "tt", "a", "span", "font", "small", "big", "mark", "sub", "sup", "q", "cite",
    "abbr", "time", "label", "nobr",
];

/// Attributes that survive into the model: a link target, an image's two
/// fields, and a tooltip. Every other attribute -- `style`, `background`,
/// `srcset`, `action`, `onclick`, `onerror` -- has nowhere to live, which is
/// the whole point.
pub const KEPT_ATTRS: &[&str] = &["href", "src", "alt", "title"];

/// The bulletin prefix the UI draws for a list item, so a text-only rendering
/// still reads as a list.
pub fn bullet(ordered: bool, index: usize) -> String {
    if ordered {
        format!("{}.", index + 1)
    } else {
        "•".to_string()
    }
}

/// One styled run of text inside a block.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub code: bool,
    /// The `href` this run points at, when it is inside a link. The UI hands it
    /// to `open_external`.
    pub link: Option<String>,
    pub title: Option<String>,
}

/// What a block is, which is all the UI needs to lay it out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph,
    Heading { level: u8 },
    Quote { depth: usize },
    Code,
    List { ordered: bool, depth: usize, index: usize },
    Rule,
    /// A replaced image: resolved inline data, or the labelled stand-in.
    Image { alt: String, resolved: bool, cid: String },
}

/// One block of the body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub kind: BlockKind,
    pub spans: Vec<Span>,
}

/// True when the model carries no readable content -- an empty `text/html` part
/// should fall back to the plain text rather than showing nothing.
pub fn is_empty(blocks: &[Block]) -> bool {
    blocks.iter().all(|block| {
        match &block.kind {
            // An image or a rule is content even with no text in it.
            BlockKind::Rule | BlockKind::Image { .. } => false,
            _ => block.spans.iter().all(|span| span.text.trim().is_empty()),
        }
    })
}

/// The blocks a message body renders as.
///
/// `images` are the inline images that were fetched successfully; a `cid:` src
/// that is not among them is labelled as blocked, exactly like a remote one.
pub fn render(html: &str, images: &[InlineImage]) -> Vec<Block> {
    let available: BTreeSet<String> = images
        .iter()
        .map(|image| strip_brackets(&image.cid).to_lowercase())
        .collect();
    let mut builder = Builder::new(available);
    builder.run(html);
    builder.finish()
}

fn strip_brackets(value: &str) -> String {
    let trimmed = value.trim();
    let trimmed = trimmed.strip_prefix('<').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('>').unwrap_or(trimmed);
    trimmed.trim().to_string()
}

/// The style state a run is rendered with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Style {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    code: bool,
    link: Option<String>,
    title: Option<String>,
}

struct Builder {
    available: BTreeSet<String>,
    blocks: Vec<Block>,
    spans: Vec<Span>,
    buffer: String,
    buffer_style: Style,
    style: Style,
    kind: BlockKind,
    /// Kept so an unbalanced end tag can restore the style it replaced.
    stack: Vec<(String, Style)>,
    /// `ul`/`ol` nesting, most recent last.
    lists: Vec<(bool, usize)>,
    /// Inside `<pre>`: whitespace is content, not noise.
    preserve: bool,
    quote_depth: usize,
    /// True while the current run of text is inside a tag whose content is
    /// dropped: nothing is gathered until that tag closes.
    dropping: usize,
    blocks_capped: bool,
}

impl Builder {
    fn new(available: BTreeSet<String>) -> Builder {
        Builder {
            available,
            blocks: Vec::new(),
            spans: Vec::new(),
            buffer: String::new(),
            buffer_style: Style::default(),
            style: Style::default(),
            kind: BlockKind::Paragraph,
            stack: Vec::new(),
            lists: Vec::new(),
            preserve: false,
            quote_depth: 0,
            dropping: 0,
            blocks_capped: false,
        }
    }

    fn run(&mut self, html: &str) {
        let tokens = tokenize(html);
        for token in tokens {
            match token {
                Token::Text(text) => self.text(&text),
                Token::Start(name, attrs, self_closing) => {
                    self.start(&name, &attrs, self_closing)
                }
                Token::End(name) => self.end(&name),
            }
        }
    }

    fn finish(mut self) -> Vec<Block> {
        self.flush_span();
        self.flush_block();
        self.blocks
    }

    fn text(&mut self, text: &str) {
        if self.dropping > 0 {
            return;
        }
        let decoded = decode_entities(text);
        if self.preserve {
            self.gather(&decoded);
        } else {
            // Runs of whitespace read as one space; the edge trimming happens
            // when the block is closed.
            let mut collapsed = String::with_capacity(decoded.len());
            let mut last_was_space = false;
            for ch in decoded.chars() {
                if ch.is_whitespace() {
                    if !last_was_space {
                        collapsed.push(' ');
                    }
                    last_was_space = true;
                } else {
                    collapsed.push(ch);
                    last_was_space = false;
                }
            }
            self.gather(&collapsed);
        }
    }

    fn gather(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if self.buffer_style != self.style && !self.buffer.is_empty() {
            self.flush_span();
        }
        self.buffer_style = self.style.clone();
        self.buffer.push_str(text);
    }

    fn newline(&mut self) {
        self.gather("\n");
    }

    fn flush_span(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        let style = std::mem::take(&mut self.buffer_style);
        let text = std::mem::take(&mut self.buffer);
        self.spans.push(Span {
            text,
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            strike: style.strike,
            code: style.code,
            link: style.link,
            title: style.title,
        });
    }

    /// Closes the block being gathered, if it has anything in it.
    fn flush_block(&mut self) {
        self.flush_span();
        // Text arrives padded by the whitespace between tags; a `<p>` must not
        // begin with the newline that preceded it. Inside `<pre>` that padding
        // is content, so nothing is trimmed there.
        if self.kind != BlockKind::Code {
            if let Some(first) = self.spans.first_mut() {
                let trimmed = first.text.trim_start().to_string();
                first.text = trimmed;
            }
            if let Some(last) = self.spans.last_mut() {
                let trimmed = last.text.trim_end().to_string();
                last.text = trimmed;
            }
        }
        self.spans.retain(|span| !span.text.is_empty());
        if self.spans.is_empty() {
            return;
        }
        if self.blocks_capped {
            self.spans.clear();
            return;
        }
        // A pathological body (loops of `<p>`) must not build an unbounded
        // model: past the cap the rest is dropped, not rendered.
        if self.blocks.len() >= MAX_BLOCKS {
            self.blocks_capped = true;
            self.spans.clear();
            return;
        }
        let spans = std::mem::take(&mut self.spans);
        self.blocks.push(Block {
            kind: self.kind.clone(),
            spans,
        });
    }

    fn start(&mut self, tag: &str, attrs: &[(String, String)], self_closing: bool) {
        if self.dropping > 0 {
            // Nested drop tags: only the outermost closing tag matters, and
            // self-closing ones do not open a level.
            if !is_void(tag) && !self_closing {
                if DROP_CONTENT_TAGS.contains(&tag) {
                    self.dropping += 1;
                } else if FORMAT_TAGS.contains(&tag) {
                    // A formatting tag inside, say, a `<style>` is text, not a
                    // tag; nothing to do.
                }
            }
            return;
        }
        if DROP_CONTENT_TAGS.contains(&tag) {
            if !is_void(tag) && !self_closing {
                self.dropping = 1;
            }
            return;
        }

        match tag {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.begin_block(BlockKind::Heading {
                    level: tag.as_bytes()[1] - b'0',
                });
            }
            "p" | "div" | "section" | "article" | "header" | "footer" | "main" | "aside"
            | "figure" | "figcaption" | "address" | "center" | "dl" | "dt" | "dd" | "table"
            | "caption" | "tr" | "td" | "th" | "thead" | "tbody" | "tfoot" | "legend"
            | "details" | "summary" | "nav" | "fieldset" => {
                self.begin_block(self.kind.clone());
                if self.kind == BlockKind::Paragraph && self.quote_depth > 0 {
                    self.kind = BlockKind::Quote {
                        depth: self.quote_depth,
                    };
                }
            }
            "blockquote" => {
                self.flush_block();
                self.quote_depth += 1;
                self.kind = BlockKind::Quote {
                    depth: self.quote_depth,
                };
            }
            "pre" => {
                self.begin_block(BlockKind::Code);
                self.preserve = true;
            }
            "ul" | "ol" => {
                self.flush_block();
                let ordered = tag == "ol";
                let depth = self.lists.len();
                self.lists.push((ordered, 0));
                self.kind = BlockKind::List {
                    ordered,
                    depth,
                    index: 0,
                };
            }
            "li" => {
                self.flush_block();
                if let Some((ordered, next)) = self.lists.last_mut() {
                    let ordered = *ordered;
                    let index = *next;
                    *next += 1;
                    let depth = self.lists.len() - 1;
                    self.kind = BlockKind::List {
                        ordered,
                        depth,
                        index,
                    };
                } else {
                    self.kind = BlockKind::Paragraph;
                }
            }
            "br" => {
                if self.spans.is_empty() && self.buffer.is_empty() {
                    // A leading `<br>` is the paragraph break itself.
                    return;
                }
                self.newline();
            }
            "hr" => {
                self.flush_block();
                self.push_kind(BlockKind::Rule);
            }
            "img" => {
                let alt = attr(attrs, "alt").unwrap_or_default();
                let src = attr(attrs, "src").unwrap_or_default();
                self.flush_block();
                let cid = src
                    .trim()
                    .strip_prefix("cid:")
                    .map(strip_brackets)
                    .or_else(|| {
                        src.trim()
                            .strip_prefix("CID:")
                            .map(strip_brackets)
                    })
                    .unwrap_or_default();
                let resolved = !cid.is_empty() && self.available.contains(&cid.to_lowercase());
                let alt = decode_entities(&alt).trim().to_string();
                self.push_kind(BlockKind::Image {
                    alt,
                    resolved,
                    cid: cid.to_lowercase(),
                });
            }
            _ => {
                // Formatting and unknown tags: style only. An unknown tag still
                // ends nothing -- its children are read normally, which is how
                // a `<font>` wrapper or a stray `<o:p>` behaves in a browser.
                if is_void(tag) {
                    return;
                }
                let style = self.style_for(tag, attrs);
                if style != self.style {
                    self.flush_span();
                }
                self.stack.push((tag.to_string(), std::mem::replace(&mut self.style, style)));
            }
        }

        if is_void(tag) || self_closing {
            // Nothing opens, so nothing closes: `br`/`hr`/`img` never push.
            return;
        }
    }

    fn end(&mut self, tag: &str) {
        if self.dropping > 0 {
            if DROP_CONTENT_TAGS.contains(&tag) {
                self.dropping -= 1;
            }
            return;
        }
        match tag {
            "blockquote" => {
                self.flush_block();
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.kind = if self.quote_depth > 0 {
                    BlockKind::Quote {
                        depth: self.quote_depth,
                    }
                } else {
                    BlockKind::Paragraph
                };
            }
            "pre" => {
                self.flush_block();
                self.preserve = false;
                self.kind = BlockKind::Paragraph;
            }
            "ul" | "ol" => {
                self.flush_block();
                self.lists.pop();
                self.kind = BlockKind::Paragraph;
            }
            "li" => {
                self.flush_block();
                // The next `<li>` sets its own kind; between them, text has no
                // block to belong to.
                self.kind = BlockKind::Paragraph;
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "section" | "article"
            | "header" | "footer" | "main" | "aside" | "figure" | "figcaption" | "address"
            | "center" | "dl" | "dt" | "dd" | "table" | "caption" | "tr" | "td" | "th"
            | "thead" | "tbody" | "tfoot" | "legend" | "details" | "summary" | "nav"
            | "fieldset" => {
                self.flush_block();
                self.kind = if self.quote_depth > 0 {
                    BlockKind::Quote {
                        depth: self.quote_depth,
                    }
                } else {
                    BlockKind::Paragraph
                };
            }
            _ => {
                // Restore the style the matching start tag saved. Mismatched
                // nesting (`<b><i></b></i>`) is common in real mail, so this
                // walks back to the nearest open tag of that name rather than
                // requiring perfect nesting.
                if let Some(at) = self.stack.iter().rposition(|(name, _)| name == tag) {
                    let (_, saved) = self.stack.remove(at);
                    self.style = saved;
                    self.flush_span();
                }
            }
        }
        // A void tag never pushed, and `br`/`img`/`hr` are handled above.
        if is_void(tag) {
            return;
        }
    }

    fn style_for(&self, tag: &str, attrs: &[(String, String)]) -> Style {
        let mut style = self.style.clone();
        match tag {
            "b" | "strong" => style.bold = true,
            "i" | "em" => style.italic = true,
            "u" | "ins" => style.underline = true,
            "s" | "strike" | "del" => style.strike = true,
            "code" | "kbd" | "samp" | "var" | "tt" => style.code = true,
            "a" => {
                if let Some(href) = attr(attrs, "href") {
                    let href = decode_entities(&href).trim().to_string();
                    if is_safe_link(&href) {
                        style.link = Some(href);
                    }
                }
                style.title = attr(attrs, "title").map(|value| decode_entities(&value));
            }
            _ => {
                if let Some(title) = attr(attrs, "title") {
                    style.title = Some(decode_entities(&title));
                }
            }
        }
        // A kept `title` on the link itself already landed above; anything else
        // in `attrs` is not part of the model.
        style
    }

    fn begin_block(&mut self, kind: BlockKind) {
        self.flush_block();
        self.kind = kind;
    }

    fn push_kind(&mut self, kind: BlockKind) {
        self.flush_block();
        let spans = std::mem::take(&mut self.spans);
        if self.blocks.len() < MAX_BLOCKS {
            self.blocks.push(Block { kind, spans });
        }
    }
}

/// Real mail can be long; the model does not need to be unbounded.
const MAX_BLOCKS: usize = 4000;

fn attr(attrs: &[(String, String)], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

/// A link the UI may hand to the operating system: absolute, and a scheme that
/// can only open a page or a compose window. `javascript:`, `data:` and
/// relative hrefs are dropped -- with the text kept, so the sentence still
/// reads.
fn is_safe_link(href: &str) -> bool {
    let lower = href.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
}

fn is_void(tag: &str) -> bool {
    matches!(
        tag,
        "br" | "img" | "hr" | "input" | "meta" | "link" | "base" | "area" | "col" | "embed"
            | "param" | "source" | "track" | "wbr"
    )
}

// ---- the tokenizer -------------------------------------------------------

enum Token {
    Text(String),
    Start(String, Vec<(String, String)>, bool),
    End(String),
}

fn tokenize(html: &str) -> Vec<Token> {
    let bytes = html.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut text_start = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if i > text_start {
            tokens.push(Token::Text(html[text_start..i].to_string()));
        }
        // Comments and declarations carry no content we want.
        if html[i..].starts_with("<!--") {
            match html[i..].find("-->") {
                Some(end) => {
                    i += end + 3;
                    text_start = i;
                    continue;
                }
                None => break,
            }
        }
        if html[i..].starts_with("<!") || html[i..].starts_with("<?") {
            match html[i..].find('>') {
                Some(end) => {
                    i += end + 1;
                    text_start = i;
                    continue;
                }
                None => break,
            }
        }
        // A `<` that does not begin a tag name is text, not markup: browsers
        // read `a < b` as a sentence, and so must this.
        let name_start_ok = match bytes.get(i + 1) {
            Some(byte) if byte.is_ascii_alphabetic() => true,
            Some(b'/') => bytes
                .get(i + 2)
                .map(|byte| byte.is_ascii_alphabetic())
                .unwrap_or(false),
            _ => false,
        };
        if !name_start_ok {
            i += 1;
            continue;
        }
        let Some(close) = find_tag_end(html, i) else {
            // An unclosed `<` is text, not a tag: the sentence survives.
            i += 1;
            continue;
        };
        let inner = &html[i + 1..close];
        i = close + 1;
        text_start = i;
        if let Some(rest) = inner.strip_prefix('/') {
            let name = rest
                .trim()
                .split(|ch: char| ch.is_whitespace())
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if !name.is_empty() {
                tokens.push(Token::End(name));
            }
            continue;
        }
        let self_closing = inner.trim_end().ends_with('/');
        let mut chars = inner.char_indices().peekable();
        let mut name = String::new();
        for (_, ch) in chars.by_ref() {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == ':' || ch == '_' {
                name.push(ch.to_ascii_lowercase());
            } else {
                break;
            }
        }
        if name.is_empty() {
            continue;
        }
        let attrs = parse_attrs(inner, name.len());
        tokens.push(Token::Start(name, attrs, self_closing));
    }
    if text_start < bytes.len() {
        tokens.push(Token::Text(html[text_start..].to_string()));
    }
    tokens
}

/// Finds the `>` that closes a tag, skipping quoted attribute values (which may
/// contain one, as in `alt="a > b"`).
fn find_tag_end(html: &str, start: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut i = start + 1;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let byte = bytes[i];
        match quote {
            Some(q) => {
                if byte == q {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' => quote = Some(byte),
                b'>' => return Some(i),
                _ => {}
            },
        }
        i += 1;
    }
    None
}

fn parse_attrs(inner: &str, name_len: usize) -> Vec<(String, String)> {
    let rest = &inner[name_len..];
    let bytes = rest.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len()
            && !(bytes[i] as char).is_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'/'
        {
            i += 1;
        }
        if i >= bytes.len() || name_start == i && bytes[i] == b'/' {
            break;
        }
        let name = rest[name_start..i].to_ascii_lowercase();
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && (bytes[i] as char).is_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let value_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = rest[value_start..i].to_string();
                i += 1;
            } else {
                let value_start = i;
                while i < bytes.len()
                    && !(bytes[i] as char).is_whitespace()
                    && bytes[i] != b'>'
                {
                    i += 1;
                }
                value = rest[value_start..i].to_string();
            }
        }
        if !name.is_empty() {
            attrs.push((name, value));
        }
    }
    attrs
}

/// The entities mail actually carries. An unknown one is left as written
/// rather than guessed at.
fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let ch = text[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let Some(semi) = text[i..].find(';').filter(|at| *at <= 12) else {
            out.push('&');
            i += 1;
            continue;
        };
        let entity = &text[i + 1..i + semi];
        let decoded = if let Some(hex) = entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(decimal) = entity.strip_prefix('#') {
            decimal.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match entity.to_ascii_lowercase().as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                "copy" => Some('©'),
                "reg" => Some('®'),
                "trade" => Some('™'),
                "hellip" => Some('…'),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "lsquo" => Some('‘'),
                "rsquo" => Some('’'),
                "ldquo" => Some('“'),
                "rdquo" => Some('”'),
                "bull" => Some('•'),
                "middot" => Some('·'),
                "deg" => Some('°'),
                "euro" => Some('€'),
                "pound" => Some('£'),
                "cent" => Some('¢'),
                "sect" => Some('§'),
                "para" => Some('¶'),
                "laquo" => Some('«'),
                "raquo" => Some('»'),
                "times" => Some('×'),
                "divide" => Some('÷'),
                "plusmn" => Some('±'),
                "frac12" => Some('½'),
                "eacute" => Some('é'),
                "egrave" => Some('è'),
                "agrave" => Some('à'),
                "ccedil" => Some('ç'),
                "uuml" => Some('ü'),
                "ouml" => Some('ö'),
                "auml" => Some('ä'),
                "szlig" => Some('ß'),
                "ntilde" => Some('ñ'),
                _ => None,
            }
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                i += semi + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::text::InlineImage;

    fn inline(cid: &str) -> InlineImage {
        InlineImage {
            part: "2".to_string(),
            cid: cid.to_string(),
            mime: "image/png".to_string(),
            size: 10,
        }
    }

    fn text_of(blocks: &[Block]) -> String {
        blocks
            .iter()
            .map(|block| {
                block
                    .spans
                    .iter()
                    .map(|span| span.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn scripts_styles_and_iframes_are_dropped_with_their_content() {
        let blocks = render(
            "<p>Before</p><script>alert('x')</script><style>.a{color:red}</style>\
             <iframe src=\"https://tracker.test\">fallback</iframe><p>After</p>",
            &[],
        );
        let text = text_of(&blocks);
        assert_eq!(text, "Before\nAfter");
        for needle in ["alert", "color", "tracker", "fallback"] {
            assert!(!text.contains(needle), "{needle} survived: {text}");
        }
    }

    #[test]
    fn handlers_and_styles_have_nowhere_to_live() {
        let blocks = render(
            "<p style=\"background:url(https://t.test/x)\" onclick=\"steal()\">Hi</p>\
             <a href=\"javascript:alert(1)\">click</a>",
            &[],
        );
        let text = text_of(&blocks);
        assert_eq!(text, "Hi\nclick");
        // The javascript: href is dropped; the words stay so the sentence reads.
        assert_eq!(blocks[1].spans[0].link, None);
        assert_eq!(blocks[0].spans[0].text, "Hi");
    }

    #[test]
    fn inline_images_resolve_and_remote_ones_become_a_labelled_stand_in() {
        let blocks = render(
            "<p>Logo:</p><img src=\"cid:logo@x\" alt=\"Company\">\
             <img src=\"https://cdn.test/pixel.gif\">\
             <img src=\"cid:missing\" alt=\"Chart\">",
            &[inline("<logo@x>")],
        );
        let images: Vec<&Block> = blocks
            .iter()
            .filter(|block| matches!(block.kind, BlockKind::Image { .. }))
            .collect();
        assert_eq!(images.len(), 3);
        assert_eq!(
            images[0].kind,
            BlockKind::Image {
                alt: "Company".to_string(),
                resolved: true,
                cid: "logo@x".to_string(),
            }
        );
        assert_eq!(
            images[1].kind,
            BlockKind::Image {
                alt: String::new(),
                resolved: false,
                cid: String::new(),
            }
        );
        assert_eq!(
            images[2].kind,
            BlockKind::Image {
                alt: "Chart".to_string(),
                resolved: false,
                cid: "missing".to_string(),
            }
        );
    }

    #[test]
    fn formatting_nests_and_mismatched_tags_do_not_lose_the_text() {
        let blocks = render("<p><b>bold <i>both</i></b> plain</p>", &[]);
        let spans = &blocks[0].spans;
        assert_eq!(spans.len(), 3);
        assert!(spans[0].bold && !spans[0].italic);
        assert!(spans[1].bold && spans[1].italic);
        assert!(!spans[2].bold && !spans[2].italic);
        assert_eq!(text_of(&blocks), "bold both plain");

        // Real mail closes tags in the wrong order; the words still arrive.
        let messy = render("<p><b>bold <i>both</b> italic</p>", &[]);
        assert_eq!(text_of(&messy), "bold both italic");
    }

    #[test]
    fn headings_quotes_lists_and_rules_become_their_own_blocks() {
        let blocks = render(
            "<h2>Title</h2><blockquote><p>Quoted</p><blockquote>Deeper</blockquote></blockquote>\
             <ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol><hr><pre>  indented\nline</pre>",
            &[],
        );
        assert_eq!(blocks[0].kind, BlockKind::Heading { level: 2 });
        assert!(matches!(blocks[1].kind, BlockKind::Quote { depth: 1 }));
        assert!(matches!(blocks[2].kind, BlockKind::Quote { depth: 2 }));
        assert_eq!(
            blocks[3].kind,
            BlockKind::List {
                ordered: false,
                depth: 0,
                index: 0
            }
        );
        assert_eq!(
            blocks[4].kind,
            BlockKind::List {
                ordered: false,
                depth: 0,
                index: 1
            }
        );
        assert_eq!(
            blocks[5].kind,
            BlockKind::List {
                ordered: true,
                depth: 0,
                index: 0
            }
        );
        assert_eq!(blocks[6].kind, BlockKind::Rule);
        assert_eq!(blocks[7].kind, BlockKind::Code);
        assert!(blocks[7].spans[0].text.contains("  indented\nline"));
        assert_eq!(bullet(false, 0), "•");
        assert_eq!(bullet(true, 2), "3.");
    }

    #[test]
    fn links_survive_with_their_href_and_a_br_breaks_the_line() {
        let blocks = render(
            "<p>See <a href=\"https://example.test/a?b=1&amp;c=2\" title=\"there\">the page</a><br>Next line</p>",
            &[],
        );
        let spans = &blocks[0].spans;
        assert_eq!(spans[0].text, "See ");
        assert_eq!(spans[1].text, "the page");
        assert_eq!(
            spans[1].link.as_deref(),
            Some("https://example.test/a?b=1&c=2")
        );
        assert_eq!(spans[1].title.as_deref(), Some("there"));
        assert_eq!(text_of(&blocks), "See the page\nNext line");
    }

    #[test]
    fn entities_and_junk_do_not_break_the_reader() {
        assert_eq!(
            decode_entities("A &amp; B &lt;c&gt; &#65; &#x42; &nbsp;"),
            "A & B <c> A B  "
        );
        assert_eq!(decode_entities("100% &notanentity; ok"), "100% &notanentity; ok");
        // An unclosed tag is text; a stray `<` is not a crash.
        let blocks = render("<p>a < b and <p>unclosed", &[]);
        assert!(text_of(&blocks).contains("a < b"));
    }

    #[test]
    fn an_unreadable_body_is_reported_as_empty() {
        assert!(is_empty(&render("", &[])));
        assert!(is_empty(&render("   \n\t ", &[])));
        // Images and rules are content; an image-only mail is not empty.
        assert!(!is_empty(&render("<img src=\"cid:x\">", &[])));
        assert!(!is_empty(&render("<hr>", &[])));
        assert!(!is_empty(&render("<p>hi</p>", &[])));
    }

    #[test]
    fn a_pathological_body_is_capped_rather_than_unbounded() {
        let html = "<p>x</p>".repeat(MAX_BLOCKS + 50);
        let blocks = render(&html, &[]);
        assert_eq!(blocks.len(), MAX_BLOCKS);
    }
}
