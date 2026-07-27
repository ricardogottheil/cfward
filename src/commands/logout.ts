import { resolveProject } from "../project/index.js";
import { line, warn, type CfwardContext } from "./context.js";
import { CliError } from "./errors.js";
import { assertProfileName } from "./format.js";
import { confirmAction, isInteractive } from "./io.js";

export interface LogoutFlags {
  readonly force: boolean;
}

export default async function logout(
  this: CfwardContext,
  flags: LogoutFlags,
  name: string,
): Promise<void> {
  const profile = assertProfileName(name);
  const store = await this.openStore();

  // Metadata, so no prompt yet. Reading it first means the confirmation can
  // name the account being dropped rather than just the profile.
  const metadata = await store.getProfile(profile);

  if (!flags.force) {
    if (!isInteractive()) {
      throw new CliError(
        `Refusing to remove "${profile}" without confirmation.`,
        `Re-run with: cfward logout ${profile} --force`,
      );
    }

    const account = metadata?.accountName ?? metadata?.accountId;
    const confirmed = await confirmAction(
      `Remove "${profile}"${account === undefined ? "" : ` (${account})`} from this machine?`,
    );
    if (!confirmed) {
      warn(this, `Left "${profile}" in place.`);
      return;
    }
  }

  const existed = await store.removeProfile(profile);

  if (!existed) {
    throw new CliError(
      `No profile named "${profile}" was stored.`,
      "Run `cfward list` to see the ones that are.",
    );
  }

  line(this, `Removed "${profile}". Its token is gone from this machine.`);

  // The repository still names it, and the next `cfward run` here will fail
  // with a message about a missing token rather than about this removal.
  const project = await resolveProject(this.cwd).catch(() => null);
  if (project?.profile === profile) {
    warn(
      this,
      `${project.configPath} still selects "${profile}". Point it somewhere ` +
        `else with: cfward use <profile>`,
    );
  }
}
