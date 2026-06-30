# MCP Server Best Practices — Research Dossier (2026-06-30)

Evidence behind **ADR-016** (tool surface) and **ADR-017** (spec compliance) in [../architecture/implementation-plan.md](../architecture/implementation-plan.md).
Three parallel research passes: (1) protocol/security necessities, (2) tool-design + tool-count, (3) our CF/BTP surface → grouping (the grouping lives in ADR-016).

---

## 1. Spec basis (important)

- **Current STABLE spec: `2025-11-25`** — build to this (not the widely-blogged `2025-06-18`). Adds OIDC discovery, Client ID Metadata Documents, incremental scope consent, async tasks.
- **`2026-07-28` is a Release Candidate, NOT stable** (locked 2026-05-21, "contains breaking changes"). It **removes `initialize`/`initialized` + `Mcp-Session-Id` (fully stateless)**, adds `Mcp-Method`/`Mcp-Name` routing headers, RFC 9207 `iss` validation, OIDC `application_type` in DCR. ⇒ **architect stateless now** so the RC is a small lift.
- Sources: [changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog) · [RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)

## 2. Authorization — our token model is exactly what the spec mandates ✅

Verbatim normative text ([Authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [Security Best Practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)):
- "MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience, according to RFC 8707 Section 2."
- "MCP servers **MUST NOT** accept or transit any other tokens."
- "The MCP server **MUST NOT** pass through the token it received from the MCP client." (for upstream API calls — act as a separate OAuth client instead)

⇒ **ADR-009 (issue own audience-bound MCP token; hold IAS id/refresh server-side; exchange for downstream tokens; never passthrough) is precisely the architecture the passthrough prohibition exists to force.** Compliant by construction.

### MUSTs we were missing (now in ADR-017)
1. **RFC 9728 Protected Resource Metadata** — "MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata." Serve `/.well-known/oauth-protected-resource`; emit `WWW-Authenticate: Bearer resource_metadata="…" scope="…"` on **401**. *The client's entire discovery entrypoint — non-optional even with a custom AS.* **⚠️ Under our ADR-009 design `authorization_servers` = the *MCP server's own* OAuth issuer, NOT the IAS issuer** — the server issues its own audience-bound tokens; advertising IAS would steer clients to fetch IAS tokens directly = the passthrough we forbid. IAS sits behind the server's `/authorize` as the upstream IdP. (The generic "= your AS issuer" guidance only coincides with IAS when IAS is *itself* the AS the client talks to — which it isn't here.)
2. **Audience validation on every call** (`aud` = canonical server URI); **401** on invalid/expired.
3. **Transport:** single POST+GET endpoint; **Origin → 403**; **`MCP-Protocol-Version` header → 400** on unsupported; sessions **MUST NOT** be used for auth.
4. **PKCE `S256`** advertised in AS metadata (confirm IAS OIDC discovery exposes `code_challenge_methods_supported`).

### What simplifies the build
- **DCR (RFC 7591) is only MAY** ("backwards compatibility"). The **recommended** path is **Client ID Metadata Documents (CIMD, SHOULD)** or **pre-registration**. ⇒ the ADR-007 proxy **need not host a DCR endpoint** — pre-register Claude/VS Code/Cursor (D9). This removes the biggest chunk of the "riskiest task."
- **Confused-deputy:** the per-client-consent MUST applies to proxies using **one static client-id** to a third-party AS with DCR+consent cookies. If IAS is *our own* AS this may not fully apply — but with one static IAS client-id for many MCP clients, **verify** (R6).

## 3. Tool design + the tool-count question (behind ADR-016)

### Hard evidence that too many tools hurts
- **Selection accuracy:** 93.1% @ ~2.2 candidate tools vs 87.1% @ 5 (BFCL, chance-corrected); medium-difficulty gap 76.8% vs 60.9%. ([arXiv 2605.24660](https://arxiv.org/html/2605.24660v2))
- **Distraction, not context-size:** a benchmark agent whose tools *fit* the window still mis-picked until reduced to **19 tools**. ([Demiliani](https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/))
- **Context bloat:** Playwright MCP = **22.2% of a 200K window** in tool defs; code-execution-with-MCP cut one case **150K→2K tokens (98.7%)**; Cloudflare Code Mode **1.17M→~1K (~99.9%)** by exposing 2 tools. ([Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp) · [Cloudflare](https://blog.cloudflare.com/enterprise-mcp/))
- **Hard client ceilings:** **Cursor 40 tools**, **Copilot 128 tools**. GitHub's MCP ships **162+ tools in 14 toolsets, 6 default**, with dynamic discovery starting at ~4. ([DeepWiki](https://deepwiki.com/github/github-mcp-server/3-github-toolsets))

⇒ **≈12 tools is in the empirically safe 10–20 band**, far under client caps. Intent-tools are the standard mitigation.

### The load-bearing rule: split read from write
A tool mixing reads + writes **cannot be honestly annotated** — it must set `readOnlyHint:false`, so clients (VS Code Copilot prompts on every non-read; Claude Code parallelizes only reads) confirm even on harmless reads, and `destructiveHint` becomes meaningless. **Splitting read/write per resource** restores honest annotations + no-prompt/parallel reads + a read-only deploy that registers *only* read tools. ([annotations](https://mcpblog.dev/blog/2026-03-13-mcp-tool-annotations), [spec/tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)) — **annotations are advisory/untrusted; the safety gate stays the real boundary.**

### Other tool rules (in ADR-016)
- Keep each `action` enum **tight + homogeneous** (same entity/params/failure); a 15-string omnibus with a `params: Record` blob = "god-tool" ([anti-patterns](https://www.digitalapplied.com/blog/mcp-server-anti-patterns-design-mistakes-2026-developer-guide)). **Enumerate every action in the description.**
- **`outputSchema` per read tool** (mitigates the intent-tool's heterogeneous-output weakness); if declared, server **MUST** return conforming `structuredContent` (+ mirror as text).
- **Result discipline:** ≤25K-token results (Claude Code default cap); a `response_format` CONCISE/DETAILED lever (Anthropic example 72 vs 206 tokens); **resolve GUIDs→names**; cursor pagination; truncate *with guidance*.
- **Errors:** tool-execution + input-validation failures → **`isError:true`** (model self-corrects); reserve JSON-RPC protocol errors for malformed calls.
- **Descriptions matter:** Anthropic credits "precise refinements to tool descriptions" for a SWE-bench SOTA. Namespace by prefix; `app_guid` not `app`.
- **Validate on evals** (prototype → evaluate → refactor) — effects vary by LLM. ([Anthropic, writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents))

## 4. Net effect on the plan
- **ADR-009 confirmed** spec-compliant (the passthrough rule mandates it).
- **ADR-017 added:** target 2025-11-25, stateless, + the PRM/audience/Origin/version MUSTs.
- **ADR-007 shrunk:** DCR optional → pre-registration; the proxy is smaller than first feared.
- **ADR-016 added:** ≤12 resource-split `CF*`/`BTP*` tools, read/write separated, single-source action table — backed by the tool-count evidence above.
