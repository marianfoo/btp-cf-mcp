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
| 1 | ~~**Implement CF app-lifecycle writes**~~ — *shipped 2026-07-02*: `CFApps` restart/stop/start execute via `POST /v3/apps/:guid/actions/*`, **with server-side target resolution** (the app's real space is fetched from the Cloud Controller and gated against the allowlist — a caller-supplied space is never trusted). | ✅ |
| 2 | **Service-Manager writes** — *create/delete shipped 2026-07-02* (`BTPServices` via the CLI-server wire format, subaccount-gated, returning the new resource + a verify-next-step). **Remaining:** async job handling — a `BTPInspect.job_status` read + poll-until-terminal helper so the model can follow provisioning instead of re-listing instances. | S |
| 3 | **Structured result + error contract** (`outputSchema` / `structuredContent`) | Today reads `JSON.stringify` the raw backend payload and errors are free text. Define a small typed result shape (status, data, jobId?, identity-mode), declare `outputSchema`, add a `response_format=CONCISE\|DETAILED` lever, and resolve GUIDs → names. Quick precursor: a stable machine-readable error code prefix on `fail()`. | M |
| 4 | **Map IAS groups → MCP scopes** | Per-user least-privilege — a core selling point — isn't enforced at the scope layer yet (every OAuth user gets a fixed default scope set). Verify IAS emits a `groups` claim, then add a fail-closed group→scope table. | M |

## Growing the surface

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 5 | **More reads** — *largely shipped 2026-07-02*: app_logs, app_routes/features/current_droplet, service_bindings, service_instance_parameters, audit_events, org_usage_summary/quota (CF) + role_collections/trust_configs/security_settings/service_instances/offerings/plans (BTP). **Remaining:** `users`/`user_detail` (need the `--of-idp` origin CLI-server param key verified live — without it `security/user` defaults to `sap.default` and misses custom-IdP shadow users); `tasks`; cursor pagination (#6). Secret-bearing endpoints stay excluded (app_env, manifest, binding details/credentials, api-credential). | S |
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
