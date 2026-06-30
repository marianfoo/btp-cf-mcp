#!/usr/bin/env node
// One-shot helper: get a fresh USER IAS id_token via OAuth auth-code + PKCE.
// You complete the login in your browser (instant SSO since you're already logged into IAS);
// the script captures the redirect, exchanges the code, and prints the id_token to STDOUT.
//
// Usage:
//   IAS_BASE_URL=https://<tenant>.accounts.ondemand.com \
//   IAS_CLIENT_ID=<your OIDC app client id> \
//   IAS_CLIENT_SECRET=<your OIDC app client secret> \
//   node scripts/get-id-token.mjs
//
// Optional: PORT (default 8123) / REDIRECT_URI — must match a redirect URI registered on the IAS app.
// Pipe the token straight into the live chain:  USER_ID_TOKEN=$(node scripts/get-id-token.mjs)
//
// stdlib only (no deps); the token goes to stdout, all prompts/logs to stderr.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const base = process.env.IAS_BASE_URL?.replace(/\/$/, '');
const clientId = process.env.IAS_CLIENT_ID;
const clientSecret = process.env.IAS_CLIENT_SECRET;
const port = Number(process.env.PORT ?? 8123);
const redirectUri = process.env.REDIRECT_URI ?? `http://localhost:${port}/callback`;

if (!base || !clientId || !clientSecret) {
  console.error('Set IAS_BASE_URL, IAS_CLIENT_ID, IAS_CLIENT_SECRET (see the header).');
  process.exit(1);
}

const b64url = (buf) => buf.toString('base64url');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const authUrl =
  `${base}/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid email profile groups')}` +
  `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

console.error(`\nOpen this URL in your browser (already logged into IAS → instant SSO):\n\n${authUrl}\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (url.searchParams.get('state') !== state || !code) {
    res.writeHead(400).end('bad state or missing code');
    console.error('Callback had a bad state or no code.');
    server.close();
    return;
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    const tokRes = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body,
    });
    const json = await tokRes.json();
    if (!tokRes.ok || !json.id_token) {
      throw new Error(`token endpoint ${tokRes.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Got it — return to your terminal.');
    console.error('\n=== id_token (use as USER_ID_TOKEN; expires_in=' + json.expires_in + 's) ===\n');
    console.log(json.id_token); // stdout = the token only
  } catch (e) {
    res.writeHead(500).end('token exchange failed');
    console.error('\nToken exchange failed:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, () => console.error(`Waiting for the redirect on ${redirectUri} …`));
