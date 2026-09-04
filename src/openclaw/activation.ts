import path from "node:path";
import type { StellaDataMode } from "../praxis/episode-store.js";
import { isRecord } from "../shared/type-guards.js";
import { ALPHA_HOST_VERSION } from "../acceptance/exact-host-evidence.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

export type StellaActivationRequest = {
  canghaiRoot: string;
  recoveryRevision: string;
  agentId: string;
  dataMode: StellaDataMode;
  durabilityRemote?: string;
  durabilityBranch?: string;
};

export type StellaActivationAssessment = {
  ready: boolean;
  issues: string[];
  desiredEntry: {
    enabled: true;
    config: StellaActivationRequest;
    hooks: {
      allowConversationAccess: true;
      allowPromptInjection: true;
      timeouts: {
        before_prompt_build: 60_000;
        before_agent_finalize: 90_000;
        agent_end: 90_000;
      };
    };
    llm: { allowAgentIdOverride: true };
  };
};

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assessStellaActivation(
  request: StellaActivationRequest,
  observed: {
    coreClean: boolean;
    canghaiClean: boolean;
    canghaiBranch: string;
    canghaiRevision: string;
    openclawVersion: string;
    configValid: boolean;
    manifestValid: boolean;
    pluginRuntimeValid: boolean;
    pluginEntry: unknown;
  },
): StellaActivationAssessment {
  if (!path.isAbsolute(request.canghaiRoot)) {
    throw new Error("Stella activation requires an absolute CangHai root");
  }
  if (!SHA_PATTERN.test(request.recoveryRevision)) {
    throw new Error("Stella activation requires a full CangHai revision");
  }
  if (!request.agentId.trim()) throw new Error("Stella activation requires an agent id");
  if (
    request.dataMode !== "read_only" &&
    request.dataMode !== "local_write" &&
    request.dataMode !== "managed_durable_write"
  ) {
    throw new Error("Stella activation data mode is invalid");
  }
  if (
    request.dataMode === "managed_durable_write" &&
    (!request.durabilityRemote?.trim() || !request.durabilityBranch?.trim())
  ) {
    throw new Error("Managed Stella activation requires an explicit durability remote and branch");
  }
  const desiredEntry = {
    enabled: true as const,
    config: request,
    hooks: {
      allowConversationAccess: true as const,
      allowPromptInjection: true as const,
      timeouts: {
        before_prompt_build: 60_000 as const,
        before_agent_finalize: 90_000 as const,
        agent_end: 90_000 as const,
      },
    },
    llm: { allowAgentIdOverride: true as const },
  };
  const issues: string[] = [];
  if (!observed.coreClean) issues.push("core_source_dirty");
  if (!observed.canghaiClean) issues.push("canghai_source_dirty");
  if (
    request.dataMode === "managed_durable_write" &&
    observed.canghaiBranch !== request.durabilityBranch
  ) {
    issues.push("canghai_branch_mismatch");
  }
  if (observed.canghaiRevision !== request.recoveryRevision) issues.push("canghai_revision_mismatch");
  if (observed.openclawVersion !== ALPHA_HOST_VERSION) issues.push("openclaw_version_mismatch");
  if (!observed.configValid) issues.push("openclaw_config_invalid");
  if (!observed.manifestValid) issues.push("canghai_manifest_invalid");
  if (!observed.pluginRuntimeValid) issues.push("stella_plugin_runtime_invalid");
  if (!isRecord(observed.pluginEntry) || !sameValue(observed.pluginEntry, desiredEntry)) {
    issues.push("stella_plugin_config_drift");
  }
  return { ready: issues.length === 0, issues, desiredEntry };
}
