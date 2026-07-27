# Contributing to cfward

Thanks for taking an interest. cfward is small and intends to stay that way, so
the fastest route to a merged change is usually a short issue first — a
paragraph describing the problem is enough to find out whether a PR is wanted
before you write one.

## Before anything else

**Never paste a real Cloudflare API token.** Not in an issue, not in a PR, not
in a test fixture, not in a screenshot. If one slips out, revoke it at
<https://dash.cloudflare.com/profile/api-tokens> before doing anything else —
deleting the comment is not enough, because the token was already delivered by
email to everyone watching the repository.

If you have found a way to expose someone's token, do not open an issue at all.
See [SECURITY.md](SECURITY.md).

## Setup

Requires Node 22.11 or newer and pnpm.

```bash
git clone https://github.com/ricardogottheil/cfward.git
cd cfward
pnpm install
pnpm typecheck && pnpm test
```

`pnpm install` will report a blocked build script the first time only if
`pnpm-workspace.yaml` is missing an entry. Approved scripts live under
`allowBuilds` there, never in a local `pnpm approve-builds`, so the allowlist
stays visible in review.

No Cloudflare account is needed to develop or test. Every test runs against
stubs and none of them touch the network.

## Running it locally

Point the config directory somewhere disposable so development never writes to
your real profile store:

```bash
export CFWARD_CONFIG_DIR=/tmp/cfward-dev
pnpm build
node dist/cli.js list
```

`CFWARD_BACKEND=vault` forces the encrypted-file backend on a machine that has
an OS keychain, which is the only way to exercise that path on macOS.

## The rules

The project's conventions and its security invariants live in
[AGENTS.md](AGENTS.md). That file is the single source of truth, written so that
both people and AI coding agents read the same rules. Read it before your first
change — particularly the eight security invariants, which are not style
preferences and are not up for negotiation in a PR.

Two that catch newcomers most often:

**No new dependencies without discussion.** Every transitive dependency runs in
the same process as a decrypted token. Open an issue proposing it, with the
transitive tree (`pnpm why` after a local install), before writing code on top
of it.

**`src/secrets/` is not modified casually.** It is reviewed cryptographic code.
If a change genuinely requires touching it, say so in the issue first.

## Tests

Every behaviour change needs a test, and the bar is a little higher than usual:

**A test that passes on broken code is worse than no test.** It is a green light
over a hole. Before you submit, break the thing you just fixed — invert the
condition, delete the guard — and confirm your test goes red. If it does not,
the test is asserting something other than what you think.

This matters more than it sounds. Several tests in this repository exist only
because a first version passed against deliberately broken code and had to be
rewritten.

Where a test asserts that something _did not_ happen — output not written, input
not consumed, a value not present — pair it with a control proving the assertion
could have failed. `consumed === false` is worthless if nothing was ever going
to read that stream.

## Submitting a change

```bash
pnpm typecheck && pnpm test
```

Both must pass. Then open a PR that says what changed and why; the diff already
says how.

- Keep unrelated changes in separate commits. A bundler upgrade and a bug fix in
  one commit cannot be reverted independently.
- Comments explain _why_, not _what_. A comment restating the line above it is
  noise; one explaining a non-obvious trade-off is the most valuable thing in
  the file.
- All code, comments, error messages and documentation are in English.
- Errors carry a `code` to branch on and a `hint` naming the user's next
  command. An error that leaves someone without a next step is incomplete.

## Reviews

Expect questions, especially on anything touching credentials. They are not
distrust — this is a tool people point at production accounts, and "why is this
correct" is a fair thing to have to answer in writing.

Small, focused pull requests get reviewed faster than large ones. That is not a
policy, just arithmetic.
