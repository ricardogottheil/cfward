import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedactor, REDACTION_MARKER } from "../src/project/redact.js";
import { childEnv, runWithProfile, type TokenSource } from "../src/project/run.js";
import { ProjectError } from "../src/project/types.js";
import type { ProfileMetadata } from "../src/secrets/index.js";

const NODE = process.execPath;
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "run-harness.ts");

/** Long enough and odd enough that an accidental substring match is not plausible. */
const TOKEN = "cf_integration_9x7Qw3rTyUiOpAsDfGhJkLzXcVbN";

/**
 * A synchronous sink. Every write lands in the array before write() returns, so
 * assertions never race the stream machinery.
 */
function collect() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function fakeStore(token: string, accountId?: string): TokenSource {
  return {
    getToken: async () => token,
    getProfile: async (): Promise<ProfileMetadata | null> =>
      accountId
        ? {
            name: "test",
            createdAt: "1970-01-01T00:00:00.000Z",
            backend: "vault",
            accountId,
          }
        : null,
  };
}

/** Runs `node -e <script>` under the profile, capturing both streams. */
async function runNode(
  script: string,
  store: TokenSource = fakeStore(TOKEN),
) {
  const out = collect();
  const err = collect();
  const result = await runWithProfile("test", NODE, ["-e", script], {
    store,
    // No process-wide handlers: the signal path has its own test below.
    signals: [],
    stdout: out.stream,
    stderr: err.stream,
  });
  return { result, stdout: out.text(), stderr: err.text() };
}

/**
 * Grandchildren that outlive their parent by design. Reaped after each test —
 * the scenarios need them to survive the assertions, not the whole session.
 * Registering one is also insurance for the tests that kill it themselves: a
 * failure part-way through would otherwise leak it.
 */
const strays: number[] = [];
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "cfward-run-"));
});

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Exited between the check and the kill. Nothing to do.
    }
  }
  await rm(scratch, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil<T>(
  probe: () => T | null,
  // A thunk, so the diagnostics are gathered when the wait fails rather than
  // when it starts — an eagerly built message reports the state before
  // anything had a chance to happen, which is never the state you need.
  label: () => string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label()}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

describe("runWithProfile (integration)", () => {
  it("propagates a zero exit code", async () => {
    const { result } = await runNode("process.exit(0)");

    expect(result).toEqual({ exitCode: 0, signal: null });
  });

  it("propagates a non-zero exit code", async () => {
    const { result } = await runNode("process.exit(42)");

    expect(result).toEqual({ exitCode: 42, signal: null });
  });

  it("propagates the exit code of a child that fails on its own", async () => {
    const { result, stderr } = await runNode("throw new Error('boom')");

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("boom");
  });

  it("delivers the token and account id to the child environment", async () => {
    // The child prints the token REVERSED. That proves the exact value arrived
    // without the assertion depending on output the redactor would rewrite —
    // and it documents the redactor's honest limit: it matches the literal
    // token, not transformations of it.
    const { result, stdout } = await runNode(
      "const t = process.env.CLOUDFLARE_API_TOKEN;" +
        "console.log('reversed=' + [...t].reverse().join('') + ' acct=' + process.env.CLOUDFLARE_ACCOUNT_ID)",
      fakeStore(TOKEN, "acct-42"),
    );

    expect(result.exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      `reversed=${[...TOKEN].reverse().join("")} acct=acct-42`,
    );
  });

  it("leaves CLOUDFLARE_ACCOUNT_ID unset when the profile has no account", async () => {
    const { stdout } = await runNode(
      "console.log('acct=' + ('CLOUDFLARE_ACCOUNT_ID' in process.env))",
    );

    expect(stdout.trim()).toBe("acct=false");
  });

  it("scrubs the token when the child prints it to stderr", async () => {
    const { result, stdout, stderr } = await runNode(
      "process.stderr.write('Authentication error [code 10000] using ' + process.env.CLOUDFLARE_API_TOKEN + '\\n')",
    );

    expect(result.exitCode).toBe(0);
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).toBe(
      `Authentication error [code 10000] using ${REDACTION_MARKER}\n`,
    );
    expect(stdout).toBe("");
  });

  it("scrubs the token when the child prints it to stdout", async () => {
    const { stdout } = await runNode(
      "console.log('token=' + process.env.CLOUDFLARE_API_TOKEN)",
    );

    expect(stdout).not.toContain(TOKEN);
    expect(stdout.trim()).toBe(`token=${REDACTION_MARKER}`);
  });

  it("scrubs a token dribbled out one byte at a time", async () => {
    // A real leak arrives in whatever chunks the pipe decides on. This forces
    // the worst case: every byte in its own write.
    const { stderr } = await runNode(
      "for (const c of process.env.CLOUDFLARE_API_TOKEN) process.stderr.write(c);" +
        "process.stderr.write('\\n')",
    );

    expect(stderr).not.toContain(TOKEN);
    expect(stderr).toBe(`${REDACTION_MARKER}\n`);
  });

  it("never puts the token on the child's command line", async () => {
    const { stdout } = await runNode(
      "console.log(JSON.stringify(process.argv) + JSON.stringify(process.execArgv))",
    );

    expect(stdout).not.toContain(TOKEN);
    expect(stdout).not.toContain(REDACTION_MARKER);
  });

  it("reports a missing command as SPAWN_FAILED with a hint", async () => {
    const failure = runWithProfile(
      "test",
      "cfward-definitely-not-a-real-binary",
      [],
      { store: fakeStore(TOKEN), signals: [] },
    );

    await expect(failure).rejects.toBeInstanceOf(ProjectError);
    await expect(failure).rejects.toMatchObject({ code: "SPAWN_FAILED" });
  });

  it(
    "terminates the child when the parent receives SIGTERM",
    async () => {
      const parent = spawn(
        NODE,
        [
          "--import",
          "tsx",
          HARNESS,
          NODE,
          "-e",
          "process.stdout.write('pid:' + process.pid + '\\n');" +
            "setInterval(() => {}, 1000)",
        ],
        {
          env: { ...process.env, HARNESS_TOKEN: TOKEN },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      parent.stdout.setEncoding("utf8");
      parent.stderr.setEncoding("utf8");
      parent.stdout.on("data", (chunk: string) => (stdout += chunk));
      parent.stderr.on("data", (chunk: string) => (stderr += chunk));

      const exited = new Promise<{ code: number | null }>((settle) =>
        parent.once("close", (code) => settle({ code })),
      );

      try {
        // The child announces itself and then lives forever. Nothing follows
        // that line, so it only arrives if the redactor releases output it can
        // no longer match instead of sitting on it.
        const grandchild = await waitUntil(
          () => {
            const match = /pid:(\d+)/.exec(stdout);
            return match?.[1] ? Number(match[1]) : null;
          },
          () =>
            `the child to report its pid (stdout: ${JSON.stringify(stdout)}, stderr: ${JSON.stringify(stderr)})`,
        );
        strays.push(grandchild);

        expect(isAlive(grandchild)).toBe(true);

        // Only the parent is signalled. spawn() puts the child in the same
        // process group, but a PID-targeted kill does not reach the group, so
        // the child can only die by way of the parent forwarding.
        process.kill(parent.pid as number, "SIGTERM");

        const status = await exited;

        await waitUntil(
          () => (isAlive(grandchild) ? null : true),
          () => `the child (pid ${grandchild}) to be terminated`,
          5_000,
        );

        // The child died by SIGTERM, so the parent reports 128 + signal number
        // rather than an exit code of its own. This also pins the escalation
        // off-by-one: escalating on the *first* signal would report SIGKILL's
        // 137 here and deny every child its chance to shut down cleanly.
        expect(status.code).toBe(128 + constants.signals.SIGTERM);
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill("SIGKILL");
        }
      }
    },
    30_000,
  );

  it(
    "escalates to SIGKILL when a second signal arrives and the child ignores the first",
    async () => {
      const parent = spawn(
        NODE,
        [
          "--import",
          "tsx",
          HARNESS,
          NODE,
          "-e",
          // Traps both signals and refuses to die: the wedged-cleanup case.
          "process.on('SIGTERM', () => process.stdout.write('ignored\\n'));" +
            "process.on('SIGINT', () => {});" +
            "process.stdout.write('pid:' + process.pid + '\\n');" +
            "setInterval(() => {}, 1000)",
        ],
        {
          env: { ...process.env, HARNESS_TOKEN: TOKEN },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      parent.stdout.setEncoding("utf8");
      parent.stderr.setEncoding("utf8");
      parent.stdout.on("data", (chunk: string) => (stdout += chunk));
      parent.stderr.on("data", (chunk: string) => (stderr += chunk));

      const exited = new Promise<{ code: number | null }>((settle) =>
        parent.once("close", (code) => settle({ code })),
      );

      try {
        const grandchild = await waitUntil(
          () => {
            const match = /pid:(\d+)/.exec(stdout);
            return match?.[1] ? Number(match[1]) : null;
          },
          () => `the child to report its pid (stdout: ${JSON.stringify(stdout)})`,
        );
        strays.push(grandchild);

        process.kill(parent.pid as number, "SIGTERM");

        // Waiting for proof the first signal was received and shrugged off,
        // rather than sleeping and hoping, keeps the escalation deterministic.
        await waitUntil(
          () => (stdout.includes("ignored") ? true : null),
          () => `the child to ignore the first signal (stdout: ${JSON.stringify(stdout)})`,
        );
        expect(isAlive(grandchild)).toBe(true);

        process.kill(parent.pid as number, "SIGTERM");

        const status = await exited;

        await waitUntil(
          () => (isAlive(grandchild) ? null : true),
          () => `the child (pid ${grandchild}) to be killed`,
          5_000,
        );

        expect(status.code).toBe(128 + constants.signals.SIGKILL);
        expect(stderr).toContain("SIGKILL");
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill("SIGKILL");
        }
      }
    },
    30_000,
  );

  it(
    "stops waiting when the child has exited but a grandchild holds the pipes",
    async () => {
      const pidFile = join(scratch, "grandchild.pid");
      const parent = spawn(
        NODE,
        [
          "--import",
          "tsx",
          HARNESS,
          NODE,
          "-e",
          // The grandchild inherits the child's stdio — our pipes — and
          // outlives it. The child's exitCode is set within ~100ms, but
          // `close` will not fire for 30 seconds. Its pid goes to a file
          // because the pipes it is holding are exactly what we cannot read.
          "const g = require('child_process').spawn('sleep',['30'],{stdio:'inherit'});" +
            "require('node:fs').writeFileSync(process.env.PID_FILE, String(g.pid));" +
            "process.exit(0)",
        ],
        {
          env: { ...process.env, HARNESS_TOKEN: TOKEN, PID_FILE: pidFile },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const exited = new Promise<number | null>((settle) =>
        parent.once("close", (code) => settle(code)),
      );

      try {
        const grandchild = await waitUntil(
          () => {
            try {
              const raw = readFileSync(pidFile, "utf8").trim();
              const pid = Number(raw);
              return Number.isInteger(pid) && pid > 0 ? pid : null;
            } catch {
              return null;
            }
          },
          () => "the child to record the grandchild pid",
          10_000,
        );
        strays.push(grandchild);

        // The pid file proves the grandchild exists; this settles past the
        // child's own exit, which follows the write immediately. Signalling
        // while the child is still alive would take the ordinary forwarding
        // path and prove nothing.
        await new Promise((done) => setTimeout(done, 1_000));

        // The grandchild is what is holding the pipes. Stating it here means a
        // future failure says which half of the scenario broke.
        expect(isAlive(grandchild)).toBe(true);

        process.kill(parent.pid as number, "SIGTERM");

        // An explicit deadline: a regression here means hanging, and hanging
        // on vitest's default timeout buries the cause in a generic message.
        const outcome = await Promise.race([
          exited.then((code) => ({ code })),
          new Promise<"hung">((settle) =>
            setTimeout(() => settle("hung"), 8_000).unref(),
          ),
        ]);

        expect(outcome).not.toBe("hung");
        // The child itself succeeded. It merely left something running, which
        // is not a failure of the command the user asked for.
        expect(outcome).toEqual({ code: 0 });
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill("SIGKILL");
        }
      }
    },
    20_000,
  );
});

describe("childEnv", () => {
  it("injects the token and account id", () => {
    const env = childEnv({ PATH: "/usr/bin" }, TOKEN, "acct-1");

    expect(env["CLOUDFLARE_API_TOKEN"]).toBe(TOKEN);
    expect(env["CLOUDFLARE_ACCOUNT_ID"]).toBe("acct-1");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("does not mutate the parent environment", () => {
    const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    childEnv(parent, TOKEN, "acct-1");

    expect(parent["CLOUDFLARE_API_TOKEN"]).toBeUndefined();
  });

  it("clears an inherited account id when the profile has none", () => {
    const env = childEnv({ CLOUDFLARE_ACCOUNT_ID: "stale" }, TOKEN);

    expect(env["CLOUDFLARE_ACCOUNT_ID"]).toBeUndefined();
  });

  it("strips global-key credentials that would outrank the token", () => {
    const env = childEnv(
      { CLOUDFLARE_API_KEY: "k", CLOUDFLARE_EMAIL: "a@b.c", CF_API_TOKEN: "t" },
      TOKEN,
    );

    expect(env["CLOUDFLARE_API_KEY"]).toBeUndefined();
    expect(env["CLOUDFLARE_EMAIL"]).toBeUndefined();
    expect(env["CF_API_TOKEN"]).toBeUndefined();
  });

  it("does not hand cfward's own token variables to the child", () => {
    const env = childEnv({ CFWARD_TOKEN_STAGING: "other-token" }, TOKEN);

    expect(env["CFWARD_TOKEN_STAGING"]).toBeUndefined();
  });
});

describe("createRedactor", () => {
  async function through(secret: string, chunks: string[]): Promise<string> {
    const redactor = createRedactor(secret);
    const out: Buffer[] = [];
    redactor.on("data", (chunk: Buffer) => out.push(chunk));
    for (const chunk of chunks) redactor.write(Buffer.from(chunk, "utf8"));
    redactor.end();
    await new Promise((done) => redactor.once("end", done));
    return Buffer.concat(out).toString("utf8");
  }

  /** Writes chunks but never ends the stream, so flush() cannot rescue anything. */
  function withoutEnding(secret: string, chunks: string[]): string {
    const redactor = createRedactor(secret);
    const out: Buffer[] = [];
    redactor.on("data", (chunk: Buffer) => out.push(chunk));
    for (const chunk of chunks) redactor.write(Buffer.from(chunk, "utf8"));
    return Buffer.concat(out).toString("utf8");
  }

  it("passes clean output through untouched", async () => {
    expect(await through(TOKEN, ["Total Upload: 1.2 KiB\n"])).toBe(
      "Total Upload: 1.2 KiB\n",
    );
  });

  it("releases output shorter than the token without waiting for more", () => {
    // The regression: a prompt is shorter than the token and nothing follows
    // it, so holding a flat token-length tail would strand it forever.
    expect(withoutEnding(TOKEN, ["? Deploy to production? (y/N) "])).toBe(
      "? Deploy to production? (y/N) ",
    );
  });

  it("holds back only a tail that could still begin the token", () => {
    const head = TOKEN.slice(0, 6);

    // "done. " cannot start the token, so it goes out; the trailing partial
    // token stays behind until the rest of it arrives.
    expect(withoutEnding(TOKEN, [`done. ${head}`])).toBe("done. ");
  });

  it("still redacts a token completed by a much later write", () => {
    const redactor = createRedactor(TOKEN);
    const out: Buffer[] = [];
    redactor.on("data", (chunk: Buffer) => out.push(chunk));

    redactor.write(Buffer.from(`error: ${TOKEN.slice(0, 6)}`, "utf8"));
    expect(Buffer.concat(out).toString("utf8")).toBe("error: ");

    redactor.write(Buffer.from(`${TOKEN.slice(6)} rejected\n`, "utf8"));
    const text = Buffer.concat(out).toString("utf8");

    expect(text).not.toContain(TOKEN);
    expect(text).toBe(`error: ${REDACTION_MARKER} rejected\n`);
  });

  it("removes the token from a single chunk", async () => {
    const output = await through(TOKEN, [`Auth error using ${TOKEN} here\n`]);

    expect(output).not.toContain(TOKEN);
    expect(output).toBe(`Auth error using ${REDACTION_MARKER} here\n`);
  });

  it("catches a token split across chunk boundaries", async () => {
    const output = await through(TOKEN, [
      `prefix ${TOKEN.slice(0, 10)}`,
      TOKEN.slice(10, 25),
      `${TOKEN.slice(25)} suffix`,
    ]);

    expect(output).not.toContain(TOKEN);
    expect(output).toBe(`prefix ${REDACTION_MARKER} suffix`);
  });

  it("catches a token split one byte at a time", async () => {
    const output = await through(TOKEN, `x${TOKEN}y`.split(""));

    expect(output).not.toContain(TOKEN);
    expect(output).toBe(`x${REDACTION_MARKER}y`);
  });

  it("removes every occurrence", async () => {
    const output = await through(TOKEN, [`${TOKEN} and ${TOKEN}`]);

    expect(output).not.toContain(TOKEN);
    expect(output).toBe(`${REDACTION_MARKER} and ${REDACTION_MARKER}`);
  });

  it("does not corrupt multi-byte characters split across chunks", async () => {
    const text = Buffer.from("café ✅\n", "utf8");
    const redactor = createRedactor(TOKEN);
    const out: Buffer[] = [];
    redactor.on("data", (chunk: Buffer) => out.push(chunk));
    for (let i = 0; i < text.length; i++) redactor.write(text.subarray(i, i + 1));
    redactor.end();
    await new Promise((done) => redactor.once("end", done));

    expect(Buffer.concat(out).toString("utf8")).toBe("café ✅\n");
  });
});
