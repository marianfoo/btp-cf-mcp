# btp-cf-mcp — Admin Setup Guide (BTP Cloud Foundry + IAS)

How to deploy and configure the btp-cf-mcp server on SAP BTP Cloud Foundry, wire up **per-user
"acts as you"** auth via IAS, connect MCP clients, and operate it. Modeled on the arc-1 deployment docs.

> **Status.** The **IAS-first per-user** mode is **shipped and running live**: a user logs in once via
> IAS, the server seals that credential into its own MCP token, and every CF / BTP-account call runs
> **as that human** (their real roles, real audit). Cloud Foundry and BTP **account** reads
> (`subaccount`, `environments`, `entitlements`) are per-user and live-verified on a **free-tier**
> subaccount. A **shared-technical** mode (XSUAA or API-key inbound + a shared CIS key) still exists as
> a fallback for setups without IAS — see §12.
>
> Still a PoC in one respect: writes (`create_service`/`delete_service`, CF lifecycle) are **inert** —
> they pass the safety gate but don't execute. The OAuth proxy's DCR is guarded by a signed,
> browser-bound **consent screen** (§11); for exposure to untrusted clients, also tighten the DCR
> redirect-URI allowlist.

---

## Identity models — per-user, technical user, or both

`BTPInspect` can run under either identity model, and **both at once** on the same instance:

| | **A) Per-user ("acts as you")** | **B) Shared read-only technical user** |
|---|---|---|
| Acts as | the **logged-in human** (their IAS identity) | one **service account** |
| Inbound auth | IAS OAuth login (the proxy) | anything — typically an **API key** |
| Audit shows | the real human | the technical user |
| Authorization | each user's own BTP roles (least-privilege per user) | the tech user's read-only roles (same for everyone) |
| Setup cost | IAS OIDC app + each user logs in | one user + two read-only roles |
| Best for | interactive use, per-user accountability | headless automation, a shared read-only view |

On one instance they **coexist**: a request that carries an IAS credential (OAuth login) runs **per-user**; a
request without one (API key) uses the **shared technical user**. Dispatcher precedence:
**per-user → technical user → shared-CIS fallback**. Set up per-user in §4–§6; add the technical user in §6a.
Both are **read-only** in this PoC.

## 1. When to use this

- You want an MCP server that manages **SAP BTP accounts** (subaccounts, entitlements, environments) and
  **Cloud Foundry** (apps, services, spaces) from Claude / VS Code / any MCP client — **as the logged-in
  user**, so audit shows the real human and SAP enforces their roles.
- You want **central admin control**: read-only by default, per-user scopes, a fail-closed target allowlist.
- One deployment = **one global account** (the CF-platform client id + GA subdomain are per-GA; N global
  accounts = N instances).

## 2. Architecture (IAS-first per-user)

```
                    ┌─ OAuth (the server is its OWN authorization server, proxying to IAS) ─┐
 MCP client ────────┤  /authorize /token /register  +  /.well-known/oauth-*                 ├──▶ [btp-cf-mcp on CF]
                    └─ or: Authorization: Bearer <api-key>  (shared-identity fallback) ──────┘        │
                                                                                                      │ inbound token = a sealed
   IAS (aejz2oiae.accounts.ondemand.com) ◀── browser login ──────────────────────────────────────────┤ JWE holding the user's
                                                                                                      │ IAS id_token (ADR-009)
                                     scope ∧ safety gate (read-only default, allowlist, deny)         │
                          ┌───────────────────────────────────────────────────────────────────────────┘
                          ▼ per request: unseal id_token ─▶ IAS app-to-app exchange (aud = CF platform) ─┐
              ┌───────────┴──────────────┐                                                               │
              ▼ CFInspect                 ▼ BTPInspect                                                    │
     CF UAA jwt-bearer ─▶ Cloud           btp CLI **server** protocol over HTTPS (no binary)             │
     Controller v3 AS THE USER            cli.btp.cloud.sap /login + /command  AS THE USER               │
     orgs · spaces · apps · services      subaccount · environments · entitlements (GA-level)            │
                                          (shared-CIS fallback when no IAS: local plan → environments only)
```

Key pieces in code:
- **Inbound OAuth proxy** — `src/auth/ias-oauth-provider.ts` (`mcpAuthRouter` mounts `/authorize` `/token`
  `/register`; the issued MCP access token **is** a sealed JWE of the IAS id_token — never a passthrough).
- **Per-user CF** — `src/auth/{ias-exchange,cf-token,token-provider}.ts` (IAS id_token → app-to-app
  exchange → CF UAA jwt-bearer → Cloud Controller).
- **BTP account ops** — `src/auth/btpcli-http.ts` (the `btp` CLI **server** REST protocol, reimplemented; no
  binary in the container). `runBtpPerUser` (Strategy A, jwt login) and `runBtpTechUser` (Strategy B,
  username/password login) in `src/handlers.ts` share one command runner.
- **Safety gate** — `src/safety.ts` + `src/policy.ts` (scope ∧ safety, read-only default, target allowlist).

## 3. Prerequisites

| # | Need | Note |
|---|------|------|
| 1 | A BTP **global account** with a **Cloud Foundry** environment, trusting a **custom IAS** tenant as a **platform** IdP | the target the server manages, and the IdP users log in through |
| 2 | **IAS admin** on that tenant | to create the OIDC app + the app-to-app dependency (§4) |
| 3 | The **CF platform application client id** in IAS (bundled app "SAP Business Technology Platform") | the exchange audience — see [per-user-ias-auth-setup.md](per-user-ias-auth-setup.md) §3 |
| 4 | The **global-account subdomain** (`BTP_GA_SUBDOMAIN`) and **CF UAA token URL** | e.g. `marianzeis-02` and `https://uaa.cf.<region>.hana.ondemand.com/oauth/token` |
| 5 | `cf` CLI **≥ 8.x** logged in to your CF org/space | `cf login -a https://api.cf.<region>.hana.ondemand.com` |
| 6 | Node 22+ to build locally | `npm ci && npm run build` |

## 4. IAS one-time setup (do this first)

The full step-by-step — create the OIDC app, make it **confidential** (client secret), add the
**`user_name = Email`** attribute, and add the **"SAP Business Technology Platform" principal-propagation
dependency** — is in **[per-user-ias-auth-setup.md](per-user-ias-auth-setup.md) §4**. Do that once, then
come back here.

Two things specific to this server:
- **Register the proxy's redirect URI on the IAS OIDC app:**
  `https://<your-route>/oauth/callback` (the server's OAuth proxy redirects there — *not* the MCP client's
  URI). Add `http://localhost:<port>/callback` too if you use the local `scripts/get-id-token.mjs` helper.
- Note the app's **Client ID / Secret** and the tenant **issuer** URL — they become `IAS_CLIENT_ID`,
  `IAS_CLIENT_SECRET`, `IAS_ISSUER` below.

## 5. Deploy the server to Cloud Foundry (IAS-first)

```bash
git clone <repo> && cd btp-cf-mcp
npm ci && npm run build

# 0. Edit manifest.yml for YOUR landscape FIRST — the route AND PUBLIC_URL (both ship with the dev route).
#    PUBLIC_URL must equal the public https route; the OAuth metadata + the sealed-token audience derive
#    from it, and it is where IAS redirects back.

# 1. Push the app (uses manifest.yml)
cf push btp-cf-mcp

# 2. Set the IAS-first config out-of-band (NEVER in manifest.yml — it is committed)
cf set-env btp-cf-mcp SEALING_SECRET        "$(openssl rand -hex 32)"   # keys the MCP-token JWE (rotate via SEALING_SECRET_PREVIOUS, §7)
cf set-env btp-cf-mcp IAS_ISSUER            https://<tenant>.accounts.ondemand.com
cf set-env btp-cf-mcp IAS_CLIENT_ID         <ias-oidc-app-client-id>
cf set-env btp-cf-mcp IAS_CLIENT_SECRET     <ias-oidc-app-client-secret>
cf set-env btp-cf-mcp CF_PLATFORM_CLIENT_ID <cf-platform-app-client-id>          # the exchange audience
cf set-env btp-cf-mcp CF_UAA_URL            https://uaa.cf.<region>.hana.ondemand.com/oauth/token
cf set-env btp-cf-mcp CF_API                https://api.cf.<region>.hana.ondemand.com
cf set-env btp-cf-mcp BTP_GA_SUBDOMAIN      <global-account-subdomain>           # enables per-user BTPInspect
cf set-env btp-cf-mcp PUBLIC_URL            https://<your-route>
# optional shared-identity fallback for scripting (see §6):
cf set-env btp-cf-mcp API_KEYS              "$(openssl rand -hex 16):admin"
cf restage btp-cf-mcp

# 3. Verify (see §9 for the green-light log line)
curl -s https://<your-route>/health | jq
curl -s https://<your-route>/.well-known/oauth-authorization-server | jq   # should list /authorize /token /register
```

The startup log must show **`inbound: IAS-first per-user (OAuth proxy) + api-key`**. If it says
`XSUAA + api-key (no IAS config)`, one of the IAS vars or `SEALING_SECRET` is missing (§9).

> 🛈 **Config precedence:** bound `VCAP_SERVICES` **>** `cf set-env` **>** defaults (`src/config.ts`).
> ⚠️ **Never put secrets in `manifest.yml`** — it is committed. Use `cf set-env`.
> 🧰 **MTA alternative:** `mbt build && cf deploy` using the committed `mta.yaml` + an mtaext for the
> route/secrets. ⚠️ Keep the filled mtaext **outside the repo** (MBT would package a root-level secret
> file into the artifact) — see `mta-config.mtaext.example`.

## 6. Per-user authorization — the BTP roles that make reads actually return data

Authenticating ≠ authorization. After login the server acts as your **IAS platform shadow user**
(origin key like `aejz2oiae-platform`), which is a **different principal** from the same email under the
"Default identity provider." That platform identity must hold the right roles, or reads come back empty / 403.

| What you want to read | Role to assign to the **platform** shadow user | Where |
|---|---|---|
| CF apps/spaces/services | CF **Org/Space roles** (e.g. OrgManager, SpaceDeveloper) under origin `<tenant>-platform` | subaccount → Cloud Foundry → Roles, or `cf set-space-role … --origin <tenant>-platform` |
| BTP **subaccount detail** + **environments** | *(none extra — works out of the box)* | — |
| BTP **entitlements** (GA-level catalog) | **Global Account Viewer** (read-only) | Global Account → Security → Users/Role Collections |

Assign the GA role from a **GA-admin session** (your `accounts.sap.com` / Default-IdP login — `btp login --sso`):

```bash
btp login --sso --subdomain <global-account-subdomain>              # Default IdP → GA admin
btp list security/trust --global-account                            # confirm the platform origin key
btp assign security/role-collection "Global Account Viewer" \
    --to-user <you@example.com> --of-idp <tenant>-platform          # e.g. aejz2oiae-platform
```

Role changes take **~1–2 minutes** to propagate. `cf orgs` = "No orgs found" or an entitlements 403 **before**
you assign roles is correct least-privilege, not a bug.

## 6a. Strategy B — set up the read-only technical user

A single service account the server uses for BTPInspect when a caller has **no per-user login** (e.g. an
API-key client). Live-verified read-only on a free-tier subaccount.

**1. Create the technical user in IAS** (`<tenant>.accounts.ondemand.com` admin console):
- Users & Authorizations → User Management → **Add User**, e.g. `mcp-readonly@<yourdomain>`.
- **Set a password and complete the one-time activation** (activation email or one interactive login) so the
  password is fixed and active — a service account can't be in a "must-change-on-first-login" state.

**2. Grant it read-only roles** (from a GA-admin session — `btp login --sso`). Two role collections, both
read-only, cover all three reads:

| Read | Role collection | Scope |
|---|---|---|
| `subaccount` detail, `entitlements` (GA catalog) | **Global Account Viewer** | global account |
| `environments` (subaccount env instances) | **Subaccount Viewer** | per subaccount |

```bash
btp login --sso --subdomain <ga-subdomain>
btp assign security/role-collection "Global Account Viewer" \
    --to-user mcp-readonly@<yourdomain> --of-idp <tenant>-platform
btp assign security/role-collection "Subaccount Viewer" \
    --to-user mcp-readonly@<yourdomain> --of-idp <tenant>-platform --subaccount <SUBACCOUNT_GUID>
```
(Skip Subaccount Viewer if you don't need `environments`. Role changes take ~1–2 min to propagate.)

**3. Configure the server** (secrets via `cf set-env`, never `manifest.yml`):
```bash
cf set-env btp-cf-mcp BTP_GA_SUBDOMAIN  <ga-subdomain>
cf set-env btp-cf-mcp BTP_TECH_USER     mcp-readonly@<yourdomain>
cf set-env btp-cf-mcp BTP_TECH_PASSWORD '<the-activated-password>'
# BTP_TECH_IDP defaults to the IAS_ISSUER host; set it only if the tech user lives on a different IdP
# (empty = the global account's default IdP / accounts.sap.com).
cf restage btp-cf-mcp
```
Give API-key clients a `viewer` key (`API_KEYS="<key>:viewer"`); their `BTPInspect` calls now run as this
read-only user.

> ⚠️ **Requires password login (ROPC).** The CLI server logs the tech user in with username/password, which
> the IAS tenant must allow. If login fails despite correct credentials + roles, ROPC is disabled for platform
> users on that tenant — use the per-user model instead, or a certificate-based technical user (not yet wired).

## 7. Configuration reference

| Variable | Default | Meaning |
|----------|---------|---------|
| **IAS-first (per-user)** | | *all 5 IAS vars **and** `SEALING_SECRET` are required to enter IAS-first mode* |
| `IAS_ISSUER` | — | IAS tenant URL, `https://<tenant>.accounts.ondemand.com` (OIDC upstream + issuer) |
| `IAS_CLIENT_ID` / `IAS_CLIENT_SECRET` | — | the server's **confidential** IAS OIDC app |
| `CF_PLATFORM_CLIENT_ID` | — | the CF-platform IAS app client id — the app-to-app **exchange audience** |
| `CF_UAA_URL` | — | CF UAA token endpoint (`…/oauth/token`) for the per-user CF token |
| `SEALING_SECRET` | — | 32-byte random; keys the MCP-token JWE |
| `SEALING_SECRET_PREVIOUS` | — | old key kept valid during a rotation: set `SEALING_SECRET`=new + this=old → live tokens keep working until they expire, then drop it (rotate without a mass re-login) |
| `CF_API` | — | Cloud Controller API base (`https://api.cf.<region>.hana.ondemand.com`) |
| `PUBLIC_URL` | — | the public https route; OAuth metadata + sealed-token audience + IAS redirect derive from it |
| **BTPInspect (both identity models)** | | |
| `BTP_GA_SUBDOMAIN` | — | global-account subdomain; **required for any per-user OR technical-user BTPInspect** (else BTPInspect falls back to the shared CIS key) |
| `BTP_DEFAULT_SUBACCOUNT` | — | default subaccount for `subaccount`/`environments` when no CIS key supplies one (a CLI-server-only deploy has no CIS); else pass `subaccount` per call |
| **Technical user (Strategy B)** | | *shared read-only BTPInspect identity; also needs `BTP_GA_SUBDOMAIN`* |
| `BTP_TECH_USER` / `BTP_TECH_PASSWORD` | — | the read-only technical user's CLI-server login (username/password) |
| `BTP_TECH_IDP` | IAS_ISSUER host | custom IAS origin host for the tech user; empty = the GA's default IdP |
| **Inbound (shared-identity fallback)** | | |
| `API_KEYS` | — | space-separated `key:profile` pairs (`viewer`/`developer`/`admin`); call with `Authorization: Bearer <key>` |
| XSUAA (bound) | — | if no IAS config, inbound falls back to XSUAA OAuth via `@arc-mcp/xsuaa-auth` (§12) |
| `ALLOW_OPEN` | `false` | `true` permits unauthenticated **read-only** access (dev only) — fail-closed by default |
| **Safety** | | |
| `ALLOW_WRITES` | `false` | enable mutations (prerequisite for any write; writes are still inert in this PoC) |
| `ALLOWED_SUBACCOUNTS` / `ALLOWED_ORGS` / `ALLOWED_SPACES` | — | fail-closed write-target allowlists |
| `DENY_ACTIONS` | — | CSV of `Tool.action` / `Tool.*` / `Tool` to refuse (e.g. `BTPServices.delete_service`) |
| **Shared CF backend (api-key / headless path)** | | *per-user OAuth callers mint their own CF token; this is only the shared fallback* |
| `CF_REFRESH_TOKEN` (+ `CF_UAA_URL`) | — | **preferred** durable shared CF token — refreshes the ~20 min access token so headless `CFInspect` doesn't die mid-session; from `~/.cf/config.json` `RefreshToken` (strip `bearer `) |
| `CF_TOKEN` | — | legacy static bearer (`cf oauth-token`); superseded by `CF_REFRESH_TOKEN` (a static token expires in ~20 min) |
| **Shared CIS (fallback backend)** | | |
| `CIS_SERVICE_KEY` | — | CIS `client_credentials` key JSON (or bind a `cis` instance) — used only when `BTP_GA_SUBDOMAIN` is unset (§12) |
| `PORT` | 8080 (CF injects) | HTTP port |

## 8. Connecting MCP clients

Point the client at **`https://<your-route>/mcp`**.

- **OAuth-capable clients** (Claude, MCP Inspector, VS Code): they discover the authorization server from
  `/.well-known/oauth-protected-resource`, dynamically register (`/register`), open the **IAS login** in a
  browser, and receive the sealed MCP token. Then every tool call runs as that user. Test with
  `npx @modelcontextprotocol/inspector` → connect → log in → call `CFInspect` `orgs`.
- **API key** (scripting / shared identity): `Authorization: Bearer <key>` (the `:<profile>` lives only in
  `API_KEYS`, not in the header). API-key callers do **not** get the per-user CF/BTP tools unless a shared
  backend is also configured — they are hidden from the tool list by design.

## 9. Operating & first-boot check

Watch `cf logs btp-cf-mcp --recent` on first boot. The green-light lines:

```
[btp-cf-mcp] IAS config found — IAS-first per-user inbound (XSUAA skipped)
[btp-cf-mcp] backends: cis=<t/f> cf=<t/f>; writes=false; apiKeys=<n>
[btp-cf-mcp] inbound: IAS-first per-user (OAuth proxy) + api-key
[btp-cf-mcp] btp-cf-mcp vX listening on :8080 (writes=false, open=false)
```

`cis=`/`cf=` here reflect the **shared** backends only; per-user CF/BTP work regardless (they ride the
request's IAS credential). Backend error bodies are logged to stderr (`console.error`), never returned to
the MCP client.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Startup says `inbound: XSUAA + api-key (no IAS config)` | An IAS var or `SEALING_SECRET` is missing | Set all 5 IAS vars **and** `SEALING_SECRET`, `cf restage` (§5) |
| OAuth login fails / redirect error at IAS | Proxy redirect URI not registered | Add `https://<route>/oauth/callback` to the IAS OIDC app (§4) |
| `BTPInspect.entitlements` → **HTTP 403** | Acting identity lacks the GA role | Assign **Global Account Viewer** (to your platform user for per-user, §6; or the tech user, §6a); wait ~1–2 min |
| `BTPInspect.environments` → **HTTP 403** but subaccount/entitlements OK | Tech user has GA Viewer but no **subaccount** role | Assign **Subaccount Viewer** to the tech user for that subaccount (§6a) |
| Tech user: **all** `BTPInspect` reads fail with a login error | Wrong creds/role, un-activated password, or **ROPC disabled** on the IAS tenant | Verify the password is activated + roles assigned; if still failing, ROPC is off → use per-user (§6a warning) |
| `BTPInspect.subaccount`/`environments` 403 or empty | Login mapped to the wrong shadow user, or no CF/GA membership | Confirm you logged in via the **custom IAS** (not Default IdP); the MCP acts as the `-platform` user |
| CF tools return **"No orgs found"** / empty | Per-user identity has no CF roles (correct least-privilege) | Assign CF Org/Space roles under origin `<tenant>-platform` (§6) |
| `CFInspect.*` / `BTPInspect.*` **not listed** for an API-key caller | By design — per-user tools need an IAS credential | Log in via OAuth, or configure a shared backend (`CF_TOKEN` / `CIS_SERVICE_KEY`) |
| `cf auth`/exchange → `Some parties were not in the token audience` or `Unable to map claim to a username` | IAS app missing the dependency or the `user_name=Email` attribute | See [per-user-ias-auth-setup.md](per-user-ias-auth-setup.md) §7 |
| **401 Unauthorized** on `/mcp` | Missing/expired token | Re-login (the sealed token has a ~30-min TTL); or pass `Bearer <key>` |
| A tool reports **"backend unavailable"** | Fallback path with no shared backend configured | Set `CIS_SERVICE_KEY` / `CF_API`+`CF_TOKEN`, or use the per-user (IAS) path |
| App **deleted or `cf` re-targets** mid-deploy | Background automation on the account re-targeting `cf` | Deploy in an isolated `CF_HOME` and chain push+set-env+restage in one invocation |
| Writes "succeed" but **nothing changes** | PoC: `create_service`/`delete_service` + CF lifecycle are **inert** | Expected; real writes are future work |

## 11. Caveats & known limitations

- **Entitlements is GA-wide, not per-subaccount.** The tool reads the **global-account** entitlement catalog
  (works with Global Account Viewer). The *subaccount-scoped* view (`servicePlanAssignments`) needs a
  separate **subaccount-level** role and is not wired — GA-wide is the canonical "what is this account
  entitled to" answer.
- **Two shadow users, same email.** The MCP acts as the **IAS platform** user (`<tenant>-platform`), *not*
  the Default-IdP (`accounts.sap.com`) admin user. Assign the roles you want the MCP to have to the
  **platform** user. This is also a useful least-privilege boundary — the "MCP identity" can be narrower
  than your primary admin identity.
- **Technical user = shared identity + a stored password.** Strategy B trades per-user accountability for
  simplicity: audit shows the technical user for every caller, and its password lives in `BTP_TECH_PASSWORD`
  (rotate it, scope the API keys tightly). It also depends on the tenant allowing **password login (ROPC)** —
  if that's disabled, use per-user or a certificate-based technical user (not yet wired).
- **CIS REST is not per-user** (SAP platform limitation, proven). The shared-CIS fallback exists only for
  setups without IAS, and its `local`-plan key can read **only** `environments` (subaccount/entitlements
  return 401 — central-plane APIs the local key can't reach). Per-user via the CLI server (§2) is the way.
- **Consent gate is per-authorization.** DCR is guarded by a signed, browser-bound consent screen (a
  relayed victim's cookieless callback is rejected). For untrusted exposure, also tighten the DCR
  redirect-URI allowlist as defence-in-depth.
- **Writes are inert** — `create/delete_service` + CF lifecycle pass the gate but don't execute (read-only
  positioning). Access tokens live ~30 min; a **refresh token** is issued when IAS grants one, else the
  client re-authenticates.
- **Rotate secrets.** `IAS_CLIENT_SECRET` (IAS console) + the tech-user password are the crown jewels;
  rotate `SEALING_SECRET` gracefully via `SEALING_SECRET_PREVIOUS` (§7) — no mass re-login.

## 12. Shared-identity fallback (no IAS)

If you cannot set up IAS, the server still runs with **XSUAA or API-key inbound** and **shared-technical**
outbound:
- Omit the IAS vars → inbound falls back to XSUAA OAuth (bind an `xsuaa` instance created from
  `xs-security.json`) + API key. Assign the `btp-cf-mcp` role collection **under the same IdP origin your
  login uses** (the classic empty-tool-list gotcha).
- Omit `BTP_GA_SUBDOMAIN` → `BTPInspect` uses a shared **CIS** `client_credentials` key. **Gotcha
  (live-proven):** create the `cis` `local` instance via the **btp CLI / Service Manager** with
  `{"grantType":"clientCredentials"}`, **not** `cf create-service` (which yields a `user_token` grant →
  HTTP 502 "Communication error with XSUAA", code 42008). Even then, a `local`-plan key can read only
  `environments`.
- Set `CF_API` + a `CF_TOKEN` bearer for `CFInspect` (writes inert).

## 13. References
- [per-user-ias-auth-setup.md](per-user-ias-auth-setup.md) — the IAS one-time setup (proven recipe) + CF/BTP legs
- [../architecture/implementation-plan.md](../architecture/implementation-plan.md) — architecture + ADRs
- [../architecture/ias-oauth-proxy-plan.md](../architecture/ias-oauth-proxy-plan.md) — the inbound OAuth proxy design
- [../operations/live-chain-runbook.md](../operations/live-chain-runbook.md) — per-user chain proof
- [../../AGENTS.md](../../AGENTS.md) — codebase guide
