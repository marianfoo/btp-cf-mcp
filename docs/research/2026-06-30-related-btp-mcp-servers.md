# Reference: How other BTP MCP servers handle auth (and what we learn)

**Date:** 2026-06-30 · **Status:** Reference (keep for future) · Companion to `2026-06-30-per-user-outbound-auth.md`

Two existing BTP MCP servers were analyzed in depth (read-only clones) to compare auth approaches against our per-user goal.

## Comparison

| | `lemaiwo/btp-mcp-server` | `sap-ef/sap-btp-usage-mcp-server` |
|---|---|---|
| **What** | CIS account admin (accounts/entitlements/provisioning) + XSUAA authorization, ~35 **generated** CRUD tools | FinOps/cost reporting (UAS Reporting Service), 6 read-only tools, built for **Joule** |
| **Really is** | A **config-only repo** running the npm pkg `odata-mcp-proxy` (generic OData→MCP proxy) | ~9-file TS server, SAP-internal team |
| **Inbound auth** | XSUAA OAuth (auth-code + static DCR echo) via `@sap/xssec` | XSUAA JWT, but caller = **Joule's technical `client_credentials`** client |
| **Outbound auth** | **Destination Service + SAP Cloud SDK** (`executeHttpRequest(dest, …)`) — destinations configured as `OAuth2ClientCredentials` | **`client_credentials`** against a UAS Reporting **service key** (re-fetched every call, no cache) |
| **Per-user?** | **Plumbed, not flipped** — forwards the user JWT but destinations are client-credentials → shared identity | **No** — shared technical identity end to end |
| **BTP CLI Server / `cf auth --assertion`?** | None | None |
| **Stack** | TS, MCP SDK, `@sap-cloud-sdk/*` 4.x, Express, Streamable HTTP + stdio, MTA deploy | TS, MCP SDK, Express, Streamable HTTP + SSE, CF buildpack |

**Bottom line:** neither does true per-user. Both confirm our research thesis — the common, low-effort path is a **shared `client_credentials` identity**, and even an SAP-internal team (usage repo) ships that. Our IAS-id_token → `cf auth --assertion` / BTP CLI Server plan is genuinely differentiated; **neither repo touches the CLI Server or `cf auth --assertion` at all**.

## The one useful idea (from lemaiwo) — a cheap CIS per-user spike

lemaiwo threads the caller's JWT all the way to `resolveDestination(destName, jwt)` but uses **client-credentials** destinations, so the JWT is ignored. The lever it leaves on the table: **if the BTP Destination is typed `OAuth2UserTokenExchange` (or `OAuth2JWTBearer`), the SAP Cloud SDK auto-exchanges the user JWT for a backend token in-zone — no manual assertion code.** This is exactly arc-1's `lookupDestinationWithUserToken` path (our doc's **M7**).

→ **Actionable:** the *lowest-effort* attempt at per-user **CIS** is: create a Destination of type `OAuth2UserTokenExchange` fronting the CIS UAA, forward the user JWT, and see if the returned token carries real CIS scopes. arc-1 already has the code (`lookupDestinationWithUserToken` → `authTokens.bearerToken`). **Caveat (per our research + Codex):** this still hits the CIS resource-server wall — CIS docs only bless Password + Client-Credentials, and the SAP-managed cis app may not grant foreign scopes (KBA 3355232 class). So it's a **cheap, low-confidence spike** worth running alongside the IAS-first test (≈ our OQ-5), *not* a proven path.

## Patterns to borrow

- **Stateless Streamable-HTTP-per-request** (both) — fresh transport per `POST /mcp`, avoids request-id collisions across MCP clients. (We already do this.)
- **RFC 8414 `/.well-known/oauth-authorization-server`** synthesized from XSUAA creds (both) — good MCP OAuth-discovery template.
- **Static DCR echo** (lemaiwo) — the dynamic-client-registration endpoint just echoes the bound XSUAA `clientid`/`clientsecret` so Claude/Cursor "just work"; echo `redirect_uris` verbatim (don't override — breaks some clients).
- **Dual credential resolution** (both) — env vars → `default-env.json` → Destination Service; `Boolean(process.env.VCAP_SERVICES)` switches local vs BTP.
- **Usage/cost API as a tool surface** (usage repo) — `/reports/v1/cloudCreditsDetails`, `/monthlySubaccountsCost` etc. A cheap, high-value **read-only** module (its own service key, Global-Account-scoped, behind a `read`/`usage` scope). Worth adding to ours later for FinOps questions.

## Anti-patterns to avoid (we already do the right thing)

- **lemaiwo hardcodes `scopes: []`** after validating the JWT → XSUAA role-collections are validated but never enforced; a viewer token can call `_delete`. Our `ACTION_POLICY` scope ∧ safety gate is the correct answer — keep it.
- **Both fail OPEN in local/dev mode** (auth disabled with a warning). We **fail closed** unless `ALLOW_OPEN` — keep it.
- **Usage repo re-fetches the outbound token every call** (no caching) + `Access-Control-Allow-Origin: *` on SSE. We cache (single-flight) and don't wildcard CORS — keep it.
- **lemaiwo's generic 3-param tool** (`path`/`body`/`headers`, LLM builds the OData) = very few tokens but pushes OData knowledge onto the LLM. arc-1/ours use curated intent tools with rich schemas — a deliberate, opposite trade-off.

## Files of record
- `lemaiwo/btp-mcp-server`: `btp-admin-api-config.json` (the API wiring); real logic in npm `odata-mcp-proxy` (`client/destination-service.js` `resolveDestination`, `tools/registry.js` JWT threading, `auth/xsuaa-auth.js`).
- `sap-ef/sap-btp-usage-mcp-server`: `src/services/sap-api-client.ts` (`getOAuthToken`, `getDirectCredentials`), `src/auth/*`, `src/index.ts` (transports + RFC 8414).
