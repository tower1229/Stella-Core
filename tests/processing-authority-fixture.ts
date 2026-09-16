import {
  bindProcessingAuthority,
  resolveDeploymentDigest,
  type ProcessingAuthority,
} from "../src/openclaw/processing-authority.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";

const purpose = { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "synthetic/model" };
const revision = "a".repeat(40);
const deployment = resolveDeploymentDigest({
  agentId: "stella", recoveryRevision: revision, pluginSource: "synthetic-plugin-source",
});

/** Owner-direct authority for unit fixtures that consume private views / fragments. */
export function ownerDirectAuthority(overrides?: {
  runId?: string;
  modelRef?: string;
  generationId?: string;
  purpose?: { readPurpose: string; derivePurpose: string; deliveryScope: string };
}): ProcessingAuthority {
  const runId = overrides?.runId ?? "run-owner";
  return bindProcessingAuthority({
    request: snapshotTurnRequest({
      agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
      prompt: "synthetic private request", senderId: "owner-host",
      senderIsOwner: true, chatType: "direct",
    }, runId),
    ownerId: "owner",
    purpose: overrides?.purpose ?? purpose,
    modelRef: overrides?.modelRef ?? "synthetic/model",
    deployment,
    generationId: overrides?.generationId ?? "generation_fixture",
  });
}

export { purpose as fixturePurpose, deployment as fixtureDeployment, revision as fixtureRevision };
