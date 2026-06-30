import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLoginArgs, childEnv, redactJwt } from '../src/auth/btp-cli.js';
import { cfTokenFromAssertion } from '../src/auth/cf-token.js';

describe('cf-token (CF UAA jwt-bearer)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cfg = { cfUaaTokenUrl: 'https://uaa.cf.example/oauth/token' };

  it('POSTs jwt-bearer with the assertion + public cf client, returns the CF access_token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = init.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(body.get('assertion')).toBe('ASSERT');
      expect(body.get('client_id')).toBe('cf');
      return new Response(JSON.stringify({ access_token: 'CFTOK' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await cfTokenFromAssertion('ASSERT', cfg)).toBe('CFTOK');
    expect(fetchMock).toHaveBeenCalledWith(cfg.cfUaaTokenUrl, expect.anything());
  });

  it('throws on a non-ok UAA response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 401 })),
    );
    await expect(cfTokenFromAssertion('a', cfg)).rejects.toThrow(/401/);
  });

  it('throws when no access_token is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    await expect(cfTokenFromAssertion('a', cfg)).rejects.toThrow(/no access_token/);
  });

  it('throws on an empty assertion', async () => {
    await expect(cfTokenFromAssertion('', cfg)).rejects.toThrow();
  });

  it('redacts the submitted assertion in error output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad assertion ASSERT here', { status: 400 })),
    );
    await expect(cfTokenFromAssertion('ASSERT', cfg)).rejects.toThrow(/<assertion>/);
  });
});

describe('btp-cli hardening (ADR-004)', () => {
  it('buildLoginArgs constructs the proven login command', () => {
    expect(buildLoginArgs({ subdomain: 'sub', idp: 'ias.tenant', jwt: 'J' })).toEqual([
      'login',
      '--url',
      'cli.btp.cloud.sap',
      '--subdomain',
      'sub',
      '--idp',
      'ias.tenant',
      '--jwt',
      'J',
    ]);
  });

  it('redactJwt removes the token from error/log text', () => {
    expect(redactJwt('boom secret-jwt leaked', 'secret-jwt')).toBe('boom <jwt> leaked');
    expect(redactJwt('no secret here', '')).toBe('no secret here');
  });

  it('childEnv excludes server secrets, keeps HOME + BTP_CLIENTCONFIG', () => {
    process.env.SEALING_SECRET = 'super-secret';
    try {
      const env = childEnv('/tmp/h');
      expect(env.HOME).toBe('/tmp/h');
      expect(env.BTP_CLIENTCONFIG).toBe('/tmp/h/config.json');
      expect(env.SEALING_SECRET).toBeUndefined();
    } finally {
      delete process.env.SEALING_SECRET;
    }
  });
});
