import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import {
  SecretError,
  type PassphraseProvider,
  type SecretBackend,
} from "./types.js";

const VERSION = 1;
const NONCE_BYTES = 24;
const KEY_BYTES = 32;
const CHECK_PLAINTEXT = "cfward-vault-ok";

/**
 * N=2^16 is roughly 64 MB of RAM and ~0.3 s on desktop hardware. That is the
 * sensible ceiling for something interactive; going higher makes every command
 * feel sluggish. The parameters live in the file, so they can be raised later
 * without breaking existing vaults.
 */
const KDF = { algorithm: "scrypt" as const, n: 2 ** 16, r: 8, p: 1 };

interface Sealed {
  nonce: string;
  ciphertext: string;
}

interface VaultFile {
  version: number;
  kdf: typeof KDF & { salt: string };
  cipher: "xchacha20poly1305";
  /** Canary blob: validates the passphrase without touching any real entry. */
  check: Sealed;
  entries: Record<string, Sealed>;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/**
 * The profile name is used as additional authenticated data. That binds each
 * ciphertext to its slot: an attacker with write access to the file cannot
 * move the "production" blob into the "staging" slot and trick you into
 * deploying against the wrong account. AAD is authenticated, not encrypted.
 */
const aad = (profile: string) => new TextEncoder().encode(profile);

function seal(key: Uint8Array, profile: string, plaintext: string): Sealed {
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
  const ct = xchacha20poly1305(key, nonce, aad(profile)).encrypt(
    new TextEncoder().encode(plaintext),
  );
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}

function open(key: Uint8Array, profile: string, sealed: Sealed): string {
  const plain = xchacha20poly1305(
    key,
    unb64(sealed.nonce),
    aad(profile),
  ).decrypt(unb64(sealed.ciphertext));
  return new TextDecoder().decode(plain);
}

/** Atomic write: temp file then rename. Never leave a half-written vault. */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600, encoding: "utf8" });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export class VaultBackend implements SecretBackend {
  readonly id = "vault" as const;
  readonly writable = true;

  /**
   * The derived key is cached for the lifetime of the process. A CLI command
   * lives for seconds, so that is enough. Avoiding the passphrase prompt on
   * every command needs an ssh-agent-style daemon (unix socket + timeout) — v2.
   *
   * Honest caveat: JavaScript cannot reliably wipe a string from memory. The
   * key is held as a Uint8Array so it can be zeroed, but the token itself
   * passes through strings. Fully mitigating that would mean moving secret
   * handling into native code; for this tool's threat model (protecting
   * secrets at rest) it is an accepted and documented trade-off.
   */
  #key: Uint8Array | null = null;

  constructor(
    private readonly path: string,
    private readonly askPassphrase: PassphraseProvider,
  ) {}

  /** The vault is always available — it is just a file. */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async #read(): Promise<VaultFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let parsed: VaultFile;
    try {
      parsed = JSON.parse(raw) as VaultFile;
    } catch {
      throw new SecretError(
        "VAULT_CORRUPT",
        `The vault at ${this.path} is not valid JSON.`,
      );
    }

    if (parsed.version > VERSION) {
      throw new SecretError(
        "VAULT_VERSION",
        `The vault uses format v${parsed.version} but this build understands up to v${VERSION}.`,
        "Upgrade cfward.",
      );
    }
    return parsed;
  }

  async #unlock(file: VaultFile): Promise<Uint8Array> {
    if (this.#key) return this.#key;

    const passphrase = await this.askPassphrase({
      confirm: false,
      reason: "Unlock the cfward vault",
    });
    const key = await scryptAsync(passphrase, unb64(file.kdf.salt), {
      N: file.kdf.n,
      r: file.kdf.r,
      p: file.kdf.p,
      dkLen: KEY_BYTES,
    });

    try {
      if (open(key, "__check__", file.check) !== CHECK_PLAINTEXT)
        throw new Error();
    } catch {
      key.fill(0);
      throw new SecretError("BAD_PASSPHRASE", "Incorrect passphrase.");
    }

    this.#key = key;
    return key;
  }

  async #create(): Promise<{ file: VaultFile; key: Uint8Array }> {
    const passphrase = await this.askPassphrase({
      confirm: true,
      reason: "Create the cfward vault",
    });
    const salt = new Uint8Array(randomBytes(16));
    const key = await scryptAsync(passphrase, salt, {
      N: KDF.n,
      r: KDF.r,
      p: KDF.p,
      dkLen: KEY_BYTES,
    });

    const file: VaultFile = {
      version: VERSION,
      kdf: { ...KDF, salt: b64(salt) },
      cipher: "xchacha20poly1305",
      check: seal(key, "__check__", CHECK_PLAINTEXT),
      entries: {},
    };
    this.#key = key;
    return { file, key };
  }

  async get(profile: string): Promise<string | null> {
    const file = await this.#read();
    if (!file) return null;

    const entry = file.entries[profile];
    if (!entry) return null;

    const key = await this.#unlock(file);
    try {
      return open(key, profile, entry);
    } catch {
      // Authentication failure with the right key means the file was altered.
      throw new SecretError(
        "VAULT_CORRUPT",
        `Entry "${profile}" failed its integrity check.`,
        "The vault may have been tampered with. Re-add the profile.",
      );
    }
  }

  async set(profile: string, token: string): Promise<void> {
    let file = await this.#read();
    let key: Uint8Array;

    if (file) {
      key = await this.#unlock(file);
    } else {
      const created = await this.#create();
      file = created.file;
      key = created.key;
    }

    file.entries[profile] = seal(key, profile, token);
    await writeAtomic(this.path, JSON.stringify(file, null, 2));
  }

  async delete(profile: string): Promise<boolean> {
    const file = await this.#read();
    if (!file?.entries[profile]) return false;

    delete file.entries[profile];
    await writeAtomic(this.path, JSON.stringify(file, null, 2));
    return true;
  }

  /** For logout: drop the derived key without waiting for the process to exit. */
  lock(): void {
    this.#key?.fill(0);
    this.#key = null;
  }
}
