// Live per-user chain proof (outbound). Gated: opt in with LIVE_CHAIN=1 + a fresh USER_ID_TOKEN
// (browser login required — headless IAS login is impossible, issue #301). Skips in plain `npm test`.
// Reuses the four src/auth modules verbatim — linear glue only (ponytail). Plan: docs/operations/live-chain-runbook.md.

import { beforeAll, describe, expect, it } from 'vitest';
import { btpLoginAndRun } from '../src/auth/btp-cli.js';
import { cfTokenFromAssertion } from '../src/auth/cf-token.js';
import { exchangeForProvider } from '../src/auth/ias-exchange.js';
import { keyFromSecret, sealCredential, unsealCredential } from '../src/auth/sealed-credential.js';

const live = process.env.LIVE_CHAIN === '1';
const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`live-chain: missing env ${name}`);
  return v;
};

describe.skipIf(!live)('live per-user chain (outbound)', () => {
  let assertion: string;

  beforeAll(async () => {
    // Custody roundtrip with the REAL token, then exchange once (shared by both legs).
    const key = keyFromSecret(required('SEALING_SECRET'));
    const sealed = await sealCredential(
      { iasCredential: required('USER_ID_TOKEN'), sub: 'live-chain', scopes: ['read'] },
      key,
      { audience: 'live-chain' },
    );
    const { iasCredential } = await unsealCredential(sealed, key, 'live-chain');
    assertion = await exchangeForProvider(iasCredential, {
      iasTokenUrl: required('IAS_TOKEN_URL'),
      clientId: required('IAS_CLIENT_ID'),
      clientSecret: required('IAS_CLIENT_SECRET'),
      providerClientId: required('CF_PLATFORM_CLIENT_ID'),
    });
  }, 120_000);

  it('CF leg: cf-token → Cloud Controller /v3/apps (200 = token accepted; +authz if EXPECTED_APP)', async () => {
    const cfToken = await cfTokenFromAssertion(assertion, { cfUaaTokenUrl: required('CF_UAA_URL') });
    const res = await fetch(`${required('CF_API')}/v3/apps?per_page=50`, {
      headers: { authorization: `Bearer ${cfToken}` },
    });
    expect(res.status).toBe(200); // 200 = the per-user CF token is accepted (chain plumbing works)
    const body = (await res.json()) as { resources?: Array<{ name?: string }> };
    expect(Array.isArray(body.resources)).toBe(true);
    console.error(`[live-chain] CC /v3/apps → ${body.resources?.length} apps as the user`);
    // Optional per-user AUTHZ proof: a 200 with [] only proves acceptance, not scoped roles.
    const expectedApp = process.env.EXPECTED_APP;
    if (expectedApp) {
      expect(body.resources?.some((a) => a.name === expectedApp)).toBe(true);
    }
  }, 120_000);

  it('BTP leg: btp login + list accounts/subaccount as the user', async () => {
    const out = await btpLoginAndRun(['list', 'accounts/subaccount'], {
      jwt: assertion,
      subdomain: required('BTP_SUBDOMAIN'),
      idp: required('BTP_IDP'),
    });
    expect(out.toLowerCase()).toContain('subaccount');
    console.error('[live-chain] btp list accounts/subaccount OK as the user');
  }, 120_000);
});
