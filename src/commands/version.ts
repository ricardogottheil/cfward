import { readFileSync } from "node:fs";
import { CliError } from "./errors.js";

/**
 * The version is read from the manifest at call time rather than inlined by
 * the bundler, so the number can never drift from the package that was
 * actually installed.
 *
 * `baseUrl` is the caller's `import.meta.url` because what matters is the
 * depth: `src/cli.ts` under vitest and the bundled `dist/cli.js` both sit one
 * directory below the package root, so the same relative path finds
 * package.json in either. Passing it in keeps this file free to move.
 */
export function readPackageVersion(baseUrl: string): string {
  const manifest = new URL("../package.json", baseUrl);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    throw new CliError(
      `Could not read the package manifest at ${manifest.pathname}`,
      "The installation looks incomplete. Reinstall cfward with `npm install -g cfward`.",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    parsed.version.length === 0
  ) {
    throw new CliError(
      `The package manifest at ${manifest.pathname} declares no version`,
      "The installation looks incomplete. Reinstall cfward with `npm install -g cfward`.",
    );
  }

  return parsed.version;
}
