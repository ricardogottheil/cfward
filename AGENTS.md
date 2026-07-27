# cfward

CLI for managing multiple Cloudflare accounts across projects, with tokens
encrypted at rest.

This file is the canonical instruction set for all coding agents. Tool-specific
files (`CLAUDE.md`, `.cursor/rules`) import it rather than duplicating it — edit
this file, not the wrappers.

## Tooling

- **Package manager: pnpm.** Never use `npm` or `yarn`. Never hand-edit
  `pnpm-lock.yaml`.
- Strict TypeScript, ESM (`"type": "module"`). Relative imports carry the
  `.js` extension.
- Tests with vitest. Build with tsdown (Rolldown-based; it replaced tsup, which
  its own author no longer maintains).
- **`tsdown.config.ts` pins values that are already tsdown defaults** — `format`,
  `clean`, `dts`. This is deliberate, not redundancy to clean up: tsdown is
  pre-1.0 and free to change its defaults between minors, and this build
  produces the package published to npm. `target` is deliberately _absent_, so
  the supported Node floor lives only in `engines.node`.
- Node 22+. **`@types/node` must stay on major 22** to match the supported
  floor. Installing a newer major lets TypeScript accept APIs that do not
  exist on the minimum supported runtime. Raise `engines.node` and the types
  together or not at all.
- **pnpm settings live in `pnpm-workspace.yaml`, not in `package.json`.** The
  `pnpm` field of `package.json` is ignored from pnpm 11 onward. Do not
  reintroduce it.
- pnpm blocks dependency install scripts by default. Approved ones are listed
  under `allowBuilds` in `pnpm-workspace.yaml` (the pre-v11 `onlyBuiltDependencies`,
  `neverBuiltDependencies` and `ignoredBuiltDependencies` keys no longer exist).
  Approve there, never via a local `pnpm approve-builds`, so the allowlist stays
  reviewable in a diff. Adding an entry requires the same justification as adding
  a dependency.
- **All code, comments, error messages, and docs are in English.**

## Commands

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # tsdown
```

Run `pnpm typecheck` and `pnpm test` before reporting a task as done. Do not
report success on code you have not type-checked.

## Architecture

```
src/
  secrets/        Three-layer credential store. ALREADY IMPLEMENTED.
                  keyring (OS) -> vault (encrypted file) -> env (CI)
  project/        Config resolution, output redaction, child process
                  spawning. ALREADY IMPLEMENTED.
  cloudflare/     Cloudflare API client
  commands/       CLI commands
```

The design goal is that `cfward run -- wrangler deploy` picks the right account
with no flags, by reading a committed `.cfward.json` that names a profile, and
resolving that profile's token from the local encrypted store.

## Security invariants — non-negotiable

These apply to all code. If a task appears to require breaking one, stop and
ask rather than improvising.

1. **A token is never written to disk unencrypted.** Not to `.env`, not to
   logs, not to temp files, not to a cache.
2. **A token is never passed as a CLI argument.** It is visible in `ps` and
   lands in shell history. It arrives via interactive prompt or stdin.
3. **A token is never printed.** When displaying a profile, mask it:
   `cf_ab...9f2`. Filter subprocess stdout/stderr in case wrangler leaks it in
   an error.
4. **`.cfward.json` is committed and contains only the profile name.** Never
   the token, and never the `accountId` if the repo is public.
5. **The token is injected only into the child process `env`**, never via
   `export` and never written into the parent shell's environment.
6. **No new dependencies without justification.** Every transitive dep can read
   the same secrets the CLI reads. Propose the dep and wait for approval.
7. **Child process stdout and stderr are piped, never inherited.** The token
   has to pass through the redactor before it reaches a terminal, a CI log or a
   scrollback buffer. The cost is that the child sees a non-TTY stdout and
   drops colours and progress bars — `wrangler deploy` looks plainer than it
   does when run directly. That is a known and accepted trade-off, decided
   deliberately, not a bug to fix. Do not switch `stdio` to `inherit`, do not
   make redaction conditional on `isTTY`, and do not add a pty dependency
   (`node-pty` or similar) to win the colours back.
8. **Never weaken the crypto to make a test pass or to speed anything up.**
   Lowering the scrypt parameters, dropping the AAD binding, or skipping the
   integrity check are never valid fixes. The vault tests take ~500 ms each by
   design: that cost is the security property. If a test fails, the test or
   the caller is wrong.

## Platform differences

- **Windows has no POSIX signals, and the signal tests are skipped there on
  purpose.** `process.kill(pid, "SIGTERM")` on Windows is not a signal: libuv
  maps it to `TerminateProcess`, which stops the target unconditionally with
  exit code 1. A process cannot install a handler that will ever fire, so the
  forward-then-escalate behaviour in `src/project/run.ts` and the 128 + n exit
  convention do not exist on that platform. The affected tests in
  `test/run.test.ts` are behind `describe.skipIf(process.platform === "win32")`
  with the reason written out. Do not make them pass on Windows by loosening
  the assertions — that asserts semantics the platform does not have. The
  user-visible consequence is documented under Known trade-offs in the README.
- **Windows stays in the CI matrix anyway.** `src/secrets/paths.ts` has a win32
  branch and the keychain backend uses Credential Manager. Dropping the OS to
  make a signal test green would take real coverage with it.
- **Prefer `process.execPath` over a shell utility in tests.** A test that
  spawns `sleep` fails on Windows for no reason connected to what it is
  testing. Node is present wherever the tests run.

## Conventions

- Domain errors use `SecretError` or `ProjectError`, each with a `code` to
  branch on and an actionable `hint`. The user should finish reading knowing
  which command to run next. Never put a secret, or a value suspected of being
  one, into either field.
- The secrets module imports nothing from the CLI layer. The passphrase arrives
  as a callback (`PassphraseProvider`) so it can be tested without a TTY.
- Comments explain _why_, not _what_.
- Prefer editing existing files over creating new ones. Do not add README or
  docs files unless asked.

## Boundaries

- Do not modify `src/secrets/` without being asked. It is reviewed code that
  handles credentials. `.claude/settings.json` denies `Edit(src/secrets/**)`,
  which already covers every built-in file-editing tool including `Write` — a
  separate `Write(...)` entry is inert and Claude Code warns about it, so do not
  add one back. But that deny prevents accidents, not determination: Bash can
  still write to those paths through `cp`, `tee`, `sd`, or shell redirection. Treat it as a
  signpost, not a sandbox. Reaching for Bash to modify a file the deny list
  covers is the signal to stop and ask, not a workaround to use.
- Do not commit or push. Leave changes staged for human review.
- Do not add telemetry, analytics, or any network call other than to
  `api.cloudflare.com`.
