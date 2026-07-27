import { REDACTION_MARKER } from "../project/redact.js";
import {
  CloudflareError,
  type AccountSummary,
  type CloudflareErrorCode,
  type TokenStatus,
  type TokenVerification,
} from "./types.js";

/**
 * A constant, not an option. An injectable base URL would be a hole in the
 * "no network call other than api.cloudflare.com" invariant, and the only
 * caller who would want one is a test — which gets `fetch` instead.
 */
const BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * Long enough for a slow link, short enough that a hung CLI is reported rather
 * than waited on. A cfward command with no output and no end is worse than a
 * failure: the user cannot tell it from a deadlock and kills it blind.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

const TOKENS_PAGE_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** Cloudflare's error codes, from the `errors[]` array rather than the HTTP status. */
const CF_INVALID_TOKEN = 1000;
const CF_INSUFFICIENT_PERMISSIONS = 9109;

/** Cloudflare's own maximum for this endpoint. */
const PER_PAGE = 50;

/**
 * The cap exists so a server that keeps reporting one more page cannot spin
 * the CLI forever. Reaching it is an error, never a short list: silently
 * returning 500 of 750 accounts would be the same undiagnosable truncation the
 * pagination was added to prevent, only harder to notice.
 */
const MAX_PAGES = 10;

/**
 * Narrower than `typeof fetch` on purpose: the client only ever calls it with a
 * string URL and an init object, and a narrow seam is easier to stub.
 */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface RequestOptions {
  /** Test seam. Defaults to the global fetch Node 22 ships. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface ApiIssue {
  code: number;
  message: string;
}

/** The Cloudflare envelope, after hand-validation. */
interface Envelope {
  success: boolean;
  errors: ApiIssue[];
  result: unknown;
  /** From `result_info.total_pages`, absent on endpoints that do not paginate. */
  totalPages: number | undefined;
}

/**
 * Cloudflare has no obligation to keep our token out of the strings it sends
 * back, and an error message travels further than anything else the CLI
 * prints: into a terminal, a CI log, a pasted bug report. Every foreign string
 * that reaches a CloudflareError passes through here first.
 */
function scrub(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join(REDACTION_MARKER);
}

/**
 * The single constructor for CloudflareError inside this module, so no future
 * edit can add an error path that skips the scrub. `stack` is derived from
 * `message`, so scrubbing the message covers it too.
 */
function failure(
  token: string,
  code: CloudflareErrorCode,
  message: string,
  hint: string,
): CloudflareError {
  return new CloudflareError(code, scrub(message, token), scrub(hint, token));
}

function invalidTokenHint(): string {
  return (
    "Cloudflare rejected the token. Create a new one at " +
    `${TOKENS_PAGE_URL} and store it with: cfward login --profile <name>`
  );
}

function permissionsHint(): string {
  return (
    "The token authenticates but is not allowed to read this. Edit it at " +
    `${TOKENS_PAGE_URL} and add the missing permission (account discovery ` +
    "needs Account > Account Settings > Read), then re-run: " +
    "cfward login --profile <name>"
  );
}

function toIssues(value: unknown): ApiIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const code = record["code"];
    const message = record["message"];
    return [
      {
        code: typeof code === "number" ? code : 0,
        message: typeof message === "string" ? message : "",
      },
    ];
  });
}

function describe(errors: ApiIssue[]): string {
  if (errors.length === 0) return "no details";
  return errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
}

function parseEnvelope(body: unknown): Envelope | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  // `success` is the discriminator the whole client branches on; a body without
  // it is not a Cloudflare response, whatever else it happens to contain.
  if (typeof record["success"] !== "boolean") return null;

  const info = record["result_info"];
  let totalPages: number | undefined;
  if (typeof info === "object" && info !== null) {
    const pages = (info as Record<string, unknown>)["total_pages"];
    if (typeof pages === "number") totalPages = pages;
  }

  return {
    success: record["success"],
    errors: toIssues(record["errors"]),
    result: record["result"],
    totalPages,
  };
}

function retryAfterHint(response: Response): string {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return `Cloudflare is rate limiting this token. Wait ${seconds} seconds, then run the command again.`;
  }
  return "Cloudflare is rate limiting this token. Wait a minute, then run the command again.";
}

/**
 * Cloudflare answers with the same envelope on 2xx and 4xx, so the codes in
 * `errors[]` decide first and the HTTP status is only a fallback. 429 is the
 * exception: it is the definitive signal, and `retry-after` lives in a header
 * the body cannot contradict.
 */
function envelopeError(
  token: string,
  response: Response,
  envelope: Envelope,
): CloudflareError {
  const detail = describe(envelope.errors);
  const codes = envelope.errors.map((issue) => issue.code);

  if (response.status === 429) {
    return failure(
      token,
      "RATE_LIMITED",
      `Cloudflare returned 429 Too Many Requests (${detail}).`,
      retryAfterHint(response),
    );
  }

  if (codes.includes(CF_INVALID_TOKEN)) {
    return failure(
      token,
      "INVALID_TOKEN",
      `Cloudflare rejected the token (${detail}).`,
      invalidTokenHint(),
    );
  }

  if (codes.includes(CF_INSUFFICIENT_PERMISSIONS)) {
    return failure(
      token,
      "INSUFFICIENT_PERMISSIONS",
      `The token lacks the permissions this request needs (${detail}).`,
      permissionsHint(),
    );
  }

  if (response.status === 401) {
    return failure(
      token,
      "INVALID_TOKEN",
      `Cloudflare answered 401 Unauthorized (${detail}).`,
      invalidTokenHint(),
    );
  }

  if (response.status === 403) {
    return failure(
      token,
      "INSUFFICIENT_PERMISSIONS",
      `Cloudflare answered 403 Forbidden (${detail}).`,
      permissionsHint(),
    );
  }

  return failure(
    token,
    "API_ERROR",
    `Cloudflare rejected the request with HTTP ${response.status} (${detail}).`,
    "This is an error from the Cloudflare API rather than from cfward. The " +
      "code above is documented at " +
      "https://developers.cloudflare.com/api/ — retry, and if it persists " +
      "check https://www.cloudflarestatus.com/",
  );
}

/**
 * The body could not be read as a Cloudflare envelope. The status still carries
 * meaning in that case — an edge-generated 429 or 401 page is HTML — so it is
 * consulted before falling back to "this is not the API talking".
 */
function unusableBodyError(
  token: string,
  response: Response,
  reason: string,
): CloudflareError {
  if (response.status === 429) {
    return failure(
      token,
      "RATE_LIMITED",
      "Cloudflare returned 429 Too Many Requests.",
      retryAfterHint(response),
    );
  }

  if (response.status === 401) {
    return failure(
      token,
      "INVALID_TOKEN",
      "Cloudflare answered 401 Unauthorized.",
      invalidTokenHint(),
    );
  }

  if (response.status === 403) {
    return failure(
      token,
      "INSUFFICIENT_PERMISSIONS",
      "Cloudflare answered 403 Forbidden.",
      permissionsHint(),
    );
  }

  return failure(
    token,
    "MALFORMED_RESPONSE",
    `api.cloudflare.com answered HTTP ${response.status}, but ${reason}.`,
    "A proxy, VPN or captive portal intercepting HTTPS is the usual cause. " +
      "Check the connection, then run the command again.",
  );
}

/** The body is never included in the message: it is attacker-controlled text of unknown length. */
function transportError(
  token: string,
  err: unknown,
  timeoutMs: number,
): CloudflareError {
  if (err instanceof Error && err.name === "TimeoutError") {
    return failure(
      token,
      "TIMEOUT",
      `api.cloudflare.com did not answer within ${timeoutMs} ms.`,
      "Check the connection or the proxy, then run the command again.",
    );
  }

  const detail = err instanceof Error ? err.message : String(err);
  return failure(
    token,
    "NETWORK",
    `Could not reach api.cloudflare.com: ${detail}`,
    "Check that the machine is online and that api.cloudflare.com is not " +
      "blocked, then run the command again.",
  );
}

/**
 * The one path to the API. Token handling, the timeout and the envelope
 * branching live here and nowhere else, so a new endpoint cannot get any of
 * the three wrong.
 */
async function request(
  path: string,
  token: string,
  options: RequestOptions,
): Promise<Envelope> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await doFetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        // The only place the token appears. Never a query parameter: URLs end
        // up in proxy logs, in error messages and in `ps` output.
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      // Covers the body as well as the headers: undici aborts a stalled read
      // through the same signal.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw transportError(token, err, timeoutMs);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw transportError(token, err, timeoutMs);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unusableBodyError(token, response, "the body is not JSON");
  }

  const envelope = parseEnvelope(parsed);
  if (envelope === null) {
    throw unusableBodyError(
      token,
      response,
      "the body is not a Cloudflare API response",
    );
  }

  if (!envelope.success) throw envelopeError(token, response, envelope);

  return envelope;
}

function readStatus(value: unknown): TokenStatus | null {
  if (value === "active" || value === "expired" || value === "disabled") {
    return value;
  }
  return null;
}

/**
 * Verifies a token against `/user/tokens/verify`.
 *
 * `cfward login` calls this before anything is stored, so that a bad token is
 * rejected while the user still has it in the clipboard rather than days later
 * inside a wrangler stack trace.
 *
 * Returns every verdict about the token, including "rejected", and throws only
 * when no verdict could be obtained — a timeout, a rate limit, a body that is
 * not the API. The distinction is what the caller needs: a returned
 * `valid: false` means do not store this token, a thrown error means we do not
 * know yet and storing it would be a guess.
 */
export async function verifyToken(
  token: string,
  options: RequestOptions = {},
): Promise<TokenVerification> {
  let envelope: Envelope;
  try {
    envelope = await request("/user/tokens/verify", token, options);
  } catch (err) {
    // For this one endpoint a rejected token is the answer, not a failure:
    // reporting it as `valid: false` is the entire point of the return shape.
    if (err instanceof CloudflareError && err.code === "INVALID_TOKEN") {
      return { valid: false, status: "invalid", expiresOn: null };
    }
    throw err;
  }

  const result = envelope.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw failure(
      token,
      "MALFORMED_RESPONSE",
      "The token verification succeeded but carried no result object.",
      "Run the command again. If it keeps happening, check " +
        "https://www.cloudflarestatus.com/",
    );
  }

  const record = result as Record<string, unknown>;
  const status = readStatus(record["status"]);
  if (status === null) {
    // Treating an unrecognised status as valid would store a token nobody
    // verified; the loud failure is the safe direction.
    throw failure(
      token,
      "MALFORMED_RESPONSE",
      "Cloudflare reported a token status this version of cfward does not know.",
      "Update cfward: the API has gained a status that predates this build.",
    );
  }

  const expiresOn = record["expires_on"];

  return {
    valid: status === "active",
    status,
    expiresOn: typeof expiresOn === "string" ? expiresOn : null,
  };
}

/**
 * Lists the accounts a token can reach, so `cfward login` can offer a picker
 * instead of asking the user to paste an account id from the dashboard.
 *
 * Paginates. Cloudflare defaults to 20 accounts per page, and a truncated
 * picker is a bug the user cannot diagnose: they scroll the list and their
 * account is simply not in it. Past MAX_PAGES it throws rather than returning
 * what it has, for the same reason.
 */
export async function listAccounts(
  token: string,
  options: RequestOptions = {},
): Promise<AccountSummary[]> {
  const accounts: AccountSummary[] = [];
  let totalPages: number | undefined;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const envelope = await request(
      `/accounts?per_page=${PER_PAGE}&page=${page}`,
      token,
      options,
    );

    if (!Array.isArray(envelope.result)) {
      throw failure(
        token,
        "MALFORMED_RESPONSE",
        "The account list succeeded but carried no array of accounts.",
        "Run the command again. If it keeps happening, check " +
          "https://www.cloudflarestatus.com/",
      );
    }

    for (const entry of envelope.result) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = record["id"];
      const name = record["name"];
      // An entry missing either field is dropped rather than shown as a blank
      // row: a picker entry with no name is one the user cannot choose.
      if (typeof id === "string" && typeof name === "string") {
        accounts.push({ id, name });
      }
    }

    totalPages = envelope.totalPages;
    if (totalPages === undefined || page >= totalPages) break;
  }

  // Reached only when Cloudflare reported more pages than the loop would walk.
  // The caller gets an error instead of a plausible-looking short list, because
  // a picker missing the one account the user wanted looks identical to a
  // picker showing everything.
  if (totalPages !== undefined && totalPages > MAX_PAGES) {
    throw failure(
      token,
      "TOO_MANY_ACCOUNTS",
      `This token reaches ${totalPages} pages of accounts, more than the ` +
        `${MAX_PAGES * PER_PAGE} cfward will enumerate.`,
      "Skip the picker and name the account outright: " +
        "cfward login --profile <name> --account-id <id>. The id is the " +
        "hex string in the dashboard URL after /accounts/, and `wrangler " +
        "whoami` prints it too.",
    );
  }

  return accounts;
}
