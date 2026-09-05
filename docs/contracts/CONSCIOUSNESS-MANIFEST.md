# Consciousness Manifest Contract

Current authority: [Design baseline](../10-DESIGN-BASELINE.md). Registry payloads, runtime profile,
capabilities and migration are defined in [Portable Registries](PORTABLE-REGISTRIES.md).
The v1 schema checks structure; the activation invariants below are also mandatory.

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

  runtimeState: {
    activationStatus: "active" | "migration_required" | "degraded";
    observedOpenClawConfigVersion?: string;
    observedOpenClawConfigBlobSha?: string;
    requiredOpenClawVersion?: string;
    runtimeProfileRef?: string;
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
    authorityClass?: "derived_falsifiable_model";
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

  authority?: {
    currentExplicitUserStatementPrecedence?: boolean;
    derivedRuntimeMayWriteAuthority?: boolean;
    sourceUsagePolicyRequiredBeforeDerivation?: boolean;
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
    criticalWritePolicy?: "sync_immediately" | "bounded_batch";
    normalWritePolicy?: "sync_immediately" | "bounded_batch";
    maxNormalRpoSeconds?: number;
  };
  notes?: string[];
}
```

## 4. Core-consciousness rule

A datum belongs behind the manifest when losing it during a clean redeploy would materially change how Stella:

- identifies itself or the owner;
- understands or predicts the owner;
- applies the owner's frameworks;
- uses learned personalized praxis;
- continues important durable goals, commitments, relationship models, or open real-world episodes;
- behaves because of owner-specific skills, capability policies, or custom tool configuration that are not already part of the portable Stella Core release.

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

## 7. Portable behavior assets

Owner-specific skills and capability policy need a portable reference when they are not shipped as part of Stella Core itself.

This distinction is deliberate:

```text
Stella-Core built-in behavior = code/release artifact
owner-specific behavior       = CangHai portable asset
```

During the Stella 1.0 → 3.0 transition, existing CangHai skills may be restored through the `extensions` registry even if some later move into generic Stella Core modules.

## 8. Secrets

The manifest records only logical secret references.

Secret values remain external or are re-provisioned. Required secrets/capabilities must be available
for the selected profile or activation fails. Optional capability availability is reported separately;
it does not permit running an instance marked degraded. A later request needing that capability
must fail explicitly when it is unavailable.

## 9. Git revision as coherence boundary

A committed CangHai Git revision is a coherent portable recovery point.

The configured recovery revision is distinct from `sourceBaseline`. The former names the exact clean checkout activated for this run; the latter records derivation provenance and may legitimately remain older after durable learning creates later recovery revisions.

Restore resolves the manifest and all referenced durable data from one chosen repository revision. It must not silently mix files from different revisions.

Runtime writes that are intended to survive total server loss therefore need eventual remote synchronization, not merely a local filesystem write.

## 10. Validation

Before activation, restoration validates:

1. manifest schema;
2. every required reference exists;
3. referenced records pass their own schemas where applicable;
4. active Framework IR references are resolvable;
5. portable behavior assets are resolvable when declared;
6. compatibility constraints are satisfied or an explicit migration is available;
7. required external secrets/capabilities are available; optional unavailable capabilities are reported separately;
8. the continuity suite can run.

For read-only Alpha activation, validation is fail closed: the checkout must be clean at the explicitly configured 40-character recovery SHA, the Core and Host versions must satisfy their declared ranges, and `runtimeState.activationStatus` must be `active`. `migration_required` and `degraded` are not runnable target-agent states.

The same rule applies to writable profiles. identity.runtimeProfileRef is authoritative; its optional
runtimeState duplicate must resolve to identical content. Managed durability requires both policies
explicitly configured, critical sync_immediately, and an explicit nonnegative RPO for normal batching.

Authority settings cannot override product invariants: effective currentExplicitUserStatementPrecedence
is true, derivedRuntimeMayWriteAuthority is false, and sourceUsagePolicyRequiredBeforeDerivation is true.
Missing values use these invariants; contradictory configured values fail validation.

Full memory is discovered through corpus registry memory_catalog_ref. Declared OngoingWork and catalog
work entries must match. Restore validates exact declared contents, including legitimate empty sets.
Historical pins verify historical integrity; current eligibility follows [source synchronization](MEMORY-LIFECYCLE.md#5-来源变更同步).
