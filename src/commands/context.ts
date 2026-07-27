import type { StricliProcess } from "@stricli/core";
import { SecretStore } from "../secrets/index.js";
import { promptPassphrase } from "./io.js";

/**
 * What every command is given. Stricli binds it as `this`.
 *
 * `cwd` and `process` are held rather than reached for so the whole layer has
 * exactly one place that touches process-wide state, and a command reads as a
 * function of its context.
 */
export interface CfwardContext {
  readonly process: StricliProcess;
  readonly cwd: string;
  /**
   * Opened on demand, and at most once per run.
   *
   * Not eager, because opening the store probes the OS keychain, and commands
   * that only read metadata — `cfward list`, `cfward use` — have no business
   * doing that before they know they need to. Memoised, because two calls
   * would mean two passphrase prompts for one command.
   */
  openStore(): Promise<SecretStore>;
}

/** For commands whose whole input is positional. Stricli reads `keyof` as never. */
export type NoFlags = Readonly<Record<never, never>>;

/**
 * A view of the real process, not the process itself.
 *
 * Node types `exitCode` as possibly `undefined` while Stricli types it as
 * possibly `null`, and under `exactOptionalPropertyTypes` those are different
 * types rather than a formality. The accessors translate between them, which
 * also keeps Stricli's `exitCode ??= code` from overwriting a `0` that `cfward
 * run` set on purpose after a child exited cleanly.
 */
function stricliProcess(): StricliProcess {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    get exitCode(): number | string | null {
      return process.exitCode ?? null;
    },
    set exitCode(value: number | string | null) {
      process.exitCode = value ?? undefined;
    },
  };
}

export function buildContext(): CfwardContext {
  let store: Promise<SecretStore> | undefined;

  return {
    process: stricliProcess(),
    cwd: process.cwd(),
    // The CLI layer owns the PassphraseProvider: this is the single point where
    // a TTY dependency is handed to `src/secrets/`, which has none of its own.
    openStore: () => (store ??= SecretStore.open(promptPassphrase)),
  };
}

/** Commands write their results here; prompts and diagnostics go to stderr. */
export function line(context: CfwardContext, text = ""): void {
  context.process.stdout.write(`${text}\n`);
}

/** Warnings are not results, so they never land on stdout. */
export function warn(context: CfwardContext, text: string): void {
  context.process.stderr.write(`cfward: ${text}\n`);
}
