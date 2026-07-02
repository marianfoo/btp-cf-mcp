import { describe, expect, it } from 'vitest';
import { BackendError } from '../src/auth/token-provider.js';
import type { AppConfig } from '../src/config.js';
import { dispatch } from '../src/handlers.js';

const config = {
  port: 0,
  apiKeys: [],
  allowOpen: false,
  safety: { allowWrites: false, allowedSubaccounts: [], allowedOrgs: [], allowedSpaces: [], denyActions: [] },
} as unknown as AppConfig;

const SUB = '65647146-155d-4755-90f4-86ad098be1ee';

describe('BTPInspect central-plan actions on a local-plan CIS key', () => {
  const clients = {
    cis: {
      get: async () => {
        throw new BackendError(401);
      },
    } as any,
    subaccountId: SUB,
  };

  for (const action of ['subaccount', 'entitlements']) {
    it(`${action}: 401 becomes an actionable central-plan message`, async () => {
      const r = await dispatch('BTPInspect', { action }, ['read'], config, clients);
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toMatch(/central-plan cis/i);
    });
  }
});

describe('CIS fallback honors BTP_DEFAULT_SUBACCOUNT (not just the CIS key subaccountId)', () => {
  it('resolves the default subaccount when the CIS key supplies none', async () => {
    const cfg = { ...config, btpDefaultSubaccount: SUB } as unknown as AppConfig;
    // CIS key with NO bound subaccountId → the read must fall back to BTP_DEFAULT_SUBACCOUNT, not throw "must be a GUID".
    const clients = { cis: { get: async () => ({ ok: true }) } as any, subaccountId: undefined };
    const r = await dispatch('BTPInspect', { action: 'subaccount' }, ['read'], cfg, clients);
    expect(r.isError).toBeUndefined();
  });
});

describe('CF writes gate on the SERVER-RESOLVED space (never an LLM-supplied value)', () => {
  const APP = '687d3a2c-dc7d-46c1-bf62-b0dc2ff6f6c3';
  const GOOD_SPACE = 'cc2d9c2e-c38b-4a68-bc4e-4c6962c4acaa';
  const EVIL_SPACE = '99999999-9999-9999-9999-999999999999';
  const writeCfg = (allowedSpaces: string[]): AppConfig =>
    ({
      ...config,
      safety: { ...config.safety, allowWrites: true, allowedSpaces },
    }) as unknown as AppConfig;
  const cfClient = (realSpace: string, posted: string[]) =>
    ({
      get: async (p: string) =>
        p === `/v3/apps/${APP}` ? { relationships: { space: { data: { guid: realSpace } } } } : {},
      post: async (p: string) => {
        posted.push(p);
        return { guid: APP, name: 'a', state: 'STARTED' };
      },
    }) as any;
  const text = (r: any): string => r.content[0].text;

  it('executes when the app really lives in an allowlisted space', async () => {
    const posted: string[] = [];
    const r = await dispatch('CFApps', { action: 'restart', guid: APP }, ['write'], writeCfg([GOOD_SPACE]), {
      cf: cfClient(GOOD_SPACE, posted),
    });
    expect(r.isError).toBeUndefined();
    expect(posted).toEqual([`/v3/apps/${APP}/actions/restart`]);
    expect(text(r)).toMatch(/STARTED/);
  });

  it("refuses when the app's REAL space is not allowlisted, even if the caller claims an allowlisted space", async () => {
    const posted: string[] = [];
    const r = await dispatch(
      'CFApps',
      { action: 'restart', guid: APP, space: GOOD_SPACE }, // LLM claims the allowlisted space — must be ignored
      ['write'],
      writeCfg([GOOD_SPACE]),
      { cf: cfClient(EVIL_SPACE, posted) },
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not in the allowlist/);
    expect(posted).toEqual([]); // nothing mutated
  });

  it('fails closed when the space cannot be resolved', async () => {
    const r = await dispatch('CFApps', { action: 'restart', guid: APP }, ['write'], writeCfg([GOOD_SPACE]), {
      cf: { get: async () => ({}), post: async () => ({}) } as any,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/fail closed/i);
  });

  it('refuses a write without the write scope', async () => {
    const r = await dispatch('CFApps', { action: 'restart', guid: APP }, ['read'], writeCfg([GOOD_SPACE]), {
      cf: cfClient(GOOD_SPACE, []),
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/requires the 'write' scope/);
  });
});

describe('BTP writes gate the subaccount before any backend call', () => {
  it('refuses a non-allowlisted subaccount with no CLI-server call', async () => {
    const cfg = {
      ...config,
      safety: { ...config.safety, allowWrites: true, allowedSubaccounts: [] },
    } as unknown as AppConfig;
    const r = await dispatch(
      'BTPServices',
      { action: 'create_service', subaccount: SUB, name: 'x', offering: 'xsuaa', plan: 'application' },
      ['write'],
      cfg,
      {},
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/not in the allowlist/);
  });
});
