//! Small shared helpers: time, and JavaScript-shaped coercions used by the
//! normalisers so `Boolean(x)`/`String(x)` behave the way the TS originals did.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// Milliseconds since the Unix epoch — `Date.now()` in JS.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RFC 3339 timestamp for `exportedAt` (`new Date().toISOString()` in TS).
pub fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00+00:00".to_string())
}

/// JavaScript truthiness: `false`, `null`, `0` and `""` are falsy; missing
/// values should never reach here (callers use `Option`), and objects or
/// arrays are always truthy, even empty ones.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `String(value)` for the shapes the normalisers care about.
/// Returns `None` for `null`/objects/arrays — callers treat that as "use the
/// default", which is what `?? ''` did after a falsy check in TS.
pub fn js_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(match n.as_i64() {
            Some(i) => i.to_string(),
            None => n.as_f64().map(format_js_f64).unwrap_or_default(),
        }),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// JS number-to-string for the cases `String(x)` would see. Doubles use Rust's
/// shortest representation, which matches JavaScript's for every value the
/// vault stores (timestamps, hues, day counts).
fn format_js_f64(f: f64) -> String {
    if f == 0.0 {
        return if f.is_sign_negative() {
            "-0".into()
        } else {
            "0".into()
        };
    }
    format!("{f}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_js() {
        assert!(!js_truthy(&json!(false)));
        assert!(!js_truthy(&Value::Null));
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&json!(0.0)));
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!("0")), "the string \"0\" is truthy in JS");
        assert!(js_truthy(&json!(1)));
        assert!(js_truthy(&json!(-1)));
        assert!(js_truthy(&json!([])), "empty array is truthy");
        assert!(js_truthy(&json!({})), "empty object is truthy");
    }

    #[test]
    fn string_coercion_covers_the_cases_the_normalisers_need() {
        assert_eq!(js_string(&json!("hi")).as_deref(), Some("hi"));
        assert_eq!(js_string(&json!(42)).as_deref(), Some("42"));
        assert_eq!(js_string(&json!(1.5)).as_deref(), Some("1.5"));
        assert_eq!(js_string(&json!(true)).as_deref(), Some("true"));
        assert_eq!(js_string(&Value::Null), None);
        assert_eq!(js_string(&json!({})), None);
    }

    #[test]
    fn iso_timestamps_parse_as_rfc3339() {
        let now = now_iso();
        time::OffsetDateTime::parse(&now, &time::format_description::well_known::Rfc3339)
            .expect("now_iso must produce parseable RFC 3339");
        assert!(now_ms() > 1_700_000_000_000, "sanity: post-2023 clock");
    }
}
