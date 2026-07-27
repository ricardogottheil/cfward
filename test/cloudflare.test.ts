import { describe, expect, it } from "vitest";
import { listAccounts, verifyToken } from "../src/cloudflare/client.js";
import { CloudflareError } from "../src/cloudflare/types.js";
import { REDACTION_MARKER } from "../src/project/redact.js";

/** Shaped like a real token so a leak in a message is unmistakable. */
const TOKEN = "kT3xQ8vN2wR7yL4mB9pF6sD1gH5jZ0aC8eU3nV7t";

type Reply = (init: RequestInit) => Promise<Response>;

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Replies are consumed in order; the last one repeats, so a test that only
 * cares about a single request does not have to count them. Each is a factory
 * because a Response body can only be read once.
 */
function stubFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const queue = [...replies];

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (!reply) throw new Error("stub fetch ran out of replies");
    return reply(init);
  };

  return { calls, fetch };
}

function jsonReply(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Reply {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

function textReply(body: string, status = 200): Reply {
  return async () =>
    new Response(body, { status, headers: { "content-type": "text/html" } });
}

function ok(result: unknown, extra: Record<string, unknown> = {}) {
  return { success: true, errors: [], messages: [], result, ...extra };
}

function bad(errors: { code: number; message: string }[]) {
  return { success: false, errors, messages: [], result: null };
}

/** Every request the client makes has to satisfy all three. */
function expectSafeTransport(calls: Call[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).toContain("https://api.cloudflare.com/client/v4/");
    expect(call.url).not.toContain(TOKEN);
    const headers = call.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  }
}

/** The token must not survive anywhere a human or a CI log can read it. */
function expectNoLeak(err: CloudflareError): void {
  expect(err.message).not.toContain(TOKEN);
  expect(err.hint ?? "").not.toContain(TOKEN);
  expect(err.stack ?? "").not.toContain(TOKEN);
}

async function expectFailure(
  promise: Promise<unknown>,
): Promise<CloudflareError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CloudflareError);
    const failure = err as CloudflareError;
    expectNoLeak(failure);
    return failure;
  }
  throw new Error("expected the call to reject");
}

describe("verifyToken", () => {
  it("reports an active token as valid and carries its expiry", async () => {
    const stub = stubFetch([
      jsonReply(
        ok({
          id: "ed17574386854bf78a67040be0a770b0",
          status: "active",
          expires_on: "2026-12-31T23:59:59Z",
        }),
      ),
    ]);

    const result = await verifyToken(TOKEN, { fetch: stub.fetch });

    expect(result).toEqual({
      valid: true,
      status: "active",
      expiresOn: "2026-12-31T23:59:59Z",
    });
    expect(stub.calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
    );
    expectSafeTransport(stub.calls);
  });

  it("reports a non-expiring token with a null expiry", async () => {
    const stub = stubFetch([jsonReply(ok({ id: "abc", status: "active" }))]);

    const result = await verifyToken(TOKEN, { fetch: stub.fetch });

    expect(result).toEqual({ valid: true, status: "active", expiresOn: null });
  });

  it("reports an expired token as invalid without throwing", async () => {
    const stub = stubFetch([
      jsonReply(
        ok({
          id: "abc",
          status: "expired",
          expires_on: "2020-01-01T00:00:00Z",
        }),
      ),
    ]);

    const result = await verifyToken(TOKEN, { fetch: stub.fetch });

    expect(result).toEqual({
      valid: false,
      status: "expired",
      expiresOn: "2020-01-01T00:00:00Z",
    });
  });

  it("reports a disabled token as invalid", async () => {
    const stub = stubFetch([jsonReply(ok({ id: "abc", status: "disabled" }))]);

    const result = await verifyToken(TOKEN, { fetch: stub.fetch });

    expect(result).toEqual({ valid: false, status: "disabled", expiresOn: null });
  });

  it("reports a revoked token as invalid rather than throwing", async () => {
    // A deleted token gets no status at all: Cloudflare answers 401/1000.
    const stub = stubFetch([
      jsonReply(bad([{ code: 1000, message: "Invalid API Token" }]), 401),
    ]);

    const result = await verifyToken(TOKEN, { fetch: stub.fetch });

    expect(result).toEqual({ valid: false, status: "invalid", expiresOn: null });
  });

  it("reports an expired token as invalid when Cloudflare answers 401 instead of a status", async () => {
    const stub = stubFetch([
      jsonReply(bad([{ code: 1000, message: "Invalid API Token" }]), 401),
    ]);

    const result = await verifyToken(TOKEN, { fetch: stub.fetch });

    expect(result.valid).toBe(false);
  });

  it("throws on a rate limit rather than declaring the token bad", async () => {
    const stub = stubFetch([
      jsonReply(bad([{ code: 10000, message: "ratelimited" }]), 429, {
        "retry-after": "30",
      }),
    ]);

    const err = await expectFailure(verifyToken(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("RATE_LIMITED");
    expect(err.hint).toContain("30 seconds");
  });

  it("falls back to a generic wait when 429 carries no retry-after", async () => {
    const stub = stubFetch([jsonReply(bad([]), 429)]);

    const err = await expectFailure(verifyToken(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("RATE_LIMITED");
    expect(err.hint).toContain("Wait a minute");
  });

  it("rejects a body that is not JSON", async () => {
    // What a captive portal or a corporate proxy actually returns.
    const stub = stubFetch([textReply("<html>Sign in to the network</html>")]);

    const err = await expectFailure(verifyToken(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("MALFORMED_RESPONSE");
    expect(err.hint).toContain("proxy");
  });

  it("rejects JSON that is not the Cloudflare envelope", async () => {
    const stub = stubFetch([jsonReply({ status: "active" })]);

    const err = await expectFailure(verifyToken(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects a success envelope with no result object", async () => {
    const stub = stubFetch([jsonReply(ok(null))]);

    const err = await expectFailure(verifyToken(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects a token status it does not recognise", async () => {
    const stub = stubFetch([jsonReply(ok({ id: "abc", status: "quarantined" }))]);

    const err = await expectFailure(verifyToken(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("MALFORMED_RESPONSE");
  });

  it("times out instead of hanging", async () => {
    // Honours the signal the client passes, which is the thing under test:
    // a client that forgot AbortSignal.timeout would hang here forever.
    const hang: Reply = (init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject((init.signal as AbortSignal).reason);
        });
      });

    const stub = stubFetch([hang]);

    const err = await expectFailure(
      verifyToken(TOKEN, { fetch: stub.fetch, timeoutMs: 20 }),
    );

    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toContain("20 ms");
  });

  it("reports an unreachable host as a network failure", async () => {
    const down: Reply = async () => {
      throw new TypeError("fetch failed");
    };

    const err = await expectFailure(
      verifyToken(TOKEN, { fetch: stubFetch([down]).fetch }),
    );

    expect(err.code).toBe("NETWORK");
    expect(err.hint).toContain("online");
  });
});

describe("listAccounts", () => {
  it("returns id and name for a single page", async () => {
    const stub = stubFetch([
      jsonReply(
        ok([
          { id: "acc-1", name: "Personal", settings: { two_factor: true } },
          { id: "acc-2", name: "Acme Client" },
        ]),
      ),
    ]);

    const accounts = await listAccounts(TOKEN, { fetch: stub.fetch });

    expect(accounts).toEqual([
      { id: "acc-1", name: "Personal" },
      { id: "acc-2", name: "Acme Client" },
    ]);
    expect(stub.calls).toHaveLength(1);
    expectSafeTransport(stub.calls);
  });

  it("follows every page Cloudflare reports", async () => {
    const page = (id: string, number: number): Reply =>
      jsonReply(
        ok([{ id, name: id.toUpperCase() }], {
          result_info: { page: number, total_pages: 3 },
        }),
      );
    const stub = stubFetch([page("acc-1", 1), page("acc-2", 2), page("acc-3", 3)]);

    const accounts = await listAccounts(TOKEN, { fetch: stub.fetch });

    expect(accounts.map((account) => account.id)).toEqual([
      "acc-1",
      "acc-2",
      "acc-3",
    ]);
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[0]?.url).toContain("page=1");
    expect(stub.calls[2]?.url).toContain("page=3");
  });

  it("throws instead of returning a short list when the page cap is exhausted", async () => {
    // 15 pages past a 10-page cap: the old behaviour returned 10 pages' worth
    // and said nothing, so the account the user wanted was just missing.
    const stub = stubFetch([
      jsonReply(
        ok([{ id: "acc-1", name: "One" }], {
          result_info: { page: 1, total_pages: 15 },
        }),
      ),
    ]);

    const err = await expectFailure(listAccounts(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("TOO_MANY_ACCOUNTS");
    expect(err.hint).toContain("--account-id");
    expect(stub.calls).toHaveLength(10);
  });

  it("drops entries that are missing an id or a name", async () => {
    const stub = stubFetch([
      jsonReply(ok([{ id: "acc-1" }, null, { id: 7, name: "Numeric" }, { id: "acc-2", name: "Kept" }])),
    ]);

    const accounts = await listAccounts(TOKEN, { fetch: stub.fetch });

    expect(accounts).toEqual([{ id: "acc-2", name: "Kept" }]);
  });

  it("maps 9109 to an actionable permissions error", async () => {
    const stub = stubFetch([
      jsonReply(
        bad([{ code: 9109, message: "Unauthorized to access requested resource" }]),
        403,
      ),
    ]);

    const err = await expectFailure(listAccounts(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("INSUFFICIENT_PERMISSIONS");
    expect(err.hint).toContain("cfward login --profile");
  });

  it("maps 1000 to an actionable invalid-token error", async () => {
    const stub = stubFetch([
      jsonReply(bad([{ code: 1000, message: "Invalid API Token" }]), 401),
    ]);

    const err = await expectFailure(listAccounts(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("INVALID_TOKEN");
    expect(err.hint).toContain("dash.cloudflare.com/profile/api-tokens");
  });

  it("scrubs the token when Cloudflare echoes it back in an error message", async () => {
    const stub = stubFetch([
      jsonReply(
        bad([{ code: 7003, message: `Could not route to /accounts?token=${TOKEN}` }]),
        400,
      ),
    ]);

    const err = await expectFailure(listAccounts(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("API_ERROR");
    expect(err.message).toContain(REDACTION_MARKER);
    // expectFailure already asserted the token is absent from message, hint
    // and stack; this is the case that would actually leak without the scrub.
  });

  it("rejects a success envelope whose result is not an array", async () => {
    const stub = stubFetch([jsonReply(ok({ id: "acc-1" }))]);

    const err = await expectFailure(listAccounts(TOKEN, { fetch: stub.fetch }));

    expect(err.code).toBe("MALFORMED_RESPONSE");
  });
});
