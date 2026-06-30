// Outbound BTP leg (ADR-004): per-user BTP account ops via the CLI Server, by shelling a bundled
// `btp` binary logged in with the user's exchanged token. Hardened per the spike review (Codex #6):
// execFile (no shell), an isolated HOME + BTP_CLIENTCONFIG per call (cleaned up), bounded timeout,
// and JWT redaction in errors.
//
// ⚠️ SPIKE-ONLY: `--jwt` goes in argv, so the token is visible in the host process list (`ps`).
// Isolated HOME does NOT hide that. Acceptable ONLY on a single-tenant host; PRODUCTION MUST use the
// CLI-Server REST path (ADR-004), not the binary. `childEnv` keeps the server's secrets out of the child.
// ponytail: per-request login (slow but safe). Switch `--jwt` to stdin/file if a live run proves support.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BtpLoginOptions {
  jwt: string;
  subdomain: string;
  idp: string;
  url?: string;
}

/** The proven `btp login` argv (live-verified recipe). Pure — unit-tested; the exec uses it. */
export function buildLoginArgs(opts: BtpLoginOptions): string[] {
  return [
    'login',
    '--url',
    opts.url ?? 'cli.btp.cloud.sap',
    '--subdomain',
    opts.subdomain,
    '--idp',
    opts.idp,
    '--jwt',
    opts.jwt,
  ];
}

/** Strip a secret from a string before it reaches a log/error. */
export function redactJwt(s: string, jwt: string): string {
  return jwt ? s.split(jwt).join('<jwt>') : s;
}

/**
 * Minimal child env — NEVER inherit the server's secrets (SEALING_SECRET, IAS_CLIENT_SECRET,
 * API_KEYS, CF_TOKEN, …). Only HOME/BTP_CLIENTCONFIG + the few vars `btp` legitimately needs.
 */
export function childEnv(home: string): NodeJS.ProcessEnv {
  const passthrough = [
    'PATH',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const env: NodeJS.ProcessEnv = { HOME: home, BTP_CLIENTCONFIG: join(home, 'config.json') };
  for (const k of passthrough) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/** Login as the user, run one `btp` command, return stdout. Isolated + cleaned up + timed out. */
export async function btpLoginAndRun(
  commandArgs: string[],
  opts: BtpLoginOptions & { timeoutMs?: number },
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'btpcli-')); // mkdtemp is 0700
  const env = childEnv(home);
  const timeout = opts.timeoutMs ?? 60_000;
  const cfg = ['--config', join(home, 'config.json')];
  try {
    // Store the session in the isolated --config file, NOT the OS keychain — required for headless/CI:
    // an isolated HOME has no Keychain, so the default secure store fails with errSecNoSuchKeychain.
    await run('btp', [...cfg, 'set', 'config', '--login.securestore', 'false'], { env, timeout });
    await run('btp', [...cfg, ...buildLoginArgs(opts)], { env, timeout });
    const { stdout } = await run('btp', [...cfg, ...commandArgs], { env, timeout });
    return stdout;
  } catch (e) {
    throw new Error(`btp '${commandArgs.join(' ')}' failed: ${redactJwt(String((e as Error).message), opts.jwt)}`);
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
