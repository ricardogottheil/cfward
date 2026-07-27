import { buildApplication, run, type ApplicationText, text_en } from "@stricli/core";
import { buildContext } from "./commands/context.js";
import { describeFailure } from "./commands/errors.js";
import { HANDLED_ERROR, normalizeExitCode } from "./commands/exit.js";
import { routes } from "./commands/index.js";
import { readPackageVersion } from "./commands/version.js";

/**
 * Stricli formats its own stderr output through this table, so overriding the
 * four error entries is what guarantees the hint is printed no matter which
 * way a command failed. `exceptionWhileParsingArguments` is deliberately left
 * alone: Stricli's own "did you mean" text for a mistyped flag is better than
 * anything this layer would produce.
 */
const text: ApplicationText = {
  ...text_en,
  exceptionWhileRunningCommand: describeFailure,
  exceptionWhileLoadingCommandContext: describeFailure,
  exceptionWhileLoadingCommandFunction: describeFailure,
  commandErrorResult: describeFailure,
};

const app = buildApplication(routes, {
  name: "cfward",
  // Registers `--version` (and `-v`) on the root command. `getCurrentVersion`
  // rather than a static `currentVersion` so the manifest is read only when
  // the flag is actually present, and no other command pays for it. No
  // `getLatestVersion`: that would make every run phone an update server, and
  // this CLI talks to api.cloudflare.com and to nothing else.
  //
  // Stricli marks this field deprecated in favour of its `version` integration,
  // but passing integrations explicitly replaces the defaults, which would mean
  // re-declaring `help`, `helpAll` and a full formatting configuration here
  // only to reproduce what the library already builds.
  versionInfo: {
    getCurrentVersion: async () => readPackageVersion(import.meta.url),
  },
  scanner: {
    // `--account-id` reads better than `--accountId`, and `cfward run --
    // wrangler deploy --env prod` needs everything past the dashes handed to
    // the child untouched rather than scanned for flags of ours.
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
  documentation: { caseStyle: "convert-camel-to-kebab" },
  localization: { text },
  determineExitCode: () => HANDLED_ERROR,
});

try {
  await run(app, process.argv.slice(2), buildContext());
} catch (err) {
  // Stricli handles everything a command can throw, so reaching here means the
  // failure was in the framework or in the context itself. Still a handled
  // error as far as the caller is concerned, and still printed with its hint.
  process.stderr.write(`${describeFailure(err)}\n`);
  process.exitCode = HANDLED_ERROR;
}

process.exitCode = normalizeExitCode(process.exitCode);
