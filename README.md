# Aegis Vault

A local-first, zero-knowledge password vault. Runs in the browser today; the core is
plain TypeScript so it can move into a native app later without touching the cryptography.

```
npm install
npm run dev        # http://localhost:5173
npm test           # crypto + vault unit tests
npm run build      # typecheck and production bundle
```

---

## Security model

The vault password is **optional**. On first run you choose:

- **No vault password** (default) — the vault key is stored directly, so the app opens
  straight into your logins with no prompt. Convenient, but anything that can read this
  browser profile can read your logins.
- **With a vault password** — the key is wrapped with a KEK derived from your password,
  so the stored data is unreadable without it.

Switch between them any time in **Settings → Vault password**. Turning a password on only
wraps the 32-byte vault key, so nothing is re-encrypted.

```
vault password ──PBKDF2-HMAC-SHA256 (600k iters, 16-byte salt)──▶ KEK
                                                                     │
                                                         unwraps (AES-256-GCM)
                                                                     ▼
                                                          VEK  (random 256-bit)
                                                                     │
                                              encrypts every login (AES-256-GCM)
                                                                     ▼
                                                    IndexedDB: item id + ciphertext
```

| Decision | Why |
| --- | --- |
| Two-level key hierarchy | `VEK` does the real work, so changing the vault password only re-wraps 32 bytes. Your logins are never re-encrypted. |
| No password verifier | The wrong password simply fails the GCM tag check. There is no `hash(password)` in storage to attack offline. |
| 600,000 PBKDF2 iterations | NIST SP 800-63B (2024) floor for PBKDF2-HMAC-SHA256. Stored per-vault in the header, so it can be raised later without breaking old vaults. |
| Per-item random 96-bit nonce | Reusing an AES-GCM nonce under one key is catastrophic, so every single seal gets a fresh IV. |
| AAD binds each item to its id | A ciphertext cannot be moved to another row and decrypted there. |
| Domain-separated AAD | A wrapped vault key cannot be replayed as an item, and vice versa. |
| Corrupt records are skipped | One unreadable row does not lock you out of everything else. |

### What this does and does not protect against

Protected: a stolen laptop, a leaked backup file, a malicious extension reading storage,
someone who gets a copy of the IndexedDB contents.

**Not** protected: a compromised OS, a keylogger, an unlocked session while the vault is
open, or a weak vault password that is brute-forced offline. The strength meter is
advisory, not a guarantee.

In passwordless mode the protection is weaker by design — it is the browser's own storage
sandbox and whatever the OS does with the profile. That is the trade for opening the app
without typing anything.

---

## Architecture

```
src/
  crypto/          platform-agnostic, no DOM or framework imports
    bytes.ts         base64url + byte helpers
    vault-crypto.ts  KDF, key wrapping, AEAD seal/open, protection modes
    passwords.ts     generator (rejection sampling) + strength estimate
    totp.ts          RFC 6238 TOTP over Web Crypto HMAC
  vault/           the portable core — no React in here
    types.ts         VaultItem, URL helpers, weak-password detection
    storage.ts       VaultStorage interface + IndexedDB and in-memory backends
    vault-service.ts create / unlock / lock / CRUD / backup
    backup.ts        encrypted export + import file handling
  components/
    react-bits/      vendored + adapted upstream components
      AnimatedList     spring-animated scrolling list (default view)
      CircularCarousel 3D ring carousel (Orbit view)
  ui/              React only
```

### The react-bits components

Both come from the shadcn registry and were vendored from their published source:

```
npx shadcn@latest view @react-bits/AnimatedList-JS-CSS
npx shadcn@latest view @react-bits/CircularCarousel-JS-CSS
```

They use plain CSS, not Tailwind, so no styling framework was pulled in. Changes made to
the upstream source, all listed in each file's header comment:

- JSX → TSX, with types; `AnimatedList` is generic over the item type.
- `AnimatedList`'s hardcoded 500×400 box and demo palette (`#120F17` / `#2F293A`) replaced
  with app tokens, so it follows the active theme. Its classes are prefixed.
- `AnimatedList`'s arrow-key handler no longer listens on `window`, which would have
  hijacked arrow keys across the whole app.
- `CircularCarousel`'s stock Unsplash demo items removed; the vault generates its own card
  artwork as local SVG data URIs, so no network requests.
- **Upstream bug fixed:** `CircularCarousel` reads `s.dir` for autoplay speed and direction,
  but its `settings` object has no `dir` property. That makes `cruise` `NaN` and poisons the
  angle and velocity every frame, so autoplay silently does nothing. Changed to `state.dir`.

### Porting to an app later

The `src/crypto` and `src/vault` folders never import React or touch the DOM, and the only
browser API they rely on is Web Crypto, which maps cleanly onto
`react-native-quick-crypto`, `expo-crypto`, or a platform keystore.

To add a new backend, implement the `VaultStorage` interface (`src/vault/storage.ts:23`) —
SQLite, a file, a keychain — and pass it to `new VaultService(...)`. Nothing above that
interface changes.

---

## Features

- Optional vault password, switchable in Settings; passwordless vaults open with no prompt
- **Per-login theming** — each login gets its own accent hue (auto-derived from its name, or
  picked) and its own background image from a URL or an upload. Text stays legible over any
  photo via a theme-aware scrim plus a text shadow, in both light and dark
- **App background** — your own image as a backdrop, with opacity, blur and dim controls
- Three views — **Flow** (spring-animated cards, default), **Orbit** (3D carousel), **List** —
  switchable from a dropdown beside *New login*, persisted across restarts
- **Right-click anywhere** for a cascading context menu: per-login actions, or app-level
  view/sort/appearance submenus. Fully keyboard navigable.
- **Settings as an in-page window** with nine tabs that slide in from the side
- Calm four-colour accent palette, light/dark/system, density, roundness, text size,
  transparency and contrast controls
- Password generator (random or passphrase) with unbiased character selection, with its
  defaults exposed in Settings
- Password strength meter with an offline-attack crack-time estimate
- Reused-password and stale-password detection under **Needs attention**, with an optional
  warning before you open a site whose password is reused
- TOTP codes generated locally from an authenticator seed
- Favorites, search, five sort orders
- Keyboard-first (`/`, `N`, `L`, `V`, `?`), auto-lock on idle/blur/tab-hide, clipboard auto-clear
- Encrypted backup export/restore (optionally re-keyed or made passwordless), CSV import/export
- Diagnostics report and a one-click preference reset

## Settings

Nine tabs, each a panel that slides in from the side:

| Tab | What it holds |
| --- | --- |
| Appearance | Theme, accent, animation intensity, glow, text size, roundness, density, transparency, high contrast |
| Background | App-wide image from URL or upload, plus opacity / blur / dim |
| Layout | Default view, sort order, show URLs, pin favorites, expand on select, health badges |
| Generator | Default length and character sets |
| Vault password | Enable / change / remove, plus the active crypto parameters |
| Security | Auto-lock, lock on blur, lock on tab hide, clipboard clearing, reveal, reuse warnings, export confirmation |
| Data | Stored size, CSV export/import, delete vault |
| Backup | Encrypted export and restore |
| About | Version, offline confirmation, diagnostics copy, reset preferences |

Preferences are stored unencrypted (they are not secret) and every value is re-validated on
load, so hand-edited or stale data cannot break the UI. That includes migrating the six
loud accent names from an earlier version onto the current calm four.

## Honest limitations

- **A vault password cannot be recovered.** This is what makes the design safe. If you
  enable one and forget it, the vault is gone. Export backups.
- Passwordless mode stores the vault key next to the data. Anyone who can read this
  browser's profile can read your logins.
- The app background image is a plain URL your browser fetches directly, so the image host
  sees the request. Uploads stay on the device but are stored unencrypted in preferences.
- Per-login background **uploads** are stored inside the encrypted record; per-login
  background **URLs** are fetched at render time, so those requests do leave the device.
- Uploads are downscaled to 1600px on the long edge and re-encoded as WebP (JPEG fallback)
  before storage, so a 4 MB phone photo typically lands around 10–40 KB. The size caps
  (2 MB per login, 8 MB for the app background) therefore apply to the compressed result.
- Clearing site data in the browser deletes the vault.
- The clipboard clear is best-effort; browsers gate clipboard access behind permissions.
- The suggested vault password is 7 words from a 150-word list plus 4 digits, which the
  strength meter scores at roughly 60 bits. That is decent, not bulletproof.
- The passphrase word list is only 150 words (≈7 bits each), well below a diceware list.
- Strength estimates assume ~1e11 guesses/second and are rough by nature.
- `CircularCarousel` and `AnimatedList` are vendored third-party components pinned to the
  versions published by the registry, not upgraded automatically.