import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { keyFromSecret, unsealCredential } from '../src/auth/sealed-credential.js';
import { createHttpApp } from '../src/server.js';

afterEach(() => vi.unstubAllGlobals());
it('preserves the IAS consent, callback, sealed-token exchange and refresh protocol', async () => {
  const secret = 'local-fixture-secret-'.repeat(4);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const ias = {
    issuer: 'https://ias.example',
    clientId: 'ias-fixture',
    clientSecret: 'fixture-secret',
    providerClientId: 'fixture-provider',
    cfUaaTokenUrl: 'https://uaa.example/token',
  };
  const idToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"fixture-user"}').toString('base64url')}.`;
  const nativeFetch = globalThis.fetch;
  const grants: URLSearchParams[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `${ias.issuer}/oauth2/token`) {
      grants.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ id_token: idToken, refresh_token: 'fixture-refresh' }), { status: 200 });
    }
    if (!String(input).startsWith(origin)) throw new Error('Unexpected external request');
    return nativeFetch(input, init);
  });
  try {
    server.on(
      'request',
      createHttpApp(
        {
          port,
          publicUrl: origin,
          apiKeys: [],
          allowOpen: false,
          consentTrustedRedirects: [],
          ias,
          sealingSecret: secret,
          safety: { allowWrites: false, allowedSubaccounts: [], allowedOrgs: [], allowedSpaces: [], denyActions: [] },
        },
        {},
        undefined,
        () => {},
      ),
    );
    const registered = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'IAS compatibility test',
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const params = new URLSearchParams({
      client_id: client.client_id,
      response_type: 'code',
      redirect_uri: 'https://client.example/callback',
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
      state: 'state+encoding',
    });
    const page = await fetch(`${origin}/authorize?${params}`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    const link = html.match(/class="btn" href="([^"]+)"/);
    expect(link).toBeTruthy();
    const upstream = new URL((link?.[1] ?? '').replace(/&amp;/g, '&'));
    expect(upstream.pathname).toBe('/oauth2/authorize');
    const callbackParams = new URLSearchParams({
      state: upstream.searchParams.get('state') ?? '',
      code: 'fixture-ias-code',
    });
    const callbackUrl = `${origin}/oauth/callback?${callbackParams}`;
    expect((await fetch(callbackUrl, { redirect: 'manual' })).status).toBe(403);
    const returned = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: {
        Cookie: page.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; '),
      },
    });
    expect(returned.status).toBe(302);
    const target = new URL(returned.headers.get('location') ?? '');
    expect(target.searchParams.get('state')).toBe('state+encoding');
    expect(target.searchParams.get('code')).toBe('fixture-ias-code');
    const token = async (fields: Record<string, string>) =>
      fetch(`${origin}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.client_id, ...fields }),
      });
    const issued = await token({
      grant_type: 'authorization_code',
      code: target.searchParams.get('code') ?? '',
      code_verifier: 'V'.repeat(43),
      redirect_uri: 'https://client.example/callback',
    });
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as { access_token: string; refresh_token: string };
    const user = await unsealCredential(tokens.access_token, keyFromSecret(secret), `${origin}/mcp`);
    expect(user.sub).toBe('fixture-user');
    expect(grants[0]?.get('code')).toBe('fixture-ias-code');
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(200);
    expect(grants[1]?.get('refresh_token')).toBe('fixture-refresh');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
