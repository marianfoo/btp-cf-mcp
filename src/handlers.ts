// Tool dispatch: scope check -> deny check -> read-only gate -> required+allowlisted target -> the
// registry action's backend call. Enforces arc-1's "scope ∧ safety" invariant per request. All
// user-supplied path/query args are GUID-validated before URL construction (no injection into the origin).

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type BtpcliSession,
  btpcliCommand,
  btpcliLogin,
  btpcliLoginPassword,
  cachedSession,
  DEFAULT_CLI_SERVER,
  invalidateSession,
  sessionCacheKey,
} from './auth/btpcli-http.js';
import { exchangeForProvider } from './auth/ias-exchange.js';
import { BackendError, IasUserTokenProvider } from './auth/token-provider.js';
import type { CisClient } from './btp.js';
import { CfClient } from './btp.js';
import type { AppConfig, BtpTechUser, IasConfig } from './config.js';
import { hasScope } from './policy.js';
import { type ActionCtx, type ActionDef, entitlement403Hint, getAction } from './registry.js';
import { checkOperation, deriveUserSafety, isDenied, requireTarget, type SafetyConfig, SafetyError } from './safety.js';

export interface Clients {
  cis?: CisClient;
  cf?: CfClient;
  subaccountId?: string;
}

export type ToolResult = CallToolResult;

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const json = (v: unknown): string => JSON.stringify(v, null, 2);

const GUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
function asGuid(value: unknown, field: string): string {
  const s = String(value ?? '');
  if (!GUID_RE.test(s)) throw new SafetyError(`'${field}' must be a GUID.`);
  return s;
}

export async function dispatch(
  name: string,
  args: Record<string, unknown>,
  scopes: string[],
  config: AppConfig,
  clients: Clients,
  ias?: { sub: string; iasCredential: string },
): Promise<ToolResult> {
  const action = String(args.action ?? '');
  const def = getAction(name, action);
  if (!def) return fail(`Unknown action '${name}.${action}'.`);
  if (!hasScope(scopes, def.scope)) return fail(`'${name}.${action}' requires the '${def.scope}' scope.`);

  const safety = deriveUserSafety(config.safety, scopes);
  if (isDenied(safety.denyActions, name, action)) return fail(`'${name}.${action}' is denied by server policy.`);

  const defaultSub = clients.subaccountId ?? config.btpDefaultSubaccount;
  try {
    checkOperation(safety, def.op, `${name}.${action}`); // read-only by default
    if (def.op === 'R') {
      return def.backend === 'cf'
        ? await runCfRead(def, args, config, clients, ias, defaultSub)
        : await runBtpRead(def, args, config, clients, ias, defaultSub);
    }
    // Writes. The allowlist gate runs on the REAL target, by construction:
    // - btp: the gated subaccount is the SAME value ctx.sub() scopes the API call to.
    // - cf: runCfWrite resolves the app's real space server-side and gates that (never an LLM-supplied value).
    if (!def.run) return fail(`'${name}.${action}' is not implemented.`);
    // Writes are PER-USER ONLY (codex P1): without this, an api-key caller would mutate via the shared
    // identities (tech user / shared CF token) — unattributable writes contradicting the per-user model.
    if (!ias?.iasCredential) {
      return fail(
        `'${name}.${action}' is a write and writes run per-user only — connect via OAuth (IAS login). API-key/shared-identity callers are read-only by design.`,
      );
    }
    if (def.backend === 'btp') {
      requireTarget(safety, 'subaccount', (args.subaccount as string | undefined) ?? defaultSub);
      return await runBtpWrite(def, args, config, ias, defaultSub);
    }
    return await runCfWrite(def, args, config, clients, ias, defaultSub, safety);
  } catch (e) {
    if (e instanceof SafetyError) return fail(e.message);
    return fail(`Error calling '${name}.${action}': ${(e as Error).message}`);
  }
}

// Build the read action's context — backend accessors bound to the resolved identity + arg validators.
function makeCtx(
  args: Record<string, unknown>,
  ga: string | undefined,
  defaultSub: string | undefined,
  over: Partial<Pick<ActionCtx, 'cf' | 'cfPost' | 'logs' | 'btp'>>,
): ActionCtx {
  const noBackend = (which: string) => async (): Promise<never> => {
    throw new Error(`${which} backend not available`);
  };
  return {
    args,
    ga: ga ?? '',
    sub: () => asGuid((args.subaccount as string | undefined) ?? defaultSub, 'subaccount'),
    guid: (field) => asGuid(args[field], field),
    cf: over.cf ?? (noBackend('CF') as ActionCtx['cf']),
    cfPost: over.cfPost ?? (noBackend('CF-write') as ActionCtx['cfPost']),
    logs: over.logs ?? (noBackend('CF-logs') as ActionCtx['logs']),
    btp: over.btp ?? (noBackend('BTP') as ActionCtx['btp']),
  };
}

function perUserCfProvider(idToken: string, ias: IasConfig): IasUserTokenProvider {
  return new IasUserTokenProvider(idToken, {
    exchange: {
      iasTokenUrl: `${ias.issuer}/oauth2/token`,
      clientId: ias.clientId,
      clientSecret: ias.clientSecret,
      providerClientId: ias.providerClientId,
    },
    cfUaa: { cfUaaTokenUrl: ias.cfUaaTokenUrl },
  });
}

// Cloud Foundry read — as the user (request-scoped CfClient from the IAS credential) when present,
// else the shared CF token. Only per-user when THIS request carries an IAS credential.
async function runCfRead(
  def: ActionDef,
  args: Record<string, unknown>,
  config: AppConfig,
  clients: Clients,
  ias: { iasCredential: string } | undefined,
  defaultSub: string | undefined,
): Promise<ToolResult> {
  const cf =
    ias?.iasCredential && config.ias && config.cfApi
      ? new CfClient(config.cfApi, perUserCfProvider(ias.iasCredential, config.ias))
      : clients.cf;
  if (!cf) return fail('CF backend not configured — log in via OAuth, or set CF_API + a CF token.');
  const ctx = makeCtx(args, config.btpGaSubdomain, defaultSub, {
    cf: (p) => cf.get(p),
    // log-cache 404 = the app has no recent logs (not an error) → hand back empty envelopes.
    logs: async (id, limit) => {
      try {
        return await cf.getLogs(id, limit);
      } catch (e) {
        if (e instanceof BackendError && e.status === 404) return { envelopes: { batch: [] } };
        throw e;
      }
    },
  });
  return ok(json(await def.run?.(ctx)));
}

// CF write: SERVER-SIDE target resolution, by construction. Every CF write is app-guid-addressed; we
// resolve the app's REAL space from the Cloud Controller and gate THAT against the allowlist — the LLM
// never supplies the gated value (a caller could otherwise name an allowlisted space but target an app
// elsewhere). Only then does the action's run() get the cfPost accessor.
async function runCfWrite(
  def: ActionDef,
  args: Record<string, unknown>,
  config: AppConfig,
  clients: Clients,
  ias: { iasCredential: string } | undefined,
  defaultSub: string | undefined,
  safety: SafetyConfig,
): Promise<ToolResult> {
  const cf =
    ias?.iasCredential && config.ias && config.cfApi
      ? new CfClient(config.cfApi, perUserCfProvider(ias.iasCredential, config.ias))
      : clients.cf;
  if (!cf) return fail('CF backend not configured — log in via OAuth, or set CF_API + a CF token.');
  const appGuid = asGuid(args.guid, 'guid');
  const app = (await cf.get(`/v3/apps/${appGuid}`)) as {
    relationships?: { space?: { data?: { guid?: string } } };
  };
  const spaceGuid = app.relationships?.space?.data?.guid;
  if (!spaceGuid) return fail("Could not resolve the app's space — refusing the write (fail closed).");
  requireTarget(safety, 'space', spaceGuid);
  const ctx = makeCtx(args, config.btpGaSubdomain, defaultSub, { cf: (p) => cf.get(p), cfPost: (p) => cf.post(p) });
  return ok(json(await def.run?.(ctx)));
}

function btp403Hint(def: ActionDef, args: Record<string, unknown>): string {
  if (def.action === 'entitlements') return entitlement403Hint(args.subaccount as string | undefined);
  return `HTTP 403 on '${def.action}'. The acting identity lacks the read-only role — assign "Global Account Viewer" (global reads) or "Subaccount Viewer" (subaccount-scoped reads) and retry after ~1–2 min.`;
}

// Run a registry action via the btp CLI server, per-user (this request's IAS credential) or shared
// technical user. Sessions are cached per identity; a stale-session 401 drops the cache and re-logs-in
// once. Returns null when no CLI-server path is configured (caller decides the fallback).
async function runBtpViaCli(
  def: ActionDef,
  args: Record<string, unknown>,
  config: AppConfig,
  ias: { iasCredential: string } | undefined,
  defaultSub: string | undefined,
  hint403: (def: ActionDef, args: Record<string, unknown>) => string,
): Promise<ToolResult | null> {
  const ga = config.btpGaSubdomain;
  if (!ga || !((ias?.iasCredential && config.ias) || config.btpTechUser)) return null;
  const perUser = Boolean(ias?.iasCredential && config.ias);
  const key = perUser
    ? sessionCacheKey('user', ias!.iasCredential, ga)
    : sessionCacheKey('tech', config.btpTechUser!.userName, config.btpTechUser!.password, ga, config.btpTechUser!.idp);
  const login = perUser ? perUserLogin(ias!.iasCredential, config.ias!, ga) : techLogin(config.btpTechUser!, ga);
  const attempt = async (): Promise<unknown> => {
    const session = await cachedSession(key, login);
    const ctx = makeCtx(args, ga, defaultSub, { btp: (c, a, p) => btpcliCommand(session, c, a, p) });
    return def.run?.(ctx);
  };
  try {
    return ok(json(await attempt()));
  } catch (e) {
    if (e instanceof BackendError && e.status === 401) {
      invalidateSession(key); // stale session → re-login once
      return ok(json(await attempt()));
    }
    if (e instanceof BackendError && e.status === 403) return fail(hint403(def, args));
    throw e;
  }
}

// BTP reads: CLI-server path first, then the shared-CIS fallback (only the cisFallback actions).
async function runBtpRead(
  def: ActionDef,
  args: Record<string, unknown>,
  config: AppConfig,
  clients: Clients,
  ias: { iasCredential: string } | undefined,
  defaultSub: string | undefined,
): Promise<ToolResult> {
  const viaCli = await runBtpViaCli(def, args, config, ias, defaultSub, btp403Hint);
  if (viaCli) return viaCli;
  if (clients.cis && def.cisFallback) return runBtpCisFallback(def, args, clients, defaultSub);
  return fail(
    'BTPAccount backend not configured — set BTP_GA_SUBDOMAIN + (per-user IAS login or BTP_TECH_USER), or bind a CIS key.',
  );
}

function btpWrite403Hint(def: ActionDef, _args: Record<string, unknown>): string {
  return `HTTP 403 on '${def.action}'. Your user cannot manage service instances — you need the "Subaccount Administrator" or "Subaccount Service Administrator" role collection on the target subaccount (assign under the app-login IdP origin, then re-login).`;
}

// BTP writes: CLI-server path ONLY (the shared CIS key is read-only by design — never a write fallback).
// The subaccount-allowlist gate ran in dispatch on the SAME value ctx.sub() resolves to.
async function runBtpWrite(
  def: ActionDef,
  args: Record<string, unknown>,
  config: AppConfig,
  ias: { iasCredential: string } | undefined,
  defaultSub: string | undefined,
): Promise<ToolResult> {
  const viaCli = await runBtpViaCli(def, args, config, ias, defaultSub, btpWrite403Hint);
  if (viaCli) return viaCli;
  return fail(
    'BTP writes need the CLI-server path — set BTP_GA_SUBDOMAIN + (per-user IAS login or BTP_TECH_USER). The shared CIS key cannot write.',
  );
}

function perUserLogin(idToken: string, ias: IasConfig, ga: string): () => Promise<BtpcliSession> {
  return async () => {
    const assertion = await exchangeForProvider(idToken, {
      iasTokenUrl: `${ias.issuer}/oauth2/token`,
      clientId: ias.clientId,
      clientSecret: ias.clientSecret,
      providerClientId: ias.providerClientId,
    });
    return btpcliLogin(assertion, {
      server: DEFAULT_CLI_SERVER,
      subdomain: ga,
      idp: ias.issuer.replace(/^https?:\/\//, ''),
    });
  };
}

function techLogin(tech: BtpTechUser, ga: string): () => Promise<BtpcliSession> {
  return () =>
    btpcliLoginPassword(tech.userName, tech.password, { server: DEFAULT_CLI_SERVER, subdomain: ga, idp: tech.idp });
}

// The Accounts + Entitlements services are global-account (central) CIS APIs; a cis-local plan token
// (subaccount-scoped) is rejected with a bare 401 — turn that into an actionable message.
async function centralRead(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(json(await fn()));
  } catch (e) {
    if (e instanceof BackendError && e.status === 401)
      return fail(
        'HTTP 401 from the CIS accounts/entitlements service — these are global-account (central) APIs. The bound CIS instance is plan "local" (subaccount-scoped), whose token they reject; only BTPAccount.environments works on a local-plan key. Bind a central-plan cis instance to enable subaccount/entitlements reads.',
      );
    throw e;
  }
}

// Legacy shared-CIS fallback (only for the cisFallback actions) when no per-user/tech btpcli path exists.
async function runBtpCisFallback(
  def: ActionDef,
  args: Record<string, unknown>,
  clients: Clients,
  defaultSub: string | undefined,
): Promise<ToolResult> {
  const cis = clients.cis;
  if (!cis) return fail('BTP backend not configured (no CIS service key bound).');
  // Same default-subaccount resolution as the per-user/tech path (honors BTP_DEFAULT_SUBACCOUNT), not just the CIS key's.
  const sub = (): string => asGuid((args.subaccount as string | undefined) ?? defaultSub, 'subaccount');
  switch (def.action) {
    case 'environments':
      return ok(json(await cis.get('provisioning_service_url', '/provisioning/v1/environments')));
    case 'entitlements':
      return centralRead(() =>
        cis.get(
          'entitlements_service_url',
          `/entitlements/v1/subaccountServicePlans?subaccountGUID=${encodeURIComponent(sub())}`,
        ),
      );
    case 'subaccount':
      return centralRead(() => cis.get('accounts_service_url', `/accounts/v1/subaccounts/${sub()}`));
    default:
      return fail(`'${def.action}' needs a per-user login or a technical user (not reachable on the shared CIS key).`);
  }
}
