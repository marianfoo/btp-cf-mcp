# Creation Chat Dossier

This dossier summarizes the original Claude creation chat that produced the first `btp-cf-mcp` PoC and the
operational lessons learned during that session. It intentionally avoids copying secrets from the transcript.

## 1. Original User Goal

The user wanted to know whether a BTP/CF MCP server could work like `arc-1`:

- deploy the server on BTP Cloud Foundry;
- log in from an MCP URL once;
- manage BTP and Cloud Foundry with as little relogin as possible;
- restrict access like `arc-1`, read-only by default;
- prevent the AI from writing to the wrong global account, subaccount, org, or space;
- understand whether BTP/CF CLI browser login could be translated into server-side auth;
- use service credentials for the PoC, but keep personal "acts as you" as the primary end goal.

The requested implementation flow was: research, spike blockers, plan, build a PoC in `~/DEV/btp-cf-mcp`, test,
run a Codex review, apply important review findings, deploy, and provide test instructions.

## 2. Early CLI Research

The first live checks inspected the user's existing `cf` and `btp` CLI state.

Findings:

- `cf oauth-token` returned a usable bearer. A direct Cloud Controller `GET /v3/organizations` with that token worked.
- The CF token was a short-lived user token from CF UAA.
- The BTP CLI behaved differently: `btp target` opened an interactive target menu, and session state lived in the
  local OS secure store rather than in a reusable exported bearer.
- BTP CLI targeting supports global-account/subaccount switching for a human session, but that is not a server model.

The early conclusion was correct for the PoC but incomplete for the final architecture:

```text
PoC: do not wrap logged-in human CLIs; use service credentials and REST APIs.
Final target: per-user CF/BTP is possible, but it requires IAS-first inbound and token exchange.
```

## 3. PoC Architecture That Was Chosen

The PoC deliberately used shared technical outbound credentials:

- inbound: `@arc-mcp/xsuaa-auth` URL login plus API key;
- outbound BTP: CIS REST with `client_credentials`;
- outbound CF: optional configured CF bearer;
- safety: arc-1-style scope gate, read-only default, deny list, and write-target allowlists.

This matched the user's request to start with service credentials while preserving a `TokenProvider` seam for later
per-user identity.

## 4. CIS Client-Credentials Spike

This was the biggest early landmine.

What failed:

- A CIS instance created through Cloud Foundry did not work for headless `client_credentials`.
- The resulting key had the wrong grant behavior for the desired headless PoC path.
- Calls returned errors such as XSUAA communication failures instead of clean BTP reads.

What worked:

- Creating the CIS instance at subaccount level through Service Manager / BTP CLI / cockpit "Other environment" with
  `grantType: clientCredentials`.
- The resulting token was accepted by provisioning endpoints such as `/provisioning/v1/environments`.

The durable lesson:

```text
For headless shared-technical CIS REST, do not create the CIS key via `cf create-service`.
Create it through Service Manager / BTP CLI at subaccount level.
```

For current docs, this is captured in `docs/guides/admin-deployment.md` and the research notes.

## 5. PoC Implementation

The first implementation created the current repo shape:

- `src/config.ts` for env/VCAP config;
- `src/auth/token-provider.ts` and `src/btp.ts` for token minting and REST clients;
- `src/policy.ts` and `src/safety.ts` for the arc-1-style safety ceiling;
- `src/tools.ts` and `src/handlers.ts` for `CloudFoundry` and `BTPAccount`;
- `src/server.ts` for MCP HTTP transport and auth;
- `test/smoke.mjs` for live MCP smoke testing;
- unit tests for safety behavior.

Local smoke verified:

- `/health` worked;
- unauthenticated `/mcp` returned 401;
- API-key `tools/list` returned visible tools;
- `BTPAccount.environments` returned real CIS data;
- a write call was blocked because `ALLOW_WRITES=false`.

## 6. Codex Review And Fixes

The user requested a Codex review of both the code and idea. The review found real trust-boundary problems.

Important fixes from that review:

- omitted write targets no longer bypass the allowlist;
- auth fails closed when no auth method is configured;
- user-controlled path/query inputs are GUID-validated before backend URL construction;
- backend response bodies are not leaked to MCP clients;
- token refresh is single-flight;
- tool listing prunes by scope, write gate, deny list, and backend availability;
- `/health` no longer discloses backend/auth details.

These are security invariants, not cosmetic PoC cleanup. Do not regress them.

## 7. Deployment And Inspector Debugging

The first deployment ran at a BTP CF route and was tested remotely:

- `/health` returned OK;
- OAuth metadata was reachable;
- unauthenticated `/mcp` returned 401;
- API-key smoke returned the BTP tool and live data;
- writes stayed blocked.

The first MCP Inspector issue was not a backend failure. Inspector was sending a stale invalid bearer token, so the
server correctly returned `invalid_token`. Clearing the bearer field or pasting the API key fixed that path.

The second Inspector issue was "no tools" after OAuth login. That was also correct behavior:

- the user had authenticated successfully;
- the XSUAA token had no `read` / `write` / `admin` app scope;
- fail-closed tool pruning hid all tools.

That experience directly motivated the always-visible `whoami` diagnostic in `src/server.ts`.

## 8. Later Corrections To The Early PoC Assumptions

The creation chat ended before the deeper per-user research finished. Current repo docs now supersede several early
assumptions.

Corrected facts:

- Personal "acts as you" cannot be achieved by reusing the XSUAA inbound token directly.
- Per-user outbound requires an IAS id token. XSUAA -> IAS exchange is not the viable direction.
- Therefore the target inbound architecture is IAS-first, not XSUAA-first.
- CF per-user is live-proven through IAS app-to-app exchange and CF UAA jwt-bearer auth.
- BTP account ops per-user are live-proven through the BTP CLI Server JWT login path.
- CIS REST remains shared-technical fallback. It must not be described as per-user.
- The target tool surface is no longer two broad tools. ADR-016 chooses resource-split read/write tools.

When this dossier conflicts with `docs/architecture/implementation-plan.md`, the implementation plan wins.

## 9. Decisions That Carried Forward

These decisions survived later research:

- Reuse `@arc-mcp/xsuaa-auth` patterns where useful.
- Keep `ALLOW_WRITES=false` as the default.
- Keep per-action server-side policy even when SAP enforces real authz.
- Use fail-closed target allowlists for writes.
- Make outbound identity pluggable instead of baking in shared credentials.
- Do not trust LLM-provided target names for writes.
- One credential cannot safely roam across global accounts.
- Prefer REST protocols behind the CLIs over shelling out to CLI binaries in production.

## 10. Decisions That Changed

| Early PoC assumption | Current corrected direction |
|---|---|
| XSUAA inbound can remain the primary per-user basis | IAS-first inbound is required for per-user CF/BTP |
| CIS `user_token` might be the natural per-user path | CIS REST per-user is not viable as primary path |
| BTP account ops can stay CIS shared if pragmatic | Decided scope is per-user BTP via CLI Server |
| Two intent tools are enough for now | Move to <=12 resource-split tools with read/write split |
| DCR is likely required | Prefer pre-registration first; DCR is optional and riskier |

## 11. Secret Handling Note

The historical chat included concrete deploy-time credentials and API keys. Treat anything from that chat as exposed.

Rules for agents:

- never copy historical keys into docs or tests;
- use placeholders in examples;
- rotate any key that appeared in a shared transcript;
- do not log tokens, assertions, refresh tokens, or raw backend error bodies.

## 12. Where To Continue

Recommended order for future implementation:

1. Stabilize the single-source tool/action registry.
2. Split current tools into the ADR-016 tool surface.
3. Finish IAS-first inbound compliance gaps: pre-registration, PRM, Origin/protocol-version checks, and tests.
4. Wire per-user CF as the default when IAS credential is present.
5. Implement BTP CLI Server REST for the scoped `BTP*` actions.
6. Keep CIS fallback explicit, disabled or clearly labelled in "acts as you" deployments.
