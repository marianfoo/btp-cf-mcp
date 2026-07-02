import { describe, expect, it } from 'vitest';
import { expandScopes, hasScope } from '../src/policy.js';
import {
  checkOperation,
  deriveUserSafety,
  isDenied,
  requireTarget,
  type SafetyConfig,
  SafetyError,
  unmatchedDenyPatterns,
} from '../src/safety.js';
import { type VisibilityCtx, visibleTools } from '../src/tools.js';

const base: SafetyConfig = {
  allowWrites: false,
  allowedSubaccounts: ['sa-1'],
  allowedOrgs: [],
  allowedSpaces: ['sp-1'],
  denyActions: [],
};
const fullCtx: VisibilityCtx = {
  allowWrites: true,
  perUser: true,
  denyActions: [],
  backends: { cf: true, cis: true, btpCli: true },
};

describe('scope expansion', () => {
  it('admin implies write + read', () => expect(expandScopes(['admin']).sort()).toEqual(['admin', 'read', 'write']));
  it('write implies read', () => expect(hasScope(['write'], 'read')).toBe(true));
  it('read does not imply write', () => expect(hasScope(['read'], 'write')).toBe(false));
});

describe('read-only by default', () => {
  it('blocks writes when allowWrites=false', () => expect(() => checkOperation(base, 'W', 'x')).toThrow(SafetyError));
  it('allows reads', () => expect(() => checkOperation(base, 'R', 'x')).not.toThrow());
  it('allows writes when enabled', () =>
    expect(() => checkOperation({ ...base, allowWrites: true }, 'W', 'x')).not.toThrow());
});

describe('per-user scopes only narrow the ceiling', () => {
  it('read-scoped user cannot write even if the server allows it', () =>
    expect(deriveUserSafety({ ...base, allowWrites: true }, ['read']).allowWrites).toBe(false));
  it('write-scoped user can when the server allows it', () =>
    expect(deriveUserSafety({ ...base, allowWrites: true }, ['write']).allowWrites).toBe(true));
});

describe('fail-closed required target (P0 fix)', () => {
  const s: SafetyConfig = { ...base, allowWrites: true };
  it('allows an allowlisted subaccount', () => expect(() => requireTarget(s, 'subaccount', 'sa-1')).not.toThrow());
  it('refuses a non-allowlisted subaccount', () =>
    expect(() => requireTarget(s, 'subaccount', 'sa-evil')).toThrow(SafetyError));
  it('refuses an OMITTED target (the bypass hole the review found)', () =>
    expect(() => requireTarget(s, 'subaccount', undefined)).toThrow(SafetyError));
  it('refuses a non-allowlisted space', () => expect(() => requireTarget(s, 'space', 'sp-evil')).toThrow(SafetyError));
  it('refuses an org when the org allowlist is empty', () =>
    expect(() => requireTarget(s, 'org', 'o-1')).toThrow(SafetyError));
});

describe('deny actions', () => {
  it('matches exact / wildcard / tool-wide', () => {
    expect(isDenied(['BTPAccount.delete_service'], 'BTPAccount', 'delete_service')).toBe(true);
    expect(isDenied(['CloudFoundry.*'], 'CloudFoundry', 'restart')).toBe(true);
    expect(isDenied(['CloudFoundry'], 'CloudFoundry', 'orgs')).toBe(true);
    expect(isDenied(['Other.x'], 'BTPAccount', 'environments')).toBe(false);
  });
  it('unmatchedDenyPatterns flags stale/typo patterns (silent no-op guard)', () => {
    expect(unmatchedDenyPatterns(['BTPServices.delete_service', 'CFInspect', 'CFApps.*'])).toEqual([]);
    // a stale tool name or a bogus action matches no registry action → flagged so startup fails loud
    expect(unmatchedDenyPatterns(['CloudFoundry', 'BTPAccount.delete_service', 'CFInspect.bogus'])).toEqual([
      'CloudFoundry',
      'BTPAccount.delete_service',
      'CFInspect.bogus',
    ]);
  });
});

describe('safety-aware tool pruning', () => {
  const actions = (tools: ReturnType<typeof visibleTools>, name: string): string[] => {
    const t = tools.find((x) => x.name === name);
    return ((t?.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? []) as string[];
  };
  it('read scope sees the read tool but no write tool', () => {
    const tools = visibleTools(['read'], fullCtx);
    expect(actions(tools, 'CFInspect')).toContain('orgs');
    expect(tools.find((t) => t.name === 'CFApps')).toBeUndefined(); // writes hidden under read scope
  });
  it('write scope sees the write tool when writes are enabled', () =>
    expect(actions(visibleTools(['write'], fullCtx), 'CFApps')).toContain('restart'));
  it('hides the write tool when ALLOW_WRITES is off, even for a write-scoped caller', () =>
    expect(
      visibleTools(['write'], { ...fullCtx, allowWrites: false }).find((t) => t.name === 'CFApps'),
    ).toBeUndefined());
  it('hides write tools from shared-identity callers (no IAS credential) — writes are per-user only', () => {
    const tools = visibleTools(['admin'], { ...fullCtx, perUser: false });
    expect(tools.find((t) => t.name === 'CFApps')).toBeUndefined();
    expect(tools.find((t) => t.name === 'BTPServices')).toBeUndefined();
    expect(tools.find((t) => t.name === 'CFInspect')).toBeDefined(); // reads unaffected
  });
  it('hides denied actions', () =>
    expect(
      actions(visibleTools(['admin'], { ...fullCtx, denyActions: ['BTPServices.delete_service'] }), 'BTPServices'),
    ).not.toContain('delete_service'));
  it('read tools carry readOnlyHint:true; write tools do not', () => {
    const tools = visibleTools(['admin'], fullCtx);
    expect(tools.find((t) => t.name === 'CFInspect')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'BTPInspect')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'CFApps')?.annotations.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'BTPServices')?.annotations.destructiveHint).toBe(true); // delete_service
  });
  it('drops a tool when its backend is unavailable', () => {
    const tools = visibleTools(['read'], { ...fullCtx, backends: { cf: false, cis: true, btpCli: false } });
    expect(tools.find((t) => t.name === 'CFInspect')).toBeUndefined();
    expect(tools.find((t) => t.name === 'BTPInspect')).toBeDefined(); // cisFallback reads still show
  });
  it('CIS-only (no btpCli) shows only the cisFallback BTP reads, not the new ones', () => {
    const a = actions(
      visibleTools(['read'], { ...fullCtx, backends: { cf: false, cis: true, btpCli: false } }),
      'BTPInspect',
    );
    expect(a).toEqual(expect.arrayContaining(['environments', 'subaccount', 'entitlements']));
    expect(a).not.toContain('subaccounts'); // btpCli-only
    expect(a).not.toContain('global_account');
  });
  it('btpCli path exposes the full BTP read surface', () => {
    const a = actions(
      visibleTools(['read'], { ...fullCtx, backends: { cf: false, cis: false, btpCli: true } }),
      'BTPInspect',
    );
    expect(a).toEqual(expect.arrayContaining(['subaccounts', 'global_account', 'subscriptions']));
  });
});
