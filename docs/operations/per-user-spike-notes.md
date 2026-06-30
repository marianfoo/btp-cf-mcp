# Per-user spike — status & next increments

The make-or-break path (plan §4): **pre-registered client → IAS login → server-issued MCP bearer (aud=server) → sealed IAS credential → exchange → (a) Cloud Controller call AND (b) `btp` CLI-Server read, each as the constrained user.**

## Built (tested, committed)
- **`src/auth/sealed-credential.ts`** (ADR-009) — seal/unseal the IAS credential into a JWE keyed by one server secret. Stateless + multi-instance by construction (any instance unseals); the client holds only opaque ciphertext (not passthrough). `test/auth.test.ts`: roundtrip + tamper + wrong-key + expiry all covered.
- **`src/auth/ias-exchange.ts`** (ADR-002) — the live-proven app-to-app exchange (`grant_type=jwt-bearer`, `resource=urn:sap:identity:application:provider:clientid:<id>`, confidential client) as REST. **Validates the token was actually re-audienced** (decode + assert `aud`) before returning — catches the "200 but aud unchanged" misconfig at the exchange, not opaquely at `cf auth`.
- **`src/auth/cf-token.ts`** — CF leg: exchange the re-audienced assertion at CF's UAA (jwt-bearer, public `cf` client) → CF access token. Request-shape tested; exact grant params live-verified in the run.
- **`src/auth/btp-cli.ts`** (ADR-004) — hardened `btp` wrapper: isolated `HOME` + `BTP_CLIENTCONFIG` per call, timeout, JWT redaction. Pure cores (`buildLoginArgs`, `redactJwt`) tested; the exec is live-verified. *(Superseded for BTPAccount reads by the binary-free REST client below.)*
- **`src/auth/btpcli-http.ts`** — the BTP account leg as **REST** (the `btp` CLI **server** protocol, no binary in the container): `btpcliLogin` (jwt → `X-Cpcli-Sessionid`) + `btpcliCommand` (`POST /command/<ver>/<cmd>?<action>`, backend status tunneled in `X-Cpcli-Backend-Status`). Reverse-engineered from the terraform-provider-btp Go client + a live `btp --verbose` capture. `test/btpcli-http.test.ts` covers login/command/error mapping. Routed by `runBtpPerUser` in `src/handlers.ts`, gated on `BTP_GA_SUBDOMAIN`.

## Status
1. ✅ **Outbound — built + LIVE-PROVEN** (cf-token.ts + btp-cli.ts). The full chain ran end-to-end against the tenant for a constrained user (2026-06-30): CF leg = Cloud Controller `/v3/apps` 200 (4 apps); BTP leg = `btp list accounts/subaccount` — both as the user. CF-UAA params worked first try. **Keychain fix:** `btp --config <file> set config --login.securestore false` (isolated HOME has no macOS Keychain → `errSecNoSuchKeychain` otherwise). `get accounts/subaccount` needs an `[ID]`; use `list`.
2. ✅ **Inbound OAuth proxy — BUILT + DEPLOYED** (ADR-007). `src/auth/ias-oauth-provider.ts` (`IasProxyOAuthProvider` + `mcpAuthRouter`): `/register` (DCR), `/authorize`→IAS→`/oauth/callback`, `/token` returns the **sealed JWE** (which *is* the MCP access token — never a passthrough); `requireBearerAuth` audience-validates every inbound bearer. Live on BTP CF: the MCP Inspector logs in via IAS and calls CF/BTP as the user. *(Spike used DCR, not pre-registration, so the Inspector works out of the box.)*
3. ✅ **BTPAccount per-user — LIVE on a FREE subaccount** via `btpcli-http.ts` + `runBtpPerUser` (2026-07-01). `subaccount get`, `environment-instance list`, `subaccount list`, and GA-level `entitlements` — all as the user. Entitlements needs **Global Account Viewer** on the platform shadow user (subaccount-scoped entitlements needs a subaccount role, not wired). See [../guides/per-user-ias-auth-setup.md](../guides/per-user-ias-auth-setup.md) §6.1.

## Shipped since (pre-publish hardening, 2026-07-01)
- ✅ **Per-authorization consent gate** (cookie-bound, non-bypassable) — the confused-deputy blocker.
- ✅ Session cache · sealing-key rotation (`SEALING_SECRET_PREVIOUS`) · refresh-token rotation · subaccount-scoped entitlements · MTA descriptor.

## Next increments (still open)
- IAS-groups→scopes (live-unverifiable until IAS emits groups); single-source action registry + the ≤12-tool buildout (product-scope expansion, drive from use cases); cert-based technical user (when ROPC is unavailable); real writes.

## Live-run recipe (reuses the proven manual flow — see [../guides/per-user-ias-auth-setup.md](../guides/per-user-ias-auth-setup.md))
Env: `IAS_TOKEN_URL={ias}/oauth2/token`, `IAS_CLIENT_ID`/`IAS_CLIENT_SECRET` (our confidential OIDC app), `CF_PLATFORM_CLIENT_ID=306ee77d-68d9-4398-ac62-1d07872563f9`, `SEALING_SECRET`. The IAS app + `user_name`=Email attribute + the `btp-platform` dependency are already configured on tenant `aejz2oiae`.
