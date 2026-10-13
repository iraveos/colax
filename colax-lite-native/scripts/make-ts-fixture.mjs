// Generates cross-compatibility fixtures for the native engine's test suite.
//
// Run from the repo root (E:\acc2):
//   node --experimental-strip-types colax-lite-native/scripts/make-ts-fixture.mjs
//
// Outputs:
//   crates/colax-core/tests/fixtures/ts-vault-backup.json
//       A real backup produced by the *actual TypeScript VaultService* in
//       `lite version/` (600k-iteration PBKDF2, real WebCrypto AES-GCM).
//       The Rust test suite restores it, proving byte compatibility in the
//       direction that matters: TS wrote, Rust reads.
//
// Also prints the known-answer vector constants embedded in
// crates/colax-core/src/crypto.rs, so they can be regenerated if the format
// ever changes.

import { pbkdf2Sync, createCipheriv, webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
// Base URL must end in "/" for new URL(rel, base) to resolve inside it.
const liteSrcUrl = pathToFileURL(join(here, "..", "..", "lite version", "src")).href;
const liteSrc = liteSrcUrl.endsWith("/") ? liteSrcUrl : `${liteSrcUrl}/`;
const fixturesDir = join(here, "..", "crates", "colax-core", "tests", "fixtures");

// Fixture credentials are synthetic and stay synthetic. Nothing here is a
// password anyone could have been using: the phrase is a build label and the
// item values name the fixture they belong to, so a secret scanner looking at
// this repository finds test data rather than something that has to be rotated.
const MASTER = "colax-lite-fixture-key-v1";

/* ---- 1. Backup from the real TS app ------------------------------------ */

const { VaultService } = await import(new URL("vault/vault-service.ts", liteSrc).href);
const { MemoryVaultStorage } = await import(new URL("vault/storage.ts", liteSrc).href);
const { serializeBackup } = await import(new URL("vault/backup.ts", liteSrc).href);

const vault = new VaultService(new MemoryVaultStorage());
await vault.create(MASTER);
await vault.addItem({
  title: "GitHub",
  username: "me@example.com",
  password: "fixture-value-one",
  url: "github.com",
  notes: "work account",
});
await vault.addItem({
  title: "Bänk 日本語 🔐",
  username: "björn@example.se",
  password: "fixture-ünïcode-値-🔐",
  url: "https://example.se/login",
  tags: ["finance"],
  favorite: true,
  notes: "unicode everywhere: ✨ — dash",
});

const backup = await vault.exportBackup();
mkdirSync(fixturesDir, { recursive: true });
const fixturePath = join(fixturesDir, "ts-vault-backup.json");
writeFileSync(fixturePath, serializeBackup(backup), "utf8");
console.log(`wrote ${fixturePath}`);
console.log(`  protection=${(await vault.protection())}, items=${backup.items.length}, iterations=${backup.header.iterations}`);

/* ---- 2. Known-answer vector for crypto.rs ------------------------------ */
//
// Fixed salt/VEK/nonces so Rust can prove, byte for byte, that PBKDF2, the
// AADs and AES-GCM agree with Node's WebCrypto (what the TS app ran on).

const iterations = 1000;
const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const vek = Buffer.from("0f0e0d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100", "hex");
const ivWrap = Buffer.from("0102030405060708090a0b0c", "hex");
const ivItem = Buffer.from("0c0a0e0d0b09080706050403", "hex");
const b64u = (b) => Buffer.from(b).toString("base64url");

const kek = pbkdf2Sync(MASTER, salt, iterations, 32, "sha256");

const c1 = createCipheriv("aes-256-gcm", kek, ivWrap);
c1.setAAD(Buffer.from("aegis.vault.v1.wrap"));
const wrappedCt = Buffer.concat([c1.update(vek), c1.final(), c1.getAuthTag()]);

const itemPlain = JSON.stringify({ id: "item-a", title: "GitHub", secret: "alpha" });
const c2 = createCipheriv("aes-256-gcm", vek, ivItem);
c2.setAAD(Buffer.from("aegis.vault.v1.item:item-a"));
const itemCt = Buffer.concat([c2.update(itemPlain), c2.final(), c2.getAuthTag()]);

console.log("\nknown-answer vector (paste into crypto.rs tests):");
console.log(
  JSON.stringify(
    {
      KAT_KEK_HEX: kek.toString("hex"),
      KAT_SALT_B64: b64u(salt),
      KAT_VEK_B64: b64u(vek),
      KAT_ITEM_IV: b64u(ivItem),
      KAT_ITEM_CT: b64u(itemCt),
      KAT_ITEM_PLAIN: itemPlain,
      header: {
        v: 1,
        protection: "password",
        kdf: "PBKDF2-SHA256",
        iterations,
        salt: b64u(salt),
        wrapped: { iv: b64u(ivWrap), ct: b64u(wrappedCt) },
      },
    },
    null,
    2,
  ),
);
