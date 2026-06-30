# LLM Onboarding Guide

This is the compact but complete project map for future AI agents. `AGENTS.md` stays terse; this file gives the
context needed to avoid repeating old mistakes.

## 1. Current State In One Page

`btp-cf-mcp` is a TypeScript MCP server for SAP BTP and Cloud Foundry management on BTP Cloud Foundry.

There are two states to keep separate:

| Layer | Current code | Decided direction |
|---|---|---|
| Inbound auth | XSUAA URL login or API key; partial IAS-first branch exists | IAS-first OAuth proxy; server issues its own MCP token |
| MCP scopes | XSUAA role collections or API-key profile | IAS groups -> `read` / `write` / `admin`, fail closed |
| CF outbound | shared `CF_TOKEN` or per-user CF when IAS credential is present | per-user CF via IAS app-to-app exchange -> CF UAA |
| BTP outbound | CIS REST shared technical key | per-user BTP account ops via BTP CLI Server; CIS only fallback |
| Tool surface | legacy `CloudFoundry` + `BTPAccount` tools | <=12 resource-split `CF*` / `BTP*` tools, reads separated from writes |
| Writes | gated, target-allowlisted, mostly inert PoC stubs | real writes only after server-side target resolution |

If you change auth or tools, read `docs/architecture/implementation-plan.md` first. It records the accepted direction.
If you add or move docs, read `docs/docs-conventions.md` first.

## 2. Read Order

For a new task, read only what is relevant:

| Need | Read |
|---|---|
| Fast repo orientation | `AGENTS.md`, then this file |
| Where new docs belong | `docs/docs-conventions.md` |
| Why the project was built this way | `docs/agent/creation-history.md` |
| Accepted architecture and phases | `docs/architecture/implementation-plan.md` |
| IAS-first inbound work | `docs/architecture/ias-oauth-proxy-plan.md` |
| Per-user CF/BTP setup | `docs/guides/per-user-ias-auth-setup.md` |
| Outbound live proof status | `docs/operations/per-user-spike-notes.md`, `docs/operations/live-chain-runbook.md` |
| Research details and dead ends | `docs/research/2026-06-30-per-user-outbound-auth.md` |
| Tool design and MCP spec evidence | `docs/research/2026-06-30-mcp-best-practices.md` |

## 3. Mental Model

The server has four independent concerns:

1. **MCP transport and inbound authentication.** `src/server.ts` creates a stateless streamable HTTP MCP server.
   Current XSUAA/API-key auth uses `@arc-mcp/xsuaa-auth`. The IAS branch mounts an OAuth proxy and verifies sealed
   MCP tokens.
2. **Server-side safety ceiling.** `src/policy.ts` maps `Tool.action` to required scope, operation type, and write
   target. `src/safety.ts` enforces read-only-by-default, deny patterns, per-user scope narrowing, and fail-closed
   target allowlists.
3. **Outbound identity and backend clients.** `src/btp.ts` is the REST client layer. Token providers live under
   `src/auth/`. Shared mode uses CIS `client_credentials` and optional `CF_TOKEN`; per-user mode uses IAS exchange
   modules.
4. **Tool surface.** `src/tools.ts` defines what the LLM sees. `visibleTools` prunes unavailable or unauthorized
   actions before they ever reach the model.

The security invariant is:

```text
MCP scope gate AND server safety gate AND SAP/CF authorization must all allow the operation.
```

Do not treat MCP scopes as the authoritative BTP/CF authorization. They are defense in depth and LLM-surface control.

## 4. Live-Proven Facts

These are not guesses:

- `@arc-mcp/xsuaa-auth` works as the PoC inbound URL-login and API-key layer.
- A CIS `client_credentials` token works only when the CIS instance is created at subaccount level through Service
  Manager / BTP CLI / cockpit "Other environment". A `cf create-service cis ...` instance produces the wrong grant
  shape for headless `client_credentials`.
- A CIS local key is subaccount-scoped. It cannot roam across global accounts or subaccounts.
- CF Cloud Controller is not authorized by the CIS key. CF needs a CF UAA token, either shared technical or per-user.
- Per-user CF works through IAS id token -> IAS app-to-app exchange -> CF UAA jwt-bearer -> Cloud Controller.
- Per-user BTP account ops work through the BTP CLI Server using a JWT login, not through CIS REST.
- CIS REST per-user is not a viable primary path; keep it shared-technical fallback only.
- The BTP CLI binary can prove a path, but production should implement the CLI Server REST protocol for the scoped
  actions we expose.
- Empty tool lists after OAuth login usually mean "valid token, zero MCP scopes", not a broken MCP server.

## 5. Important Landmines

| Landmine | Why it matters | What to do |
|---|---|---|
| `cf create-service cis` for client credentials | CF/Kyma environment instances do not create the needed headless key | Create CIS via Service Manager / BTP CLI with `grantType: clientCredentials` |
| Local CIS vs central CIS | Local plan can read provisioning environments; central account APIs may reject it | Surface actionable errors; use central plan for global-account reads |
| BTP CLI session state | Human `btp login` stores session in secure store and can target many GAs | Do not depend on local human CLI state in server code |
| Global-account switching | One credential has one scope | Use one deployment or credential registry per GA; never accept arbitrary GA args |
| XSUAA no-scope login | OAuth succeeds but role collection missing or wrong IdP origin | Keep `whoami` visible and explain role collection/origin |
| IAS platform origin | Per-user CF/BTP roles apply to the IAS platform-origin shadow user | Assign least-privilege roles under the platform origin |
| DCR/consent | DCR plus one static upstream IAS client may trigger confused-deputy concerns | Prefer pre-registration for production; dev-only DCR must stay constrained |
| Historic chat secrets | The creation chat included deploy-time secrets/API keys | Never copy old keys into docs; rotate any key that appeared in a transcript |

## 6. How To Improve Tools Safely

The planned tool work is not "add many actions to the two current tools." It is:

1. Add a single-source action registry before growing the action count.
2. Split reads from writes at the tool level so `readOnlyHint` and client behavior are honest.
3. Move current reads into `CFInspect` and `BTPInspect`.
4. Move writes into pure-write tools such as `CFApps`, `CFServices`, `BTPServices`, and `BTPSecurity`.
5. Add target taxonomy before high-blast-radius writes: `directory`, `global-account`, `foundation` / `global`.
6. Keep `BTPSecurity` and CF platform writes at `admin`, not generic `write`.
7. Resolve write targets server-side where possible, then call `requireTarget` on the resolved value.

Do not rely on tool annotations for security. They help clients and models; the policy and safety gates are the
boundary.

## 7. Current Test Expectations

Run these after code changes:

```bash
npm test
npm run typecheck
npm run build
```

For live checks:

```bash
MCP_URL=https://.../mcp MCP_KEY=... node test/smoke.mjs
LIVE_CHAIN=1 ... npm test -- test/live-chain.integration.test.ts
```

Live tests require real tenant credentials and should skip cleanly when env vars are absent.

## 8. Safe Defaults For Future Agents

- Preserve fail-closed behavior. If no auth is configured, the server must refuse to start unless `ALLOW_OPEN=true`.
- Keep writes invisible and refused unless both the caller scope and `ALLOW_WRITES=true` allow them.
- Validate path and query inputs before constructing backend URLs.
- Never log or return backend response bodies that may contain tokens or internal details.
- Keep `whoami` honest about scopes and identity mode.
- Prefer REST APIs used by the CLIs; use the BTP CLI binary only for constrained spikes.
- Treat shared CIS fallback as explicitly shared-technical in descriptions and results.
- Keep docs updated when changing architecture. Future LLMs will follow the docs more than memory.
