import { CatalogError } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import {
  assertPurposeAxes,
  assertQuoteCapability,
  parseSourcePolicy,
  type PolicyPurpose,
  type SourceAccessContext,
} from "../canghai/source-policy.js";
import { isRecord } from "../shared/type-guards.js";
import type { BoundTurnRequest } from "./turn-request.js";
import { resolveTurnAudience, type TurnAudience, type TurnAudienceDecision } from "./turn-audience.js";

export const PROCESSING_STAGES = ["read", "derive", "learn", "quote", "deliver"] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export type ProcessingAuthority = Readonly<{
  schemaVersion: "stella.processing-authority/v1";
  ownerId: string;
  senderId?: string;
  senderIsOwner: boolean;
  audience: TurnAudience;
  privateContextAllowed: boolean;
  purpose: PolicyPurpose;
  modelRef: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  deployment: string;
  generationId: string;
  requestHash: string;
}>;

function check(value: unknown, category: string): asserts value {
  if (!value) throw new CatalogError(category);
}

export function resolveDeploymentDigest(input: {
  agentId: string;
  recoveryRevision: string;
  pluginSource: string;
}): string {
  check(typeof input.agentId === "string" && input.agentId.trim() &&
    typeof input.recoveryRevision === "string" && /^[a-f0-9]{40}$/.test(input.recoveryRevision) &&
    typeof input.pluginSource === "string" && input.pluginSource.trim(), "invalid_deployment_binding");
  return bytesVersion(canonicalJson({
    source: input.pluginSource,
    agentId: input.agentId,
    recoveryRevision: input.recoveryRevision,
  }));
}

/** Freeze Host-trusted processing facts for one run. Does not grant source bytes. */
export function bindProcessingAuthority(input: {
  request: BoundTurnRequest;
  ownerId: string;
  purpose: PolicyPurpose;
  modelRef: string;
  deployment: string;
  generationId: string;
  audience?: TurnAudienceDecision;
}): ProcessingAuthority {
  const request = input.request;
  check(typeof input.ownerId === "string" && input.ownerId.trim(), "invalid_processing_owner");
  check(typeof input.modelRef === "string" && input.modelRef.includes("/"), "invalid_processing_model");
  check(typeof input.deployment === "string" && input.deployment.startsWith("sha256:"), "invalid_processing_deployment");
  check(typeof input.generationId === "string" && input.generationId.trim(), "invalid_processing_generation");
  check(isRecord(input.purpose) &&
    typeof input.purpose.readPurpose === "string" && input.purpose.readPurpose.trim() &&
    typeof input.purpose.derivePurpose === "string" && input.purpose.derivePurpose.trim() &&
    typeof input.purpose.deliveryScope === "string" && input.purpose.deliveryScope.trim(), "invalid_processing_purpose");
  const audience = input.audience ?? resolveTurnAudience(request);
  return Object.freeze({
    schemaVersion: "stella.processing-authority/v1",
    ownerId: input.ownerId,
    ...(request.senderId ? { senderId: request.senderId } : {}),
    senderIsOwner: request.senderIsOwner,
    audience: audience.audience,
    privateContextAllowed: audience.privateContextAllowed,
    purpose: {
      readPurpose: input.purpose.readPurpose,
      derivePurpose: input.purpose.derivePurpose,
      deliveryScope: input.purpose.deliveryScope,
    },
    modelRef: input.modelRef,
    sessionId: request.sessionId,
    sessionKey: request.sessionKey,
    runId: request.runId,
    deployment: input.deployment,
    generationId: input.generationId,
    requestHash: request.requestHash,
  });
}

/** Re-check frozen authority against live Host / catalog facts. */
export function assertProcessingAuthority(
  authority: ProcessingAuthority,
  current: {
    request: BoundTurnRequest;
    modelRef: string;
    deployment: string;
    generationId: string;
    purpose: PolicyPurpose;
  },
): void {
  check(authority.schemaVersion === "stella.processing-authority/v1", "invalid_processing_authority");
  check(current.request.runId === authority.runId, "processing_run_mismatch");
  check(current.request.sessionId === authority.sessionId, "processing_session_mismatch");
  check(current.request.sessionKey === authority.sessionKey, "processing_session_mismatch");
  check(current.request.requestHash === authority.requestHash, "processing_request_mismatch");
  check(current.request.senderIsOwner === authority.senderIsOwner, "processing_sender_mismatch");
  check((current.request.senderId ?? undefined) === authority.senderId, "processing_sender_mismatch");
  check(current.modelRef === authority.modelRef, "processing_model_mismatch");
  check(current.deployment === authority.deployment, "processing_deployment_mismatch");
  check(current.generationId === authority.generationId, "processing_generation_mismatch");
  check(canonicalJson(current.purpose) === canonicalJson(authority.purpose), "processing_purpose_mismatch");
  const live = resolveTurnAudience(current.request);
  check(live.audience === authority.audience && live.privateContextAllowed === authority.privateContextAllowed,
    "processing_audience_mismatch");
}

const STAGE_AXES = {
  read: (purpose: PolicyPurpose) => ({ readPurpose: purpose.readPurpose }),
  derive: (purpose: PolicyPurpose) => ({
    readPurpose: purpose.readPurpose,
    derivePurpose: purpose.derivePurpose,
  }),
  // Learn shares purpose axes with derive; write intent is enforced by the learn path.
  learn: (purpose: PolicyPurpose) => ({
    readPurpose: purpose.readPurpose,
    derivePurpose: purpose.derivePurpose,
  }),
  quote: (purpose: PolicyPurpose) => ({ readPurpose: purpose.readPurpose }),
  deliver: (purpose: PolicyPurpose) => ({
    readPurpose: purpose.readPurpose,
    derivePurpose: purpose.derivePurpose,
    deliveryScope: purpose.deliveryScope,
  }),
} as const satisfies Record<ProcessingStage, (purpose: PolicyPurpose) => Partial<PolicyPurpose>>;

/**
 * Stage-scoped purpose / quote checks. Full conjunction remains
 * assertSourcePolicyAccess for callers that need every axis at once.
 */
export function assertProcessingStage(
  authority: ProcessingAuthority,
  policy: unknown,
  stage: ProcessingStage,
  context?: SourceAccessContext,
): void {
  check(PROCESSING_STAGES.includes(stage), "invalid_processing_stage");
  parseSourcePolicy(policy);
  // Private-context stages never admit non-owner audiences; quote is private output too.
  check(authority.privateContextAllowed, "private_context_audience_forbidden");
  assertPurposeAxes(policy, STAGE_AXES[stage](authority.purpose));
  if (stage === "quote") assertQuoteCapability(policy, context);
}
