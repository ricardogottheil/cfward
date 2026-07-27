import { SecretError } from "../secrets/index.js";
import { line, type CfwardContext } from "./context.js";
import { describeExpiry, maskToken, table } from "./format.js";

export interface ListFlags {
  readonly tokens: boolean;
}

/**
 * Reading a token means unlocking the store, which for the vault means a
 * passphrase prompt. That is why this is opt-in: listing profiles is the one
 * command that has to stay instant and silent, and the metadata it prints was
 * deliberately stored unencrypted so it could be.
 */
async function maskedTokens(
  context: CfwardContext,
  names: readonly string[],
): Promise<Map<string, string>> {
  const store = await context.openStore();
  const masked = new Map<string, string>();

  for (const name of names) {
    try {
      masked.set(name, maskToken(await store.getToken(name)));
    } catch (err) {
      // One unreadable profile should not hide the other nine. A profile whose
      // metadata survived but whose secret did not is exactly what this column
      // is worth showing.
      if (err instanceof SecretError && err.code === "PROFILE_NOT_FOUND") {
        masked.set(name, "(missing)");
        continue;
      }
      throw err;
    }
  }

  return masked;
}

export default async function list(
  this: CfwardContext,
  flags: ListFlags,
): Promise<void> {
  const store = await this.openStore();
  const profiles = await store.listProfiles();

  if (profiles.length === 0) {
    line(this, "No profiles stored.");
    line(this, "Add one with: cfward login --profile <name>");
    return;
  }

  const masked = flags.tokens
    ? await maskedTokens(
        this,
        profiles.map((profile) => profile.name),
      )
    : null;

  const headers = ["PROFILE", "ACCOUNT", "EXPIRES", "STORED"];
  const rows = profiles.map((profile) => {
    const row = [
      profile.name,
      profile.accountName ?? profile.accountId ?? "-",
      describeExpiry(profile.expiresOn),
      profile.backend,
    ];
    return masked === null ? row : [...row, masked.get(profile.name) ?? "-"];
  });

  line(this, table(masked === null ? headers : [...headers, "TOKEN"], rows));
}
