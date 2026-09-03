import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PraxisEvaluationReport } from "./praxis-evaluation.js";

const execFileAsync = promisify(execFile);
const ALPHA_HOST_VERSION = "2026.8.2";

type SourceInput = {
  root: string;
  revision: string;
};

export type AlphaRecoveryEvidence = {
  cleanRuntimeState: boolean;
  importedLegacyRuntime: boolean;
  dataReadable: boolean;
  cognitiveBootstrapRestored: boolean;
  derivedRuntimeRebuilt: boolean;
  continuityAccepted: boolean;
  identityRestored: boolean;
  frameworkRestored: boolean;
  twinRestored: boolean;
  praxisLearningRestored: boolean;
  importantOpenStateRestored: boolean;
};

export type AlphaDurabilityEvidence = {
  criticalWritePolicy: "sync_immediately" | "bounded_batch";
  criticalSynchronized: boolean;
  normalWritePolicy: "sync_immediately" | "bounded_batch";
  maxNormalRpoSeconds: number;
  observedNormalRpoSeconds: number;
};

export type AlphaCandidateInput = {
  core: SourceInput;
  canghai: SourceInput;
  hostVersion: string;
  artifactPath: string;
  recovery: AlphaRecoveryEvidence;
  durability: AlphaDurabilityEvidence;
  evaluation: PraxisEvaluationReport;
  privateEvaluationIncluded: boolean;
  createdAt?: string;
};

export type AlphaCandidateReceipt = {
  schemaVersion: "stella.alpha-candidate-receipt/v1";
  candidate: true;
  createdAt: string;
  core: { revision: string; sourceClean: true };
  canghai: { revision: string; sourceClean: true };
  host: { product: "OpenClaw"; version: "2026.8.2"; cleanRuntimeState: true };
  artifact: { path: string; sha256: string; bytes: number };
  recovery: AlphaRecoveryEvidence;
  durability: AlphaDurabilityEvidence;
  evaluation: PraxisEvaluationReport & { privateEvaluationIncluded: boolean };
  release: {
    tagCreated: false;
    githubReleaseCreated: false;
    npmPublished: false;
    productionDeployed: false;
  };
};

async function inspectSource(label: string, source: SourceInput): Promise<string> {
  if (!/^[0-9a-f]{40}$/i.test(source.revision)) {
    throw new Error(`${label} revision must be a full Git commit SHA`);
  }
  const root = path.resolve(source.root);
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", root, "status", "--porcelain"]),
  ]);
  if (head.trim() !== source.revision) {
    throw new Error(`${label} HEAD must equal the candidate revision`);
  }
  if (status.trim()) throw new Error(`${label} source must be clean`);
  return head.trim();
}

async function hashArtifact(artifactPath: string): Promise<{ sha256: string; bytes: number }> {
  const absolutePath = path.resolve(artifactPath);
  const details = await stat(absolutePath);
  if (!details.isFile() || details.size === 0) {
    throw new Error("Alpha candidate artifact must be a non-empty file");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: details.size };
}

function validateRecovery(recovery: AlphaRecoveryEvidence): void {
  const required = [
    recovery.cleanRuntimeState,
    recovery.dataReadable,
    recovery.cognitiveBootstrapRestored,
    recovery.derivedRuntimeRebuilt,
    recovery.continuityAccepted,
    recovery.identityRestored,
    recovery.frameworkRestored,
    recovery.twinRestored,
    recovery.praxisLearningRestored,
    recovery.importantOpenStateRestored,
  ];
  if (recovery.importedLegacyRuntime || required.some((value) => value !== true)) {
    throw new Error("Alpha recovery evidence does not satisfy clean Level 3 continuity");
  }
}

function validateDurability(durability: AlphaDurabilityEvidence): void {
  if (durability.criticalWritePolicy !== "sync_immediately" || !durability.criticalSynchronized) {
    throw new Error("Alpha critical writes must be synchronized immediately");
  }
  if (
    !Number.isInteger(durability.maxNormalRpoSeconds) ||
    durability.maxNormalRpoSeconds < 0 ||
    !Number.isFinite(durability.observedNormalRpoSeconds) ||
    durability.observedNormalRpoSeconds < 0
  ) {
    throw new Error("Alpha normal RPO evidence is invalid");
  }
  if (durability.observedNormalRpoSeconds > durability.maxNormalRpoSeconds) {
    throw new Error("Alpha observed normal RPO exceeds the manifest policy");
  }
}

function validateEvaluation(evaluation: PraxisEvaluationReport): void {
  if (
    evaluation.caseCount < 30 ||
    evaluation.caseCount > 50 ||
    evaluation.failedCount !== 0 ||
    evaluation.passedCount !== evaluation.caseCount ||
    evaluation.failedCaseIds.length !== 0
  ) {
    throw new Error("Alpha Praxis evaluation must pass all 30 to 50 cases");
  }
}

export async function createAlphaCandidateReceipt(
  input: AlphaCandidateInput,
): Promise<AlphaCandidateReceipt> {
  if (input.hostVersion !== ALPHA_HOST_VERSION) {
    throw new Error(`Alpha candidate requires OpenClaw ${ALPHA_HOST_VERSION}`);
  }
  validateRecovery(input.recovery);
  validateDurability(input.durability);
  validateEvaluation(input.evaluation);
  const containsPrivateEvaluation = input.evaluation.boundaryCounts.private_canghai > 0;
  if (input.privateEvaluationIncluded !== containsPrivateEvaluation) {
    throw new Error("Alpha private-evaluation flag does not match the evaluation boundary counts");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Alpha receipt time is invalid");

  const [coreRevision, canghaiRevision, artifact] = await Promise.all([
    inspectSource("Core", input.core),
    inspectSource("CangHai", input.canghai),
    hashArtifact(input.artifactPath),
  ]);

  return {
    schemaVersion: "stella.alpha-candidate-receipt/v1",
    candidate: true,
    createdAt,
    core: { revision: coreRevision, sourceClean: true },
    canghai: { revision: canghaiRevision, sourceClean: true },
    host: { product: "OpenClaw", version: ALPHA_HOST_VERSION, cleanRuntimeState: true },
    artifact: { path: path.resolve(input.artifactPath), ...artifact },
    recovery: input.recovery,
    durability: input.durability,
    evaluation: { ...input.evaluation, privateEvaluationIncluded: input.privateEvaluationIncluded },
    release: {
      tagCreated: false,
      githubReleaseCreated: false,
      npmPublished: false,
      productionDeployed: false,
    },
  };
}
