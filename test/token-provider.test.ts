import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClientCredentialsProvider,
  IasUserTokenProvider,
  RefreshTokenProvider,
  StaticTokenProvider,
} from '../src/auth/token-provider.js';

describe('StaticTokenProvider', () => {
  it('returns the static token', async () => {
    expect(await new StaticTokenProvider('T').getToken()).toBe('T');
  });
});

describe('ClientCredentialsProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints once, caches, and coalesces concurrent refreshes (single-flight)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: `tok${calls}`, expires_in: 3600 }), { status: 200 });
      }),
    );
    const p = new ClientCredentialsProvider('https://uaa/token', 'id', 'secret');
    const [a, b] = await Promise.all([p.getToken(), p.getToken()]); // concurrent → single mint
    expect(a).toBe('tok1');
    expect(b).toBe('tok1');
    expect(await p.getToken()).toBe('tok1'); // cached
    expect(calls).toBe(1);
  });

  it('POSTs grant_type=client_credentials with Basic auth', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      expect(init.body).toContain('grant_type=client_credentials');
      expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
      return new Response(JSON.stringify({ access_token: 'X', expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await new ClientCredentialsProvider('https://uaa/token', 'id', 'secret').getToken()).toBe('X');
  });

  it('throws on a non-ok token response (status only, no body leak)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('detail', { status: 401 })),
    );
    await expect(new ClientCredentialsProvider('https://uaa/token', 'id', 'secret').getToken()).rejects.toThrow(/401/);
  });
});

describe('RefreshTokenProvider (durable shared CF token)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs grant_type=refresh_token with the public cf client, caches + single-flights', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      calls++;
      expect(init.body).toContain('grant_type=refresh_token');
      expect(init.body).toContain('refresh_token=RT');
      expect(init.body).toContain('client_id=cf');
      expect(init.headers.Authorization).toBeUndefined(); // public client: no Basic auth
      return new Response(JSON.stringify({ access_token: `cf${calls}`, expires_in: 1200 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = new RefreshTokenProvider('https://uaa/oauth/token', 'RT');
    const [a, b] = await Promise.all([p.getToken(), p.getToken()]);
    expect(a).toBe('cf1');
    expect(b).toBe('cf1');
    expect(await p.getToken()).toBe('cf1'); // cached
    expect(calls).toBe(1);
  });

  it('adopts a rotated refresh_token from the response for the next mint', async () => {
    const bodies: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        bodies.push(init.body);
        calls++;
        // expires_in:1 → never cached, so the second getToken re-mints and must reuse the rotated token
        return new Response(
          JSON.stringify({ access_token: `cf${calls}`, expires_in: 1, refresh_token: `RT${calls + 1}` }),
          { status: 200 },
        );
      }),
    );
    const p = new RefreshTokenProvider('https://uaa/oauth/token', 'RT1');
    await p.getToken(); // submits RT1, response rotates to RT2
    await p.getToken(); // must submit RT2, not RT1
    expect(bodies[0]).toContain('refresh_token=RT1');
    expect(bodies[1]).toContain('refresh_token=RT2');
  });

  it('throws on a non-ok response (status only, no body leak)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('detail', { status: 401 })),
    );
    await expect(new RefreshTokenProvider('https://uaa/oauth/token', 'RT').getToken()).rejects.toThrow(/401/);
  });
});

describe('IasUserTokenProvider (per-user CF chain)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('chains IAS exchange → CF UAA and returns the CF token', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const reaudienced = `${b64({ alg: 'none' })}.${b64({ aud: 'prov', sub: 'u', exp: future })}.sig`;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls++;
        return url.includes('ias')
          ? new Response(JSON.stringify({ access_token: reaudienced }), { status: 200 }) // IAS exchange
          : new Response(JSON.stringify({ access_token: 'CFTOK' }), { status: 200 }); // CF UAA
      }),
    );
    const p = new IasUserTokenProvider('IDTOKEN', {
      exchange: { iasTokenUrl: 'https://ias/oauth2/token', clientId: 'c', clientSecret: 's', providerClientId: 'prov' },
      cfUaa: { cfUaaTokenUrl: 'https://uaa/oauth/token' },
    });
    expect(await p.getToken()).toBe('CFTOK');
    expect(calls).toBe(2);
  });
});
