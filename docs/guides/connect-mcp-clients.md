# Connecting MCP clients

btp-cf-mcp is a **remote, streamable-HTTP** MCP server. Point any MCP client at:

```
https://<your-route>/mcp
```

(the live PoC is `https://btp-cf-mcp-dev.cfapps.us10-001.hana.ondemand.com/mcp`).

## Two ways to authenticate

| | **OAuth ("acts as you")** | **API key (shared)** |
|---|---|---|
| Identity | each user logs in via IAS → their real CF/BTP roles | one shared identity (tech user for BTP) |
| Setup | one browser login, then silent refresh | a static `Authorization: Bearer` header |
| Use it when | interactive clients (VS Code, Claude Desktop, Codex, Copilot Studio) | headless/automation (Copilot coding agent) or quick tests |

The server discovers OAuth automatically (RFC 9728 protected-resource metadata → RFC 8414 AS metadata →
RFC 7591 dynamic client registration), so OAuth clients need **only the URL** — no client id/secret.

> **Read-only by default.** Mint API keys as `<key>:viewer` (read-only) unless a caller truly needs writes.
> Profiles: `viewer` (read) · `developer` (read+write) · `admin`. Set them in the `API_KEYS` env
> (space-separated `key:profile` pairs). For autonomous callers (the Copilot coding agent), **prefer `viewer`.**

---

## GitHub Copilot

All three Copilot surfaces work against btp-cf-mcp **with no server changes**. No CORS or COOP handling is
needed — Copilot connects over native/server-side HTTP, and the server sets no `Cross-Origin-Opener-Policy`
(so the OAuth popup is never blocked).

### 1. Copilot coding agent (github.com — autonomous agent / code review)

**API key only** — the coding agent does **not** support OAuth MCP servers.

Repo (or org) **Settings → Code & automation → Copilot → MCP servers**:

```json
{
  "mcpServers": {
    "btp-cf-mcp": {
      "type": "http",
      "url": "https://<your-route>/mcp",
      "tools": ["*"],
      "headers": { "Authorization": "Bearer $COPILOT_MCP_BTP_KEY" }
    }
  }
}
```

- Create an **Actions/Agents secret** whose name **must start with `COPILOT_MCP_`** — e.g.
  `COPILOT_MCP_BTP_KEY` = a btp-cf-mcp API key. Use a **`:viewer`** (read-only) key here.
- Narrow `"tools"` to the specific tool names (`CFInspect`, `BTPInspect`, …) instead of `"*"` if you want.

### 2. VS Code — GitHub Copilot (agent mode)

`.vscode/mcp.json` (workspace) or your user `mcp.json`. **OAuth (recommended, no secrets):**

```json
{ "servers": { "btp-cf-mcp": { "type": "http", "url": "https://<your-route>/mcp" } } }
```

First connect opens a browser to the consent page + IAS login (auto-registers via DCR). API-key alternative:

```json
{
  "servers": {
    "btp-cf-mcp": {
      "type": "http",
      "url": "https://<your-route>/mcp",
      "headers": { "Authorization": "Bearer ${input:btp_api_key}" }
    }
  },
  "inputs": [{ "id": "btp_api_key", "type": "promptString", "description": "btp-cf-mcp API key", "password": true }]
}
```

VS Code runs the MCP client in its Node/Electron extension host (not a web page) — no CORS involved.

### 3. Microsoft Copilot Studio (agent → Tools → New tool → Model Context Protocol)

- **Transport:** *Streamable HTTP* (the server serves exactly this at `POST /mcp`).
- **Server URL:** `https://<your-route>/mcp`
- **Auth:** *OAuth 2.0* → **Dynamic discovery** (do **not** enter a client id/secret, and do **not** pick
  "Manual" — that's for XSUAA-native servers). Copilot Studio walks the discovery endpoints and self-registers
  via DCR. Per-user IAS identity.
- **Simpler:** *API key* → Type *Header*, name `Authorization`, value `Bearer <your API key>` (shared identity).
- **Skip the consent page for your connector:** the sign-in popup shows a one-click consent screen
  (confused-deputy defense). For a connector you operate, allowlist its exact redirect URI (shown on that
  page, `https://global.consent.azure-apim.net/redirect/…`) via `CONSENT_TRUSTED_REDIRECTS` — the flow then
  goes straight to the IAS login; unknown clients still get the screen.

> If — and only if — you ever see a CORS error in browser devtools during a Copilot Studio connection,
> that means a browser-origin call path is in play. btp-cf-mcp emits **no CORS headers today** (not needed
> for a normal connection). Enabling it is a small server change — wire the `@arc-mcp/xsuaa-auth` `applyCors`
> helper behind an `ALLOWED_ORIGINS` env, allowing `https://global.consent.azure-apim.net`
> ([ROADMAP.md](../../ROADMAP.md)).

---

## Claude Desktop

**OAuth:** Settings → **Connectors** → **Add custom connector** → URL `https://<your-route>/mcp` (runs the
browser OAuth flow). **API key** (config file `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "btp-cf": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-route>/mcp", "--header", "Authorization: Bearer <your API key>"]
    }
  }
}
```

## Codex CLI — `~/.codex/config.toml`

**OAuth:**
```toml
[mcp_servers.btp-cf]
url = "https://<your-route>/mcp"
```
then `codex mcp login btp-cf`. **API key:** add `bearer_token_env_var = "BTP_CF_MCP_KEY"` and export that env var.

## Cursor — `mcp.json`

```json
{ "mcpServers": { "btp-cf": { "url": "https://<your-route>/mcp", "headers": { "Authorization": "Bearer <your API key>" } } } }
```

---

## Notes

- **No CORS / COOP needed** for any of the above. CORS is off (btp-cf-mcp emits no `Access-Control-*` headers)
  and only matters for a browser-origin MCP client (none of these are); the `applyCors` helper ships in
  `@arc-mcp/xsuaa-auth` but **isn't wired into the IAS-first path yet** — a small change if a browser client ever
  needs it (ROADMAP). Do **not** port arc-1's `helmet(crossOriginOpenerPolicy)` block — btp-cf-mcp mounts no
  helmet on purpose (so there's no COOP to break the OAuth popup).
- **Token lifetimes (OAuth):** access token 30 min (refreshed silently); refresh token `MCP_REFRESH_TTL`
  (default 8 h) → that's the longest before a browser re-auth, capped by your IAS tenant's refresh lifetime.
- **DCR client ids are stateless** (HMAC, no expiry) — they survive `cf push`/restart, so clients don't
  re-register.
