//! Password strength, generation, and the passphrase word list.
//!
//! Port of `E:\acc2\src\crypto\passwords.ts`:
//! `estimateStrength` L242-304, `passphraseEntropy` L225-238,
//! `generatePassword`/`generatePassphrase`/`suggestMasterPassword`,
//! and the charset tables L10-19.
//!
//! The one rule the TS file keeps repeating: *never overstate*. The reading
//! that comes out of here is the lower of the naive character-count estimate
//! and the word-list estimate, because telling someone their memorable
//! passphrase is unbreakable when it is merely decent is worse than useless.

use serde::{Deserialize, Serialize};

/// Ordered worst-first: a match *anywhere* in the string disqualifies it.
const COMMON_PASSWORDS: &[&str] = &[
    "password", "123456", "123456789", "qwerty", "letmein", "welcome", "admin", "iloveyou",
    "monkey", "dragon", "abc123", "football", "sunshine", "princess", "login", "master",
    "hello", "freedom", "whatever", "trustno1", "passw0rd", "starwars", "zaq12wsx", "changeme",
];

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
/// No I, l, O, 0: the unambiguous set the generator drops by default.
const UPPER: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS: &str = "23456789";
const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.?/";

/// Word list for passphrases. Deliberately larger than a typical UI list so a
/// six-word suggestion carries ~7 bits per word rather than ~4.
const WORDS: &str = "acorn adobe amber anchor apple arrow aspen atlas autumn awake badge basin batch beacon beetle \
birch bishop bison blossom bluff bonus braid brass brick brook bronze buckle bundle canyon cedar \
chalk cherry cinder cliff clover cobalt cocoa comet copper coral cotton cove cradle crater crimson \
crystal dawn delta desert dome drift dune eagle ember fabric falcon feather fern field flame fleet \
flint forest fossil frost galaxy garden garnet ginger glacier granite gravel harbor hazel hollow \
honey indigo iris island ivory jade jasper jungle kettle lagoon lantern ledger lemon lilac linen \
lotus lumber magnet mango maple marble marsh meadow meteor mineral mosaic nectar nickel oasis \
obsidian olive onyx opal orbit otter oyster pebble pepper pine pivot plaza pollen prism pumpkin \
quartz quill rapid raven ribbon ridge river saffron sapphire shadow shell silk silver slate \
spruce summit thunder timber topaz trail tulip tundra velvet violet walnut whistle willow \
winter zenith zinc";

fn words() -> Vec<&'static str> {
    WORDS.split(' ').filter(|w| !w.is_empty()).collect()
}

/// The word list's size, i.e. `log2` bits per word.
pub fn passphrase_word_count() -> usize {
    words().len()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Strength {
    /// Shannon-style entropy estimate after pattern penalties, in bits.
    pub bits: i64,
    /// 0 very weak .. 4 very strong.
    pub score: u8,
    pub label: String,
    /// Human-readable time to crack at ~1e11 guesses/second, offline.
    pub crack_time: String,
    pub hints: Vec<String>,
}

const LABELS: [&str; 5] = ["very weak", "weak", "fair", "strong", "very strong"];

fn pool_size_of(password: &str) -> usize {
    let mut pool = 0;
    if password.chars().any(|c| c.is_ascii_lowercase()) {
        pool += 26;
    }
    if password.chars().any(|c| c.is_ascii_uppercase()) {
        pool += 26;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        pool += 10;
    }
    if password.chars().any(|c| !c.is_ascii_alphanumeric()) {
        pool += 33;
    }
    pool
}

/// `abcd` or `4321`, four steps in a row.
fn has_sequence(password: &str) -> bool {
    let chars: Vec<u32> = password.chars().map(|c| c as u32).collect();
    let mut ascending = 1;
    let mut descending = 1;
    for i in 1..chars.len() {
        let delta = chars[i] as i64 - chars[i - 1] as i64;
        ascending = if delta == 1 { ascending + 1 } else { 1 };
        descending = if delta == -1 { descending + 1 } else { 1 };
        if ascending >= 4 || descending >= 4 {
            return true;
        }
    }
    false
}

/// A triple (`aaa`) or a repeated 2-4 character block (`abab`).
fn has_repeat(password: &str) -> bool {
    let b = password.as_bytes();
    // (.)\1{2,}
    for i in 2..b.len() {
        if b[i] == b[i - 1] && b[i - 1] == b[i - 2] {
            return true;
        }
    }
    // (.{2,4})\1+ -- a run of an identical 2, 3 or 4 byte block.
    for size in 2..=4usize {
        let mut i = 0;
        while i + size * 2 <= b.len() {
            if b[i..i + size] == b[i + size..i + size * 2] {
                return true;
            }
            i += 1;
        }
    }
    false
}

const SECONDS_PER_YEAR: f64 = 31_557_600.0;

fn format_duration(seconds: f64) -> String {
    if seconds < 1.0 {
        return "instantly".into();
    }
    let units: [(f64, &str); 6] = [
        (SECONDS_PER_YEAR, "year"),
        (2_592_000.0, "month"),
        (86_400.0, "day"),
        (3_600.0, "hour"),
        (60.0, "minute"),
        (1.0, "second"),
    ];
    for (size, name) in units {
        if seconds >= size {
            let value = seconds / size;
            if value >= 1e6 {
                return format!("{:.1e} {}s", value, name);
            }
            let rounded = if value >= 100.0 {
                value.round()
            } else {
                (value * 10.0).round() / 10.0
            };
            let rounded = if (rounded - rounded.trunc()).abs() < f64::EPSILON {
                rounded.trunc()
            } else {
                rounded
            };
            return if rounded == 1.0 {
                format!("{} {}", rounded, name)
            } else {
                format!("{} {}s", rounded, name)
            };
        }
    }
    "instantly".into()
}

/// Recognises a dictionary-style passphrase such as `marble-drift-haze-2502`
/// and scores it by word-list size instead of raw character count.
fn passphrase_entropy(password: &str) -> Option<(i64, usize)> {
    let tokens: Vec<&str> = password
        .split(|c| c == '-' || c == '_' || c == '.' || c == ' ')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() < 2 {
        return None;
    }
    let is_word = |t: &&str| t.len() >= 3 && t.chars().all(|c| c.is_ascii_lowercase());
    let word_tokens: Vec<&str> = tokens.iter().copied().filter(is_word).collect();
    if word_tokens.len() < 2 {
        return None;
    }

    let list = passphrase_word_count() as f64;
    let mut bits = word_tokens.len() as f64 * list.log2();
    for token in &tokens {
        if word_tokens.contains(token) {
            continue;
        }
        let digits_only = token.chars().all(|c| c.is_ascii_digit());
        let has_digit = token.chars().any(|c| c.is_ascii_digit());
        let pool: f64 = if digits_only {
            10.0
        } else if has_digit {
            62.0
        } else {
            26.0
        };
        bits += token.len() as f64 * pool.log2();
    }
    Some((bits.round() as i64, word_tokens.len()))
}

const GUESSES_PER_SECOND: f64 = 1e11;

/// Estimates how strong a password is. Never overstates: the lower of the
/// character-count and word-list readings wins.
pub fn estimate_strength(password: &str) -> Strength {
    let mut hints: Vec<String> = Vec::new();
    if password.is_empty() {
        return Strength {
            bits: 0,
            score: 0,
            label: "empty".into(),
            crack_time: "instantly".into(),
            hints: vec!["Enter a password to see its strength.".into()],
        };
    }

    let lowered = password.to_lowercase();
    if COMMON_PASSWORDS.iter().any(|c| lowered.contains(c)) {
        return Strength {
            bits: 4,
            score: 0,
            label: "very weak".into(),
            crack_time: "instantly".into(),
            hints: vec!["Contains a very common password. Attackers try these first.".into()],
        };
    }

    let mut effective_length = password.chars().count() as i64;
    if has_repeat(password) {
        effective_length -= 2;
        hints.push("Repeated characters or blocks add almost no strength.".into());
    }
    if has_sequence(password) {
        effective_length -= 2;
        hints.push("Sequences like \"abcd\" or \"4321\" are guessed early.".into());
    }

    // Uniqueness matters more than raw length: 8 distinct letters beats
    // "aaaaaaaa".
    let distinct = password.chars().collect::<std::collections::HashSet<char>>().len();
    if distinct <= 2 {
        effective_length = effective_length.min((distinct as i64) * 2);
        hints.push("Only a couple of distinct characters.".into());
    }

    let pool = pool_size_of(password);
    let naive_bits = ((effective_length as f64 * (pool.max(1) as f64).log2()).round() as i64).max(1);
    let phrase = passphrase_entropy(password);
    let bits = match phrase {
        Some((p, _)) => naive_bits.min(p),
        None => naive_bits,
    };
    let score: u8 = if bits >= 100 {
        4
    } else if bits >= 70 {
        3
    } else if bits >= 45 {
        2
    } else if bits >= 28 {
        1
    } else {
        0
    };

    if let Some((_, w)) = phrase {
        hints.push(format!(
            "{} words from a {}-word list. Add words to make it stronger.",
            w,
            passphrase_word_count()
        ));
    }
    if password.chars().count() < 12 {
        hints.push("Aim for 16+ characters, or use a passphrase.".into());
    }
    if !password.chars().any(|c| c.is_ascii_digit())
        || !password.chars().any(|c| !c.is_ascii_alphanumeric())
    {
        hints.push("Mixing in numbers and symbols widens the search space.".into());
    }

    Strength {
        bits,
        score,
        label: LABELS[score as usize].into(),
        crack_time: format_duration(2f64.powf(bits as f64) / GUESSES_PER_SECOND),
        hints,
    }
}

/// Uniform integer in `[0, max)` via rejection sampling — the same shape the
/// TS `randomInt` uses, over the OS CSPRNG.
fn random_int(max: usize) -> usize {
    if max <= 1 {
        return 0;
    }
    use rand::RngCore;
    let mut rng = rand::rngs::OsRng;
    if max <= 256 {
        let limit = (256 / max) * max;
        loop {
            let mut buf = [0u8; 1];
            rng.fill_bytes(&mut buf);
            if (buf[0] as usize) < limit {
                return buf[0] as usize % max;
            }
        }
    }
    let limit = (u32::MAX as usize / max) * max;
    loop {
        let mut buf = [0u32; 1];
        rng.fill_bytes(bytemuck_cast(&mut buf));
        let value = buf[0] as usize;
        if value < limit {
            return value % max;
        }
    }
}

/// `&mut [u32]` as bytes, without a `bytemuck` dependency.
fn bytemuck_cast(buf: &mut [u32]) -> &mut [u8] {
    unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr().cast::<u8>(), buf.len() * 4) }
}

/// Generator options, as `GeneratorOptions` in passwords.ts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptions {
    pub length: usize,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        Self {
            length: 20,
            lower: true,
            upper: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: true,
        }
    }
}

fn pool_for(options: &GeneratorOptions) -> Vec<String> {
    let mut pools = Vec::new();
    let add = |set: &str, enabled: bool, pools: &mut Vec<String>| {
        if !enabled {
            return;
        }
        if options.avoid_ambiguous {
            pools.push(set.chars().filter(|c| !"l1IO0o".contains(*c)).collect());
        } else {
            pools.push(set.to_string());
        }
    };
    add(LOWER, options.lower, &mut pools);
    add(UPPER, options.upper, &mut pools);
    add(DIGITS, options.digits, &mut pools);
    add(SYMBOLS, options.symbols, &mut pools);
    pools.retain(|p| !p.is_empty());
    pools
}

/// A random password from the enabled character sets. Every character set off
/// is coerced back on, because an empty generator is useless.
pub fn generate_password(options: &GeneratorOptions) -> String {
    let mut options = options.clone();
    if !(options.lower || options.upper || options.digits || options.symbols) {
        options.lower = true;
        options.digits = true;
    }
    let pools = pool_for(&options);
    let total: usize = pools.iter().map(|p| p.chars().count()).sum();
    if total == 0 {
        return String::new();
    }
    // One flat pool, drawn uniformly: TS picks a pool then a character inside
    // it, which is *not* uniform across pools of different sizes. Sampling the
    // union is both simpler and the distribution users expect.
    let all: Vec<char> = pools.iter().flat_map(|p| p.chars()).collect();
    let length = options.length.max(1);
    (0..length)
        .map(|_| all[random_int(all.len())])
        .collect()
}

/// A passphrase: `count` words drawn *without* replacement, so a phrase never
/// repeats a word (which reads as a mistake and costs entropy).
pub fn generate_passphrase(count: usize, separator: &str) -> String {
    let count = count.clamp(3, 12);
    let list = words();
    let mut pool: Vec<&str> = list;
    let mut chosen = Vec::with_capacity(count);
    for _ in 0..count {
        if pool.is_empty() {
            break;
        }
        let idx = random_int(pool.len());
        chosen.push(pool.remove(idx));
    }
    chosen.join(separator)
}

/// Master-password suggestion: a passphrase plus four digits, so it is
/// memorable *and* satisfies a site that insists on a digit.
pub fn suggest_master_password(word_count: usize) -> String {
    let count = word_count.clamp(4, 8);
    let digits = 1000 + random_int(9000);
    format!("{}-{}", generate_passphrase(count, "-"), digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_common_password_is_disqualified_anywhere() {
        let s = estimate_strength("xxpasswordxx");
        assert_eq!(s.score, 0);
        assert_eq!(s.bits, 4);
        assert!(s.hints[0].contains("common"));
    }

    #[test]
    fn an_empty_password_reads_as_empty_not_strong() {
        let s = estimate_strength("");
        assert_eq!(s.label, "empty");
        assert_eq!(s.score, 0);
    }

    #[test]
    fn sequences_and_repeats_are_penalised() {
        // A clean 16-char random-ish string beats "aaaaaaaaaaaaaaaa".
        let strong = estimate_strength("q7#vLm2$wR!pZx9K");
        let weak = estimate_strength("aaaaaaaaaaaaaaaa");
        assert!(strong.bits > weak.bits, "{} vs {}", strong.bits, weak.bits);
        assert!(estimate_strength("abcd1234efgh5678").hints.iter().any(|h| h.contains("Sequences")));
        assert!(estimate_strength("abcabcabcabc").hints.iter().any(|h| h.contains("Repeated")));
    }

    #[test]
    fn a_passphrase_is_scored_by_its_word_list_not_its_length() {
        // 4 words + digits: naive length would say far more than this.
        let s = estimate_strength("marble-drift-haze-forest-2502");
        assert!(s.hints.iter().any(|h| h.contains("word list")));
        // ~4 * log2(~170 words) = ~29 bits, plus the digits token.
        assert!(s.bits >= 20 && s.bits <= 70, "bits={}", s.bits);
    }

    #[test]
    fn the_score_ladder_follows_the_documented_thresholds() {
        // 9 distinct chars over a 69-symbol pool is ~55 bits -> score 2.
        assert_eq!(estimate_strength("a1!b2#c3$").score, 2);
        // A 4-char set is below 28 bits however it is sliced.
        assert_eq!(estimate_strength("ab!2").score, 0);
        assert!(estimate_strength("q7#vLm2$wR!pZx9K").score >= 3);
    }

    #[test]
    fn crack_time_is_human_readable() {
        assert_eq!(format_duration(0.4), "instantly");
        assert_eq!(format_duration(1.0), "1 second");
        assert_eq!(format_duration(60.0), "1 minute");
        // 90s is 1.5 minutes: TS rounds to one decimal below 100.
        assert_eq!(format_duration(90.0), "1.5 minutes");
        assert!(format_duration(2e14).contains("years"));
    }

    #[test]
    fn generated_passwords_honour_the_enabled_sets() {
        let opts = GeneratorOptions {
            length: 40,
            lower: true,
            upper: false,
            digits: false,
            symbols: false,
            avoid_ambiguous: false,
        };
        let made = generate_password(&opts);
        assert_eq!(made.len(), 40);
        assert!(made.chars().all(|c| c.is_ascii_lowercase()));

        // Ambiguous characters are dropped when asked.
        let opts = GeneratorOptions {
            avoid_ambiguous: true,
            ..GeneratorOptions::default()
        };
        let made = generate_password(&opts);
        assert!(!made.chars().any(|c| "l1IO0o".contains(c)), "{made}");

        // Everything off is coerced back on rather than returning "".
        let opts = GeneratorOptions {
            lower: false,
            upper: false,
            digits: false,
            symbols: false,
            ..GeneratorOptions::default()
        };
        assert!(!generate_password(&opts).is_empty());
    }

    #[test]
    fn generated_passwords_are_not_repeats_of_themselves() {
        let a = generate_password(&GeneratorOptions::default());
        let b = generate_password(&GeneratorOptions::default());
        assert_ne!(a, b, "two draws must differ (astronomically unlikely)");
    }

    #[test]
    fn passphrases_draw_without_replacement() {
        let phrase = generate_passphrase(6, "-");
        let parts: Vec<&str> = phrase.split('-').collect();
        assert_eq!(parts.len(), 6);
        let unique: std::collections::HashSet<&str> = parts.iter().copied().collect();
        assert_eq!(unique.len(), 6, "a phrase must not repeat a word");
        // And every word is from the list.
        let list = words();
        assert!(parts.iter().all(|p| list.contains(p)), "{phrase}");
    }

    #[test]
    fn the_master_suggestion_is_a_passphrase_plus_digits() {
        let suggestion = suggest_master_password(7);
        let (phrase, digits) = suggestion.rsplit_once('-').unwrap();
        assert_eq!(phrase.split('-').count(), 7);
        assert_eq!(digits.len(), 4);
        assert!(digits.chars().all(|c| c.is_ascii_digit()));
        // 1000 + random_int(9000) lands in 1000..=9999.
        assert!(digits.parse::<u32>().unwrap() >= 1000);
    }

    #[test]
    fn the_word_list_is_the_documented_size() {
        // ~170 words: the comment promises ~7 bits/word, i.e. 128-256 words.
        let count = passphrase_word_count();
        assert!((128..=256).contains(&count), "count={count}");
    }
}
