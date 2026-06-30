# Per-User Outbound Auth for `btp-cf-mcp` — Acting As the Logged-In User on CIS and Cloud Foundry

**Date:** 2026-06-30
**Status:** Research / architecture decision input
**Repo:** `~/DEV/btp-cf-mcp` (PoC MCP server managing SAP BTP + Cloud Foundry, deployed on BTP Cloud Foundry)
**Reference repo:** `~/DEV/arc-1` (ABAP-ADT MCP server whose auth/safety model and `@arc-mcp/xsuaa-auth` dependency we reuse)

---

## 0. ADDENDUM — Post-Codex Revision (READ FIRST; supersedes the §5/§7 primitive & recommendation)

An outside review (Codex/GPT-5, 2026-06-30) confirmed the CIS-REST and CF identity-zone conclusions but **overturned the central primitive**. The correction is decisive:

- **OQ-1 is the wrong primitive and will most likely FAIL.** You cannot reliably mint a per-user IAS id_token **from** the inbound XSUAA access token. BTP trust is **IAS → XSUAA** (IAS is the upstream IdP that issues *to* XSUAA), **not** XSUAA → IAS. The inbound token is an XSUAA-issued *access* token with `aud=btp-cf-mcp!t498139` and `iss=<subaccount XSUAA>`; IAS has no reason to trust that issuer/JWKS as a jwt-bearer assertion, and the audience/token-type are wrong even if an admin tried to register XSUAA as an external OIDC provider. The real primitive is **"the server possesses a per-user id_token issued by IAS"**, full stop — obtained at login, not exchanged from XSUAA.

- **CORRECTED ARCHITECTURE — IAS-first inbound.** Make the MCP server's inbound login an **IAS/OIDC** login (against the `aejz2oiae` tenant) so the server holds a genuine **IAS id_token from the start**. That single IAS id_token is the universal currency: feed it to `cf auth --assertion` (CF) and to the BTP CLI Server `/login/<ver>/idtoken` (BTP account ops). **No XSUAA→IAS hop.** If the current XSUAA app-scope model (`read/write/admin` role collections) must be kept, do an **IAS → XSUAA** exchange (the *supported* direction; SAP Cloud SDK provides it) or re-derive scopes from **IAS groups**.

- **Revised recommendation:** (1) Move inbound auth to IAS/OIDC (or add an IAS inbound mode) — `@arc-mcp/xsuaa-auth` already ships `createOidcVerifier`. (2) CF per-user via the IAS id_token + `cf auth --assertion` (CF CLI ≥ 8.12), after verifying the platform-UAA jwt-bearer client + trusted-issuer + audience. (3) BTP account ops via the **BTP CLI Server** `/login/<ver>/idtoken` (NOT CIS REST — and NOTE the CLI Server cannot replace Cloud Controller v3 app/space/service ops). (4) **CIS REST stays shared `client_credentials`** (explicitly *not* acts-as-you) until SAP confirms a per-user CIS REST grant.

- **Corrections to specifics below:** §8 OQ-4 endpoint is wrong — id-token login is `POST https://cli.btp.cloud.sap/login/<ver>/idtoken`, not `/login/<ver>` (the base is username/password). "Same subaccount/identity-zone" governs *XSUAA* jwt-bearer/Destination exchange, **not** IAS→CF (there it's IAS issuer/audience/origin trust). The §7.2 `IasIdTokenProvider` must NOT `id_token ?? access_token` — require a JWT with the expected `iss`/`aud`/`sub`/`email`/exp. Adding `uaa.user`/`Token_Exchange` to our `xs-security.json` does **not** make the SAP-managed CIS app grant CIS scopes to us (M1/Rank-3 stays blocked).

- **THE ONE LIVE TEST (revised):** take a **real IAS id_token produced by the planned IAS-first inbound flow** and prove BOTH `cf auth --assertion <id_token>` AND `POST cli.btp.cloud.sap/login/<ver>/idtoken {jwt:<id_token>}` accept it **for a user with deliberately limited roles**, and that the resulting CF/BTP calls enforce that user's real roles.

- **Outside input IS required** (Codex concurs): **IAS admin** (register the OIDC app for inbound; confirm issuer/audience/groups), **CF/BTP platform support** (the platform-UAA jwt-bearer client contract + trusted `-platform` IdP), and **SAP CIS product support** (whether per-user CIS REST is supported/audited as the human at all).

- **✅ LIVE-PROVEN (2026-06-30) — per-user CIS via in-zone XSUAA jwt-bearer is DEAD (M1/M7/OQ-5 blocked).** Captured a real user XSUAA token (origin `sap.custom`, scopes `btp-cf-mcp!t498139.read/write/admin`) and exchanged it (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, assertion = user token) at the *same* subaccount XSUAA (`dev-9li7mzug.authentication.us10…`) for the CIS client. The exchange **SUCCEEDS — HTTP 200, user identity `marian@zeis.de` preserved** — BUT the resulting token carries scopes **`["openid","uaa.user"]` only — zero CIS scopes**, so the CIS provisioning call returns **502 / code 42008**. This empirically confirms the prediction: the SAP-managed `cis` app does not grant its scopes to our app, and our role-collection scopes are app-specific. **Conclusion: CIS REST per-user is not achievable — CIS stays shared-technical (M9).** Per-user effort focuses solely on CF + BTP-account-ops via the IAS id_token → `cf auth --assertion` / BTP CLI Server path. (Spike: `scratchpad/xsuaa-cis-spike.mjs`.)

- **🔬 LIVE TEST (2026-06-30, IAS-first CF/BTP legs) — partial, very informative.** Registered an IAS OIDC app (public client + PKCE, Client ID `881adbc3-…`), minted a real user id_token (`iss=aejz2oiae.accounts.ondemand.com`, `sub=P000000`, `email=marian@zeis.de`, ~116 min). Fed it to both legs:
  - **CF leg** (`cf auth cf "" --assertion <id_token>` / raw CF-UAA jwt-bearer): **CF UAA TRUSTS the IAS issuer** (no "unable to map issuer" — the platform `-platform` trust works) but returns `{"error":"invalid_token","error_description":"Some parties were not in the token audience: 306ee77d-68d9-4398-ac62-1d07872563f9"}`. **→ CF per-user is REACHABLE — the only blocker is the id_token `aud`:** it must include the CF platform client `306ee77d-68d9-4398-ac62-1d07872563f9`, but ours is `aud=881adbc3` (our app). Fix = IAS **Dependency/Consumed-API** config so our app's token carries `306ee77d` in its audience, then re-mint + retest. This is a *configurable* gap, not the zone wall — a major positive update vs. the doc's pessimism.
    - **FOLLOW-UP attempts (same day) — audience NOT yet emittable via standard params.** Added the BTP-platform app (App ID `13ac4879`, client `306ee77d`, origin `btp-platform`) as an IAS dependency **"All APIs → Allow all APIs for principal propagation"**, set the app's **Access Token Format = JWT**, and tried to emit `aud=306ee77d` via: (a) plain auth-code login, (b) RFC 8693 **token-exchange** with `audience=306ee77d` and `=13ac4879` (200 but id_token `aud` unchanged; `requested_token_type=id_token`→"Missing session for token"; IAS exchange only allows `requested_token_type=access_token`; result token still `aud=881adbc3`), and (c) the OIDC **`resource=306ee77d`** param at authorize+token. **Every token came back `aud=881adbc3` (our app) only.** So CF per-user is **architecturally reachable** (CF UAA trusts the IAS tenant) but **emitting the platform audience requires the EXACT SAP IAS principal-propagation token request, which is NOT one of the standard OAuth params** — most likely a specific *provided-API scope* of the platform app, or the SAP Cloud SDK / `@sap/xssec` principal-propagation helper that encodes the flow. **This is the precise, narrow "outside input" item: confirm with SAP/IAS docs the exact request that makes IAS issue our app a token audienced for the `btp-platform` app.** Not crackable from first principles + trial-and-error alone.
    - **✅ BREAKTHROUGH (same day) — audience SOLVED.** SAP doc *Consume an API from a Provider Application* gives the exact app-to-app flow: `POST $ias/oauth2/token` with **confidential client auth** (the consumer app needs a client secret), `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<user id_token>`, and the magic param **`resource=urn:sap:identity:application:provider:clientid:<providerClientId>`** (or `…:provider:name:<dependencyName>`). With the consumer→provider **Dependency** ("All APIs / principal propagation") configured, this returns a **user token with `aud=<providerClientId>`** (`ias_apis:["principal-propagation"]`, `sub`, `mail`). Confirmed live: `resource=...clientid:306ee77d...` → token `aud=306ee77d`, `sub=P000000`, `mail=marian@zeis.de`. **CF UAA now ACCEPTS the audience** — `cf auth … --assertion` advanced past the audience check to **`"Unable to map claim to a username"`**. So **per-user CF is PROVEN reachable**; remaining = a CF-UAA claim-mapping detail (propagation token has `mail`+`sub=P000000` but not the `user_name`/`email` claim the CF platform UAA's IAS trust maps). Fix = enrich the IAS token via **Attributes** (add the mapped claim) or align the Subject Name Identifier. Refs: [Consume an API from a Provider Application](https://help.sap.com/docs/cloud-identity-services/cloud-identity-services/consume-api-from-another-application), [JWT Bearer Flow App-to-App](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/jwt-bearer-flow-between-two-applications-in-sap-cloud-identity-services-app-to-app). **The doc's pessimistic "CF needs SAP platform support" verdict is now downgraded: the whole chain is reproducible by the customer; only a claim-mapping field remains.**
    - **✅✅ FULLY CRACKED (2026-06-30) — per-user CF works END TO END.** The last piece was the username claim: added IAS Attribute **`user_name` = Email** to the consumer app (the CF platform UAA's IAS trust maps `user_name`). Re-ran the chain → **`cf auth cf "" --assertion <token>` returned `OK`**, CF token `user_name=marian@zeis.de`, `origin=aejz2oiae-platform`. `cf orgs` → "No orgs found" = CORRECT per-user least-privilege (the user has no CF org/space roles under the platform origin yet; assigning roles grants access — the user's own authz is enforced). **Per-user CF is PROVEN, fully reproducible by the customer, NO SAP support needed.**

      **WORKING RECIPE (per-user CF):**
      1. **IAS OIDC app** for the MCP server (this is the *inbound* login): confidential (client secret) + "Enable Public Client Flows" (PKCE) + **Access Token Format = JWT**.
      2. **IAS app → Attributes:** add `user_name` = Email (source Identity Directory → Email). *(This is the claim the CF UAA maps to the username.)*
      3. **IAS app → Dependencies → APIs:** add the **`SAP Business Technology Platform` / `btp-platform`** app (client `306ee77d`) as **"All APIs / principal propagation."**
      4. **Inbound:** user logs into the MCP server via IAS OIDC (auth-code + PKCE) → server holds the user's IAS id_token (now carrying `user_name`).
      5. **Outbound exchange (server-side, confidential):** `POST $ias/oauth2/token` with `Authorization: Basic <clientid:secret>`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<user id_token>`, `resource=urn:sap:identity:application:provider:clientid:306ee77d-…` → returns a token with `aud=306ee77d` carrying the user.
      6. **CF:** `cf auth <cf-client> "" --assertion <that token>` (CF CLI ≥ 8.12) → CF session **as the user** (`origin=aejz2oiae-platform`); CC API then enforces the user's real CF org/space roles.
      7. To act on actual CF resources, assign the user CF roles under the `aejz2oiae-platform` origin (normal role-collection step).

      **✅ BTP-account leg also PROVEN (2026-06-30).** `btp login --url https://cli.btp.cloud.sap --subdomain <GA> --idp aejz2oiae.accounts.ondemand.com --jwt <propagation token>` → **OK**; `btp list accounts/subaccount` returned the subaccounts **as the user** (target = the user's GA). The **SAME** propagation token (`aud=306ee77d`) drives BOTH `cf auth --assertion` (CF) AND `btp login --jwt` (CLI Server / BTP account ops). (`btp --info` shows "dummy mail at dummy issuer" — cosmetic; the session is authorized as the real user.) **KEY INSIGHT: the BTP CLI Server gives per-user BTP *account ops* (subaccounts/entitlements/environments/role-collections) — the very operations CIS REST can't do per-user. So there is NO real per-user gap: only the CIS REST *transport* is shared-technical; the account operations themselves are reachable per-user via the CLI Server.** Map complete: **CF per-user ✅ · BTP account ops per-user ✅ · (CIS REST = shared transport, redundant for per-user).** Rank-1 IAS-first design fully validated.
  - **BTP CLI Server leg** (`POST cli.btp.cloud.sap/login/v2.97.0/idtoken`): HTTP **400** (right endpoint, bad request — likely the same audience issue or body shape); base `/login/v2.97.0` → 401. Revisit after the CF audience fix.
  - **Operational note:** the `btp` CLI session keeps expiring mid-work; isolate per-test with `BTP_CLIENTCONFIG`. The IAS login itself was **silent SSO** (good inbound-UX omen).

The mechanism inventory (§3), zone analysis (§2.3), and CIS/CF conclusions (§5) below remain valid; only the *primitive* (how the IAS token is obtained) and the resulting *recommendation* change per this addendum.

---

## 1. Goal and the Exact Question

**Goal (the one that matters):** The user logs into the MCP server **once** — the existing XSUAA OAuth URL login — and the server then **acts as that user**, enforcing the user's *own* BTP/CF authorizations, on **both**:

- **CIS** (SAP Cloud Management Service — BTP account/subaccount/entitlement/provisioning ops), and
- **CF** (Cloud Foundry Cloud Controller — org/space/app/service ops),

with **no further login**.

**Exact question:** Can a single inbound XSUAA login be converted, server-side and headlessly, into outbound credentials that act *as the user* (not as a shared technical identity) on CIS and on CF? If pure one-login is impossible for some leg, what is the ranked set of alternatives that get closest, each honestly costed in extra user steps, UX, security, and effort?

**One-line answer.** For **CIS**, acting *as the user* with zero extra user steps is **not reachable** as the PoC is wired today, and it is **not a documented capability of the CIS APIs at all** (they accept only Password grant and, subaccount-only, Client Credentials [1][2]). The realistic per-user CIS path runs through the **BTP CLI Server's JWT Bearer Assertion flow** [4][5], not a CIS jwt-bearer grant. For **CF**, acting *as the user* headlessly is reachable **only** via a per-user **IAS-issued id_token** fed to the CF platform UAA (`cf auth --assertion`, CF CLI ≥ 8.12 [6][7]) — the **inbound XSUAA app token cannot be reused** because the Cloud Controller is a *separate* identity zone not connected to XSUAA [8]. Both per-user paths therefore converge on the **same primitive**: an **IAS-minted, per-user OIDC id_token**, valid only **within the one subaccount/identity-zone** the PoC already lives in (the same constraint arc-1 #434 proved [3]).

---

## 2. Background: Current PoC Auth and the Identity Zones Involved

### 2.1 Inbound auth (verified)

The MCP server's inbound edge is XSUAA OAuth URL login via the published npm package **`@arc-mcp/xsuaa-auth`** (the `setupHttpAuth` facade). `src/server.ts` wires it:

```ts
const bearer = setupHttpAuth(app, { apiKeys, xsuaa, expandScopes, required: !config.allowOpen }, noopLogger);
```

After login the server holds the user's **verified XSUAA access token**, whose claims (decoded today only by the `whoami` diagnostic in `src/server.ts`) are:

| Claim | Value | Meaning |
|-------|-------|---------|
| `aud` | `btp-cf-mcp!t498139` | Audience = **our app's** XSUAA instance |
| `scope` | `…read` / `…write` / `…admin` (app-qualified) | Our app's role-collection scopes |
| `origin` | `sap.custom` | A **custom IAS tenant** `aejz2oiae.accounts.ondemand.com` |
| `zid` | `65647146-155d-4755-90f4-86ad098be1ee` | The **dev subaccount** = our app's **identity zone** |
| issuer | `https://<subaccount>.authentication.us10.hana.ondemand.com/oauth/token` | The subaccount XSUAA |

Region `cf-us10`, CF org `Marian Zeis_dev-9li7mzug`. `xs-security.json` defines exactly three scopes (`read`/`write`/`admin`) and three role-templates (Viewer/Developer/Administrator) — **no `uaa.user` scope, no `Token_Exchange` role, no `foreign-scope-references`, no `granted-apps`**.

### 2.2 Outbound auth (current state)

Outbound is **CIS REST** (SAP Cloud Management Service) via OAuth2 **`client_credentials`** — a **shared technical identity**. `src/btp.ts`:

```ts
export class ClientCredentialsProvider implements TokenProvider { /* grant_type=client_credentials, Basic cis clientid:secret */ }
export class CisClient { private readonly provider = new ClientCredentialsProvider(creds.tokenUrl, …); }
```

`src/config.ts` builds the CIS token URL as `${cred.uaa.url}/oauth/token` from a **`cis` local-plan service key** created via Service Manager / `btp` CLI (Other environment). This shared identity **does not act as the user** — CIS audit attributes every call to the technical OAuth client, not the human.

CF (Cloud Controller) is **not wired**: `CfClient` exists and takes a `TokenProvider`, but the only providers are `ClientCredentialsProvider` and a `StaticTokenProvider` (a CF token pasted via env). `dispatch()` calls into the clients but **drops `extra.authInfo.token`** — it forwards only `scopes`.

**Verified facts the PoC already proved:**
- CIS `client_credentials` works **only** when the `cis` instance is created at **subaccount level** via Service Manager / `btp` CLI (Other environment). `cf create-service cis` yields a service key whose `grant_type` is `user_token`, not `client_credentials` — consistent with SAP's note that Client Credentials is available "only when creating the instances of this service on a subaccount level by using the SAP Service Manager API, CLI, or … the SAP BTP cockpit and selecting the *Other* environment" [1].
- The `cis` instance and the app XSUAA are in the **same subaccount / identity zone** (`zid 65647146-…`).
- arc-1 #434 (live-reproduced): `OAuth2UserTokenExchange` (jwt-bearer) works **within** one subaccount/identity-zone, **fails cross-subaccount** with `Token header claim [kid] references unknown signing key` / `Unable to map issuer: No identity provider found` [3].

### 2.3 The four identity zones (this is the crux of everything below)

```
                          ┌─────────────────────────────────────────────────────┐
                          │  CUSTOM IAS TENANT  (origin sap.custom)               │
                          │  aejz2oiae.accounts.ondemand.com                      │
                          │  — the ONE upstream IdP that every zone below trusts  │
                          └───────────────┬───────────────────────┬──────────────┘
                                          │ trusts as IdP          │ trusts as IdP
                                          ▼ (application users)     ▼ (platform users, "-platform" origin)
   ┌────────────────────────────┐   ┌────────────────────────────┐   ┌────────────────────────────┐
   │  APP XSUAA  (subaccount     │   │  CIS-UAA  (subaccount       │   │  CF PLATFORM UAA            │
   │  identity zone, zid 65647…) │   │  identity zone, SAME zid)   │   │  login/uaa.cf.us10-001.*    │
   │  aud = btp-cf-mcp!t498139   │   │  aud = cis xsappname        │   │  SEPARATE identity zone     │
   │  inbound login lands here   │   │  client_credentials today   │   │  NOT connected to XSUAA [8] │
   └────────────────────────────┘   └────────────────────────────┘   └────────────────────────────┘
          └────────── SAME ZONE (in-zone jwt-bearer is structurally allowed) ──────────┘            ▲
                                                                                                    │
                                          DIFFERENT ZONE — XSUAA token cannot cross here ────────────┘
```

- **App XSUAA** and **CIS-UAA** are the *same* identity zone (the subaccount). In-zone XSUAA token exchange is structurally permitted [11], subject to scope/trust config.
- **CF platform UAA** is a **different** identity zone. SAP staff state plainly: *"The CF Cloud Controller API is currently not connected to XSUAA and thus it is not possible to obtain a token from there"* [8]. A UAA identity zone is an isolated logical boundary; two zones = two separate UAA deployments with separate clients, users, IdP registrations and signing keys [9].
- The **custom IAS tenant** is the single thing all three trust. For platform users (CF), the custom-IdP trust is configured at the global-account level ("Establish Trust and Federation of Custom Identity Providers for Platform Users" [10]); its **origin key always ends with `-platform`** and is *distinct* from the subaccount application origin `sap.custom`.

**Consequence:** the portable credential for *the same human* across all three zones is an **IAS-issued OIDC id_token**, **not** an XSUAA access token. Everything in §3–§7 follows from this.

---

## 3. Mechanism Inventory

Legend — **per-user?** = does the resulting outbound call act as the human (their authz, their audit identity)? **headless?** = can the server do it with no interactive step at request time? **same-zone only?** = does it depend on staying inside the one subaccount/identity-zone? **extra user steps** = beyond the one inbound login.

| # | Mechanism | Target | per-user? | headless? | same-zone only? | Extra user steps (freq) | Confidence + source |
|---|-----------|--------|:---------:|:---------:|:---------------:|-------------------------|---------------------|
| M1 | **CIS jwt-bearer / user_token exchange** of the inbound XSUAA token at the cis UAA `/oauth/token` | CIS | yes (if it works) | yes | yes | One-time admin: add `uaa.user` + `Token_Exchange` to `xs-security.json`, redeploy, **grant-chain** (cis `granted-apps`→app + app `foreign-scope-references`), assign cis role collections per user. **No per-request step.** | **LOW–MEDIUM.** XSUAA *supports* jwt-bearer generically [11], but **CIS docs document only Password + Client-Credentials** [1][2] — jwt-bearer is *undocumented for CIS* and likely blocked by the SAP-managed cis app's trust config. Must live-test. [1][2][11] |
| M2 | **CIS Password grant** (user's username+password to cis UAA) | CIS | yes | no | no | User must hand over raw username+password (+2FA passcode appended); fails for SSO/MFA-only users. Per session. | **HIGH** (documented [1]) — but **breaks one-login**; "Two-factor authentication is only relevant for Password grant" and the passcode is appended to the password [1]. |
| M3 | **BTP CLI Server JWT Bearer Assertion** (`assertion` / `BTP_ASSERTION`): POST an IAS id_token as the `jwt` login field → per-user `X-Cpcli-Sessionid` → run `accounts/*`, `services/*`, `security/*` as the user | CIS-equivalent (BTP account ops) + CF account-level | yes | yes | yes | One-time admin: register an IAS OIDC app for the token mint; ensure IAS is the custom IdP. Per request: server mints the IAS id_token from the inbound identity (no user step **if** the exchange works). | **MEDIUM.** CLI-Server side is **code-proven** (`DefaultServerURL https://cli.btp.cloud.sap`, `cliTargetProtocolVersion v2.97.0`, `X-Cpcli-Sessionid`, `command/<ver>/<cmd>?<action>`, custom-IdP **mandatory**) [4][5]. The XSUAA-token→IAS-id_token mint is two documented halves, not one cited chain. [4][5][13] |
| M4 | **CF UAA jwt-bearer** (`cf auth CLIENT_ID SECRET --assertion <IAS-id_token>`, CF CLI ≥ 8.12) → CF user token, Cloud Controller enforces the user's org/space roles | CF | yes | yes | n/a (cross-zone *by design*: assertion is IAS-issued, UAA maps it by `iss` to the registered IAS IdP) | One-time admin: register/trust the IAS `-platform` origin in the CF subaccount; map the user into CF org/space roles. Per request: mint the IAS id_token (no user step **if** the exchange works) **and** a platform-zone jwt-bearer client must exist (largely SAP-managed). | **MEDIUM.** `--assertion` + `GrantTypeJwtBearer` are **code-proven** in `command/v7/auth_command.go` and shipped in **v8.12.0** ("Allow CF Authentication based on Tokens — user and client tokens" #3455) [6][7]. Platform-zone client provisioning unverified. [6][7] |
| M5 | **CF passcode** (`cf login --sso` → browser `/passcode` → one-time code → `/oauth/token grant_type=password&passcode`) | CF | yes | **no** | n/a | One interactive browser step **per session** (open passcode URL, paste code). | **HIGH** — per-user, but passcode is only retrievable from an authenticated **browser** session; not automatable. [12] |
| M6 | **CF technical-user with custom IdP** (`cf login --origin <origin> -u <user> -p <password>`) — SAP's *documented automation* path | CF | yes | yes | n/a | Server must hold the **user's password**; restricted to users that exist **directly in the IAS tenant** (OIDC, not SAML; corporate IdP must support password grant). Per session/credential. | **HIGH** (documented [14]) — headless **but credential-bearing**; breaks one-login. |
| M7 | **Destination Service principal propagation** (`lookupDestinationWithUserToken`, OAuth2UserTokenExchange/SAMLBearer) | CIS (same-zone) | yes | yes | yes (for the jwt-bearer variant) | One-time: create a BTP Destination fronting the target. No per-request user step. | **HIGH** that the mechanism exists & arc-1 uses it [3]; for CIS it **collapses into M1** (same in-zone jwt-bearer under the hood) and adds indirection; **inert for CF** (no Destination type bridges into the CF platform-UAA zone). |
| M8 | **CF/CIS X.509 / mTLS passcode (per user)** | CIS via CLI Server / CF | yes | yes | n/a | Per user: enrol an X.509 client cert in IAS and make its key available to the server. Cannot consume the inbound token. | **HIGH** that it exists; heavy ops burden; not derivable from the inbound token. [5] |
| M9 | **Shared technical identity + own scope enforcement** (current PoC) | CIS (today) + CF (would-be) | **no** | yes | n/a | None — but the backend sees one technical principal; audit attribution lost; user's *real* BTP/CF authz **not** enforced. | **HIGH** — honest fallback, explicitly **not** acts-as-you. [1] |

---

## 4. End-to-End Token Chains

### 4.1 Chain A — CIS (BTP account ops)

```
[1] User → inbound XSUAA URL login            ✅ works (PoC verified)
        ▼ server holds USER XSUAA access token (aud=btp-cf-mcp!t498139, zid=65647146…, origin=sap.custom)

  ── Path A1: direct CIS jwt-bearer (M1) ───────────────────────────────────────────────
[2] POST cis-UAA /oauth/token
        grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
        assertion=<inbound USER token>, Basic <cis clientid:secret>
        ▼
    ⚠️  BREAKS / UNPROVEN — three gates:
        (a) inbound token lacks `uaa.user` scope → insufficient_scope (KBA 2876853 class)
        (b) no granted-apps/foreign-scope trust between the SAP-managed cis app and our app
            → exchanged token carries NO cis scopes → CIS 403 (KBA 3355232 class)
        (c) CIS docs document ONLY password + client_credentials [1][2]; jwt-bearer is
            undocumented for the cis RESOURCE server — it may reject a jwt-bearer-shaped token
        ▼ even if (a)+(b) fixed, (c) is the resource-server wall — LIVE TEST REQUIRED

  ── Path A2: BTP CLI Server assertion (M3) — the realistic per-user path ───────────────
[2'] POST IAS /oauth2/token  grant_type=jwt-bearer, assertion=<inbound token>, IAS OIDC client
        ▼ ⚠️ mint an IAS-issued id_token for the SAME user (two documented halves [13]; verify live)
[3'] POST https://cli.btp.cloud.sap/login/v2.97.0  body.jwt=<IAS id_token>,
        X-Cpcli-Subdomain=<GA subdomain>, X-Cpcli-Customidp=aejz2oiae.accounts.ondemand.com
        ▼ ✅ CLI Server returns per-user X-Cpcli-Sessionid (custom IdP mandatory [4][5])
[4'] POST command/v2.97.0/<accounts|services|security|…>?<action>  (X-Cpcli-Sessionid)
        ▼ ✅ runs AS the user, the user's BTP role collections enforced
```

**Where A works/breaks:** A1 breaks at the cis resource server (gate c) on top of two fixable config gates (a,b) — and is **undocumented**, so treat as blocked until live-proven. **A2 is the path that actually reaches "acts-as-you" for BTP account ops**, gated only by the IAS id_token mint (`[2']`, verify live) and the same-subaccount constraint (satisfied).

### 4.2 Chain B — CF (Cloud Controller ops)

```
[1] User → inbound XSUAA URL login            ✅ works
        ▼ server holds USER XSUAA access token (zid = SUBACCOUNT zone)

  ── The obvious shortcut (reuse the inbound token) ────────────────────────────────────
[2] POST CF-platform-UAA /oauth/token  jwt-bearer, assertion=<inbound XSUAA token>
        ▼
    ❌ BREAKS structurally — CF Cloud Controller is NOT connected to XSUAA [8];
        the CF platform UAA is a DIFFERENT identity zone [9] and has no registered
        IdP whose issuer == the subaccount XSUAA → "Unable to map issuer" /
        "kid references unknown signing key" (same family as arc-1 #434 [3]).

  ── Path B1: IAS id_token → cf auth --assertion (M4) — the only headless acts-as-you ───
[2'] POST IAS /oauth2/token  grant_type=jwt-bearer, assertion=<inbound token>
        ▼ ⚠️ mint an IAS id_token for the SAME user (verify live [13])
[3'] cf auth CLIENT_ID SECRET --assertion <IAS id_token>   (CF CLI ≥ 8.12 [6][7])
        → UAA jwt-bearer; UAA maps the assertion by its `iss` to the trusted IAS `-platform` IdP
        ▼ ✅ CF user token, Cloud Controller enforces the user's org/space roles
     PRECONDITIONS (one-time admin): IAS is a PLATFORM-USER IdP (-platform origin [10]);
        a jwt-bearer-grant client exists in the platform UAA zone (largely SAP-managed — verify).

  ── Path B2 / B3: documented but NOT one-login ────────────────────────────────────────
   B2  cf login --origin <origin> -u <user> -p <password>   ← SAP's automation doc [14],
        needs the user's PASSWORD, users must live directly in IAS (OIDC, not SAML).
   B3  cf login --sso → browser /passcode → paste code [12]  ← one interactive step per session.
```

**Where B works/breaks:** the inbound XSUAA token is the **wrong currency** for CF and is rejected at the zone boundary [8][9]. **B1 is the only headless acts-as-you path**, and it needs the *same* IAS id_token mint as A2 plus platform-zone trust/client config that is partly outside the customer's control. B2/B3 are documented and per-user but each adds a user step (password or passcode).

---

## 5. Verdict: One Login, Nothing Else

### CIS — **NOT reachable as a documented CIS capability; reachable for BTP account ops via the CLI Server (M3/A2) with one-time config, no per-request user step.**

- A true *CIS-REST* per-user token with zero extra steps does **not exist**: the CIS APIs are protected by **Password grant** and, subaccount-only, **Client Credentials** [1][2]. Password = the user's password (extra step, breaks SSO); Client Credentials = shared technical identity (not the user). There is **no documented jwt-bearer/user-token grant for CIS**.
- The `"grant_type": "user_token"` field in the cis service key is a **key descriptor**, not an instruction to call the XSUAA jwt-bearer endpoint — the doc's own curl examples show **only** `grant_type=password` and `grant_type=client_credentials` [1]. Treating it as RFC token-exchange is a conflation.
- **What IS reachable with no per-request user step:** route BTP account ops through the **BTP CLI Server JWT Bearer Assertion flow** (M3) using an **IAS-minted per-user id_token**. This *is* acts-as-you (the user's BTP role collections gate every `command/<ver>/…` [4][5]), gated only by the IAS id_token mint (verify live) and the same-subaccount constraint (already satisfied). It is a **different backend than the CIS REST APIs** the PoC calls today.
- **Honest caveat:** even M3 needs the user to hold the relevant BTP role collections; a user with none gets "Insufficient scope". That is correct least-privilege, but it is *more* admin overhead than the current shared identity.

### CF — **NOT reachable from the inbound XSUAA token. Reachable headlessly only by minting a per-user IAS id_token (M4/B1); otherwise one extra user step (password or passcode).**

- The Cloud Controller is **not connected to XSUAA** [8] and lives in a **separate identity zone** [9]; the inbound XSUAA token cannot be exchanged into it (the arc-1 #434 wall, here **structural and unfixable** — you cannot make the platform UAA trust your subaccount XSUAA) [3][8][9].
- The **only** headless acts-as-you path is **M4/B1**: mint an IAS id_token for the user and `cf auth --assertion` it (CF CLI ≥ 8.12 [6][7]). This depends on (i) the IAS id_token mint succeeding (verify live) and (ii) a platform-zone jwt-bearer client trusting the IAS `-platform` origin existing — partly SAP-managed.
- SAP's *documented* headless CF-with-custom-IdP path is **M6** (`cf login --origin -u -p` [14]) — but it needs the **user's password** and only works for users that exist directly in the IAS tenant. The passcode path **M5** needs one browser step per session [12]. Both are per-user but **not one-login**.

**Bottom line — do not promise pure one-login acts-as-you.** It is reachable for CF *headlessly* only through the IAS-id_token mint (M4), and for "CIS" only by redirecting BTP account ops to the CLI Server (M3) — both contingent on a **single, live-unverified primitive**: can the server mint a per-user IAS id_token from the inbound XSUAA token inside this one subaccount? If yes, **one IAS id_token covers both** M3 (BTP/CIS-equivalent) and M4 (CF). If no, every remaining per-user option costs at least one extra user step.

---

## 6. Ranked Approaches

| Rank | Approach | What it achieves | Extra user steps (freq) | UX cost (1=best,5=worst) | Security posture | Effort | Residual gaps |
|------|----------|------------------|-------------------------|:------------------------:|------------------|:------:|---------------|
| 1 | **IAS-id_token primitive → M3 (BTP/CIS via CLI Server) + M4 (CF via `cf auth --assertion`)** | True acts-as-you on **both** legs from one login | None at request time (one-time admin: IAS OIDC client + platform-user trust + CF role mapping) | 1 | **Strong** — real user identity, user's own BTP/CF authz, correct audit attribution | **L** | Whole chain hinges on the IAS id_token mint (verify live); platform-zone jwt-bearer client partly SAP-managed; CLI Server is a first-party-ish contract |
| 2 | **CF M4 + CIS M9 (split model):** CF acts-as-you via IAS id_token; CIS stays shared-technical with own scope gate | Acts-as-you on CF; honest least-privilege ceiling on CIS | None at request time (CF one-time trust/role config) | 1 | CF strong; CIS = shared identity (documented downgrade) | M | CIS audit shows tech user; per-user CIS authz not enforced |
| 3 | **CIS M1 in-zone jwt-bearer (if live-test passes) + CF M4** | Acts-as-you on both, CIS via direct REST | One-time: `uaa.user`+`Token_Exchange`+grant-chain in `xs-security.json`, cis role collections per user | 2 | Strong if it works | M–L | **CIS jwt-bearer is undocumented [1][2]; likely blocked by SAP-managed cis trust — verify before committing** |
| 4 | **CF M6 (`cf login --origin -u -p`) + CIS M2 (password grant)** | Acts-as-you on both, fully documented | User supplies **password** (+2FA) per session/credential | 4 | Strong identity, **but server holds raw credentials** — large attack surface, no SSO/MFA | S | Breaks one-login; incompatible with SSO/MFA-only users |
| 5 | **CF M5 (passcode) + CIS M3 (CLI Server)** | Acts-as-you on both | CF: one browser **passcode paste per session**; CIS: none | 3 | Strong | S–M | CF not headless; passcode repeats per token expiry |
| 6 | **Shared technical identity for both (M9) + own ARC-1-style scope/safety gate** (current PoC) | Approximates per-user authz **in the MCP layer only** | None | 1 | **Weakest** — backend sees one principal; audit attribution lost; real BTP/CF authz not enforced | S (done) | **Not acts-as-you.** Acceptable only for admin-designated shared-service ops |
| 7 | **Per-user X.509/mTLS technical users (M8)** | Stronger *technical* identity (cert, not secret) | One-time per-user cert enrolment in IAS | 2 | Better credential hygiene, **still not the end user** | L | No acts-as-you gain; heavy provisioning |

### Top-3 in prose

**Rank 1 — the IAS-id_token primitive driving M3 + M4.** This is the only design that delivers the literal goal: one inbound login, then acts-as-you on *both* CIS-equivalent BTP account ops and CF, with no per-request user interaction. Its elegance is that **one** per-user IAS-issued id_token is the universal currency — fed as the `jwt` login to the BTP CLI Server [4][5] and as `--assertion` to the CF platform UAA [6][7]. The CLI Server and CF UAA both resolve the assertion by its `iss` to the trusted custom IAS tenant and run the command as that user, enforcing the user's real role collections. Everything rides on one unproven hop — converting the inbound XSUAA token into an IAS-issued id_token via the IAS jwt-bearer endpoint (`/oauth2/token`, RFC 7523 [13]) — and on the same-subaccount constraint that arc-1 #434 already proved holds here [3]. Effort is **L** because of the IAS app registration, the platform-user `-platform` trust [10], CF role mapping, and a TypeScript port of the ~250-line CLI-Server login/command protocol. But if the single live test in §8 passes, this is the architecturally correct end state and should be the target.

**Rank 2 — split model: CF acts-as-you (M4), CIS shared-technical (M9).** This is the pragmatic PoC recommendation (see §7). It accepts an honest asymmetry: CF — where a code-proven per-user mechanism exists (`cf auth --assertion`, shipped v8.12.0 [6][7]) — becomes true acts-as-you, while CIS stays on the shared `client_credentials` identity already built, with the MCP server's own scope/safety layer (`deriveUserSafety`, `checkOperation`, `allowedSubaccounts/Orgs`, `denyActions`) approximating per-user restriction. It is honest because it does **not** claim CIS acts-as-you, and it avoids betting the PoC on the undocumented CIS jwt-bearer path or the partly-SAP-managed platform-zone client. The residual gap is real and must be stated to stakeholders: on CIS the backend audit shows the technical user, and the user's *real* BTP authorizations are not enforced by SAP.

**Rank 3 — CIS in-zone jwt-bearer (M1) if and only if a live test passes.** Tempting because CIS and the app XSUAA share one zone, so in-zone XSUAA token exchange is *structurally* permitted [11], and the wiring (add `uaa.user` + `Token_Exchange` + a grant-chain to `xs-security.json`, assign cis role collections) is bounded. But two SAP-doc facts make it high-risk: (1) the CIS APIs document **only** Password + Client-Credentials grants [1][2] — jwt-bearer is undocumented for the cis resource server; and (2) the cis app is **SAP-managed**, so there is no evidence it will `granted-apps`-grant its scopes to an arbitrary customer app for foreign-scope exchange — without that, the exchanged token comes back with no cis scopes and CIS returns 403 (the KBA 3355232 failure class). Do **not** build on M1 until the §8 live test returns a 200 with cis scopes in the token.

---

## 7. Recommendation for the PoC + Implementation Plan

**Recommendation: adopt the Rank-2 split model now, with the code wired so Rank-1 is a drop-in later.**

- **CF → per-user (M4).** Implement the IAS-id_token → `cf auth --assertion` path. This is the highest-value, lowest-regret change: it is the *only* code-proven per-user mechanism for either backend [6][7], and it directly closes the "act as the user on CF" gap.
- **CIS → keep shared `client_credentials` (M9) for now**, documented honestly as *not* acts-as-you, with the existing MCP scope/safety gate as defense-in-depth. **Do not** wire CIS jwt-bearer until the §8 live test proves the cis resource server accepts it. If/when M3 (CLI Server) is built for BTP account ops, route account ops there for true per-user.
- **Both legs converge on one helper:** an **IAS jwt-bearer token-mint** that turns the inbound XSUAA token into a per-user IAS id_token. Build it once; it feeds both M4 (CF, now) and M3 (CLI Server, later).

### 7.1 Which grant / which token

| Leg | Grant to mint the per-user credential | Credential fed outbound |
|-----|---------------------------------------|--------------------------|
| **IAS mint (shared helper)** | `POST https://aejz2oiae.accounts.ondemand.com/oauth2/token`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<inbound XSUAA token>`, IAS OIDC `client_id`/`secret` [13] | An **IAS-issued id_token** for the same user |
| **CF (M4, now)** | CF UAA jwt-bearer via `cf auth … --assertion <IAS id_token>` semantics (`GrantTypeJwtBearer`) [6][7] | A **CF user access token** → `CfClient` |
| **BTP account (M3, later)** | `POST https://cli.btp.cloud.sap/login/v2.97.0`, `body.jwt=<IAS id_token>`, `X-Cpcli-Customidp`, `X-Cpcli-Subdomain` [4][5] | A per-user **`X-Cpcli-Sessionid`** replayed on every `command/<ver>/…` |

### 7.2 Minimal code wiring (threading `extra.authInfo.token` → dispatch → outbound clients)

The inbound token is **already in hand** — `src/server.ts` reads `extra.authInfo?.token` today (only `decodeClaims` uses it). Three localized edits, exactly the swap `src/btp.ts`'s top comment anticipates ("the seam where the PoC's shared client_credentials identity will later become a request-scoped per-user token … that swap also threads the inbound token through dispatch"):

1. **`src/server.ts`** — in the `CallToolRequestSchema` handler, capture and forward the token:
   ```ts
   const userJwt = extra.authInfo?.token;            // already present (whoami uses it)
   return dispatch(req.params.name, args, scopes, config, clients, userJwt);
   ```

2. **`src/handlers.ts`** — extend `dispatch(name, args, scopes, config, clients, userJwt?)`. For the **CF** path, build a **request-scoped** `CfClient` from a new per-user provider instead of the long-lived shared client (mirrors arc-1's `applyPerUserAuthTokens` → `bearerTokenProvider: async () => bearer` → `Authorization: Bearer <user token>` in `src/server/server.ts`/`src/adt/http.ts`). Leave the **CIS** path on the shared `CisClient` for now.

3. **`src/btp.ts`** — add two providers behind the existing `TokenProvider` seam (no call-site change to `getJson`/`runCf`):
   ```ts
   // Mint a per-user IAS id_token from the inbound XSUAA token (RFC 7523, same IAS tenant).
   class IasIdTokenProvider {
     constructor(private iasTokenUrl: string, private clientId: string, private clientSecret: string, private userJwt: string) {}
     async getIdToken(): Promise<string> {
       const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
       const res = await fetch(this.iasTokenUrl, { method: 'POST',
         headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
         body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.userJwt }).toString() });
       if (!res.ok) throw new BackendError(res.status);
       const d = await res.json() as { id_token?: string; access_token: string };
       return d.id_token ?? d.access_token;            // verify which field the tenant returns (§8)
     }
   }
   // CF UAA jwt-bearer: exchange the IAS id_token for a CF user access token.
   class CfAssertionTokenProvider implements TokenProvider {
     constructor(private cfUaaTokenUrl: string, private ias: IasIdTokenProvider, private cfClientId = 'cf') {}
     async getToken(): Promise<string> {
       const idToken = await this.ias.getIdToken();
       const res = await fetch(this.cfUaaTokenUrl, { method: 'POST',
         headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
         body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: idToken, client_id: this.cfClientId, response_type: 'token' }).toString() });
       if (!res.ok) throw new BackendError(res.status);
       return (await res.json() as { access_token: string }).access_token;
     }
   }
   ```
   Then per request: `new CfClient(cfApi, new CfAssertionTokenProvider(cfUaaTokenUrl, new IasIdTokenProvider(iasTokenUrl, iasClientId, iasSecret, userJwt)))`.

**Reuse of `@arc-mcp/xsuaa-auth/btp`.** The published `./btp` export surfaces `lookupDestinationWithUserToken`, `lookupDestination`, `resolveBTPDestination`, `createConnectivityProxy`, `parseVCAPServices` — it is **Destination-Service-centric** and performs the grant *through a BTP Destination* via `getDestination({ isolationStrategy: 'tenant-user' })`; the only raw helper (`fetchClientCredentialsToken`) is client-credentials-only, and the one jwt-bearer call inside is hard-wired to the Connectivity Service and discards its result. So **for CIS** you could front the cis UAA with a Destination of type `OAuth2UserTokenExchange` and reuse `lookupDestinationWithUserToken` verbatim (it returns `authTokens.bearerToken`) — but that still rides the *same undocumented CIS jwt-bearer assumption* as M1, so spike it only after the §8 CIS test. **For CF** the package offers nothing reusable (no Destination type bridges the platform-UAA zone), so the two small providers above are the right call — they reuse the **pattern** (`bearerTokenProvider`/`TokenProvider` injection) rather than the package code. Keep the `IasIdTokenProvider` separate so it can later feed the M3 CLI-Server login unchanged.

### 7.3 Honesty in the tool surface

Keep `whoami` and extend it to show, per leg, whether the call will act as the user or as the shared identity. Never let the docs claim per-user CIS while M9 is in force.

---

## 8. Open Questions to Verify LIVE on the Dev Subaccount

Run these against `zid 65647146-…`, region `cf-us10`, IAS tenant `aejz2oiae.accounts.ondemand.com`. The **single most important** is OQ-1 (the IAS id_token mint) — the whole Rank-1/Rank-2-CF design depends on it.

**OQ-1 (CRITICAL) — can the inbound XSUAA token be minted into a per-user IAS id_token?**
```bash
# Use a real inbound token captured from a `whoami` call (USER_XSUAA_JWT).
curl -s -L -X POST "https://aejz2oiae.accounts.ondemand.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "<IAS_OIDC_CLIENT_ID>:<IAS_OIDC_CLIENT_SECRET>" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "assertion=${USER_XSUAA_JWT}" | tee /tmp/ias.json
# Expect: 200 with an `id_token` (or `access_token`) whose `sub`/`email` = the user and `iss` = the IAS tenant.
# Decode and check `iss`, `aud`, `sub`, `email`:
python3 -c "import json,base64,sys;t=json.load(open('/tmp/ias.json'));tok=t.get('id_token',t.get('access_token'));p=tok.split('.')[1];print(json.dumps(json.loads(base64.urlsafe_b64decode(p+'=='*(-len(p)%4))),indent=2))"
```
If this fails, the one-login design collapses to the password/passcode fallbacks (Rank 4/5).

**OQ-2 — does `cf auth --assertion` accept that IAS id_token for the user?**
```bash
cf api https://api.cf.us10-001.hana.ondemand.com
cf auth cf "" --assertion "$(python3 -c "import json;print(json.load(open('/tmp/ias.json'))['id_token'])")"   # CF CLI >= 8.12
cf oauth-token            # confirm a USER token with cloud_controller.* and the user's org/space roles
cf orgs                   # should reflect the user's real CF roles, not a tech identity's
```
Also confirm the IAS **`-platform`** origin is registered/trusted in the CF subaccount and a jwt-bearer-grant client exists in the platform UAA zone (largely SAP-managed).

**OQ-3 — contrast: confirm the inbound XSUAA token is REJECTED by CF UAA directly** (documents the zone wall):
```bash
curl -s -L -X POST "https://uaa.cf.us10-001.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "assertion=${USER_XSUAA_JWT}" -d "client_id=cf"
# Expect: error mapping the issuer (e.g. "Unable to map issuer") — proves M4 needs the IAS id_token, not the XSUAA token.
```

**OQ-4 — does the BTP CLI Server accept the IAS id_token as a login assertion (M3)?**
```bash
SUBDOMAIN="<global-account-subdomain>"; IDP="aejz2oiae.accounts.ondemand.com"
curl -s -i -X POST "https://cli.btp.cloud.sap/login/v2.97.0" \
  -H "Content-Type: application/json" -H "X-Cpcli-Format: json" \
  -H "X-Cpcli-Subdomain: ${SUBDOMAIN}" -H "X-Cpcli-Customidp: ${IDP}" \
  -d "$(python3 -c "import json;print(json.dumps({'customIdp':'${IDP}','subdomain':'${SUBDOMAIN}','jwt':json.load(open('/tmp/ias.json'))['id_token']}))")"
# Expect: 200 + an `X-Cpcli-Sessionid` response header (per-user session). 412 = send a newer <ver>;
#         400 "Invalid provider configuration" = wrong audience on the assertion.
```

**OQ-5 (only if pursuing Rank-3 M1) — does the cis resource server accept an in-zone jwt-bearer USER token?** After adding `uaa.user` + `Token_Exchange` to `xs-security.json`, redeploying, wiring the grant-chain, and assigning cis role collections to the test user:
```bash
CIS_UAA_URL="<cis uaa.url>"
curl -s -L -X POST "${CIS_UAA_URL}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "<CIS_CLIENTID>:<CIS_CLIENTSECRET>" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "assertion=${USER_XSUAA_JWT}" | tee /tmp/cis.json
# Decode `scope` — does it contain the cis app's scopes (e.g. <cis-xsappname>.job.read, account/entitlement scopes)?
# Then call a real CIS endpoint as the user and confirm 200 (not 403):
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/cis.json'))['access_token'])")
curl -s -H "Authorization: bearer ${TOKEN}" "<provisioning_service_url>/provisioning/v1/environments"
```
A 403 or an empty/`uaa.user`-only scope set confirms M1 is blocked for CIS — fall back to M3 (CLI Server) for per-user BTP account ops.

**OQ-6 — refresh-token / session lifetimes** that drive how often any fallback re-prompts: CF platform-UAA refresh-token TTL in `us10`; CLI-Server session TTL (the joule toolkit notes ~12h sessions). Confirm both so the UX cost of M5/M6 is accurate.

---

## 9. Sources

1. SAP Help — *Getting an Access Token for SAP Cloud Management Service APIs* (CIS protected by **Password grant** + subaccount-only **Client Credentials**; curl examples show only `grant_type=password`/`client_credentials`; `"grant_type":"user_token"` is a service-key descriptor field; "Two-factor authentication is only relevant for Password grant"; access token carries only its granted scopes). https://help.sap.com/docs/btp/sap-business-technology-platform/getting-access-token-for-sap-cloud-management-service-apis
2. SAP Help — *SAP Cloud Management Service — Service Plans* ("Credentials or Password grant type token …"; `central-viewer`/`local-viewer` plans are Client-Credentials-only). https://help.sap.com/docs/BTP/65de2977205c403bbc107264b8eccf4b/a508b724bf6d457ca7ac024b8e4b8457.html
3. arc-1 internal memory — `project_issue_434_cross_subaccount_usertokenexchange` (live-reproduced: in-zone XSUAA jwt-bearer works; cross-subaccount fails `kid references unknown signing key` / `Unable to map issuer`).
4. SAP/terraform-provider-btp — `internal/btpcli/client.go` (`DefaultServerURL = https://cli.btp.cloud.sap`; `cliTargetProtocolVersion = v2.97.0`; `X-Cpcli-Sessionid` from `HeaderCLISessionId`; per-command headers `X-Cpcli-Sessionid`/`X-Cpcli-Subdomain`/`X-Cpcli-Customidp`; login endpoints `login/<ver>`, `login/<ver>/idtoken`, `login/<ver>/browser`; command path `command/<ver>/<command>?<action>`). https://github.com/SAP/terraform-provider-btp/blob/main/internal/btpcli/client.go
5. SAP/terraform-provider-btp — `templates/index.md.tmpl` (the **JWT Bearer Assertion flow** "requires a custom identity provider"; `idtoken` is "SAP-internal use only"; SSO "not intended for … containerized environments or CI/CD pipelines"; X.509 flow; username/password "not compatible with SAP Universal ID"; env vars `BTP_ASSERTION`/`BTP_ENABLE_SSO`/`USE_BTPCLI_SESSION`/`BTP_USERNAME`/`BTP_PASSWORD`). https://github.com/SAP/terraform-provider-btp/blob/main/templates/index.md.tmpl
6. cloudfoundry/cli — `command/v7/auth_command.go` (`--assertion` flag "Token based authentication with assertion (user) or in combination with client-credentials (non-user)"; `constant.GrantTypeJwtBearer`; user-assertion → jwt-bearer, `--client-credentials --assertion` → `client_assertion` of type `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`; `--origin` enforces a UAA-version check and cannot combine with `--client-credentials`). https://github.com/cloudfoundry/cli/blob/main/command/v7/auth_command.go
7. cloudfoundry/cli — release **v8.12.0** ("[v8] Allow CF Authentication based on Tokens - user and client tokens by @strehle in #3455"; `--assertion` absent in v8.11.0). https://github.com/cloudfoundry/cli/releases/tag/v8.12.0
8. SAP Community Q&A — *How to access Cloud Foundry Controller API?* (SAP staff: "The CF Cloud Controller API is currently not connected to XSUAA and thus it is not possible to obtain a token from there"; use the CF UAA `login.cf.<region>.hana.ondemand.com/oauth/token`, Basic `cf:` empty secret, `grant_type=password`, scopes `cloud_controller.read`/`cloud_controller.write`). https://community.sap.com/t5/technology-q-a/how-to-access-cloud-foundry-controller-api/qaq-p/12144361
9. Cloud Foundry Docs — *UAA concepts* (identity zones are isolated logical boundaries; two zones ≈ two separate UAA deployments — separate clients/users/IdPs/signing keys, distinguished by subdomain). https://docs.cloudfoundry.org/uaa/uaa-concepts.html
10. SAP Help — *Establish Trust and Federation of Custom Identity Providers for Platform Users* (custom IdP for **platform** users, global-account level; origin key found under Security → Trust Configuration → Custom Platform Identity Providers; platform-user origin distinct from the application origin). https://help.sap.com/docs/BTP/65de2977205c403bbc107264b8eccf4b/c36898473d704e07a33268c9f9d29515.html
11. SAP/cloud-security-services-integration-library — `token-client/README.md` ("Token exchange is only supported within the same Identity zone/tenant … call the `/oauth/token` endpoint of the same subdomain that was used for the original token"; documents JWT Bearer / Client Credentials / Refresh / Password flows; jwt-bearer takes an existing user token and preserves the user for a different service). https://github.com/SAP/cloud-security-services-integration-library/blob/main/token-client/README.md
12. Cloud Foundry CLI Reference — `cf login --sso` / `--sso-passcode` (one-time passcode from the authenticated browser session at the UAA `/passcode` URL). https://cli.cloudfoundry.org/en-US/v6/login.html
13. SAP Help (Cloud Identity Services) — *Use JWT Bearer Flow* / *Configure OpenID Connect Application for Token Exchange* (IAS `/oauth2/token`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<id_token>`, RFC 7523/8693; same-tenant only). https://help.sap.com/docs/cloud-identity-services/cloud-identity-services/using-jwt-bearer-flow
14. SAP Help — *Log On as a Technical User With a Custom Identity Provider* (headless CF automation = `cf login --origin <origin> -u <user> -p <password>`; users must exist **directly** in the SAP Cloud Identity Services tenant, OIDC not SAML; corporate IdP must support password grant). https://help.sap.com/docs/BTP/65de2977205c403bbc107264b8eccf4b/98ec56a6dd4347b6ad466aaab19ded02.html
15. SAP Help — *Log On with a Custom Identity Provider to the Cloud Foundry Environment Using the cf CLI* (interactive = browser SSO; automation = technical-user origin path; "only supported if the users exist directly in your tenant of SAP Cloud Identity Services"). https://help.sap.com/docs/BTP/65de2977205c403bbc107264b8eccf4b/d477618e861c48d2976e03f9b6a3cfe8.html
16. SAP Cloud SDK (Java) — *Cloud Foundry XSUAA Explained* (one XSUAA instance per subaccount; tenant-qualified `xsappname!t<index>`; grant-type use cases: User Login = Authorization Code, on-behalf-of-user = JWT Bearer, on-behalf-of-service = Client Credentials). https://sap.github.io/cloud-sdk/docs/java/guides/cloud-foundry-xsuaa-service
17. SAP Community blog — *Authenticating GitHub Actions Workflows Deploying to SAP BTP Cloud Foundry with JWTs* (`cf auth --assertion`; IAS GitHub-OIDC corporate IdP; NameID/origin mapping). https://community.sap.com/t5/technology-blog-posts-by-sap/authenticating-github-actions-workflows-deploying-to-the-sap-btp-cloud/ba-p/14075047
18. dev.to (Vipin Menon) — *Bye-Bye Credentials! Automate BTP & Cloud Foundry Setup with Terraform using GitHub OIDC* (the *same* raw OIDC id_token used as `BTP_ASSERTION` and `CF_ASSERTION_TOKEN`; IAS validates the assertion against the external IdP's JWKS; `aud` = IAS tenant issuer URI). https://dev.to/vipinvkmenon/bye-bye-credentials-automate-btp-cloud-foundry-setup-with-terraform-using-github-actions-and-3m07
19. SAP-samples/joule-a2a-agent-toolkit — `skills/btp-cli/SKILL.md` (SAP's own AI-agent BTP skill: per-user `btp login`, role collections enforced — "Insufficient scope" when missing; ~12h sessions). https://github.com/SAP-samples/joule-a2a-agent-toolkit/blob/main/skills/btp-cli/SKILL.md
20. SAP KBA 2876853 — *User does not have scope "uaa.user" / JWT does not include scope "uaa.user"* (mandatory for user-token / jwt-bearer user flows). https://userapps.support.sap.com/sap/support/knowledge/en/2876853
21. SAP KBA 3355232 — *Scopes are missing in OAuth access token for SAP Cloud Management Service APIs* (a user-grant token can return only `openid user_attributes uaa.user` and 403 on CIS when the cis scopes are not assigned). https://userapps.support.sap.com/sap/support/knowledge/en/3355232
22. Local source — `~/DEV/btp-cf-mcp/src/{server,handlers,btp,config}.ts` + `xs-security.json` (inbound `extra.authInfo.token` available; `TokenProvider` seam; shared `ClientCredentialsProvider` for CIS; `xs-security.json` has no `uaa.user`/`Token_Exchange`/grant-chain) and `~/DEV/btp-cf-mcp/node_modules/@arc-mcp/xsuaa-auth/dist/btp.d.ts` + `dist/btp/{destination,vcap}.d.ts` (public `./btp` surface: `lookupDestinationWithUserToken`, `PerUserAuthTokens`, `fetchClientCredentialsToken` client-credentials-only).
23. Local source — `~/DEV/arc-1/src/server/server.ts` (`extra.authInfo?.token`, `isJwt = token.split('.').length === 3`, `lookupDestinationWithUserToken`, `applyPerUserAuthTokens` → `adtConfig.bearerTokenProvider = async () => bearer`) + `src/adt/http.ts` (`Authorization: Bearer <user token>`) — the reusable per-user threading pattern.
