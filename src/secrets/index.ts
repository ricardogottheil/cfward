export { SecretStore, resolveBackend } from "./store.js";
export { KeyringBackend } from "./keyring.js";
export { VaultBackend } from "./vault.js";
export { EnvBackend, envVarFor } from "./env.js";
export { configDir, metadataPath, vaultPath } from "./paths.js";
export {
  SecretError,
  type BackendId,
  type PassphraseProvider,
  type PassphraseRequest,
  type ProfileMetadata,
  type SecretBackend,
  type SecretErrorCode,
} from "./types.js";
