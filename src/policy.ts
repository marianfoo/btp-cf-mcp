// Scope + action-policy model — adapted from arc-1 src/authz/policy.ts.
// Single source mapping `Tool.action` -> required scope, operation type, and (for writes)
// the target dimension that MUST be present and allowlisted.

import { REGISTRY } from './registry.js';

export type Scope = 'read' | 'write' | 'admin';
export type OpType = 'R' | 'W' | 'A'; // Read | Write | Admin(account-level)
export type TargetKind = 'subaccount' | 'org' | 'space';

export interface ActionPolicy {
  scope: Scope;
  op: OpType;
  target?: TargetKind; // writes only: which target must be allowlisted
}

// Derived from the single-source registry — never hand-maintained (no drift with tools.ts/dispatch).
export const ACTION_POLICY: Record<string, ActionPolicy> = Object.fromEntries(
  REGISTRY.map((a) => [
    `${a.tool}.${a.action}`,
    a.target ? { scope: a.scope, op: a.op, target: a.target } : { scope: a.scope, op: a.op },
  ]),
);

export function expandScopes(scopes: readonly string[]): Scope[] {
  const s = new Set<Scope>();
  for (const x of scopes) {
    if (x === 'admin') {
      s.add('read');
      s.add('write');
      s.add('admin');
    } else if (x === 'write') {
      s.add('read');
      s.add('write');
    } else if (x === 'read') {
      s.add('read');
    }
  }
  return [...s];
}

export function hasScope(scopes: readonly string[], required: Scope): boolean {
  return expandScopes(scopes).includes(required);
}

export function getPolicy(tool: string, action: string): ActionPolicy | undefined {
  return ACTION_POLICY[`${tool}.${action}`];
}
