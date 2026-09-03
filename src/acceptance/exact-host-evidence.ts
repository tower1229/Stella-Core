import { isRecord } from "../shared/type-guards.js";

export const ALPHA_HOST_VERSION = "2026.8.2";

export type ExactHostRecoveryReceipt = {
  schemaVersion: "stella.exact-host-recovery-receipt/v1";
  coreRevision: string;
  canghaiRevision: string;
  hostVersion: typeof ALPHA_HOST_VERSION;
  artifactSha256: string;
  canghaiFixture: "private";
  cleanRuntimeState: true;
  importedLegacyRuntime: false;
  dataReadable: true;
  cognitiveBootstrapRestored: true;
  derivedRuntimeRebuilt: true;
  continuityAccepted: true;
  identityRestored: true;
  frameworkRestored: true;
  twinRestored: true;
  praxisLearningRestored: true;
  importantOpenStateRestored: true;
  exactHostAgentTurns: number;
  privateFixtureIncluded: true;
};

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

export function parseExactHostVersion(output: string): typeof ALPHA_HOST_VERSION {
  const match = /^OpenClaw ([^ ]+)/u.exec(output.trim());
  if (match?.[1] !== ALPHA_HOST_VERSION) {
    throw new Error(`Exact Host requires OpenClaw ${ALPHA_HOST_VERSION}`);
  }
  return ALPHA_HOST_VERSION;
}

export function assertStellaHostConfig(
  value: unknown,
  expected: { canghaiRoot: string; canghaiRevision: string; agentId: string },
): void {
  if (
    !isRecord(value) ||
    value.canghaiRoot !== expected.canghaiRoot ||
    value.recoveryRevision !== expected.canghaiRevision ||
    value.agentId !== expected.agentId ||
    value.dataMode !== "read_only"
  ) {
    throw new Error("Exact Host Stella config is not bound to the requested CangHai source");
  }
}

export function parseExactHostRecoveryReceipt(value: unknown): ExactHostRecoveryReceipt {
  if (!isRecord(value)) throw new Error("Invalid exact-host recovery receipt");
  const requiredTrue = [
    "cleanRuntimeState",
    "dataReadable",
    "cognitiveBootstrapRestored",
    "derivedRuntimeRebuilt",
    "continuityAccepted",
    "identityRestored",
    "frameworkRestored",
    "twinRestored",
    "praxisLearningRestored",
    "importantOpenStateRestored",
    "privateFixtureIncluded",
  ];
  if (
    value.schemaVersion !== "stella.exact-host-recovery-receipt/v1" ||
    typeof value.coreRevision !== "string" ||
    !SHA_PATTERN.test(value.coreRevision) ||
    typeof value.canghaiRevision !== "string" ||
    !SHA_PATTERN.test(value.canghaiRevision) ||
    value.hostVersion !== ALPHA_HOST_VERSION ||
    typeof value.artifactSha256 !== "string" ||
    !SHA256_PATTERN.test(value.artifactSha256) ||
    value.canghaiFixture !== "private" ||
    value.importedLegacyRuntime !== false ||
    requiredTrue.some((field) => value[field] !== true) ||
    !Number.isInteger(value.exactHostAgentTurns) ||
    (value.exactHostAgentTurns as number) <= 0
  ) {
    throw new Error("Invalid exact-host recovery receipt");
  }
  return value as ExactHostRecoveryReceipt;
}
