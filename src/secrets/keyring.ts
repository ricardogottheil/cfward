import type { SecretBackend } from "./types.js";

const SERVICE = "cfward";

type Entry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};
type KeyringModule = { Entry: new (service: string, user: string) => Entry };

let cached: KeyringModule | null | undefined;

/**
 * Lazy import. @napi-rs/keyring is a native module: if there is no prebuilt
 * binary for the platform, or we are inside a container with no Secret
 * Service, requiring it throws. That must not take down the whole CLI — we
 * want to fall through to the vault instead.
 */
async function load(): Promise<KeyringModule | null> {
  if (cached !== undefined) return cached;
  try {
    cached = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
  } catch {
    cached = null;
  }
  return cached;
}

export class KeyringBackend implements SecretBackend {
  readonly id = "keyring" as const;
  readonly writable = true;

  async isAvailable(): Promise<boolean> {
    const mod = await load();
    if (!mod) return false;

    // Loading the module is not enough: on headless Linux the binding exists
    // but the Secret Service never answers. A real round-trip is the only
    // reliable probe.
    try {
      const probe = new mod.Entry(SERVICE, "__cfward_probe__");
      probe.setPassword("probe");
      const ok = probe.getPassword() === "probe";
      probe.deletePassword();
      return ok;
    } catch {
      return false;
    }
  }

  async get(profile: string): Promise<string | null> {
    const mod = await load();
    if (!mod) return null;
    try {
      return new mod.Entry(SERVICE, profile).getPassword();
    } catch {
      return null;
    }
  }

  async set(profile: string, token: string): Promise<void> {
    const mod = await load();
    if (!mod) throw new Error("keyring unavailable");
    new mod.Entry(SERVICE, profile).setPassword(token);
  }

  async delete(profile: string): Promise<boolean> {
    const mod = await load();
    if (!mod) return false;
    try {
      return new mod.Entry(SERVICE, profile).deletePassword();
    } catch {
      return false;
    }
  }
}
