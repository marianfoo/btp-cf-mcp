import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BtpcliSession,
  btpcliCommand,
  btpcliLogin,
  btpcliLoginPassword,
  cachedSession,
  invalidateSession,
  sessionCacheKey,
} from '../src/auth/btpcli-http.js';
import { BackendError } from '../src/auth/token-provider.js';

const cfg = { server: 'https://cli.test', subdomain: 'ga-sub', idp: 'tenant.accounts.ondemand.com' };
const session: BtpcliSession = { server: 'https://cli.test', sessionId: 'S1', subdomain: 'ga-sub', issuer: 'iss' };

describe('btpcliLogin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts customIdp/subdomain/jwt and returns the session id from the header', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('https://cli.test/login/v2.97.0');
      expect(JSON.parse(init.body)).toEqual({ customIdp: cfg.idp, subdomain: cfg.subdomain, jwt: 'ASSERT' });
      return new Response(JSON.stringify({ mail: 'me@x', issuer: 'iss-x' }), {
        status: 200,
        headers: { 'x-cpcli-sessionid': 'SID123' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const s = await btpcliLogin('ASSERT', cfg);
    // issuer for the command header = the customIdp used at login (cfg.idp), NOT the response issuer.
    expect(s).toEqual({ server: 'https://cli.test', sessionId: 'SID123', subdomain: 'ga-sub', issuer: cfg.idp });
  });

  it('throws BackendError(401) when 200 carries no session id (JWT not accepted)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    await expect(btpcliLogin('bad', cfg)).rejects.toMatchObject({ status: 401 });
  });

  it('propagates a non-200 login status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 502 })),
    );
    await expect(btpcliLogin('x', cfg)).rejects.toMatchObject({ status: 502 });
  });
});

describe('btpcliLoginPassword (read-only technical user)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts customIdp/subdomain/userName/password when an IAS idp is given', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      expect(JSON.parse(init.body)).toEqual({
        customIdp: cfg.idp,
        subdomain: cfg.subdomain,
        userName: 'svc@x',
        password: 'pw',
      });
      return new Response(JSON.stringify({ issuer: 'iss-x' }), {
        status: 200,
        headers: { 'x-cpcli-sessionid': 'SIDp' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const s = await btpcliLoginPassword('svc@x', 'pw', cfg);
    expect(s.sessionId).toBe('SIDp');
  });

  it('omits customIdp for the default IdP (idp = "")', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body).not.toHaveProperty('customIdp');
      expect(body).toMatchObject({ subdomain: cfg.subdomain, userName: 'svc@x', password: 'pw' });
      return new Response('{}', { status: 200, headers: { 'x-cpcli-sessionid': 'SID2' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await btpcliLoginPassword('svc@x', 'pw', { ...cfg, idp: '' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('throws BackendError(401) when the credentials/role are not accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(btpcliLoginPassword('svc@x', 'bad', cfg)).rejects.toMatchObject({ status: 401 });
  });
});

describe('session cache', () => {
  it('reuses a cached session and re-logs-in only after invalidate', async () => {
    let logins = 0;
    const login = async (): Promise<BtpcliSession> => {
      logins++;
      return session;
    };
    const key = sessionCacheKey('tech', 'svc@x', 'ga');
    await cachedSession(key, login);
    await cachedSession(key, login);
    expect(logins).toBe(1); // second call served from cache
    invalidateSession(key);
    await cachedSession(key, login);
    expect(logins).toBe(2); // re-login after invalidate (the 401-retry path)
  });

  it('sessionCacheKey is stable, opaque, and input-sensitive', () => {
    expect(sessionCacheKey('a', 'b')).toBe(sessionCacheKey('a', 'b'));
    expect(sessionCacheKey('a', 'b')).not.toBe(sessionCacheKey('a', 'c'));
    expect(sessionCacheKey('secret')).not.toContain('secret'); // hashed, not raw
  });
});

describe('btpcliCommand', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds /command URL + session headers and returns the parsed backend JSON', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('https://cli.test/command/v2.97.0/accounts/subaccount?get');
      expect(init.headers['X-Cpcli-Sessionid']).toBe('S1');
      expect(init.headers['X-Cpcli-Subdomain']).toBe('ga-sub');
      expect(init.headers['X-Cpcli-Customidp']).toBe('iss');
      expect(JSON.parse(init.body)).toEqual({ paramValues: { subaccount: 'g' } });
      return new Response(JSON.stringify({ displayName: 'dev' }), {
        status: 200,
        headers: { 'x-cpcli-backend-status': '200' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await btpcliCommand(session, 'accounts/subaccount', 'get', { subaccount: 'g' })).toEqual({
      displayName: 'dev',
    });
  });

  it('maps a tunneled backend status >=400 to BackendError (e.g. entitlements 403)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: '403 Forbidden' }), {
            status: 200,
            headers: { 'x-cpcli-backend-status': '403' },
          }),
      ),
    );
    await expect(btpcliCommand(session, 'accounts/entitlement', 'list', {})).rejects.toBeInstanceOf(BackendError);
    await expect(btpcliCommand(session, 'accounts/entitlement', 'list', {})).rejects.toMatchObject({ status: 403 });
  });
});
