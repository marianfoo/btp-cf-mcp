# AGENTS.md

Guidance for AI coding agents working in this repo. **Single source of truth** — `CLAUDE.md` imports it.
Keep it terse: task → files + ≤1 gotcha per row. Deep detail lives in `docs/` (read on demand).
If you need the full project story, read `docs/agent/onboarding.md`; for docs placement/naming, read
`docs/docs-conventions.md`.

## Project Overview

**btp-cf-mcp** is a TypeScript MCP (Model Context Protocol) server for **SAP BTP + Cloud Foundry management**,
deployed on BTP Cloud Foundry, running IAS-first per-user auth. Tool surface (ADR-016/S3): reads and writes are
SEPARATE tools — **`CFInspect`** / **`BTPInspect`** (reads, `readOnlyHint:true`) + **`CFApps`** / **`BTPServices`**
(writes, blast-radius-grouped, hidden by default, not-yet-implemented). It reuses `@arc-mcp/xsuaa-auth` patterns
and the arc-1 scope/safety model.

> **Status & DECIDED direction — read the [plan](docs/architecture/implementation-plan.md) before touching auth or tools.**
> The code below is the **as-built PoC plus partial IAS/per-user spike code**. **Decided 2026-06-30:** move to
> **IAS-first inbound** where the server issues its *own* MCP token and holds the IAS credential sealed (ADR-009/017);
> **per-user CF *and* BTP** (BTP via the **CLI Server**, ADR-004; **CIS demoted to fallback**, ADR-003); and a
> **≤12 resource-split `CF*`/`BTP*` tool surface with reads separated from writes** (ADR-016). Build *toward the plan*,
> not toward the current PoC shape.

## Design Principles

1. **Read-only by default, opt-in power** — `ALLOW_WRITES=false`; every mutation refused until enabled + target allowlisted.
2. **Two authz layers** — the MCP scope gate (`read`/`write`/`admin`) is defense-in-depth + LLM-surface control; the *real* authz is the user's BTP/CF roles (per-user) or the technical identity's (shared).
3. **Fail closed** — no auth method configured ⇒ refuse to start (unless `ALLOW_OPEN`); per-user scopes only *narrow* the server ceiling.
4. **Call the REST APIs the CLIs use** — not the CLI binaries (Cloud Controller API + CIS REST), unless `cf push`/exotic commands force it.
5. **Per-credential scope** — one CIS key / one CF identity = one subaccount/GA; no roaming.

## Build & Test

```bash
npm ci
npm run build          # tsc -> dist/
npm test               # vitest (unit)
npm run typecheck      # tsc --noEmit (src + tests)
npm run lint / lint:fix / format   # biome (auto-fixed on commit via husky)
npm run dev            # tsx watch src/index.ts
# live MCP smoke: MCP_URL=… MCP_KEY=… node test/smoke.mjs
```
Pre-commit: Husky runs `lint-staged` → Biome auto-fixes staged files. **Never hand-fix formatting.**

## Configuration (env; on CF: bound VCAP_SERVICES > env > defaults)

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port (CF injects) |
| `API_KEYS` | `key:profile` pairs (viewer/developer/admin) for inbound auth |
| `ALLOW_OPEN` | `true` permits unauthenticated read-only (dev only); default fail-closed |
| `ALLOW_WRITES` | enable mutations (default false) |
| `ALLOWED_SUBACCOUNTS` / `ALLOWED_ORGS` / `ALLOWED_SPACES` | fail-closed write-target allowlists |
| `DENY_ACTIONS` | `Tool.action` / `Tool.*` / `Tool` deny patterns |
| `CIS_SERVICE_KEY` | CIS `client_credentials` key JSON (or bind a `cis` instance) |
| `CF_API` / `CF_REFRESH_TOKEN`+`CF_UAA_URL` / `CF_TOKEN` | CF Cloud Controller API + shared backend token: prefer `CF_REFRESH_TOKEN` (durable — refreshes the ~20min access token) over static `CF_TOKEN` (dies mid-session); per-user OAuth callers mint their own |
| `PUBLIC_URL` | OAuth-metadata URL behind a proxy |
| `IAS_ISSUER` / `IAS_CLIENT_ID` / `IAS_CLIENT_SECRET` | IAS-first inbound + app-to-app exchange config |
| `CF_PLATFORM_CLIENT_ID` / `CF_UAA_URL` | per-user CF exchange target + CF UAA token endpoint |
| `BTP_GA_SUBDOMAIN` | global-account subdomain; required for BTPInspect/BTPServices via the btp CLI *server* protocol (per-user OR tech-user; else shared-CIS fallback) |
| `BTP_TECH_USER` / `BTP_TECH_PASSWORD` / `BTP_TECH_IDP` | shared read-only technical user (Strategy B) — CLI-server username/password login; idp defaults to the IAS_ISSUER host |
| `SEALING_SECRET` / `SEALING_SECRET_PREVIOUS` | 32-byte-random key for sealed MCP tokens (weak = brute-forceable); set `_PREVIOUS`=old during rotation to keep live tokens valid (seal uses current, unseal tries both) |
| `MCP_REFRESH_TTL` | OAuth refresh-token lifetime = longest before a browser re-auth (jose duration, default `8h`); capped by the IAS tenant's own refresh-token lifetime |
| `DCR_SIGNING_SECRET` | dedicated HMAC for OAuth DCR client_ids (defaults to `SEALING_SECRET`); set it so a `SEALING_SECRET` rotation doesn't force every client to re-register |
| `BTP_DEFAULT_SUBACCOUNT` | default subaccount for the BTP tools when no CIS key supplies one (CLI-server-only deploy) |
| XSUAA | bound service → VCAP (inbound OAuth URL login via `@arc-mcp/xsuaa-auth`) |

## Codebase Structure

```
src/
  index.ts     # composition root: loadConfig -> build clients -> startHttp
  server.ts    # MCP Server + HTTP transport + XSUAA/API-key or IAS OAuth proxy + whoami diagnostic
  config.ts    # env/VCAP config loader (CIS, API keys, IAS, safety, allowOpen)
  registry.ts  # SINGLE SOURCE: every action = one ActionDef (metadata + run); tools/policy/dispatch derive from it
  policy.ts    # ACTION_POLICY DERIVED from registry.ts; expandScopes, hasScope
  safety.ts    # SafetyConfig + checkOperation (read-only gate) + deriveUserSafety + requireTarget (fail-closed) + isDenied
  handlers.ts  # dispatch (scope -> deny -> gate -> target) runs the registry action; runCfRead/runBtpRead bind the identity ctx
  btp.ts       # REST clients: CisClient + CfClient; backend response bodies stay out of MCP errors
  auth/        # IAS exchange, CF token, sealed MCP-token custody, IAS OAuth proxy (ias-oauth-provider), btpcli-http (per-user BTP account REST), btp-cli spike wrapper
  tools.ts     # tool definitions (LLM schema) + visibleTools (scope/write/deny/backend-aware pruning)
test/          # unit tests, live-chain integration skip, smoke.mjs live MCP client
docs/          # README + docs-conventions; agent/, architecture/, guides/, operations/, research/
```

## Key Files for Common Tasks

| Task | Files (+ gotcha) |
|---|---|
| Understand context fast | `docs/agent/onboarding.md` — current code and target architecture differ; keep them separate |
| Reconstruct original PoC history | `docs/agent/creation-history.md` — contains the spikes/review/debug lessons without leaked secrets |
| Add or move docs | `docs/docs-conventions.md` — choose `agent/`, `architecture/`, `guides/`, `operations/`, or `research/`; use kebab-case |
| Add a tool action | `src/registry.ts` — ONE `ActionDef` (tool/action/scope/op/target/backend/params/summary/run). `tools.ts` (schema+enum+desc), `policy.ts` (ACTION_POLICY), and dispatch all DERIVE from it — no three-file drift |
| Grow the tool surface | add registry entries; keep the tool COUNT small (fewer tools select better) — capability via actions, not micro-tools |
| Change the safety gate | `src/safety.ts` — `requireTarget` is fail-closed (omitted write target is refused); per-user scopes only narrow |
| Add an outbound backend / token flow | `src/auth/token-provider.ts` + `src/btp.ts` — keep identity pluggable; never log assertions/tokens |
| BTPInspect as user OR tech user | `src/auth/btpcli-http.ts` (`btpcliLogin` jwt / `btpcliLoginPassword` user+pw) + `runBtpRead` (`perUserLogin`/`techLogin` → cached session → registry action) in `src/handlers.ts`; gate on `BTP_GA_SUBDOMAIN`; precedence per-user→tech-user→CIS-fallback; entitlements = GA-level (Global Account Viewer), subaccount-scoped reads need Subaccount Viewer |
| Inbound auth change | `src/server.ts` `startHttp` — IAS-first proxy (`src/auth/ias-oauth-provider.ts` + `mcpAuthRouter` + sealed-JWE verifier) when IAS configured, else `setupHttpAuth` (XSUAA/api-key). SHIPPED; see [ADR-001/007](docs/architecture/implementation-plan.md) |
| Config / env | `src/config.ts` — secrets from VCAP/env, never committed |
| Per-user CF/BTP setup (admin) | [docs/guides/per-user-ias-auth-setup.md](docs/guides/per-user-ias-auth-setup.md) |
| Debug "no tools" after OAuth | `whoami` + role collections — valid auth with zero scopes prunes everything by design |

## Documentation Layout

`docs/` is organized by reader need:

- `agent/` — AI-agent context and project history.
- `architecture/` — architecture plans and protocol explanations; accepted ADRs go in `architecture/adr/0001-title.md`.
- `guides/` — setup and admin how-to docs.
- `operations/` — runbooks, live-test plans, and spike status.
- `research/` — dated research dossiers (`YYYY-MM-DD-topic.md`).

New docs use lowercase kebab-case and must be linked from `docs/README.md`. Do not add loose one-off Markdown files
under `docs/`.

## Architecture: Request Flow

1. **HTTP transport** (`src/server.ts`, stateless StreamableHTTPServerTransport per request).
2. **Inbound auth** (PoC: `@arc-mcp/xsuaa-auth setupHttpAuth`, XSUAA / API key → `authInfo { scopes }`; IAS branch issues sealed MCP tokens; fail-closed unless `ALLOW_OPEN`). **Decided target → IAS-first**: server issues its own audience-bound MCP token + holds the IAS credential sealed (plan ADR-001/009/017).
3. **dispatch** (`src/handlers.ts`): scope check (`ACTION_POLICY`) → deny check → `checkOperation` (read-only gate) → `requireTarget` (fail-closed allowlist, writes) → backend.
4. **Outbound** (`src/btp.ts` + `src/auth/*`): `CisClient` (shared `client_credentials` fallback) / `CfClient` (shared or per-user IAS exchange). BTP per-user is via CLI Server work, not CIS REST.
5. **Tool listing** prunes the action enum by scope ∧ write-gate ∧ deny ∧ backend availability (`visibleTools`).

**Key invariant:** scope ∧ safety ∧ (SAP/CF auth). All must pass.

## Code Patterns

```typescript
// Outbound token provider — the per-user swap point (src/auth/token-provider.ts)
export interface TokenProvider { getToken(): Promise<string>; }
// shared today: new ClientCredentialsProvider(tokenUrl, clientId, secret)  (single-flight + 60s cache)
// per-user CF: new IasUserTokenProvider(unsealedIasCredential, iasConfig)

// Dispatch gate order (src/handlers.ts) — never reorder past the safety checks
const policy = getPolicy(name, action);
if (!hasScope(scopes, policy.scope)) return fail(`requires '${policy.scope}'`);
const safety = deriveUserSafety(config.safety, scopes);
checkOperation(safety, policy.op, name);                 // read-only by default
if (policy.op !== 'R' && policy.target) requireTarget(safety, policy.target, resolvedTarget);  // fail-closed
```

## Style & Quality
- **ESM-only** (local imports need `.js`), **TypeScript strict**, **Biome** (2-space, single quotes, 120 cols — auto-fixed on commit, never hand-format).
- **Conventional commits** (`feat:`/`fix:` → release-please); `chore:`/`docs:`/`ci:`/`refactor:` → no release.
- Every code change requires a test; security/gate logic must leave a runnable check.
- Secrets never committed; never log tokens. The `whoami` tool is diagnostic — keep it honest about scopes.
