@AGENTS.md

## Claude Code specific

- Use plan mode for any change under `src/secrets/` or `src/cloudflare/`. Show
  the plan and wait for approval before editing credential-handling code.
- Do not run `git commit` or `git push`. Stage changes and stop.
- When adding a dependency, run `pnpm why <pkg>` afterwards and report the
  transitive tree size. Every dep can read the same secrets the CLI reads.
