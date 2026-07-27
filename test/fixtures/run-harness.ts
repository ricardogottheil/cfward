/**
 * Runs runWithProfile in a process of its own.
 *
 * The SIGTERM test needs to signal *the process that called runWithProfile*.
 * In-process that would be the vitest worker, and a missed handler would take
 * the whole run down instead of failing one test — so the parent gets to be a
 * real, separate process.
 *
 * Not named `*.test.ts`, so vitest does not collect it.
 */
import { runWithProfile } from "../../src/project/run.js";
import type { ProfileMetadata } from "../../src/secrets/index.js";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: run-harness <command> [...args]");

const accountId = process.env["HARNESS_ACCOUNT_ID"];

const result = await runWithProfile("harness", command, args, {
  store: {
    getToken: async () => process.env["HARNESS_TOKEN"] ?? "harness-token",
    getProfile: async (): Promise<ProfileMetadata | null> =>
      accountId
        ? {
            name: "harness",
            createdAt: "1970-01-01T00:00:00.000Z",
            backend: "vault",
            accountId,
          }
        : null,
  },
});

process.exit(result.exitCode);
