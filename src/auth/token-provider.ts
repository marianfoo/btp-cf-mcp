// Outbound token providers — mint/cache/refresh a bearer for the REST clients. This is the seam
// where the PoC's shared client_credentials identity will become a request-scoped per-user token
// (composed with ias-exchange.ts + cf-token.ts). Moved here from btp.ts so all outbound-token code
// lives next to the rest of the auth module.

import { type CfUaaConfig, cfTokenFromAssertion } from './cf-token.js';
import { exchangeForProvider, type IasExchangeConfig } from './ias-exchange.js';

export interface TokenProvider {
  getToken(): Promise<string>;
}

// Minimal error: never carries the backend response body to the MCP caller (logged to stderr instead).
export class BackendError extends Error {
  constructor(public readonly status: number) {
    super(`backend returned HTTP ${status}`);
    this.name = 'BackendError';
  }
}

// client_credentials mint with in-memory cache (60s buffer) + single-flight refresh.
// Pattern lifted from arc-1 src/server/sinks/btp-auditlog.ts.
export class ClientCredentialsProvider implements TokenProvider {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;
  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (this.inflight) return this.inflight; // coalesce concurrent refreshes
    this.inflight = this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async mint(): Promise<string> {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    if (!res.ok) throw new BackendError(res.status);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }
}

// Static bearer (e.g. a CF token supplied via env) — lets the PoC reach the
// Cloud Controller API before a dedicated CF technical identity exists.
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

// A DURABLE shared CF backend: CF access tokens live only ~20min on some landscapes, so a static token
// dies mid-session. Mint fresh access tokens from a long-lived refresh token instead. Public `cf` client
// (client_id in the body, no secret — same identity as cf-token.ts / the CLI). Cache + single-flight.
export class RefreshTokenProvider implements TokenProvider {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;
  private refreshToken: string; // mutable: some UAAs rotate it on each refresh
  constructor(
    private readonly tokenUrl: string,
    refreshToken: string,
    private readonly clientId = 'cf',
  ) {
    this.refreshToken = refreshToken;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (this.inflight) return this.inflight; // coalesce concurrent refreshes
    this.inflight = this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async mint(): Promise<string> {
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
      }).toString(),
    });
    if (!res.ok) throw new BackendError(res.status);
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    // UAA rotation: a returned refresh_token replaces the old one (which may now be invalid). In-memory
    // only — a restart falls back to the env token (fine on non-rotating landscapes). ponytail: no persistence.
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    return this.token;
  }
}

/** Config for the per-user CF chain (the live-proven outbound recipe). */
export interface IasUserAuthConfig {
  exchange: IasExchangeConfig;
  cfUaa: CfUaaConfig;
}

// Per-user CF token: the live-proven chain (IAS app-to-app exchange → CF UAA), driven by the
// unsealed IAS credential. Re-run per getToken (CF tokens are short-lived); the JWE TTL bounds it.
export class IasUserTokenProvider implements TokenProvider {
  constructor(
    private readonly idToken: string,
    private readonly cfg: IasUserAuthConfig,
  ) {}
  async getToken(): Promise<string> {
    const reaudienced = await exchangeForProvider(this.idToken, this.cfg.exchange);
    return cfTokenFromAssertion(reaudienced, this.cfg.cfUaa);
  }
}
