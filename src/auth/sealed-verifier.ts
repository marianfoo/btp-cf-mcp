// Bearer verifier for the server's OWN sealed-JWE MCP token (ADR-009). Unseals it (validating
// audience + exp) into an AuthInfo, carrying the IAS credential in `extra` so dispatch can act as
// the user. Throws on any non-sealed token, so the chain falls through to the api-key verifier.

import type { AuthInfo, Verifier } from '@arc-mcp/xsuaa-auth';
import { unsealCredential } from './sealed-credential.js';

export function createSealedJweVerifier(keys: Uint8Array | Uint8Array[], audience: string): Verifier {
  return async (token: string): Promise<AuthInfo> => {
    const { sub, scopes, iasCredential, exp } = await unsealCredential(token, keys, audience);
    return {
      token,
      clientId: sub,
      scopes,
      expiresAt: exp, // requireBearerAuth requires a numeric expiresAt
      extra: { sub, iasCredential }, // the seam into per-user dispatch
    };
  };
}
