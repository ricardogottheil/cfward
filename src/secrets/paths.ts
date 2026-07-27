import { homedir } from "node:os";
import { join } from "node:path";

const APP = "cfward";

/**
 * XDG resolution done by hand rather than pulling in `env-paths`. For a tool
 * that handles credentials, every transitive dependency is attack surface: a
 * malicious postinstall anywhere in the tree reads whatever the CLI reads.
 */
export function configDir(): string {
  const override = process.env.CFWARD_CONFIG_DIR;
  if (override) return override;

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, APP);
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP);
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  return join(
    xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config"),
    APP,
  );
}

export const metadataPath = () => join(configDir(), "profiles.json");
export const vaultPath = () => join(configDir(), "vault.json");
