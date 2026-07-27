import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { ExitCode } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudflareError } from "../src/cloudflare/index.js";
import type { CfwardContext } from "../src/commands/context.js";
import { CliError, describeFailure } from "../src/commands/errors.js";
import { normalizeExitCode } from "../src/commands/exit.js";
import login, {
  assertPassphraseReachable,
  type BackendHolder,
} from "../src/commands/login.js";
import use from "../src/commands/use.js";
import { readPackageVersion } from "../src/commands/version.js";
import { parseConfig, ProjectError } from "../src/project/index.js";
import {
  SecretError,
  type BackendId,
  type ProfileMetadata,
  type SecretStore,
} from "../src/secrets/index.js";

let root: string;

beforeEach(async () => {
  // realpath because macOS hands out /var/... temp paths that are symlinks to
  // /private/var/..., and the config resolver compares path strings.
  root = await realpath(await mkdtemp(join(tmpdir(), "cfward-cli-")));
  // A repository boundary, so the upward walk stops here instead of climbing
  // out of the temp tree and finding whatever lives above it.
  await mkdir(join(root, ".git"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeBackend(id: BackendId): BackendHolder {
  return {
    backend: {
      id,
      writable: id !== "env",
      isAvailable: async () => true,
      get: async () => null,
      set: async () => {},
      delete: async () => false,
    },
  };
}

/**
 * SecretStore has a private constructor and its `open()` probes the OS
 * keychain, so the double is cast rather than built. Every member a command
 * under test actually reaches is supplied; anything else would throw, which is
 * the behaviour a test wants from a member it did not expect to be called.
 */
function fakeContext(cwd: string, store: Partial<SecretStore> = {}) {
  const out: string[] = [];
  const err: string[] = [];

  const context: CfwardContext = {
    cwd,
    process: {
      stdout: { write: (text: string) => void out.push(text) },
      stderr: { write: (text: string) => void err.push(text) },
    },
    openStore: async () => store as SecretStore,
  };

  return { context, stdout: () => out.join(""), stderr: () => err.join("") };
}

/**
 * Replaces `process.stdin` for the duration of one call and reports whether
 * anything ever read from it. `_read` fires only on demand, so construction
 * alone cannot flip the flag.
 */
async function withStdin<T>(
  contents: string,
  body: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; consumed: boolean }> {
  let consumed = false;
  const stream = new Readable({
    read() {
      consumed = true;
      this.push(Buffer.from(contents, "utf8"));
      this.push(null);
    },
  });

  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  try {
    const [result] = await Promise.allSettled([body()]);
    return { result: result as PromiseSettledResult<T>, consumed };
  } finally {
    if (original) Object.defineProperty(process, "stdin", original);
  }
}

describe("use", () => {
  it("writes a config containing exactly the profile key", async () => {
    const { context } = fakeContext(root, { getProfile: async () => null });

    await use.call(context, {}, "production");

    const raw = await readFile(join(root, ".cfward.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Invariant 4. Asserting the key list rather than the object catches a
    // future edit that adds a field, which `toEqual` alone would too, but this
    // one names the reason in the failure message.
    expect(Object.keys(parsed)).toEqual(["profile"]);
    expect(parsed).toEqual({ profile: "production" });

    // The file has to be readable by the resolver that will consume it: a
    // write the parser rejects is a broken repository, not a formatting choice.
    expect(parseConfig(raw, "test")).toEqual({ profile: "production" });
  });

  it("writes no account id even when the store holds one", async () => {
    const metadata: ProfileMetadata = {
      name: "production",
      createdAt: "1970-01-01T00:00:00.000Z",
      backend: "keyring",
      accountId: "0123456789abcdef0123456789abcdef",
      accountName: "Acme Inc",
      expiresOn: "2099-01-01T00:00:00.000Z",
    };
    const { context } = fakeContext(root, { getProfile: async () => metadata });

    await use.call(context, {}, "production");

    const raw = await readFile(join(root, ".cfward.json"), "utf8");

    // The account id is the half of invariant 4 that a public repository
    // publishes, and it is sitting right there in the metadata this command
    // just read. Nothing but the name may cross into the committed file.
    expect(Object.keys(JSON.parse(raw) as object)).toEqual(["profile"]);
    expect(raw).not.toContain(metadata.accountId!);
    expect(raw).not.toContain("Acme");
  });
});

describe("normalizeExitCode", () => {
  it("maps every negative code Stricli defines to a handled error", () => {
    const negatives = Object.values(ExitCode).filter((code) => code < 0);

    // Guards the guard: if Stricli ever stops using negative codes this list
    // empties and the loop below would pass without asserting anything.
    expect(negatives.length).toBeGreaterThan(0);

    for (const code of negatives) expect(normalizeExitCode(code)).toBe(1);
  });

  it("turns an unknown command into 1 rather than 251", () => {
    // Only the low byte reaches the shell, so ExitCode.UnknownCommand (-5)
    // would arrive as 251 and InvalidArgument (-4) as 252.
    expect(ExitCode.UnknownCommand).toBeLessThan(0);
    expect(normalizeExitCode(ExitCode.UnknownCommand)).toBe(1);
    expect(normalizeExitCode(ExitCode.InvalidArgument)).toBe(1);
  });

  it("passes a child's own exit code through untouched", () => {
    // `cfward run` depends on this: flattening non-zero codes to 1 would break
    // every Makefile and CI step that branches on the real status.
    expect(normalizeExitCode(7)).toBe(7);
    expect(normalizeExitCode(137)).toBe(137);
    expect(normalizeExitCode(0)).toBe(0);
    expect(normalizeExitCode(undefined)).toBeUndefined();
  });
});

describe("describeFailure", () => {
  const HINT = "Run: cfward login --profile production";

  const domainErrors = [
    ["SecretError", new SecretError("PROFILE_NOT_FOUND", "No token stored.", HINT)],
    ["ProjectError", new ProjectError("CONFIG_MISSING_PROFILE", "No profile key.", HINT)],
    ["CloudflareError", new CloudflareError("INVALID_TOKEN", "Token rejected.", HINT)],
    ["CliError", new CliError("Cancelled.", HINT)],
  ] as const;

  it.each(domainErrors)("prints the hint carried by a %s", (_name, error) => {
    const text = describeFailure(error);

    expect(text).toContain(error.message);
    expect(text).toContain(HINT);
  });

  it("keeps every word of a hint long enough to wrap", () => {
    const hint =
      "`.cfward.json` is committed to the repository, so removing the line " +
      "later is not enough: rotate the token at " +
      "https://dash.cloudflare.com/profile/api-tokens and store the new one " +
      "with cfward login.";

    const text = describeFailure(new CliError("A token is in the config.", hint));

    expect(text.split("\n").length).toBeGreaterThan(3);
    // Wrapping is allowed to move the line breaks and add indentation, but not
    // to drop or reorder a single word.
    expect(text.replace(/\s+/g, " ")).toContain(hint);
  });

  it("prints a plain Error's message with no hint and no stack", () => {
    const text = describeFailure(new Error("something broke"));

    expect(text).toBe("cfward: something broke");
    expect(text.split("\n")).toHaveLength(1);
    expect(text).not.toContain("at ");
  });

  it("ignores a hint on an error type that is not one of ours", () => {
    // hintOf() branches on instanceof rather than on the shape, so a foreign
    // object carrying a `hint` is not formatted as though it were a domain
    // error whose hint we vouched for.
    class Impostor extends Error {
      readonly hint = "do not print me";
    }

    expect(describeFailure(new Impostor("nope"))).toBe("cfward: nope");
  });

  it("describes a thrown value that is not an Error at all", () => {
    expect(describeFailure("boom")).toBe("cfward: boom");
  });
});

describe("the stdin/vault conflict guard", () => {
  it("refuses a stdin token when the vault holds the passphrase", () => {
    expect(() => assertPassphraseReachable(fakeBackend("vault"), true)).toThrow(CliError);
  });

  it("allows a stdin token when the OS keychain holds the secret", () => {
    // No passphrase is needed, so stdin is free to carry the token.
    expect(() => assertPassphraseReachable(fakeBackend("keyring"), true)).not.toThrow();
  });

  it("allows a prompted token with the vault", () => {
    expect(() => assertPassphraseReachable(fakeBackend("vault"), false)).not.toThrow();
  });

  it("fires before stdin is consumed", async () => {
    const { context } = fakeContext(root, {
      ...fakeBackend("vault"),
      getProfile: async () => null,
    });

    const { result, consumed } = await withStdin("cf-token-that-must-not-be-read", () =>
      login.call(context, { profile: "production", stdin: true, force: false }),
    );

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(CliError);
    expect(String((result as PromiseRejectedResult).reason)).toMatch(/stdin cannot also carry/);

    // The point of the guard. Failing after the pipe was drained would leave
    // the user with no way to retry: the token is gone and the passphrase
    // prompt would be reading from a closed stream.
    expect(consumed).toBe(false);
  });

  it("does drain stdin when the guard does not fire", async () => {
    // Control for the test above. Without it, `consumed === false` could pass
    // for the wrong reason — a double that was never going to be read at all.
    // The value is deliberately malformed so the command fails at the shape
    // check rather than continuing on to the network.
    const { context } = fakeContext(root, {
      ...fakeBackend("keyring"),
      getProfile: async () => null,
    });

    const { result, consumed } = await withStdin("two words", () =>
      login.call(context, { profile: "production", stdin: true, force: false }),
    );

    expect(result.status).toBe("rejected");
    expect(String((result as PromiseRejectedResult).reason)).toMatch(/whitespace/);
    expect(consumed).toBe(true);
  });
});

describe("readPackageVersion", () => {
  it("reports the version this package was published with", async () => {
    // This file sits one directory below the package root, the same depth as
    // `src/cli.ts` and as the bundled `dist/cli.js`, so it exercises the exact
    // relative path the CLI uses. The expected value is read through the
    // working directory instead, so a resolver that finds the wrong manifest
    // cannot agree with itself.
    const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));

    expect(readPackageVersion(import.meta.url)).toBe(manifest.version);
  });

  it("explains an installation with no manifest instead of throwing a read error", () => {
    // Resolves to `<root>/package.json`, which is not there.
    const entry = pathToFileURL(join(root, "dist", "cli.js")).href;

    expect(() => readPackageVersion(entry)).toThrow(CliError);
    try {
      readPackageVersion(entry);
    } catch (exc) {
      expect((exc as CliError).hint).toMatch(/Reinstall/);
    }
  });

  it("rejects a manifest whose version is missing or not a string", async () => {
    const entry = pathToFileURL(join(root, "dist", "cli.js")).href;

    for (const contents of ['{"name":"cfward"}', '{"version":42}', '{"version":""}']) {
      await writeFile(join(root, "package.json"), contents);
      expect(() => readPackageVersion(entry)).toThrow(/declares no version/);
    }
  });
});
