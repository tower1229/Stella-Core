import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConsciousness, type LoadedConsciousness } from "../canghai/manifest.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import {
  CangHaiPraxisEpisodeStore,
  type PraxisMemory,
} from "../praxis/episode-store.js";

export type DerivedRebuildEvidence = {
  target: string;
  evidence: string;
};

export type ContinuityProbeInput = {
  loaded: LoadedConsciousness;
  memory: PraxisMemory;
  rebuildEvidence: DerivedRebuildEvidence[];
};

export type ContinuityProbeResult = {
  accepted: boolean;
  evidence: string[];
};

export type RecoveryDrillOptions = {
  canghaiRoot: string;
  recoveryRevision: string;
  coreVersion: string;
  hostVersion: string;
  rebuild: (target: string, loaded: LoadedConsciousness) => Promise<DerivedRebuildEvidence>;
  verifyContinuity: (input: ContinuityProbeInput) => Promise<ContinuityProbeResult>;
};

export type RecoveryDrillReport = {
  schemaVersion: "stella.recovery-drill/v1";
  recoveryRevision: string;
  levels: {
    dataReadable: true;
    cognitiveBootstrapRestored: true;
    derivedRuntimeRebuilt: true;
    continuityAccepted: true;
  };
  restored: {
    identity: true;
    framework: true;
    twin: true;
    praxisLearning: true;
    importantOpenState: true;
  };
  structuralEvidence: {
    instanceId: string;
    identityRefs: string[];
    twinRefs: string[];
    frameworkRefs: string[];
    praxisLearningRefs: string[];
    openEpisodeRefs: string[];
    durableState:
      | { status: "not_declared" }
      | {
        status: "restored";
        records: Array<{ field: string; ref: string; blobSha: string }>;
      };
    continuitySuiteRef?: string;
  };
  rebuildEvidence: DerivedRebuildEvidence[];
  continuityEvidence: string[];
};

const execFileAsync = promisify(execFile);

function requireBootstrapCategory(
  loaded: LoadedConsciousness,
  category: "identity" | "twin" | "framework",
): void {
  if (!loaded.bootstrapDocuments.some((document) => document.category === category)) {
    throw new Error(`Recovery Level 1 is missing ${category} bootstrap state`);
  }
}

function referenceRefs(loaded: LoadedConsciousness, fieldPrefix: string): string[] {
  return loaded.requiredReferences
    .filter(({ field }) => field === fieldPrefix || field.startsWith(`${fieldPrefix}.`))
    .map(({ ref }) => ref);
}

async function collectDurableStateEvidence(
  loaded: LoadedConsciousness,
  recoveryRevision: string,
): Promise<RecoveryDrillReport["structuralEvidence"]["durableState"]> {
  const checks = loaded.requiredReferences.filter(
    ({ field }) => field === "durableState" || field.startsWith("durableState."),
  );
  if (checks.length === 0) return { status: "not_declared" };

  const records = await Promise.all(checks.map(async ({ field, ref }) => {
    const relativePath = parseCangHaiRef(ref).relativePath;
    const { stdout } = await execFileAsync("git", [
      "-C",
      loaded.canghaiRoot,
      "rev-parse",
      `${recoveryRevision}:${relativePath}`,
    ]);
    const blobSha = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(blobSha)) {
      throw new Error(`Recovery Level 1 could not identify durable state ${field}`);
    }
    return { field, ref, blobSha };
  }));
  return { status: "restored", records };
}

export async function runRecoveryDrill(
  options: RecoveryDrillOptions,
): Promise<RecoveryDrillReport> {
  const loaded = await loadConsciousness(options.canghaiRoot, undefined, {
    recoveryRevision: options.recoveryRevision,
    coreVersion: options.coreVersion,
    openclawVersion: options.hostVersion,
    dataMode: "read_only",
  });
  requireBootstrapCategory(loaded, "identity");
  requireBootstrapCategory(loaded, "twin");
  requireBootstrapCategory(loaded, "framework");

  const memory = await new CangHaiPraxisEpisodeStore({
    loaded,
    dataMode: "read_only",
  }).listMemory();
  if (memory.learningItems.length === 0) {
    throw new Error("Recovery Level 1 is missing durable Praxis learning");
  }
  const importantOpenEpisodes = memory.openEpisodes.filter(
    ({ recoveryPriority }) => recoveryPriority === "important",
  );
  if (importantOpenEpisodes.length === 0) {
    throw new Error("Recovery Level 1 is missing important open Praxis state");
  }
  if (!loaded.manifest.compatibility.modelPolicyRef) {
    throw new Error("Recovery Level 1 is missing the runtime model policy reference");
  }
  const identityRefs = loaded.bootstrapDocuments
    .filter(({ category }) => category === "identity")
    .map(({ ref }) => ref);
  const twinRefs = loaded.bootstrapDocuments
    .filter(({ category }) => category === "twin")
    .map(({ ref }) => ref);
  const frameworkRefs = loaded.bootstrapDocuments
    .filter(({ category }) => category === "framework")
    .map(({ ref }) => ref);
  const durableState = await collectDurableStateEvidence(loaded, options.recoveryRevision);

  const rebuildEvidence: DerivedRebuildEvidence[] = [];
  for (const target of loaded.manifest.derived.rebuild) {
    const evidence = await options.rebuild(target, loaded);
    if (evidence.target !== target || !evidence.evidence.trim()) {
      throw new Error(`Derived rebuild ${target} did not provide matching evidence`);
    }
    rebuildEvidence.push(evidence);
  }

  const continuity = await options.verifyContinuity({ loaded, memory, rebuildEvidence });
  if (
    !continuity.accepted ||
    continuity.evidence.length === 0 ||
    continuity.evidence.some((entry) => !entry.trim())
  ) {
    throw new Error("Recovery Level 3 continuity verification failed");
  }

  return {
    schemaVersion: "stella.recovery-drill/v1",
    recoveryRevision: options.recoveryRevision,
    levels: {
      dataReadable: true,
      cognitiveBootstrapRestored: true,
      derivedRuntimeRebuilt: true,
      continuityAccepted: true,
    },
    restored: {
      identity: true,
      framework: true,
      twin: true,
      praxisLearning: true,
      importantOpenState: true,
    },
    structuralEvidence: {
      instanceId: loaded.manifest.instance.id,
      identityRefs,
      twinRefs,
      frameworkRefs,
      praxisLearningRefs: memory.learningItems.map(({ ref }) => ref),
      openEpisodeRefs: importantOpenEpisodes.map(({ ref }) => ref),
      durableState,
      ...(loaded.manifest.evaluation?.continuitySuiteRef
        ? { continuitySuiteRef: loaded.manifest.evaluation.continuitySuiteRef }
        : {}),
    },
    rebuildEvidence,
    continuityEvidence: continuity.evidence,
  };
}
