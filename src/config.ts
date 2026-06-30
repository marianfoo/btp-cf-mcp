// Config loader. Priority: bound VCAP_SERVICES creds > explicit env > defaults.
// On CF, binding the `cis` and `xsuaa` instances injects creds via VCAP_SERVICES ("just works").

import type { SafetyConfig } from './safety.js';

export interface CisCreds {
  tokenUrl: string; // {uaa.url}/oauth/token
  clientId: string;
  clientSecret: string;
  endpoints: Record<string, string>;
  subaccountId?: string;
}

export interface ApiKeyEntry {
  key: string;
  scopes: string[];
}

export interface IasConfig {
  /** IAS issuer, e.g. https://<tenant>.accounts.ondemand.com (OIDC discovery + the proxy upstream). */
  issuer: string;
  /** This server's IAS OIDC app (confidential). */
  clientId: string;
  clientSecret: string;
  /** The CF-platform IAS app client id — the provider for the app-to-app exchange. */
  providerClientId: string;
  /** CF UAA token endpoint (jwt-bearer → CF token). */
  cfUaaTokenUrl: string;
}

/** A shared read-only technical user for BTPAccount (Strategy B) — CLI-server username/password login. */
export interface BtpTechUser {
  userName: string;
  password: string;
  /** custom IAS origin host for an IAS user, or '' for the global account's default IdP. */
  idp: string;
}

export interface AppConfig {
  port: number;
  publicUrl?: string;
  apiKeys: ApiKeyEntry[];
  allowOpen: boolean; // ALLOW_OPEN=true permits unauthenticated read-only access (dev only); default fail-closed
  safety: SafetyConfig;
  cis?: CisCreds;
  cfApi?: string;
  ias?: IasConfig; // IAS-first per-user inbound (ADR-001-B); absent → api-key/shared path only
  sealingSecret?: string; // SEALING_SECRET — keys the MCP-token JWE (ADR-009)
  sealingSecretPrevious?: string; // SEALING_SECRET_PREVIOUS — old key kept valid during rotation
  btpGaSubdomain?: string; // BTP_GA_SUBDOMAIN — enables BTPAccount via the btp CLI server (per-user AND tech-user)
  btpTechUser?: BtpTechUser; // BTP_TECH_USER/_PASSWORD/_IDP — shared read-only BTPAccount identity (Strategy B)
  btpDefaultSubaccount?: string; // BTP_DEFAULT_SUBACCOUNT — default subaccount when no CIS key binds one
}

const PROFILE_SCOPES: Record<string, string[]> = {
  viewer: ['read'],
  developer: ['read', 'write'],
  admin: ['admin'],
};

function csv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseApiKeys(spec: string | undefined): ApiKeyEntry[] {
  // "key1:viewer key2:admin" — space-separated key:profile pairs.
  return (spec ?? '')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const [key, profile = 'viewer'] = pair.split(':');
      return { key, scopes: PROFILE_SCOPES[profile] ?? ['read'] };
    });
}

function vcap(): Record<string, Array<{ credentials?: Record<string, unknown> }>> {
  try {
    return JSON.parse(process.env.VCAP_SERVICES ?? '{}');
  } catch {
    return {};
  }
}

interface CisKey {
  uaa?: { url: string; clientid: string; clientsecret: string; subaccountid?: string };
  endpoints?: Record<string, string>;
}

function loadCis(): CisCreds | undefined {
  // Prefer a bound `cis` instance; fall back to a pasted service key in CIS_SERVICE_KEY.
  const bound = vcap().cis?.[0]?.credentials as CisKey | undefined;
  let cred: CisKey | undefined = bound;
  if (!cred && process.env.CIS_SERVICE_KEY) {
    const raw = JSON.parse(process.env.CIS_SERVICE_KEY) as { credentials?: CisKey } & CisKey;
    cred = raw.credentials ?? raw; // accept wrapped or unwrapped key
  }
  if (!cred?.uaa || !cred?.endpoints) return undefined;
  return {
    tokenUrl: `${cred.uaa.url}/oauth/token`,
    clientId: cred.uaa.clientid,
    clientSecret: cred.uaa.clientsecret,
    endpoints: cred.endpoints,
    subaccountId: cred.uaa.subaccountid,
  };
}

function loadIas(): IasConfig | undefined {
  const { IAS_ISSUER, IAS_CLIENT_ID, IAS_CLIENT_SECRET, CF_PLATFORM_CLIENT_ID, CF_UAA_URL } = process.env;
  const vars = { IAS_ISSUER, IAS_CLIENT_ID, IAS_CLIENT_SECRET, CF_PLATFORM_CLIENT_ID, CF_UAA_URL };
  const missing = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  // Some-but-not-all set: warn instead of silently reverting to the legacy path (a hard-to-diagnose footgun).
  if (missing.length > 0 && missing.length < Object.keys(vars).length) {
    console.error(`[btp-cf-mcp] IAS partial config — ignoring IAS-first inbound; missing: ${missing.join(', ')}`);
  }
  if (!IAS_ISSUER || !IAS_CLIENT_ID || !IAS_CLIENT_SECRET || !CF_PLATFORM_CLIENT_ID || !CF_UAA_URL) return undefined;
  return {
    issuer: IAS_ISSUER.replace(/\/$/, ''),
    clientId: IAS_CLIENT_ID,
    clientSecret: IAS_CLIENT_SECRET,
    providerClientId: CF_PLATFORM_CLIENT_ID,
    cfUaaTokenUrl: CF_UAA_URL,
  };
}

// Shared read-only technical user for BTPAccount (Strategy B). idp defaults to the IAS issuer host
// (the tech user is typically on the same IAS), or '' (default IdP) when no IAS is configured.
function loadBtpTechUser(iasIssuer?: string): BtpTechUser | undefined {
  const userName = process.env.BTP_TECH_USER;
  const password = process.env.BTP_TECH_PASSWORD;
  if (!userName || !password) return undefined;
  const idp = process.env.BTP_TECH_IDP ?? (iasIssuer ? iasIssuer.replace(/^https?:\/\//, '') : '');
  return { userName, password, idp };
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    publicUrl: process.env.PUBLIC_URL,
    apiKeys: parseApiKeys(process.env.API_KEYS),
    allowOpen: process.env.ALLOW_OPEN === 'true',
    cis: loadCis(),
    cfApi: process.env.CF_API,
    ias: loadIas(),
    sealingSecret: process.env.SEALING_SECRET,
    sealingSecretPrevious: process.env.SEALING_SECRET_PREVIOUS,
    btpGaSubdomain: process.env.BTP_GA_SUBDOMAIN,
    btpTechUser: loadBtpTechUser(process.env.IAS_ISSUER),
    btpDefaultSubaccount: process.env.BTP_DEFAULT_SUBACCOUNT,
    safety: {
      allowWrites: process.env.ALLOW_WRITES === 'true',
      allowedSubaccounts: csv(process.env.ALLOWED_SUBACCOUNTS),
      allowedOrgs: csv(process.env.ALLOWED_ORGS),
      allowedSpaces: csv(process.env.ALLOWED_SPACES),
      denyActions: csv(process.env.DENY_ACTIONS),
    },
  };
}
