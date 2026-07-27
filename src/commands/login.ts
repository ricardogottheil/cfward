import {
  CloudflareError,
  listAccounts,
  verifyToken,
  type AccountSummary,
} from "../cloudflare/index.js";
import type { ProfileMetadata, SecretStore } from "../secrets/index.js";
import { line, warn, type CfwardContext } from "./context.js";
import { CliError } from "./errors.js";
import {
  assertAccountId,
  assertProfileName,
  describeExpiry,
  maskToken,
} from "./format.js";
import {
  confirmAction,
  isInteractive,
  pickAccount,
  promptProfileName,
  promptToken,
  readTokenFromStdin,
} from "./io.js";

export interface LoginFlags {
  readonly profile?: string;
  readonly accountId?: string;
  readonly stdin: boolean;
  readonly force: boolean;
}

const NEW_TOKEN_HINT =
  "Create a replacement at https://dash.cloudflare.com/profile/api-tokens, " +
  "then run this command again.";

/**
 * Nothing is stored until Cloudflare has confirmed the token, so a typo is
 * reported while the user still has the original in their clipboard rather
 * than days later, from inside a wrangler stack trace.
 */
async function acceptedToken(token: string): Promise<{ expiresOn: string | null }> {
  const verification = await verifyToken(token);
  if (verification.valid) return { expiresOn: verification.expiresOn };

  const reason =
    verification.status === "expired"
      ? "The token has expired."
      : verification.status === "disabled"
        ? "The token is disabled."
        : "Cloudflare does not recognise that token.";

  throw new CliError(`${reason} Nothing was stored.`, NEW_TOKEN_HINT);
}

/**
 * A token scoped to Workers alone cannot read the account list, and that is a
 * perfectly ordinary token to want to store. So a permissions failure here
 * degrades to "no account id" with a warning, while everything else — a rate
 * limit, a timeout, more accounts than the client will enumerate — still
 * throws, because each of those has an answer the user can act on.
 */
async function discoverAccounts(
  context: CfwardContext,
  token: string,
): Promise<readonly AccountSummary[]> {
  try {
    return await listAccounts(token);
  } catch (err) {
    if (err instanceof CloudflareError && err.code === "INSUFFICIENT_PERMISSIONS") {
      warn(context, `${err.message} Storing the profile without an account id.`);
      if (err.hint) warn(context, err.hint);
      return [];
    }
    throw err;
  }
}

async function chooseAccount(
  context: CfwardContext,
  token: string,
): Promise<AccountSummary | null> {
  const accounts = await discoverAccounts(context, token);

  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0] ?? null;

  if (!isInteractive()) {
    throw new CliError(
      `This token reaches ${accounts.length} accounts and there is no terminal to choose at.`,
      "Name the one this profile should use: cfward login --profile <name> " +
        "--account-id <id>. `wrangler whoami` prints the ids, and so does the " +
        "dashboard URL after /accounts/.",
    );
  }

  return pickAccount(accounts);
}

/**
 * True when the token has to come off stdin rather than a prompt: either the
 * user said so, or stdin is not a terminal — in CI or under a pipe, prompting
 * would hang or fail with nobody there to see why.
 */
function tokenComesFromStdin(flags: LoginFlags): boolean {
  return flags.stdin || process.stdin.isTTY !== true;
}

/**
 * Narrower than SecretStore on purpose: the guard only asks which backend is
 * in play, and a test double should not have to impersonate the rest.
 */
export type BackendHolder = Pick<SecretStore, "backend">;

/**
 * Both the token and the vault passphrase would have to arrive on stdin, and
 * the token has already consumed it. Caught before anything is read, so the
 * command fails with an explanation instead of at the write, after a network
 * round trip, with a prompt nobody can answer.
 */
export function assertPassphraseReachable(
  store: BackendHolder,
  fromStdin: boolean,
): void {
  if (!fromStdin || store.backend.id !== "vault") return;

  throw new CliError(
    "The token is being read from stdin, so stdin cannot also carry the vault passphrase.",
    "Run `cfward login --profile <name>` interactively and paste the token at " +
      "the prompt. This machine has no OS keychain available, which is why the " +
      "encrypted vault is being used.",
  );
}

async function confirmReplacement(
  context: CfwardContext,
  existing: ProfileMetadata,
  flags: LoginFlags,
  fromStdin: boolean,
): Promise<boolean> {
  if (flags.force) return true;

  // With the token arriving on stdin there is no free stdin to answer on, so
  // replacing an existing profile has to be stated up front.
  if (fromStdin || !isInteractive()) {
    throw new CliError(
      `Profile "${existing.name}" already exists.`,
      `Replace its token with: cfward login --profile ${existing.name} --force`,
    );
  }

  return confirmAction(`Profile "${existing.name}" already exists. Replace its token?`);
}

export default async function login(
  this: CfwardContext,
  flags: LoginFlags,
): Promise<void> {
  const profile =
    flags.profile === undefined
      ? await promptProfileName()
      : assertProfileName(flags.profile);

  // Both flags are checked before anything is read, spawned or sent: a typo in
  // either should cost a message, not a consumed stdin and a round trip to
  // Cloudflare first.
  const named =
    flags.accountId === undefined ? undefined : assertAccountId(flags.accountId);

  const store = await this.openStore();
  const fromStdin = tokenComesFromStdin(flags);

  const existing = await store.getProfile(profile);
  if (existing !== null && !(await confirmReplacement(this, existing, flags, fromStdin))) {
    warn(this, `Left "${profile}" unchanged.`);
    return;
  }

  assertPassphraseReachable(store, fromStdin);

  const token = fromStdin ? await readTokenFromStdin() : await promptToken();
  const { expiresOn } = await acceptedToken(token);

  const account = named === undefined ? await chooseAccount(this, token) : null;
  const accountId = named ?? account?.id;

  const record = await store.addProfile(
    profile,
    token,
    {
      expiresOn,
      lastVerifiedAt: new Date().toISOString(),
      // Written key by key rather than as `accountId: undefined`, which
      // `exactOptionalPropertyTypes` rejects and which would also persist a
      // key whose only meaning is that it is missing.
      ...(accountId === undefined ? {} : { accountId }),
      ...(account === null ? {} : { accountName: account.name }),
    },
    { overwrite: existing !== null },
  );

  if (accountId === undefined) {
    warn(
      this,
      "No account id stored: CLOUDFLARE_ACCOUNT_ID will not be set for the " +
        "child process. Re-run with --account-id <id> if a command needs it.",
    );
  }

  // Invariant 3: this is the only form in which any part of the token is
  // allowed to reach a terminal.
  line(this, `Stored profile "${record.name}"`);
  line(this, `  token    ${maskToken(token)}`);
  line(
    this,
    `  account  ${record.accountName ?? "(unknown)"}${
      record.accountId === undefined ? "" : ` — ${record.accountId}`
    }`,
  );
  line(this, `  expires  ${describeExpiry(record.expiresOn)}`);
  line(this, `  stored   ${record.backend}`);
}
