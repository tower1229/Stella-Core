import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveCangHaiRef } from "./ref.js";

export const DEFAULT_MANIFEST_PATH = "50_PersonalAgent/stella/manifest.yaml";

export type StellaConsciousnessManifest = {
  schemaVersion: "stella.consciousness-manifest/v1";
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

export function parseConsciousnessManifest(input: string): StellaConsciousnessManifest {
  const parsed = parseYaml(input) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Consciousness manifest must be a YAML object");
  }

  const schemaVersion = requireString(parsed, "schemaVersion");
  if (schemaVersion !== "stella.consciousness-manifest/v1") {
    throw new Error(`Unsupported consciousness manifest schema: ${schemaVersion}`);
  }

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

  const manifest: StellaConsciousnessManifest = {
    schemaVersion: "stella.consciousness-manifest/v1",
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
  ];

  return refs.filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

export async function loadConsciousness(
  canghaiRoot: string,
  manifestPath = DEFAULT_MANIFEST_PATH,
): Promise<LoadedConsciousness> {
  const root = path.resolve(canghaiRoot);
  const absoluteManifestPath = path.resolve(root, manifestPath);
  const relativeManifestPath = path.relative(root, absoluteManifestPath);

  if (relativeManifestPath.startsWith("..") || path.isAbsolute(relativeManifestPath)) {
    throw new Error("Manifest path escapes CangHai root");
  }

  const manifestText = await readFile(absoluteManifestPath, "utf8");
  const manifest = parseConsciousnessManifest(manifestText);

  const requiredReferences: ManifestReferenceCheck[] = [];
  for (const [field, ref] of collectReferenceFields(manifest)) {
    const resolved = resolveCangHaiRef(root, ref);
    await access(resolved.absolutePath);
    requiredReferences.push({ field, ref, absolutePath: resolved.absolutePath });
  }

  return {
    canghaiRoot: root,
    manifestPath: absoluteManifestPath,
    manifest,
    requiredReferences,
  };
}
