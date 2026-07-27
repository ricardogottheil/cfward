/**
 * The only non-zero code cfward produces on its own. `run` is the exception:
 * it reports the child's status instead, which is the whole point of wrapping
 * a command rather than replacing it.
 */
export const HANDLED_ERROR = 1;

/**
 * Stricli signals its own routing and parsing failures with negative codes —
 * `ExitCode.UnknownCommand` is -5, `ExitCode.InvalidArgument` is -4.
 *
 * A negative exit code does not survive the trip through a shell: only the low
 * byte reaches the caller, so -4 arrives as 252 and -5 as 251. Neither number
 * means anything to anyone, and to the user a mistyped command is an ordinary
 * handled error. Everything else passes through untouched, which is what lets
 * `cfward run` report the child's own status.
 */
export function normalizeExitCode(
  code: number | string | null | undefined,
): number | string | null | undefined {
  return typeof code === "number" && code < 0 ? HANDLED_ERROR : code;
}
