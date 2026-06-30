// ADR-009 — credential custody for a STATELESS, multi-instance server.
// The IAS credential + scopes are sealed (encrypted, audience-bound) into the opaque blob that IS
// the server's own MCP access token. Any instance holding the symmetric key can unseal it, so there
// is NO server-side session store. The MCP client only ever holds ciphertext it cannot read or replay
// against IAS — this is NOT token passthrough; `aud` stops replay at a sibling service that shares the key.
//
// Key rotation: unseal accepts a key list (current + previous). Seal always uses the current key; set
// SEALING_SECRET=new + SEALING_SECRET_PREVIOUS=old to rotate WITHOUT revoking live tokens — old tokens
// still unseal via the previous key until they expire (~30m), then drop SEALING_SECRET_PREVIOUS.

import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';

export interface SealedClaims {
  /** The upstream IAS credential (id_token now; refresh token later) we exchange on the user's behalf. */
  iasCredential: string;
  /** The IAS subject — for audit + cache keying. */
  sub: string;
  /** The MCP scopes granted to this session (read/write/admin). */
  scopes: string[];
  /** Expiry (epoch seconds) — surfaced so the bearer verifier can set AuthInfo.expiresAt. */
  exp: number;
}

/**
 * Derive a 32-byte A256GCM key from a config secret string (SHA-256).
 * PRODUCTION: `SEALING_SECRET` MUST be a high-entropy 32-byte random value — clients hold the
 * ciphertext, so a weak/password-like secret is offline-brute-forceable (there is no KDF stretching).
 */
export function keyFromSecret(secret: string): Uint8Array {
  if (!secret) throw new Error('sealing secret is empty');
  return new Uint8Array(createHash('sha256').update(secret, 'utf8').digest());
}

/**
 * Seal the IAS credential + scopes into an encrypted, audience-bound JWT (the server's MCP token).
 * `audience` = this server's canonical resource id, so the blob can't be replayed at a sibling service
 * that shares the secret. `ttl` is a jose timespan (default '30m').
 */
export async function sealCredential(
  claims: { iasCredential: string; sub: string; scopes: string[] },
  key: Uint8Array,
  opts: { audience: string; ttl?: string },
): Promise<string> {
  return new EncryptJWT({ iasCredential: claims.iasCredential, sub: claims.sub, scopes: claims.scopes })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime(opts.ttl ?? '30m')
    .encrypt(key);
}

/**
 * Unseal + validate (signature, audience, exp). `keys` may be a single key or a list (current +
 * previous, for rotation) — each is tried until one decrypts+audience-validates. Throws on
 * tampered / wrong-key / wrong-aud / expired.
 */
export async function unsealCredential(
  sealed: string,
  keys: Uint8Array | Uint8Array[],
  expectedAudience: string,
): Promise<SealedClaims> {
  const list = Array.isArray(keys) ? keys : [keys];
  let lastErr: unknown = new Error('no sealing key configured');
  for (const key of list) {
    let payload: Awaited<ReturnType<typeof jwtDecrypt>>['payload'];
    try {
      ({ payload } = await jwtDecrypt(sealed, key, { audience: expectedAudience }));
    } catch (e) {
      lastErr = e; // wrong key / wrong aud / expired — try the next key
      continue;
    }
    // Decrypted + audience OK with this key → validate the payload (do NOT fall through to other keys).
    const scopes = payload.scopes;
    if (
      typeof payload.iasCredential !== 'string' ||
      typeof payload.sub !== 'string' ||
      typeof payload.exp !== 'number' ||
      !Array.isArray(scopes) ||
      !scopes.every((s) => typeof s === 'string')
    ) {
      throw new Error('sealed credential malformed');
    }
    return { iasCredential: payload.iasCredential, sub: payload.sub, scopes: scopes as string[], exp: payload.exp };
  }
  throw lastErr;
}
