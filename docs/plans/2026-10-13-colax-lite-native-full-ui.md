# Colax Lite Native — Full UI Port Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the entire Colax web app (`E:\acc2`) as the fully native Rust + Slint desktop app in `E:\acc2\colax-lite-native`, feature-for-feature including the mail engine — no WebView2, no Chromium, no Node.

**Architecture:** `crates/colax-core` grows from a vault engine into the complete domain layer (crypto, model, preferences, channels, health, history, TOTP, generator, site intel, CSV, mail-cache shape). `app/colax-lite` grows from an 8-screen Slint file into a module tree of screens over one shell, with Rust as the state machine exactly as it is today: Slint renders what it is told and reports what the user did; every state transition lives in Rust.

**Tech Stack:** Rust 2021 · Slint 1.18.1 · `aes-gcm`/`pbkdf2`/`hmac`/`sha2`/`sha1` · `serde`/`serde_json` · `rand` · `time` · `imap` + `mailparse` + `encoding_rs` · `ureq` · `ammonia` · `csv` · `qrcode` · `image` · `rodio` · `windows-sys`.

---

## 0. The one rule for every task in this plan

**The TypeScript in `E:\acc2\src` is the specification. Port it; do not reinterpret it.**

Every behavioural question — default value, clamp range, message string, sort tie-break, coercion rule — is already answered in the TS source. When this plan says "port `X`", read the TS file listed, reproduce its behaviour in Rust, and prove parity with a test that runs both sides or asserts the TS fixture.

Two existing artefacts prove this approach works and must be kept green:

- `crates/colax-core/tests/fixtures/ts-vault-backup.json` — a backup written by the **real** TS `VaultService` at 600k iterations, restored by Rust in `crates/colax-core/tests/engine.rs`.
- `crates/colax-core/scripts/make-ts-fixture.mjs` — regenerates that fixture from `E:\acc2\lite version\src`. Extend this pattern: any time you port a pure function with fixture-able output, generate a TS fixture and assert Rust matches it byte for byte.

Do **not** delete or rewrite existing native work. `colax-core` and the 8 existing screens are correct and must keep passing their tests.

---

## 1. What exists today

### Source (`E:\acc2`) — 69 files, ~31,578 lines in `src/`

| Area | Path | Notes |
| --- | --- | --- |
| UI | `src/ui/` (44 files) | `App.tsx` 3,633 · `Settings.tsx` 2,711 · `views.tsx` 1,587 · `ItemEditor.tsx` 1,096 · `Dashboard.tsx` 1,021 |
| Core | `src/crypto/` (5 files) | `vault-crypto.ts`, `passwords.ts`, `security.ts`, `totp.ts`, `bytes.ts` |
| Core | `src/vault/` (7 files) | `storage.ts` 1,523 (the prefs schema), `channels.ts` 779, `site-intel.ts` 570, `optimize.ts` 346, `vault-service.ts` 326, `types.ts` 320, `backup.ts` |
| Lib | `src/lib/` (5 files) | `platform.ts` (the porting seam), `oauth.ts`, `mail-text.ts`, `mail-providers.ts`, `activity.ts` |
| Style | `src/styles/tokens.css` (413), `src/styles/app.css` (2,066) | plain global CSS, custom properties, no framework |
| Shell | `electron/` (`main.ts`, `preload.ts`, `mail-imap.ts`, `oauth.ts`) | Node-only mail + OAuth; **this is what `imap`/`ureq` replace** |
| Tests | `test/*.test.ts` (26 files) | Node's built-in runner, pure logic only — the behavioural spec for the ports |

### Target (`E:\acc2\colax-lite-native`) — already working, untracked in git

```
Cargo.toml                      workspace: crates/colax-core, app/colax-lite
crates/colax-core/
  src/{lib,bytes,crypto,engine,error,model,storage,util}.rs
  tests/engine.rs               17 integration tests incl. TS-fixture restore
  tests/fixtures/ts-vault-backup.json
app/colax-lite/
  Cargo.toml                    slint 1.18.1, dirs, windows-sys
  build.rs                      slint_build + winres icon
  ui/main.slint                 818 lines, 8 screens, Btn/Field/Alert/Theme globals
  src/main.rs                   892 lines: ShellState, autostart, window chrome, all flows
  src/platform.rs               166 lines: Win32 clipboard + GetOpenFileNameW
packaging/{colax-lite.nsi,build-installer.ps1}
scripts/make-ts-fixture.mjs
```

`build-log.txt` shows a clean dev build. `target/` is populated (8.65 GB). Two installers ship at the folder root.

### The parity gap (verified, not guessed)

`colax-core` **has**: PBKDF2/AES-GCM crypto, header resolve/rewrap, `VaultEngine` CRUD + backup import/export, `VaultItem` model + normalisers, atomic `vault.json` storage — all byte-compatible with TS.

`colax-core` **lacks**: password generation, strength estimation, TOTP code generation, answer/passcode hashing, health analysis, channels/folders/tags, the preferences schema (it is an opaque `serde_json::Value` defaulting to `{}`), history, site-intel, optimize, CSV, mail-cache shape, `relative_time`/`hostname_of`, and the `VaultItem.showMail`/`mailFilter` fields.

The Slint UI **has**: first-run create (device/password), unlock, import, list + search, copy password, lock, tray, autostart, close-to-tray.

The Slint UI **lacks**: everything else — item CRUD, four views, sidebar, editor, settings, dashboard, history, security gate/form, context menus, shortcuts, docks, alarms, mail, appearance.

---

## 2. Architecture decisions

### ADR-1 — Extend `colax-core`; do not split it

All new pure logic goes into `colax-core` as new modules. The crate charter is already "crypto, model, normalisers, storage. No UI." Preferences, channels and health are normalisers and pure logic, so they belong. The added deps (`csv`, `regex`, `url`, `sha1`, `data-encoding`, `unicode-normalization`, `subtle`) are all small, pure-Rust and offline.

*Alternative considered:* a second `colax-logic` crate. Rejected — it would need `VaultItem` and `VaultError`, so it would depend on `colax-core` anyway, and the split buys nothing while adding a re-export layer to keep straight.

### ADR-2 — Rust computes the palette; Slint only consumes it

The web app derives colours from `hsl(var(--accent-h) ...)` in CSS. Slint has no `hsl()` construction builtin, and the existing native code already does this right: `main.rs:314 tile_color()` computes HSL→RGB in Rust and passes a `slint::Color`.

So: one `Theme` global in Slint holds `in-out` colour properties. A single Rust function `apply_appearance(ui, &prefs)` mirrors `src/ui/hooks.ts:applyAppearance()` and pushes the fully resolved palette. Same for density, roundness, text scale, contrast and transparency — all resolved in Rust, all pushed once.

This keeps `ui/theme.slint` free of branching (matching the tokens.css comment: *"Components never branch on theme"*).

### ADR-3 — Split `main.slint` before adding screens

818 lines is already at the limit of one file, and this plan adds roughly 6,000 more. Slint supports `import { X } from "path.slint";` and `slint_build::compile` resolves transitive imports, so split first, then grow:

```
app/colax-lite/ui/
  theme.slint          Theme global + palette structs + derived metrics
  widgets.slint        Btn, Field, Toggle, Select, Slider, Modal, Alert, Toast,
                       Segmented, Chip, Badge, Tile, StrengthMeter, EmptyState,
                       SectionCard, Checkbox, RadioRow, IconButton, Divider
  models.slint         every struct passed across the boundary
  shell.slint          MainWindow root: sidebar + topbar + content + dock + overlays
  screens/
    lock.slint         the 8 existing auth screens (moved verbatim)
    list.slint         Flow / Orbit / List / Grid
    editor.slint       ItemEditor + Generator
    settings.slint     SettingsWindow + tabs
    security.slint     SecurityGate + SecurityForm
    dashboard.slint    Dashboard
    history.slint      HistoryPanel
    mail.slint         MailCenter + Mailbox + message list + body
    menus.slint        cascading context menu + view menu
    dialogs.slint      confirm / bulk / capture / shortcuts / appearance tuner
  main.slint           imports everything; exports MainWindow + AppTray (entry point)
```

`build.rs` keeps pointing at `ui/main.slint` unchanged.

### ADR-4 — Split `main.rs` before adding handlers

892 lines today; this plan adds several thousand. Same treatment:

```
app/colax-lite/src/
  main.rs        wiring only: build UI, register callbacks, run loop
  shell.rs       ShellState, read/write state, autostart, find/focus window (moved)
  state.rs       AppState, Shared, vault_path, startup/lock screen choice, goto, notice
  platform.rs    clipboard, open/save dialogs, external links (exists, extended)
  appearance.rs  apply_appearance, tile_color, hue maths
  items.rs       row/card model building, search, sort, filters
  item_ops.rs    add/update/delete/restore/favourite/attention/bulk
  security_ops.rs gate verification, auto-lock timer, clipboard clear/watch
  settings_ops.rs per-tab handlers
  mail/          mod.rs, imap.rs, oauth.rs, mime.rs, providers.rs
  shortcuts.rs   global key handling, dock keys, sidebar Alt+1..9
  menus.rs       context-menu tree construction
  alarms.rs      1 s tick, chime
  render.rs      --render-check screen walker (UI regression harness)
```

The existing rule stays: *engine work happens in a short borrow, UI properties are set afterwards*, because setting `screen` re-enters handlers.

### ADR-5 — Mail runs on a worker thread, not an async runtime

The Electron shell used Node `imapflow` in the main process. Slint's event loop is synchronous and adding `tokio` would drag a runtime into a binary whose release profile is tuned for size (`lto`, `opt-level="s"`, `panic="abort"`).

Use the synchronous `imap` crate on one dedicated `std::thread::worker`, with `std::sync::mpsc` channels to and from the UI, and `slint::Timer` to poll the receive side. `ureq` (also sync) handles OAuth token exchange on the same thread. This mirrors the Electron design — one persistent connection per mailbox, retry logic — without a runtime.

### ADR-6 — A `--render-check` harness is the UI test strategy

Slint has no unit-test story for widgets, and the Electron build already solved this: `npm run check:render` boots and validates rendering. Mirror it:

`colax-lite.exe --render-check` walks every screen/dialog/tab in a fixed list, sets the properties each needs, snapshots the resulting property tree to stdout as JSON, and exits non-zero on any panic, missing model, or layout overflow. Store golden JSON under `app/colax-lite/tests/golden/`. Run it in CI and before every commit that touches `ui/`.

Core logic stays under `cargo test` (TDD, as the skill requires). UI work is verified by `cargo build` + `cargo test` + `--render-check`.

---

## 3. New dependencies

### `crates/colax-core/Cargo.toml`

| Crate | Version | Replaces / provides | TS origin |
| --- | --- | --- | --- |
| `sha1` | `0.10` | TOTP HMAC-SHA1 | `src/crypto/totp.ts:35-44` |
| `data-encoding` | `2` | `BASE32_NOPAD` | `src/crypto/totp.ts:9`, `security.ts:69-102` |
| `unicode-normalization` | `1` | NFKD for answers | `src/crypto/security.ts:203` |
| `subtle` | `2` | constant-time compare | `src/crypto/bytes.ts:50` |
| `csv` | `1` | RFC 4180 import/export | `src/ui/Settings.tsx:422-489` |
| `url` | `2` | WHATWG `new URL` | `src/vault/types.ts:270`, `site-intel.ts:175` |
| `regex` | `1` | HTML stripping, site intel | `src/lib/mail-text.ts:186-232` |

`hmac` and `pbkdf2` are already declared but unused by `colax-core` — they become used here.

### `app/colax-lite/Cargo.toml`

| Crate | Version | Provides | TS origin |
| --- | --- | --- | --- |
| `imap` | `4` | IMAP client (sync) | `electron/mail-imap.ts` |
| `native-tls` | `0.2` | IMAP STARTTLS/SSL | same |
| `mailparse` | `0.15` | MIME tree + transfer decode | `src/lib/mail-text.ts` |
| `encoding_rs` | `0.8` | WHATWG charset labels | `mail-text.ts:156-182` |
| `ammonia` | `4` | HTML sanitiser (DOMPurify) | `src/ui/FullMail.tsx:16,38,89` |
| `ureq` | `2` | OAuth token exchange | `electron/oauth.ts` |
| `qrcode` | `0.14` | otpauth QR | `src/ui/SecurityForm.tsx:70` |
| `image` | `0.25` | decode + resize uploads | `src/ui/card-art.ts:130-190` |
| `webp` | `0.3` | lossy WebP encode | same |
| `rodio` | `0.19` | alarm chime + sounds | `src/ui/useAlarms.ts:33-71` |
| `base64` | `0.22` | data-URL images | workspace already declares it |

Clipboard read/clear and save dialogs are **not** new crates: `src/platform.rs` already hand-rolls Win32 clipboard and `GetOpenFileNameW`, so extend it with `GetClipboardText`-equivalent and `GetSaveFileNameW`. `arboard`/`rfd` remain the documented fallback if the hand-rolled path proves brittle.

**Deliberately not added:** `notify-rust` (the TS app uses in-app toasts only), `tokio` (ADR-5), `chrono` (`time` is already a dep; add `time-tz` only if alarm local-time conversion needs zone data).

---

## 4. Target layout

```
E:\acc2\colax-lite-native\
├── Cargo.toml                        +[profile] unchanged; add nothing
├── crates\colax-core\
│   ├── Cargo.toml                    +7 deps
│   ├── src\
│   │   ├── lib.rs                    +re-export every new module
│   │   ├── bytes.rs                  (exists)
│   │   ├── crypto.rs                 (exists)
│   │   ├── engine.rs                 +export_backup carries preferences
│   │   ├── error.rs                  (exists)
│   │   ├── model.rs                  +show_mail, +mail_filter
│   │   ├── storage.rs                (exists)
│   │   ├── util.rs                   (exists)
│   │   ├── passwords.rs              NEW  generate + strength
│   │   ├── totp.rs                   NEW  base32, code, seconds, otpauth
│   │   ├── security.rs               NEW  answers, passcode, security_level
│   │   ├── health.rs                 NEW  weak / stale / reused
│   │   ├── channels.rs               NEW  Channel, Tag, Folder, SidebarEntry
│   │   ├── prefs.rs                  NEW  VaultPreferences + defaults + normalise
│   │   ├── history.rs                NEW  HistoryEvent + append + trim
│   │   ├── site_intel.rs             NEW  capture, verdict, tag suggestions
│   │   ├── optimize.rs               NEW  OptimizeStyle, profiles, presets
│   │   ├── csv_io.rs                 NEW  export / import
│   │   └── text.rs                   NEW  relative_time, hostname_of, dates
│   ├── tests\
│   │   ├── engine.rs                 (exists) must stay green
│   │   ├── passwords.rs              NEW
│   │   ├── totp.rs                   NEW
│   │   ├── security.rs               NEW
│   │   ├── prefs.rs                  NEW
│   │   ├── channels.rs               NEW
│   │   ├── health.rs                 NEW
│   │   └── fixtures\                 +ts-prefs.json, +ts-totp.json, …
│   └── scripts\make-ts-fixture.mjs   extended to emit the new fixtures
├── app\colax-lite\
│   ├── Cargo.toml                    +11 deps
│   ├── build.rs                      unchanged
│   ├── ui\
│   │   ├── main.slint                entry point, thin
│   │   ├── theme.slint               NEW
│   │   ├── widgets.slint             NEW
│   │   ├── models.slint              NEW
│   │   ├── shell.slint               NEW
│   │   └── screens\*.slint           NEW (10 files)
│   ├── src\
│   │   ├── main.rs                   wiring only
│   │   ├── shell.rs                  NEW (moved)
│   │   ├── state.rs                  NEW (moved + grown)
│   │   ├── platform.rs               extended
│   │   ├── appearance.rs             NEW
│   │   ├── items.rs                  NEW
│   │   ├── item_ops.rs               NEW
│   │   ├── security_ops.rs           NEW
│   │   ├── settings_ops.rs           NEW
│   │   ├── shortcuts.rs              NEW
│   │   ├── menus.rs                  NEW
│   │   ├── alarms.rs                 NEW
│   │   ├── mail\{mod,imap,oauth,mime,providers}.rs  NEW
│   │   └── render.rs                 NEW (--render-check)
│   ├── assets\                       (exists)
│   └── tests\golden\*.json           NEW
└── docs\plans\                       this file
```

---

## 5. Phase map

| Phase | Deliverable | Proves itself by |
| --- | --- | --- |
| **0** | Design system + shell skeleton + `--render-check` harness | `cargo build` clean, render-check walks 8 existing screens unchanged |
| **1** | `colax-core` full domain parity | `cargo test -p colax-core` green incl. new TS-fixture parity tests |
| **2** | Preferences live: persisted, normalised, drives the theme | accent/theme/density/roundness/text-scale change the UI and survive restart |
| **3** | Sidebar + four views + search/sort/filter + item CRUD | create/edit/delete a login from the UI; all four views render the same vault |
| **4** | Item editor (9 sections) + generator + security form | generate → apply → save; TOTP enrol with QR; health badges correct |
| **5** | Settings window, 13 tabs | every control writes prefs and is observable after restart |
| **6** | Security: gate, auto-lock, clipboard clear/capture | wrong code rejected; clipboard self-clears; idle lock fires |
| **7** | Dashboard + History + alarms | dashboard numbers match a hand-built vault; history round-trips |
| **8** | Context menus + shortcuts + docks + appearance tuner | full keyboard-only run of the app |
| **9** | Mail engine + platform polish + packaging | read a real mailbox; installer builds |

Each phase ends with `cargo test && cargo build --release && colax-lite.exe --render-check` and a commit.

---

## Phase 0 — Design system, shell skeleton, render harness

**Intent:** before any new screen exists, establish the component vocabulary and the split structure, and get a regression harness in place. Everything after this phase composes these parts.

### Task 0.1 — Baseline: prove the current build is green

**Files:** none created.

> **Measured 2026-10-13:** the baseline is already green. `cargo test -p colax-core` → **34 unit tests + 17 integration tests pass**, including `restores_a_backup_written_by_the_typescript_app` and `crypto::tests::pbkdf2_matches_node_webcrypto`. Confirmed with `cargo test -p colax-core --quiet 2>$null` → `EXIT=0`.
>
> **PowerShell gotcha:** running it as `cargo test ... 2>&1 | …` reports *exit code 1* even when every test passes — PowerShell turns cargo's stderr progress lines into error records, the same artefact that fills `build-log.txt` with `NativeCommandError`. Always check `$LASTEXITCODE` after a bare `cargo` invocation, never the pipeline's status.

**Step 1: Re-run the existing core tests**

Run: `cargo test -p colax-core` (in `E:\acc2\colax-lite-native`)
Expected: `test result: ok.` — 17 integration tests plus 34 unit tests pass.

**Step 2: Build the app**

Run: `cargo build -p colax-lite`
Expected: `Finished` with no warnings (matches `build-log.txt`).

**Step 3: Record the baseline**

Run: `cargo build -p colax-lite 2>&1 | Out-File -Encoding utf8 build-log.txt`
Expected: file rewritten; commit this only if it differs meaningfully.

**Step 4: Commit**

```bash
git add colax-lite-native
git commit -m "chore: baseline colax-lite-native before full UI port"
```

> Note: `git status` currently reports `?? colax-lite-native/` — the whole tree is untracked. This first commit is what puts the existing work under version control. Do not use `--force` or add `target/` (`.gitignore` already excludes it).

---

### Task 0.2 — Split `main.slint` into a module tree (no behaviour change)

**Files:**
- Create: `app/colax-lite/ui/theme.slint`
- Create: `app/colax-lite/ui/widgets.slint`
- Create: `app/colax-lite/ui/models.slint`
- Create: `app/colax-lite/ui/screens/lock.slint`
- Modify: `app/colax-lite/ui/main.slint` (becomes the thin entry point)
- Modify: `app/colax-lite/src/main.rs` (only if generated type paths move)

**Step 1: Move the `Theme` global verbatim**

Cut `global Theme { ... }` (`main.slint:43-62`) into `ui/theme.slint` unchanged, and add `export`:

```slint
// ui/theme.slint — the lite app's dark palette (tokens.css), flattened.
// Colours are *pushed from Rust* (ADR-2); nothing here branches on theme.
export global Theme {
    out property <color> bg: #101319;
    out property <color> text: #f0f3f9;
    out property <color> muted: #a0a6b5;
    out property <color> faint: #767b86;
    out property <color> accent: #75a5c7;
    out property <color> accent-strong: #90b8d6;
    out property <color> accent-press: #518db8;
    out property <color> accent-soft: #75a5c733;
    out property <color> danger: #e07b80;
    out property <color> danger-soft: #e07b802b;
    out property <color> good: #7dd3a0;
    out property <color> good-soft: #7dd3a02b;
    out property <color> card: #1a1e27;
    out property <color> border: #ffffff17;
    out property <color> border-strong: #ffffff2b;
    out property <color> field: #ffffff0f;
    out property <color> field-focus: #ffffff1a;
    out property <color> row-hover: #ffffff0a;
}
```

`out` (not `in-out`) is deliberate: Rust writes these through `ui.global::<Theme>()`, and `out` properties are the ones exposed that way.

**Step 2: Move `Btn`, `Field`, `Alert` into `ui/widgets.slint`**

Cut `main.slint:67-208` verbatim, adding `export` to each component. They already reference `Theme`, so add at the top:

```slint
import { Theme } from "theme.slint";
export component Btn inherits Rectangle { /* …unchanged… */ }
export component Field inherits Rectangle { /* …unchanged… */ }
export component Alert inherits Rectangle { /* …unchanged… */ }
```

**Step 3: Move `ItemRow` into `ui/models.slint`**

Cut `main.slint:27-38` verbatim with `export`. This file will accumulate every cross-boundary struct (`LoginCard`, `SidebarRow`, `SettingRow`, `MenuNode`, …) as later phases add them.

**Step 4: Move the eight auth screens into `ui/screens/lock.slint`**

Cut the `if (root.screen != Screen.Vault) : Rectangle { … }` block (`main.slint:472-772`) into a reusable exported component:

```slint
// ui/screens/lock.slint
import { Theme, Btn, Field, Alert } from "../widgets.slint";  // Theme re-exported
import { Screen } from "../models.slint";

export component LockScreen inherits Rectangle {
    in property <Screen> screen;
    in property <string> error-text;
    in property <string> notice-text;
    in property <bool> busy;
    in-out property <string> password-value;
    in-out property <string> confirm-value;
    callback create-no-password();
    // …every callback the block used…
    // …the moved body verbatim, with `root.` referring to this component…
}
```

Move `enum Screen` into `models.slint` with `export`, since both `lock.slint` and `main.slint` need it.

**Step 5: Rewire `main.slint`**

```slint
import { Theme } from "theme.slint";
import { Btn, Field, Alert } from "widgets.slint";
import { Screen, ItemRow } from "models.slint";
import { LockScreen } from "screens/lock.slint";

export component MainWindow inherits Window {
    // …properties and callbacks unchanged…
    if (root.screen == Screen.Vault) : VerticalLayout { /* …unchanged vault list… */ }
    if (root.screen != Screen.Vault) : LockScreen {
        screen: root.screen;
        error-text <=> root.error-text;
        // …wire the rest…
    }
}

export component AppTray inherits SystemTrayIcon { /* …unchanged… */ }
```

**Step 6: Build and confirm zero behaviour change**

Run: `cargo build -p colax-lite`
Expected: compiles clean.

Run: `cargo run -p colax-lite`
Expected: all eight screens render and behave exactly as before — first run, create with password, confirm, unlock, device unlock, import, error.

**Step 7: Commit**

```bash
git add colax-lite-native/app/colax-lite/ui
git commit -m "refactor(ui): split main.slint into theme/widgets/models/screens"
```

---

### Task 0.3 — Split `main.rs` into modules (no behaviour change)

**Files:**
- Create: `app/colax-lite/src/shell.rs`
- Create: `app/colax-lite/src/state.rs`
- Create: `app/colax-lite/src/appearance.rs`
- Modify: `app/colax-lite/src/main.rs`

**Step 1: Move window/tray/autostart code to `shell.rs`**

Cut `main.rs:34-108` (constants, `ShellState`, `state_path`, `read_state`, `write_state`), `:110-172` (`apply_autostart`), `:174-263` (`find_main_window`, `show_window`, `focus_main_window`) into `shell.rs` with `pub(crate)` visibility. Keep the doc comments — they record measured Win32 behaviour that must not be "simplified".

**Step 2: Move vault UI state to `state.rs`**

Cut `:265-419` (`AppState`, `Shared`, `vault_path`, `startup_screen`, `lock_screen_for`, `tile_color`, `row_for`, `refresh_items`, `goto`, `notice`, `tray_lock_enabled`) into `state.rs`. Move `tile_color` to `appearance.rs` and re-export.

**Step 3: Move the flows to `state.rs`**

Cut `:421-583` (`create_vault`, `unlock_with`, `restore_backup`, `pick_backup`, `copy_item_password`, `lock_vault`, `import_handler`) into `state.rs`.

**Step 4: Leave `main.rs` as wiring**

It should now read: state-file boot → build UI → open vault → register tray callbacks → register vault callbacks → close handler → `show()` → focus → `run()`.

**Step 5: Build and re-test by hand**

Run: `cargo build -p colax-lite`
Expected: clean, with no `warning: unused` — if one appears, a `pub(crate)` was missed.

Repeat the eight-screen manual pass from Task 0.2 Step 6.

**Step 6: Commit**

```bash
git add colax-lite-native/app/colax-lite/src
git commit -m "refactor(app): split main.rs into shell/state/appearance modules"
```

---

### Task 0.4 — The widget library (`ui/widgets.slint`)

**Files:**
- Modify: `app/colax-lite/ui/widgets.slint`
- Modify: `app/colax-lite/src/appearance.rs`

This is the vocabulary every later phase composes. Each component is styled from `Theme` only, so ADR-1 keeps theming free.

**Components to add (all `export`):**

| Component | Signature (essentials) | Web counterpart |
| --- | --- | --- |
| `Btn` | *(exists)* `label, kind 0/1/2, enabled, h, clicked` | `.btn`, `.btn--primary` |
| `Field` | *(exists)* `value<=>, placeholder, password, enabled, accepted, edited` | `input.field` |
| `Alert` | *(exists)* `message, good` | `.alert` |
| `Toggle` | `checked<=>, label, enabled, toggled()` | `Switch` in `primitives.tsx` |
| `Checkbox` | `checked<=>, label, toggled()` | settings checkboxes |
| `Select` | `options: [string], index: int, changed(i)` — popup list | `Select` in `primitives.tsx` |
| `Slider` | `value<=>, minimum, maximum, step, label, formatted` | `Slider` in `Settings.tsx` |
| `Segmented` | `options: [string], index: int, changed(i)` | `SubTabs`, factor switch |
| `Chip` | `label, hue: color, selected, removable` | tag chips |
| `Badge` | `label, tone (0 neutral/1 warn/2 danger/3 good), icon` | `HealthBadges` |
| `Tile` | `initial, hue: color, size, image: image` | `LoginMark` |
| `StrengthMeter` | `score: int (0-4), bits: int, label: string` | `StrengthMeter` |
| `EmptyState` | `title, hint, action-label, action()` | `ViewEmptyState` |
| `SectionCard` | `title, hint`, slots for content | `.panel` |
| `Modal` | `title, width, visible<=>, close-requested()`, dimmed scrim + centred card, `Escape` closes | `Modal` in `primitives.tsx` |
| `Toast` | `message, good` | `Toasts` |
| `IconButton` | `icon: image/string, tooltip, clicked()` | `.icon-btn` |
| `Divider` | *(none, or `height`)* | hairline rule |
| `ScrollBox` | wraps content, thin scrollbar styled per `tokens.css:405-425` | global scrollbar rules |

**Step 1: Write `Toggle` and `Slider` first (the Settings primitives)**

```slint
// ui/widgets.slint — additions
export component Toggle inherits Rectangle {
    in property <string> label;
    in-out property <bool> checked;
    in property <bool> enabled: true;
    callback toggled();

    height: 26px;
    touch := TouchArea {
        enabled: root.enabled;
        clicked => {
            root.checked = !root.checked;
            root.toggled();
        }
    }
    Text {
        text: root.label;
        color: root.enabled ? Theme.text : Theme.faint;
        font-size: 14px;
        vertical-alignment: center;
        x: 0;
        width: parent.width - 52px;
        height: parent.height;
    }
    Rectangle {
        x: parent.width - 44px;
        width: 44px;
        height: 24px;
        border-radius: 12px;
        background: root.checked
            ? (touch.has-hover ? Theme.accent-strong : Theme.accent)
            : (touch.has-hover ? #ffffff1f : #ffffff14);

        Rectangle {
            x: root.checked ? parent.width - 22px : 2px;
            y: 2px;
            width: 20px;
            height: 20px;
            border-radius: 10px;
            background: root.checked ? #10182a : Theme.muted;
            animate x { duration: 120ms; easing: ease-out; }
        }
    }
}
```

**Step 2: `Modal` — the shared overlay**

Port `src/ui/primitives.tsx` `Modal`: dimmed scrim (`TouchArea` absorbing clicks), centred card, title, `Escape`/scrim close, focus first field. Slint has no focus trap, so expose a `focus-target` id the host wires to its first `Field`.

**Step 3: `Select` — a button that opens a popup**

Slint has no styled dropdown. Implement as `Btn`-looking row + `PopupWindow` listing `options`, highlighting `index`, calling `changed(i)` on click and `close()`. Keyboard: `Tab` moves on, `Enter` opens, arrow keys move a highlight — port the behaviour described at `primitives.tsx` `Select` (arrows/Home/End/type-ahead/Escape).

**Step 4: Style the scrollbar once**

`ScrollBox` sets `ScrollBar` styling via `default-font`/palette properties, or hand-roll a `Rectangle` track + thumb per `tokens.css:405-425` (`--border-strong`, 3px transparent border, pill radius, hover → `--text-faint`).

**Step 5: Verify**

Run: `cargo build -p colax-lite`
Then write `app/colax-lite/src/render.rs` (Task 0.5) and add a `widgets` screen that instantiates every component once.

Run: `cargo run -p colax-lite -- --render-check`
Expected: exit 0; JSON lists all components with non-zero bounds and no `NaN`.

**Step 6: Commit**

```bash
git add colax-lite-native/app/colax-lite
git commit -m "feat(ui): widget library for the native build"
```

---

### Task 0.5 — `--render-check` harness

**Files:**
- Create: `app/colax-lite/src/render.rs`
- Create: `app/colax-lite/tests/golden/`

**Step 1: Define the walker**

`render.rs` exposes `pub fn run(ui: &MainWindow) -> Result<(), String>`. It holds a fixed table of steps:

```rust
/// One render-check step: a screen (or dialog state) plus the properties it
/// needs set to render. Golden JSON records the resulting property tree.
pub struct Step {
    pub name: &'static str,
    pub setup: fn(&MainWindow),
}
```

Each step sets `screen`/`visible`/model properties, yields to the event loop with `slint::run_event_loop_until` or a zero-duration `Timer` so layouts settle, then serialises the visible component tree (id, bounds, text, visibility) to JSON.

**Step 2: Wire it up in `main.rs`**

```rust
if std::env::args().any(|a| a == "--render-check") {
    let report = render::run(&ui)?;
    println!("{report}");
    return Ok(());
}
```

Run it *after* `ui.show()` so `init` and layout have executed (the existing boot code at `main.rs:875-882` already re-enters the screen for exactly this reason).

**Step 3: First golden**

Run: `cargo run -p colax-lite -- --render-check > app/colax-lite/tests/golden/phase0.json`
Expected: JSON covering the eight existing screens.

**Step 4: Commit**

```bash
git add colax-lite-native/app/colax-lite
git commit -m "test(ui): --render-check property-tree harness"
```

---

## Phase 1 — `colax-core` domain parity

**Intent:** give the engine every pure capability the web app has, so no later UI phase ever has to reach into app code for logic. This is the most TDD-heavy phase; every task is test-first.

All tasks follow the skill's rhythm: write the failing test → run → implement → run → commit. The TS file named is the spec; read it before writing the test.

### Task 1.1 — Password generation and strength

**Files:**
- Create: `crates/colax-core/src/passwords.rs`
- Modify: `crates/colax-core/src/lib.rs` (re-export)
- Modify: `crates/colax-lite-native/Cargo.toml` — no new dep; `rand` 0.8 already provides unbiased `gen_range` (rejection sampling) and `SliceRandom::shuffle` (Fisher–Yates)
- Test: `crates/colax-core/tests/passwords.rs`

**Spec:** `E:\acc2\src\crypto\passwords.ts` (272 lines) — `randomInt` L50, `shuffle` L67, `generatePassword` L80, `generatePassphrase` L126, `suggestMasterPassword` L148, `WORDS` L110, `Strength` L156, `estimateStrength` L242.
**Behavioural tests to mirror:** `E:\acc2\test\crypto.test.ts`.

**Public API to build:**

```rust
pub struct GeneratorOptions {
    pub length: usize,        // default 20, clamp 8..=64
    pub lower: bool, pub upper: bool, pub digits: bool, pub symbols: bool,
    pub avoid_ambiguous: bool,
}
impl Default for GeneratorOptions { /* TS DEFAULT_PASSWORD_GENERATOR */ }

pub struct Strength {
    pub bits: f64,
    pub score: u8,          // 0..=4
    pub label: &'static str,
    pub crack_time: String, // human string, TS format
    pub hints: Vec<String>,
}

pub fn generate_password(opts: &GeneratorOptions) -> Result<String, String>;
pub fn generate_passphrase(words: usize) -> String;      // 3..=10, default from TS
pub fn suggest_master_password() -> String;              // 7 words + 4 digits
pub fn estimate_strength(password: &str) -> Strength;
```

**Step 1: Write the failing test**

```rust
// crates/colax-core/tests/passwords.rs
use colax_core::passwords::*;

#[test]
fn generator_uses_requested_length_and_sets() {
    let opts = GeneratorOptions { length: 32, ..Default::default() };
    let pw = generate_password(&opts).expect("sets are on");
    assert_eq!(pw.chars().count(), 32);
    assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
    assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
    assert!(pw.chars().any(|c| c.is_ascii_digit()));
    assert!(pw.chars().any(|c| "!@#$%^&*".contains(c)));
}

#[test]
fn generator_refuses_an_empty_alphabet() {
    let opts = GeneratorOptions { length: 20, lower: false, upper: false,
                                  digits: false, symbols: false,
                                  avoid_ambiguous: false };
    assert!(generate_password(&opts).is_err());
}

#[test]
fn avoid_ambiguous_drops_look_alikes() {
    let opts = GeneratorOptions { length: 64, avoid_ambiguous: true, ..Default::default() };
    let pw = generate_password(&opts).unwrap();
    for c in "l1IIO0" { assert!(!pw.contains(c), "found {c} in {pw}"); }
}

#[test]
fn strength_scores_match_the_ts_table() {
    // Fixture generated by scripts/make-ts-fixture.mjs from the real
    // estimateStrength(); see the script's --strengths flag.
    let cases: Vec<(String, u8, f64)> = load_fixture("ts-strength.json");
    for (password, score, bits) in cases {
        let s = estimate_strength(&password);
        assert_eq!(s.score, score, "score for {password}");
        assert!((s.bits - bits).abs() < 0.001, "bits for {password}");
    }
}
```

**Step 2: Run and confirm failure**

Run: `cargo test -p colax-core --test passwords`
Expected: `error[E0433]: failed to resolve: use of undeclared crate or module colax_core::passwords` (module not created).

**Step 3: Generate the TS fixture**

Extend `crates/colax-core/scripts/make-ts-fixture.mjs` with a `--strengths` mode that imports `estimateStrength` from `E:\acc2\src\crypto\passwords.ts` and writes `tests/fixtures/ts-strength.json` over a fixed list of ~40 passwords covering: empty, common (`password`, `123456`), sequential, repeated, short, long random, a passphrase, a hex key, a URL, unicode.

Run (from `E:\acc2`): `node --experimental-strip-types colax-lite-native/crates/colax-core/scripts/make-ts-fixture.mjs --strengths`

**Step 4: Implement `passwords.rs`**

Port line by line. The load-bearing details:

- `randomInt(max)` must be **rejection sampling**, not `max % n`. `rand`'s `gen_range(0..n)` already is — use it and say so in the doc comment.
- `shuffle` must be Fisher–Yates from the end, as TS does.
- Guaranteed-set-character: TS draws one char per enabled set first, then fills, then shuffles. Reproduce the order — the fixture pins the *distribution*, the order pins the *guarantee*.
- `avoidAmbiguous` removes `l1IIO0` — confirm against `passwords.ts`, do not guess.
- `estimateStrength` penalties (common-password list, sequences, repeats, keyboard walks) are data, not algorithms: copy the exact lists and thresholds from TS. Where a list is long, keep it in a `const` array in the same order.

**Step 5: Run and confirm pass**

Run: `cargo test -p colax-core --test passwords`
Expected: `test result: ok.`

**Step 6: Commit**

```bash
git add colax-lite-native/crates/colax-core
git commit -m "feat(core): password generator and strength estimator"
```

---

### Task 1.2 — TOTP

**Files:**
- Create: `crates/colax-core/src/totp.rs`
- Modify: `Cargo.toml` (workspace) — add `sha1 = "0.10"` to `[workspace.dependencies]`
- Modify: `crates/colax-core/Cargo.toml` — add `sha1.workspace = true`, `data-encoding = "2"`
- Test: `crates/colax-core/tests/totp.rs`

**Spec:** `E:\acc2\src\crypto\totp.ts` (67 lines) and `E:\acc2\src\crypto\security.ts:69-190`.
**Behavioural tests:** `E:\acc2\test\crypto.test.ts` (TOTP section).

```rust
pub fn base32_decode(value: &str) -> Result<Vec<u8>, String>;   // strips non-alphabet, unpadded OK
pub fn base32_encode(bytes: &[u8]) -> String;                   // unpadded, uppercase
pub fn totp_code(seed_base32: &str, at_unix: u64) -> Result<String, String>;
pub fn totp_seconds_remaining(at_unix: u64) -> u64;             // 30 - (t % 30)
pub fn current_totp_code(seed_base32: &str) -> Result<String, String>;
pub fn verify_totp(seed_base32: &str, code: &str) -> bool;      // constant-time-ish, accepts current ±1 window
pub fn extract_totp_secret(input: &str) -> Option<String>;      // from otpauth:// URL or bare seed
pub fn otpauth_url(label: &str, seed_base32: &str) -> String;   // for the QR
pub fn generate_totp_seed() -> String;                          // 20 random bytes -> base32
```

**Step 1: Write the failing test with RFC 6238 vectors**

```rust
// crates/colax-core/tests/totp.rs
use colax_core::totp::*;

/// RFC 6238 Appendix B, SHA-1 vectors. The seed is ASCII "12345678901234567890"
/// per the RFC; the TS implementation stores it base32-encoded.
#[test]
fn rfc6238_sha1_vectors() {
    // (unix_time, expected_code) — from RFC 6238 test vectors
    let cases: [(u64, &str); 6] = [
        (59, "94287082"),
        (1111111109, "07081804"),
        (1111111111, "14050471"),
        (1234567890, "89005924"),
        (2000000000, "69279037"),
        (20000000000, "65353130"),
    ];
    let seed = base32_encode(b"12345678901234567890");
    for (at, expected) in cases {
        assert_eq!(totp_code(&seed, at).unwrap(), expected, "t={at}");
    }
}
```

**Step 2: Run, confirm failure** — `cargo test -p colax-core --test totp` → `unresolved import colax_core::totp`.

**Step 3: Implement**

- Base32: `data_encoding::BASE32_NOPAD.decode(...)` after stripping everything not in `A-Z2-7` (case-insensitive) — matches TS's tolerant parser.
- Code: `HMAC-SHA1(key=seed, msg=u64::to_be_bytes(counter))`, counter = `t / 30`, then RFC 4226 dynamic truncation (`& 0x7fffffff`, 4-byte window at `h[19] & 0xf`), `% 1_000_000`, zero-pad to 6.
- Cross-check: assert Rust output equals the TS `totpCodeAt` for 20 timestamps in a fixture (`make-ts-fixture.mjs --totp`).

**Step 4: Run, confirm pass, commit**

```bash
git add colax-lite-native/crates/colax-core
git commit -m "feat(core): RFC 6238 TOTP over HMAC-SHA1"
```

---

### Task 1.3 — Security questions and passcode

**Files:**
- Create: `crates/colax-core/src/security.rs`
- Modify: `crates/colax-core/Cargo.toml` — add `unicode-normalization.workspace = true`, `subtle.workspace = true`
- Test: `crates/colax-core/tests/security.rs`

**Spec:** `E:\acc2\src\crypto/security.ts:193-368` — `normaliseAnswer` L203, `answerTooWeak` L214, `hashAnswer` L261, `verifyAnswer` L268, `hashPasscode` L283, `verifyPasscode` L289, `passcodeTooWeak` L297, `securityLevel` L337.
**Behavioural tests:** `E:\acc2\test\security.test.ts`, `security-passcode.test.ts`.

```rust
pub fn normalise_answer(answer: &str) -> String;      // NFKD, strip U+0300..=U+036F, trim, lowercase
pub fn answer_too_weak(answer: &str) -> bool;
pub fn hash_answer(answer: &str) -> (String, String); // (hash_b64url, salt_b64url), PBKDF2 210k
pub fn verify_answer(answer: &str, hash: &str, salt: &str) -> bool;
pub fn hash_passcode(code: &str) -> (String, String);
pub fn verify_passcode(code: &str, hash: &str, salt: &str) -> bool;
pub fn passcode_too_weak(code: &str, totp_set: bool) -> bool;  // >=8 / >=12, class mix, != "password"
pub fn security_level(sec: &LoginSecurity) -> SecurityLevel;   // None / Partial / Protected
```

**Critical:** the PBKDF2 parameters and salt encoding must match TS exactly or a backup restored from the web app will fail its own gate. `derive_kek` in `crypto.rs:240` is private and vault-specific — add a `pub(crate)` shared helper with an `iterations` parameter rather than duplicating it.

**Step 1:** write failing tests asserting `hash_answer` output for a fixed `(answer, salt)` pair taken from `security.test.ts`.
**Step 2:** confirm failure. **Step 3:** implement. **Step 4:** confirm pass. **Step 5:** commit.

```bash
git add colax-lite-native/crates/colax-core
git commit -m "feat(core): answer and passcode hashing, security level"
```

---

### Task 1.4 — Health analysis

**Files:** Create `crates/colax-core/src/health.rs`, Test `crates/colax-core/tests/health.rs`

**Spec:** `E:\acc2\src\vault\types.ts:297-360` (`findWeakItems`, `isWeakPassword`, `staleDaysFor`, `findReusedPasswords`, `patternStem`); channel `weak` branch `E:\acc2\src\vault\channels.ts:571-595`. **Tests:** `E:\acc2\test\health.test.ts`.

```rust
pub fn is_weak_password(password: &str) -> bool;
pub fn stale_days_for(item: &VaultItem, prefs_age_days: u32) -> u64;  // 0 disables
pub fn is_stale(item: &VaultItem, prefs_age_days: u32) -> bool;
pub fn find_weak_items(items: &[VaultItem]) -> Vec<String>;           // ids
pub fn find_reused_passwords(items: &[VaultItem]) -> Vec<Vec<String>>;// clusters
pub fn pattern_stem(password: &str) -> String;                        // groups reused passwords
```

Depends on Task 1.1's `estimate_strength`. `pattern_stem` is the subtle one — port it verbatim and pin it with a fixture from `health.test.ts`.

**Steps:** failing test → confirm → implement → pass → commit `feat(core): weak, stale and reused password analysis`.

---

### Task 1.5 — Channels, folders, tags, sidebar

**Files:** Create `crates/colax-core/src/channels.rs`, Test `crates/colax-core/tests/channels.rs`

**Spec:** `E:\acc2\src\vault\channels.ts` (779 lines) — types L56-140, `BUILTIN_CHANNELS` L488, `normaliseFolders` L404, `normaliseSidebar` L429, `applyChannel` L551, `describeChannel` L613, `normaliseChannels` L648, `ensureDefaultTags` L804, `reorder` L838.
**Tests:** `E:\acc2\test\channels.folder.test.ts`, `channels.dashboard.test.ts`, `sidebar-dnd.test.ts`, `sidebar-hide.test.ts`, `sidebar-tree.test.ts`.

```rust
pub struct Channel { /* id, name, kind, icon, hue, show, tags, image*, security, … */ }
pub struct Tag { /* id, name, hue */ }
pub struct Folder { /* id, name, icon, hue, image*, security, … */ }
pub enum SidebarEntry { Channel(String), Folder(String), Separator(String) }

pub const BUILTIN_CHANNELS: &[Channel] = /* … */;

pub fn normalise_channels(raw: &Value) -> Vec<Channel>;
pub fn normalise_tags(raw: &Value) -> Vec<Tag>;
pub fn normalise_folders(raw: &Value) -> Vec<Folder>;
pub fn normalise_sidebar(raw: &Value, chans: &[Channel], folders: &[Folder]) -> Vec<SidebarEntry>;
pub fn ensure_default_tags(tags: &mut Vec<Tag>);
pub fn apply_channel(channel: &Channel, items: &[VaultItem]) -> Vec<VaultItem>;
pub fn describe_channel(channel: &Channel, chans: &[Channel]) -> String;
pub fn reorder(entries: &mut Vec<SidebarEntry>, from: usize, to: usize);
```

This is the largest pure port in Phase 1 — `applyChannel` alone implements five filter kinds. Work it as three commits if needed (`types+normalisers`, `applyChannel+describe`, `reorder+movement`) but keep each independently green.

**Steps:** failing tests (port all five TS test files' cases first) → confirm → implement → pass → commit.

---

### Task 1.6 — Preferences schema, defaults, normaliser

**Files:** Create `crates/colax-core/src/prefs.rs`, Test `crates/colax-core/tests/prefs.rs`

**Spec:** `E:\acc2\src\vault\storage.ts` — `VaultPreferences` L473-839 (~90 fields), `DEFAULT_PREFERENCES` L841-969, `normalisePreferences` L1069-1454 (~385 lines), plus `normaliseDockPos` L976, `normaliseDockSlots` L1021, `Alarm` L304, `CachedMailMessage` L241 + `mergeMailCache` L264, `HistoryEvent` L354 (delegates to Task 1.7), dock types L114-192.
**Tests:** `E:\acc2\test\preferences.test.ts` — port it wholesale.

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultPreferences { /* every field, typed, with Default */ }

impl Default for VaultPreferences { /* DEFAULT_PREFERENCES, field for field */ }

pub fn default_preferences() -> VaultPreferences;
pub fn normalise_preferences(raw: &Value) -> VaultPreferences;   // the 385-line one
pub fn normalise_dock_slots(raw: &Value) -> Vec<DockSlotConfig>;
pub fn normalise_dock_pos(raw: &Value) -> DockPlacement;
pub fn merge_mail_cache(existing: Vec<CachedMailMessage>,
                        incoming: Vec<CachedMailMessage>) -> Vec<CachedMailMessage>;
```

**This task unblocks Phases 2, 5, 8 and most of 7.** It is worth doing exhaustively even though nothing displays it yet.

Key rules to honour:
- Every field must round-trip: `serde_json::to_value(normalise_preferences(&to_value(&p))) == to_value(&p)` for the default.
- Legacy accent names (`aurora`, `mint`, `nebula`, `orchid`, `sunset`, `ember`) map onto the calm four — `tokens.css:99-117` is the authoritative mapping.
- Retired fields (`expandOnOpen`, `mailOptInMigrated`, `mailEveryLogin`) and one-time stamps (`mailLinkedOnly`, `lookPresetMigrated`, `sidebarGrouped`, `orbitDockRestored`) must still be **read and written back** so the file round-trips with the web build.
- Caps: `MAX_HISTORY_EVENTS 200`, `MAX_HISTORY_CHARS 400_000`, `MAIL_CACHE_CAP 300`, `MAX_DOCK_SLOTS 24`, `MAX_DOCKS 4`.

**Also in this task — close the two known divergences:**
1. `crates/colax-core/src/model.rs` `VaultItem` gains `show_mail: bool` and `mail_filter: String` (defaults from `src/vault/types.ts:36-44`), added to `normalise_item` so a TS backup round-trips without loss.
2. `crates/colax-core/src/engine.rs:405` `export_backup()` currently sets `preferences: None`. Once preferences matter, carry them — and add a test asserting a TS backup with preferences survives `export_backup` → `parse_backup` → `restore_backup`.

**Steps:** failing tests (ported `preferences.test.ts`) → confirm → implement → pass → commit `feat(core): VaultPreferences schema, defaults and normaliser`.

---

### Task 1.7 — History and undo log

**Files:** Create `crates/colax-core/src/history.rs`, Test `crates/colax-core/tests/history.rs`

**Spec:** `E:\acc2\src\vault\storage.ts:324-470` (`HistoryEvent`, `normaliseHistory`, `historyEventsFor`, `appendHistory`, caps); wiring `src/ui/hooks.ts:192-194`. **Tests:** `E:\acc2\test\history.test.ts`.

```rust
pub struct HistoryEvent { /* id, kind, itemId, at, label, snapshot?, … */ }
pub fn normalise_history(raw: &Value) -> Vec<HistoryEvent>;
pub fn append_history(log: &mut Vec<HistoryEvent>, event: HistoryEvent);  // applies both caps
pub fn history_events_for(log: &[HistoryEvent], item_id: &str) -> Vec<HistoryEvent>;
```

Undo/redo itself already exists as `VaultEngine::replace_items` — this task is only the log. The app-side undo stacks stay in `app/colax-lite/src/item_ops.rs` (Phase 3), mirroring `hooks.ts` `useRef` stacks bounded to 50.

**Steps:** failing test → confirm → implement → pass → commit `feat(core): history log with caps`.

---

### Task 1.8 — Text helpers

**Files:** Create `crates/colax-core/src/text.rs`, Test inline

**Spec:** `E:\acc2\src\vault\types.ts` — `relativeTime` L177, `toDateInput` L229, `fromDateInput` L236, `hostnameOf` L270, `normalizeUrl` (already ported), image caps L98-104.

```rust
pub fn relative_time(at_ms: i64, now_ms: i64) -> String;  // "2 days ago", "just now", …
pub fn to_date_input(ms: i64) -> String;                  // "YYYY-MM-DD" local
pub fn from_date_input(s: &str) -> Option<i64>;
pub fn hostname_of(url: &str) -> String;                  // via `url` crate, WHATWG rules
```

`hostname_of` must match JS `new URL(url).hostname` — including its handling of missing schemes, which the `url` crate does because it implements the same spec. Add `url.workspace = true`.

**Steps:** failing test → confirm → implement → pass → commit `feat(core): relative time, date and hostname helpers`.

---

### Task 1.9 — Site intel and capture

**Files:** Create `crates/colax-core/src/site_intel.rs`, Test `crates/colax-core/tests/site_intel.rs`

**Spec:** `E:\acc2\src\vault\site-intel.ts` (570 lines). **Tests:** `E:\acc2\test\site-intel.test.ts`, `clipboard-detect.test.ts`.

```rust
pub struct Capture { /* site, host, username, password, … */ }
pub struct CaptureVerdict { /* … */ }
pub fn inspect_capture(raw: &Capture, items: &[VaultItem], prefs: &VaultPreferences) -> CaptureVerdict;
pub fn capture_to_draft(c: &Capture) -> Value;
pub fn suggest_tags_for_draft(draft: &Value, tags: &[Tag]) -> Vec<String>;
pub fn mask_email(email: &str) -> String;
pub fn known_site(host: &str) -> Option<&'static SiteInfo>;
pub fn site_name_for(host: &str) -> String;
```

Pure port. The `knownSite` table is data — copy it verbatim.

**Steps:** failing tests → confirm → implement → pass → commit `feat(core): site intel and capture analysis`.

---

### Task 1.10 — Optimize profiles

**Files:** Create `crates/colax-core/src/optimize.rs`

**Spec:** `E:\acc2\src\vault\optimize.ts` (346 lines). **Tests:** `E:\acc2\test\optimize.test.ts`.

`OptimizeStyle`, `OptimizeProfile`, `FULL_DETAIL`/`BALANCED`/`MAX_SAVINGS_STYLE`, the `OPTIMISATIONS` counter table, `style_from_prefs`, `style_patch`, `snapshot_style`, `read_style`, `normalise_optimize_profiles`.

**Steps:** failing tests → confirm → implement → pass → commit `feat(core): optimize styles and profiles`.

---

### Task 1.11 — CSV import/export

**Files:** Create `crates/colax-core/src/csv_io.rs`, modify `crates/colax-core/Cargo.toml` (+`csv = "1"`)

**Spec:** `E:\acc2\src\ui\Settings.tsx:422-489` — `exportCsv` builds `name,url,username,password,notes`; `importCsv` parses the same header, skips unknown rows.

```rust
pub fn export_csv(items: &[VaultItem]) -> String;
pub fn import_csv(text: &str) -> Result<Vec<Value>, String>;   // draft values, engine adds ids
```

**Steps:** failing test with a quoted-field fixture (commas, quotes, newlines inside notes — RFC 4180 escaping is the whole point) → confirm → implement → pass → commit `feat(core): CSV import and export`.

---

### Task 1.12 — Phase 1 gate

**Step 1:** extend `make-ts-fixture.mjs` so every fixture the new tests consume is reproducible.

**Step 2:** run the whole suite.

Run: `cargo test -p colax-core`
Expected: all existing + new tests pass, including the TS-fixture parity tests.

**Step 3:** confirm nothing regressed upstream.

Run: `cd E:\acc2 && npm test`
Expected: unchanged — Phase 1 must not touch `E:\acc2\src`.

**Step 4: Commit**

```bash
git add colax-lite-native
git commit -m "feat(core): full domain parity with the TypeScript app"
```

---

## Phase 2 — Preferences live, theming applied

**Intent:** make prefs real: typed, persisted, normalised on load, and driving the whole look.

### Task 2.1 — `apply_appearance`

**Files:** Create `app/colax-lite/src/appearance.rs`; Modify `ui/theme.slint`, `src/main.rs`

**Spec:** `E:\acc2\src\ui\hooks.ts` `applyAppearance()` (~line 350-480) and `src/styles/tokens.css`.

**Step 1:** write `apply_appearance(ui: &MainWindow, prefs: &VaultPreferences)` in `appearance.rs`. It resolves, in order:

1. `theme` (`light`/`dark`/`system`) → system via `AppsUseLightTheme` registry value (`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`), read through the existing `windows-sys` dep.
2. `accent` → `--accent-h`/`--accent-h-2` from the table at `tokens.css:82-97`, then the four accent colours from `tokens.css:146-165` (dark) / `261-280` (light).
3. `highContrast` → the overrides at `tokens.css:455-467`.
4. `reduceTransparency` → drop glass alpha (`tokens.css:451-453`).
5. `roundness`, `density`, `textScale`, `cardDepth` → scalar multipliers exposed as `Theme` metrics.

**Step 2:** `ui/theme.slint` gains the scalar properties alongside the colours:

```slint
export global Theme {
    // …existing colours…
    out property <float> roundness: 1;      // multiplies every border-radius
    out property <float> density: 1;        // multiplies row heights and padding
    out property <float> text-scale: 1;     // multiplies font sizes
    out property <float> card-depth: 0.4;   // 0..1, drives elevation
}
```

Every widget then uses `Math.round(10px * Theme.roundness)` etc. Go through `widgets.slint` and replace hard-coded radii/sizes with these.

**Step 3:** call `apply_appearance` at boot and from a new `on_prefs_changed` path.

**Verification:** run the app, flip theme/accent/density/roundness/text-scale in a temporary debug panel (replaced by Phase 5's Settings) and confirm every screen follows. Confirm `--render-check` produces two distinct goldens for light and dark.

**Commit:** `feat(ui): appearance preferences drive the palette`

---

### Task 2.2 — Persist preferences through the engine

**Files:** Modify `src/state.rs`, `src/main.rs`

**Spec:** `src/ui/hooks.ts:useVault` — `savePreferences` path.

**Step 1:** at boot, `let prefs = normalise_preferences(engine.preferences())`.
**Step 2:** add `fn save_prefs(ui, state, prefs)` that calls `engine.save_preferences(to_value(&prefs))`, then `apply_appearance`.
**Step 3:** `ShellState` (`trayEnabled`, `closeToTray`, `launchAtLogin`, `soundsMuted`) now **mirrors** its four prefs counterparts instead of living separately: on change, write both `shell.json` (for the tray, which exists before unlock) and `vault.json` prefs. `write_state` loses `#[allow(dead_code)]`.
**Step 4:** add a test in `crates/colax-core/tests/prefs.rs` proving `save_preferences` → reload → identical struct.

**Verification:** change a pref, restart, confirm it held.

**Commit:** `feat: preferences persist and load through the engine`

---

## Phase 3 — Sidebar, four views, search, item CRUD

**Intent:** the app becomes usable as a vault.

### Task 3.1 — `models.slint`: the cross-boundary structs

**Files:** Modify `ui/models.slint`

Define everything Rust will push down. Design them once, carefully — they are the contract.

```slint
export struct LoginCard {
    id: string,
    label: string,          // labelOf: title || username || hostname || "Untitled"
    title: string,
    username: string,
    hostname: string,
    url: string,
    initial: string,
    tile: color,            // accent_of() hue -> solid
    favorite: bool,
    needs-attention: bool,
    has-totp: bool,
    totp-code: string,      // empty when not applicable
    totp-remaining: int,    // seconds, drives the ring
    badges: [Badge],        // weak / stale / reused / secured, computed in Rust
    tags: [TagChip],
    notes: string,
    masked-password: string,// "••••••••", never the real one
    modified-note: string,  // "Password 2 days ago · Username last week"
    secured: bool,          // gates reveal/edit behind SecurityGate
    selected: bool,
    duplicate: bool,
    hue: int,               // for per-card accent
    has-image: bool,
    image: image,
}

export struct SidebarRow {
    id: string,
    kind: int,              // 0 channel, 1 folder, 2 separator
    label: string,
    icon: string,
    hue: color,
    count: int,
    depth: int,
    expanded: bool,
    hidden: bool,
    locked: bool,
    selected: bool,
    is-builtin: bool,
}

export struct Badge { label: string, tone: int }
export struct TagChip { name: string, hue: color, compact: bool }
export enum ViewKind { Flow, Orbit, List, Grid }
```

**Never put a password in a model.** `main.slint:27-38` records why: passwords stay in the engine and are fetched by id on demand. Every struct here obeys that.

### Task 3.2 — The shell

**Files:** Create `ui/shell.slint`; Modify `ui/main.slint`

**Spec:** `E:\acc2\src\ui\App.tsx:2860-3215` (the `.shell` grid) and `src/styles/app.css` `.shell`, `.sidebar`, `.topbar`, `.content`.

```slint
// grid-template-columns: 272px 1fr  (or 1fr 272px when rail=right)
export component Shell inherits Rectangle {
    in property <SidebarPosition> rail;    // Left | Right | Top | Bottom
    // slots: sidebar, topbar, content, dock, overlays
}
```

Port these states from `App.tsx`:
- locked folder → `SecurityGate`
- `kind == 'mail'` → mail screen (Phase 9 placeholder)
- `kind == 'history'` → history (Phase 7 placeholder)
- `kind == 'dashboard'` → dashboard (Phase 7 placeholder)
- empty search → `EmptyState`
- otherwise → active view

Topbar: spacer + sidebar-recovery pill (when rail hidden), centre search with `/` hint and clear button, `New login` action.

**Verify:** `--render-check` walks Shell in all four rail positions.

### Task 3.3 — Sidebar

**Files:** Create `ui/screens/sidebar.slint`; Create `src/items.rs`

**Spec:** `E:\acc2\src\ui\Sidebar.tsx` (662 lines) — channel rows, folders (expand/collapse, children), separators, DnD reorder, compact mode, footer `Compact · Hide · Settings · Shortcuts · Lock`, empty hint.

Rust side: `build_sidebar(prefs) -> Vec<SidebarRow>` using `colax_core::channels`.

Start **without** drag-and-drop (Phase 8); get selection, expansion, counts and filtering right first.

### Task 3.4 — The four views

**Files:** Create `ui/screens/list.slint`; Modify `src/items.rs`

**Spec:** `E:\acc2\src\ui\views.tsx` (1,587 lines) — `AnimatedListView` L649-912, `CarouselView` L918-1107, `BasicView` L1113-1318, `GridView` L1337-1581; helpers `labelOf`, `maskOf`, `LoginMark`, `TagChips`, `HealthBadges`, `ModifiedNote`, `isStale`. Defaults at `storage.ts:91-101`.

Order: **List → Grid → Flow → Orbit.**

1. **List** is the baseline and exercises every card element: `LoginMark`, badges, title + star, action row (copy/edit/reveal/more), reveal state showing username + plaintext password, letter groups.
2. **Grid** reuses the same cell with different layout and 2-D reorder later.
3. **Flow** is the staggered-entrance list — in Slint, animate `opacity`/`y` per row using the `motion`/`motionSpeed` prefs (`tokens.css:51-58`) rather than porting `motion/react`.
4. **Orbit** is a 3-D ring. Slint has no 3-D transforms; implement it as a horizontal carousel with per-card `scale`/`opacity` derived from `Math.cos(angle)` — visually equivalent to `CircularCarousel`'s depth fade at `preset="orbit"`. Autoplay "drift" becomes a `Timer` advancing the angle.

**Verify:** one golden per view in `--render-check`, all fed the same fixture vault.

### Task 3.5 — Search, sort, filter

**Files:** Modify `src/items.rs`; Modify `crates/colax-core/src/prefs.rs` if a helper is missing

**Spec:** sort modes at `storage.ts` `SortMode` + labels `SORT_LABELS`; search matches title/username/url/notes/tags (check `App.tsx` search handler — do not guess); `pinFavorites` floats favourites; `manualOrder` for `sort == "manual"`; channel filter via `apply_channel`.

### Task 3.6 — Item CRUD

**Files:** Create `src/item_ops.rs`; Modify `ui/main.slint` (wire callbacks)

**Spec:** `src/ui/hooks.ts` `useVault` (`addItem`, `updateItem`, `deleteItem`, `restoreItem`, undo/redo stacks) and `App.tsx` handlers.

Implement: add, update (with `password_updated_at` stamping already in `engine.rs:277-293`), delete (honouring `confirmDeletes`), restore, favourite toggle, attention toggle, undo/redo (`replace_items`, stacks bounded to 50, `Ctrl+Z`/`Ctrl+Shift+Z`), multi-select + bulk edit/delete.

**Gate:** create a login from the UI in all four views, edit it, delete it, undo the delete, restart the app, confirm it stayed deleted.

**Commit:** `feat(ui): sidebar, four views, search and item CRUD`

---

## Phase 4 — Item editor, generator, security form

### Task 4.1 — Generator component

**Files:** Create `ui/screens/generator.slint` (reused by the editor and Settings)

**Spec:** `src/ui/ItemEditor.tsx` `Generator` — Random/Words segmented, preview + eye + dice + copy, length slider 8–64 or words 3–10, set toggles, `StrengthMeter`, `Use this password`, "Turn on at least one character set."

Backed entirely by `colax_core::passwords` (Task 1.1).

### Task 4.2 — Strength meter

**Files:** Modify `ui/widgets.slint`

**Spec:** `src/ui/primitives.tsx` `StrengthMeter` — five bands from `score`, colour from tone, optional `bits`/`crack time` readout.

### Task 4.3 — The editor's nine sections

**Files:** Create `ui/screens/editor.slint`; Create `src/item_ops.rs` handlers

**Spec:** `src/ui/ItemEditor.tsx` (1,096 lines) — `SECTIONS` at L314.

| # | Section | Contents |
| --- | --- | --- |
| 1 | `identity` | Name, Website |
| 2 | `credentials` | Username, Password (mono, reveal, lock-gated), Generate, Share, `StrengthMeter`, inline Generator |
| 3 | `security` | `SecurityForm` (Task 4.4) |
| 4 | `reminders` | preset chips (Follow global / 15 min / 1 h / 12 h / 1 d / 7 d / 30 d / 90 d) + manual unit/number + computed flag-time note |
| 5 | `organise` | `TagPicker` (add + cloud of chips), Last changed date inputs with relative hints |
| 6 | `appearance` | `HUE_PRESETS` swatches + custom hue slider, background image (URL/upload/remove + preview), icon image, blur slider |
| 7 | `notes` | textarea |
| 8 | `inbox` | `showMail` toggle + `mailFilter` segmented + `InboxSection` (Phase 9 stub) |
| 9 | `flags` | `favorite`, `needsAttention` toggles |

Layout: left rail of icon+label buttons, main panel, footer Cancel / Save. Autosave drafts with `useDraftAutoSave`'s 350 ms debounce (`hooks.ts`) — implement as `slint::Timer`.

**Image uploads** need the save/open dialog extension in `platform.rs` plus `image`/`webp` downscale to `MAX_IMAGE_EDGE` with the `MAX_BACKGROUND_BYTES`/`MAX_AVATAR_BYTES` caps — port `src/ui/card-art.ts:130-190`.

### Task 4.4 — SecurityForm + QR

**Files:** Create `ui/screens/security_form.slint`; Modify `platform.rs`

**Spec:** `src/ui/SecurityForm.tsx` (623 lines) — four glance tabs (Authenticator / Passcode / Recovery / Passkey), staged-seed enrol (nothing saved until a 6-digit code confirms), QR via `qrcode` crate rendering the `otpauth://` URL from Task 1.2, passcode rules, question add/check/delete, passkey disabled-with-reason.

QR: `qrcode::QrCode::new(url)` → module matrix → paint as a grid of `Rectangle`s in Slint (no image encoding needed, and it stays crisp at any size).

**Gate:** add a login with a TOTP secret; scan the QR with a real authenticator app; confirm the displayed code matches; reveal a `secured` login only after passing the gate.

**Commit:** `feat(ui): item editor, generator and security form`

---

## Phase 5 — Settings window

**Files:** Create `ui/screens/settings.slint`; Create `src/settings_ops.rs`

**Spec:** `src/ui/Settings.tsx` (2,711 lines) + `src/ui/SettingsWindow.tsx` (202) + the `VaultPreferences` schema already ported in Task 1.6.

**Structure:** in-page window with a tab rail sliding in from the side, `Ctrl/Cmd+1–9` to jump, `Escape` to close. `SettingsWindow.tsx` defines the chrome; `Settings.tsx` defines the content.

| Tab | Controls (complete, from the inventory) |
| --- | --- |
| **appearance** | Theme (light/dark/system previews), Accent (4 presets), Animation intensity, Animation speed, Glow, Text size, Corner roundness, Card shadow, Density, Transparency, High contrast |
| **layout** | Group list by letter, Auto-tag new logins, Show unassigned channel, New tags become channels, Channel labels, Rail position, Card size (per view), Quick-launch docks, Default view, Sort by, Show websites, Label orbit nodes, Pin favorites, Health badges, + 8 individual chrome-visibility toggles (shortcuts / lock / new-channel / compact / new-login / bulk-add / settings / hide-sidebar), Show sidebar, Floating controls, Hide dividers |
| **hidden** | Dynamic lost-and-found grouped Topbar / Floating bars / Sidebar / Login cards, each with a Show action; `Show all N`; empty state |
| **background** | Image URL + upload + remove, opacity, blur, dim |
| **channels** | `ChannelManager` — channel rows (dot, name, badges, count, eye, edit), New channel / Hide all / Show all; tags: add, rename, hue, usage count, delete (scrubs from logins) |
| **generator** | Default length 8–64; `lower`/`upper`/`digits`/`symbols`/`avoidAmbiguous` |
| **security** | **locking**: auto-lock select (default 5 min), vault `SecurityForm`, Lock now, KDF/encryption chips · **clipboard**: clear-seconds select (default 30), clear-on-lock, detect, auto-save · **warnings**: warn-on-reuse, auto-tag-reused, password-age days (180), email-age (365), email-check (90), mask emails · **confirmations**: confirm-before-export, confirm-deletes, copy-toasts |
| **alarms** | alarm rows (time, label, days, Test, enable, Delete) + New alarm (label, time, day chips, import sound ≤300 KB / reset to chime, Add) |
| **data** | stored count + KB, version chip, Export CSV, Import CSV, Delete all data (confirm modal) |
| **backup** | Export (with `confirmBeforeExport` → "Protect this backup" modal, strength ≥2 gate), Restore (file dialog → password → optional re-key) |
| **desktop** | Run at startup, System tray, Minimise to tray on close, Mute all sounds |
| **optimize** | **general**: Balanced / Maximum savings / Restore my look, saved profiles (name, save, apply, rename, overwrite, delete, active tick), "What it costs" metrics + Measure again, Reset · **look**: 7 toggles · **speed**: low-memory, hardware accel, disable spellcheck · **messages**: slower polling, inline images, page size 25/50/100, clear cache |
| **about** | version chip, `offline only` chip, Copy diagnostics (JSON to clipboard), Keyboard shortcuts → open sheet, Reset preferences, Created by → `iraveos` |

**Sub-patterns to build once and reuse:** `Row` (label/hint/control, stacked variant), `SubTabs`, `Slider` with formatted value, `ThemePreview` swatch, `BackgroundSection`.

**Known dead code — do not port:** `ChangePasswordModal` / `SetPasswordModal` / `DisablePasswordModal` in `Settings.tsx` are unreachable (their setters are never called). The reachable path for vault-password change is Settings › Security › locking. Note this in a comment so the next reader doesn't think it was missed.

**Gate:** walk every tab with `--render-check`; for 10 spot-checked controls, change → restart → confirm persisted and visually applied.

**Commit:** `feat(ui): settings window with thirteen tabs`

---

## Phase 6 — Security and locking

**Files:** Create `ui/screens/security.slint`; Create `src/security_ops.rs`

### Task 6.1 — SecurityGate

**Spec:** `src/ui/SecurityGate.tsx` (217 lines). Any one factor passes. Order: Passcode → Authenticator → Recovery question, segmented control only when >1 factor exists. Passcode field + Enter; 6-digit numeric input; question `<select>` + answer. Exact error strings from the file. Invoked from: per-login reveal in all four views, pending-item edit/reveal, folder open, vault-level verification (`prefs.vaultSecurity`).

Backed by `colax_core::security` (Task 1.3).

### Task 6.2 — LockScreen upgrades

**Spec:** `src/ui/LockScreen.tsx` (296 lines). Add what the current Slint lock screens lack: the strength meter on password entry, `Suggest a strong vault password` (Task 1.1), the Sun/Moon theme toggle, the persistent-storage warning, and `That password is not correct.` clearing the field.

### Task 6.3 — Auto-lock

**Spec:** `src/ui/hooks.ts` `useAutoLock`. Activity on `pointerdown`/`keydown`/`wheel`/`touchstart` resets an `autoLockMinutes` timer (default 5). In Slint, a single `TouchArea`-wide activity signal plus `TextInput` edits feed one `reset_activity()`; a `slint::Timer` fires the lock.

On lock: drop the engine key (`engine.lock()`), and if `clearClipboardOnLock`, wipe the clipboard.

### Task 6.4 — Clipboard clear + capture

**Files:** Modify `platform.rs` (add read + clear)

**Spec:** `src/ui/hooks.ts` `useClipboard` (L570-620) and `src/ui/useClipboardWatcher.ts` (504 lines).

- `clearClipboardSeconds` (default 30) → `Timer` that overwrites with `""`, but only if the clipboard still holds our own write (self-write marks for 15 s).
- Capture: poll every 2.5 s when `clipboardCapture` is on; run `inspect_capture` (Task 1.9); `clipboardAutoSave` saves directly, otherwise raise the "Login found on the clipboard" modal with Not now / Save to vault.
- Reuse warning → tappable toast when `warnOnReuse`.

**Gate:** copy a password, wait 30 s, confirm cleared; copy a credential not in the vault with capture on, confirm the offer modal appears; leave the app idle past `autoLockMinutes`, confirm it locks.

**Commit:** `feat: security gate, auto-lock and clipboard handling`

---

## Phase 7 — Dashboard, history, alarms

### Task 7.1 — Dashboard

**Files:** Create `ui/screens/dashboard.slint`

**Spec:** `src/ui/Dashboard.tsx` (1,021 lines).

Widgets: security summary ring (0–100, bands Excellent/Good/Needs work/At risk, "Review now"); four stat tiles (Total / Favorites / Weak / Untagged) each navigating to a channel; "Needs your attention" issue list; Recent Logins; Recent mail; Insights (strength bands + popover, 30-day sparkline, most logins per site, reused clusters, most-used top 5/20); Email review; Second factors; Channels distribution bars; Quick actions (New login / Bulk add / New channel); Organize signposts.

All metrics computed in Rust from `items` + `prefs` using `health.rs` and `channels.rs` — keep `dashboard.slint` purely presentational.

Sparklines: Slint `Path` elements with the points computed in Rust.

### Task 7.2 — History panel

**Files:** Create `ui/screens/history.slint`

**Spec:** `src/ui/HistoryPanel.tsx` (248 lines) — search, filter chips All/Added/Edited/Deleted, day-grouped rows, actions Restore / Edit / Copy password / Copy address / Forget, "Clear log". Backed by `history.rs` (Task 1.7) and `engine.restore_item`.

### Task 7.3 — Alarms

**Files:** Create `src/alarms.rs`; Modify `settings.slint`

**Spec:** `src/ui/useAlarms.ts` (66 lines) — 1 s tick matcher against `Alarm { time: "HH:MM", days: 0..6, sound, enabled }`, default chime as three sine tones (port `playDefaultChime`'s frequencies directly), imported sound as a data URL → `rodio` decoder, muted by `soundsMuted`.

Local-time conversion for `HH:MM` matching: `time` is already a dependency; add `time-tz` only if the zone database is needed.

**Gate:** dashboard numbers match a hand-built 20-item vault; history shows every edit made during Phases 3–6; an alarm set one minute out fires.

**Commit:** `feat: dashboard, history and alarms`

---

## Phase 8 — Context menus, shortcuts, docks, appearance tuner

### Task 8.1 — Cascading context menu

**Files:** Create `ui/screens/menus.slint`; Create `src/menus.rs`

**Spec:** `src/ui/context-menu.tsx` (551 lines) — menu model (`item`/`separator`/`submenu`), root width 232 / submenu 224, keyboard (arrows, right/left for submenu open/close, Enter/Space, Escape closes one level then all, type-ahead), close on outside pointer-down / wheel / blur / resize.

`src/menus.rs` builds the trees; `menus.slint` renders them. Port **every** menu from the inventory:

- `newChannelMenu` — Channels / Bars / Show hidden / Hide sidebar / Channel layout ▸ / Rail position ▸ / Card size ▸ / Card appearance… / Quick add ▸
- `bulkChannelMenu` — Hide / Show / Move to folder ▸ / Delete / Clear
- `channelMenu` — Open / Edit / Colour ▸ / Icon ▸ / Show ▸ / Filter by tag ▸ / Move to folder ▸ / Add separator / New channel / Show-Hide / Delete
- `folderMenu`, `separatorMenu`
- `itemMenu` — Copy password/username/URL, Share, favourite, flag, Edit, Card size ▸, Open ▸ (with reused-password note), Delete
- `appMenu` — New login, Show sidebar, Switch view ▸, Card size ▸, Sort by ▸, Appearance ▸, Settings, Show hidden, Shortcuts, Lock
- `dockMenu`, `dockSlotMenu`, `hideEntry`, `bulkMenu`
- Shift+right-click → view switcher

### Task 8.2 — Global keyboard shortcuts

**Files:** Create `src/shortcuts.rs`

**Spec:** `src/ui/hooks.ts` `useHotkeys` (~L380-410), `useSelectAllShortcuts`, `useViewShortcuts` (`ViewMenu.tsx`), `useDockShortcuts` (`Dock.tsx`).

| Key | Action |
| --- | --- |
| `/` | focus search |
| `N` | new login |
| `L` | lock vault |
| `V` | cycle view |
| `?` | shortcuts sheet |
| `Esc` | close editor → confirm → shortcuts sheet; clears selection |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | undo / redo |
| `Alt+1–9` | jump to first 9 sidebar channels |
| `Ctrl+A` | select all in view |
| `Ctrl+1–4` | Flow / Orbit / List / Grid |
| `Ctrl+1–9` | Settings tab (when Settings open) |
| bare chars | dock slot keys (pool 1–9 then a–z) |

All guarded: skip when a text field, menu, dialog or editor has focus (`typingHasFocus()` at `hooks.ts`). In Slint, route through one `KeyEvent` handler on `MainWindow` and reproduce the guard precisely.

Also port the shortcuts sheet content (`App.tsx:3736-3746`).

### Task 8.3 — Docks

**Files:** Create `ui/screens/dock.slint`; Create `src/settings_ops.rs` handlers

**Spec:** `src/ui/Dock.tsx` (296), `src/ui/DockSettings.tsx` (454), dock types + `normaliseDockSlots` at `storage.ts:114-192`/`1021`.

Up to 4 bars, free placement + edge snap, family dividers (`views / go / logins / mail`), hue dot, `KeyRecorder` (capturing a bare key for a slot), `useDockShortcuts`.

### Task 8.4 — Appearance tuner

**Files:** Create `ui/screens/appearance_tuner.slint`

**Spec:** `src/ui/AppearancePanel.tsx` (235) — right-edge slide-over: Size (Scale 0.6–1.6, Width, Orbit height/aspect or min height, Corner radius 0–48), Accent swatches (`CHANNEL_ACCENTS`), Reset to view defaults.

### Task 8.5 — Reordering (drag and drop)

**Spec:** `views.tsx` `useLoginReorder` — press-and-hold 120 ms, >8 px arms the drag, ghost follows pointer at offset (−24, −20), before/after indicators, edge auto-scroll (56 px margins, ±10), click suppressed 400 ms after drop, Grid uses 2-D slot math. Also `Sidebar.tsx` DnD and `sidebar-dnd.test.ts`.

Slint has no native drag API beyond `TouchArea` `moved`/`pressed` — implement with pointer capture semantics on the `TouchArea`.

**Gate:** complete a full run of the app using only the keyboard; right-click in every region and confirm the correct menu; configure a dock slot with a key and trigger it.

**Commit:** `feat: context menus, keyboard shortcuts, docks and appearance tuner`

---

## Phase 9 — Mail engine, platform polish, packaging

This is the only phase with genuinely new engineering rather than ports.

### Task 9.1 — Provider table and connection config

**Files:** Create `src/mail/providers.rs`

**Spec:** `src/lib/mail-providers.ts` (216 lines) — `providerForAddress` (longest-domain match), `resolveConnection`, `accountLabel`, and the full table: gmail, outlook, yahoo, icloud, fastmail, zoho, yandex, aol, gmx, **proton bridge `127.0.0.1:1143`**, custom — each `{host, port, secure, domains, appPasswordUrl, hint}`.

Port verbatim as `const PROVIDERS: &[Provider]`.

### Task 9.2 — IMAP client on a worker thread

**Files:** Create `src/mail/imap.rs`, `src/mail/mod.rs`

**Spec:** `electron/mail-imap.ts` (509 lines) — one persistent connection per mailbox, retry with backoff, `inboxList`, `fullMail` (body + inline images).

```rust
// src/mail/mod.rs
pub enum MailRequest { ListInbox { account: String, since: Option<String> },
                       FullBody { account: String, uid: String },
                       Disconnect { account: String } }
pub enum MailResponse { ListInbox { account: String, messages: Vec<MailSummary> },
                        FullBody { account: String, body: MailBody },
                        Failed { account: String, error: String } }

pub fn spawn_mail_worker() -> (Sender<MailRequest>, Receiver<MailResponse>);
```

- One `std::thread` named `colax-mail`, `std::sync::mpsc` both ways.
- `imap::Client::new(host, port)` + `native_tls` connector, `login`, `select("INBOX")`, `fetch`/`fetch_set`.
- App side: `slint::Timer` at 500 ms drains `MailResponse` and updates models. Nothing blocking ever runs on the UI thread.
- Never log credentials; the existing capability-per-function rule means `account.app_password` never leaves `mail/`.

**Verification:** connect a real Gmail mailbox with an app password; list; open a message.

### Task 9.3 — MIME parsing

**Files:** Create `src/mail/mime.rs`

**Spec:** `src/lib/mail-text.ts` (222 lines) — `pickTextPart`, `pickHtmlPart`, `collectInlineImages`, `decodeQuotedPrintable`, `decodePartBytes`, `stripHtml`.

- `mailparse` walks the MIME tree and transfer-decodes.
- `encoding_rs` decodes charset labels — the TS version explicitly handles non-UTF-8 labels (`windows-1256`, `iso-8859-6`) that `TextDecoder` supports; `encoding_rs` implements the same WHATWG label table.
- `stripHtml`: the TS version is deliberately regex-based (`mail-text.ts:186-232`) and there are tests for it (`test/mail-text.test.ts`) — port the **regexes**, not a DOM parser, so the fixtures pass unchanged.

### Task 9.4 — Sanitising and rendering mail bodies

**Files:** Create `src/mail/sanitize.rs`; Create `ui/screens/full_mail.slint`

**Spec:** `src/ui/FullMail.tsx` (91 lines).

Slint has no HTML widget, so: sanitise with `ammonia` (allowlist mirroring DOMPurify's config in `FullMail.tsx:38`), then convert the sanitised fragment into a small rich-text model — a `Vec<Block>` of `{ kind: Paragraph|Heading|Quote|Code|List, spans: Vec<Span { text, bold, italic, link }> }` — and render it with `Text` elements. Handle:
- `cid:` images → resolved from the fetched inline images
- remote images → blocked placeholder with a label (TS blocks them deliberately)
- all links → routed through `open_external`

### Task 9.5 — OAuth

**Files:** Create `src/mail/oauth.rs`

**Spec:** `src/lib/oauth.ts` (248 lines) + `electron/oauth.ts` (246 lines).

- `OAUTH_PRESETS` google / microsoft / custom (`consoleUrl`, hints)
- `build_authorize_url` with PKCE S256 (`sha2` + `base64` URL-safe + `rand` — all present) and a random `state`
- loopback listener on `127.0.0.1:<port>` via std `TcpListener`, single request, respond with a small success page, then close
- `ureq` for the token exchange; `webbrowser` (or `cmd /c start`) to launch the OS browser
- `parse_token_response`, `access_token_usable` (60 s skew), `normalise_mail_oauth`
- token refresh before expiry; refresh token stored **in the encrypted vault item**, never in `shell.json`

### Task 9.6 — Mail UI

**Files:** Create `ui/screens/mail.slint`

**Spec:** `src/ui/MailCenter.tsx` (149), `MailboxWindow.tsx` (50), `MailMessages.tsx` (452), `LoginMessages.tsx` (478), `InboxSection.tsx` (715), `useGmail.ts` (434), `useFullBody.ts`.

MailCenter header (Manage mail / Connect a mailbox) + empty onboarding; `MailboxTabs` (buttons ≤4, `Select` above); message list with server-side search (Enter runs, Escape clears), status note, error + Retry, `Load older messages` (UID paging), expandable rows → From/Date/Mailbox dl, `Open in <provider>`; per-login `LoginMessages` expander with Refresh and count.

`useGmail.ts`'s unauthenticated `https://mail.google.com/mail/feed/atom` fetch is renderer-side in the web build; port it with `ureq` including the `document.hidden` check (window focus state from Slint).

**Gate:** read, search, page and open a real mailbox end to end; confirm a `LoginMessages` expander shows the right messages for one login.

**Commit:** `feat: mail engine (IMAP, OAuth, MIME) and mail UI`

---

### Task 9.7 — Platform polish

| Item | Spec | Approach |
| --- | --- | --- |
| Save dialog | `Settings.tsx` CSV export, image upload | extend `platform.rs` with `GetSaveFileNameW` mirroring the existing `GetOpenFileNameW` |
| Image pipeline | `src/ui/card-art.ts:130-190` | `image` decode → resize to `MAX_IMAGE_EDGE` → `webp` encode → base64; caps `MAX_BACKGROUND_BYTES`, `MAX_AVATAR_BYTES` |
| Sounds | `src/ui/useAlarms.ts:33-71` | `rodio`; default chime = three sine tones with TS frequencies; imported sound = `rodio` decoder |
| Tray mute | `main.rs` `on_mute_requested` | now real: toggles `soundsMuted`, rewrites `shell.json` + prefs |
| Tray menu | `main.slint` `AppTray` | enable/disable `Lock now` per unlock state (exists); Mute becomes live |
| Activity/focus | `src/lib/activity.ts` | Slint window active state → `appActiveNow` equivalent |
| Capture extension | `src/ui/useCaptureOffer.ts` | the Chrome extension relays via `postMessage`/`chrome.runtime`; there is no browser here. Provide the same flow over a `127.0.0.1` loopback port the extension can target, or gate the feature behind a `platform.name == 'web'`-style capability flag and show the existing "needs the desktop app" wording inverted. Decide and document in code. |
| Autostart / tray / close-to-tray | `Settings › desktop` | `apply_autostart` exists; wire the four toggles to `ShellState` + prefs (Task 2.2) |
| Update `--render-check` | — | add goldens for every Phase 3–9 screen |

### Task 9.8 — Packaging

**Files:** `packaging/colax-lite.nsi`, `packaging/build-installer.ps1`, workspace `Cargo.toml`

**Spec:** both files already exist and work. Changes needed:

1. Bump `workspace.package.version` past `1.1.0`.
2. Confirm the NSIS script's `!define APP_EXE` and version injection still match.
3. Confirm uninstall still leaves `%APPDATA%\app.colax.lite` behind (`colax-lite.nsi` deliberately does this — do not "fix" it).
4. New `vault.json` fields (`showMail`, `mailFilter`) must survive an upgrade from a 1.1.0 vault — covered by Task 1.6's round-trip test, but add an explicit fixture from a real 1.1.0 `vault.json`.

Run: `powershell -File packaging\build-installer.ps1`
Expected: `Colax Lite Setup <version>.exe` at `E:\acc2\colax-lite-native\`.

### Task 9.9 — Final gate

```bash
cargo test -p colax-core
cargo build --release -p colax-lite
./target/release/colax-lite.exe --render-check
cd E:\acc2 && npm test        # source untouched
powershell -File packaging\build-installer.ps1
```

All four green. Then:

```bash
git add colax-lite-native
git commit -m "feat: full Colax feature parity in the native build"
```

---

## 6. Cross-cutting rules

1. **Never block the UI thread.** Engine work stays in a short `borrow()` as `main.rs` already does (the file header records why: setting `screen` re-enters handlers). Mail and image work go to threads; results come back through `slint::Timer` polling.
2. **Never put a secret in a Slint model.** `main.slint:27-30` states the rule; every struct in `models.slint` obeys it. Passwords are fetched by id on demand.
3. **Message strings come from the TS files, verbatim.** Error text is user-visible behaviour — `"That password is not correct."`, `"That backup password is not correct."`, `"The two passwords do not match."` already exist in `main.rs` and match the TS.
4. **Every new core module is test-first against a TS fixture.** Extend `make-ts-fixture.mjs` rather than hand-writing expected values, except for standard-vector tests (RFC 6238) where the standard is the fixture.
5. **`E:\acc2\src` is read-only for this plan.** The web build must keep building and its 26 test files must keep passing. If a port reveals a genuine bug in the TS, fix it in a separate, clearly-labelled commit with its own test — do not fold it into a port.
6. **Add a phase gate, not a hope.** Each phase ends with the four commands in Task 9.9 (minus packaging until Phase 9).
7. **Commit at every task boundary.** The tree is currently untracked; Task 0.1 fixes that first so every subsequent change is reviewable.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| **Scale.** ~31,500 lines of TS to port; the plan is 10 phases by design. | Phase 1 is pure and independently testable; Phases 3–8 each ship something visibly usable. Do not start a phase before the previous gate is green. |
| **Orbit view in Slint** has no 3-D transforms. | Cosine-derived scale/opacity approximation (Task 3.4). Accept a visual delta; pin it with a golden. |
| **Mail bodies have no HTML renderer.** | Sanitise → rich-text model → `Text` blocks (Task 9.4). Styling will be simpler than the web build's; that is acceptable and should be stated in the UI if a body degrades. |
| **Slint has no focus trap / native dropdown / drag API.** | All three are hand-built in `widgets.slint` (Modal, Select) and Task 8.5. Port the behaviours described in `primitives.tsx`, not browser defaults. |
| **Prefs shape drift** between the web build and this one. | `normalise_preferences` round-trip test + a TS-generated `ts-prefs.json` fixture; retired fields are still written back. |
| **`export_backup` drops preferences** (`engine.rs:405`). | Fixed in Task 1.6 with a test. |
| **`VaultItem` missing `showMail`/`mailFilter`** silently drops data on re-save. | Fixed in Task 1.6 with a round-trip test. |
| **The tree is untracked in git.** | Task 0.1 commits it before any change is made. |
| **Build times.** Release is `codegen-units=1` + full LTO. | Use `cargo build -p colax-lite` (dev) during development; release only at phase gates. |
