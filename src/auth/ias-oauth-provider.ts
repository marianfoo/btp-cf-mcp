// IAS-proxying OAuth provider (ADR-007). Mirrors the XSUAA provider's callback-proxy structure, but
// the upstream is IAS (`/oauth2/*`) and `exchangeAuthorizationCode` SEALS the IAS id_token into the
// audience-bound JWE that IS the server's MCP access token (ADR-009) — never an upstream passthrough.
//
// Uses StatelessDcrClientStore so MCP clients register via DCR. The confused-deputy risk of DCR + a
// static upstream IAS client-id is mitigated by a per-authorization CONSENT GATE: `authorize()` renders
// an interstitial naming the requesting client + its redirect, AND sets a signed browser cookie that
// `/oauth/callback` requires (createConsentGuard) — so an attacker who scrapes the Approve URL and relays
// the victim straight to IAS is rejected (the victim's browser has no cookie). Mapping IAS groups to
// scopes remains future work (scopes are read/write by ALLOW_WRITES today).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuthStateCodec, StatelessDcrClientStore, type Verifier } from '@arc-mcp/xsuaa-auth';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { RequestHandler, Response } from 'express';
import { decodeJwt } from 'jose';
import type { IasConfig } from '../config.js';
import { sealCredential, unsealCredential } from './sealed-credential.js';
import { createSealedJweVerifier } from './sealed-verifier.js';

const IAS_LOGIN_SCOPES = 'openid email profile groups offline_access';
const TOKEN_TTL_SEC = 1800;
const REFRESH_TTL = '8h';

// Consent cookie: proves this BROWSER passed the /authorize consent page. Verified at /oauth/callback so a
// relayed victim (whose browser never saw consent) is rejected — the confused-deputy defense (see authorize).
const CONSENT_COOKIE = 'mcp_consent';
const CONSENT_TTL_MS = 10 * 60 * 1000;

function signConsent(secret: string): string {
  const exp = String(Date.now() + CONSENT_TTL_MS);
  return `${exp}.${createHmac('sha256', secret).update(exp).digest('base64url')}`;
}

function consentValid(value: string | undefined, secret: string): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(createHmac('sha256', secret).update(exp).digest('base64url'));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  return Number(exp) > Date.now();
}

/** Express middleware for /oauth/callback: require a valid consent cookie (set at /authorize). */
export function createConsentGuard(secret: string): RequestHandler {
  return (req, res, next) => {
    const raw = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${CONSENT_COOKIE}=`))
      ?.slice(CONSENT_COOKIE.length + 1);
    if (!consentValid(raw, secret)) {
      res.status(403).send('Authorization consent is missing or expired. Restart the sign-in from your MCP client.');
      return;
    }
    next();
  };
}

// Client-supplied values (name/redirect via DCR) are attacker-controlled — HTML-escape before rendering.
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function renderConsentPage(o: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  approveUrl: string;
}): string {
  const row = (k: string, v: string): string =>
    `<div class="field"><span class="k">${k}</span> <span class="v">${escapeHtml(v)}</span></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize access</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
.card{border:1px solid #e0e0e0;border-radius:12px;padding:1.5rem 1.75rem}
h2{margin:0 0 .5rem}.field{margin:.45rem 0;font-size:.95rem}.k{color:#666}
.v{font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all}
.btn{display:inline-block;margin-top:1.3rem;padding:.6rem 1.4rem;background:#0a6ed1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}
.warn{color:#a6360a;font-size:.85rem;margin-top:1rem}</style></head>
<body><div class="card">
<h2>Authorize access</h2>
<p>An application wants to sign in to SAP BTP <b>as you</b> through this MCP server.</p>
${row('Application:', o.clientName)}
${row('Client ID:', o.clientId)}
${row('Redirects to:', o.redirectUri)}
${row('Access:', o.scopes.join(', ') || 'read')}
<p class="warn">Approve only if you started this from a client you trust and the redirect above looks right.</p>
<a class="btn" href="${escapeHtml(o.approveUrl)}">Approve &amp; continue to SAP login</a>
</div></body></html>`;
}

export class IasProxyOAuthProvider extends ProxyOAuthServerProvider {
  private readonly authUrl: string;
  private readonly tokenUrl: string;

  constructor(
    private readonly ias: IasConfig,
    private readonly sealKey: Uint8Array,
    private readonly audience: string,
    private readonly defaultScopes: string[],
    verifier: Verifier,
    private readonly store: StatelessDcrClientStore,
    private readonly callbackUrl: string,
    private readonly stateCodec: OAuthStateCodec,
    private readonly signingSecret: string,
    private readonly secureCookies: boolean,
    // Seal with `sealKey` (current); unseal refresh tokens with all keys (current + previous) so refresh
    // survives a SEALING_SECRET rotation. Defaults to [sealKey] when no previous key is configured.
    private readonly unsealKeys: Uint8Array[] = [sealKey],
  ) {
    const authUrl = `${ias.issuer}/oauth2/authorize`;
    const tokenUrl = `${ias.issuer}/oauth2/token`;
    super({
      endpoints: { authorizationUrl: authUrl, tokenUrl },
      verifyAccessToken: verifier,
      getClient: (clientId) => store.getClient(clientId),
    });
    this.authUrl = authUrl;
    this.tokenUrl = tokenUrl;
    this.skipLocalPkceValidation = true; // forward the client's PKCE challenge to IAS
  }

  get clientsStore(): StatelessDcrClientStore {
    return this.store;
  }

  // Show a CONSENT GATE naming the requesting client, then (on Approve) redirect to IAS with the server's
  // IAS client-id + /oauth/callback; the client's redirect + state are encoded so /oauth/callback returns
  // to the client (the issue-#214 callback-proxy pattern). The gate is the confused-deputy defense for
  // DCR + a static upstream client-id: the user sees WHICH client + redirect they are authorizing.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const proxyState = this.stateCodec.encode({
      clientState: params.state,
      clientRedirectUri: params.redirectUri,
      clientId: client.client_id,
    });
    const url = new URL(this.authUrl);
    url.search = new URLSearchParams({
      client_id: this.ias.clientId,
      response_type: 'code',
      redirect_uri: this.callbackUrl,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state: proxyState,
      scope: IAS_LOGIN_SCOPES,
    }).toString();
    // Bind the consent to this browser: /oauth/callback requires this cookie, so an attacker who scrapes
    // the Approve URL and relays the victim straight to IAS is rejected (the victim's browser has no cookie).
    res.setHeader(
      'Set-Cookie',
      `${CONSENT_COOKIE}=${signConsent(this.signingSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CONSENT_TTL_MS / 1000}${this.secureCookies ? '; Secure' : ''}`,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(
      renderConsentPage({
        clientName: client.client_name || client.client_id,
        clientId: client.client_id,
        redirectUri: params.redirectUri ?? '(none)',
        scopes: params.scopes ?? this.defaultScopes,
        approveUrl: url.toString(),
      }),
    );
  }

  // Exchange the IAS code for the IAS id_token, then SEAL it into the MCP access token (the JWE).
  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: this.ias.clientId,
      client_secret: this.ias.clientSecret,
      redirect_uri: this.callbackUrl,
    });
    if (codeVerifier) body.set('code_verifier', codeVerifier);
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`IAS token exchange failed: ${res.status}`);
    const data = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
    const idToken = data.id_token ?? data.access_token;
    if (!idToken) throw new Error('IAS token exchange: no id_token in response');
    const claims = decodeJwt(idToken);
    const sub = typeof claims.sub === 'string' ? claims.sub : String(claims.mail ?? 'unknown');
    return this.issueTokens(idToken, data.refresh_token, sub);
  }

  // Refresh: unseal the (audience-bound) refresh JWE → the IAS refresh_token → IAS refresh grant → a new
  // sealed access token (+ rotated refresh). If IAS never issued a refresh_token, no refresh JWE was ever
  // returned, so this path isn't reached — the client just re-authenticates.
  async exchangeRefreshToken(_client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const { iasCredential: iasRefresh, sub } = await unsealCredential(
      refreshToken,
      this.unsealKeys,
      this.refreshAudience(),
    );
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: iasRefresh,
        client_id: this.ias.clientId,
        client_secret: this.ias.clientSecret,
        scope: IAS_LOGIN_SCOPES,
      }).toString(),
    });
    if (!res.ok) throw new Error(`IAS refresh failed: ${res.status}`);
    const data = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
    const idToken = data.id_token ?? data.access_token;
    if (!idToken) throw new Error('IAS refresh: no id_token in response');
    return this.issueTokens(idToken, data.refresh_token, sub);
  }

  private refreshAudience(): string {
    return `${this.audience}+refresh`;
  }

  // Seal the id_token into the MCP access token; if IAS issued a refresh_token, seal it too (distinct
  // audience so it can't be replayed as an access token at /mcp).
  private async issueTokens(idToken: string, iasRefresh: string | undefined, sub: string): Promise<OAuthTokens> {
    const access_token = await sealCredential(
      { iasCredential: idToken, sub, scopes: this.defaultScopes },
      this.sealKey,
      {
        audience: this.audience,
        ttl: `${TOKEN_TTL_SEC}s`,
      },
    );
    const out: OAuthTokens = { access_token, token_type: 'bearer', expires_in: TOKEN_TTL_SEC };
    if (iasRefresh) {
      out.refresh_token = await sealCredential(
        { iasCredential: iasRefresh, sub, scopes: this.defaultScopes },
        this.sealKey,
        {
          audience: this.refreshAudience(),
          ttl: REFRESH_TTL,
        },
      );
    }
    return out;
  }
}

/** Build the IAS proxy provider + the DCR store + state codec (the transport wires the callback). */
export function createIasOAuthProvider(
  ias: IasConfig,
  appUrl: string,
  sealKeys: Uint8Array | Uint8Array[], // current [, previous…] — seal uses the first, unseal tries all
  audience: string,
  defaultScopes: string[],
  signingSecret: string,
): {
  provider: IasProxyOAuthProvider;
  clientStore: StatelessDcrClientStore;
  stateCodec: OAuthStateCodec;
  consentGuard: RequestHandler;
} {
  const unsealKeys = Array.isArray(sealKeys) ? sealKeys : [sealKeys];
  const sealKey = unsealKeys[0];
  const clientStore = new StatelessDcrClientStore(ias.clientId, ias.clientSecret, signingSecret, { ttlSeconds: 0 });
  const stateCodec = new OAuthStateCodec(signingSecret);
  const callbackUrl = `${appUrl.replace(/\/$/, '')}/oauth/callback`;
  const verifier = createSealedJweVerifier(unsealKeys, audience);
  const provider = new IasProxyOAuthProvider(
    ias,
    sealKey,
    audience,
    defaultScopes,
    verifier,
    clientStore,
    callbackUrl,
    stateCodec,
    signingSecret,
    appUrl.startsWith('https://'),
    unsealKeys,
  );
  return { provider, clientStore, stateCodec, consentGuard: createConsentGuard(signingSecret) };
}
