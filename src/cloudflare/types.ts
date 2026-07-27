export type CloudflareErrorCode =
  /** Cloudflare code 1000, or an HTTP 401 whose body was unusable. */
  | "INVALID_TOKEN"
  /** Cloudflare code 9109, or an HTTP 403 whose body was unusable. */
  | "INSUFFICIENT_PERMISSIONS"
  /** HTTP 429. */
  | "RATE_LIMITED"
  /** The request outlived its AbortSignal.timeout. */
  | "TIMEOUT"
  /** fetch rejected before an answer arrived: DNS, TLS, connection refused. */
  | "NETWORK"
  /** Not JSON, or JSON that is not the Cloudflare envelope. */
  | "MALFORMED_RESPONSE"
  /** The token reaches more accounts than the client will enumerate. */
  | "TOO_MANY_ACCOUNTS"
  /** Any other `success: false` envelope, carrying Cloudflare's own code. */
  | "API_ERROR";

/** Mirrors SecretError and ProjectError: a code to branch on and a hint that names the next command. */
export class CloudflareError extends Error {
  constructor(
    readonly code: CloudflareErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

/**
 * `active`, `disabled` and `expired` are Cloudflare's own vocabulary.
 * `invalid` is ours: a token that has been deleted, or was never real, gets a
 * 401 rather than a status, and collapsing that into the same field lets the
 * caller branch once instead of twice.
 */
export type TokenStatus = "active" | "expired" | "disabled" | "invalid";

export interface TokenVerification {
  /** True only for `active`. The one field `cfward login` has to gate on. */
  valid: boolean;
  status: TokenStatus;
  /** ISO-8601, or null when the token does not expire. Feeds ProfileMetadata.expiresOn. */
  expiresOn: string | null;
}

/**
 * Only the two fields an account picker needs. The /accounts payload carries
 * settings and legacy flags that would be dead weight, and every extra field
 * kept here is a field some later command is tempted to persist.
 */
export interface AccountSummary {
  id: string;
  name: string;
}
