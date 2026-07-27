import { isCancel, password, select, confirm, text } from "@clack/prompts";
import type { AccountSummary } from "../cloudflare/index.js";
import { checkProfileName } from "../project/index.js";
import type { PassphraseProvider } from "../secrets/index.js";
import { CliError } from "./errors.js";
import { assertProfileName } from "./format.js";

/**
 * Every prompt is drawn on stderr, never stdout.
 *
 * stdout is the command's result — a table, a resolved profile, the child's
 * own output under `cfward run`. Interleaving a prompt into it would corrupt
 * anything that reads cfward from a pipe, and the prompt itself is not a
 * result: it is a conversation with whoever is at the terminal.
 */
const PROMPT_IO = { input: process.stdin, output: process.stderr } as const;

/**
 * Short enough not to be a wall, long enough that the scrypt cost is not the
 * only thing standing between a stolen vault file and its contents.
 */
const MIN_PASSPHRASE_LENGTH = 12;

/**
 * Both ends have to be a terminal. stdin alone is not enough: with stderr
 * redirected the prompt is still waiting but nothing is drawn, so the command
 * looks hung to the one person able to answer it.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

function requireInteractive(message: string, hint: string): void {
  if (!isInteractive()) throw new CliError(message, hint);
}

/**
 * Ctrl+C at a prompt. Reported as a handled error so it exits 1 rather than
 * looking like the command did what was asked.
 */
function cancelled(): never {
  throw new CliError("Cancelled.");
}

const CI_HINT =
  "In CI there is no terminal and no keychain: export the token as " +
  "CFWARD_TOKEN_<PROFILE> (for example CFWARD_TOKEN_PRODUCTION) from the " +
  "runner's secret store. The environment is read before the vault and never " +
  "prompts.";

/**
 * The CLI layer's half of the contract in `src/secrets/`: the vault knows how
 * to derive a key and nothing about terminals, and this is the only place a
 * passphrase is ever typed. Nothing under `src/secrets/` imports it.
 */
export const promptPassphrase: PassphraseProvider = async ({
  confirm: needsConfirm,
  reason,
}) => {
  requireInteractive(
    `${reason}: no terminal is attached, so the passphrase cannot be asked for.`,
    CI_HINT,
  );

  const first = await password({
    ...PROMPT_IO,
    message: `${reason} — passphrase`,
    validate: (value) => {
      const entered = value ?? "";
      if (entered.length === 0) return "The passphrase cannot be empty.";
      if (needsConfirm && entered.length < MIN_PASSPHRASE_LENGTH) {
        return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
      }
      return undefined;
    },
  });
  if (isCancel(first)) cancelled();

  if (!needsConfirm) return first;

  const again = await password({ ...PROMPT_IO, message: "Repeat the passphrase" });
  if (isCancel(again)) cancelled();

  if (again !== first) {
    // Deliberately fatal rather than a retry loop: a mistyped passphrase on a
    // vault being created would encrypt the token under something the user
    // does not know, and they would only find out at the next `cfward run`.
    throw new CliError(
      "The two passphrases do not match.",
      "Nothing was written. Run the command again.",
    );
  }

  return first;
};

const TOKEN_HINT =
  "Create one at https://dash.cloudflare.com/profile/api-tokens. It is 40 " +
  "characters of letters, digits, underscore and hyphen.";

function assertTokenShape(value: string): string {
  if (value.length === 0) {
    throw new CliError("No token was provided.", TOKEN_HINT);
  }
  if (/\s/.test(value)) {
    // Almost always a pasted line that carried something else with it, or a
    // file with more than one line in it. Guessing which part is the token
    // would store the wrong thing and fail much later.
    throw new CliError(
      "The value provided contains whitespace, so it is not a Cloudflare API token.",
      TOKEN_HINT,
    );
  }
  return value;
}

/**
 * Reads the token from stdin, for `echo "$CF_TOKEN" | cfward login --stdin`
 * and for any non-interactive caller.
 *
 * Invariant 2 stands either way: the token arrives on a pipe, never as an
 * argument, so it never reaches `ps` or the shell history.
 */
export async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    throw new CliError(
      "Nothing arrived on stdin.",
      'Pipe the token in: echo "$CF_TOKEN" | cfward login --profile <name> --stdin',
    );
  }

  return assertTokenShape(raw);
}

/** A masked prompt, so the token is not left sitting in the scrollback either. */
export async function promptToken(): Promise<string> {
  requireInteractive(
    "No terminal is attached, so the token cannot be asked for.",
    'Pipe it in instead: echo "$CF_TOKEN" | cfward login --profile <name> --stdin. ' +
      CI_HINT,
  );

  const value = await password({
    ...PROMPT_IO,
    message: "Cloudflare API token",
    validate: (entered) => {
      const token = (entered ?? "").trim();
      if (token.length === 0) return "The token cannot be empty.";
      if (/\s/.test(token)) return "A token contains no whitespace.";
      return undefined;
    },
  });
  if (isCancel(value)) cancelled();

  return assertTokenShape(value.trim());
}

export async function promptProfileName(): Promise<string> {
  requireInteractive(
    "No profile name was given and there is no terminal to ask at.",
    "Name it on the command line: cfward login --profile <name>",
  );

  const value = await text({
    ...PROMPT_IO,
    message: "Profile name",
    placeholder: "production",
    validate: (entered) => {
      const name = (entered ?? "").trim();
      if (name.length === 0) return "A profile needs a name.";
      const problem = checkProfileName(name);
      if (problem === "too-long") return "That name is too long.";
      if (problem === "invalid-characters") {
        return "Use letters, digits, dot, underscore or hyphen, starting with a letter or digit.";
      }
      return undefined;
    },
  });
  if (isCancel(value)) cancelled();

  return assertProfileName(value.trim());
}

export async function pickAccount(
  accounts: readonly AccountSummary[],
): Promise<AccountSummary> {
  const chosen = await select({
    ...PROMPT_IO,
    message: "Which account should this profile use?",
    options: accounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.id,
    })),
  });
  if (isCancel(chosen)) cancelled();

  const account = accounts.find((entry) => entry.id === chosen);
  if (!account) cancelled();
  return account;
}

export async function confirmAction(message: string): Promise<boolean> {
  const answer = await confirm({ ...PROMPT_IO, message, initialValue: false });
  if (isCancel(answer)) cancelled();
  return answer;
}
