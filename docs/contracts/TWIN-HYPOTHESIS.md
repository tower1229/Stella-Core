# Twin Hypothesis Contract

## 1. Purpose

A Twin Hypothesis is a testable, context-scoped prediction model about how the owner tends to perceive, interpret, prefer, decide, express, or act.

It is not a permanent personality label and does not require prior user confirmation to exist.

The hypothesis earns or loses strength through evidence and prediction outcomes.

## 2. Required semantics

```ts
interface TwinHypothesis {
  schemaVersion: string;
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

## 4. Scope is mandatory in meaning

A hypothesis should be as contextual as evidence allows.

Prefer:

> Under high relational uncertainty, the owner often continues analysis to reduce action risk.

Over:

> The owner is an overthinker.

A contextual hypothesis may later generalize if evidence across domains supports it.

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

This makes the Twin falsifiable through behavior rather than merely plausible in prose.

## 7. User correction

Explicit correction is a strong supervision event. It may:

- sharply reduce strength;
- narrow scope;
- create a competing hypothesis;
- retire a hypothesis.

It does not require deleting historical evidence.

## 8. Alpha serialization

Recommended CangHai representation:

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
  - praxis:...
counter_refs: []
created_at: ...
updated_at: ...
---

# Hypothesis

Under ...

## Notes

Human-readable interpretation and important caveats.
```
