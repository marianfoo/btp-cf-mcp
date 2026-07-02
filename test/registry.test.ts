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
    cfPost: async () => ({}),
    logs: async () => ({}),
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

  it('every action (reads AND writes) has a run()', () => {
    for (const a of REGISTRY) expect(typeof a.run, `${a.tool}.${a.action}`).toBe('function');
  });

  it('every write declares a target dimension (the allowlist gate)', () => {
    for (const a of REGISTRY.filter((x) => x.op !== 'R')) {
      expect(a.target, `${a.tool}.${a.action}`).toBeDefined();
    }
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

  const cfPath = async (action: string, args: Record<string, unknown> = {}): Promise<string> => {
    let p = '';
    const cf = async (x: string): Promise<unknown> => {
      p = x;
      return { resources: [] };
    };
    await getAction('CFInspect', action)?.run?.(ctx({ args, cf }));
    return p;
  };

  it('new CF reads build the right Cloud Controller paths', async () => {
    expect(await cfPath('app_routes', { guid: 'app-g' })).toBe('/v3/apps/app-g/routes?per_page=50');
    expect(await cfPath('app_features', { guid: 'app-g' })).toBe('/v3/apps/app-g/features');
    expect(await cfPath('app_current_droplet', { guid: 'app-g' })).toBe('/v3/apps/app-g/droplets/current');
    expect(await cfPath('service_instance_parameters', { guid: 'si-g' })).toBe(
      '/v3/service_instances/app-g/parameters',
    );
    expect(await cfPath('org_usage_summary', {})).toBe('/v3/organizations/app-g/usage_summary');
    expect(await cfPath('org_quota', {})).toBe('/v3/organization_quotas?organization_guids=app-g');
    expect(await cfPath('audit_events')).toBe('/v3/audit_events?per_page=50&order_by=-created_at');
  });

  it('app_logs decodes base64 log-cache payloads (and reads the app guid)', async () => {
    const payload = Buffer.from('boot complete\n', 'utf8').toString('base64');
    const out = (await getAction('CFInspect', 'app_logs')?.run?.(
      ctx({
        args: { guid: 'app-g' },
        logs: async () => ({
          envelopes: { batch: [{ timestamp: '1700000000000000000', instance_id: '0', log: { payload, type: 'OUT' } }] },
        }),
      }),
    )) as any;
    expect(out.logs[0]).toMatchObject({ type: 'OUT', instance: '0', message: 'boot complete' });
  });

  it('service_instance_parameters redacts secret-looking keys, keeps config', async () => {
    const out = await getAction('CFInspect', 'service_instance_parameters')?.run?.(
      ctx({ args: { guid: 'si-g' }, cf: async () => ({ sapsystemname: 'H01', db_password: 'x', apiKey: 'y' }) }),
    );
    expect(out).toEqual({ sapsystemname: 'H01', db_password: '<redacted>', apiKey: '<redacted>' });
  });

  it('new BTP reads call the right btp CLI commands (subaccount-scoped)', async () => {
    const seen = async (action: string): Promise<unknown> => {
      let s: unknown;
      const btp = async (c: string, a: string, p: Record<string, unknown>): Promise<unknown> => {
        s = { c, a, p };
        return {};
      };
      await getAction('BTPInspect', action)?.run?.(ctx({ btp }));
      return s;
    };
    expect(await seen('role_collections')).toEqual({
      c: 'security/role-collection',
      a: 'list',
      p: { subaccount: 'sub-guid' },
    });
    expect(await seen('trust_configs')).toEqual({ c: 'security/trust', a: 'list', p: { subaccount: 'sub-guid' } });
    expect(await seen('service_offerings')).toEqual({
      c: 'services/offering',
      a: 'list',
      p: { subaccount: 'sub-guid' },
    });
  });

  it('compactBtpList strips catalog bloat keys regardless of wrapper', async () => {
    const out = (await getAction('BTPInspect', 'service_offerings')?.run?.(
      ctx({ btp: async () => ({ items: [{ name: 'xsuaa', metadata: { big: 1 }, iconBase64: 'x' }] }) }),
    )) as any;
    expect(out.items[0]).toEqual({ name: 'xsuaa' });
  });

  it('CFApps writes POST the v3 action endpoints and return app state + next step', async () => {
    for (const action of ['restart', 'stop', 'start']) {
      let posted = '';
      const cfPost = async (p: string): Promise<unknown> => {
        posted = p;
        return { guid: 'app-g', name: 'my-app', state: 'STARTED', created_at: 'x', lifecycle: {} };
      };
      const out = (await getAction('CFApps', action)?.run?.(ctx({ args: { guid: 'app-g' }, cfPost }))) as any;
      expect(posted).toBe(`/v3/apps/app-g/actions/${action}`);
      expect(out.app).toEqual({ guid: 'app-g', name: 'my-app', state: 'STARTED' }); // projected, no lifecycle noise
      expect(out._next).toMatch(/app_processes/);
    }
  });

  it('create_service sends the live-captured CLI-server wire params', async () => {
    let seen: any;
    const btp = async (c: string, a: string, p: Record<string, unknown>): Promise<unknown> => {
      seen = { c, a, p };
      return { id: 'new-id' };
    };
    const out = (await getAction('BTPServices', 'create_service')?.run?.(
      ctx({ args: { name: 'my-xsuaa', offering: 'xsuaa', plan: 'application' }, btp }),
    )) as any;
    expect(seen).toEqual({
      c: 'services/instance',
      a: 'create',
      p: { subaccount: 'sub-guid', name: 'my-xsuaa', offeringName: 'xsuaa', planName: 'application' },
    });
    expect(out._next).toMatch(/service_instances/);
  });

  it('create_service refuses an injection-shaped name', async () => {
    await expect(
      getAction('BTPServices', 'create_service')?.run?.(
        ctx({ args: { name: 'x; rm -rf /', offering: 'xsuaa', plan: 'application' } }),
      ),
    ).rejects.toThrow(/must be 1-64 chars/);
  });

  it('delete_service sends instanceID + confirm (the captured delete wire format)', async () => {
    let seen: any;
    const btp = async (c: string, a: string, p: Record<string, unknown>): Promise<unknown> => {
      seen = { c, a, p };
      return {};
    };
    await getAction('BTPServices', 'delete_service')?.run?.(ctx({ args: { instanceId: SUB }, btp }));
    expect(seen).toEqual({
      c: 'services/instance',
      a: 'delete',
      p: { subaccount: 'sub-guid', instanceID: SUB, confirm: 'true' },
    });
  });
});
