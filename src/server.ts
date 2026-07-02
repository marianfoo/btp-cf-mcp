// MCP server + HTTP-streamable transport + inbound auth (via @arc-mcp/xsuaa-auth facade).

import {
  type ApiKeyEntry,
  type AuthOptions,
  createChainedTokenVerifier,
  createOAuthCallbackHandler,
  noopLogger,
  setupHttpAuth,
} from '@arc-mcp/xsuaa-auth';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createIasOAuthProvider } from './auth/ias-oauth-provider.js';
import { keyFromSecret } from './auth/sealed-credential.js';
import { createSealedJweVerifier } from './auth/sealed-verifier.js';
import type { AppConfig } from './config.js';
import { type Clients, dispatch } from './handlers.js';
import { expandScopes } from './policy.js';
import { deriveUserSafety } from './safety.js';
import { visibleTools } from './tools.js';

export const VERSION = '0.0.1';

// Default scopes only apply in explicit open mode (ALLOW_OPEN). Authenticated callers carry real scopes.
function scopesOf(authInfo: { scopes?: string[] } | undefined): string[] {
  return authInfo?.scopes ?? ['read'];
}

// Always-visible diagnostic tool: explains the no-scope state and surfaces raw token claims.
const WHOAMI_TOOL = {
  name: 'whoami',
  description:
    "Diagnostic: show the caller's resolved scopes, plus raw token claims (origin/scope) when the token is a readable JWT — sealed-JWE and API-key tokens are opaque. Always available, even with no scopes.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    title: 'Who am I',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function decodeClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const keep = ['scope', 'origin', 'client_id', 'cid', 'azp', 'user_name', 'email', 'zid', 'ext_attr', 'aud'];
    return Object.fromEntries(keep.filter((k) => k in payload).map((k) => [k, payload[k]]));
  } catch {
    return null;
  }
}

function whoamiResult(authInfo: { scopes?: string[]; clientId?: string; token?: string } | undefined): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const resolvedScopes = authInfo?.scopes ?? [];
  const tokenClaims = decodeClaims(authInfo?.token);
  const out = {
    clientId: authInfo?.clientId ?? null,
    resolvedScopes,
    note: resolvedScopes.length
      ? 'Scopes present — tools should be visible.'
      : 'No scopes. Look at tokenClaims.scope: if it has no "btp-cf-mcp...read/write/admin" entry, your role collection is not in THIS token. Assign the role, then get a FRESH token (old tokens keep old scopes), and confirm tokenClaims.origin matches the IdP where you assigned the role.',
    tokenClaims,
    // A sealed-JWE (OAuth-proxy) or API-key token has no client-readable JWT payload — say so instead of a bare null.
    ...(tokenClaims
      ? {}
      : {
          tokenClaimsNote:
            'Token is opaque (sealed JWE from the OAuth proxy, or an API key) — no client-readable JWT claims; resolvedScopes above are authoritative.',
        }),
  };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}

function buildServer(config: AppConfig, clients: Clients): Server {
  const server = new Server({ name: 'btp-cf-mcp', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const scopes = scopesOf(extra.authInfo);
    // Per-user backends are usable only when THIS request carries an IAS credential (the sealed
    // id_token). API-key callers have none — advertise per-user tools to them only if a shared
    // backend also exists, else they'd see a tool that always fails.
    const hasIas = Boolean((extra.authInfo?.extra as { iasCredential?: string } | undefined)?.iasCredential);
    return {
      tools: [
        WHOAMI_TOOL,
        ...visibleTools(scopes, {
          allowWrites: deriveUserSafety(config.safety, scopes).allowWrites,
          perUser: hasIas, // writes are per-user only — hide them from api-key/shared-identity callers
          denyActions: config.safety.denyActions,
          backends: {
            cf: Boolean(clients.cf) || (hasIas && Boolean(config.ias)),
            cis: Boolean(clients.cis), // shared CIS key — only the cisFallback BTP reads
            // The primary BTP path: per-user (this request has an IAS credential) or the shared tech user.
            btpCli: (hasIas && Boolean(config.btpGaSubdomain)) || Boolean(config.btpTechUser && config.btpGaSubdomain),
          },
        }),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const scopes = scopesOf(extra.authInfo);
    console.error(
      `[btp-cf-mcp] call ${req.params.name} scopes=${JSON.stringify(scopes)} client=${extra.authInfo?.clientId ?? '-'}`,
    );
    if (req.params.name === 'whoami') return whoamiResult(extra.authInfo);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const ias = extra.authInfo?.extra as { sub: string; iasCredential: string } | undefined;
    return dispatch(req.params.name, args, scopes, config, clients, ias);
  });

  return server;
}

export function startHttp(
  config: AppConfig,
  clients: Clients,
  xsuaa: AuthOptions['xsuaa'] | undefined,
  log: (m: string) => void,
): void {
  const app = express();
  app.use(express.json());

  // Minimal health: no backend/auth/write disclosure.
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION }));

  const apiKeys: ApiKeyEntry[] = config.apiKeys.map((k) => ({ key: k.key, scopes: k.scopes }));
  let bearer: express.RequestHandler | undefined;

  if (config.ias && config.sealingSecret) {
    // IAS-first per-user inbound (ADR-001-B/007/009): this server is its OWN OAuth AS, proxying to IAS;
    // the issued MCP token IS the sealed JWE. DCR is guarded by a per-authorization consent gate
    // (ias-oauth-provider.ts authorize()). IAS-groups→scopes mapping is still future work.
    const sealKey = keyFromSecret(config.sealingSecret);
    // Rotation: seal with the current key; verify + unseal (access AND refresh) with current + previous,
    // so rotating SEALING_SECRET doesn't invalidate live tokens until they expire.
    const verifyKeys = config.sealingSecretPrevious ? [sealKey, keyFromSecret(config.sealingSecretPrevious)] : sealKey;
    const appUrl = (config.publicUrl ?? `http://localhost:${config.port}`).replace(/\/$/, '');
    const audience = `${appUrl}/mcp`;
    const defaultScopes = config.safety.allowWrites ? ['read', 'write'] : ['read'];
    const { provider, clientStore, stateCodec, consentGuard } = createIasOAuthProvider(
      config.ias,
      appUrl,
      verifyKeys,
      audience,
      defaultScopes,
      config.sealingSecret,
      config.dcrSigningSecret,
    );
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(appUrl),
        baseUrl: new URL(appUrl),
        scopesSupported: ['read', 'write', 'admin'],
      }),
    );
    // consentGuard: reject a callback whose browser never passed the /authorize consent page (confused-deputy).
    app.get(
      '/oauth/callback',
      consentGuard,
      createOAuthCallbackHandler(stateCodec, clientStore, { logger: noopLogger }),
    );
    const chained = createChainedTokenVerifier({ apiKeys }, createSealedJweVerifier(verifyKeys, audience), undefined, {
      expandScopes: (s: string[]) => expandScopes(s),
    });
    bearer = requireBearerAuth({
      verifier: { verifyAccessToken: chained },
      resourceMetadataUrl: `${appUrl}/.well-known/oauth-protected-resource`,
    });
    log('inbound: IAS-first per-user (OAuth proxy) + api-key');
  } else {
    // Legacy: XSUAA OAuth URL-login + api-key (the shared-identity PoC path). Fail closed unless ALLOW_OPEN.
    bearer = setupHttpAuth(
      app,
      { apiKeys, xsuaa, expandScopes: (s: string[]) => expandScopes(s), required: !config.allowOpen },
      noopLogger,
    );
    log('inbound: XSUAA + api-key (no IAS config)');
  }

  const mcp: express.RequestHandler = async (req, res) => {
    const server = buildServer(config, clients);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  if (bearer) app.all('/mcp', bearer, mcp);
  else app.all('/mcp', mcp);

  app.listen(config.port, '0.0.0.0', () =>
    log(
      `btp-cf-mcp v${VERSION} listening on :${config.port} (writes=${config.safety.allowWrites}, open=${config.allowOpen})`,
    ),
  );
}
