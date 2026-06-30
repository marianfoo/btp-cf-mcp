# btp-cf-mcp — Documentation Index

Start here if you are navigating the repo docs. Future docs must follow
[docs-conventions.md](docs-conventions.md).

## Agent Context

| Doc | What it is | Read it when |
|---|---|---|
| [agent/onboarding.md](agent/onboarding.md) | Full project map for AI agents: current vs target architecture, live-proven facts, landmines, safe change path. | A new LLM/agent needs enough context to work safely |
| [agent/creation-history.md](agent/creation-history.md) | Synthesis of the original creation chat: goals, spikes, Codex review fixes, deploy/debug lessons, and later corrections. | Understanding how the PoC came to exist and what changed afterward |
| [../AGENTS.md](../AGENTS.md) | Single source of truth for AI coding agents working in the repo. | Before code or docs work |

## Architecture

| Doc | What it is | Read it when |
|---|---|---|
| [architecture/implementation-plan.md](architecture/implementation-plan.md) | Architecture, embedded ADRs, decisions, phased build, and quality plan. | Before auth, tool-surface, or deployment architecture changes |
| [architecture/ias-oauth-proxy-plan.md](architecture/ias-oauth-proxy-plan.md) | Detailed IAS OAuth proxy plan for server-issued MCP tokens. | Continuing IAS-first inbound work |
| [architecture/adr/README.md](architecture/adr/README.md) | Naming and shape for accepted ADR files. | Splitting accepted decisions out of the plan |

## Guides

| Doc | What it is | Read it when |
|---|---|---|
| [guides/admin-deployment.md](guides/admin-deployment.md) | Deploy and configure the server on BTP CF + IAS. | Setting up or operating the server |
| [guides/per-user-ias-auth-setup.md](guides/per-user-ias-auth-setup.md) | Proven IAS-first per-user CF/BTP setup: IAS app config, app-to-app exchange, CF roles, troubleshooting. | Setting up per-user auth in a tenant |

## Operations

| Doc | What it is | Read it when |
|---|---|---|
| [operations/live-chain-runbook.md](operations/live-chain-runbook.md) | Live test plan for the per-user outbound chain. | Running the real IAS -> CF/BTP proof |
| [operations/per-user-spike-notes.md](operations/per-user-spike-notes.md) | Current status of per-user spike modules and next increments. | Continuing the spike or interpreting live-run results |

## Research

| Doc | What it is | Read it when |
|---|---|---|
| [research/2026-06-30-per-user-outbound-auth.md](research/2026-06-30-per-user-outbound-auth.md) | Full research trail: why CIS per-user is dead, why CF works, every dead end and breakthrough. | Understanding why the architecture changed |
| [research/2026-06-30-related-btp-mcp-servers.md](research/2026-06-30-related-btp-mcp-servers.md) | How related BTP MCP servers handle auth and tool surfaces. | Comparing approaches |
| [research/2026-06-30-mcp-best-practices.md](research/2026-06-30-mcp-best-practices.md) | MCP spec compliance and tool-count/design evidence behind ADR-016/017. | Designing MCP tools or auth transport |

## TL;DR

Per-user "acts as you" is proven for CF and BTP account ops via the CLI Server. CIS REST cannot be the per-user
primary path and stays shared-technical fallback. Per-user requires IAS-first inbound; read
[architecture/implementation-plan.md](architecture/implementation-plan.md) before changing auth or tools.
