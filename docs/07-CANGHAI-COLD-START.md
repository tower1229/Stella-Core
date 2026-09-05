# CangHai 1.0 → Stella 3.0 Cold-Start Mapping

## 1. Goal

Build the first recoverable Stella 3.0 consciousness set from the existing CangHai/Stella 1.0 assets without destructive migration.

Current mapping follows [Portable Registries](contracts/PORTABLE-REGISTRIES.md) and [Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md). Existing files can remain canonical sources; obsolete managed formats require explicit migration before activation.

Alpha uses an additive source mapping:

```text
existing CangHai assets
        ↓ referenced in place
Consciousness Manifest + registries
        ↓
Stella Core versioned source adapters
        ↓
Twin / Framework / Praxis runtime
```

Do not relocate or rewrite the existing corpus merely to satisfy the new architecture.

### Verified legacy baseline

The Stella 1.0 backup is CangHai `dev`, verified on 2026-09-05 at
`a1c2f4ec444b7d3245a7a0afea74460470a5dfc2`. The current `local/stella-alpha` branch is a
Stella Core integration test branch. Read legacy evidence from the resolved `dev` commit;
do not infer 1.0 capabilities from the current working tree.

The manifest and `30_PersonalData/` structure described below are 3.0 additions and do not exist
in that legacy commit. Migration and runtime operations still require an explicitly configured
source revision; the legacy backup branch is not automatically a runnable 3.0 recovery target.
See [the requirements alignment record](09-REQUIREMENTS-ALIGNMENT.md) for the complete distinction.

## 2. Migration rule: reference first, re-role second, move last

For each legacy asset:

1. preserve original path and provenance;
2. assign its Stella 3.0 cognitive role;
3. reference it through a registry;
4. validate its declared format through a versioned adapter; migrate obsolete managed formats explicitly;
5. only later decide whether physical relocation improves maintainability.

A path move is not an architectural milestone.

## 3. Existing asset mapping

| Existing CangHai asset | 3.0 role | Alpha handling |
| --- | --- | --- |
| `50_PersonalAgent/openclaw/workspace/SOUL.md` | identity/persona | reference directly from manifest |
| `.../IDENTITY.md` | instance identity projection | reference directly |
| `.../USER.md` | owner bootstrap projection | reference directly; not treated as full Twin |
| `.../MEMORY.md` | curated bootstrap/experience pointer | reference during compatibility period |
| `50_PersonalAgent/openclaw/openclaw.json` | legacy runtime/model configuration source | read only as migration input; derive and validate the portable runtime profile before activation |
| `50_PersonalAgent/corpus-registry.yaml` | experience/corpus discovery | reference directly |
| `30_RAG/model-seed/` | Twin cold-start hypotheses + supporting evidence | derive bounded Twin Hypothesis seeds; keep source files unchanged |
| `30_RAG/self-reflection/` | Twin evidence | retrieve as supporting/counter evidence |
| `30_RAG/life-log/` | episodic personal experience | index in place |
| `30_RAG/relationship/` | social/relationship experience | index in place for relationship Praxis |
| `30_RAG/health/` | state/health experience | keep as evidence, not Alpha core domain |
| `30_RAG/work/` | work contextual-self evidence | keep for later domains |
| `30_RAG/writing/` | writing contextual-self/style evidence | keep for later domains |
| `30_RAG/frameworks/` | canonical Framework Source | register existing framework files as sources |
| `50_PersonalAgent/skills/` | legacy owner-specific behavior assets | classify and map to the current skill contract before enabling; retain private behavior in CangHai |
| existing Stella evals | continuity/regression seed | reuse privately where owner facts are involved |

## 4. New additive CangHai bootstrap structure

Alpha adds a small 3.0 control surface without moving legacy content:

```text
50_PersonalAgent/
└── stella/
    ├── manifest.yaml
    ├── runtime-profile.yaml
    ├── skills-registry.yaml
    ├── frameworks/
    │   ├── source-registry.yaml
    │   └── active-ir-registry.yaml
    ├── twin/
    │   └── hypotheses-registry.yaml
    └── continuity/
        └── suite.yaml

30_PersonalData/
├── twin/
│   └── hypotheses/
├── praxis/
│   ├── episodes/
│   └── playbook/
└── framework-runtime/
    └── active-ir/
```

The `50_PersonalAgent/stella/` tree is configuration/discovery metadata.

The `30_PersonalData/` tree contains new durable owner-specific learning produced by Stella 3.0.

Existing `30_RAG/` remains valid and is not duplicated.

## 5. Consciousness Manifest initial references

The initial manifest should point to:

```yaml
identity:
  soulRef: path:50_PersonalAgent/openclaw/workspace/SOUL.md
  identityRef: path:50_PersonalAgent/openclaw/workspace/IDENTITY.md
  userProfileRef: path:50_PersonalAgent/openclaw/workspace/USER.md
  runtimeProfileRef: path:50_PersonalAgent/stella/runtime-profile.yaml

experience:
  corpusRegistryRef: path:50_PersonalAgent/corpus-registry.yaml

frameworks:
  sourceRegistryRef: path:50_PersonalAgent/stella/frameworks/source-registry.yaml
  activeIrRegistryRef: path:50_PersonalAgent/stella/frameworks/active-ir-registry.yaml

twin:
  hypothesisRegistryRef: path:50_PersonalAgent/stella/twin/hypotheses-registry.yaml

praxis:
  episodeRootRef: path:30_PersonalData/praxis/episodes
  playbookRegistryRef: path:30_PersonalData/praxis/playbook/registry.yaml

extensions:
  skillRegistryRef: path:50_PersonalAgent/stella/skills-registry.yaml
```

## 6. Runtime profile separation

The only authoritative profile is identity.runtimeProfileRef, using the complete field contract in
[Portable Registries](contracts/PORTABLE-REGISTRIES.md#3-runtime-profile). Required fields include
language, timezone, contract profile, model roles, capability adapters, source policies and autonomy.
Use actual instance values and external SecretRefs; placeholder models and undeclared capabilities
cannot pass activation.

The legacy openclaw.json is migration evidence and a deployment backup, not a second active Stella
profile. Derive the portable non-secret profile explicitly, then generate Host configuration from it.
Machine paths, ports, credentials and old runtime state do not become personal cognition. Optional
unavailable capabilities and a blocked activation state are distinct.

## 7. Framework cold start

Do not compile every framework for Alpha.

Start with a small operator set extracted from the existing canonical framework corpus. The first relationship/social Praxis build should prioritize cognitive jobs such as:

- observation vs interpretation separation;
- condition/dependent-origination analysis;
- direct-experience / smallest-real-world-test check;
- anti-certainty / competing-explanation check;
- proportionality and boundary translation where supported by owner-authored sources.

For each activated operator:

```text
existing source
→ versioned compiler
→ Framework IR
→ validate
→ persist exact active IR in CangHai
→ register active IR
```

The exact active IR is portable because model compilation is not assumed deterministic.

## 8. Twin cold start

Do not transform the full personal-model seed into one large Twin record.

Extract only hypotheses that can make useful contextual predictions.

Alpha target: roughly 5–10 relationship/social hypotheses, each with:

- contextual scope;
- prediction target;
- initial strength;
- source references;
- explicit counterevidence when already available.

Examples of acceptable hypothesis forms are structural, not owner-specific content:

> Under high interpersonal uncertainty, the owner may prefer additional analysis before acting.

> When an action feels socially performative rather than sincere, acceptance probability may drop.

These are seeds. Future Praxis outcomes determine whether they strengthen, narrow, split, or retire.

## 9. Legacy skill mapping

Existing Stella skills fall into three migration classes:

### Class A — Generic Stella Core behavior

Logic that is broadly part of the Stella 3.0 product architecture should eventually move into Stella Core runtime modules.

Examples may include generic Praxis routing, Twin handling, framework selection, and outcome recording.

### Class B — Owner-specific behavior asset

A skill that encodes owner-specific preferences, workflows, data sources, or private operating conventions remains portable in CangHai and is referenced by the skill registry.

### Class C — External/integration capability

Skills primarily wrapping external services or one-off operational tooling remain separate capabilities and are restored only when dependencies are available.

The canonical class values are core_behavior, owner_behavior and integration. Inactive legacy assets may remain unmapped evidence, but every enabled skill must have a valid class, source, policy and capability declaration. Old save-confirmation rules and current owner authorization must be reconciled before execution; unknown or conflicting instructions cannot be activated unchanged.

## 10. New personal learning writes

Stella 3.0 must not write new Twin/Praxis learning back into legacy `model-seed/` or unrelated `30_RAG` files.

New learning goes to new managed 3.0 locations:

```text
30_PersonalData/twin/hypotheses/
30_PersonalData/praxis/episodes/
30_PersonalData/praxis/playbook/
30_PersonalData/framework-runtime/active-ir/
```

This creates a clean boundary:

```text
legacy 1.0 corpus = cold-start evidence
3.0 managed data  = continuously learned consciousness
```

## 11. Restore behavior during transition

A fresh restore during Alpha should:

1. load the manifest;
2. load identity/bootstrap files from their existing locations;
3. load the existing corpus registry;
4. load 3.0 Twin seed registry and records;
5. load canonical framework sources from existing `30_RAG/frameworks/` paths;
6. load exact active IR from new 3.0 managed storage;
7. load Praxis episodes/playbook from new storage;
8. validate the current owner-specific skills registry, policy and dependencies;
9. rebuild OpenClaw runtime projections/indexes;
10. start with a fresh session.

No old session database is required. Empty registries are legal; declared dependencies are mandatory.
Episode v1, unversioned registries and old profiles require the explicit migrations in their contracts.
Raw legacy source files need not change merely because their discovery metadata is upgraded.

## 12. Completion of source mapping

Source mapping is complete when every declared durable dependency has a validated current representation or an intentionally retained canonical legacy source readable through the declared adapter. There is one current managed format per contract; obsolete format fallback and parallel writes do not satisfy migration.

Physical migration of old archives is optional. Continuity and reconstructability are the requirement.
