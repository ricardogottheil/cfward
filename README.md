<!-- Cover and badges are served by shieldcn.dev. Every image is wrapped in
     <picture> because the SVG carries a fixed background: mode=light renders
     dark-on-light for GitHub's light theme, mode=dark renders light-on-dark.
     A single URL is invisible against one of the two.

     The cover lives inside the <h1> on purpose. The document keeps a real
     top-level heading, named by the image's alt text, without printing the
     title twice. Do not try to hide a separate <h1> instead: GitHub's
     sanitizer strips both `style` and `hidden`, so it would render visible. -->

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/header/glow.svg?title=cfward&amp;subtitle=Multiple%20Cloudflare%20accounts%2C%20tokens%20encrypted%20at%20rest&amp;logo=lu:KeyRound&amp;theme=orange&amp;mode=dark">
    <img alt="cfward" src="https://shieldcn.dev/header/glow.svg?title=cfward&amp;subtitle=Multiple%20Cloudflare%20accounts%2C%20tokens%20encrypted%20at%20rest&amp;logo=lu:KeyRound&amp;theme=orange&amp;mode=light">
  </picture>
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cfward"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/cfward.svg?mode=dark"><img alt="npm version" src="https://shieldcn.dev/npm/cfward.svg?mode=light"></picture></a>
  <a href="https://github.com/ricardogottheil/cfward/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/ricardogottheil/cfward.svg?workflow=ci.yml&amp;branch=main&amp;mode=dark"><img alt="CI" src="https://shieldcn.dev/github/ci/ricardogottheil/cfward.svg?workflow=ci.yml&amp;branch=main&amp;mode=light"></picture></a>
  <a href="https://www.npmjs.com/package/cfward"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/npm/node/cfward.svg?mode=dark"><img alt="Node >=22.11.0" src="https://shieldcn.dev/npm/node/cfward.svg?mode=light"></picture></a>
  <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/ricardogottheil/cfward.svg?mode=dark"><img alt="MIT license" src="https://shieldcn.dev/github/license/ricardogottheil/cfward.svg?mode=light"></picture></a>
</p>

Manage multiple Cloudflare accounts across projects, with tokens encrypted at
rest.

Each repository names a profile in a committed file. cfward resolves that name
to a token from your OS keychain and injects it into the command you run —
never into your shell, never into a `.env`, never onto your clipboard.

```bash
cfward run -- wrangler deploy
```

No flags. The right account, because the repository already said which one.

## The problem

If you work on more than one Cloudflare account, you have probably done at
least one of these:

- Kept `CLOUDFLARE_API_TOKEN` exported in `.zshrc` and deployed a client's
  project to your own account.
- Kept several tokens in `.env` files, one per repository, and hoped every one
  of them was in `.gitignore`.
- Pasted a token from the dashboard each time and let it sit in your shell
  history.

All three fail the same way: the token lives somewhere readable, and which
account you are deploying to depends on what you last typed.

## Install

```bash
npm install -g cfward
# or
pnpm add -g cfward
```

Requires Node 22.11 or newer.

## Quick start

Store a token once per machine:

```bash
cfward login --profile acme-client
```

You will be prompted for the token — it is never echoed and never accepted as a
command-line argument. cfward verifies it against Cloudflare, offers a picker
if the token reaches more than one account, and stores it encrypted.

Then, in a repository:

```bash
cfward use acme-client
```

That writes `.cfward.json`, which you commit:

```json
{
  "profile": "acme-client"
}
```

From then on, in that repository and any subdirectory of it:

```bash
cfward run -- wrangler deploy
cfward run -- wrangler d1 list
```

A teammate clones the repository, runs `cfward login --profile acme-client`
once with their own token, and everything works with no further setup.

## How it resolves

```
cfward run -- wrangler deploy
        │
        ▼
 .cfward.json in this repo          ← committed. profile name only, no secrets
        │  "acme-client"
        ▼
 local profile store                ← OS keychain, or an encrypted vault file
        │  the token
        ▼
 wrangler, with the token
 in its environment only            ← dies with the process
```

The search walks up from the current directory and stops at the git repository
root or `$HOME`, whichever comes first. A `.cfward.json` sitting above your repo
in a parent checkout cannot select an account for it.

## Commands

| Command                         | What it does                                                                |
| ------------------------------- | --------------------------------------------------------------------------- |
| `cfward login --profile <name>` | Prompt for a token, verify it, store it encrypted                           |
| `cfward list`                   | Profiles on this machine, with account and expiry                           |
| `cfward use <profile>`          | Write `.cfward.json` so this project selects a profile                      |
| `cfward run -- <command>`       | Run a command with the profile's credentials                                |
| `cfward status`                 | Which profile this directory resolves to, and whether its token still works |
| `cfward logout <profile>`       | Remove a profile from this machine                                          |

Useful flags:

```bash
cfward login --profile ci --stdin        # read the token from a pipe
cfward login --profile x --account-id …  # skip the account picker
cfward list --tokens                     # show a masked fingerprint of each token
cfward run --profile staging -- wrangler deploy   # override for one command
cfward --version                         # or -v, prints the installed version
```

`cfward run` passes the child's exit code through unchanged, so it composes
with `&&`, `make`, and CI steps the way you would expect.

## Where the token lives

cfward tries three backends in order:

1. **Your OS keychain** — macOS Keychain, Windows Credential Manager, or the
   Linux Secret Service. This is the default wherever one is available.
2. **An encrypted vault file** — for containers and headless machines with no
   keychain. Encrypted with XChaCha20-Poly1305 under a key derived from a
   passphrase with scrypt. Each entry is bound to its profile name, so swapping
   two entries in the file is detected rather than silently deploying to the
   wrong account.
3. **Environment variables** — for CI, where there is no keychain and nobody to
   type a passphrase. `CFWARD_TOKEN_<PROFILE>` or `CLOUDFLARE_API_TOKEN`.

Account names, IDs and expiry dates are stored separately in plain JSON, on
purpose: `cfward list` and `cfward status` stay instant and never make you
unlock anything to answer "which account is this project on".

The token itself is never written unencrypted, never passed as a command-line
argument where `ps` and your shell history would capture it, and never printed.
Output from commands run through `cfward run` is scrubbed, in case the tool
underneath leaks it into an error message.

## Token permissions

Create tokens at
<https://dash.cloudflare.com/profile/api-tokens> with the narrowest permission
that covers what you deploy. A few starting points:

| You deploy                   | Permission                        |
| ---------------------------- | --------------------------------- |
| Workers                      | Account · Workers Scripts · Edit  |
| Pages                        | Account · Cloudflare Pages · Edit |
| D1                           | Account · D1 · Edit               |
| Nothing, just testing cfward | Account · Account Settings · Read |

Most people reach for a global API key because nobody tells them which scopes
they need. A scoped token that expires is a much smaller problem when it leaks,
and `cfward status` warns you before the expiry date arrives.

## In CI

There is no keychain and nobody to answer a prompt, so pass the token as a
secret:

```yaml
- run: cfward run -- wrangler deploy
  env:
    CFWARD_TOKEN_ACME_CLIENT: ${{ secrets.CLOUDFLARE_TOKEN }}
```

The profile name comes from the committed `.cfward.json`, and the environment
variable supplies the token for it. Nothing else changes between your machine
and CI.

To store a token non-interactively, pipe it:

```bash
echo "$CF_TOKEN" | cfward login --profile ci --stdin
```

## Known trade-offs

**Commands run through `cfward run` lose colours and progress bars.** Their
output is piped rather than inherited so the token can be scrubbed from it,
and the child therefore sees a non-TTY stdout. This is deliberate. Redaction is
worth more than colour on a tool whose entire job is keeping a credential out
of places it should not be.

**On Windows, Ctrl+C during `cfward run` terminates the child immediately.**
Everywhere else the signal is forwarded to the child, which gets the chance to
shut down cleanly, and a second Ctrl+C escalates to SIGKILL. Windows has no
POSIX signals, so there is nothing to forward: the child is stopped outright and
does not get to run its own cleanup. If the command you are running needs to
finish what it started, let it finish.

**cfward protects secrets at rest, not against a compromised session.** Anything
already running as your user can prompt you, read your keychain, or wait for you
to unlock the vault. What cfward raises the cost of is a stolen laptop, a leaked
backup, a `.env` committed by accident, and deploying to the wrong account.

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). The conventions and security invariants live
in [AGENTS.md](AGENTS.md).

Found a way to expose a token? Do not open an issue. See
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
