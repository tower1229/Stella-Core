import { loadConsciousness, type LoadedConsciousness } from "../canghai/manifest.js";
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
  rebuildEvidence: DerivedRebuildEvidence[];
  continuityEvidence: string[];
};

function requireBootstrapCategory(
  loaded: LoadedConsciousness,
  category: "identity" | "twin" | "framework",
): void {
  if (!loaded.bootstrapDocuments.some((document) => document.category === category)) {
    throw new Error(`Recovery Level 1 is missing ${category} bootstrap state`);
  }
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
  if (memory.openEpisodes.length === 0) {
    throw new Error("Recovery Level 1 is missing important open Praxis state");
  }

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
    rebuildEvidence,
    continuityEvidence: continuity.evidence,
  };
}
