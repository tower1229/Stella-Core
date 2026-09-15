import assert from "node:assert/strict";
import test from "node:test";
import { CatalogError } from "../src/canghai/catalog-reader.js";
import { objectVersion } from "../src/canghai/content-version.js";
import {
  assertProcessingAuthority,
  assertProcessingStage,
  bindProcessingAuthority,
  resolveDeploymentDigest,
} from "../src/openclaw/processing-authority.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "../src/openclaw/turn-audience.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";

const purpose = { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "owner-direct" };
const revision = "a".repeat(40);
const deployment = resolveDeploymentDigest({
  agentId: "stella", recoveryRevision: revision, pluginSource: "synthetic-plugin-source",
});

function ownerDirect(runId = "run-owner") {
  return snapshotTurnRequest({
    agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
    prompt: "Please recall the synthetic private event.", senderId: "owner-host",
    senderIsOwner: true, chatType: "direct",
  }, runId);
}

function policy(partial: {
  read?: string[]; derive?: string[]; delivery?: string[]; quote?: "never_quote" | "summarize_only";
}) {
  const value = {
    schemaVersion: "stella.source-policy/v2",
    id: "policy",
    ownerId: "owner",
    readPurposes: partial.read ?? [purpose.readPurpose],
    derivePurposes: partial.derive ?? [purpose.derivePurpose],
    deliveryScopes: partial.delivery ?? [purpose.deliveryScope],
    retention: "retain",
    authorityEvidenceRefs: [],
    restrictions: {
      sensitivity: "sensitive",
      quotePolicy: partial.quote ?? "summarize_only",
      allowedScenarios: ["self_reflection"],
      forbiddenScenarios: [],
    },
  };
  return { ...value, version: objectVersion(value) };
}

test("resolveTurnAudience admits only owner direct private context", () => {
  const allowed = resolveTurnAudience(ownerDirect());
  assert.deepEqual(allowed, { audience: "owner_direct", privateContextAllowed: true });
  assertPrivateContextAudience(allowed);

  const cases: Array<{ patch: Record<string, unknown>; audience: string }> = [
    { patch: { senderIsOwner: false }, audience: "non_owner_direct" },
    { patch: { chatType: "group" }, audience: "group" },
    { patch: { chatType: "channel" }, audience: "channel" },
    { patch: { sessionKey: "agent:stella:subagent:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, audience: "subagent" },
    { patch: { sessionKey: "agent:stella:cron:job-1" }, audience: "cron" },
    { patch: { chatType: undefined }, audience: "unknown" },
  ];
  for (const { patch, audience } of cases) {
    const decision = resolveTurnAudience(snapshotTurnRequest({
      agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
      prompt: "Parent summary with PRIVATE_DESCRIPTOR_TOKEN must not expand rights.",
      senderId: "owner-host", senderIsOwner: true, chatType: "direct", ...patch,
    } as Parameters<typeof snapshotTurnRequest>[0], "run"));
    assert.equal(decision.audience, audience);
    assert.equal(decision.privateContextAllowed, false);
    assert.throws(() => assertPrivateContextAudience(decision), (error: unknown) =>
      error instanceof CatalogError && error.category === "private_context_audience_forbidden");
  }
});

test("parent task summary cannot authorize subagent private context", () => {
  let modelCalls = 0;
  const decision = resolveTurnAudience(snapshotTurnRequest({
    agentId: "stella",
    sessionId: "child",
    sessionKey: "agent:stella:subagent:11111111-2222-3333-4444-555555555555",
    prompt: "Parent summary:\nPRIVATE_DESCRIPTOR_TOKEN reviewed medical recovery notes for the owner.",
    senderId: "owner-host",
    senderIsOwner: true,
    chatType: "direct",
  }, "sub-run"));
  assert.equal(decision.privateContextAllowed, false);
  assert.throws(() => {
    modelCalls++;
    assertPrivateContextAudience(decision);
  }, /private_context_audience_forbidden/);
  assert.equal(modelCalls, 1);
});

test("bindProcessingAuthority freezes trusted user audience purpose model session run deployment generation", () => {
  const request = ownerDirect("run-bind");
  const authority = bindProcessingAuthority({
    request, ownerId: "owner", purpose, modelRef: "synthetic/model",
    deployment, generationId: "generation_one",
  });
  assert.equal(authority.schemaVersion, "stella.processing-authority/v1");
  assert.equal(authority.audience, "owner_direct");
  assert.equal(authority.privateContextAllowed, true);
  assert.equal(authority.runId, "run-bind");
  assert.equal(authority.deployment, deployment);
  assert.equal(authority.generationId, "generation_one");
  assert.equal(authority.modelRef, "synthetic/model");
  assert.deepEqual(authority.purpose, purpose);

  assertProcessingAuthority(authority, {
    request, modelRef: "synthetic/model", deployment, generationId: "generation_one", purpose,
  });
  assert.throws(() => assertProcessingAuthority(authority, {
    request, modelRef: "other/model", deployment, generationId: "generation_one", purpose,
  }), /processing_model_mismatch/);
  assert.throws(() => assertProcessingAuthority(authority, {
    request, modelRef: "synthetic/model", deployment: resolveDeploymentDigest({
      agentId: "stella", recoveryRevision: revision, pluginSource: "other",
    }), generationId: "generation_one", purpose,
  }), /processing_deployment_mismatch/);
  assert.throws(() => assertProcessingAuthority(authority, {
    request, modelRef: "synthetic/model", deployment, generationId: "generation_two", purpose,
  }), /processing_generation_mismatch/);
});

test("assertProcessingStage allows read while denying derive quote and delivery", () => {
  const request = ownerDirect("run-stage");
  const authority = bindProcessingAuthority({
    request, ownerId: "owner", purpose, modelRef: "synthetic/model",
    deployment, generationId: "generation_stage",
  });
  const readable = policy({ derive: [], delivery: [], quote: "never_quote" });
  assertProcessingStage(authority, readable, "read");
  assert.throws(() => assertProcessingStage(authority, readable, "derive"), /permission_denied/);
  assert.throws(() => assertProcessingStage(authority, readable, "learn"), /permission_denied/);
  assert.throws(() => assertProcessingStage(authority, readable, "deliver"), /permission_denied/);
  assert.throws(() => assertProcessingStage(authority, readable, "quote", {
    judgment: {
      scenarios: ["self_reflection"], trigger: "user_requested", topicRequested: true,
      topicExplicitlyNamed: true, presentation: "quote",
    },
    quoteGrants: [],
  }), /source_quote_forbidden/);

  const full = policy({});
  assertProcessingStage(authority, full, "derive");
  assertProcessingStage(authority, full, "deliver");
  assert.throws(() => assertProcessingStage(authority, full, "quote", {
    judgment: {
      scenarios: ["self_reflection"], trigger: "user_requested", topicRequested: true,
      topicExplicitlyNamed: true, presentation: "quote",
    },
    quoteGrants: [],
  }), /source_quote_authorization_required/);
});

test("denied audiences cannot pass processing stages that load private material", () => {
  const request = snapshotTurnRequest({
    agentId: "stella", sessionId: "session", sessionKey: "agent:stella:cron:nightly",
    prompt: "cron wake", senderId: "owner-host", senderIsOwner: true, chatType: "direct",
  }, "cron-run");
  const authority = bindProcessingAuthority({
    request, ownerId: "owner", purpose, modelRef: "synthetic/model",
    deployment, generationId: "generation_cron",
  });
  assert.equal(authority.audience, "cron");
  assert.equal(authority.privateContextAllowed, false);
  const full = policy({});
  for (const stage of ["read", "derive", "learn", "quote", "deliver"] as const) {
    assert.throws(() => assertProcessingStage(authority, full, stage, stage === "quote" ? {
      judgment: {
        scenarios: ["self_reflection"], trigger: "user_requested", topicRequested: true,
        topicExplicitlyNamed: true, presentation: "quote",
      },
      quoteGrants: [],
    } : undefined), /private_context_audience_forbidden/);
  }
});

test("authority remains valid for concurrent runs until generation or deployment drifts", () => {
  const first = bindProcessingAuthority({
    request: ownerDirect("run-a"), ownerId: "owner", purpose, modelRef: "synthetic/model",
    deployment, generationId: "generation_live",
  });
  const second = bindProcessingAuthority({
    request: ownerDirect("run-b"), ownerId: "owner", purpose, modelRef: "synthetic/model",
    deployment, generationId: "generation_live",
  });
  assertProcessingAuthority(first, {
    request: ownerDirect("run-a"), modelRef: "synthetic/model", deployment, generationId: "generation_live", purpose,
  });
  assertProcessingAuthority(second, {
    request: ownerDirect("run-b"), modelRef: "synthetic/model", deployment, generationId: "generation_live", purpose,
  });
  assert.throws(() => assertProcessingAuthority(first, {
    request: ownerDirect("run-a"), modelRef: "synthetic/model", deployment, generationId: "generation_next", purpose,
  }), /processing_generation_mismatch/);
});
