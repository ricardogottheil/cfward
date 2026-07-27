# Security Policy

cfward stores Cloudflare API tokens and injects them into other processes. A
bug here can expose a live credential, so security reports are welcome and
taken seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

- Go to the [Security tab](https://github.com/ricardogottheil/cfward/security/advisories/new)
  and open a draft advisory.

That channel is private until an advisory is published, so a working exploit
can be discussed without putting anyone's tokens at risk in the meantime.

Please include the cfward version (`cfward --version`), your OS, which storage
backend was in use (OS keychain or encrypted vault), and the steps to
reproduce. A redacted transcript is more useful than a description — but
redact your own token before sending it.

## What to expect

This is a small project maintained by one person, so these are honest
estimates rather than guarantees:

| Stage                   | Target  |
| ----------------------- | ------- |
| Acknowledgement         | 3 days  |
| Initial assessment      | 7 days  |
| Fix released, or a plan | 30 days |

You will be credited in the advisory unless you ask not to be. If a report is
out of scope, you will get an explanation of why rather than silence.

## Supported versions

While cfward is pre-1.0, only the latest published version receives security
fixes. Upgrade before reporting.

## In scope

Anything that puts a token somewhere it should not be, or lets someone read one
they should not have:

- Recovering a token from `vault.json` without the passphrase, or weakening the
  work factor needed to try.
- A token reaching disk unencrypted — `profiles.json`, a log, a temp file, a
  cache, or `.cfward.json`.
- A token surviving into terminal output, a CI log, an error message, or a
  stack trace. The redactor exists to prevent exactly this.
- Defeating the AAD binding that ties each vault entry to its profile name, for
  example by swapping two sealed entries so a command deploys against the wrong
  account.
- `.cfward.json` accepting a value that a repository should never carry, or a
  profile name escaping validation into a path, an environment variable name,
  or a terminal escape sequence.
- A child process inheriting a credential it should not see, including cfward's
  own `CFWARD_TOKEN_*` variables or a stale `CLOUDFLARE_API_KEY`.

## Out of scope

These are known properties of the design, not oversights. Reporting them will
get a link back to this section.

**An attacker already running code as your user.** The OS keychain and the
encrypted vault protect secrets _at rest_. Neither is a defence against a
process with your privileges — that process can prompt you, read your keychain,
or wait for you to unlock the vault. cfward raises the cost of a stolen laptop
or a leaked backup, not of a compromised session.

**Secrets in process memory.** JavaScript cannot reliably erase a string from
memory. The derived vault key is held as a `Uint8Array` and zeroed on lock, but
the token itself passes through strings. Fixing this properly means moving
secret handling into native code; the trade-off is deliberate and documented in
`src/secrets/vault.ts`.

**The token in the child process environment.** `cfward run` injects
`CLOUDFLARE_API_TOKEN` into the child's environment because that is how
wrangler and the Cloudflare tooling expect to receive it. On Linux this makes
it readable at `/proc/<pid>/environ` for the duration of the command — by the
same user, who could have read it anyway. The alternative, writing it to a
file, is worse.

**Colours and progress bars missing from `cfward run` output.** The child's
stdout is piped rather than inherited so the token can be scrubbed from it.
That is the cost of the redactor, decided deliberately.

**The `.claude/settings.json` deny rules.** Those prevent an AI coding agent
from accidentally editing credential-handling code. They are a signpost for
tooling, not a security boundary, and were never intended to constrain a
determined process.

## Cloudflare tokens

If you believe a token of yours was exposed through cfward, rotate it first and
report second. Revoke it at
<https://dash.cloudflare.com/profile/api-tokens>; the report can wait the two
minutes that takes.
