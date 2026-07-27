import { resolveProject, runWithProfile } from "../project/index.js";
import type { CfwardContext } from "./context.js";
import { CliError } from "./errors.js";
import { assertProfileName } from "./format.js";

export interface RunFlags {
  readonly profile?: string;
}

/**
 * The flag wins over the file: `--profile` is how someone deploys this repo to
 * a different account once, without editing a committed file to do it.
 */
export async function resolveProfile(
  cwd: string,
  override: string | undefined,
): Promise<string> {
  if (override !== undefined) return assertProfileName(override);

  const project = await resolveProject(cwd);
  if (project !== null) return project.profile;

  throw new CliError(
    "No .cfward.json was found in this directory or above it, and no --profile was given.",
    "Select one for this project: cfward use <profile>. `cfward list` shows " +
      "the profiles stored on this machine.",
  );
}

export default async function run(
  this: CfwardContext,
  flags: RunFlags,
  ...command: string[]
): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new CliError(
      "No command was given.",
      "Put it after a double dash: cfward run -- wrangler deploy",
    );
  }

  const profile = await resolveProfile(this.cwd, flags.profile);
  const store = await this.openStore();

  const result = await runWithProfile(profile, executable, args, {
    store,
    cwd: this.cwd,
  });

  // The child's own status, unchanged. A wrapper that flattened every non-zero
  // exit to 1 would break `cfward run -- <anything>` inside a Makefile, a CI
  // step or a `&&` chain — every one of which branches on the real code.
  this.process.exitCode = result.exitCode;
}
