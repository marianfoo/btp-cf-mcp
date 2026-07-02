import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIasOAuthProvider } from '../src/auth/ias-oauth-provider.js';
import { keyFromSecret, unsealCredential } from '../src/auth/sealed-credential.js';

const fakeJwt = (payload: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;

const ias = {
  issuer: 'https://tenant.accounts.ondemand.com',
  clientId: 'server-cid',
  clientSecret: 'sec',
  providerClientId: 'prov',
  cfUaaTokenUrl: 'https://uaa/token',
};
const secret = 'x'.repeat(64);
const { provider, consentGuard } = createIasOAuthProvider(
  ias,
  'https://app.example',
  keyFromSecret(secret),
  'https://app.example/mcp',
  ['read'],
  secret,
);

function fakeRes() {
  const r: any = { headers: {} };
  r.setHeader = (k: string, v: string) => {
    r.headers[k] = v;
  };
  r.send = (b: string) => {
    r.body = b;
  };
  r.redirect = (u: string) => {
    r.redirected = u;
  };
  return r;
}

const client = (over: Record<string, unknown> = {}) =>
  ({ client_id: 'client-1', client_name: 'Test Client', redirect_uris: ['https://c/cb'], ...over }) as any;
const params = (over: Record<string, unknown> = {}) =>
  ({ redirectUri: 'https://c/cb', codeChallenge: 'chal', scopes: ['read'], ...over }) as any;

describe('consent skip for admin-trusted redirects', () => {
  const { provider: trusting } = createIasOAuthProvider(
    ias,
    'https://app.example',
    keyFromSecret(secret),
    'https://app.example/mcp',
    ['read'],
    secret,
    undefined,
    ['https://c/cb'], // admin pre-approved this exact redirect
  );

  it('302s straight to IAS for a trusted redirect — cookie STILL set (relay defense intact)', async () => {
    const res = fakeRes();
    await trusting.authorize(client(), params(), res);
    expect(res.redirected).toContain('tenant.accounts.ondemand.com/oauth2/authorize');
    expect(res.body).toBeUndefined(); // no interstitial
    expect(res.headers['Set-Cookie']).toMatch(/mcp_consent=[^;]+;.*HttpOnly/); // the actual defense
  });

  it('still shows the interstitial for a DIFFERENT redirect on the same server', async () => {
    const res = fakeRes();
    await trusting.authorize(
      client({ redirect_uris: ['https://evil/cb'] }),
      params({ redirectUri: 'https://evil/cb' }),
      res,
    );
    expect(res.redirected).toBeUndefined();
    expect(res.body).toContain('Authorize access');
  });
});

describe('OAuth consent gate', () => {
  it('renders an interstitial (not a redirect) naming the client + an Approve link to IAS', async () => {
    const res = fakeRes();
    await provider.authorize(client(), params(), res);
    expect(res.redirected).toBeUndefined(); // consent page, NOT a straight 302 to IAS
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toContain('Authorize access');
    expect(res.body).toContain('Test Client');
    expect(res.body).toContain('client-1');
    // Approve continues to IAS with the server's IAS client-id.
    expect(res.body).toContain('tenant.accounts.ondemand.com/oauth2/authorize');
    expect(res.body).toContain('server-cid');
    // A consent cookie is set (binds the flow to this browser — the anti-relay defense).
    expect(res.headers['Set-Cookie']).toMatch(/mcp_consent=[^;]+;.*HttpOnly.*SameSite=Lax/);
  });

  it('HTML-escapes attacker-controlled client name + redirect (no XSS breakout)', async () => {
    const res = fakeRes();
    await provider.authorize(
      client({ client_name: '<script>alert(1)</script>' }),
      params({ redirectUri: 'https://evil/"><img src=x onerror=alert(1)>' }),
      res,
    );
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('"><img'); // attribute/tag breakout must not survive
    expect(res.body).toContain('&quot;&gt;&lt;img');
  });
});

describe('refresh-token rotation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('issues a refresh_token when IAS returns one, and rotates it on refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id_token: fakeJwt({ sub: 'u1' }), refresh_token: 'ias-r1' }), { status: 200 }),
      ),
    );
    const t1 = await provider.exchangeAuthorizationCode({ client_id: 'c' } as any, 'code');
    expect(t1.access_token).toBeTruthy();
    expect(t1.refresh_token).toBeTruthy();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id_token: fakeJwt({ sub: 'u1' }), refresh_token: 'ias-r2' }), { status: 200 }),
      ),
    );
    const t2 = await provider.exchangeRefreshToken({ client_id: 'c' } as any, t1.refresh_token as string);
    expect(t2.access_token).toBeTruthy();
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(t2.refresh_token).toBeTruthy();
  });

  it('omits refresh_token when IAS does not issue one (degrades to re-auth)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id_token: fakeJwt({ sub: 'u1' }) }), { status: 200 })),
    );
    const t = await provider.exchangeAuthorizationCode({ client_id: 'c' } as any, 'code');
    expect(t.access_token).toBeTruthy();
    expect(t.refresh_token).toBeUndefined();
  });

  it('a refresh token cannot be replayed as an access token (distinct audience)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id_token: fakeJwt({ sub: 'u1' }), refresh_token: 'ias-r1' }), { status: 200 }),
      ),
    );
    const t1 = await provider.exchangeAuthorizationCode({ client_id: 'c' } as any, 'code');
    // access audience is https://app.example/mcp; the refresh JWE is bound to a different audience.
    await expect(
      unsealCredential(t1.refresh_token as string, keyFromSecret(secret), 'https://app.example/mcp'),
    ).rejects.toThrow();
  });
});

describe('consent guard (anti-relay: /oauth/callback requires the browser-bound cookie)', () => {
  const guardReq = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as any;
  const guardRes = () => {
    const r: any = { statusCode: 200 };
    r.status = (c: number) => {
      r.statusCode = c;
      return r;
    };
    r.send = (b: string) => {
      r.body = b;
    };
    return r;
  };

  it('rejects (403) a callback with no consent cookie — the relayed-victim case', () => {
    const res = guardRes();
    let nexted = false;
    consentGuard(guardReq(), res, () => {
      nexted = true;
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('accepts a callback carrying the cookie that /authorize set', async () => {
    const ares = fakeRes();
    await provider.authorize(client(), params(), ares);
    const cookie = (ares.headers['Set-Cookie'] as string).split(';')[0]; // "mcp_consent=<value>"
    const res = guardRes();
    let nexted = false;
    consentGuard(guardReq(cookie), res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a forged/tampered cookie', () => {
    const res = guardRes();
    let nexted = false;
    consentGuard(guardReq(`mcp_consent=${Date.now() + 99999}.forgedsignature`), res, () => {
      nexted = true;
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
