// MCP tool definitions (the schema the LLM sees) + safety-aware pruning — all DERIVED from the
// single-source registry (src/registry.ts). Adding an action there updates the schema, the enum, and
// the description here automatically. The LLM never sees an action its scope/backend can't run.

import { hasScope } from './policy.js';
import { type ActionDef, actionsOf, toolNames } from './registry.js';
import { isDenied } from './safety.js';

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export interface VisibilityCtx {
  allowWrites: boolean;
  denyActions: string[];
  // Writes are per-user only (dispatch refuses shared-identity callers) — don't advertise write tools
  // to a caller whose request carries no IAS credential, or they'd see tools that always fail.
  perUser: boolean;
  // cf = a CF backend (per-user or shared token); cis = the shared CIS key; btpCli = the per-user/tech
  // btp CLI-server path (the primary BTP backend).
  backends: { cf: boolean; cis: boolean; btpCli: boolean };
}

const PARAM_DESC: Record<string, string> = {
  guid: 'Resource GUID — an APP guid for the app_* actions and CFApps writes, an ORG guid for org_usage_summary/org_quota, a SERVICE-INSTANCE guid for service_instance_parameters. UUID form, e.g. 6064d98a-95e6-400b-8a0e-37dcc14a5f7d.',
  limit: 'Max rows to return (e.g. app_logs line count). Optional; defaults to 100.',
  subaccount:
    "Subaccount GUID. Defaults to the bound/configured subaccount (the CIS key's, or BTP_DEFAULT_SUBACCOUNT); REQUIRED if none is configured. UUID form.",
  name: "Name for the new service instance. Required for 'create_service'.",
  offering: "Service offering technical name, e.g. 'xsuaa' or 'destination'. Required for 'create_service'.",
  plan: "Service plan, e.g. 'application' or 'lite'. Required for 'create_service'.",
  instanceId: "GUID of the service instance to delete. Required for 'delete_service'.",
};

const TOOL_INTRO: Record<string, string> = {
  CFInspect:
    'READ Cloud Foundry via the Cloud Controller v3 API, as the logged-in user (or a shared CF token). Read-only. Reports the backend unavailable if CF is not configured. Actions: ',
  CFApps:
    "Cloud Foundry app-lifecycle WRITES — these EXECUTE against the Cloud Controller. Address the app by 'guid'; the server resolves the app's real space and refuses if it is not allowlisted. Actions: ",
  BTPInspect:
    'READ an SAP BTP account via the btp CLI account APIs, as the logged-in user (or a shared read-only technical user); works on a free/local subaccount. Read-only. Reads need the matching read-only role (Global Account Viewer, or Subaccount Viewer for subaccount-scoped reads) — HTTP 403 otherwise. Actions: ',
  BTPServices:
    'SAP BTP service-instance WRITES (Service Manager) — these EXECUTE as the acting identity. The target subaccount must be allowlisted; provisioning/deletion may complete asynchronously (verify with BTPInspect). Actions: ',
};

const TOOL_TITLE: Record<string, string> = {
  CFInspect: 'Cloud Foundry — read',
  CFApps: 'Cloud Foundry apps — write',
  BTPInspect: 'BTP account — read',
  BTPServices: 'BTP services — write',
};

// MCP tool annotations, derived from the tool's actions (honest per-tool: a read tool is readOnlyHint:true,
// so hosts can auto-approve; a write tool sets destructive/idempotent from its actions). Advisory only —
// the real boundary stays the safety gate + scopes + SAP/CF authz.
function annotationsFor(actions: ActionDef[], name: string): ToolAnnotations {
  const readOnly = actions.every((a) => a.op === 'R');
  return {
    title: TOOL_TITLE[name] ?? name,
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : actions.some((a) => Boolean(a.destructive)),
    idempotentHint: actions.every((a) => a.idempotent ?? a.op === 'R'),
    openWorldHint: true, // hits external SAP BTP / Cloud Foundry APIs
  };
}

function buildTool(name: string, actions: ActionDef[]): ToolDef {
  const params = [...new Set(actions.flatMap((a) => a.params ?? []))];
  const props: Record<string, unknown> = { action: { type: 'string', enum: actions.map((a) => a.action) } };
  for (const p of params) props[p] = { type: 'string', description: PARAM_DESC[p] ?? p };
  return {
    name,
    description: `${TOOL_INTRO[name] ?? ''}${actions.map((a) => a.summary).join('; ')}.`,
    inputSchema: { type: 'object', properties: props, required: ['action'], additionalProperties: false },
    annotations: annotationsFor(actions, name),
  };
}

export function allTools(): ToolDef[] {
  return toolNames().map((n) => buildTool(n, actionsOf(n)));
}

function actionVisible(a: ActionDef, scopes: string[], ctx: VisibilityCtx): boolean {
  if (!hasScope(scopes, a.scope)) return false;
  if (a.op !== 'R' && (!ctx.allowWrites || !ctx.perUser)) return false;
  if (isDenied(ctx.denyActions, a.tool, a.action)) return false;
  if (a.backend === 'cf') return ctx.backends.cf;
  return ctx.backends.btpCli || (Boolean(a.cisFallback) && ctx.backends.cis); // btp
}

// Prune each tool to the actions this caller can actually run; drop empty tools.
export function visibleTools(scopes: string[], ctx: VisibilityCtx): ToolDef[] {
  const tools: ToolDef[] = [];
  for (const name of toolNames()) {
    const allowed = actionsOf(name).filter((a) => actionVisible(a, scopes, ctx));
    if (allowed.length) tools.push(buildTool(name, allowed));
  }
  return tools;
}
