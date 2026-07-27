import { CloudflareError } from "../cloudflare/index.js";
import { ProjectError } from "../project/index.js";
import { SecretError } from "../secrets/index.js";

/**
 * Failures raised by the CLI layer itself: a flag that was not supplied, a
 * cancelled prompt, a terminal that is not there. It carries a hint for the
 * same reason SecretError, ProjectError and CloudflareError do — the user
 * should finish reading knowing which command to run next.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Fixed rather than read from the terminal: hints are also read back in CI logs. */
const HINT_WIDTH = 76;

/**
 * Read off the declared property rather than by duck-typing `"hint" in err`,
 * so a foreign object that happens to carry a `hint` cannot be formatted as if
 * it were one of ours.
 */
function hintOf(err: unknown): string | undefined {
  if (
    err instanceof SecretError ||
    err instanceof ProjectError ||
    err instanceof CloudflareError ||
    err instanceof CliError
  ) {
    return err.hint;
  }
  return undefined;
}

function indent(text: string): string {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= HINT_WIDTH) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);

  return lines.map((entry) => `  ${entry}`).join("\n");
}

/**
 * The one place a failure becomes text.
 *
 * Installed as Stricli's error formatter, so every way out of a command — a
 * thrown error, a returned one, a failure while the context is being built —
 * lands here and prints the hint. Half of what these error types are for is
 * the sentence naming the next command; an error that reaches the user without
 * it is a bug rather than a cosmetic problem.
 */
export function describeFailure(exc: unknown): string {
  const message = exc instanceof Error ? exc.message : String(exc);
  const hint = hintOf(exc);

  return hint === undefined
    ? `cfward: ${message}`
    : `cfward: ${message}\n\n${indent(hint)}`;
}
