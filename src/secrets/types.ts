export type BackendId = "keyring" | "vault" | "env";

/**
 * Metadata for a profile. Deliberately stored as plain JSON, NOT encrypted:
 * `cfward list` and `cfward status` must work without unlocking the keychain
 * or prompting for a passphrase. The token never lives here.
 */
export interface ProfileMetadata {
  name: string;
  accountId?: string;
  accountName?: string;
  /** ISO-8601. Sourced from /user/tokens/verify */
  expiresOn?: string | null;
  createdAt: string;
  lastVerifiedAt?: string;
  /** Which backend holds the token, so it can be migrated later. */
  backend: BackendId;
}

/**
 * A backend only ever knows about one secret at a time. It deliberately does
 * NOT expose list(): the macOS Keychain and the Windows Credential Manager
 * offer no portable way to enumerate entries. SecretStore owns the profile
 * index in the metadata file instead.
 */
export interface SecretBackend {
  readonly id: BackendId;
  readonly writable: boolean;
  isAvailable(): Promise<boolean>;
  get(profile: string): Promise<string | null>;
  set(profile: string, token: string): Promise<void>;
  delete(profile: string): Promise<boolean>;
}

export interface PassphraseRequest {
  /** True when creating the vault, where the passphrase must be typed twice. */
  confirm: boolean;
  reason: string;
}

/**
 * Injected by the CLI layer. The secrets module depends on nothing interactive
 * (no @clack/prompts), so it can be tested without a TTY.
 */
export type PassphraseProvider = (req: PassphraseRequest) => Promise<string>;

export type SecretErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "BACKEND_READONLY"
  | "BAD_PASSPHRASE"
  | "VAULT_CORRUPT"
  | "VAULT_VERSION"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_EXISTS";

export class SecretError extends Error {
  constructor(
    readonly code: SecretErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "SecretError";
  }
}
