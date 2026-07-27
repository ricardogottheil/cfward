import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SecretStore } from "../secrets/index.js";
import { createRedactor } from "./redact.js";
import { ProjectError } from "./types.js";

/**
 * Credentials the child must not inherit.
 *
 * The global-key pair outranks the API token in wrangler's own resolution, so
 * an inherited `CLOUDFLARE_API_KEY` left over from an unrelated login would
 * quietly deploy to a different account than the profile names — the exact
 * mistake this command exists to prevent. The `CF_*` spellings are the legacy
 * aliases, still honoured by several Cloudflare tools.
 */
const CONFLICTING_VARS = [
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
  "CF_ACCOUNT_ID",
];

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
];

/**
 * The only two things this module asks of the secret store. Narrower than
 * SecretStore on purpose: it documents the whole surface being depended on, and
 * a test double does not have to impersonate a class it never exercises.
 */
export type TokenSource = Pick<SecretStore, "getToken" | "getProfile">;

export interface RunOptions {
  /**
   * Opened by the CLI layer, which owns passphrase prompting. Taking the store
   * rather than building one keeps this module free of any TTY dependency, the
   * same way `src/secrets/` takes a PassphraseProvider.
   */
  store: TokenSource;
  cwd?: string;
  /** Overridable so tests can run without touching process-wide handlers. */
  signals?: readonly NodeJS.Signals[];
  /**
   * Where the child's filtered output goes. Defaults to the parent's own
   * streams; injectable so the filtering itself can be asserted without
   * monkey-patching process.stdout.
   */
  stdout?: Writable;
  stderr?: Writable;
}

export interface RunResult {
  /** Death by signal is reported as 128 + signal number, per shell convention. */
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/**
 * Builds the child's environment. The token is placed here and nowhere else:
 * not on the command line, where `ps` and shell history would capture it, and
 * not in the parent's own `process.env`, where it would outlive the command and
 * leak into every later child.
 */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  token: string,
  accountId?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };

  for (const name of CONFLICTING_VARS) delete env[name];

  // cfward's own per-profile variables are how *cfward* reads a token in CI.
  // Nothing downstream needs them, and every one of them is a second copy of a
  // credential in a process that did not ask for it.
  for (const name of Object.keys(env)) {
    if (name.startsWith("CFWARD_TOKEN_")) delete env[name];
  }

  env["CLOUDFLARE_API_TOKEN"] = token;

  // Cleared rather than left alone when the profile has no account: a stale
  // inherited value is worse than none, because wrangler would act on it.
  if (accountId) env["CLOUDFLARE_ACCOUNT_ID"] = accountId;
  else delete env["CLOUDFLARE_ACCOUNT_ID"];

  return env;
}

/**
 * Streams the child's output through the redactor and into `sink`.
 *
 * `sink` is the parent's own stdout or stderr, which outlives this call, so it
 * is written to by hand rather than handed to pipeline() as a destination:
 * pipeline attaches error and close listeners it cannot remove from a stream it
 * does not end, and they accumulate on process.stdout across calls.
 */
async function pump(
  source: Readable,
  sink: Writable,
  secret: string,
  wasKilled: () => boolean,
): Promise<void> {
  try {
    await pipeline(source, createRedactor(secret), async (scrubbed) => {
      for await (const chunk of scrubbed) {
        // once() rejects if the sink errors while we wait, and detaches both
        // listeners either way.
        if (!sink.write(chunk)) await once(sink, "drain");
      }
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // The child closing a pipe early is normal (`cfward run -- ... | head`).
    if (code === "EPIPE") return;
    // We tore the pipes down ourselves after escalating to SIGKILL. Output
    // stopping there is the intent, not a failure to report.
    if (code === "ERR_STREAM_PREMATURE_CLOSE" && wasKilled()) return;
    throw err;
  }
}

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return 1;
}

/**
 * Runs `command` with the profile's credentials injected into the child
 * environment only, forwarding termination signals and reporting the child's
 * exit status.
 *
 * The first termination signal is forwarded as sent, so the child gets to shut
 * down cleanly. A second escalates to SIGKILL: a user pressing Ctrl+C twice is
 * telling us the polite request did not work, and there has to be a way out.
 * A SIGKILLed child reports 137 (128 + 9).
 *
 * A signal arriving after the child has already exited means something the
 * child spawned inherited the pipes and is still holding them, so `close` will
 * not arrive on its own. That signal stops the wait immediately and reports the
 * child's real exit status, which may well be 0 — the command did succeed; it
 * just left something running behind it.
 *
 * stdout and stderr are piped rather than inherited so the token can be
 * scrubbed from anything the child prints (AGENTS.md invariant 7). The cost is
 * that the child sees a non-TTY stdout and will drop colours and progress
 * bars; stdin stays inherited, so prompts and piped input still work.
 */
export async function runWithProfile(
  profile: string,
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const token = await options.store.getToken(profile);
  const metadata = await options.store.getProfile(profile);

  const child = spawn(command, [...args], {
    cwd: options.cwd ?? process.cwd(),
    env: childEnv(process.env, token, metadata?.accountId),
    stdio: ["inherit", "pipe", "pipe"],
    // Never `true`: with a shell, anything in `args` becomes shell syntax.
    shell: false,
    windowsHide: true,
  });

  const notices = options.stderr ?? process.stderr;
  const signals = options.signals ?? DEFAULT_SIGNALS;

  // Counted across every forwarded signal, not per signal: someone who hits
  // Ctrl+C and then reaches for `kill` wants out, and it is not their job to
  // send the same one twice.
  let interruptions = 0;
  let killed = false;

  /**
   * Stops waiting on the child's output. Only reached once the user has asked
   * to be let go, so losing whatever was still in flight is the point.
   */
  const abandonOutput = () => {
    killed = true;
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  const handlers = signals.map((signal) => {
    const handler = () => {
      const alive = child.exitCode === null && child.signalCode === null;

      // The child is already gone, yet we are still here — so something it
      // spawned inherited the pipes and is holding them open, and `close` is
      // never coming. There is nothing left to signal; the only way out is to
      // stop reading. This case must be checked before the counter, because
      // treating it as "nothing to do" is what left Ctrl+C inert.
      if (!alive) {
        abandonOutput();
        return;
      }

      // The parent does not die here — it stays alive to report the child's
      // real exit status once the child has finished cleaning up.
      interruptions += 1;
      if (interruptions === 1) {
        child.kill(signal);
        return;
      }

      // Second signal: the child is either ignoring this one or is wedged in
      // cleanup. Re-sending it would leave the user pressing Ctrl+C at a
      // process that has already decided not to listen. SIGKILL cannot be
      // caught, so this always ends.
      killed = true;
      notices.write(
        `\ncfward: "${command}" did not exit; sending SIGKILL.\n`,
      );
      child.kill("SIGKILL");

      // Registered while the child is demonstrably still alive, so `exit` is
      // genuinely still to come. Registering it after the fact — as an earlier
      // version did — attaches a listener to an event that has already fired.
      child.once("exit", abandonOutput);
    };
    process.on(signal, handler);
    return { signal, handler };
  });

  try {
    const exited = new Promise<RunResult>((settle, fail) => {
      child.once("error", (err: NodeJS.ErrnoException) => {
        fail(
          new ProjectError(
            "SPAWN_FAILED",
            `Could not run "${command}": ${err.message}`,
            err.code === "ENOENT"
              ? `"${command}" was not found on PATH. Install it, or run it through your package manager (for example: cfward run -- pnpm exec ${command}).`
              : undefined,
          ),
        );
      });
      child.once("close", (code, signal) =>
        settle({ exitCode: exitCodeFor(code, signal), signal: signal ?? null }),
      );
    });

    const [result] = await Promise.all([
      exited,
      pump(child.stdout, options.stdout ?? process.stdout, token, () => killed),
      pump(child.stderr, notices, token, () => killed),
    ]);

    return result;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}
