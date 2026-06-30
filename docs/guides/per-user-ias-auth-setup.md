# Per-User "Acts As You" Auth for Cloud Foundry + BTP Account Ops — Admin Setup Guide

**Status:** ✅ CF proven end-to-end 2026-06-30; BTP account ops (CLI-server REST, free-tier) live-verified 2026-07-01 · **Audience:** BTP / IAS administrators
**What it achieves:** a deployed server (e.g. an MCP server) where a user logs in **once** (OIDC) and the server then calls the **Cloud Foundry Cloud Controller API _as that user_** — the user's own CF org/space roles are enforced, audit shows the real human — with **no second login** and **no shared technical credential**.

> Research backstory and the dead-ends we ruled out: [../research/2026-06-30-per-user-outbound-auth.md](../research/2026-06-30-per-user-outbound-auth.md). This guide is the distilled, working recipe.

---

## 1. What works and what doesn't (set expectations)

| Backend | Per-user "acts as you"? | Mechanism |
|---|---|---|
| **Cloud Foundry** (apps/spaces/services/orgs) | ✅ **Yes** | IAS-first login → IAS app-to-app token exchange → `cf auth --assertion` |
| **BTP account ops** (subaccount/environments/entitlements) | ✅ **Yes (live, free-tier)** | Same exchange → **btp CLI *server* protocol over HTTPS** (`src/auth/btpcli-http.ts`, no binary). `subaccount`/`environments` need no extra role; `entitlements` (GA-level) needs **Global Account Viewer** on the platform user (§6.1) |
| **CIS REST APIs** | ❌ **No** (platform limitation) | Stays shared-technical (`client_credentials`). Per-user CIS REST is not supported by SAP — proven dead. |

---

> **Not per-user?** For headless/automation callers you can instead use a **shared read-only technical
> user** for BTP account reads (one service account + two Viewer roles, API-key inbound). Both models can run
> on the same instance. See [admin-deployment.md](admin-deployment.md) → "Identity models" + §6a.

## 2. The model — IAS-first, then app-to-app principal propagation

```
 User ──OIDC login──▶ [Your app's IAS OIDC application]  (origin in IAS)
                              │  user id_token (aud = your app, carries user_name)
                              ▼
        POST {ias}/oauth2/token   grant_type=jwt-bearer
              assertion=<user id_token>   Basic <yourClientId:secret>
              resource=urn:sap:identity:application:provider:clientid:<CF-PLATFORM-CLIENT-ID>
                              │  exchanged token (aud = CF platform app, carries the user)
                              ▼
        cf auth <cfClient> "" --assertion <exchanged token>   (CF CLI ≥ 8.12)
                              │
                              ▼
        Cloud Controller session AS THE USER (origin = the IAS platform origin)
```

Two facts that make this work and were the hard-won discoveries:
- The **CF platform UAA already trusts your IAS tenant** (the `…-platform` trust), so the assertion's *issuer* is fine — the only requirements are the right **audience** and the right **username claim**.
- IAS will only mint a token audienced for another application via the **documented app-to-app flow** (the special `resource` URN), and only for a **confidential** client.

---

## 3. Prerequisites

- **IAS admin** on the tenant that is the BTP **platform** IdP (the one with origin ending `-platform`, e.g. `aejz2oiae.accounts.ondemand.com`).
- **`cf` CLI ≥ 8.12.0** (the `--assertion` flag shipped in v8.12 — "Allow CF Authentication based on Tokens").
- The **CF platform application's client ID** in IAS. How to find it:
  - In IAS → *Applications* there is a **Bundled** app named **"SAP Business Technology Platform"** (internal name `btp-platform`). Its **Client Authentication → Client ID** is the value you need (here it was `306ee77d-68d9-4398-ac62-1d07872563f9`). Its logout URIs are all `uaa.cf.*` / `*.cockpit.btp.cloud.sap` — that confirms it's the right one.
  - Or read it off the failure: `cf auth … --assertion <wrong-aud-token>` returns `Some parties were not in the token audience: <CF-PLATFORM-CLIENT-ID>`.

---

## 4. One-time IAS setup (the admin steps)

### 4.1 Create the OIDC application for your server (the *consumer*)
IAS → **Applications & Resources → Applications → Create** → **OpenID Connect** → name it (e.g. `my-server`).

### 4.2 OpenID Connect Configuration
- **Redirect URIs:** your server's login callback(s), e.g. `https://my-server.cfapps.<region>.hana.ondemand.com/oauth/callback` (+ `http://localhost:<port>/callback` for local testing).
- **Grant types:** enable **Authorization Code** + **Enforce PKCE (S256)**, **JWT Bearer**, and **Token Exchange (RFC 8693)**.
- **Access Token Format:** set to **JSON Web Token** (the exchange must emit a JWT). *(Advanced Settings.)*
- **Access / ID Token lifetime:** ≥ 15–30 min (so the minted token survives the exchange + `cf auth`).

### 4.3 Client Authentication (make it confidential)
- Under **Client Authentication**, leave **Enable Public Client Flows** ON (the browser login uses PKCE) **and** **Secrets → Add** a client secret (API Access: Application/OpenID). **Save the secret** — the *exchange* authenticates with it. A public-only client **cannot** mint another app's audience.

### 4.4 Attributes — add the username claim (critical)
IAS → app → **Trust → Attributes → Add**:
- **`user_name` = Email** (source *Identity Directory → Email*).
This is the claim the CF platform UAA maps to the CF username. Without it: `cf auth` fails with **"Unable to map claim to a username."** (The `Login Name` field is often blank — use **Email**.)

### 4.5 Dependency — consume the CF platform app (principal propagation)
IAS → app → **Application APIs → Dependencies → APIs → Add** → choose **"SAP Business Technology Platform"** → **"All APIs" / "Allow all APIs for principal propagation."**
This authorizes your app to obtain tokens audienced for the CF platform app on behalf of the user.

---

## 5. Runtime flow (what the server does)

### 5.1 Inbound — log the user in via this IAS app (OIDC auth-code + PKCE)
Standard OIDC: redirect to `{ias}/oauth2/authorize?response_type=code&client_id=<yourClientId>&redirect_uri=…&code_challenge=…&code_challenge_method=S256&scope=openid email profile groups`, exchange the `code` at `{ias}/oauth2/token`. You now hold the user's **id_token** (it carries `user_name`).

### 5.2 Outbound — app-to-app token exchange (confidential, server-side)
```bash
curl -s "$IAS/oauth2/token" -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' -H 'Accept: application/json' \
  -u "$YOUR_CLIENT_ID:$YOUR_CLIENT_SECRET" \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
  --data-urlencode "assertion=$USER_ID_TOKEN" \
  --data-urlencode 'resource=urn:sap:identity:application:provider:clientid:306ee77d-68d9-4398-ac62-1d07872563f9'
# → returns a token with aud=<CF-PLATFORM-CLIENT-ID> carrying the user (sub, mail, user_name, ias_apis:[principal-propagation])
```
The `resource` may also be `urn:sap:identity:application:provider:name:<dependencyName>` (the dependency's display name).

### 5.3 Hand the token to CF
```bash
cf api https://api.cf.<region>.hana.ondemand.com
cf auth cf "" --assertion "$EXCHANGED_TOKEN"      # CF CLI ≥ 8.12
cf oauth-token        # a USER token: user_name=<email>, origin=<ias-platform-origin>
```
Or call the Cloud Controller directly with the resulting CF bearer. Cache + refresh the CF token (it's short-lived); the IAS exchange can be re-run from a cached user id_token / refresh token.

---

## 6. Per-user authorization (roles) — REQUIRED to actually see resources

Authenticating ≠ authorization. The user is now mapped to the **IAS platform-origin shadow user** in CF. To act on real resources, that identity must hold CF roles:
- BTP cockpit → subaccount → **Cloud Foundry → Spaces / Org Members** → add the user (under the **IAS platform origin**, not the Default IdP) with the needed Space/Org role.
- `cf orgs` returning **"No orgs found"** is *correct* when the identity has no roles yet — it proves least-privilege is working.

**✅ Loop proven (2026-06-30):** before any role, the per-user token's `cf orgs` = "No orgs found". After `cf set-org-role marian@zeis.de "<org>" OrgManager --origin aejz2oiae-platform` + `cf set-space-role … SpaceDeveloper --origin aejz2oiae-platform` (assigned by an admin), the **same** per-user token returned `cf orgs` → the dev org and `cf apps` → the real apps (`arc1-2023`, `arc1-2025`, `btp-cf-mcp`, …). So **authentication (IAS login) + authorization (cockpit/CLI role under the IAS origin) compose exactly as expected** — the server acts as the user and sees precisely what that identity is granted, nothing more.

> ⚠️ **Identity origin matters** — see §8. The token's identity is the user under the **IAS platform origin**, which may be a *different shadow user* than the same email under the "Default identity provider."

---

### 6.1 BTP account-ops roles (the platform user again)

The BTP account leg maps to the **same platform shadow user** as CF (origin `<tenant>-platform`). Its reads
need these roles on that user:

| Read | Role needed | Assign as GA admin (`btp login --sso`, Default IdP) |
|---|---|---|
| `subaccount` detail, `environments` | *(none — works out of the box)* | — |
| `entitlements` (global-account catalog) | **Global Account Viewer** (read-only) | `btp assign security/role-collection "Global Account Viewer" --to-user <you> --of-idp <tenant>-platform` |

Find the exact platform origin key with `btp list security/trust --global-account`. Role changes take
**~1–2 min** to propagate. A 403 on `entitlements` before the role is assigned is expected.

> The **subaccount-scoped** entitlement view (`servicePlanAssignments`, provisioning) needs a
> *subaccount*-level role, not a GA one; the tool reads GA-wide instead (the canonical "what is this
> account entitled to" answer).

## 7. Troubleshooting (exact errors → fixes, from the live build)

| Symptom | Cause | Fix |
|---|---|---|
| `cf auth` → `Some parties were not in the token audience: <id>` | Token `aud` is your app, not the CF platform app | Use the **app-to-app exchange** with `resource=urn:sap:identity:application:provider:clientid:<id>` (§5.2) + the **Dependency** (§4.5) |
| `cf auth` → `Unable to map claim to a username` | Token lacks the username claim CF maps | Add **Attribute `user_name` = Email** (§4.4), re-mint |
| Exchange 200 but `aud` unchanged (still your app) | Wrong `resource` value (raw client id) or **public** client | Use the **URN** form + a **client secret** (confidential) (§4.3, §5.2) |
| Exchange → `Missing OIDC session, no user found` | jwt-bearer without the `resource` URN / no user assertion | Include the `resource` URN and a valid user id_token as `assertion` |
| IAS token-exchange (RFC 8693) only returns opaque/own-aud token | Wrong flow — exchange can't re-audience an id_token | Use the **jwt-bearer + resource URN** flow, not raw `grant_type=token-exchange` |
| Inbound login id_token missing `user_name` | Attribute not configured | §4.4 |
| CIS REST per-user attempts return scopeless token / 502 | **Not supported by SAP** | Keep CIS on shared `client_credentials` |
| `BTPInspect.entitlements` → **HTTP 403** (backend on `servicePlanAssignments`/`assignments`) | Platform user lacks a GA role | Assign **Global Account Viewer** under `<tenant>-platform` (§6.1); the tool reads GA-level, which that role covers |
| BTP CLI-server login 200 but commands **401** | Logged in via the raw id_token or wrong idp | Use the **exchanged** `aud=<cf-platform>` token as the login JWT (not the raw id_token); idp = the IAS issuer host |

---

## 8. Known limitations & the identity-origin caveat

- **CIS REST is not per-user** (platform limitation, proven). Use a shared technical `cis` `client_credentials` key + your own scope/safety gate.
- **BTP account ops (CLI Server)** run per-user via the CLI **server** protocol **reimplemented as REST** in `src/auth/btpcli-http.ts` — **no `btp` binary in the container**: `POST cli.btp.cloud.sap/login/<ver>` with `{customIdp, subdomain, jwt:<exchanged-token>}` → session id in the `X-Cpcli-Sessionid` header; then `POST /command/<ver>/<command>?<action>` with that session + `X-Cpcli-Subdomain` + `X-Cpcli-Customidp` (the real backend status is tunneled in `X-Cpcli-Backend-Status`). The login JWT is the **same `aud=<cf-platform>` exchanged token** as the CF leg — the CLI server trusts it. Live-verified on a **free** subaccount: `subaccount get`, `environment-instance list`, `subaccount list`. **`entitlements`** reads the **global-account** catalog and needs a GA role (§6.1); its subaccount-scoped variant (`servicePlanAssignments`) needs a subaccount-level role and is not wired. Enable this path with `BTP_GA_SUBDOMAIN=<ga-subdomain>`.
- **Identity origin:** the per-user token authenticates the user under the **IAS platform origin** (e.g. `…-platform`). If the same human also exists under the **"Default identity provider"** (SAP ID Service) with *different* role assignments, those are **two distinct shadow users**. The server acts as the **IAS** one — assign that identity the roles you want it to have, or point inbound login at whichever IdP carries the user's real authorizations. Decide this deliberately (it's also a useful least-privilege boundary: the "MCP identity" can be deliberately narrower than the human's primary admin identity).

---

## 9. Security notes

- The exchange uses a **confidential** client secret — store it as a bound secret / env, never in code.
- Validate the exchanged token's `iss`/`aud`/`exp` before use; never `id_token ?? access_token` blindly.
- The minted token is a real user credential — cache per `(user, audience)` with exp-aware refresh; do not log it.
- Per-user means **per-user authorization is enforced by SAP** (CF roles), in addition to your app's own scope/safety gate — defense in depth.
