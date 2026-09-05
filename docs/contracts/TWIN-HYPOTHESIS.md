# Twin Hypothesis Contract

Current authority: [Design baseline](../10-DESIGN-BASELINE.md). This record implements scoped Twin
understanding within [interaction learning](MEMORY-LIFECYCLE.md#4-交互学习), not a second memory controller.

## 1. Purpose

A Twin Hypothesis is a testable, context-scoped prediction model about how the owner tends to perceive, interpret, prefer, decide, express, or act.

It is not a permanent personality label and does not require prior user confirmation to exist.

The hypothesis earns or loses strength through evidence and prediction outcomes.

## 2. Required semantics

```ts
interface TwinHypothesis {
  schemaVersion: "stella.twin-hypothesis/v1";
  id: string;
  status: "candidate" | "active" | "weakened" | "retired";

  statement: string;

  scope: {
    domains?: string[];
    contexts?: string[];
    roles?: string[];
    actors?: string[];
  };

  predicts: Array<
    | "interpretation"
    | "preference"
    | "choice"
    | "action"
    | "expression"
    | "state_transition"
  >;

  strength: number;

  supportingRefs: string[];
  counterRefs: string[];

  sourceBaseline?: { repository: string; branch?: string; commit: string };
  sourceSnapshot?: Record<string, string>;

  stats?: {
    predictions?: number;
    correct?: number;
    incorrect?: number;
    unresolved?: number;
  };

  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;

  supersedes?: string[];
  derivedFrom?: string[];
}
```

## 3. Strength semantics

`strength` is a model belief weight in `[0,1]` used for ranking/calibration.

It is not a claim that psychology can be measured to objective probability precision.

The update algorithm must be versioned separately from the record so the owner can re-evaluate all hypotheses under a new algorithm.

Each update is a LearningChange with input versions, independent evidence identities, old/new strength,
scope and a structured LLM explanation. Deterministic validation enforces bounds and deduplication;
fixed lexical or unexplained additive scoring cannot replace semantic judgment. No supported update
is a valid no_change result. Alpha may demonstrate Praxis learning instead of changing a Twin.

## 4. Scope is mandatory in meaning

A hypothesis should be as contextual as evidence allows.

Prefer:

> Under high relational uncertainty, the owner often continues analysis to reduce action risk.

Over:

> The owner is an overthinker.

A contextual hypothesis may later generalize if evidence across domains supports it.

At least one scope collection must be nonempty. A global claim must be explicit in the normalized
Understanding metadata and supported by evidence; an empty v1 scope cannot silently mean global.

## 5. Evidence

References may point to:

- experience records;
- self-reflection sources;
- conversation archives;
- Praxis episodes;
- explicit user corrections;
- evaluation runs.

Supporting and counter evidence are both first-class.

## 6. Prediction linkage

Important decisions should record which hypotheses contributed to a prediction.

When the outcome is known, the episode updates hypothesis evaluation statistics.

Only supported, uniquely identified prediction/outcome evidence contributes. Reprocessing the same
event does not increment statistics twice. Explicit correction can revise the applicable Twin before
an action Episode closes; scoped statements and broader hypotheses remain distinct.

This makes the Twin falsifiable through behavior rather than merely plausible in prose.

## 7. User correction

Explicit correction is a strong supervision event. It may:

- sharply reduce strength;
- narrow scope;
- create a competing hypothesis;
- retire a hypothesis.

It does not require deleting historical evidence.

Historical predictions retain the exact hypothesis version they used. Updating this record must not
invalidate their sealed content. Current eligibility and source removal follow Memory Lifecycle;
removed evidence cannot be revived from an old Twin, summary or repository version.

## 8. Alpha serialization

Recommended CangHai representation:

The v1 Markdown fields normalize to camelCase. source_baseline, source_snapshot, last_tested_at and
derived_from normalize correspondingly. A source snapshot records derivation history, not permission
to require all future source bytes to remain unchanged. New string evidence references use
mem:<percent-encoded-id>@sha256:<64-hex>, resolving to the same { id, version } as Memory Lifecycle.
Existing path inputs are explicitly mapped during migration, never treated as stable evidence identity.

statement is the nonempty text under the single Hypothesis heading and before the next heading;
Notes are human annotations. Duplicate Hypothesis sections or conflicting frontmatter/body statements
fail validation. New machine-managed JSON records use the schema's camelCase keys directly.

```markdown
---
schema_version: stella.twin-hypothesis/v1
id: twin-hypothesis-...
status: active
scope:
  domains: [relationship]
predicts: [action, interpretation]
strength: 0.68
supporting_refs:
  - mem:evidence_example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
counter_refs: []
created_at: ...
updated_at: ...
---

# Hypothesis

Under ...

## Notes

Human-readable interpretation and important caveats.
```
