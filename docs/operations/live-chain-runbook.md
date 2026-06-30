# Live-run plan — prove the per-user outbound chain end-to-end

**Goal.** Prove, against the real tenant with one deliberately-constrained user, that the four spike modules compose into a working per-user chain:

```
seal(id_token) → unseal → IAS exchange → cf-token → Cloud Controller call  AS THE USER
                                       └→ btp login → btp read              AS THE USER
```

The **inbound MCP OAuth proxy** (PRM / `/authorize` / `/callback`) is a **separate later increment** — its mechanism is standard OAuth auth-code; the SAP-specific, day-to-find risk all lives in this *outbound* chain, so that is what the live run de-risks.

## Decision: what gets sealed (ponytail / YAGNI)
Seal the **IAS `id_token`**, not the refresh token. It is fresh (~30 min) — enough for a session-length proof — and removes a refresh round-trip. **Production increment (flagged, not built):** seal the refresh token + add a tiny `ias-refresh.ts` (`refresh_token` → fresh `id_token`) before the exchange, for long sessions. The `sealed-credential` field is already generically named `iasCredential`, so no module changes are needed to switch later.

## The harness (one file, glue only)
A single **gated integration test** `test/live-chain.integration.test.ts` that composes the *existing* modules against the real env and **skips cleanly without creds** (`describe.skipIf`, never a hard fail in `npm test`):

1. **Input (env):** `USER_ID_TOKEN` (a fresh user IAS id_token — see prerequisite), `SEALING_SECRET`, `IAS_TOKEN_URL`, `IAS_CLIENT_ID`/`IAS_CLIENT_SECRET`, `CF_PLATFORM_CLIENT_ID`, `CF_UAA_URL`, `CF_API`, `BTP_SUBDOMAIN`, `BTP_IDP`. A `required()` helper throws if you opted in (`LIVE_CHAIN=1`) but missed one.
2. **Custody roundtrip:** `sealCredential` → `unsealCredential` with the *real* token (proves ADR-009 against real data).
3. **Exchange (ADR-002):** `exchangeForProvider(idToken)` → re-audienced assertion (proves the exchange + the re-audiencing validation live).
4. **CF leg:** `cfTokenFromAssertion` → CF token → `GET {CF_API}/v3/apps?per_page=3` with `Authorization: Bearer` → assert **200** + a `resources` array (proves the CF leg + per-user authz; logs the count).
5. **BTP leg:** `btpLoginAndRun(['get','accounts/subaccount'], { jwt: assertion, … })` → assert it names the user's subaccount (proves the CLI-Server leg).
6. Each step logs PASS to **stderr** only; **no secret is ever logged**.

The legs run **in order** so a failure localises (exchange → cf-token → CC → btp); live param issues (CF-UAA grant params, `btp` argv) get fixed per leg as they surface — that is the point of the run.

## Live-execution prerequisite (honest)
A fresh USER id_token requires a **browser login** — headless IAS login is impossible (issue #301). So the live green run needs the operator to either (a) run the IAS auth-code login and paste the `id_token` into `USER_ID_TOKEN`, or (b) supply a cached one. The harness + its assertions are built and reviewed now; the green run happens when a token is supplied. Until then `npm test` skips it.

## Ponytail principles (apply to ALL code — past + future)
- **Reuse the four modules verbatim** — the harness is linear glue, zero new abstractions.
- **Gate with `describe.skipIf`** — no new test framework, no skip-policy helper yet (add only if a second live test appears).
- **Seal the id_token** (skip refresh) — YAGNI for a proof.
- **No re-architecting on live failures** — fix the live param, not the design.
- The four modules already follow this (single-purpose functions, `jose` reused, no speculative config).

## Self-review (caveats to verify in the run)
- **CF-UAA grant params unverified** (`response_type=token`, `client_id=cf`, jwt-bearer) — the run is precisely what tests them; if the CC call ≠ 200, fix the params on the cf-token leg, not the design.
- **BTP leg reuses the SAME exchanged assertion** (aud = CF-platform `306ee77d`) for `btp login`, as proven manually. If `btp` rejects it (needs a different provider audience), add a second `exchangeForProvider` with the BTP provider id — verify live.
- **Host needs the `btp` binary** + network reach to CF UAA / CC. The test is gated, so its absence only skips.
- **No new revocation/refresh** in this run (id_token TTL bounds the session) — by design.

## Acceptance
**Chain plumbing (always):** CC `/v3/apps` returns **200** (the per-user CF token is *accepted*) **and** `btp get accounts/subaccount` returns the user's subaccount — both driven only by a sealed id_token. **Per-user authz (only when `EXPECTED_APP` is set):** the named app the user is entitled to appears in `/v3/apps` — because a 200 with an empty list proves *acceptance*, not *scoped roles* (the role loop was separately proven manually). That is the make-or-break per-user proof (outbound). Inbound proxy follows.
