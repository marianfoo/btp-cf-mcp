import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeForProvider } from '../src/auth/ias-exchange.js';
import { keyFromSecret, sealCredential, unsealCredential } from '../src/auth/sealed-credential.js';
import { createSealedJweVerifier } from '../src/auth/sealed-verifier.js';

describe('sealed-credential (ADR-009)', () => {
  const key = keyFromSecret('test-sealing-secret');
  const AUD = 'https://srv/mcp';

  it('roundtrips the credential + sub + scopes (audience-bound)', async () => {
    const sealed = await sealCredential({ iasCredential: 'refresh-xyz', sub: 'user@x.de', scopes: ['read'] }, key, {
      audience: AUD,
    });
    expect(sealed.split('.')).toHaveLength(5); // JWE compact serialization
    const out = await unsealCredential(sealed, key, AUD);
    expect(out.iasCredential).toBe('refresh-xyz');
    expect(out.sub).toBe('user@x.de');
    expect(out.scopes).toEqual(['read']);
    expect(typeof out.exp).toBe('number');
  });

  it('rejects a wrong key (different instance secret)', async () => {
    const sealed = await sealCredential({ iasCredential: 'r', sub: 's', scopes: [] }, key, { audience: AUD });
    await expect(unsealCredential(sealed, keyFromSecret('other-secret'), AUD)).rejects.toThrow();
  });

  it('rejects the wrong audience (no cross-service replay)', async () => {
    const sealed = await sealCredential({ iasCredential: 'r', sub: 's', scopes: [] }, key, { audience: AUD });
    await expect(unsealCredential(sealed, key, 'https://other/mcp')).rejects.toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth fails)', async () => {
    const parts = (await sealCredential({ iasCredential: 'r', sub: 's', scopes: [] }, key, { audience: AUD })).split(
      '.',
    );
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1); // flip one ciphertext char
    await expect(unsealCredential(parts.join('.'), key, AUD)).rejects.toThrow();
  });

  it('rejects an expired credential', async () => {
    const sealed = await sealCredential({ iasCredential: 'r', sub: 's', scopes: [] }, key, {
      audience: AUD,
      ttl: '0s',
    });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(unsealCredential(sealed, key, AUD)).rejects.toThrow();
  });

  it('keyFromSecret: 32 bytes, deterministic, rejects empty', () => {
    expect(keyFromSecret('a')).toHaveLength(32);
    expect([...keyFromSecret('a')]).toEqual([...keyFromSecret('a')]);
    expect(() => keyFromSecret('')).toThrow();
  });

  it('key rotation: a token sealed with the old key unseals via [new, old] but not [new] alone', async () => {
    const oldKey = keyFromSecret('old-secret');
    const newKey = keyFromSecret('new-secret');
    const sealed = await sealCredential({ iasCredential: 'r', sub: 's', scopes: ['read'] }, oldKey, { audience: AUD });
    expect((await unsealCredential(sealed, [newKey, oldKey], AUD)).sub).toBe('s');
    await expect(unsealCredential(sealed, [newKey], AUD)).rejects.toThrow();
  });
});

describe('sealed-verifier (ADR-009)', () => {
  const key = keyFromSecret('test-sealing-secret');
  const AUD = 'https://srv/mcp';

  it('unseals a token into AuthInfo carrying the IAS credential', async () => {
    const token = await sealCredential({ iasCredential: 'idtok', sub: 'u@x.de', scopes: ['read', 'write'] }, key, {
      audience: AUD,
    });
    const info = await createSealedJweVerifier(key, AUD)(token);
    expect(info.clientId).toBe('u@x.de');
    expect(info.scopes).toEqual(['read', 'write']);
    expect(typeof info.expiresAt).toBe('number');
    expect(info.extra).toEqual({ sub: 'u@x.de', iasCredential: 'idtok' });
  });

  it('throws on a non-sealed / api-key token (so the chain falls through)', async () => {
    await expect(createSealedJweVerifier(key, AUD)('not-a-jwe')).rejects.toThrow();
  });
});

describe('ias-exchange (ADR-002)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cfg = {
    iasTokenUrl: 'https://ias.example/oauth2/token',
    clientId: 'cid',
    clientSecret: 'sec',
    providerClientId: '306ee77d',
  };
  const future = () => Math.floor(Date.now() / 1000) + 3600;
  const jwt = (claims: object): string => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
  };

  it('POSTs jwt-bearer + the resource URN + Basic auth, returns the re-audienced access_token', async () => {
    const tok = jwt({ aud: '306ee77d', sub: 'u', exp: future() });
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = init.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(body.get('resource')).toBe('urn:sap:identity:application:provider:clientid:306ee77d');
      expect(body.get('assertion')).toBe('USER_IDTOKEN');
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
      return new Response(JSON.stringify({ access_token: tok }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await exchangeForProvider('USER_IDTOKEN', cfg)).toBe(tok);
    expect(fetchMock).toHaveBeenCalledWith(cfg.iasTokenUrl, expect.anything());
  });

  it('falls back to id_token when no access_token', async () => {
    const tok = jwt({ aud: '306ee77d', sub: 'u', exp: future() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id_token: tok }), { status: 200 })),
    );
    expect(await exchangeForProvider('x', cfg)).toBe(tok);
  });

  it('rejects a token not re-audienced to the provider (200 but aud unchanged)', async () => {
    const tok = jwt({ aud: 'cid', sub: 'u', exp: future() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: tok }), { status: 200 })),
    );
    await expect(exchangeForProvider('x', cfg)).rejects.toThrow(/re-audienced/);
  });

  it('throws on a non-ok IAS response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    );
    await expect(exchangeForProvider('x', cfg)).rejects.toThrow(/400/);
  });

  it('throws on an empty user token', async () => {
    await expect(exchangeForProvider('', cfg)).rejects.toThrow();
  });

  it('redacts the submitted assertion in error output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('error: assertion USER_IDTOKEN invalid', { status: 400 })),
    );
    await expect(exchangeForProvider('USER_IDTOKEN', cfg)).rejects.toThrow(/<assertion>/);
  });
});
