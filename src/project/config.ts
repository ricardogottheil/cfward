import { ProjectError, type CfwardConfig } from "./types.js";

/**
 * Profile names become keychain entry names, metadata keys and (uppercased)
 * environment variable names. Restricting the charset here keeps a hostile
 * `.cfward.json` from smuggling path separators, control characters or
 * terminal escapes into any of those.
 */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Deliberately one below TOKEN_SHAPED's 37-character floor, and the two must
 * stay that way relative to each other. Because no accepted name can be long
 * enough to match TOKEN_SHAPED, a legitimate profile can never be reported as
 * a leaked credential — the worst accusation this validator can make. Raising
 * this to 37 or beyond would let an ordinary long name be rejected with
 * CONFIG_SECRET_IN_FILE, telling the user to rotate a token they never wrote.
 */
const MAX_PROFILE_LENGTH = 36;

/**
 * A Cloudflare API token is 40 characters of [A-Za-z0-9_-]; a legacy global
 * API key is 37 hex characters. No plausible profile name reaches that length,
 * so the shape is a reliable tell regardless of which key it hides under.
 */
const TOKEN_SHAPED = /^[A-Za-z0-9_-]{37,}$/;

const SECRET_WORDS = [
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "apikey",
  "authkey",
  "privatekey",
  "bearer",
  "auth",
];

/**
 * Why a committed file must never carry a credential, spelled out: users who
 * put a token here usually think deleting the line later undoes it.
 */
const LEAK_HINT =
  "`.cfward.json` is committed to the repository. Every value in it is " +
  "readable by anyone who can clone the repo, and it stays in the git " +
  "history even after you delete the line, so removing it is not enough. " +
  "Delete the key, rotate the token at " +
  "https://dash.cloudflare.com/profile/api-tokens, then store the new one " +
  "encrypted with: cfward login --profile <name>";

function looksLikeSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_WORDS.some((word) => normalized.includes(word));
}

/**
 * Walks the whole parsed document, not just the top level: a token buried
 * under `{"env": {"prod": {"apiToken": "..."}}}` is exactly as published as one
 * at the root. Iterative rather than recursive so a deeply nested file cannot
 * blow the stack before it is rejected.
 */
function assertNoSecrets(value: unknown, configPath: string): void {
  const stack: { node: unknown; key: string }[] = [{ node: value, key: "" }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const { node, key } = current;

    // The value is never echoed back: printing it is the leak we are reporting.
    if (typeof node === "string" && TOKEN_SHAPED.test(node)) {
      throw new ProjectError(
        "CONFIG_SECRET_IN_FILE",
        `${configPath}: the value of "${key || "(root)"}" has the shape of a Cloudflare API token.`,
        LEAK_HINT,
      );
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) =>
        stack.push({ node: item, key: `${key}[${index}]` }),
      );
      continue;
    }

    if (typeof node === "object" && node !== null) {
      for (const [childKey, childValue] of Object.entries(node)) {
        if (looksLikeSecretKey(childKey)) {
          throw new ProjectError(
            "CONFIG_SECRET_IN_FILE",
            `${configPath}: the key "${childKey}" names a credential.`,
            LEAK_HINT,
          );
        }
        stack.push({ node: childValue, key: childKey });
      }
    }
  }
}

/**
 * Hand-written rather than delegated to a schema library: the schema is one
 * field, and a CLI that handles credentials pays for every dependency twice —
 * once in install weight for its users, once in the trust it extends to code
 * that runs in the same process as a decrypted token.
 */
export function parseConfig(raw: string, configPath: string): CfwardConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProjectError(
      "CONFIG_INVALID_JSON",
      `${configPath} is not valid JSON: ${(err as Error).message}`,
      'Expected exactly: { "profile": "your-profile-name" }',
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectError(
      "CONFIG_NOT_OBJECT",
      `${configPath} must contain a JSON object.`,
      'Expected exactly: { "profile": "your-profile-name" }',
    );
  }

  // Runs before the shape checks so a leaked token is reported as a leak,
  // rather than as an incidental "unknown key".
  assertNoSecrets(parsed, configPath);

  const record = parsed as Record<string, unknown>;

  const unknown = Object.keys(record).filter((key) => key !== "profile");
  if (unknown.length > 0) {
    throw new ProjectError(
      "CONFIG_UNKNOWN_KEY",
      `${configPath}: unexpected ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((k) => `"${k}"`).join(", ")}.`,
      "This file holds the profile name and nothing else. Account details " +
        "live in the local profile store, which is not committed: see " +
        "`cfward list`.",
    );
  }

  const profile = record["profile"];

  if (profile === undefined) {
    throw new ProjectError(
      "CONFIG_MISSING_PROFILE",
      `${configPath} has no "profile" key.`,
      'Add it: { "profile": "your-profile-name" }',
    );
  }

  if (typeof profile !== "string") {
    throw new ProjectError(
      "CONFIG_INVALID_PROFILE",
      `${configPath}: "profile" must be a string, got ${Array.isArray(profile) ? "array" : typeof profile}.`,
      'Expected exactly: { "profile": "your-profile-name" }',
    );
  }

  if (profile.length > MAX_PROFILE_LENGTH) {
    throw new ProjectError(
      "CONFIG_INVALID_PROFILE",
      `${configPath}: "profile" is longer than ${MAX_PROFILE_LENGTH} characters.`,
      "Profile names are short labels like `production` or `acme-client`.",
    );
  }

  if (!PROFILE_PATTERN.test(profile)) {
    throw new ProjectError(
      "CONFIG_INVALID_PROFILE",
      `${configPath}: "profile" must start with a letter or digit and contain only letters, digits, dot, underscore or hyphen.`,
      "Profile names are short labels like `production` or `acme-client`. " +
        "Run `cfward list` to see the ones you have.",
    );
  }

  return { profile };
}
