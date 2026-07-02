# btp-cf-mcp

**An MCP server that lets an AI assistant inspect and manage your SAP BTP account and Cloud Foundry —
as *you*.** A user signs in once via IAS; the server then calls the BTP and Cloud Foundry APIs under
that person's own identity, so their real roles are enforced and the audit trail shows the real human —
no shared technical password, no second login. A shared **read-only technical user** mode is also
available for headless/automation callers.

> Status: a working **proof-of-concept**, read-only by default. Reads are live-verified on a free-tier
> BTP account; writes (app lifecycle, service create/delete) execute only when explicitly enabled and
> only against allowlisted targets. See [Status](#status).

---

## What it is

An [MCP](https://modelcontextprotocol.io) server (same lineage as [arc-1](https://github.com/arc-mcp/arc-1),
which does this for ABAP) that gives Claude — or any MCP client — a small, safe set of tools over:

- **SAP BTP account** — subaccounts, environments, entitlements (via the `btp` CLI server APIs).
- **Cloud Foundry** — orgs, spaces, apps, services (via the Cloud Controller v3 API).

The point of difference is **identity**: the server is its own OAuth authorization server that proxies
login to IAS, seals the user's credential into its own token, and then acts **as that user** on every
call — CF enforces their org/space roles, BTP enforces their global-account roles. It reimplements the
`btp` CLI *server* protocol over plain HTTPS, so there is **no CLI binary** in the container.

## What you can do

Reads and writes are **separate tools** so each read tool is honestly `readOnlyHint:true` (hosts
auto-approve, no confirm friction), and a read-only deployment renders **only** the two Inspect tools:

| Tool | Actions | Notes |
|---|---|---|
| **`CFInspect`** (read) | `orgs`, `spaces`, `apps`, `services`, `routes`, `app_detail`, `app_processes` | Cloud Controller v3; as the user or a shared CF token. `app_processes` = instance health/state |
| **`BTPInspect`** (read) | `subaccount`, `subaccounts`, `global_account`, `environments`, `entitlements`, `subscriptions` | `entitlements` = global-account catalog, or a subaccount's plan assignments if you pass a subaccount |
| **`whoami`** | — | diagnostic: resolved scopes + token claims |
| `CFApps` / `BTPServices` (write) | restart/stop/start an app · create/delete service instances | **per-user (OAuth) only**; hidden unless `ALLOW_WRITES=true`; targets must be allowlisted — CFApps resolves the app's **real** space server-side |

A deliberately small surface (fewer tools select more accurately). Every action is defined once in a
**single-source registry** (`src/registry.ts`); the schema, scopes, MCP annotations, and dispatch all
derive from it — so growing capability is adding a row, not a tool.

## Use cases

- **"Which of my apps are running, and is anything crashed?"** — an AI ops helper over `CFInspect.apps`
  for a developer, scoped to exactly the spaces they have roles in.
- **"What service plans is this account entitled to, and how much quota is left?"** — `BTPInspect.entitlements`
  for capacity/licensing questions, without opening the cockpit.
- **"List my subaccounts and their environments"** — a quick BTP-account overview from chat.
- **Team read-only assistant** — point a shared, **read-only technical user** (Global Account Viewer +
  Subaccount Viewer) at a support channel so anyone can ask about the landscape, with one auditable identity.
- **Per-developer accountability** — each developer's assistant logs in as them, so it sees *only* what
  they're entitled to and every action is attributed to the real person.

## How it works

```
 MCP client ──OAuth (this server IS the auth server, proxying to IAS)──▶ [btp-cf-mcp]
      │  or  Authorization: Bearer <api-key>                                  │ MCP token = a sealed JWE
      ▼                                                                       │ holding the user's IAS credential
   IAS login (browser, once)  ◀───────────────────────────────────────────────┤
                                  per request: unseal → IAS app-to-app exchange │
                    ┌───────────────────────────────────────────────────────────┘
                    ▼ CFInspect                            ▼ BTPInspect
        CF UAA → Cloud Controller v3 (as you)   btp CLI *server* REST (as you) — no binary
```

- **Inbound** — the server exposes OAuth (`/authorize` `/token` `/register` + discovery), proxies login to
  IAS, and issues its own token: a **sealed, audience-bound JWE** of the IAS credential (never a passthrough).
  DCR is guarded by a **consent gate** so a user always sees which client they're authorizing.
- **Outbound** — per request it unseals the credential, does the IAS app-to-app exchange, and calls CF
  (via CF UAA) and BTP (via the CLI-server protocol) **as the user**.

Full design + the hard-won auth details: [docs/guides/per-user-ias-auth-setup.md](docs/guides/per-user-ias-auth-setup.md).

## Two identity models

- **Per-user ("acts as you")** — best audit + least-privilege; each user logs in via IAS.
- **Shared read-only technical user** — one service account (Global Account Viewer + Subaccount Viewer) for
  headless/API-key callers; simpler, one audited identity.

Both can run on the **same instance** — an OAuth caller runs per-user, an API-key caller uses the tech user.
Setup + trade-offs: [docs/guides/admin-deployment.md](docs/guides/admin-deployment.md) → "Identity models".

## Safety

- **Read-only by default** (`ALLOW_WRITES=false`); writes need explicit enablement + a fail-closed target
  allowlist (`ALLOWED_SUBACCOUNTS/ORGS/SPACES`) + per-action `DENY_ACTIONS`.
- **Scopes** (`read`/`write`/`admin`) prune the tool list — the LLM only sees what the caller may do.
- **Two authz layers** — the server's scope gate *and* the user's real BTP/CF roles (defense in depth).
- **Consent gate** on the OAuth proxy (confused-deputy defense); secrets never logged; sealed tokens are
  audience-bound so they can't be replayed at a sibling service.

## Quick start

Deploy to BTP Cloud Foundry (IAS-first, per-user):

```bash
npm ci && npm run build                # dist/ is not committed — build before pushing
cf push btp-cf-mcp                     # or: mbt build && cf deploy (secrets via an mtaext OUTSIDE the repo — see mta.yaml)
# then set the IAS-first config (secrets via cf set-env, never manifest.yml):
cf set-env btp-cf-mcp SEALING_SECRET "$(openssl rand -hex 32)"
cf set-env btp-cf-mcp IAS_ISSUER https://<tenant>.accounts.ondemand.com
cf set-env btp-cf-mcp IAS_CLIENT_ID <id>   # + IAS_CLIENT_SECRET, CF_PLATFORM_CLIENT_ID,
cf set-env btp-cf-mcp CF_UAA_URL ...        #   CF_UAA_URL, CF_API, BTP_GA_SUBDOMAIN, PUBLIC_URL
cf restage btp-cf-mcp
```

Point an MCP client (Claude, `npx @modelcontextprotocol/inspector`) at `https://<route>/mcp` → it
discovers OAuth, you log in via IAS, and tool calls run as you. **Full step-by-step (IAS app, the roles
that make reads return data, troubleshooting, caveats): [docs/guides/admin-deployment.md](docs/guides/admin-deployment.md).**

## Status

**Shipped + live-verified** (free-tier BTP account):
- ✅ IAS-first **per-user** inbound (OAuth proxy) + a signed, browser-bound **consent gate**.
- ✅ Per-user **Cloud Foundry** (Cloud Controller, as the user) and **BTP account** reads (CLI-server protocol, no binary).
- ✅ Shared **read-only technical user** mode (username/password login).
- ✅ Read-only safety gate + scope-based tool pruning; sealing-key rotation; refresh-token rotation; session caching.

- ✅ Read/write-split tool surface (`CFInspect`/`BTPInspect` + write tools) with honest MCP annotations.

- ✅ Writes: CF app lifecycle (restart/stop/start) + Service Manager create/delete — off by default,
  fail-closed target allowlists, and CFApps gates on the app's **server-resolved** space (never a
  caller-supplied value).

**PoC boundaries:**
- ⏳ Async job polling for service create/delete is manual (verify via `BTPInspect.service_instances`).
- ⏳ Mapping IAS groups → scopes and an MTA-only deploy are future work.

## Documentation

- [docs/guides/admin-deployment.md](docs/guides/admin-deployment.md) — deploy + configure (start here)
- [docs/guides/connect-mcp-clients.md](docs/guides/connect-mcp-clients.md) — connect Copilot / Claude Desktop / Codex / VS Code / Cursor
- [docs/guides/per-user-ias-auth-setup.md](docs/guides/per-user-ias-auth-setup.md) — the IAS per-user auth recipe
- [ROADMAP.md](ROADMAP.md) — what works today vs what's planned · [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup
- [docs/README.md](docs/README.md) — full docs index · [AGENTS.md](AGENTS.md) — codebase guide for AI agents
