//! The app background's picture: reading an uploaded photo, decoding a stored
//! one, and blurring it.
//!
//! The web gets all three from the browser: `<input type=file>` hands the
//! component a `File`, a canvas downscales and re-encodes it, and CSS paints
//! it with `background-size: cover` plus `filter: blur(Npx)`. Nothing here has
//! a browser, so:
//!
//! * reading is `read_image_data_url` — decode, downscale to `MAX_IMAGE_EDGE`,
//!   re-encode as JPEG and wrap in the same `data:` URL the TS stores. JPEG
//!   rather than the TS's WebP: `image`'s WebP encoder is lossy-only and not
//!   worth a second codec path for a file the app itself re-reads;
//! * decoding is `decode_source` — a `data:` URL or a local file path. An
//!   `http(s)` URL is *not* fetched: this app makes no network request for a
//!   picture, so nothing can leak an IP just because a login carries a URL;
//! * blurring is `slint_background`, which blurs the pixels before handing
//!   them to Slint. Slint rectangles have no filter chain, so the CSS's
//!   `filter: blur()` has to happen here instead.
//!
//! The four error strings are `readImageFile`'s own (card-art.ts L130), so a
//! user sees the sentence the web app would have shown.

use std::path::Path;

use base64::Engine as _;
use image::RgbaImage;

/// `MAX_APP_BACKGROUND_BYTES` (types.ts L101): the cap on the *encoded* data
/// URL, so it can be generous.
pub const MAX_APP_BACKGROUND_BYTES: usize = 8_000_000;
/// `MAX_IMAGE_EDGE` (types.ts L104): anything larger is downscaled first.
pub const MAX_IMAGE_EDGE: u32 = 1600;
/// The TS refuses absurd inputs before decoding them (card-art.ts L134).
const MAX_INPUT_BYTES: u64 = 40_000_000;

/// The extensions a file dialog may hand us. The web reads `File.type`; a
/// native picker gives a path, so the check is on the name — and then the
/// decoder gets the last word anyway.
const IMAGE_EXTENSIONS: [&str; 10] = [
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "ico", "avif",
];

/// Read a picked image into the data URL a preference stores: decode,
/// downscale to `MAX_IMAGE_EDGE`, re-encode as JPEG at the TS's quality for
/// its pixel budget, base64 it, and refuse anything still over `max_bytes`.
pub fn read_image_data_url(path: &Path, max_bytes: usize) -> Result<String, String> {
    let name = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&name.as_str()) {
        return Err("That file is not an image.".into());
    }
    let input_bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if input_bytes > MAX_INPUT_BYTES {
        return Err("That image is too large to process. Try one under 40 MB.".into());
    }

    let decoded = image::open(path).map_err(|_| "That file could not be decoded as an image.".to_string())?;
    let mut rgba = decoded.to_rgba8();
    if rgba.width().max(rgba.height()) > MAX_IMAGE_EDGE {
        rgba = downscale(rgba, MAX_IMAGE_EDGE);
    }

    let quality = quality_for(u64::from(rgba.width()) * u64::from(rgba.height()));
    let encoded = encode_jpeg(&rgba, quality)
        .ok_or_else(|| "Could not process that image.".to_string())?;
    let data_url = format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&encoded)
    );
    if data_url.len() > max_bytes {
        return Err(format!(
            "That image is still {} KB after compressing. The limit is {} KB.",
            data_url.len() / 1000,
            max_bytes / 1000
        ));
    }
    Ok(data_url)
}

/// The TS's `encodeLargest` budget (card-art.ts L182): the bigger the picture,
/// the harder it is compressed, because the cap is on the result.
fn quality_for(pixels: u64) -> u8 {
    if pixels > 1_200_000 {
        72
    } else if pixels > 600_000 {
        80
    } else {
        86
    }
}

/// Scale so the longest edge lands on `edge`, the same rounding the canvas
/// does (`Math.round(naturalWidth * scale)`, card-art.ts L144).
fn downscale(rgba: RgbaImage, edge: u32) -> RgbaImage {
    let longest = rgba.width().max(rgba.height());
    let scale = f64::from(edge) / f64::from(longest);
    let width = ((f64::from(rgba.width()) * scale).round() as u32).max(1);
    let height = ((f64::from(rgba.height()) * scale).round() as u32).max(1);
    image::imageops::resize(&rgba, width, height, image::imageops::FilterType::Triangle)
}

fn encode_jpeg(rgba: &RgbaImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode_image(&image::DynamicImage::ImageRgba8(rgba.clone()))
        .ok()?;
    Some(out)
}

/// Decode a stored background source into pixels: a `data:` URL, a local file
/// path — or nothing at all for an `http(s)` URL, which this app does not
/// fetch.
pub fn decode_source(src: &str) -> Option<RgbaImage> {
    let src = src.trim();
    if src.is_empty() {
        return None;
    }
    if let Some(rest) = src.strip_prefix("data:") {
        // `data:image/jpeg;base64,....`
        let (meta, payload) = rest.split_once(',')?;
        if !meta.contains("base64") {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(payload).ok()?;
        return image::load_from_memory(&bytes).ok().map(|decoded| decoded.to_rgba8());
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        return None;
    }
    image::open(Path::new(src)).ok().map(|decoded| decoded.to_rgba8())
}

/// The picture Slint should paint, blurred by `blur` pixels if asked. `None`
/// means there is nothing to paint (or nothing this app can decode), and the
/// window keeps its own background.
///
/// The decoded pixels are kept beside their source for the next call: a blur
/// drag changes one dial at a time, and decoding the whole photo again for
/// each step would be the most expensive thing on the frame. One picture
/// (at most `MAX_IMAGE_EDGE` on its long edge) is held for the process.
pub fn slint_background(src: &str, blur: f64) -> Option<slint::Image> {
    let src = src.trim().to_string();
    thread_local! {
        static LAST_DECODED: std::cell::RefCell<Option<(String, RgbaImage)>> =
            const { std::cell::RefCell::new(None) };
    }
    LAST_DECODED.with(|cell| {
        let mut cache = cell.borrow_mut();
        if cache.as_ref().map(|(key, _)| key != &src).unwrap_or(true) {
            *cache = Some((src.clone(), decode_source(&src)?));
        }
        let (_, rgba) = cache.as_ref().expect("the decode above filled it");
        let rgba = if blur >= 0.5 {
            image::imageops::blur(rgba, blur as f32)
        } else {
            rgba.clone()
        };
        Some(to_slint(rgba))
    })
}

fn to_slint(rgba: RgbaImage) -> slint::Image {
    let (width, height) = rgba.dimensions();
    let mut buffer = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::new(width, height);
    buffer.make_mut_bytes().copy_from_slice(rgba.as_raw());
    slint::Image::from_rgba8(buffer)
}

/// Which picture the app should paint, and with which three dials.
///
/// `applyChannelAppearance` (hooks.ts L434): a channel that carries its own
/// photo supplies its opacity, blur and dim with it; a channel without one
/// borrows the preference's photo *and* its three values, so the app-wide
/// picture renders exactly as it always did.
pub fn background_of(
    prefs: &colax_core::VaultPreferences,
    channel: Option<&colax_core::Channel>,
) -> Option<(String, f64, f64, f64)> {
    let own = channel.map(|channel| channel.background_image.as_str()).unwrap_or("");
    if !own.is_empty() {
        let channel = channel.expect("an own image implies a channel");
        return Some((
            own.to_string(),
            channel.background_opacity,
            channel.background_blur,
            channel.background_dim,
        ));
    }
    if prefs.background_image.is_empty() {
        return None;
    }
    Some((
        prefs.background_image.clone(),
        prefs.background_opacity,
        prefs.background_blur,
        prefs.background_dim,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat picture with one bright pixel, written where the reader can find
    /// it: what a user's upload looks like to this module.
    fn write_png(name: &str, width: u32, height: u32) -> std::path::PathBuf {
        let mut image = RgbaImage::new(width, height);
        for pixel in image.pixels_mut() {
            *pixel = image::Rgba([20, 40, 60, 255]);
        }
        image.put_pixel(0, 0, image::Rgba([200, 210, 220, 255]));
        let path = std::env::temp_dir().join(format!("colax-art-{name}-{}.png", std::process::id()));
        image.save(&path).expect("the fixture writes");
        path
    }

    #[test]
    fn a_non_image_name_is_refused_by_name() {
        let path = std::env::temp_dir().join("colax-art-not-an-image.txt");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(
            read_image_data_url(&path, MAX_APP_BACKGROUND_BYTES),
            Err("That file is not an image.".into())
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_reader_re_encodes_and_lands_inside_the_cap() {
        let path = write_png("reader", 40, 20);
        let url = read_image_data_url(&path, MAX_APP_BACKGROUND_BYTES).expect("a small png reads");
        assert!(url.starts_with("data:image/jpeg;base64,"), "{url}");
        let decoded = decode_source(&url).expect("the data url decodes again");
        assert_eq!(decoded.dimensions(), (40, 20));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_oversized_result_says_how_big_it_still_is() {
        let path = write_png("oversized", 64, 64);
        // A cap of one byte: no JPEG fits, and the sentence is the TS's.
        let error = read_image_data_url(&path, 1).expect_err("nothing fits in one byte");
        assert!(error.starts_with("That image is still "), "{error}");
        assert!(error.ends_with("KB after compressing. The limit is 0 KB."), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_url_is_not_fetched_and_a_missing_file_decodes_to_nothing() {
        assert!(decode_source("https://example.com/photo.jpg").is_none());
        assert!(decode_source("/nowhere/at/all.png").is_none());
        assert!(decode_source("").is_none());
        assert!(slint_background("https://example.com/photo.jpg", 0.0).is_none());
    }

    #[test]
    fn the_blur_runs_over_the_pixels_the_css_would_have_blurred() {
        let path = write_png("blur", 32, 32);
        let url = read_image_data_url(&path, MAX_APP_BACKGROUND_BYTES).unwrap();
        let sharp = decode_source(&url).unwrap();
        let blurred = image::imageops::blur(&sharp, 6.0);
        // The bright corner pixel has spread into its neighbour, and the size
        // is untouched: exactly what `filter: blur(6px)` does to the layer.
        assert_ne!(blurred.get_pixel(1, 0), sharp.get_pixel(1, 0));
        assert_eq!(blurred.dimensions(), sharp.dimensions());
        assert!(slint_background(&url, 6.0).is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_channel_photo_brings_its_own_dials() {
        let mut prefs = colax_core::VaultPreferences::default();
        assert!(background_of(&prefs, None).is_none());

        prefs.background_image = "data:image/jpeg;base64,AAAA".into();
        prefs.background_blur = 12.0;
        let plain = background_of(&prefs, None).expect("the preference's photo");
        assert_eq!(plain.1, prefs.background_opacity);
        assert_eq!(plain.2, 12.0);

        let mut channel = colax_core::Channel::default();
        channel.id = "work".into();
        // No photo of its own: the preference's, dials included.
        let borrowed = background_of(&prefs, Some(&channel)).expect("borrowed");
        assert_eq!(borrowed.0, prefs.background_image);
        assert_eq!(borrowed.2, 12.0);

        // Its own photo: its own three values, as `applyChannelAppearance`
        // reads them.
        channel.background_image = "data:image/jpeg;base64,BBBB".into();
        channel.background_blur = 0.0;
        channel.background_dim = 0.8;
        let own = background_of(&prefs, Some(&channel)).expect("own");
        assert_eq!(own.0, "data:image/jpeg;base64,BBBB");
        assert_eq!(own.2, 0.0);
        assert_eq!(own.3, 0.8);
    }
}
