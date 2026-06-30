// Safety ceiling — adapted from arc-1 src/adt/safety.ts.
// Gates: read-only-by-default, per-action deny, and a fail-closed REQUIRED target allowlist for writes.

import { expandScopes, type OpType, type TargetKind } from './policy.js';
import { REGISTRY } from './registry.js';

export interface SafetyConfig {
  allowWrites: boolean; // master mutation switch (default false)
  allowedSubaccounts: string[]; // fail-closed: a write target absent from its list is refused
  allowedOrgs: string[];
  allowedSpaces: string[];
  denyActions: string[]; // 'Tool.action' | 'Tool.*' | 'Tool'
}

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

export function checkOperation(s: SafetyConfig, op: OpType, name: string): void {
  if ((op === 'W' || op === 'A') && !s.allowWrites) {
    throw new SafetyError(`'${name}' is a mutation but the server is read-only. Set ALLOW_WRITES=true to enable.`);
  }
}

export function isDenied(denyActions: string[], tool: string, action: string): boolean {
  return denyActions.some((d) => d === `${tool}.${action}` || d === `${tool}.*` || d === tool);
}

// A DENY_ACTIONS pattern that matches NO known tool.action is a SILENT SAFETY NO-OP (a stale tool name
// or a typo) — return those so startup can fail loudly instead of leaving an action unexpectedly allowed.
export function unmatchedDenyPatterns(patterns: string[]): string[] {
  return patterns.filter((p) => !REGISTRY.some((a) => isDenied([p], a.tool, a.action)));
}

// Fail-closed: a write's target MUST be provided AND allowlisted. An omitted target is refused
// (closes the "undefined slips through" hole). Reads do not call this.
export function requireTarget(s: SafetyConfig, kind: TargetKind, value: string | undefined): void {
  const list = kind === 'subaccount' ? s.allowedSubaccounts : kind === 'org' ? s.allowedOrgs : s.allowedSpaces;
  if (!value) {
    throw new SafetyError(`A '${kind}' target is required for this write but was not provided.`);
  }
  if (!list.includes(value)) {
    throw new SafetyError(`${kind} '${value}' is not in the allowlist [${list.join(', ') || 'empty'}].`);
  }
}

// Per-user scopes only narrow the server ceiling, never expand it (arc-1 invariant).
export function deriveUserSafety(base: SafetyConfig, scopes: readonly string[]): SafetyConfig {
  const canWrite = expandScopes(scopes).includes('write');
  return { ...base, allowWrites: base.allowWrites && canWrite };
}
