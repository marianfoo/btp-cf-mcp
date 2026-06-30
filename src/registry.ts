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
  // NO 'app_env': /v3/apps/:guid/env leaks VCAP_SERVICES binding credentials to read scope (codex P1).
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
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
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
