import { describe, expect, it } from 'vitest';
import { getPolicy } from '../src/policy.js';
import { type ActionCtx, getAction, REGISTRY } from '../src/registry.js';

const SUB = '11111111-1111-1111-1111-111111111111';
function ctx(over: Partial<ActionCtx> = {}): ActionCtx {
  return {
    args: {},
    ga: 'ga-1',
    sub: () => 'sub-guid',
    guid: (f) => (f === 'guid' ? 'app-g' : SUB),
    cf: async () => ({}),
    btp: async () => ({}),
    ...over,
  };
}

describe('registry (single source)', () => {
  it('policy.ACTION_POLICY is derived from the registry — every action resolves, no drift', () => {
    for (const a of REGISTRY) {
      const p = getPolicy(a.tool, a.action);
      expect(p, `${a.tool}.${a.action}`).toBeDefined();
      expect(p?.scope).toBe(a.scope);
      expect(p?.op).toBe(a.op);
      expect(p?.target).toBe(a.target);
    }
  });

  it('reads have a run(); writes are inert (no run)', () => {
    for (const a of REGISTRY) expect(typeof a.run === 'function').toBe(a.op === 'R');
  });

  it('CF app_processes fetches the process list then per-type instance stats and merges them', async () => {
    const paths: string[] = [];
    const cf = async (p: string): Promise<unknown> => {
      paths.push(p);
      return p.endsWith('/processes')
        ? { resources: [{ type: 'web' }] }
        : { resources: [{ index: 0, state: 'RUNNING' }] };
    };
    const out = (await getAction('CFInspect', 'app_processes')?.run?.(ctx({ args: { guid: 'app-g' }, cf }))) as {
      instanceStats: Record<string, unknown>;
    };
    expect(paths).toEqual(['/v3/apps/app-g/processes', '/v3/apps/app-g/processes/web/stats']);
    expect(out.instanceStats.web).toEqual({ resources: [{ index: 0, state: 'RUNNING' }] });
  });

  it('CF list reads flag truncation only when a next page exists', async () => {
    const withNext = await getAction('CFInspect', 'apps')?.run?.(
      ctx({ cf: async () => ({ resources: [], pagination: { next: { href: 'x' }, total_results: 120 } }) }),
    );
    expect((withNext as { _truncated?: boolean })._truncated).toBe(true);
    const noNext = await getAction('CFInspect', 'apps')?.run?.(
      ctx({ cf: async () => ({ resources: [], pagination: { next: null } }) }),
    );
    expect((noNext as { _truncated?: boolean })._truncated).toBeUndefined();
  });

  it('BTP subaccounts lists at the global-account level', async () => {
    let seen: unknown;
    await getAction('BTPInspect', 'subaccounts')?.run?.(
      ctx({
        btp: async (c, a, p) => {
          seen = { c, a, p };
          return {};
        },
      }),
    );
    expect(seen).toEqual({ c: 'accounts/subaccount', a: 'list', p: { globalAccount: 'ga-1' } });
  });

  it('entitlements: GA catalog with no subaccount, plan assignments with one', async () => {
    let seen: any;
    const run = getAction('BTPInspect', 'entitlements')?.run;
    await run?.(
      ctx({
        btp: async (c, a, p) => {
          seen = { c, a, p };
          return {};
        },
      }),
    );
    expect(seen.p).toEqual({ globalAccount: 'ga-1' });
    await run?.(
      ctx({
        args: { subaccount: SUB },
        btp: async (c, a, p) => {
          seen = { c, a, p };
          return {};
        },
      }),
    );
    expect(seen.p).toEqual({ subaccount: SUB });
  });

  it('entitlements projects the catalog to quota fields, dropping iconBase64/dataCenters (6.5MB→~100KB)', async () => {
    const raw = {
      entitledServices: [
        {
          name: 'svc',
          displayName: 'Service',
          businessCategory: { id: 'X', displayName: 'Cat' },
          iconBase64: 'AAAA...huge',
          servicePlans: [
            { name: 'std', amount: 5, remainingAmount: 2, dataCenters: [{ region: 'jp20' }], resources: [] },
          ],
        },
      ],
      serviceTermsOfUseStatus: 'ok',
    };
    const out = (await getAction('BTPInspect', 'entitlements')?.run?.(ctx({ btp: async () => raw }))) as any;
    expect(out.entitledServices[0]).toEqual({
      name: 'svc',
      displayName: 'Service',
      businessCategory: 'Cat',
      servicePlans: [{ name: 'std', amount: 5, remainingAmount: 2 }],
    });
    expect(out.serviceTermsOfUseStatus).toBe('ok'); // small top-level fields pass through
  });

  it('entitlements keeps compact assignmentInfo on assignedServices (who got the plan + how much)', async () => {
    const raw = {
      assignedServices: [
        {
          name: 'svc',
          servicePlans: [
            {
              name: 'std',
              amount: 3,
              assignmentInfo: [
                {
                  entityId: 'sa-1',
                  entityType: 'SUBACCOUNT',
                  amount: 1,
                  entityState: 'OK',
                  unlimitedAmountAssigned: false,
                  resources: [],
                  billingObject: null,
                },
              ],
            },
          ],
        },
      ],
    };
    const out = (await getAction('BTPInspect', 'entitlements')?.run?.(ctx({ btp: async () => raw }))) as any;
    expect(out.assignedServices[0].servicePlans[0].assignmentInfo).toEqual([
      { entityId: 'sa-1', entityType: 'SUBACCOUNT', amount: 1, entityState: 'OK', unlimitedAmountAssigned: false },
    ]); // billing/resources bloat dropped, assignment quota kept
  });

  it('subscriptions drops per-app iconBase64/applicationCoordinates, keeps the rest', async () => {
    const raw = {
      applications: [
        { appName: 'app1', state: 'SUBSCRIBED', iconBase64: 'PNGPNGPNG', applicationCoordinates: { a: 1, b: 2 } },
      ],
    };
    const out = (await getAction('BTPInspect', 'subscriptions')?.run?.(ctx({ btp: async () => raw }))) as any;
    expect(out.applications[0]).toEqual({ appName: 'app1', state: 'SUBSCRIBED' });
  });
});
