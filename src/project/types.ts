/** The only file cfward reads from a repository. Committed, so never secret. */
export const CONFIG_FILENAME = ".cfward.json";

/**
 * The complete schema. One key, by design: the file is committed, so anything
 * else it could hold is either useless to other clones or dangerous to publish.
 */
export interface CfwardConfig {
  profile: string;
}

export interface ResolvedProject {
  profile: string;
  /** Absolute path to the `.cfward.json` that was used. */
  configPath: string;
  /** Directory holding that file. The project root as far as cfward cares. */
  root: string;
}

export type ProjectErrorCode =
  | "CONFIG_INVALID_JSON"
  | "CONFIG_NOT_OBJECT"
  | "CONFIG_MISSING_PROFILE"
  | "CONFIG_INVALID_PROFILE"
  | "CONFIG_UNKNOWN_KEY"
  | "CONFIG_SECRET_IN_FILE"
  | "CONFIG_UNREADABLE"
  | "SPAWN_FAILED";

/** Mirrors SecretError: a code to branch on and a hint that names the next command. */
export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}
