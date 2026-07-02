# Roadmap

Where btp-cf-mcp is today and what would take it from proof-of-concept to product. Derived from a
multi-dimensional review (2026-07). Effort: **S** ≈ hours, **M** ≈ days, **L** ≈ weeks.

## What works today

- **Per-user "acts as you"** inbound: IAS OAuth proxy → sealed MCP token → CF/BTP calls as the user.
- **Shared read-only** modes: api-key + technical BTP user; durable shared CF token (auto-refresh).
- **Reads**: `CFInspect` (orgs, spaces, apps, services, routes, app_detail, app_processes) and
  `BTPInspect` (environments, subaccount, subaccounts, global_account, subscriptions, entitlements),
  with large-payload projection and honest truncation signals.
- **Safety**: read-only by default, fail-closed write-target allowlists, per-action deny (validated at
  startup), scope-based tool pruning, per-tool MCP annotations.

## Near-term (highest leverage)

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 1 | **Implement CF app-lifecycle writes** (`CFApps` restart/stop/start) | The four write actions pass the safety gate but return "NOT YET IMPLEMENTED" — the biggest gap keeping this a PoC. Lowest blast radius, idempotent, no async. Needs server-side target resolution (resolve app GUID → real space before the allowlist check, instead of trusting the LLM-supplied space). | M |
| 2 | **Service-Manager writes** (`BTPServices` create/delete) **+ async job handling** | Service create/delete are asynchronous on BTP (return a job ref, not a finished resource). Add a `BTPInspect.job_status` read + a shared poll-until-terminal helper first, so a write can return a job ref the model follows. | M |
| 3 | **Structured result + error contract** (`outputSchema` / `structuredContent`) | Today reads `JSON.stringify` the raw backend payload and errors are free text. Define a small typed result shape (status, data, jobId?, identity-mode), declare `outputSchema`, add a `response_format=CONCISE\|DETAILED` lever, and resolve GUIDs → names. Quick precursor: a stable machine-readable error code prefix on `fail()`. | M |
| 4 | **Map IAS groups → MCP scopes** | Per-user least-privilege — a core selling point — isn't enforced at the scope layer yet (every OAuth user gets a fixed default scope set). Verify IAS emits a `groups` claim, then add a fail-closed group→scope table. | M |

## Growing the surface

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 5 | **More reads**: recent app logs, tasks, current scale, service keys/bindings, role-collection membership, marketplace/plan catalog, org/space quotas | Common ops questions are unanswerable today. Each is a ~10-line `ActionDef`. Keep `app_env` excluded (credential leak). | M |
| 6 | **Cursor pagination** across CF list reads | Reads cap at 50 and only signal truncation. Add an optional `page`/cursor param threaded through the `run()` closures. | S |
| 7 | **Optional stdio / local transport** | `index.ts` only starts HTTP; most desktop MCP clients attach over stdio. Add a `TRANSPORT=stdio` path reusing `buildServer()` with an env-token identity and no inbound OAuth — a 2-minute on-ramp. | M |

## Hardening & quality

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 8 | **Test coverage** for `config.ts` (0% today), `dispatch()` gate tree, `runBtpRead` precedence + 401-retry, `whoami`, and `tools` visibility pruning | These hold real footguns (api-key profile→scope mapping, IAS all-5-required, precedence). Pair with the CI coverage step now wired in. | M |
| 9 | **Observability**: structured per-call audit events + basic metrics | For a server whose pitch is per-user attribution, a single `console.error` isn't enough. Emit a structured JSON audit event (who/what/identity-mode/target/outcome) + latency/error counters; extend `/health` + `whoami` to report per-leg identity mode. | M |
| 10 | **Rate limiting + outbound backoff** on 429/5xx + bounded concurrency | No per-user MCP rate limit and no outbound retry/backoff; `app_processes` fans out one `/stats` call per process type. | M |
| 11 | **Remove the `btp-cli.ts` spike** | `src/auth/btp-cli.ts` shells a bundled `btp` binary, is explicitly SPIKE-ONLY (JWT in argv, visible in `ps`), and is superseded by the REST path (`btpcli-http.ts`). Used only by two tests. Delete it (retarget the tests) or quarantine it under a labeled `spike/` dir so a reader can't wire it up. | S |
| 12 | **Wire CORS behind `ALLOWED_ORIGINS`** | The IAS-first branch bypasses `setupHttpAuth` and emits no `Access-Control-*` headers; the `applyCors` helper ships in `@arc-mcp/xsuaa-auth` but isn't reachable (not re-exported). Not needed for any current client (Copilot/Claude/Codex/Cursor all use native HTTP), only for a future **browser-origin** MCP client. Add a config field + call `applyCors` (needs an upstream re-export or a deep import). | S |
