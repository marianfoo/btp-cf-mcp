// Outbound CF leg (ADR-002 continued): exchange the re-audienced IAS assertion for a CF Cloud
// Controller token at CF's UAA (jwt-bearer). This is what `cf auth --assertion` does under the
// hood; we do it as REST to avoid a cf-CLI dependency in production.
// ponytail: the public `cf` client (no secret, response_type=token) — the same identity the CLI uses.
// The exact grant params are live-verified in the spike run (docs/operations/per-user-spike-notes.md).

export interface CfUaaConfig {
  /** CF UAA token endpoint, e.g. https://uaa.cf.<region>.hana.ondemand.com/oauth/token */
  cfUaaTokenUrl: string;
  /** UAA client used by the CF CLI; defaults to the public `cf` client. */
  clientId?: string;
}

/** Exchange a re-audienced IAS assertion for a CF access token (the user's CF session). */
export async function cfTokenFromAssertion(assertion: string, cfg: CfUaaConfig): Promise<string> {
  if (!assertion) throw new Error('cf-token: empty assertion');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
    client_id: cfg.clientId ?? 'cf',
    response_type: 'token',
  });
  const res = await fetch(cfg.cfUaaTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    // Redact the submitted assertion in case the endpoint echoes it back (never log a token).
    const text = (await res.text().catch(() => '')).split(assertion).join('<assertion>');
    throw new Error(`CF UAA exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('CF UAA exchange: no access_token in response');
  return json.access_token;
}
