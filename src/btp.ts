// REST clients for CIS + Cloud Foundry. Token minting + the TokenProvider seam live in
// ./auth/token-provider.ts (where the PoC's shared client_credentials identity will later
// become a request-scoped per-user token, composed with ias-exchange.ts + cf-token.ts).

import { BackendError, ClientCredentialsProvider, type TokenProvider } from './auth/token-provider.js';
import type { CisCreds } from './config.js';

// `path` must already be a safe, encoded relative path (callers validate args before building it).
async function getJson(base: string, path: string, token: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      headers: { Authorization: `bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000), // bound a hung backend so it can't hang the MCP request
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      console.error(`[btp-cf-mcp] backend timeout for ${path}`);
      throw new BackendError(504);
    }
    throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Full detail to stderr for operators; the thrown error stays generic for the client.
    console.error(`[btp-cf-mcp] backend ${res.status} for ${path}: ${body.slice(0, 500)}`);
    throw new BackendError(res.status);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export class CisClient {
  private readonly provider: ClientCredentialsProvider;
  constructor(private readonly creds: CisCreds) {
    this.provider = new ClientCredentialsProvider(creds.tokenUrl, creds.clientId, creds.clientSecret);
  }
  endpoint(name: string): string {
    const url = this.creds.endpoints[name];
    if (!url) throw new Error(`CIS endpoint '${name}' is not in the service key`);
    return url;
  }
  async get(endpointName: string, path: string): Promise<unknown> {
    return getJson(this.endpoint(endpointName), path, await this.provider.getToken());
  }
}

export class CfClient {
  constructor(
    private readonly api: string,
    private readonly provider: TokenProvider,
  ) {}
  async get(path: string): Promise<unknown> {
    return getJson(this.api, path, await this.provider.getToken());
  }
}
