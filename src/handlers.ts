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
import { checkOperation, deriveUserSafety, isDenied, requireTarget, SafetyError } from './safety.js';

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
    if (def.op !== 'R' && def.target) {
      // Resolve the target (subaccount defaults to the bound one) then require it present + allowlisted.
      const value =
        def.target === 'subaccount'
          ? ((args.subaccount as string | undefined) ?? defaultSub)
          : (args[def.target] as string | undefined);
      requireTarget(safety, def.target, value);
    }
    if (def.op !== 'R') {
      return fail(`'${name}.${action}' is a write that passed the safety gate but is NOT YET IMPLEMENTED.`);
    }
    return def.backend === 'cf'
      ? await runCfRead(def, args, config, clients, ias, defaultSub)
      : await runBtpRead(def, args, config, clients, ias, defaultSub);
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
  over: Partial<Pick<ActionCtx, 'cf' | 'logs' | 'btp'>>,
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

function btp403Hint(def: ActionDef, args: Record<string, unknown>): string {
  if (def.action === 'entitlements') return entitlement403Hint(args.subaccount as string | undefined);
  return `HTTP 403 on '${def.action}'. The acting identity lacks the read-only role — assign "Global Account Viewer" (global reads) or "Subaccount Viewer" (subaccount-scoped reads) and retry after ~1–2 min.`;
}

// BTP account read via the btp CLI server, in precedence: per-user (this request's IAS credential) →
// shared read-only technical user → shared-CIS fallback (only the cisFallback actions). Sessions are
// cached per identity; a stale-session 401 drops the cache and re-logs-in once.
async function runBtpRead(
  def: ActionDef,
  args: Record<string, unknown>,
  config: AppConfig,
  clients: Clients,
  ias: { iasCredential: string } | undefined,
  defaultSub: string | undefined,
): Promise<ToolResult> {
  const ga = config.btpGaSubdomain;
  if (ga && ((ias?.iasCredential && config.ias) || config.btpTechUser)) {
    const perUser = Boolean(ias?.iasCredential && config.ias);
    const key = perUser
      ? sessionCacheKey('user', ias!.iasCredential, ga)
      : sessionCacheKey(
          'tech',
          config.btpTechUser!.userName,
          config.btpTechUser!.password,
          ga,
          config.btpTechUser!.idp,
        );
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
      if (e instanceof BackendError && e.status === 403) return fail(btp403Hint(def, args));
      throw e;
    }
  }
  if (clients.cis && def.cisFallback) return runBtpCisFallback(def, args, clients, defaultSub);
  return fail(
    'BTPAccount backend not configured — set BTP_GA_SUBDOMAIN + (per-user IAS login or BTP_TECH_USER), or bind a CIS key.',
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
