// ADR-002 — IAS app-to-app token exchange (live-proven recipe, see docs/guides/per-user-ias-auth-setup.md).
// Turns the user's IAS id_token into a token audienced for a *provider* app (the CF platform app,
// or any BTP app we depend on), carrying the user — the basis for "acts as you" on CF + BTP.
//
// The crux that took a day to find: grant_type MUST be jwt-bearer with a `resource` URN of the form
// urn:sap:identity:application:provider:clientid:<id>, from a CONFIDENTIAL client. RFC-8693
// token-exchange and a raw client-id `resource` both silently keep aud=our-own-app.

import { decodeJwt } from 'jose';

export interface IasExchangeConfig {
  /** {ias}/oauth2/token */
  iasTokenUrl: string;
  /** our IAS OIDC app (confidential — needs the secret). */
  clientId: string;
  clientSecret: string;
  /** the provider app's IAS client id (e.g. the btp-platform app for CF). */
  providerClientId: string;
}

/** Exchange the user's IAS id_token for a token audienced at `providerClientId`, as the user. */
export async function exchangeForProvider(userIdToken: string, cfg: IasExchangeConfig): Promise<string> {
  if (!userIdToken) throw new Error('exchange: empty user id_token');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: userIdToken,
    resource: `urn:sap:identity:application:provider:clientid:${cfg.providerClientId}`,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(cfg.iasTokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    // Redact the submitted assertion in case the endpoint echoes it back (never log a token).
    const text = (await res.text().catch(() => '')).split(userIdToken).join('<assertion>');
    throw new Error(`IAS exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; id_token?: string };
  const token = json.access_token ?? json.id_token;
  if (!token) throw new Error('IAS exchange: no token in response');
  // A 200 does NOT prove re-audiencing — a public client or wrong `resource` returns aud=our-own-app
  // (docs/guides/per-user-ias-auth-setup.md troubleshooting). Catch that here, not opaquely at `cf auth`.
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(token);
  } catch {
    throw new Error('IAS exchange: token is not a JWT (set IAS Access Token Format = JWT)');
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.providerClientId)) {
    throw new Error(
      `IAS exchange: token not re-audienced to ${cfg.providerClientId} (aud=${JSON.stringify(claims.aud)})`,
    );
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
    throw new Error('IAS exchange: token already expired');
  }
  if (!claims.sub) throw new Error('IAS exchange: token missing sub');
  return token;
}
