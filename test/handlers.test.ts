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
