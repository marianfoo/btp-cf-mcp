# btp-cf-mcp — Architecture, Decisions & Implementation Plan

**Date:** 2026-06-30 · **Status:** DRAFT for review — every ADR below is **Proposed → your call** · **Scope:** turn the proven PoC + per-user research into a buildable plan.

> **How to read this:** §3 is the point — the **ADRs (decisions)**. Each has options + a recommendation + status. Skim §1–2 for context, decide §3, and §4–5 are the build/quality plan that follows from your decisions. Companion docs: [per-user research trail](../research/2026-06-30-per-user-outbound-auth.md), [admin setup guide](../guides/per-user-ias-auth-setup.md), [related BTP MCP servers](../research/2026-06-30-related-btp-mcp-servers.md).

---

## 1. Where we are (the PoC + what's proven)

**Deployed PoC** (`btp-cf-mcp-dev.cfapps.us10-001.hana.ondemand.com`, dev subaccount):
- **Inbound:** `@arc-mcp/xsuaa-auth` `setupHttpAuth` — XSUAA OAuth URL-login **+** API key, chained verifier, scopes `read`/`write`/`admin` from XSUAA role collections; fail-closed.
- **Outbound:** CIS (BTPAccount tool) via shared `client_credentials`; CF (CloudFoundry tool) via a static env token (`StaticTokenProvider`).
- **Safety ceiling (arc-1 model):** read-only by default (`ALLOW_WRITES`), `ACTION_POLICY` scope gate, fail-closed target allowlist (`requireTarget`), `DENY_ACTIONS`, safety-aware tool pruning, `whoami` diagnostic. 19 unit tests, Codex-reviewed (P0/P1 fixed).

**Per-user research — settled (live-proven):**
| Operation surface | Per-user "acts as you"? | Mechanism |
|---|---|---|
| **CF** (apps/spaces/services/orgs) | ✅ proven end-to-end (incl. role loop) | IAS-first login → IAS app-to-app exchange → `cf auth --assertion` |
| **BTP account ops** (subaccounts/entitlements/environments/role-collections) | ✅ proven | same exchange → `btp login --jwt` (CLI Server) |
| **CIS REST** (a transport) | ❌ no per-user grant | shared `client_credentials` only |

**The one architectural fact that drives everything:** per-user requires the server to hold the user's **IAS** id_token (the app-to-app exchange is an IAS feature; an XSUAA token **cannot** be exchanged into IAS — trust is IAS→XSUAA, one-directional, live-proven). So **per-user ⇒ IAS-first inbound.**

---

## 2. Target architecture (if per-user is adopted)

```
 MCP client ──OAuth──▶ [btp-cf-mcp]  ── inbound: IAS OIDC (server proxies the MCP OAuth flow to IAS)
                            │  holds the user's IAS id_token + derived MCP scopes (read/write/admin)
        ┌───────────────────┼────────────────────────────┐
        ▼ scope ∧ safety gate (arc-1 model, defense-in-depth)
   dispatch(name,args,scopes,userJwt)
        │
        ├─▶ CF  : per-user  — IAS app-to-app exchange(userJwt) → CF token → Cloud Controller (user's CF roles)
        ├─▶ BTP : per-user  — same exchange → CLI Server (`btp login --jwt`) → account ops (user's BTP roles)  [DECIDED in scope]
        └─▶ CIS : fallback  — shared client_credentials → CIS REST, only where the CLI Server can't reach (gated)
```

**Two authorization layers (keep both):**
1. **MCP scope gate** (`read`/`write`/`admin` + allowlists + deny) — coarse, server-side, prunes the LLM surface and enforces read-only-by-default. Defense in depth.
2. **Real BTP/CF authorization** — enforced by SAP against the *user's* roles (per-user) or the *technical identity's* roles (shared CIS).

---

## 3. Architecture Decision Records (Proposed — decide these)

> Convention (from arc-1): on acceptance these split into `docs/architecture/adr/000N-title.md` with status `Accepted`. Format: Context · Options · Decision · Consequences.

> **✅ Decisions taken (2026-06-30, user):** **(D8)** tool surface = **≤12 resource-split adopted** (ADR-016) + port the single-source registry (D10); **(scope)** per-user = **CF *and* BTP account ops, both per-user** — BTP via the **CLI Server** (**ADR-004 promoted: deferred → in-scope**; **ADR-003 CIS REST demoted → fallback**); **(confirmed)** IAS-first inbound (ADR-001-B) + **server-issued token** (ADR-009) + **pre-registration not DCR** (D9) + spec **2025-11-25 stateless** (ADR-017) + MTA (ADR-006) + arc-1 quality (ADR-008). Those ADRs are now **Accepted**; the rest stay Proposed. **Next step chosen: a second Codex review of this updated plan.** Trade-off accepted: full per-user adds the CLI-Server build to the critical path (heavier than CF-only).

### ADR-001 — Inbound authentication: **IAS-first OIDC** (supersede XSUAA inbound)  ⭐ load-bearing
**Context.** The PoC logs users in via XSUAA. Per-user outbound (CF + BTP account ops) is **proven to require an IAS id_token**, and XSUAA→IAS exchange is impossible. So the inbound identity must be IAS for per-user to work at all.
**Options.**
- **A. Keep XSUAA inbound** → per-user is *impossible*; CF/BTP stay shared-technical. Simplest; honest if per-user isn't a goal.
- **B. IAS-first OIDC inbound** → server holds the IAS id_token → drives per-user CF/BTP. MCP scopes derived from **IAS groups** (or a coarse api-key/role mapping). ⭐ recommended *if per-user is the goal*.
- **C. Dual (XSUAA + IAS)** → two login paths, two scope models. Most complex; only if you must serve both shared and per-user simultaneously.
**Decision (proposed).** **B**, gated on you confirming per-user is a product goal (it was the whole investigation). If per-user is *not* required, choose **A** and stop at the current PoC + hardening.
**Consequences.** + true acts-as-you; correct audit; least-privilege via BTP roles. − lose the XSUAA role-collection scope model (replace with IAS-groups→scopes); **requires an MCP-OAuth-proxy to IAS** (ADR-007, the main build risk); the login screen becomes the IAS login.
**Note on XSUAA's fate.** Under **B**, the **`xsuaa` application instance is dropped for inbound** — login is IAS-OIDC and MCP scopes come from IAS groups, so no XSUAA binding/`xs-security.json` is needed. The only XSUAA still in play is the `cis` key's *own* UAA, which the `cis` service manages internally (not a binding we own). ⇒ **MTA (ADR-006) binds no `xsuaa`** under B — a real deployment simplification. Under **A** (keep XSUAA inbound), `xsuaa` + `xs-security.json` stay as today.

### ADR-002 — Per-user CF outbound via the IAS app-to-app exchange
**Context.** Proven recipe: IAS id_token → `POST {ias}/oauth2/token` (`grant_type=jwt-bearer`, confidential client, `resource=urn:sap:identity:application:provider:clientid:<cf-platform>`) → token `aud=<cf-platform>` → `cf auth --assertion`.
**Decision (proposed).** Implement a **request-scoped `CfClient`** built from the **server-stored IAS credential for the session** (per **ADR-009** — looked up by the MCP subject, **not** the raw client bearer): exchange → CF token, cached per `(user, audience)` with exp-aware refresh. Depends on ADR-001 + ADR-009.
**Consequences.** + per-user CF, SAP-enforced. − the user needs CF roles under the IAS-platform origin (admin step); short-lived tokens need refresh handling.

### ADR-003 — CIS stays **shared technical** (`client_credentials`)
**Context.** Per-user CIS REST is live-proven impossible (exchange yields a scopeless token; CIS 502).
**Decision (proposed).** Keep CIS on a shared `cis local` `client_credentials` key + the MCP scope/safety gate. **Document honestly as *not* acts-as-you.** Where per-user BTP *account* operations are genuinely needed, route them through the CLI Server (ADR-004), not CIS REST.
**Consequences.** + simple, works. − **even reads are not SAP-authorized as the user** and may be sensitive; CIS audit shows the technical user; the MCP scope/allowlist gate is the only restriction → **mark BTPAccount as shared-technical in the tool surface (ADR-012).**
**Update (decision 2026-06-30 — DEMOTED to fallback).** Since BTP account ops are now per-user via the CLI Server (ADR-004), the `BTP*` tools route through the **CLI Server by default**; CIS REST is kept only as a **fallback** for ops the CLI Server can't reach, or an explicit shared-admin mode. Its shared-technical caveats above apply *only on that fallback path*.

### ADR-004 — BTP account ops per-user via the **CLI Server** — ✅ **ACCEPTED (in scope, primary `BTP*` backend)**
**Context.** Proven (`btp login --jwt` accepts the same propagation token; lists subaccounts as the user). But the CLI Server is a heavier protocol (`X-Cpcli-Sessionid`, `command/<ver>/<cmd>?<action>`).
**Options.** (a) shell out to a bundled `btp` binary (per-request `BTP_CLIENTCONFIG` isolation) — simplest; (b) reimplement the CLI Server REST protocol in TS (like `terraform-provider-btp`) — cleaner, more code.
**Decision (2026-06-30 — ✅ ACCEPTED, in scope).** The CLI Server is the **primary per-user backend for the `BTP*` tool family** (reads *and* writes — so all account ops are attributable to the human, not the shared CIS identity). **Build order:** (a) spike via a **bundled `btp` binary** (per-request `BTP_CLIENTCONFIG` isolation) to prove the per-user account loop end-to-end, then (b) **reimplement the CLI Server REST protocol in TS** for production (honours AGENTS.md principle 4 "prefer REST"; like `terraform-provider-btp`). CIS REST (ADR-003) stays only as a fallback.
**Consequences.** + uniform per-user surface (CF + BTP both acts-as-you); near-free auth given ADR-002's exchange (same token). − **adds real build weight to the critical path** (the CLI Server protocol: `X-Cpcli-Sessionid`, `command/<ver>/<cmd>?<action>`, the `btp login --jwt` session) — heavier than the CF-only path; binary bundling for the spike, then a REST reimpl.
**CLI-binary spike hardening (Codex #6 — it's a constrained spike, not a production bridge).** `BTP_CLIENTCONFIG` isolation alone is insufficient: per-request **unique temp config dir + isolated `HOME` + `umask 077` + guaranteed cleanup**; **`execFile` not a shell**; **pass `--jwt` via env/stdin, never argv** (argv is world-readable in the process list); **bounded concurrency + hard timeouts + redacted stdout/stderr**. Per-request login is safest but slow; any per-user persisted CLI config must live in the **same sealed/shared store as ADR-009**, not on local disk (breaks stateless/multi-instance). The production REST reimpl is realistic only if **scoped to the action registry** (the `BTP*` actions we expose), not "reimplement the whole `btp` CLI."

### ADR-005 — Authorization model: MCP scope gate **+** delegate real authz to BTP roles
**Context.** Two layers exist; keep both.
**Decision (proposed).** Retain the arc-1-style `ACTION_POLICY` (scope per `Tool.action`), `deriveUserSafety` (scopes narrow the ceiling), `requireTarget` (fail-closed allowlist), `DENY_ACTIONS`, and safety-aware tool pruning **as defense-in-depth + LLM-surface control**. The *authoritative* authz is the user's BTP/CF roles (per-user) or the technical identity's roles (shared). Derive MCP scopes from **IAS groups** under ADR-001-B.
**Consequences.** + a hard read-only-by-default ceiling independent of SAP; pruned LLM surface. − two places define "what's allowed" — keep them consistent (the MCP gate must never be *more* permissive than intended).

### ADR-006 — Deployment: **MTA** (over `cf push` manifest)
**Context.** PoC uses `manifest.yml` + manual `cf create-service`. There's also background automation on the account that re-targets `cf` (it deleted a freshly-pushed app mid-deploy), making ad-hoc `cf push` fragile.
**Options.** A. keep `manifest.yml` + a deploy script; B. **MTA** (`mta.yaml`) — declaratively bundles the app + service instances (xsuaa, destination, the `cis` key) + bindings; reproducible; arc-1 uses it.
**Decision (proposed).** **MTA** for the CF side (app + service instances + bindings). The **IAS OIDC app is an IAS-side prerequisite** (created in the IAS admin console / SCI API, *not* MTA) — documented in the admin setup guide. Deploy with `mbt build` + `cf deploy` in a clean, isolated `CF_HOME`.
**Consequences.** + reproducible, survives the cf-target-flip; one descriptor. − MTA toolchain (`mbt`); IAS app stays a manual/scripted prerequisite (unavoidable — IAS isn't in MTA).

### ADR-007 — Inbound MCP-OAuth proxy to IAS: **extend `@arc-mcp/xsuaa-auth` or build thin** ⭐ main build risk
**Context.** ADR-001-B needs the server to be an OAuth **authorization server** for MCP clients (DCR + `/authorize` + `/token` + metadata) that delegates to **IAS**. `@arc-mcp/xsuaa-auth`'s `setupHttpAuth` proxy is **XSUAA-specific**; its `createOidcVerifier` validates IAS tokens but doesn't provide the proxy/DCR for an IAS upstream. IAS doesn't support open DCR, so MCP clients can't register at IAS directly — the server must proxy (fixed IAS app behind a server-issued DCR).
**Options.** A. **Extend `@arc-mcp/xsuaa-auth`** to accept an IAS upstream (reuse its DCR store + state codec + callback) — contribute back; B. **Build a thin IAS OAuth proxy** in this repo (the test harness already does the auth-code+PKCE+callback against IAS — productionize it + add DCR + metadata).
**Decision (proposed).** **Prototype B** (fastest path to a working per-user login; we already have the IAS auth-code flow), then **upstream to A** if it generalizes cleanly. Reuse `@arc-mcp/xsuaa-auth`'s `StatelessDcrClientStore` + `OAuthStateCodec` if they're upstream-agnostic.
**Refine (post-research, materially shrinks this).** The MCP spec makes **DCR only OPTIONAL (MAY)** — the recommended registration path is **Client ID Metadata Documents (CIMD, SHOULD)** or **pre-registration**. So the proxy need **not host a DCR endpoint**: **start with pre-registered client-ids** (simplest, fine for a known client set like Claude/VS Code/Cursor), add CIMD if open onboarding is needed. This drops the single biggest piece of the "riskiest task." Still required (ADR-017): the OAuth-server metadata, `/authorize`+`/token`, callback, **MCP-token issuance**, and **server-side IAS credential storage (ADR-009)**.
**Consequences.** + unblocks ADR-001-B. − it's an **OAuth/session proxy** — DCR · metadata · `/authorize`+`/token` · callback · **MCP-token issuance** + **server-side IAS id/refresh storage (ADR-009)** · refresh · resource binding — **not** a "thin" proxy; the riskiest/biggest single task. **Spike it first** against the full ADR-014 criteria (below).

### ADR-008 — Code quality & tooling: **mirror arc-1, scaled for ~10 files**
**Context.** Repo currently has no biome/AGENTS.md/Husky/CI. arc-1's setup is the model.
**Decision (proposed).** Adopt the **Phase-0 minimum now** (see §5): `biome.json` (copy verbatim), strict `tsconfig.json` + `tsconfig.tests.json`, Husky + lint-staged (Biome auto-fix on commit), a single `vitest.config.ts` + `tests/helpers/skip-policy.ts`, a `.github/workflows/test.yml` (lint · typecheck · `npm audit --audit-level=high` · build · unit tests on Node 22+), conventional commits + `release-please-config.json`, and an `AGENTS.md` as the single source of truth. **Defer** the file-size ratchet, Docker, security-scan, and integration/e2e until there's a reason.
**Consequences.** + production-grade gate in ~a day; never hand-fix formatting; automated releases. − minor upfront setup. **Refine:** do NOT defer auth integration/contract tests (ADR-014) — they're the riskiest part.

### ADR-009 — Token/session architecture: server-issued MCP token, IAS credential held server-side ⭐ (added post-review)
**Context.** The MCP spec requires the client-facing bearer to be **audience-bound to THIS server** and **warns against token passthrough**. The proven flow obtained the user's IAS id_token via a *direct* IAS login (test harness); in production the server is the OAuth **authorization server** for MCP clients. The current code only sees the *client-presented* bearer (`src/server.ts` `authInfo.token`) — that must NOT be the raw IAS token.
**Decision (proposed).** The server (via the ADR-007 proxy) **issues its own MCP access tokens** (aud = this server) to clients, and **stores the user's IAS id_token + refresh token server-side**, keyed to the MCP session/subject. Outbound exchanges (ADR-002) use the **server-stored IAS credential looked up by session**, never a client-passed token. This **supersedes the "thread `authInfo.token`" shorthand** in ADR-002.
**Credential custody — resolves the stateless × multi-instance tension (Codex #2).** "Stateless" = transport/session-stateless; the per-user IAS id/refresh credential must still survive across the ≥2 CF instances. Two options:
- **(i) Sealed-into-token — recommended, truly stateless, the arc-1 pattern:** the server-issued MCP token **carries the IAS refresh token encrypted** (a sealed claim, server-secret-keyed — arc-1's `OAuthStateCodec` does exactly this). Any instance decrypts with the shared secret ⇒ **no external store**. The client holds only opaque ciphertext (**not** passthrough — only the server can decrypt/use it). Revocation = short access-token TTL + a small deny-list + sealing-secret rotation.
- **(ii) Shared encrypted store:** a bound Redis / Postgres / BTP Credential Store, keyed by `subject`+`client_id`/grant-id; revocable by delete. Needs infra.

**Decision:** start with **(i)** (no infra, multi-instance-safe by construction); add (ii) only if instant revocation or token size forces it.
**Consequences.** + MCP-compliant, no passthrough, multi-instance without sticky sessions, refresh server-side. − sealing-secret rotation runbook (ADR-015); under (i) revocation is TTL/deny-list-based, not instant. Owned by the ADR-007 proxy.

### ADR-010 — IAS groups → MCP scopes (load-bearing, unproven)
**Context.** ADR-001-B derives `read`/`write`/`admin` from IAS groups, but our `whoami` tests showed **no `groups` claim** — unverified.
**Decision (proposed).** Configure the IAS app to emit `groups`; map specific group IDs → scopes; **fail closed** (no recognized group → no scope, matching today's empty-scope behavior). Define api-key/open-mode semantics (no user JWT → the api-key profile's scopes; `ALLOW_OPEN` → `read`).
**Consequences.** + per-user MCP scopes. − another origin-bound assignment + a mapping table; **verify IAS emits groups first.**

### ADR-011 — Identity-origin governance (decision-grade, not a caveat)
**Context.** The per-user token authenticates the **IAS platform-origin shadow user**, NOT the human's Default-IdP admin identity (proven: GA-admin lives on `Default identity provider`, the token maps to `aejz2oiae-platform`).
**Decision (proposed).** Treat the platform-origin identity as the **MCP's per-user identity**; grant it **scoped** roles (don't mirror full admin). Document who grants what, under which origin. (Mirroring full admin = handing an LLM god-mode — see research doc Point B.)
**Consequences.** + least-privilege boundary. − the MCP can't act with the human's Default-IdP roles; admins must assign under the platform origin.

### ADR-012 — Mixed-identity tool surface (honesty)
**Context.** CF = per-user, CIS = shared-technical. The user/LLM must know which.
**Decision (proposed).** Mark each tool's identity mode in its description + audit; extend `whoami` to show per-leg identity; never imply a CIS-fallback call is acts-as-you.
**CIS-fallback governance (Codex #8, post-scope-decision).** Now that `BTP*` is per-user (CLI Server), CIS REST is **fallback-only: disabled by default**, enabled only by explicit config (e.g. `BTP_ALLOW_CIS_FALLBACK`); **shared-technical writes off by default**; every fallback call is **labelled shared-technical in the result + audit**; an "acts-as-you" deployment can **exclude the fallback entirely**.
**Consequences.** + honest surface, correct audit expectation, fallback can't silently masquerade as per-user. − the fallback path needs its own gate + labelling.

### ADR-013 — Write-target resolution (don't trust LLM-supplied targets)
**Context.** CF/BTP writes take an `org`/`space`/`guid`; an LLM could supply a wrong/spoofed target to dodge the allowlist.
**Decision (proposed).** **Resolve the real target server-side** (e.g. app GUID → its actual space) and run `requireTarget` against the **resolved** value, not the LLM's claim. Applies to all future writes.
**Consequences.** + closes a target-spoofing hole in the safety gate. − a resolution lookup per write.

### ADR-014 — Auth testing strategy (don't defer)
**Context.** Auth is the riskiest part; ADR-008's "defer integration tests" is wrong for an auth-heavy server.
**Decision (proposed).** From Phase 1: **fake OIDC/IAS provider contract tests** (the exchange, claim/audience validation, negative cases — wrong aud, missing `user_name`, expired assertion) + **live skip-policy smoke** (the real IAS→CF role loop, gated by creds via arc-1's `requireOrSkip`) + refresh/expiry tests.
**Consequences.** + the chain is tested, regressions caught. − more test infra than a trivial server (justified).

### ADR-015 — Secret management
**Context.** IAS client secret, DCR signing secret, CIS key — all secrets; **IAS is not in MTA**.
**Decision (proposed).** Store as bound CF service creds / user-provided service / env (never committed). Define rotation: rotating the **DCR signing secret** invalidates cached client_ids (mirror arc-1's `ARC1_DCR_SIGNING_SECRET`); IAS client secret rotation is an IAS-console/SCI-API step (runbook). The **`SEALING_SECRET` (ADR-009) MUST be a 32-byte random value** — clients hold the sealed ciphertext, so a weak/password-like secret is offline-brute-forceable (`keyFromSecret` does no KDF stretching). 
**Consequences.** + clear secret lifecycle. − a rotation runbook + the IAS secret stays a manual/scripted prerequisite.

### ADR-016 — Tool surface: ≤12 resource-split intent tools (`CF*`/`BTP*`), read/write separated ⭐ (added, deep-research-backed)
**Context.** Current surface = 3 tools (`whoami` + `CloudFoundry` + `BTPAccount`), ~5 live reads + 5 inert write stubs; the full plausible BTP+CF management surface is **~120+ operations**. Evidence (research): large flat tool sets **measurably degrade LLM tool-selection** (93.1% accuracy @ ~2.2 candidate tools vs 87.1% @ 5; a benchmark agent chose correctly only after cutting to **19 tools**) and bloat context (Playwright's tools = 22% of a 200K window); hard client ceilings exist (**Cursor 40, Copilot 128**). **≈12 sits in the empirically safe 10–20 band.** Intent-tools are the standard mitigation; arc-1 proves it.
**Decision (proposed).** Adopt **resource-split intent tools under `CF*`/`BTP*` prefixes, read separated from write — NO mixed R+W tool** (Codex #3: MCP annotations are tool-level, so a mixed tool can't be honestly `readOnlyHint:true`). **11 committed + 1 reserve**, every tool **pure-read or pure-write**:
- **Reads** (all `readOnlyHint:true`): **`CFInspect`** (apps · services · routes · builds/droplets · runtime · **orgs · spaces · quotas · roles · marketplace · platform-info**) · **`BTPInspect`** (subaccounts · directories · environments · subscriptions · entitlements · SM-services · **role-collections · trust · members** · `job_status`) · **`Manage`** (whoami · backends · features · targets).
- **Writes** (`readOnlyHint:false`): **`CFApps`** · **`CFServices`** · **`CFOrgSpace`** (create/delete space, quotas, role assign/revoke) · **`CFPlatform`** (admin-scope) · **`BTPSubaccounts`** · **`BTPEntitlements`** · **`BTPServices`** · **`BTPSecurity`** (admin-scope).
- [+reserve `CFDiagnose`/`BTPAudit`]. The two read tools carry larger action enums — fine (homogeneous reads). This keeps annotations honest **and** stays ≤12.
- **Read/write split is the load-bearing rule** (research's #1 finding): honest `readOnlyHint`/`destructiveHint`, no-confirm reads, parallel reads, and a read-only deploy registers **only** the read tools (zero write risk). The `CF*`/`BTP*` prefix **encodes the backend** (CF Cloud Controller vs BTP account CLI-Server) — **both per-user** after the 2026-06-30 scope decision (CIS REST = fallback only).
- **Design rules:** keep each `action` enum tight + homogeneous (same entity/params/failure — split off any action needing a wildly different param set); **enumerate every action in the description**; declare **`outputSchema` per read tool**; **gate per action server-side** (annotations are advisory/untrusted — the safety gate is the boundary); prune the action enum by scope (`ALLOW_WRITES=false` ⇒ write actions never rendered); result discipline (≤25K-token results, a `response_format` CONCISE/DETAILED lever, **resolve GUIDs→names**, cursor pagination).
- **Build-first:** port arc-1's **single-source action table** (`tool-registry.ts` pattern — derive the JSON-Schema enum + Zod enum + `ACTION_POLICY` from ONE table + a sync test) **before** the action count grows; the PoC hand-writes enum and policy separately = drift risk at ~110 rows.
**Flags (don't fit cleanly).** Async CIS jobs (`create_environment`/`delete_subaccount` return job refs → `BTPInspect.job_status`); binary app upload doesn't fit JSON args (exclude v1; use an existing droplet GUID); logs = bounded "recent N" not a stream; **CF service-instances ≠ Service-Manager instances** (different objects — document in both descriptions or the LLM conflates them).
**Safety taxonomy must grow first (Codex #7).** The current `TargetKind = subaccount|org|space` (`src/policy.ts`) doesn't cover the expanded surface — add **`directory`/`global-account`** targets (subaccount/directory create) and a **`foundation`/`global`** target (CF platform writes); and gate **`BTPSecurity` (trust/role-collection grants) + `CFPlatform` writes at `admin` scope**, not generic `write` (higher blast radius). ADR-013's resolve-real-target depends on this taxonomy existing — build it with the registry.
**Consequences.** + token-efficient, honest annotations, safe read-only deploy, scales under client caps. − ~110 policy rows (mitigated by the single-source table) + a two-level (tool→action) selection the model must do (mitigated by per-action descriptions). Migration from today's 3 tools is mechanical (rename + relocate + wire the 2 inert write paths). **Validate on evals** (prototype→evaluate→refactor) since effects vary by LLM.

### ADR-017 — MCP spec compliance: target **2025-11-25**, architect **stateless** ⭐ (added)
**Context.** Research confirms the current **stable** spec is **2025-11-25** (not 06-18); a **2026-07-28 RC** is locked-but-unreleased and **removes the `initialize` handshake + `Mcp-Session-Id` (fully stateless)** + adds `iss` validation. Our per-request PoC is already stateless (good), but is missing several **MUSTs**.
**Decision (proposed).** Target **2025-11-25**; stay **stateless** (forward-compatible with the RC). Close the MUST gaps:
- **RFC 9728 Protected Resource Metadata** at `/.well-known/oauth-protected-resource` — **`authorization_servers` = the MCP server's OWN OAuth issuer** (the server *is* the AS; it issues its own audience-bound tokens per ADR-009). **NOT the IAS issuer** (Codex #1): advertising IAS would steer clients to fetch IAS tokens directly = the passthrough shape ADR-009 forbids. IAS is the *upstream* IdP behind the server's `/authorize`, invisible to the MCP client. Emit `WWW-Authenticate: Bearer resource_metadata="…" scope="…"` on **401**. *(Non-optional — the client's discovery entrypoint.)*
- **Validate inbound bearer audience = canonical server URI** on every call; **401** on invalid/expired. *(Confirms ADR-009 — spec-required verbatim: "MUST NOT pass through the token … from the MCP client.")*
- **Origin header → 403** on invalid; **never authenticate via session**; **`MCP-Protocol-Version` header → 400** on unsupported; `initialize`/`initialized` + same-version negotiation.
- **Tools:** JSON-Schema 2020-12 `inputSchema` (non-null); report tool-execution **and input-validation** failures as **`isError:true`** (not protocol errors — enables model self-correction); if `outputSchema` declared, return conforming `structuredContent` (+ mirror as text); cursor pagination.
- **Operational:** ensure the CF ingress/AppRouter **forwards `Authorization` / `MCP-Protocol-Version` / `Mcp-Session-Id` and preserves `WWW-Authenticate` on 401** (a common BTP reverse-proxy footgun).
- **Confused-deputy check:** if the ADR-007 proxy uses **one static IAS client-id for many MCP clients**, the spec's **per-client consent MUST** may apply — verify against our topology.
**Consequences.** + a genuinely spec-compliant remote server (interoperates with Claude, VS Code, ChatGPT dev-mode, Cursor). − several small endpoints/validations to add in Phase 1 — mostly **mandatory, not optional**.

---

## 4. Phased implementation plan

| Phase | Goal | Key work | Depends on | Size |
|---|---|---|---|---|
| **0. Quality foundation** | arc-1-grade gate | biome/tsconfig/husky/CI/AGENTS.md/release-please (§5) **+ port arc-1's single-source action-registry** (one table → JSON-Schema enum + Zod + `ACTION_POLICY` + sync test, ADR-016) | — | **S** (~1–2 days) |
| **1. Spec-compliant + IAS-first inbound + BOTH per-user spikes** | login → server token, spec-clean, both legs proven | IAS OAuth/session proxy (ADR-007, **pre-registered clients not DCR**, **PRM→server issuer**, **sealed-token credential custody** ADR-009), IAS-groups→scopes; **MCP MUSTs** (PRM, audience, Origin→403, protocol-version, `isError`, ADR-017); **+ a minimal CLI-Server per-user read** (bundled `btp`, one harmless BTP read as the constrained user) — BTP is now core (Codex #4) | ADR-001,004,007,009,017 | **L** (riskiest) |
| **2. Tool surface** | the ≤12 `CF*`/`BTP*` tools | grow the action tables (CFInspect/BTPInspect reads; pure-write tools) + target taxonomy + `admin` tier (ADR-016); annotations + `outputSchema`; wire write paths; result discipline. *Plumbing can be built on the shared PoC identity, then switched to per-user — but CF **and** BTP reads are per-user at runtime* | ADR-016 | **M** |
| **3. Per-user CF** | `CfClient` acts as the user | server-held IAS cred (ADR-009) → `IasExchangeProvider` → `CfClient`; cache/refresh; tests (ADR-014) | ADR-002, Ph.1 | **M** |
| **4. MTA deploy** | reproducible deploy | `mta.yaml` (app + cis-key; **`xsuaa` only under ADR-001-A**); IAS OIDC app = prereq, not MTA (ADR-015); `mbt build`/`cf deploy` in isolated `CF_HOME` | ADR-006 | **M** |
| **5. BTP account per-user** | account ops as the user (reads too) | CLI Server: spike via bundled `btp`, then REST reimpl; route `BTP*` tools here (CIS → fallback) | ADR-004 | **M/L** |
| **6. Hardening** | prod posture | audit events, rate-limit, error minimization, timeouts/backoff, token cache hygiene | all | **M** |

**Recommended first move:** Phase 0 (cheap, unblocks everything) **+** a **time-boxed Phase-1 spike of ADR-007** (the IAS OAuth/session proxy) — make-or-break for the whole per-user build; prove it before committing Phases 3–5. **Phase 2 (tool surface, read tools) can proceed in parallel** on the current shared identity — it doesn't depend on per-user.

**Spike pass/fail (NOT "browser reaches IAS"):** passes only if the FULL path works for **one real MCP client + one deliberately-constrained user** — **pre-registered client → IAS login → server-issued MCP bearer (aud = this server; PRM advertises the *server's* issuer) → sealed IAS credential → exchange → BOTH (a) a Cloud Controller call AND (b) one `btp` CLI-Server read, each enforcing that user's platform-origin roles**. Both legs, because CF and BTP are both per-user now. Anything less hasn't de-risked the build.

---

## 5. Quality & tooling plan (concrete, from arc-1)

**Adopt now (Phase 0):**
- **`biome.json`** — copy arc-1's verbatim (2-space, single quotes, trailing commas, 120 cols, `organizeImports`, `noExplicitAny:warn`, test overrides). Never hand-format.
- **`tsconfig.json`** — `ES2022`/`Node16`, `strict`, `isolatedModules`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `declaration`+maps. **`tsconfig.tests.json`** extends it (`rootDir:'.'`, `noEmit`, include `test/**`).
- **Scripts:** `build` (just `tsc` for us), `dev` (`tsx watch`), `start`, `test`/`test:watch`/`test:coverage`, `lint` (`biome check .`), `lint:fix`, `format`, `typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.tests.json`), `prepare` (`husky || true`).
- **Husky + lint-staged:** `.husky/pre-commit` → `npx lint-staged`; `"*.{ts,js,json}": "biome check --write --no-errors-on-unmatched"`.
- **`vitest.config.ts`** (unit only, `test/**/*.test.ts`, v8 coverage) + **`tests/helpers/skip-policy.ts`** (`requireOrSkip`, `SkipReason`) copied from arc-1 — use from day 1 for the live-integration tests (the IAS/CF chain).
- **`.github/workflows/test.yml`:** Node 22/24 matrix → `npm ci` → `npm audit --audit-level=high --omit=optional` → `lint` → `typecheck` → `build` → `test`.
- **`release-please-config.json`** (`release-type:node`, `bump-minor-pre-major`, changelog sections feat/fix/perf visible, chore/docs/ci/refactor hidden) + **conventional commits** from now.
- **`engines.node` `>=22.19`**; devDeps: `@biomejs/biome ^2.5`, `typescript ~6.0`, `vitest ^4.1`, `@vitest/coverage-v8`, `tsx ^4.22`, `husky ^9.1`, `lint-staged ^17`.
- **`AGENTS.md`** — single source of truth (draft created alongside this plan), `CLAUDE.md` imports it (arc-1 pattern). Terse: project overview, design principles, build/test, config table, file-map table, request-flow, the safety invariant, code patterns.

**Defer (add when there's a reason):** file-size ratchet (`scripts/ci/check-file-sizes.mjs`), coverage-summary in CI, Docker/`security-scan`/`dependency-review` workflows, integration/e2e vitest configs.

**Engineering Playbook (carry over from arc-1):** freeze the observable surface first (the tool-definition JSON the LLM sees); move-only refactors verified by the full gate; make invariants true by construction (derive parallel lists from one table); security values ride *required* params (so a missed call site is a compile error); guard the guards.

---

## 6. Decision summary — your call

> **Decide these THREE first (per Codex review):** **(1) Product scope** — "per-user CF first, CIS shared read-only" **vs** "all BTP account ops must be per-user"? (drives ADR-004). **(2)** The IAS proxy **issues local MCP tokens + stores IAS creds server-side** (ADR-009) — recommend **yes** (MCP-compliant, no passthrough). **(3)** The exact **IAS groups + platform-origin role governance** → `read`/`write`/`admin` (ADR-010/011). **Prove first:** the full MCP-OAuth-to-IAS path end-to-end (the ADR-007 spike criteria in §4).
>
> **Two MCP-research findings that are NOT optional (just do them):** target spec **2025-11-25 + stay stateless** (the 2026 RC drops sessions), and implement the **RFC 9728 PRM + audience-validation + Origin→403 MUSTs** (ADR-017) — required for any compliant remote server. One finding that *simplifies* the build: **DCR is optional → use pre-registration** (D9), shrinking the ADR-007 proxy.
>
> **Status:** D1/D2/D5/D8/D9/D10 + ADR-009/016/017 are now **DECIDED** (§3 banner) — the table below is the rationale record kept for traceability. The remaining genuinely-open items are setup-time, not blocking: **R2** (verify IAS emits `groups`) and **ADR-011/R3** (platform-origin role governance).

| # | Decision | Recommended | If you say "no" |
|---|---|---|---|
| **D1** | Is **per-user** a product goal? | **Yes** (the whole investigation) | Stop at shared-technical PoC + Phase 0/5 hardening; skip ADR-001-B/002/007 |
| **D2** | Inbound = **IAS-first** (ADR-001) | **Yes**, if D1=yes | Keep XSUAA inbound (no per-user) |
| **D3** | Build the **IAS OAuth proxy** (ADR-007) | **Spike first**, then commit | Per-user is blocked — this is the gate |
| **D4** | CIS stays **shared** (ADR-003) | **Yes** (no alternative) | — |
| **D5** | BTP account per-user (ADR-004) | ✅ **DECIDED: in scope** — per-user via CLI Server | — |
| **D6** | Deploy via **MTA** (ADR-006) | **Yes** | Keep `manifest.yml` + script |
| **D7** | Adopt **arc-1 quality setup** (ADR-008) | **Yes, now** (Phase 0) | Stay minimal |
| **D8** | **Tool surface** = ≤12 resource-split `CF*`/`BTP*`, read/write separated (ADR-016) | **Yes** — token-efficient, honest annotations, safe read-only deploy | Keep the 2-tool backend split (doesn't scale; dishonest annotations) |
| **D9** | Client registration = **pre-registration / CIMD, skip DCR** (ADR-007/017) | **Yes** — DCR is only optional in the spec; shrinks the proxy (the main risk) | Build full DCR (more work; only if open client onboarding is needed) |
| **D10** | Port the **single-source action registry** in Phase 0 (ADR-016) | **Yes** — cheap now, prevents enum/policy drift at ~110 rows | Hand-maintain enum + policy separately (drift = #1 bug source) |

---

## 7. Risks & open questions
- **R1 (high):** ADR-007 — the IAS OAuth proxy is the biggest unknown. Does `@arc-mcp/xsuaa-auth` generalize, or do we build? **Spike before committing Phases 2–4.**
- **R2:** IAS-groups → MCP-scopes mapping — confirm IAS emits `groups` and map them to `read`/`write`/`admin` (the `whoami` claims showed no groups yet; configure + verify).
- **R3:** the **identity-origin** nuance — per-user maps to the IAS-platform shadow user; roles must be assigned under that origin (documented). Decide the role-granting governance (scoped vs mirror).
- **R4:** token lifetimes/refresh — IAS id_token (~min), CF token (short) — design the per-user cache + refresh (re-exchange from a stored IAS refresh token).
- **R5:** the account's **cf-target-flip automation** — keep deploys on isolated `CF_HOME` / MTA; understand/contain that automation before CI deploys here.
- **R6:** **confused-deputy consent** — if the ADR-007 proxy fronts IAS with ONE static client-id for many MCP clients, the spec's per-client-consent MUST may apply; confirm against the exact token-exchange topology (ADR-017).
- **R7:** **CF service-instances vs Service-Manager instances** are different objects with different GUIDs/identity — the most likely LLM confusion in the tool surface; document the distinction in both `CFServices`/`CFInspect` and `BTPServices` descriptions (ADR-016).
- **R8:** **MCP-spec velocity** — stable is `2025-11-25`; the `2026-07-28` RC brings breaking changes (stateless, no session id, `iss` validation). Architect stateless now (ADR-017) so the RC is a small lift, not a rewrite.
