import { RecoveryAuthorityError, type RecoveryAuthorityResolver, type RecoveryAuthoritySnapshot } from "./recovery-authority-contract.js";

export type RecoveryReadScope = Readonly<{ agentId: string; canghaiRoot: string; manifestPath: string }>;
export type RecoveryReadBinding = Readonly<{ resolver: RecoveryAuthorityResolver; expected: RecoveryAuthoritySnapshot }>;
function snapshot(value: RecoveryAuthoritySnapshot, scope: RecoveryReadScope): RecoveryAuthoritySnapshot {
  if (!value || typeof value !== "object" || !value.binding || typeof value.binding !== "object" || (value.mode !== "core_checkpoint" && value.mode !== "legacy_config") || typeof value.revision !== "string" || !/^[a-f0-9]{40}$/i.test(value.revision) ||
      typeof value.token !== "string" || !value.token || value.binding.agentId !== scope.agentId ||
      value.binding.repositoryRoot !== scope.canghaiRoot || value.binding.manifestPath !== scope.manifestPath) {
    throw new RecoveryAuthorityError("recovery_read_binding_mismatch");
  }
  return Object.freeze({ mode: value.mode, binding: Object.freeze({ ...value.binding }), revision: value.revision, token: value.token });
}
/** Capture once for one operation; assertion never reads and adopts a replacement. */
export async function captureRecoveryReadBinding(scope: RecoveryReadScope, resolver: RecoveryAuthorityResolver): Promise<RecoveryReadBinding> {
  const owner = Object.freeze({ ...scope });
  const expected = snapshot(await resolver.read(), owner);
  if (expected.mode !== resolver.mode) throw new RecoveryAuthorityError("recovery_read_binding_mismatch");
  await resolver.assertCurrent(expected);
  return Object.freeze({ resolver, expected });
}
export function freezeRecoveryReadBinding(binding: RecoveryReadBinding, scope: RecoveryReadScope): RecoveryReadBinding {
  const resolver = binding.resolver, expected = snapshot(binding.expected, scope);
  if (expected.mode !== resolver.mode) throw new RecoveryAuthorityError("recovery_read_binding_mismatch");
  return Object.freeze({ resolver, expected });
}
export async function assertRecoveryReadBinding(binding: RecoveryReadBinding, scope: RecoveryReadScope): Promise<void> {
  const fixed = freezeRecoveryReadBinding(binding, scope);
  await fixed.resolver.assertCurrent(fixed.expected);
}
/** Caller closes at registration shutdown/supersession. No hidden global adoption. */
export function createRecoveryReadScope(scope: RecoveryReadScope, resolver: RecoveryAuthorityResolver) {
  const owner = Object.freeze({ ...scope });
  let active = true;
  const assertActive = () => { if (!active) throw new RecoveryAuthorityError("recovery_scope_closed"); };
  const scoped: RecoveryAuthorityResolver = Object.freeze({ mode: resolver.mode,
    async read() { assertActive(); const value = snapshot(await resolver.read(), owner); assertActive(); return value; },
    async assertCurrent(expected: RecoveryAuthoritySnapshot) {
      assertActive();
      const fixed = snapshot(expected, owner);
      if (fixed.mode !== resolver.mode) throw new RecoveryAuthorityError("recovery_read_binding_mismatch");
      await resolver.assertCurrent(fixed);
      assertActive();
    },
  });
  return Object.freeze({ resolver: scoped, capture: () => captureRecoveryReadBinding(owner, scoped),
    close() { active = false; } });
}
