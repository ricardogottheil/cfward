import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseConfig } from "./config.js";
import {
  CONFIG_FILENAME,
  ProjectError,
  type ResolvedProject,
} from "./types.js";

export interface ResolveOptions {
  /**
   * Overrides `$HOME` for the upward walk. Exposed so the boundary can be
   * exercised against a temporary tree instead of the real home directory.
   */
  home?: string;
}

/**
 * A git worktree or submodule has a `.git` *file* rather than a directory, so
 * the check is "does the entry exist", not "is it a directory".
 */
async function isRepositoryRoot(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(configPath: string): Promise<string | null> {
  try {
    return await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;

    // Present but unusable. Walking past it would silently deploy against
    // whatever profile the *parent* directory names, which is the one failure
    // mode this tool exists to prevent.
    throw new ProjectError(
      "CONFIG_UNREADABLE",
      `${configPath} exists but could not be read: ${(err as Error).message}`,
      code === "EISDIR"
        ? `${CONFIG_FILENAME} must be a file, not a directory.`
        : "Check the file permissions.",
    );
  }
}

/**
 * Walks up from `cwd` looking for `.cfward.json`, stopping at the git
 * repository root or `$HOME`, whichever comes first.
 *
 * Both boundaries are inclusive — the directory that triggers the stop is
 * still searched — so a config at the repository root is found, and a config
 * in `$HOME` works as a personal default for everything outside a repo.
 * Nothing above them is read: a `.cfward.json` sitting in `/` or in a parent
 * checkout has no business selecting a Cloudflare account for this project.
 *
 * Returns null when no config exists. Throws ProjectError when one exists but
 * is invalid; a malformed config is never treated as an absent one.
 */
export async function resolveProject(
  cwd: string,
  options: ResolveOptions = {},
): Promise<ResolvedProject | null> {
  const home = resolve(options.home ?? homedir());
  let dir = resolve(cwd);

  for (;;) {
    const configPath = join(dir, CONFIG_FILENAME);
    const raw = await readIfPresent(configPath);

    if (raw !== null) {
      const config = parseConfig(raw, configPath);
      return { profile: config.profile, configPath, root: dir };
    }

    if (dir === home || (await isRepositoryRoot(dir))) return null;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
