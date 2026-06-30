# Inbound IAS OAuth Proxy — Detailed Plan (ADR-007/009/017)

> **Status (this is the design record):** SHIPPED + live-verified — the OAuth proxy, sealed-JWE token,
> the **per-authorization consent gate** (cookie-bound, non-bypassable), refresh-token rotation, and
> sealing-key rotation are all implemented. This doc keeps the original planning/decisions; for current
> behavior see the [guides](../guides/admin-deployment.md). (The "consent gate = increment 2 / deferred"
> notes below are historical.)

**Goal of the first increment:** an MCP client (Inspector/Claude) discovers the server's OAuth metadata, logs the user in **via IAS**, and a CF read tool then runs **as that IAS user** — closing the loop from the proven outbound chain to a real inbound login.

> Backed by a 3-agent study (library reuse, the 2025-11-25 MCP OAuth-proxy spec, integration). Reuses the **live-proven** outbound chain verbatim.

> **✅ Codex plan review (folded):** **R2 RESOLVED — buildable.** SDK `/token` returns the provider's tokens verbatim; `requireBearerAuth` uses *our* verifier (no SDK introspection); `AuthInfo.extra` is a supported seam. Corrections applied: (1) the provider overrides **both `authorize()` and `exchangeAuthorizationCode()`** — base `ProxyOAuthServerProvider.authorize()` forwards the *client's* id/redirect upstream, but IAS needs the server's IAS client-id + `/oauth/callback`; **refresh/revoke omitted for the spike** (AS metadata still advertises `refresh_token` — accepted limitation). (2) `unsealCredential` also returns **`exp`** (`requireBearerAuth` rejects a token with no numeric `expiresAt`). (3) **D-a → pre-registration for increment 1** (a public `/register` = unauthenticated DCR is no barrier; pre-reg avoids the confused-deputy MUST entirely). (4) tool-pruning must treat CF as available when **IAS per-user config** is present, not only a shared `clients.cf`.

## 1. Architecture — the double-OAuth proxy
The server is **both** an OAuth 2.1 Resource Server **and** its own Authorization Server, proxying to IAS. Two token flows, never the same token (the "no passthrough" point):

```
MCP client ──OAuth(PKCE_C, state_C)──▶ [server /authorize] ──OAuth(PKCE_S, state_S)──▶ IAS /oauth2/authorize
                                              ◀── /callback ◀── IAS code
   server exchanges IAS code → IAS id_token, SEALS it into a JWE (aud = THIS server) = the MCP access token
MCP client ◀── /token (MCP_AT = sealed JWE) ──┘
MCP client ──Bearer MCP_AT──▶ [/mcp] → unseal → {sub, iasCredential} → per-user exchange → CF/BTP AS THE USER
```

**Token audience invariant (load-bearing):** `MCP_AT.aud == this server` (NOT IAS). The server never accepts an IAS token at `/mcp` and never forwards the MCP token to IAS/SAP.

## 2. Reuse vs build (from the library inventory — ~75% reuse)
**Reuse as-is** (`@arc-mcp/xsuaa-auth`, upstream-agnostic, carries the 2026-06 security hardening): `StatelessDcrClientStore` (DCR `/register`, no DB), `OAuthStateCodec` (signed state), `createOAuthCallbackHandler` (`/oauth/callback` + redirect binding-check), `matchesRedirectPattern`/`validateRedirectUri` (SSRF-safe), `createChainedTokenVerifier`, `createApiKeyVerifier`, `resolveAppUrl`, `noopLogger`, types. From the **MCP SDK** directly: `mcpAuthRouter`, `requireBearerAuth`, `ProxyOAuthServerProvider`.

**Build (small):** `IasProxyOAuthProvider` (subclass of the SDK's `ProxyOAuthServerProvider`; IAS `/oauth2/*` endpoints + `exchangeAuthorizationCode` seals the id_token), `sealedJweVerifier`, `IasUserTokenProvider`, `loadIas()` config, the thin wiring (replacing the XSUAA branch). **Drop:** `setupHttpAuth`'s XSUAA path, `loadXsuaaCredentials`, `createXsuaaOAuthProvider`.

**Unchanged (reused verbatim):** `ias-exchange.ts`, `cf-token.ts`, `btp-cli.ts` — the proven outbound chain.

## 3. The `sealed-credential.ts` change (finalize the ADR-009 token model)
```ts
interface SealedClaims { iasCredential: string; sub: string; scopes: string[]; exp: number; }   // + scopes + exp
sealCredential(claims: {iasCredential; sub; scopes}, key, opts: { audience: string; ttl?: string }): Promise<string>  // setAudience
unsealCredential(sealed, key, expectedAudience): Promise<SealedClaims>  // jwtDecrypt({audience}) validates aud+exp; returns exp; fail-closed if scopes not string[]
```
`aud` is a seal *option* (the server's resource id), `scopes` is a per-user *claim*. This is the smallest change satisfying "carry aud + scopes + aud-validation." Breaks the current 2-arg callers → update `test/auth.test.ts` + `test/live-chain.integration.test.ts` (pass an `audience`).

## 4. File-by-file changes
| File | Change |
|---|---|
| `src/auth/sealed-credential.ts` | +`scopes`; seal opts `{audience, ttl?}` + `setAudience`; unseal `(…, expectedAudience)` via `jwtDecrypt({audience})`. |
| `src/auth/sealed-verifier.ts` | **New.** `createSealedJweVerifier(key, audience): Verifier` → unseal → `AuthInfo{clientId:sub, scopes, expiresAt(from exp), extra:{sub, iasCredential}}`. |
| `src/auth/ias-oauth-provider.ts` | **New.** `IasProxyOAuthProvider extends ProxyOAuthServerProvider` + `createIasOAuthProvider(iasCfg, appUrl, sealKey)` → `{provider, clientStore, stateCodec}`; `exchangeAuthorizationCode` seals the IAS id_token. |
| `src/auth/token-provider.ts` | **Add** `IasUserTokenProvider` (wraps `exchangeForProvider`→`cfTokenFromAssertion`). |
| `src/config.ts` | `IasConfig` (issuer/clientId/clientSecret/providerClientId/cfUaaTokenUrl/audience) + `sealingSecret`; `loadIas()` mirroring `loadCis()`. |
| `src/server.ts` | `startHttp`: mount `mcpAuthRouter(provider)` + `/oauth/callback` + `requireBearerAuth({verifier: sealed-JWE→api-key chain})` in place of the XSUAA branch. CallTool handler: read `extra.authInfo.extra` → pass to `dispatch`. |
| `src/handlers.ts` | `dispatch(…, ias?)`: when present, build a per-user `CfClient(cfApi, new IasUserTokenProvider(...))` for the call. |
| `src/index.ts` | Drop the XSUAA wiring; build `sealKey`; keep the api-key→shared-client fallback. |
| `ias-exchange/cf-token/btp-cli.ts` | **No change.** |

## 5. Decisions for the first increment (your call where flagged)
- **D-a — Registration + the consent gate ⚠️:** The spec makes a **per-client consent screen a MUST** when DCR + a static upstream client_id are combined (confused-deputy). Options: **(i)** use the library's DCR store **without** a consent gate for the **internal dev spike only** (the Inspector works immediately; the confused-deputy attack needs an attacker registering clients, which a dev-only instance doesn't expose) — and treat the consent gate as a **deferred MUST before any untrusted exposure**; **(ii)** pre-registration only (no DCR → no consent obligation, but you hand-configure each client). **Decision (per Codex): pre-registration for increment 1** — a config-listed `client_id`+redirect_uri, no DCR, so the confused-deputy obligation never arises. DCR + the per-client consent gate = increment 2. Keep the spike internal + a constrained user + `ALLOW_WRITES=false` regardless. 
- **D-b — Seal the id_token only** (not refresh): re-auth on expiry (short JWE TTL). Refresh-token sealing is a later `iasCredential` swap (no signature change). 
- **D-c — Fixed scope set** for now (`['read']`, or `['read','write']` gated by `ALLOW_WRITES`); IAS-groups→scopes deferred (the `scopes` claim already rides the seal). 
- **D-d — CF per-user first**; BTP-account tools stay on the shared CIS client for increment 1 (CF is pure REST — no `btp` binary / keychain in the request path). 
- **D-e — XSUAA inbound dropped; API-key path kept** (falls back to the shared `clients.cf`, so `whoami`/headless still work with no IAS round-trip).

## 6. Security MUSTs — in increment 1 vs deferred
**Satisfied in increment 1** (mostly free via the SDK proxy + library): PKCE on both legs (S256), `code_challenge_methods_supported:["S256"]` in AS metadata, **audience-bound MCP token** (the seal) + `aud==server` validation on every inbound bearer, **no token passthrough** (by construction — IAS token sealed server-side, never returned), exact-match redirect-uri (library), signed single-use state (library), HTTPS, drop the `org` etc.
**Deferred (flagged — close before production exposure):** ⚠️ **per-client consent gate** (confused-deputy MUST, D-a), refresh-token rotation, IAS-groups→scopes + scope step-up (403 challenge), multi-instance revocation/deny-list (short TTL is the interim story).

## 7. Sub-increments (each gated + tested)
1. **Token core (no network):** the `sealed-credential.ts` change + `sealedJweVerifier` + `IasUserTokenProvider` + unit tests (seal/unseal with aud, verifier→AuthInfo, provider chaining with mocked exchange). Update the 2 existing callers.
2. **The proxy + wiring:** `IasProxyOAuthProvider` + `loadIas()` + `server.ts`/`index.ts` swap; `mcpAuthRouter` mounts; gate green; `whoami` shows the IAS identity.
3. **Live test:** MCP Inspector (or a script) → discover → DCR → IAS login → `/token` → sealed JWE → `CloudFoundry.orgs` runs as the user. (Same live-debug loop as the outbound chain.)

## 8. Risks
- **R1 ⚠️:** the deferred consent gate is a real spec MUST — acceptable only because the spike is dev-only; must land before exposing the AS to untrusted clients.
- **R2:** the `ProxyOAuthServerProvider.exchangeAuthorizationCode` contract — confirm the SDK lets the override return a custom (sealed-JWE) `access_token` cleanly, and that `requireBearerAuth`/`mcpAuthRouter` don't assume an introspectable upstream token.
- **R3:** id_token TTL (~minutes) bounds the MCP session in increment 1 (D-b) — fine for the proof, needs refresh for real use.
- **R4:** IAS app must register the server's `/oauth/callback` redirect URI (deploy-time prereq, like the localhost one for `get-id-token.mjs`).
