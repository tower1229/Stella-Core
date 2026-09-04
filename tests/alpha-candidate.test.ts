import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createAlphaCandidateReceipt } from "../src/acceptance/alpha-candidate.js";

const execFileAsync = promisify(execFile);

async function createRepository(prefix: string): Promise<{ root: string; revision: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  await writeFile(path.join(root, "source.txt"), "source\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "source.txt"]);
  await execFileAsync("git", ["-C", root, "commit", "--quiet", "-m", "source"]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return { root, revision: stdout.trim() };
}

test("creates a fail-closed Alpha candidate receipt bound to clean sources and artifact", async () => {
  const core = await createRepository("stella-alpha-core-");
  const canghai = await createRepository("stella-alpha-canghai-");
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "stella-alpha-artifact-"));
  const artifactPath = path.join(artifactRoot, "stella-core.tgz");
  await writeFile(artifactPath, "packed artifact", "utf8");
  try {
    const artifactSha256 = createHash("sha256").update("packed artifact").digest("hex");
    const receipt = await createAlphaCandidateReceipt({
      core: { root: core.root, revision: core.revision },
      canghai: { root: canghai.root, revision: canghai.revision },
      hostVersion: "2026.8.2",
      artifactPath,
      recovery: {
        schemaVersion: "stella.exact-host-recovery-receipt/v1",
        coreRevision: core.revision,
        canghaiRevision: canghai.revision,
        hostVersion: "2026.8.2",
        artifactSha256,
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
        exactHostAgentTurns: 3,
        privateFixtureIncluded: true,
      },
      praxisLoop: {
        schemaVersion: "stella.exact-host-praxis-receipt/v1",
        coreRevision: core.revision,
        initialCanghaiRevision: "4".repeat(40),
        finalCanghaiRevision: canghai.revision,
        hostVersion: "2026.8.2",
        artifactSha256,
        dataMode: "managed_durable_write",
        predictionSealedBeforeOutcome: true,
        recommendationPersisted: true,
        actualRecorded: true,
        outcomeClosed: true,
        learningPersisted: true,
        learningRetrievedAfterRestart: true,
        finalRevisionRemoteSynchronized: true,
        sourceClean: true,
        exactHostAgentTurns: 3,
        episodeRefHash: "5".repeat(64),
        learningRefHash: "6".repeat(64),
        privateFixtureIncluded: true,
      },
      durability: {
        criticalWritePolicy: "sync_immediately",
        criticalSynchronized: true,
        normalWritePolicy: "bounded_batch",
        maxNormalRpoSeconds: 300,
        observedNormalRpoSeconds: 12,
        normalState: "current",
        synchronizedRevision: canghai.revision,
      },
      evaluation: {
        schemaVersion: "stella.alpha-praxis-evaluation/v1",
        boundary: "mixed",
        boundaryCounts: { public_synthetic: 29, private_canghai: 1 },
        caseCount: 30,
        passedCount: 30,
        failedCount: 0,
        failedCaseIds: [],
        failedDimensions: {},
        categoryCounts: {
          asking_for_help: 4,
          family_privacy: 4,
          gratitude_reciprocity: 4,
          informal_workplace: 4,
          refusing_requests: 4,
          relationship_communication: 4,
          social_etiquette: 3,
          uncertainty_conflict: 3,
        },
        execution: {
          coreRevision: core.revision,
          canghaiRevision: canghai.revision,
          hostVersion: "2026.8.2",
          artifactSha256,
        },
      },
      createdAt: "2026-09-03T00:00:00.000Z",
    });

    assert.equal(receipt.schemaVersion, "stella.alpha-candidate-receipt/v2");
    assert.equal(receipt.candidate, true);
    assert.equal(receipt.core.sourceClean, true);
    assert.equal(receipt.canghai.sourceClean, true);
    assert.equal(receipt.host.version, "2026.8.2");
    assert.equal(
      receipt.artifact.sha256,
      artifactSha256,
    );
    assert.equal(receipt.release.tagCreated, false);
    assert.equal(receipt.release.npmPublished, false);
  } finally {
    await rm(core.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(canghai.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(artifactRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("rejects dirty or incomplete candidate evidence", async () => {
  const core = await createRepository("stella-alpha-core-");
  const canghai = await createRepository("stella-alpha-canghai-");
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "stella-alpha-artifact-"));
  const artifactPath = path.join(artifactRoot, "stella-core.tgz");
  await writeFile(artifactPath, "packed artifact", "utf8");
  const artifactSha256 = createHash("sha256").update("packed artifact").digest("hex");
  const base = {
    core: { root: core.root, revision: core.revision },
    canghai: { root: canghai.root, revision: canghai.revision },
    hostVersion: "2026.8.2",
    artifactPath,
    recovery: {
      schemaVersion: "stella.exact-host-recovery-receipt/v1" as const,
      coreRevision: core.revision,
      canghaiRevision: canghai.revision,
      hostVersion: "2026.8.2" as const,
      artifactSha256,
      canghaiFixture: "private" as const,
      cleanRuntimeState: true as const,
      importedLegacyRuntime: false as const,
      dataReadable: true as const,
      cognitiveBootstrapRestored: true as const,
      derivedRuntimeRebuilt: true as const,
      continuityAccepted: true as const,
      identityRestored: true as const,
      frameworkRestored: true as const,
      twinRestored: true as const,
      praxisLearningRestored: true as const,
      importantOpenStateRestored: true as const,
      exactHostAgentTurns: 3,
      privateFixtureIncluded: true as const,
    },
    praxisLoop: {
      schemaVersion: "stella.exact-host-praxis-receipt/v1" as const,
      coreRevision: core.revision,
      initialCanghaiRevision: "4".repeat(40),
      finalCanghaiRevision: canghai.revision,
      hostVersion: "2026.8.2" as const,
      artifactSha256,
      dataMode: "managed_durable_write" as const,
      predictionSealedBeforeOutcome: true as const,
      recommendationPersisted: true as const,
      actualRecorded: true as const,
      outcomeClosed: true as const,
      learningPersisted: true as const,
      learningRetrievedAfterRestart: true as const,
      finalRevisionRemoteSynchronized: true as const,
      sourceClean: true as const,
      exactHostAgentTurns: 3,
      episodeRefHash: "5".repeat(64),
      learningRefHash: "6".repeat(64),
      privateFixtureIncluded: true as const,
    },
    durability: {
      criticalWritePolicy: "sync_immediately" as const,
      criticalSynchronized: true,
      normalWritePolicy: "bounded_batch" as const,
      maxNormalRpoSeconds: 300,
      observedNormalRpoSeconds: 12,
      normalState: "current" as const,
      synchronizedRevision: canghai.revision,
    },
    evaluation: {
      schemaVersion: "stella.alpha-praxis-evaluation/v1" as const,
      boundary: "mixed" as const,
      boundaryCounts: { public_synthetic: 29, private_canghai: 1 },
      caseCount: 30,
      passedCount: 30,
      failedCount: 0,
      failedCaseIds: [],
      failedDimensions: {},
      categoryCounts: {
        asking_for_help: 4,
        family_privacy: 4,
        gratitude_reciprocity: 4,
        informal_workplace: 4,
        refusing_requests: 4,
        relationship_communication: 4,
        social_etiquette: 3,
        uncertainty_conflict: 3,
      },
      execution: {
        coreRevision: core.revision,
        canghaiRevision: canghai.revision,
        hostVersion: "2026.8.2",
        artifactSha256,
      },
    },
    createdAt: "2026-09-03T00:00:00.000Z",
  };
  try {
    await writeFile(path.join(core.root, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(createAlphaCandidateReceipt(base), /Core source must be clean/);
    await rm(path.join(core.root, "dirty.txt"));
    await assert.rejects(
      createAlphaCandidateReceipt({
        ...base,
        recovery: { ...base.recovery, exactHostAgentTurns: 0 },
      }),
      /Invalid exact-host recovery receipt/,
    );
    await assert.rejects(
      createAlphaCandidateReceipt({
        ...base,
        evaluation: { ...base.evaluation, passedCount: 29, failedCount: 1, failedCaseIds: ["x"] },
      }),
      /evaluation must pass/,
    );
    await assert.rejects(
      createAlphaCandidateReceipt({
        ...base,
        durability: { ...base.durability, observedNormalRpoSeconds: 301 },
      }),
      /RPO exceeds/,
    );
    await assert.rejects(
      createAlphaCandidateReceipt({
        ...base,
        evaluation: {
          ...base.evaluation,
          boundary: "public_synthetic",
          boundaryCounts: { public_synthetic: 30, private_canghai: 0 },
        },
      }),
      /private Praxis evaluation/,
    );
  } finally {
    await rm(core.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(canghai.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(artifactRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
