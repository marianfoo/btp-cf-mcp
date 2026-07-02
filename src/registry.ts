// Single source of truth for every tool action. tools.ts (LLM schema + enum + description + annotations)
// and policy.ts (scope/op/target) are DERIVED from this — no three-file drift.
//
// Tool surface = ADR-016 / S3 (research + codex, 2026-07-01): READS and WRITES live in SEPARATE tools so
// each read tool is honestly readOnlyHint:true (hosts auto-approve, no confirm friction) and writes are
// grouped by blast-radius/backend (honest destructiveHint). Keep the tool COUNT small (fewer tools select
// better); grow capability by adding rows, not micro-tools. Read-only deploy → only the two Inspect tools.

import type { OpType, Scope, TargetKind } from './policy.js';

/** What a read action's `run` gets — backend accessors already bound to the resolved identity. */
export interface ActionCtx {
  args: Record<string, unknown>;
  ga: string; // global-account subdomain
  sub: () => string; // resolved subaccount GUID (throws if none configured/passed)
  guid: (field: string) => string; // validate a GUID-shaped arg
  cf: (path: string) => Promise<unknown>; // Cloud Controller v3 GET
  logs: (sourceId: string, limit: number) => Promise<unknown>; // CF log-cache (recent app logs; empty envelopes on 404)
  btp: (command: string, action: string, params: Record<string, unknown>) => Promise<unknown>; // btp CLI-server command
}

export interface ActionDef {
  tool: string;
  action: string;
  scope: Scope;
  op: OpType;
  target?: TargetKind; // writes: the dimension that must be allowlisted
  backend: 'cf' | 'btp';
  cisFallback?: boolean; // btp read also reachable via the legacy shared-CIS key (local plan)
  destructive?: boolean; // write annotation: irreversible / data-loss (delete). reads = never destructive
  idempotent?: boolean; // write annotation: repeating is safe (stop/start/delete)
  params?: string[]; // input params this action reads (for the schema + docs)
  summary: string; // one clause for the tool description
  run?: (ctx: ActionCtx) => Promise<unknown>; // reads only; writes are inert until implemented (dispatch)
}

// ─── Cloud Foundry (Cloud Controller v3) ─────────────────────────────────────────────────────────
// CFInspect = reads (readOnlyHint:true). CFApps = space-targeted app-lifecycle writes.

// CF list reads cap at per_page=50. If there's a next page, mark the result truncated so the LLM doesn't
// report a partial list as complete. (Real cursor pagination is a roadmap item.)
async function cfList(c: ActionCtx, path: string): Promise<unknown> {
  const res = (await c.cf(path)) as { pagination?: { next?: unknown; total_results?: number } };
  if (res?.pagination?.next) {
    const total = res.pagination.total_results ?? 'many';
    return { ...res, _truncated: true, _hint: `Only the first 50 of ${total} shown — refine your query for the rest.` };
  }
  return res;
}

// Keep only the named keys from an object (used by the projections below to trim large SAP/CF payloads).
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

// audit_events: keep who/what/when; drop the verbose per-event `data` blob.
function compactAuditEvents(raw: unknown): unknown {
  const r = raw as { resources?: Array<Record<string, unknown>> };
  if (!Array.isArray(r?.resources)) return raw;
  return {
    events: r.resources.map((e) => ({
      type: e.type,
      actor: (e.actor as { name?: string } | undefined)?.name,
      target: (e.target as { name?: string; type?: string } | undefined)?.name,
      target_type: (e.target as { type?: string } | undefined)?.type,
      space: (e.space as { guid?: string } | undefined)?.guid,
      created_at: e.created_at,
    })),
  };
}

// app_current_droplet: keep what's deployed; drop execution_metadata (a large base64 blob).
function compactDroplet(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  return pick(raw as Record<string, unknown>, [
    'guid',
    'state',
    'image',
    'stack',
    'buildpacks',
    'process_types',
    'created_at',
    'updated_at',
    'lifecycle',
  ]);
}

// service_instance_parameters is config-only by CF contract, but defensively redact any value whose KEY
// looks secret, in case a broker echoed a credential into the parameters.
const SECRET_KEY_RE = /pass|secret|token|key|cert|credential/i;
function redactSecretKeys(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(redactSecretKeys);
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) =>
        SECRET_KEY_RE.test(k) ? [k, '<redacted>'] : [k, redactSecretKeys(v)],
      ),
    );
  }
  return raw;
}

// app_logs: log-cache returns base64 log payloads + nanosecond timestamps — decode to readable lines.
function decodeLogs(raw: unknown): unknown {
  const batch = (raw as { envelopes?: { batch?: Array<Record<string, unknown>> } })?.envelopes?.batch ?? [];
  return {
    logs: batch.map((e) => {
      const log = e.log as { payload?: string; type?: string } | undefined;
      const ts = Number(e.timestamp);
      return {
        time: Number.isFinite(ts) ? new Date(ts / 1e6).toISOString() : undefined,
        type: log?.type,
        instance: e.instance_id,
        message: log?.payload ? Buffer.from(log.payload, 'base64').toString('utf8').replace(/\n$/, '') : '',
      };
    }),
  };
}

const CF: ActionDef[] = [
  {
    tool: 'CFInspect',
    action: 'orgs',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'orgs' = your organizations",
    run: (c) => cfList(c, '/v3/organizations?per_page=50'),
  },
  {
    tool: 'CFInspect',
    action: 'spaces',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'spaces' = your spaces",
    run: (c) => cfList(c, '/v3/spaces?per_page=50'),
  },
  {
    tool: 'CFInspect',
    action: 'apps',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'apps' = apps (up to 50)",
    run: (c) => cfList(c, '/v3/apps?per_page=50'),
  },
  {
    tool: 'CFInspect',
    action: 'services',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'services' = CF service instances",
    run: (c) => cfList(c, '/v3/service_instances?per_page=50'),
  },
  {
    tool: 'CFInspect',
    action: 'routes',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'routes' = routes/URLs",
    run: (c) => cfList(c, '/v3/routes?per_page=50'),
  },
  {
    tool: 'CFInspect',
    action: 'app_detail',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'app_detail' = one app (REQUIRES 'guid')",
    run: (c) => c.cf(`/v3/apps/${c.guid('guid')}`),
  },
  {
    tool: 'CFInspect',
    action: 'app_processes',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'app_processes' = an app's processes + per-instance health/state (REQUIRES 'guid')",
    // /processes gives the process definitions; /processes/:type/stats gives the ACTUAL per-instance state
    // (RUNNING/CRASHED + cpu/mem usage) — merge them so "is anything crashed?" is answered in the payload.
    run: async (c) => {
      const g = c.guid('guid');
      const procs = (await c.cf(`/v3/apps/${g}/processes`)) as { resources?: Array<{ type: string }> };
      const instanceStats: Record<string, unknown> = {};
      for (const p of procs.resources ?? []) {
        instanceStats[p.type] = await c.cf(`/v3/apps/${g}/processes/${p.type}/stats`);
      }
      return { processes: procs, instanceStats };
    },
  },
  // NO 'app_env' / 'app_manifest' / service-binding 'details' / service 'credentials': all leak cleartext
  // secrets (VCAP_SERVICES, env vars, binding passwords) to read scope — excluded on purpose (codex P1).
  {
    tool: 'CFInspect',
    action: 'app_logs',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid', 'limit'],
    summary: "'app_logs' = an app's recent logs (REQUIRES 'guid'; optional 'limit', default 100)",
    run: async (c) => decodeLogs(await c.logs(c.guid('guid'), Number(c.args.limit) || 100)),
  },
  {
    tool: 'CFInspect',
    action: 'app_routes',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'app_routes' = the routes/URLs mapped to an app (REQUIRES 'guid')",
    run: (c) => cfList(c, `/v3/apps/${c.guid('guid')}/routes?per_page=50`),
  },
  {
    tool: 'CFInspect',
    action: 'app_features',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'app_features' = an app's feature toggles (ssh, revisions, …) (REQUIRES 'guid')",
    run: (c) => c.cf(`/v3/apps/${c.guid('guid')}/features`),
  },
  {
    tool: 'CFInspect',
    action: 'app_current_droplet',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'app_current_droplet' = what's deployed right now: image/buildpacks/stack (REQUIRES 'guid')",
    run: async (c) => compactDroplet(await c.cf(`/v3/apps/${c.guid('guid')}/droplets/current`)),
  },
  {
    tool: 'CFInspect',
    action: 'service_bindings',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'service_bindings' = service keys + app-to-service bindings (metadata only, no credentials)",
    run: (c) => cfList(c, '/v3/service_credential_bindings?per_page=50'),
  },
  {
    tool: 'CFInspect',
    action: 'service_instance_parameters',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary:
      "'service_instance_parameters' = a service instance's provisioning config (REQUIRES 'guid'; secret-looking keys redacted)",
    run: async (c) => redactSecretKeys(await c.cf(`/v3/service_instances/${c.guid('guid')}/parameters`)),
  },
  {
    tool: 'CFInspect',
    action: 'audit_events',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    summary: "'audit_events' = recent CF activity newest-first (who did what: deploy/restart/scale/bind)",
    run: async (c) => compactAuditEvents(await c.cf('/v3/audit_events?per_page=50&order_by=-created_at')),
  },
  {
    tool: 'CFInspect',
    action: 'org_usage_summary',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'org_usage_summary' = an org's live consumption: instances/memory/routes (REQUIRES 'guid' = org GUID)",
    run: (c) => c.cf(`/v3/organizations/${c.guid('guid')}/usage_summary`),
  },
  {
    tool: 'CFInspect',
    action: 'org_quota',
    scope: 'read',
    op: 'R',
    backend: 'cf',
    params: ['guid'],
    summary: "'org_quota' = the quota (limits) applied to an org (REQUIRES 'guid' = org GUID)",
    // MUST filter by the org guid — the unfiltered organization_quotas catalog is tens of thousands of rows.
    run: (c) => c.cf(`/v3/organization_quotas?organization_guids=${c.guid('guid')}`),
  },
  {
    tool: 'CFApps',
    action: 'restart',
    scope: 'write',
    op: 'W',
    target: 'space',
    backend: 'cf',
    destructive: false,
    idempotent: false,
    params: ['space'],
    summary: "'restart' an app (write, NOT YET IMPLEMENTED)",
  },
  {
    tool: 'CFApps',
    action: 'stop',
    scope: 'write',
    op: 'W',
    target: 'space',
    backend: 'cf',
    destructive: false,
    idempotent: true,
    params: ['space'],
    summary: "'stop' an app (write, NOT YET IMPLEMENTED)",
  },
  {
    tool: 'CFApps',
    action: 'start',
    scope: 'write',
    op: 'W',
    target: 'space',
    backend: 'cf',
    destructive: false,
    idempotent: true,
    params: ['space'],
    summary: "'start' an app (write, NOT YET IMPLEMENTED)",
  },
];

// The GA entitlement catalog is ~6.5 MB (per-plan iconBase64 + dataCenters + sourceEntitlements) — far too
// big for an LLM context. Project to the fields that answer "which plans + how much quota" (~98% smaller).
// Only the service-catalog shape (entitledServices/assignedServices) is trimmed; other shapes pass through.
const PLAN_KEYS = [
  'name',
  'displayName',
  'amount',
  'remainingAmount',
  'unlimited',
  'category',
  'provisioningMethod',
  'numberOfAssignedEntities',
];
// assignedServices plans carry assignmentInfo = which entity (subaccount) got the plan + how much — the
// whole point of the assigned view. Keep a compact slice of it (codex P2); drop billing/dates/parent bloat.
const ASSIGN_KEYS = ['entityId', 'entityType', 'amount', 'entityState', 'unlimitedAmountAssigned'];
function compactPlan(p: Record<string, unknown>): Record<string, unknown> {
  const out = pick(p, PLAN_KEYS);
  if (Array.isArray(p.assignmentInfo)) {
    out.assignmentInfo = p.assignmentInfo.map((ai) => pick(ai as Record<string, unknown>, ASSIGN_KEYS));
  }
  return out;
}
function compactService(s: Record<string, unknown>): Record<string, unknown> {
  return {
    name: s.name,
    displayName: s.displayName,
    businessCategory: (s.businessCategory as { displayName?: string } | undefined)?.displayName,
    servicePlans: ((s.servicePlans as Record<string, unknown>[]) ?? []).map(compactPlan),
  };
}
function compactEntitlements(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entitledServices) && !Array.isArray(r.assignedServices)) return raw;
  const map = (a: unknown): unknown =>
    Array.isArray(a) ? a.map((s) => compactService(s as Record<string, unknown>)) : a;
  return { ...r, entitledServices: map(r.entitledServices), assignedServices: map(r.assignedServices) };
}

// subscriptions carry a per-app iconBase64 (base64 PNG, ~5KB) + applicationCoordinates (~3.5KB) — useless
// to an LLM and the bulk of a ~157KB payload. Drop just those two; keep every other app field.
const SUB_DROP = ['iconBase64', 'applicationCoordinates'];
function compactSubscriptions(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.applications)) return raw;
  const strip = (app: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(app).filter(([k]) => !SUB_DROP.includes(k)));
  return { ...r, applications: r.applications.map((a) => strip(a as Record<string, unknown>)) };
}

// btp Service Manager catalog rows are wide (icon/metadata/broker-catalog/schema blobs). Strip just those
// known-bloat keys from each item; shape-agnostic (bare array or {items|value|resources:[…]}), else pass through.
const CATALOG_DROP = ['metadata', 'broker_catalog', 'iconBase64', 'schemas', 'labels'];
function compactBtpList(raw: unknown): unknown {
  const stripItem = (o: unknown): unknown =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => !CATALOG_DROP.includes(k)))
      : o;
  if (Array.isArray(raw)) return raw.map(stripItem);
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const key of ['items', 'value', 'resources']) {
      if (Array.isArray(r[key])) return { ...r, [key]: (r[key] as unknown[]).map(stripItem) };
    }
  }
  return raw;
}

// ─── BTP account (btp CLI server) ────────────────────────────────────────────────────────────────
// BTPInspect = reads (readOnlyHint:true). BTPServices = Service Manager writes.
const BTP: ActionDef[] = [
  {
    tool: 'BTPInspect',
    action: 'environments',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    cisFallback: true,
    params: ['subaccount'],
    summary: "'environments' = the subaccount's environment instances (CF/Kyma)",
    run: (c) => c.btp('accounts/environment-instance', 'list', { globalAccount: c.ga, subaccount: c.sub() }),
  },
  {
    tool: 'BTPInspect',
    action: 'subaccount',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    cisFallback: true,
    params: ['subaccount'],
    summary: "'subaccount' = one subaccount's detail",
    run: (c) => c.btp('accounts/subaccount', 'get', { globalAccount: c.ga, subaccount: c.sub() }),
  },
  {
    tool: 'BTPInspect',
    action: 'subaccounts',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    summary: "'subaccounts' = list all subaccounts in the global account",
    run: (c) => c.btp('accounts/subaccount', 'list', { globalAccount: c.ga }),
  },
  {
    tool: 'BTPInspect',
    action: 'global_account',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    summary: "'global_account' = the global account's detail",
    run: (c) => c.btp('accounts/global-account', 'get', { globalAccount: c.ga }),
  },
  {
    tool: 'BTPInspect',
    action: 'subscriptions',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'subscriptions' = multitenant app subscriptions of the subaccount",
    run: async (c) =>
      compactSubscriptions(await c.btp('accounts/subscription', 'list', { globalAccount: c.ga, subaccount: c.sub() })),
  },
  {
    tool: 'BTPInspect',
    action: 'entitlements',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    cisFallback: true,
    params: ['subaccount'],
    summary:
      "'entitlements' = entitled plans + quota: the global-account catalog (no 'subaccount'), or a subaccount's plan assignments (with 'subaccount')",
    run: async (c) => {
      const explicit = c.args.subaccount as string | undefined;
      const raw = await c.btp(
        'accounts/entitlement',
        'list',
        explicit ? { subaccount: c.guid('subaccount') } : { globalAccount: c.ga },
      );
      return compactEntitlements(raw);
    },
  },
  {
    tool: 'BTPInspect',
    action: 'role_collections',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'role_collections' = the subaccount's role collections + their roles (RBAC audit)",
    run: (c) => c.btp('security/role-collection', 'list', { subaccount: c.sub() }),
  },
  // NOTE: 'users' (security/user list) deferred — without the --of-idp origin it defaults to sap.default and
  // misses the custom-IdP shadow users (codex P2). Needs the CLI-server origin param key verified live. (ROADMAP)
  {
    tool: 'BTPInspect',
    action: 'trust_configs',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'trust_configs' = the subaccount's trusted identity providers (SSO/login config)",
    run: (c) => c.btp('security/trust', 'list', { subaccount: c.sub() }),
  },
  {
    tool: 'BTPInspect',
    action: 'security_settings',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'security_settings' = the subaccount's token policy / default IdP / auth settings",
    run: (c) => c.btp('security/settings', 'list', { subaccount: c.sub() }),
  },
  {
    tool: 'BTPInspect',
    action: 'service_instances',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'service_instances' = Service Manager instances in the subaccount (name/offering/plan/status)",
    run: async (c) => compactBtpList(await c.btp('services/instance', 'list', { subaccount: c.sub() })),
  },
  {
    tool: 'BTPInspect',
    action: 'service_offerings',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'service_offerings' = the subaccount's Service Manager catalog (what can be provisioned)",
    run: async (c) => compactBtpList(await c.btp('services/offering', 'list', { subaccount: c.sub() })),
  },
  {
    tool: 'BTPInspect',
    action: 'service_plans',
    scope: 'read',
    op: 'R',
    backend: 'btp',
    params: ['subaccount'],
    summary: "'service_plans' = plans available in the subaccount (map entitlements → concrete plans)",
    run: async (c) => compactBtpList(await c.btp('services/plan', 'list', { subaccount: c.sub() })),
  },
  {
    tool: 'BTPServices',
    action: 'create_service',
    scope: 'write',
    op: 'W',
    target: 'subaccount',
    backend: 'btp',
    destructive: false,
    idempotent: false,
    params: ['subaccount', 'name', 'offering', 'plan'],
    summary: "'create_service' a service instance (write, REQUIRES name+offering+plan, NOT YET IMPLEMENTED)",
  },
  {
    tool: 'BTPServices',
    action: 'delete_service',
    scope: 'write',
    op: 'W',
    target: 'subaccount',
    backend: 'btp',
    destructive: true,
    idempotent: true,
    params: ['subaccount', 'instanceId'],
    summary: "'delete_service' (write, REQUIRES instanceId, DESTRUCTIVE, NOT YET IMPLEMENTED)",
  },
];

export const REGISTRY: ActionDef[] = [...CF, ...BTP];

const BY_KEY = new Map(REGISTRY.map((a) => [`${a.tool}.${a.action}`, a]));

export function getAction(tool: string, action: string): ActionDef | undefined {
  return BY_KEY.get(`${tool}.${action}`);
}

/** Tool names in registration order. */
export function toolNames(): string[] {
  const seen: string[] = [];
  for (const a of REGISTRY) if (!seen.includes(a.tool)) seen.push(a.tool);
  return seen;
}

export function actionsOf(tool: string): ActionDef[] {
  return REGISTRY.filter((a) => a.tool === tool);
}

/** 403-hint for the entitlement reads (the common backend-authorization misconfig). */
export function entitlement403Hint(explicitSub: string | undefined): string {
  return explicitSub
    ? `HTTP 403 reading subaccount entitlements. Assign the read-only "Subaccount Viewer" role to the acting identity on subaccount ${explicitSub} (propagation ~1–2 min).`
    : 'HTTP 403 reading entitlements. Assign the read-only "Global Account Viewer" role to the acting identity at the global account (propagation ~1–2 min).';
}
