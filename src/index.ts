// Composition root: load config, build outbound clients, wire inbound auth, start HTTP.

import { type AuthOptions, loadXsuaaCredentials, resolveAppUrl } from '@arc-mcp/xsuaa-auth';
import { RefreshTokenProvider, StaticTokenProvider } from './auth/token-provider.js';
import { CfClient, CisClient } from './btp.js';
import { loadConfig } from './config.js';
import type { Clients } from './handlers.js';
import { unmatchedDenyPatterns } from './safety.js';
import { startHttp } from './server.js';

const log = (m: string): void => {
  // stderr only (stdout stays clean even though this transport is HTTP)
  console.error(`[btp-cf-mcp] ${m}`);
};

const config = loadConfig();

// Fail loud on a DENY_ACTIONS pattern that matches no known tool.action — a stale name or typo would
// otherwise be a SILENT safety no-op (the action stays allowed).
const badDeny = unmatchedDenyPatterns(config.safety.denyActions);
if (badDeny.length) {
  log(`FATAL: DENY_ACTIONS match no known tool.action (stale name / typo → silent no-op): ${badDeny.join(', ')}`);
  process.exit(1);
}

// Fail loud: IAS-first inbound needs SEALING_SECRET to issue sealed MCP tokens (server.ts gates the OAuth
// path on config.ias && config.sealingSecret). Without it the server would silently boot api-key-only.
if (config.ias && !config.sealingSecret) {
  log(
    'FATAL: IAS_* configured but SEALING_SECRET is missing — the IAS-first path cannot issue sealed tokens. Set SEALING_SECRET (openssl rand -hex 32).',
  );
  process.exit(1);
}

// Shared CF backend (the api-key / headless path). Prefer CF_REFRESH_TOKEN (durable — mints fresh access
// tokens as the ~20min ones expire) over a static CF_TOKEN (dies mid-session). Per-user OAuth callers get
// their own request-scoped CF token instead (handlers.ts), so this is only the shared fallback.
const cfProvider =
  process.env.CF_REFRESH_TOKEN && process.env.CF_UAA_URL
    ? new RefreshTokenProvider(process.env.CF_UAA_URL, process.env.CF_REFRESH_TOKEN)
    : process.env.CF_TOKEN
      ? new StaticTokenProvider(process.env.CF_TOKEN)
      : undefined;

const clients: Clients = {
  cis: config.cis ? new CisClient(config.cis) : undefined,
  subaccountId: config.cis?.subaccountId,
  cf: config.cfApi && cfProvider ? new CfClient(config.cfApi, cfProvider) : undefined,
};

// XSUAA URL-login: enabled when an xsuaa instance is bound. dcrTtlSeconds:0 = clients
// never need to re-register; refresh-token-validity (xs-security.json) governs re-login.
let xsuaa: AuthOptions['xsuaa'] | undefined;
if (config.ias) {
  log('IAS config found — IAS-first per-user inbound (XSUAA skipped)');
} else {
  try {
    xsuaa = {
      credentials: loadXsuaaCredentials(),
      appUrl: resolveAppUrl(process.env, { publicUrlEnvVar: 'PUBLIC_URL', port: config.port }),
      dcrTtlSeconds: 0,
    };
    log('XSUAA binding found — URL login enabled');
  } catch (e) {
    log(`No usable XSUAA binding (${(e as Error).message}) — API-key auth only`);
  }
}

log(
  `backends: cis=${Boolean(clients.cis)} cf=${Boolean(clients.cf)}; writes=${config.safety.allowWrites}; apiKeys=${config.apiKeys.length}`,
);
startHttp(config, clients, xsuaa, log);
