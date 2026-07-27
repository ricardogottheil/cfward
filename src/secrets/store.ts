import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EnvBackend } from "./env.js";
import { KeyringBackend } from "./keyring.js";
import { metadataPath, vaultPath } from "./paths.js";
import {
  SecretError,
  type BackendId,
  type PassphraseProvider,
  type ProfileMetadata,
  type SecretBackend,
} from "./types.js";
import { VaultBackend } from "./vault.js";

interface MetadataFile {
  version: 1;
  profiles: Record<string, ProfileMetadata>;
}

const EMPTY: MetadataFile = { version: 1, profiles: {} };

/**
 * Picks the write backend. The environment backend is never selected here: it
 * is consulted first in getToken() and nowhere else, because it cannot be
 * written to.
 *
 * CFWARD_BACKEND forces a specific one. Useful for tests, and for anyone who
 * prefers the vault despite having a keychain (sharing config across machines).
 */
export async function resolveBackend(
  askPassphrase: PassphraseProvider,
): Promise<SecretBackend> {
  const forced = process.env.CFWARD_BACKEND as BackendId | undefined;

  if (forced === "vault") return new VaultBackend(vaultPath(), askPassphrase);
  if (forced === "keyring") {
    const kr = new KeyringBackend();
    if (await kr.isAvailable()) return kr;
    throw new SecretError(
      "BACKEND_UNAVAILABLE",
      "CFWARD_BACKEND=keyring was set but the keychain is not responding.",
      "Unset the variable to fall back to the encrypted vault.",
    );
  }

  const keyring = new KeyringBackend();
  if (await keyring.isAvailable()) return keyring;
  return new VaultBackend(vaultPath(), askPassphrase);
}

export class SecretStore {
  readonly #env = new EnvBackend();

  private constructor(
    readonly backend: SecretBackend,
    private readonly metaPath: string,
  ) {}

  static async open(askPassphrase: PassphraseProvider): Promise<SecretStore> {
    return new SecretStore(await resolveBackend(askPassphrase), metadataPath());
  }

  async #readMeta(): Promise<MetadataFile> {
    try {
      return JSON.parse(await readFile(this.metaPath, "utf8")) as MetadataFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY);
      throw err;
    }
  }

  async #writeMeta(meta: MetadataFile): Promise<void> {
    await mkdir(dirname(this.metaPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.metaPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(meta, null, 2), {
        mode: 0o600,
        encoding: "utf8",
      });
      await rename(tmp, this.metaPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Never touches the keychain or prompts. This is what makes `cfward list` instant. */
  async listProfiles(): Promise<ProfileMetadata[]> {
    const meta = await this.#readMeta();
    return Object.values(meta.profiles).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async getProfile(name: string): Promise<ProfileMetadata | null> {
    return (await this.#readMeta()).profiles[name] ?? null;
  }

  async addProfile(
    name: string,
    token: string,
    details: Omit<ProfileMetadata, "name" | "createdAt" | "backend">,
    { overwrite = false } = {},
  ): Promise<ProfileMetadata> {
    const meta = await this.#readMeta();
    if (meta.profiles[name] && !overwrite) {
      throw new SecretError(
        "PROFILE_EXISTS",
        `Profile "${name}" already exists.`,
      );
    }

    // Secret first: if the keychain write fails we do not want orphaned
    // metadata pointing at a token that does not exist.
    await this.backend.set(name, token);

    const record: ProfileMetadata = {
      ...details,
      name,
      backend: this.backend.id,
      createdAt: meta.profiles[name]?.createdAt ?? new Date().toISOString(),
    };
    meta.profiles[name] = record;
    await this.#writeMeta(meta);
    return record;
  }

  /**
   * The environment always wins, so a CI job can override the profile the repo
   * asks for without editing any file.
   */
  async getToken(name: string): Promise<string> {
    const fromEnv = await this.#env.get(name);
    if (fromEnv) return fromEnv;

    const token = await this.backend.get(name);
    if (!token) {
      throw new SecretError(
        "PROFILE_NOT_FOUND",
        `No token stored for "${name}".`,
        `Run: cfward login --profile ${name}`,
      );
    }
    return token;
  }

  async removeProfile(name: string): Promise<boolean> {
    const meta = await this.#readMeta();
    const existed = Boolean(meta.profiles[name]);

    // Delete the secret even with no metadata: covers a corrupted index that
    // left dangling entries in the keychain.
    await this.backend.delete(name);

    if (existed) {
      delete meta.profiles[name];
      await this.#writeMeta(meta);
    }
    return existed;
  }
}
