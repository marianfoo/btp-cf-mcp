# Contributing to btp-cf-mcp

Thanks for your interest! This is a proof-of-concept MCP server for SAP BTP + Cloud Foundry
management. Before diving in, skim [AGENTS.md](AGENTS.md) — the single source of truth for how the
codebase is organized and the invariants to preserve (it's written for AI agents but works for humans).

## Prerequisites

- **Node 22+** and npm.
- `npm ci` to install.

## Development loop

```bash
npm ci
npm test           # unit tests (vitest) — every change needs a test
npm run typecheck  # tsc --noEmit (src + tests)
npm run lint       # biome (do NOT hand-fix formatting — see below)
npm run build      # tsc → dist/
npm run dev        # local run; loads .env if present (copy .env.example → .env)
```

Run the full set before opening a PR. See [ROADMAP.md](ROADMAP.md) for where the project is headed.

## Conventions

- **Conventional commits.** `feat:` and `fix:` drive [release-please](https://github.com/googleapis/release-please)
  version bumps; `docs:`/`chore:`/`refactor:`/`test:`/`ci:` don't cut a release. Use those for
  behavior-preserving changes.
- **Never hand-format.** A husky pre-commit hook runs `biome check --write` on staged files. Let it.
- **Add a test with every code change.** New tool actions are a `~10-line` `ActionDef` in
  `src/registry.ts` (the single source that drives the schema, scopes, and dispatch) plus a test.
- **Keep secrets out of git.** Config comes from env / `cf set-env` / an mtaext *outside* the repo —
  never commit `.env`, service keys, tokens, or a filled `.mtaext`.
- **Logging goes to stderr** (stdout is reserved). Read-only by default; writes stay behind the safety gate.

## Reporting issues

Open a GitHub issue with what you ran, what you expected, and the actual output (redact any tokens).
