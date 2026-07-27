import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILENAME, ProjectError, resolveProject } from "../project/index.js";
import { line, warn, type CfwardContext, type NoFlags } from "./context.js";
import { assertProfileName } from "./format.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the profile name should be written.
 *
 * A `.cfward.json` in the current directory always wins — that is the file
 * this directory's commands will resolve to. Otherwise an ancestor's config is
 * updated in place, because creating a second one below it would shadow the
 * first and leave two files disagreeing about the same project.
 *
 * A config that exists but does not parse is reported rather than silently
 * replaced: it may be a mangled edit worth looking at before it is overwritten.
 */
async function targetConfig(cwd: string): Promise<string> {
  const here = join(cwd, CONFIG_FILENAME);
  if (await exists(here)) return here;

  try {
    const project = await resolveProject(cwd);
    return project?.configPath ?? here;
  } catch (err) {
    if (err instanceof ProjectError) {
      throw new ProjectError(
        err.code,
        err.message,
        `${err.hint ?? ""} Fix that file, or run \`cfward use\` from the directory that holds it to replace it outright.`.trim(),
      );
    }
    throw err;
  }
}

export default async function use(
  this: CfwardContext,
  _flags: NoFlags,
  name: string,
): Promise<void> {
  const profile = assertProfileName(name);
  const path = await targetConfig(this.cwd);

  const store = await this.openStore();
  // Metadata only, so this neither unlocks the vault nor prompts. A profile
  // that is not stored locally is still worth committing: CI resolves the same
  // name from CFWARD_TOKEN_<PROFILE>.
  if ((await store.getProfile(profile)) === null) {
    warn(
      this,
      `No profile named "${profile}" is stored on this machine. ` +
        `Add it with: cfward login --profile ${profile}`,
    );
  }

  // Invariant 4: this file is committed, so it carries the profile name and
  // nothing else — no token, and no account id that a public repo would
  // publish. Mode 0644 for the same reason: it is not a secret.
  await writeFile(path, `${JSON.stringify({ profile }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });

  line(this, `${path} now selects profile "${profile}".`);
  line(this, "Commit it, and every clone of this repository deploys to the same account.");
}
