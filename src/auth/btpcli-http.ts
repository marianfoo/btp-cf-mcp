// The `btp` CLI server protocol over plain HTTPS — no binary, works in the CF container, acts as the
// user. Live-verified against https://cli.btp.cloud.sap and mirrors the terraform-provider-btp Go
// client (internal/btpcli): login with a user JWT → X-Cpcli-Sessionid; then
// POST /command/<proto>/<command>?<action> with the session headers and {"paramValues":{…}}.
//
// ponytail: per-request login (one extra round-trip per call), no session cache — add a cache only if
// BTPAccount call volume ever makes the login latency matter.

import { createHash } from 'node:crypto';
import { BackendError } from './token-provider.js';

const PROTO = 'v2.97.0';
export const DEFAULT_CLI_SERVER = 'https://cli.btp.cloud.sap';

// In-memory CLI-server session cache. Keyed by a hash of the login credential (per-user id_token or the
// tech user), so isolation is by construction — a request only ever hits its own identity's session.
// TTL is well under the server-side session lifetime; the handler's 401-retry re-logs-in if a cached
// session has gone stale, so staleness self-heals rather than failing the call.
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessionCache = new Map<string, { session: BtpcliSession; exp: number }>();

/** Derive an opaque cache key from credential parts (never store raw tokens/passwords as keys). */
export function sessionCacheKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Return a cached session for `key`, or run `login()` and cache it. */
export async function cachedSession(key: string, login: () => Promise<BtpcliSession>): Promise<BtpcliSession> {
  const now = Date.now();
  const hit = sessionCache.get(key);
  if (hit && hit.exp > now) return hit.session;
  // On a miss, sweep expired entries so per-user (id_token) keys — which never repeat — can't grow the
  // map unbounded in a long-running process. Guarded by a size threshold to keep the common path O(1).
  if (sessionCache.size > 64) for (const [k, v] of sessionCache) if (v.exp <= now) sessionCache.delete(k);
  const session = await login();
  sessionCache.set(key, { session, exp: now + SESSION_TTL_MS });
  return session;
}

export function invalidateSession(key: string): void {
  sessionCache.delete(key);
}

export interface BtpcliLoginConfig {
  server: string;
  subdomain: string; // global account subdomain (e.g. marianzeis-02)
  idp: string; // custom IAS idp host = issuer without scheme
}

export interface BtpcliSession {
  server: string;
  sessionId: string;
  subdomain: string;
  issuer: string;
}

/** Log in with a user JWT (== `btp login --jwt <assertion>`); returns the session for commands. */
export async function btpcliLogin(jwt: string, cfg: BtpcliLoginConfig): Promise<BtpcliSession> {
  const res = await fetch(`${cfg.server}/login/${PROTO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cpcli-Format': 'json' },
    body: JSON.stringify({ customIdp: cfg.idp, subdomain: cfg.subdomain, jwt }),
  });
  const sessionId = res.headers.get('x-cpcli-sessionid') ?? '';
  await res.body?.cancel(); // drain; the session id is in the header, not the body
  // A 200 without a session id means the JWT was not accepted for this global account.
  if (res.status !== 200 || !sessionId) throw new BackendError(res.status === 200 ? 401 : res.status);
  // Commands must carry the SAME customIdp used at login (the regular /login sets the session IdP from the
  // request, per the btp-CLI Go client) — the response 'issuer' can be a dummy value on some tenants.
  return { server: cfg.server, sessionId, subdomain: cfg.subdomain, issuer: cfg.idp };
}

/**
 * Log in with a username + password (a shared read-only technical user). `cfg.idp` = the custom IAS
 * origin host for an IAS user, or '' for the global account's default IdP. Needs the tenant to allow
 * password login (ROPC). Same session shape as btpcliLogin, so the command runner is identical.
 */
export async function btpcliLoginPassword(
  userName: string,
  password: string,
  cfg: BtpcliLoginConfig,
): Promise<BtpcliSession> {
  const body = cfg.idp
    ? { customIdp: cfg.idp, subdomain: cfg.subdomain, userName, password }
    : { subdomain: cfg.subdomain, userName, password };
  const res = await fetch(`${cfg.server}/login/${PROTO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cpcli-Format': 'json' },
    body: JSON.stringify(body),
  });
  const sessionId = res.headers.get('x-cpcli-sessionid') ?? '';
  await res.body?.cancel(); // drain; the session id is in the header
  // A 200 without a session id means the credentials/role were not accepted (or ROPC is disabled).
  if (res.status !== 200 || !sessionId) throw new BackendError(res.status === 200 ? 401 : res.status);
  // Commands carry the SAME customIdp used at login (see btpcliLogin).
  return { server: cfg.server, sessionId, subdomain: cfg.subdomain, issuer: cfg.idp };
}

/** Run one CLI command (e.g. command='accounts/subaccount', action='get'); returns the backend JSON. */
export async function btpcliCommand(
  s: BtpcliSession,
  command: string,
  action: string,
  paramValues: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${s.server}/command/${PROTO}/${command}?${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cpcli-Format': 'json',
      'X-Cpcli-Sessionid': s.sessionId,
      'X-Cpcli-Subdomain': s.subdomain,
      'X-Cpcli-Customidp': s.issuer,
    },
    body: JSON.stringify({ paramValues }),
  });
  if (res.status !== 200) throw new BackendError(res.status);
  const text = await res.text();
  // The CLI server tunnels the real backend status in a header; the body is the payload OR an error.
  const backend = Number(res.headers.get('x-cpcli-backend-status') ?? 200);
  const parsed = text ? JSON.parse(text) : {};
  if (backend >= 400) {
    console.error(
      `[btp-cf-mcp] btpcli ${command}?${action} backend ${backend}: ${JSON.stringify(parsed).slice(0, 300)}`,
    );
    throw new BackendError(backend);
  }
  return parsed;
}
