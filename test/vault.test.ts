import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretError } from "../src/secrets/types.js";
import { VaultBackend } from "../src/secrets/vault.js";

const passphrase = (value: string) => async () => value;

describe("VaultBackend", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cfward-"));
    path = join(dir, "vault.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a token", async () => {
    const vault = new VaultBackend(path, passphrase("correct horse"));
    await vault.set("production", "cf_token_PROD");
    vault.lock();

    expect(await vault.get("production")).toBe("cf_token_PROD");
  });

  it("never writes the token in plaintext", async () => {
    const vault = new VaultBackend(path, passphrase("correct horse"));
    await vault.set("production", "cf_token_PROD");

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("cf_token_PROD");
  });

  it("rejects a wrong passphrase without touching real entries", async () => {
    await new VaultBackend(path, passphrase("correct horse")).set(
      "production",
      "cf_token_PROD",
    );

    const wrong = new VaultBackend(path, passphrase("wrong"));
    await expect(wrong.get("production")).rejects.toMatchObject({
      code: "BAD_PASSPHRASE",
    });
  });

  it("returns null for an unknown profile", async () => {
    const vault = new VaultBackend(path, passphrase("correct horse"));
    await vault.set("production", "cf_token_PROD");

    expect(await vault.get("staging")).toBeNull();
  });

  it("detects entries swapped between profiles", async () => {
    const vault = new VaultBackend(path, passphrase("correct horse"));
    await vault.set("production", "cf_token_PROD");
    await vault.set("staging", "cf_token_STG");

    // The AAD binding ties each ciphertext to its profile name. Swapping the
    // sealed blobs must fail rather than deploy against the wrong account.
    const file = JSON.parse(await readFile(path, "utf8"));
    [file.entries.production, file.entries.staging] = [
      file.entries.staging,
      file.entries.production,
    ];
    await writeFile(path, JSON.stringify(file));

    const tampered = new VaultBackend(path, passphrase("correct horse"));
    await expect(tampered.get("production")).rejects.toMatchObject({
      code: "VAULT_CORRUPT",
    });
  });

  it("deletes an entry", async () => {
    const vault = new VaultBackend(path, passphrase("correct horse"));
    await vault.set("production", "cf_token_PROD");

    expect(await vault.delete("production")).toBe(true);
    expect(await vault.get("production")).toBeNull();
    expect(await vault.delete("production")).toBe(false);
  });

  it("surfaces a corrupt vault file as SecretError", async () => {
    await writeFile(path, "not json at all");
    const vault = new VaultBackend(path, passphrase("correct horse"));

    await expect(vault.get("production")).rejects.toBeInstanceOf(SecretError);
  });
});
