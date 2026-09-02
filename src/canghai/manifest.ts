import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { satisfies, valid } from "semver";
import { parse as parseYaml } from "yaml";
import { resolveCangHaiRef } from "./ref.js";
import { parseTwinHypothesisRecord, validateSchema } from "./schema.js";

export const DEFAULT_MANIFEST_PATH = "50_PersonalAgent/stella/manifest.yaml";
const execFileAsync = promisify(execFile);

export const CONSCIOUSNESS_FAILURE_CATEGORY = {
  activationDegraded: "stella_activation_degraded",
  coreIncompatible: "stella_core_incompatible",
  hostIncompatible: "stella_host_incompatible",
  manifestInvalid: "stella_manifest_invalid",
  migrationRequired: "stella_migration_required",
  recordInvalid: "stella_record_invalid",
  recoveryRevisionInvalid: "stella_recovery_revision_invalid",
  referenceInvalid: "stella_reference_invalid",
} as const;

export type ConsciousnessFailureCategory =
  (typeof CONSCIOUSNESS_FAILURE_CATEGORY)[keyof typeof CONSCIOUSNESS_FAILURE_CATEGORY];

export class ConsciousnessLoadError extends Error {
  constructor(
    readonly category: ConsciousnessFailureCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConsciousnessLoadError";
  }
}

export type ConsciousnessLoadOptions = {
  recoveryRevision: string;
  coreVersion: string;
  openclawVersion: string;
};

export type StellaConsciousnessManifest = {
  schemaVersion: "stella.consciousness-manifest/v1";
  sourceBaseline: {
    repository: string;
    branch?: string;
    ref?: string;
    commit: string;
    capturedAt?: string;
    validationPolicy?: "exact_commit" | "exact_commit_and_pinned_source_blobs";
  };
  instance: {
    id: string;
    ownerRef: string;
    displayName?: string;
  };
  compatibility: {
    stellaCore: string;
    openclaw: string;
    modelPolicyRef?: string;
  };
  identity: {
    soulRef: string;
    identityRef?: string;
    userProfileRef?: string;
    runtimeProfileRef: string;
    projectionOnlyRefs?: string[];
  };
  twin: {
    hypothesisRegistryRef: string;
    contextualSelfRegistryRef?: string;
    durableStateRef?: string;
  };
  frameworks: {
    sourceRegistryRef: string;
    activeIrRegistryRef: string;
  };
  praxis: {
    episodeRootRef: string;
    playbookRegistryRef?: string;
    openEpisodeRegistryRef?: string;
  };
  experience: {
    corpusRegistryRef: string;
  };
  extensions?: {
    skillRegistryRef?: string;
    capabilityPolicyRef?: string;
    customToolRegistryRef?: string;
  };
  durableState?: {
    goalsRef?: string;
    commitmentsRef?: string;
    openLoopsRef?: string;
  };
  evaluation?: {
    continuitySuiteRef?: string;
    twinEvaluationRef?: string;
    praxisEvaluationRef?: string;
  };
  derived: {
    rebuild: string[];
  };
  secrets?: {
    refs: string[];
  };
  durability?: {
    criticalWritePolicy?: "sync_immediately" | "bounded_batch";
    normalWritePolicy?: "sync_immediately" | "bounded_batch";
    maxNormalRpoSeconds?: number;
  };
  runtimeState: {
    activationStatus: "active" | "migration_required" | "degraded";
    observedOpenClawConfigVersion?: string;
    observedOpenClawConfigBlobSha?: string;
    requiredOpenClawVersion?: string;
    runtimeProfileRef?: string;
  };
  authority?: {
    currentExplicitUserStatementPrecedence?: boolean;
    derivedRuntimeMayWriteAuthority?: boolean;
    sourceUsagePolicyRequiredBeforeDerivation?: boolean;
  };
  notes?: string[];
};

export type ManifestReferenceCheck = {
  field: string;
  ref: string;
  absolutePath: string;
};

export type LoadedConsciousness = {
  canghaiRoot: string;
  manifestPath: string;
  manifest: StellaConsciousnessManifest;
  requiredReferences: ManifestReferenceCheck[];
  bootstrapDocuments: ConsciousnessBootstrapDocument[];
  recoveryRevision?: string;
};

export type ConsciousnessBootstrapDocument = {
  category: "identity" | "twin" | "framework";
  field: string;
  ref: string;
  content: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`Manifest field ${key} must be an object`);
  }
  return value;
}

function requireString(parent: Record<string, unknown>, key: string, fieldPath = key): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Manifest field ${fieldPath} must be a non-empty string`);
  }
  return value;
}

function optionalString(parent: Record<string, unknown>, key: string, fieldPath = key): string | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Manifest field ${fieldPath} must be a non-empty string when present`);
  }
  return value;
}

function optionalRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Manifest field ${key} must be an object when present`);
  }
  return value;
}

function optionalStringArray(parent: Record<string, unknown>, key: string): string[] | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Manifest field ${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function optionalBoolean(parent: Record<string, unknown>, key: string): boolean | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Manifest field ${key} must be a boolean when present`);
  }
  return value;
}

function optionalStringEnum<T extends string>(
  parent: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fieldPath = key,
): T | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Manifest field ${fieldPath} has an unsupported value`);
  }
  return value as T;
}

function requireStringEnum<T extends string>(
  parent: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fieldPath = key,
): T {
  const value = optionalStringEnum(parent, key, values, fieldPath);
  if (value === undefined) {
    throw new Error(`Manifest field ${fieldPath} is required`);
  }
  return value;
}

export function parseConsciousnessManifest(input: string): StellaConsciousnessManifest {
  const parsed = parseYaml(input) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Consciousness manifest must be a YAML object");
  }

  const schemaVersion = requireString(parsed, "schemaVersion");
  if (schemaVersion !== "stella.consciousness-manifest/v1") {
    throw new Error(`Unsupported consciousness manifest schema: ${schemaVersion}`);
  }

  const sourceBaseline = requireRecord(parsed, "sourceBaseline");
  const instance = requireRecord(parsed, "instance");
  const compatibility = requireRecord(parsed, "compatibility");
  const identity = requireRecord(parsed, "identity");
  const twin = requireRecord(parsed, "twin");
  const frameworks = requireRecord(parsed, "frameworks");
  const praxis = requireRecord(parsed, "praxis");
  const experience = requireRecord(parsed, "experience");
  const derived = requireRecord(parsed, "derived");

  const rebuild = derived.rebuild;
  if (!Array.isArray(rebuild) || rebuild.some((item) => typeof item !== "string")) {
    throw new Error("Manifest field derived.rebuild must be an array of strings");
  }

  const extensions = optionalRecord(parsed, "extensions");
  const durableState = optionalRecord(parsed, "durableState");
  const evaluation = optionalRecord(parsed, "evaluation");
  const secrets = optionalRecord(parsed, "secrets");
  const durability = optionalRecord(parsed, "durability");
  const runtimeState = requireRecord(parsed, "runtimeState");
  const authority = optionalRecord(parsed, "authority");
  const sourceValidationPolicy = optionalStringEnum(
    sourceBaseline,
    "validationPolicy",
    ["exact_commit", "exact_commit_and_pinned_source_blobs"] as const,
    "sourceBaseline.validationPolicy",
  );
  const runtimeActivationStatus = requireStringEnum(
    runtimeState,
    "activationStatus",
    ["active", "migration_required", "degraded"] as const,
    "runtimeState.activationStatus",
  );
  const notes = optionalStringArray(parsed, "notes");

  const manifest: StellaConsciousnessManifest = {
    schemaVersion: "stella.consciousness-manifest/v1",
    sourceBaseline: {
      repository: requireString(sourceBaseline, "repository", "sourceBaseline.repository"),
      commit: requireString(sourceBaseline, "commit", "sourceBaseline.commit"),
      ...(optionalString(sourceBaseline, "branch", "sourceBaseline.branch")
        ? { branch: optionalString(sourceBaseline, "branch", "sourceBaseline.branch") }
        : {}),
      ...(optionalString(sourceBaseline, "ref", "sourceBaseline.ref")
        ? { ref: optionalString(sourceBaseline, "ref", "sourceBaseline.ref") }
        : {}),
      ...(optionalString(sourceBaseline, "capturedAt", "sourceBaseline.capturedAt")
        ? { capturedAt: optionalString(sourceBaseline, "capturedAt", "sourceBaseline.capturedAt") }
        : {}),
      ...(sourceValidationPolicy ? { validationPolicy: sourceValidationPolicy } : {}),
    },
    instance: {
      id: requireString(instance, "id", "instance.id"),
      ownerRef: requireString(instance, "ownerRef", "instance.ownerRef"),
      ...(optionalString(instance, "displayName", "instance.displayName")
        ? { displayName: optionalString(instance, "displayName", "instance.displayName") }
        : {}),
    },
    compatibility: {
      stellaCore: requireString(compatibility, "stellaCore", "compatibility.stellaCore"),
      openclaw: requireString(compatibility, "openclaw", "compatibility.openclaw"),
      ...(optionalString(compatibility, "modelPolicyRef", "compatibility.modelPolicyRef")
        ? { modelPolicyRef: optionalString(compatibility, "modelPolicyRef", "compatibility.modelPolicyRef") }
        : {}),
    },
    identity: {
      soulRef: requireString(identity, "soulRef", "identity.soulRef"),
      runtimeProfileRef: requireString(identity, "runtimeProfileRef", "identity.runtimeProfileRef"),
      ...(optionalString(identity, "identityRef", "identity.identityRef")
        ? { identityRef: optionalString(identity, "identityRef", "identity.identityRef") }
        : {}),
      ...(optionalString(identity, "userProfileRef", "identity.userProfileRef")
        ? { userProfileRef: optionalString(identity, "userProfileRef", "identity.userProfileRef") }
        : {}),
      ...(optionalStringArray(identity, "projectionOnlyRefs")
        ? { projectionOnlyRefs: optionalStringArray(identity, "projectionOnlyRefs") }
        : {}),
    },
    twin: {
      hypothesisRegistryRef: requireString(twin, "hypothesisRegistryRef", "twin.hypothesisRegistryRef"),
      ...(optionalString(twin, "contextualSelfRegistryRef", "twin.contextualSelfRegistryRef")
        ? { contextualSelfRegistryRef: optionalString(twin, "contextualSelfRegistryRef", "twin.contextualSelfRegistryRef") }
        : {}),
      ...(optionalString(twin, "durableStateRef", "twin.durableStateRef")
        ? { durableStateRef: optionalString(twin, "durableStateRef", "twin.durableStateRef") }
        : {}),
    },
    frameworks: {
      sourceRegistryRef: requireString(frameworks, "sourceRegistryRef", "frameworks.sourceRegistryRef"),
      activeIrRegistryRef: requireString(frameworks, "activeIrRegistryRef", "frameworks.activeIrRegistryRef"),
    },
    praxis: {
      episodeRootRef: requireString(praxis, "episodeRootRef", "praxis.episodeRootRef"),
      ...(optionalString(praxis, "playbookRegistryRef", "praxis.playbookRegistryRef")
        ? { playbookRegistryRef: optionalString(praxis, "playbookRegistryRef", "praxis.playbookRegistryRef") }
        : {}),
      ...(optionalString(praxis, "openEpisodeRegistryRef", "praxis.openEpisodeRegistryRef")
        ? { openEpisodeRegistryRef: optionalString(praxis, "openEpisodeRegistryRef", "praxis.openEpisodeRegistryRef") }
        : {}),
    },
    experience: {
      corpusRegistryRef: requireString(experience, "corpusRegistryRef", "experience.corpusRegistryRef"),
    },
    derived: { rebuild: rebuild as string[] },
    ...(extensions
      ? {
          extensions: {
            ...(optionalString(extensions, "skillRegistryRef", "extensions.skillRegistryRef")
              ? { skillRegistryRef: optionalString(extensions, "skillRegistryRef", "extensions.skillRegistryRef") }
              : {}),
            ...(optionalString(extensions, "capabilityPolicyRef", "extensions.capabilityPolicyRef")
              ? { capabilityPolicyRef: optionalString(extensions, "capabilityPolicyRef", "extensions.capabilityPolicyRef") }
              : {}),
            ...(optionalString(extensions, "customToolRegistryRef", "extensions.customToolRegistryRef")
              ? { customToolRegistryRef: optionalString(extensions, "customToolRegistryRef", "extensions.customToolRegistryRef") }
              : {}),
          },
        }
      : {}),
    ...(durableState
      ? {
          durableState: {
            ...(optionalString(durableState, "goalsRef", "durableState.goalsRef")
              ? { goalsRef: optionalString(durableState, "goalsRef", "durableState.goalsRef") }
              : {}),
            ...(optionalString(durableState, "commitmentsRef", "durableState.commitmentsRef")
              ? { commitmentsRef: optionalString(durableState, "commitmentsRef", "durableState.commitmentsRef") }
              : {}),
            ...(optionalString(durableState, "openLoopsRef", "durableState.openLoopsRef")
              ? { openLoopsRef: optionalString(durableState, "openLoopsRef", "durableState.openLoopsRef") }
              : {}),
          },
        }
      : {}),
    ...(evaluation
      ? {
          evaluation: {
            ...(optionalString(evaluation, "continuitySuiteRef", "evaluation.continuitySuiteRef")
              ? { continuitySuiteRef: optionalString(evaluation, "continuitySuiteRef", "evaluation.continuitySuiteRef") }
              : {}),
            ...(optionalString(evaluation, "twinEvaluationRef", "evaluation.twinEvaluationRef")
              ? { twinEvaluationRef: optionalString(evaluation, "twinEvaluationRef", "evaluation.twinEvaluationRef") }
              : {}),
            ...(optionalString(evaluation, "praxisEvaluationRef", "evaluation.praxisEvaluationRef")
              ? { praxisEvaluationRef: optionalString(evaluation, "praxisEvaluationRef", "evaluation.praxisEvaluationRef") }
              : {}),
          },
        }
      : {}),
    ...(secrets ? { secrets: { refs: optionalStringArray(secrets, "refs") ?? [] } } : {}),
    ...(durability
      ? {
          durability: {
            ...(durability.criticalWritePolicy === "sync_immediately" || durability.criticalWritePolicy === "bounded_batch"
              ? { criticalWritePolicy: durability.criticalWritePolicy }
              : {}),
            ...(durability.normalWritePolicy === "sync_immediately" || durability.normalWritePolicy === "bounded_batch"
              ? { normalWritePolicy: durability.normalWritePolicy }
              : {}),
            ...(typeof durability.maxNormalRpoSeconds === "number" && Number.isInteger(durability.maxNormalRpoSeconds) && durability.maxNormalRpoSeconds >= 0
              ? { maxNormalRpoSeconds: durability.maxNormalRpoSeconds }
              : {}),
          },
        }
      : {}),
    runtimeState: {
      activationStatus: runtimeActivationStatus,
            ...(optionalString(runtimeState, "observedOpenClawConfigVersion", "runtimeState.observedOpenClawConfigVersion")
              ? { observedOpenClawConfigVersion: optionalString(runtimeState, "observedOpenClawConfigVersion", "runtimeState.observedOpenClawConfigVersion") }
              : {}),
            ...(optionalString(runtimeState, "observedOpenClawConfigBlobSha", "runtimeState.observedOpenClawConfigBlobSha")
              ? { observedOpenClawConfigBlobSha: optionalString(runtimeState, "observedOpenClawConfigBlobSha", "runtimeState.observedOpenClawConfigBlobSha") }
              : {}),
            ...(optionalString(runtimeState, "requiredOpenClawVersion", "runtimeState.requiredOpenClawVersion")
              ? { requiredOpenClawVersion: optionalString(runtimeState, "requiredOpenClawVersion", "runtimeState.requiredOpenClawVersion") }
              : {}),
            ...(optionalString(runtimeState, "runtimeProfileRef", "runtimeState.runtimeProfileRef")
              ? { runtimeProfileRef: optionalString(runtimeState, "runtimeProfileRef", "runtimeState.runtimeProfileRef") }
              : {}),
    },
    ...(authority
      ? {
          authority: {
            ...(optionalBoolean(authority, "currentExplicitUserStatementPrecedence") !== undefined
              ? { currentExplicitUserStatementPrecedence: optionalBoolean(authority, "currentExplicitUserStatementPrecedence") }
              : {}),
            ...(optionalBoolean(authority, "derivedRuntimeMayWriteAuthority") !== undefined
              ? { derivedRuntimeMayWriteAuthority: optionalBoolean(authority, "derivedRuntimeMayWriteAuthority") }
              : {}),
            ...(optionalBoolean(authority, "sourceUsagePolicyRequiredBeforeDerivation") !== undefined
              ? { sourceUsagePolicyRequiredBeforeDerivation: optionalBoolean(authority, "sourceUsagePolicyRequiredBeforeDerivation") }
              : {}),
          },
        }
      : {}),
    ...(notes ? { notes } : {}),
  };

  return manifest;
}

function collectReferenceFields(manifest: StellaConsciousnessManifest): Array<[string, string]> {
  const refs: Array<[string, string | undefined]> = [
    ["instance.ownerRef", manifest.instance.ownerRef],
    ["compatibility.modelPolicyRef", manifest.compatibility.modelPolicyRef],
    ["identity.soulRef", manifest.identity.soulRef],
    ["identity.identityRef", manifest.identity.identityRef],
    ["identity.userProfileRef", manifest.identity.userProfileRef],
    ["identity.runtimeProfileRef", manifest.identity.runtimeProfileRef],
    ...(manifest.identity.projectionOnlyRefs ?? []).map((ref, index) => [
      `identity.projectionOnlyRefs[${index}]`,
      ref,
    ] as [string, string]),
    ["twin.hypothesisRegistryRef", manifest.twin.hypothesisRegistryRef],
    ["twin.contextualSelfRegistryRef", manifest.twin.contextualSelfRegistryRef],
    ["twin.durableStateRef", manifest.twin.durableStateRef],
    ["frameworks.sourceRegistryRef", manifest.frameworks.sourceRegistryRef],
    ["frameworks.activeIrRegistryRef", manifest.frameworks.activeIrRegistryRef],
    ["praxis.episodeRootRef", manifest.praxis.episodeRootRef],
    ["praxis.playbookRegistryRef", manifest.praxis.playbookRegistryRef],
    ["praxis.openEpisodeRegistryRef", manifest.praxis.openEpisodeRegistryRef],
    ["experience.corpusRegistryRef", manifest.experience.corpusRegistryRef],
    ["extensions.skillRegistryRef", manifest.extensions?.skillRegistryRef],
    ["extensions.capabilityPolicyRef", manifest.extensions?.capabilityPolicyRef],
    ["extensions.customToolRegistryRef", manifest.extensions?.customToolRegistryRef],
    ["durableState.goalsRef", manifest.durableState?.goalsRef],
    ["durableState.commitmentsRef", manifest.durableState?.commitmentsRef],
    ["durableState.openLoopsRef", manifest.durableState?.openLoopsRef],
    ["evaluation.continuitySuiteRef", manifest.evaluation?.continuitySuiteRef],
    ["evaluation.twinEvaluationRef", manifest.evaluation?.twinEvaluationRef],
    ["evaluation.praxisEvaluationRef", manifest.evaluation?.praxisEvaluationRef],
    ["runtimeState.runtimeProfileRef", manifest.runtimeState.runtimeProfileRef],
  ];

  return refs.filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function requireRegistryRefs(
  input: string,
  collectionKey: string,
  refKey: string,
  fieldPrefix: string,
  blobKey?: string,
): Array<{ field: string; ref: string; expectedBlob?: string }> {
  const parsed = parseYaml(input) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed[collectionKey])) {
    throw new Error(`Registry field ${collectionKey} must be an array`);
  }

  return parsed[collectionKey].map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Registry field ${collectionKey}[${index}] must be an object`);
    }
    const expectedBlob = blobKey
      ? optionalString(entry, blobKey, `${fieldPrefix}[${index}].${blobKey}`)
      : undefined;
    return {
      field: `${fieldPrefix}[${index}].${refKey}`,
      ref: requireString(entry, refKey, `${fieldPrefix}[${index}].${refKey}`),
      ...(expectedBlob ? { expectedBlob } : {}),
    };
  });
}

async function validateReference(
  root: string,
  field: string,
  ref: string,
  requireTracked = false,
): Promise<ManifestReferenceCheck> {
  try {
    const resolved = resolveCangHaiRef(root, ref);
    await access(resolved.absolutePath);
    const canonicalPath = await realpath(resolved.absolutePath);
    const relativeCanonicalPath = path.relative(root, canonicalPath);
    if (relativeCanonicalPath.startsWith("..") || path.isAbsolute(relativeCanonicalPath)) {
      throw new Error("reference resolves outside CangHai root");
    }
    if (requireTracked) {
      const canonicalRepositoryPath = relativeCanonicalPath.split(path.sep).join(path.posix.sep);
      for (const repositoryPath of new Set([
        resolved.relativePath,
        canonicalRepositoryPath,
      ])) {
        const tracked = await execFileAsync("git", [
          "-C",
          root,
          "ls-files",
          "--",
          repositoryPath,
        ]);
        if (!tracked.stdout.trim()) {
          throw new Error("reference or symlink target is not present in recovery commit");
        }
      }
    }
    return { field, ref, absolutePath: canonicalPath };
  } catch (error) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.referenceInvalid,
      `Required CangHai reference ${field} is unavailable or invalid`,
      { cause: error },
    );
  }
}

async function readBootstrapDocument(
  check: ManifestReferenceCheck,
  category: ConsciousnessBootstrapDocument["category"],
): Promise<ConsciousnessBootstrapDocument> {
  return {
    category,
    field: check.field,
    ref: check.ref,
    content: await readFile(check.absolutePath, "utf8"),
  };
}

async function validateBlobPin(
  root: string,
  field: string,
  ref: string,
  expectedBlob: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(expectedBlob)) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.recordInvalid,
      `Declared source blob for ${field} must be a full Git blob SHA`,
    );
  }
  const resolved = resolveCangHaiRef(root, ref);
  try {
    const result = await execFileAsync("git", ["-C", root, "hash-object", resolved.relativePath]);
    if (result.stdout.trim() !== expectedBlob) throw new Error("blob mismatch");
  } catch (error) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.recordInvalid,
      `Declared source blob for ${field} does not match the selected recovery content`,
      { cause: error },
    );
  }
}

export async function loadConsciousness(
  canghaiRoot: string,
  manifestPath = DEFAULT_MANIFEST_PATH,
  options?: ConsciousnessLoadOptions,
): Promise<LoadedConsciousness> {
  const root = await realpath(path.resolve(canghaiRoot));
  const absoluteManifestPath = path.resolve(root, manifestPath);
  const relativeManifestPath = path.relative(root, absoluteManifestPath);

  if (relativeManifestPath.startsWith("..") || path.isAbsolute(relativeManifestPath)) {
    throw new Error("Manifest path escapes CangHai root");
  }
  let canonicalManifestPath: string;
  try {
    canonicalManifestPath = await realpath(absoluteManifestPath);
  } catch (error) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.manifestInvalid,
      "Consciousness manifest is unavailable",
      { cause: error },
    );
  }
  const relativeCanonicalManifestPath = path.relative(root, canonicalManifestPath);
  if (
    relativeCanonicalManifestPath.startsWith("..") ||
    path.isAbsolute(relativeCanonicalManifestPath)
  ) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.manifestInvalid,
      "Consciousness manifest resolves outside CangHai root",
    );
  }
  if (options) {
    try {
      const trackedManifest = await execFileAsync("git", [
        "-C",
        root,
        "ls-files",
        "--",
        relativeManifestPath,
      ]);
      if (!trackedManifest.stdout.trim()) throw new Error("manifest is not tracked");
    } catch (error) {
      throw new ConsciousnessLoadError(
        CONSCIOUSNESS_FAILURE_CATEGORY.manifestInvalid,
        "Consciousness manifest is not present in the selected recovery commit",
        { cause: error },
      );
    }
  }

  let manifest: StellaConsciousnessManifest;
  try {
    const manifestText = await readFile(canonicalManifestPath, "utf8");
    await validateSchema("consciousness-manifest", parseYaml(manifestText) as unknown);
    manifest = parseConsciousnessManifest(manifestText);
  } catch (error) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.manifestInvalid,
      `Consciousness manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (options) {
    await validateActivationGate(root, manifest, options);
  }

  if (
    manifest.runtimeState.observedOpenClawConfigBlobSha &&
    manifest.compatibility.modelPolicyRef
  ) {
    await validateBlobPin(
      root,
      "runtimeState.observedOpenClawConfigBlobSha",
      manifest.compatibility.modelPolicyRef,
      manifest.runtimeState.observedOpenClawConfigBlobSha,
    );
  }

  const requiredReferences: ManifestReferenceCheck[] = [];
  for (const [field, ref] of collectReferenceFields(manifest)) {
    requiredReferences.push(await validateReference(root, field, ref, options !== undefined));
  }

  const checkByField = new Map(requiredReferences.map((check) => [check.field, check]));
  const requireCheck = (field: string): ManifestReferenceCheck => {
    const check = checkByField.get(field);
    if (!check) throw new Error(`Validated manifest reference is missing: ${field}`);
    return check;
  };

  const bootstrapDocuments: ConsciousnessBootstrapDocument[] = [];
  for (const field of [
    "identity.soulRef",
    "identity.identityRef",
    "identity.userProfileRef",
    "identity.runtimeProfileRef",
  ]) {
    const check = checkByField.get(field);
    if (check) bootstrapDocuments.push(await readBootstrapDocument(check, "identity"));
  }

  const twinRegistryCheck = requireCheck("twin.hypothesisRegistryRef");
  const twinRegistryText = await readFile(twinRegistryCheck.absolutePath, "utf8");
  const twinRefs = requireRegistryRefs(twinRegistryText, "hypotheses", "ref", "twin.hypotheses");
  for (const nested of twinRefs) {
    const check = await validateReference(root, nested.field, nested.ref, options !== undefined);
    const content = await readFile(check.absolutePath, "utf8");
    try {
      const record = parseTwinHypothesisRecord(content);
      await validateSchema("twin-hypothesis", record);
      if (isRecord(record.sourceSnapshot)) {
        for (const [sourceRef, expectedBlob] of Object.entries(record.sourceSnapshot)) {
          if (typeof expectedBlob !== "string") {
            throw new Error("Twin source snapshot values must be Git blob SHAs");
          }
          await validateBlobPin(root, `${nested.field}.sourceSnapshot`, sourceRef, expectedBlob);
        }
      }
    } catch (error) {
      throw new ConsciousnessLoadError(
        CONSCIOUSNESS_FAILURE_CATEGORY.recordInvalid,
        `Twin hypothesis ${nested.field} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    requiredReferences.push(check);
    bootstrapDocuments.push({
      category: "twin",
      field: check.field,
      ref: check.ref,
      content,
    });
  }

  const frameworkSourceRegistryCheck = requireCheck("frameworks.sourceRegistryRef");
  const frameworkSourceRegistryText = await readFile(frameworkSourceRegistryCheck.absolutePath, "utf8");
  const frameworkSourceRefs = requireRegistryRefs(
    frameworkSourceRegistryText,
    "sources",
    "source_ref",
    "frameworks.sources",
    "source_blob_sha",
  );
  for (const nested of frameworkSourceRefs) {
    requiredReferences.push(
      await validateReference(root, nested.field, nested.ref, options !== undefined),
    );
    if (nested.expectedBlob) {
      await validateBlobPin(root, nested.field, nested.ref, nested.expectedBlob);
    }
  }

  const activeIrRegistryCheck = requireCheck("frameworks.activeIrRegistryRef");
  const activeIrRegistryText = await readFile(activeIrRegistryCheck.absolutePath, "utf8");
  const activeIrRefs = requireRegistryRefs(activeIrRegistryText, "active", "ir_ref", "frameworks.active");
  for (const nested of activeIrRefs) {
    const check = await validateReference(root, nested.field, nested.ref, options !== undefined);
    const content = await readFile(check.absolutePath, "utf8");
    try {
      const record = parseYaml(content) as unknown;
      await validateSchema("framework-ir", record);
      if (isRecord(record) && isRecord(record.source)) {
        const sourceRef = requireString(record.source, "ref", `${nested.field}.source.ref`);
        const contentHash = requireString(
          record.source,
          "contentHash",
          `${nested.field}.source.contentHash`,
        );
        if (/^[0-9a-f]{40}$/i.test(contentHash)) {
          await validateBlobPin(root, `${nested.field}.source.contentHash`, sourceRef, contentHash);
        }
      }
    } catch (error) {
      throw new ConsciousnessLoadError(
        CONSCIOUSNESS_FAILURE_CATEGORY.recordInvalid,
        `Framework IR ${nested.field} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    requiredReferences.push(check);
    bootstrapDocuments.push({
      category: "framework",
      field: check.field,
      ref: check.ref,
      content,
    });
  }
  const activeSourceRefs = requireRegistryRefs(
    activeIrRegistryText,
    "active",
    "source_ref",
    "frameworks.active",
    "source_blob_sha",
  );
  for (const nested of activeSourceRefs) {
    requiredReferences.push(
      await validateReference(root, nested.field, nested.ref, options !== undefined),
    );
    if (nested.expectedBlob) {
      await validateBlobPin(root, nested.field, nested.ref, nested.expectedBlob);
    }
  }

  return {
    canghaiRoot: root,
    manifestPath: canonicalManifestPath,
    manifest,
    requiredReferences,
    bootstrapDocuments,
    ...(options ? { recoveryRevision: options.recoveryRevision } : {}),
  };
}

async function validateActivationGate(
  root: string,
  manifest: StellaConsciousnessManifest,
  options: ConsciousnessLoadOptions,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(options.recoveryRevision)) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.recoveryRevisionInvalid,
      "Configured CangHai recovery revision must be a full 40-character Git commit SHA",
    );
  }

  let currentRevision: string;
  let sourceStatus: string;
  try {
    const revisionResult = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    const statusResult = await execFileAsync("git", [
      "-C",
      root,
      "status",
      "--porcelain",
    ]);
    currentRevision = revisionResult.stdout.trim();
    sourceStatus = statusResult.stdout.trim();
  } catch (error) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.recoveryRevisionInvalid,
      "CangHai recovery source is not a readable Git checkout",
      { cause: error },
    );
  }

  if (currentRevision !== options.recoveryRevision || sourceStatus.length > 0) {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.recoveryRevisionInvalid,
      `CangHai checkout must be clean at configured recovery revision ${options.recoveryRevision}`,
    );
  }

  if (manifest.runtimeState.activationStatus === "migration_required") {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.migrationRequired,
      "CangHai consciousness requires migration before activation",
    );
  }
  if (manifest.runtimeState.activationStatus === "degraded") {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.activationDegraded,
      "CangHai consciousness is degraded and cannot be activated",
    );
  }
  if (manifest.runtimeState.activationStatus !== "active") {
    throw new ConsciousnessLoadError(
      CONSCIOUSNESS_FAILURE_CATEGORY.manifestInvalid,
      "Manifest runtimeState.activationStatus must be active before activation",
    );
  }

  requireCompatibleVersion(
    options.coreVersion,
    manifest.compatibility.stellaCore,
    CONSCIOUSNESS_FAILURE_CATEGORY.coreIncompatible,
    "Stella Core",
  );
  requireCompatibleVersion(
    options.openclawVersion,
    manifest.compatibility.openclaw,
    CONSCIOUSNESS_FAILURE_CATEGORY.hostIncompatible,
    "OpenClaw",
  );
  if (manifest.runtimeState.requiredOpenClawVersion) {
    requireCompatibleVersion(
      options.openclawVersion,
      manifest.runtimeState.requiredOpenClawVersion,
      CONSCIOUSNESS_FAILURE_CATEGORY.hostIncompatible,
      "OpenClaw runtime state",
    );
  }
}

function requireCompatibleVersion(
  version: string,
  range: string,
  category: ConsciousnessFailureCategory,
  component: string,
): void {
  if (!valid(version) || !satisfies(version, range, { includePrerelease: true })) {
    throw new ConsciousnessLoadError(
      category,
      `${component} version ${version} does not satisfy ${range}`,
    );
  }
}
