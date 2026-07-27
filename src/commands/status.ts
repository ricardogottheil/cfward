import { verifyToken } from "../cloudflare/index.js";
import { CONFIG_FILENAME, resolveProject } from "../project/index.js";
import { line, warn, type CfwardContext } from "./context.js";
import { CliError } from "./errors.js";
import { assertProfileName, daysUntil, describeExpiry, maskToken } from "./format.js";

export interface StatusFlags {
  readonly profile?: string;
}

/**
 * Turns the verified expiry into the sentence the command exists to print. The
 * number matters more than the date: nobody reads `2026-09-06` and works out
 * that it is a fortnight away.
 */
function expiryLine(expiresOn: string | null): string {
  if (expiresOn === null) return "  expires  never";

  const days = daysUntil(expiresOn);
  if (days === null) return `  expires  ${expiresOn}`;
  if (days < 0) return `  expires  ${describeExpiry(expiresOn)} — ${-days} days ago`;
  if (days === 0) return `  expires  ${describeExpiry(expiresOn)} — today`;

  return `  expires  ${describeExpiry(expiresOn)} — ${days} day${days === 1 ? "" : "s"} left`;
}

export default async function status(
  this: CfwardContext,
  flags: StatusFlags,
): Promise<void> {
  const project = flags.profile === undefined ? await resolveProject(this.cwd) : null;

  // A name that came off a flag is held to the same rule as one that came out
  // of `.cfward.json`: it becomes a keychain entry name and an environment
  // variable name downstream, and neither should ever see a path separator.
  const profile =
    flags.profile === undefined ? project?.profile : assertProfileName(flags.profile);
  if (profile === undefined) {
    throw new CliError(
      `No ${CONFIG_FILENAME} was found in this directory or above it.`,
      "Select a profile for this project: cfward use <profile>",
    );
  }

  line(this, `profile    ${profile}`);
  line(this, `  from     ${project?.configPath ?? "--profile"}`);

  const store = await this.openStore();
  const metadata = await store.getProfile(profile);
  if (metadata === null) {
    warn(
      this,
      `"${profile}" is not in the local profile store. Its token has to come ` +
        "from the environment.",
    );
  } else {
    line(
      this,
      `  account  ${metadata.accountName ?? metadata.accountId ?? "(none stored)"}`,
    );
    line(this, `  stored   ${metadata.backend}`);
  }

  // Reads the token, so this is the point at which the vault may ask for a
  // passphrase. Everything above came from unencrypted metadata on purpose.
  const token = await store.getToken(profile);
  line(this, `  token    ${maskToken(token)}`);

  const verification = await verifyToken(token);
  line(this, `  status   ${verification.status}`);
  line(this, expiryLine(verification.expiresOn));

  if (!verification.valid) {
    throw new CliError(
      `The token for "${profile}" is ${verification.status} and will not authenticate.`,
      `Replace it: create a new token at ` +
        `https://dash.cloudflare.com/profile/api-tokens, then run ` +
        `cfward login --profile ${profile} --force`,
    );
  }
}
