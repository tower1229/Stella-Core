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

export function assertStellaHostHooks(value: unknown): void {
  if (
    !isRecord(value) ||
    value.allowConversationAccess !== true ||
    value.allowPromptInjection !== true ||
    !isRecord(value.timeouts) ||
    typeof value.timeouts.before_prompt_build !== "number" ||
    value.timeouts.before_prompt_build < 60_000
  ) {
    throw new Error("Exact Host Stella prompt hook permissions or timeout are insufficient");
  }
}

export function assertStellaPluginManifest(value: unknown): void {
  if (
    !isRecord(value) ||
    value.id !== "stella-core" ||
    !isRecord(value.activation) ||
    value.activation.onStartup !== true ||
    !Array.isArray(value.activation.onAgentHarnesses) ||
    !value.activation.onAgentHarnesses.includes("openclaw")
  ) {
    throw new Error("Packed Stella plugin is not activated for the OpenClaw Gateway and agent harness");
  }
}

export function assertStellaPluginRuntime(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.plugin)) {
    throw new Error("Exact Host did not return Stella plugin runtime evidence");
  }
  const plugin = value.plugin;
  const typedHooks = Array.isArray(value.typedHooks) ? value.typedHooks : [];
  const hookNames = new Set(typedHooks.flatMap((hook) =>
    isRecord(hook) && typeof hook.name === "string" ? [hook.name] : []
  ));
  if (
    plugin.id !== "stella-core" ||
    plugin.status !== "loaded" ||
    plugin.activated !== true ||
    !hookNames.has("before_prompt_build") ||
    !hookNames.has("before_agent_run")
  ) {
    throw new Error("Exact Host Stella plugin runtime is not active with required hooks");
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
  return {
    schemaVersion: "stella.exact-host-recovery-receipt/v1",
    coreRevision: value.coreRevision as string,
    canghaiRevision: value.canghaiRevision as string,
    hostVersion: ALPHA_HOST_VERSION,
    artifactSha256: value.artifactSha256 as string,
    canghaiFixture: "private",
    cleanRuntimeState: true,
    importedLegacyRuntime: false,
    dataReadable: true,
    cognitiveBootstrapRestored: true,
    derivedRuntimeRebuilt: true,
    continuityAccepted: true,
    identityRestored: true,
    frameworkRestored: true,
    twinRestored: true,
    praxisLearningRestored: true,
    importantOpenStateRestored: true,
    exactHostAgentTurns: value.exactHostAgentTurns as number,
    privateFixtureIncluded: true,
  };
}
