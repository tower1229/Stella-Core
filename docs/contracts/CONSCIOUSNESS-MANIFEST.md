# Consciousness Manifest Contract

## 1. Purpose

The Consciousness Manifest is the deterministic bootstrap entrypoint for one Stella instance.

It answers one question:

> Given a fresh compatible OpenClaw installation and Stella Core, where is the durable owner-specific state required to reconstruct this Stella?

The manifest does not contain the whole personal model. It points to the portable CangHai representations that collectively form durable core consciousness.

## 2. Default location

Alpha uses one stable discovery path inside CangHai:

```text
50_PersonalAgent/stella/manifest.yaml
```

The path is a bootstrap locator, not the identity of any referenced object. Durable records keep stable IDs independent of filesystem paths.

A future schema version may add alternate discovery, but Alpha restoration must not depend on searching the repository heuristically.

## 3. Required semantics

```ts
interface StellaConsciousnessManifest {
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
    rebuild: Array<
      | "bootstrap_projection"
      | "memory_index"
      | "vector_index"
      | "embeddings"
      | "memory_wiki"
      | "framework_registry"
      | "praxis_index"
    >;
  };

  secrets?: {
    refs: string[];
  };

  durability?: {
    criticalWritePolicy: "sync_immediately" | "bounded_batch";
    normalWritePolicy: "sync_immediately" | "bounded_batch";
    maxNormalRpoSeconds?: number;
  };
}
```

## 4. Core-consciousness rule

A datum belongs behind the manifest when losing it during a clean redeploy would materially change how Stella:

- identifies itself or the owner;
- understands or predicts the owner;
- applies the owner's frameworks;
- uses learned personalized praxis;
- continues important durable goals, commitments, relationship models, or open real-world episodes.

This includes learned model state even when it was inferred automatically rather than manually confirmed.

## 5. What is intentionally excluded

The manifest must not depend on:

- old OpenClaw session IDs;
- raw active conversation state;
- compaction state;
- machine-local SQLite databases;
- prompt caches;
- FTS/vector index files;
- reproducible embeddings;
- transient subagent state;
- temporary per-turn state estimates.

These are rebuilt or intentionally forgotten after restore.

## 6. Active non-deterministic artifacts

If an artifact materially affects behavior and cannot be bit-deterministically reproduced from canonical personal data, its exact active representation must be portable and referenced by the manifest or a referenced registry.

Examples include:

- model-compiled active Framework IR;
- future personalized adapters/checkpoints;
- learned policy parameters that cannot be deterministically regenerated.

## 7. Secrets

The manifest records only logical secret references.

Secret values remain in an external secret system or are re-provisioned during restore. Absence of an optional secret may degrade capabilities but must not corrupt personal cognitive data.

## 8. Git revision as coherence boundary

A committed CangHai Git revision is a coherent portable recovery point.

Restore resolves the manifest and all referenced durable data from one chosen repository revision. It must not silently mix files from different revisions.

Runtime writes that are intended to survive total server loss therefore need eventual remote synchronization, not merely a local filesystem write.

## 9. Validation

Before activation, restoration validates:

1. manifest schema;
2. every required reference exists;
3. referenced records pass their own schemas where applicable;
4. active Framework IR references are resolvable;
5. compatibility constraints are satisfied or an explicit migration is available;
6. required external secrets/capabilities are either available or explicitly marked degraded;
7. the continuity suite can run.
