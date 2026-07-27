import { checkProfileName, MAX_PROFILE_LENGTH } from "../project/index.js";
import { CliError } from "./errors.js";

/**
 * Below this length, showing the ends of a value would reveal most of it. A
 * real Cloudflare API token is 40 characters and a legacy global key is 37, so
 * nothing legitimate lands here — but the store will hold whatever it was
 * given, and a masking function that leaks short inputs is worse than useless.
 */
const MIN_MASKABLE = 16;

const FULLY_MASKED = "…";

/**
 * `AbCd…9f2`. Invariant 3: a token is never printed. This is the only shape in
 * which any part of one may appear, and it exists so a user can tell two
 * stored tokens apart without either of them being readable.
 */
export function maskToken(token: string): string {
  if (token.length < MIN_MASKABLE) return FULLY_MASKED;
  return `${token.slice(0, 4)}…${token.slice(-3)}`;
}

const MS_PER_DAY = 86_400_000;

/** Negative once the token has expired, which is the caller's cue to say so. */
export function daysUntil(iso: string, now = Date.now()): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.ceil((at - now) / MS_PER_DAY);
}

/** `2026-09-06` from an ISO-8601 timestamp, or the raw string if it is not one. */
function isoDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * A Cloudflare token with no expiry is the common case, so "never" has to read
 * as a fact rather than as missing data — `-` would be ambiguous next to a
 * profile whose expiry we simply have not fetched.
 */
export function describeExpiry(expiresOn: string | null | undefined): string {
  if (expiresOn === null || expiresOn === undefined) return "never";

  const days = daysUntil(expiresOn);
  if (days === null) return expiresOn;

  const date = isoDate(expiresOn);
  if (days < 0) return `${date} (expired)`;
  if (days === 0) return `${date} (today)`;
  return `${date} (${days}d)`;
}

/**
 * Validates a name that arrived from a flag or a positional argument, using
 * the same rule `.cfward.json` is held to. Rejecting here rather than at write
 * time is what stops a profile from being created that no repository could
 * ever name.
 */
export function assertProfileName(name: string): string {
  const problem = checkProfileName(name);
  if (problem === null) return name;

  if (problem === "too-long") {
    throw new CliError(
      `Profile name is longer than ${MAX_PROFILE_LENGTH} characters.`,
      "Profile names are short labels like `production` or `acme-client`.",
    );
  }

  throw new CliError(
    "Profile name must start with a letter or digit and contain only letters, digits, dot, underscore or hyphen.",
    "Profile names are short labels like `production` or `acme-client`. " +
      "Run `cfward list` to see the ones you have.",
  );
}

/**
 * Deliberately looser than the 32 lowercase hex characters Cloudflare issues
 * today: the job here is to keep whitespace and shell metacharacters out of a
 * value that ends up in the child's environment, not to predict the format of
 * every id Cloudflare will ever mint.
 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9]{16,64}$/;

export function assertAccountId(value: string): string {
  if (ACCOUNT_ID_PATTERN.test(value)) return value;

  throw new CliError(
    "That does not look like a Cloudflare account id.",
    "It is a long hex string: `wrangler whoami` prints it, and it is also the " +
      "part of the dashboard URL after /accounts/.",
  );
}

/**
 * Pads to the widest cell per column. Deliberately plain text with no ANSI and
 * no box drawing: the output of `cfward list` is as likely to be piped into
 * grep as it is to be read.
 */
export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, row[column]?.length ?? 0), header.length),
  );

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();

  return [render(headers), ...rows.map(render)].join("\n");
}
