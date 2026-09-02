# CangHai 1.0 → Stella 3.0 Cold-Start Mapping

## 1. Goal

Build the first recoverable Stella 3.0 consciousness set from the existing CangHai/Stella 1.0 assets without destructive migration.

Alpha uses an additive compatibility layer:

```text
existing CangHai assets
        ↓ referenced in place
Consciousness Manifest + registries
        ↓
Stella Core compatibility adapters
        ↓
Twin / Framework / Praxis runtime
```

Do not relocate or rewrite the existing corpus merely to satisfy the new architecture.

## 2. Migration rule: reference first, re-role second, move last

For each legacy asset:

1. preserve original path and provenance;
2. assign its Stella 3.0 cognitive role;
3. reference it through a registry;
4. let Stella Core read it through a compatibility adapter;
5. only later decide whether physical relocation improves maintainability.

A path move is not an architectural milestone.

## 3. Existing asset mapping

| Existing CangHai asset | 3.0 role | Alpha handling |
| --- | --- | --- |
| `50_PersonalAgent/openclaw/workspace/SOUL.md` | identity/persona | reference directly from manifest |
| `.../IDENTITY.md` | instance identity projection | reference directly |
| `.../USER.md` | owner bootstrap projection | reference directly; not treated as full Twin |
| `.../MEMORY.md` | curated bootstrap/experience pointer | reference during compatibility period |
| `50_PersonalAgent/openclaw/openclaw.json` | legacy runtime/model configuration source | reference as transitional runtime profile; later compile a portable Stella runtime profile |
| `50_PersonalAgent/corpus-registry.yaml` | experience/corpus discovery | reference directly |
| `30_RAG/model-seed/` | Twin cold-start hypotheses + supporting evidence | derive bounded Twin Hypothesis seeds; keep source files unchanged |
| `30_RAG/self-reflection/` | Twin evidence | retrieve as supporting/counter evidence |
| `30_RAG/life-log/` | episodic personal experience | index in place |
| `30_RAG/relationship/` | social/relationship experience | index in place for relationship Praxis |
| `30_RAG/health/` | state/health experience | keep as evidence, not Alpha core domain |
| `30_RAG/work/` | work contextual-self evidence | keep for later domains |
| `30_RAG/writing/` | writing contextual-self/style evidence | keep for later domains |
| `30_RAG/frameworks/` | canonical Framework Source | register existing framework files as sources |
| `50_PersonalAgent/skills/` | legacy owner-specific behavior assets | expose through a transitional skill registry; later decide which logic belongs in generic Stella Core |
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

Do not make the Consciousness Manifest depend directly on an arbitrary historical `openclaw.json` forever.

Alpha should introduce a small portable Stella runtime profile containing only settings required to reconstruct Stella-specific cognitive behavior, for example:

```yaml
schema_version: stella.runtime-profile/v1
agent_id: stella
language: zh-CN
openclaw:
  memory_profile: builtin
  active_memory: enabled
  dreaming_role: episodic_only
models:
  main: ...
  router: ...
  framework_compiler: ...
cortex:
  alpha_domain: relationship
  max_framework_operators: 2
```

Environment-specific values, credentials, absolute paths, host ports, service configuration, and machine-local OpenClaw state do not belong here.

The legacy `openclaw.json` remains useful migration input and deployment backup, but 3.0 recovery should eventually compile host-specific OpenClaw configuration from this portable profile.

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

Alpha does not need to decide the final class for every legacy skill. The transitional registry records the current source path and restore status.

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
8. load transitional owner-specific skills registry;
9. rebuild OpenClaw runtime projections/indexes;
10. start with a fresh session.

No old session database is required.

## 12. Exit condition for the compatibility layer

The compatibility layer may be retired only when every durable cognitive dependency needed for restore has a first-class 3.0 representation or an intentionally retained canonical legacy source.

Physical migration of old archives is optional. Continuity and reconstructability are the requirement.
