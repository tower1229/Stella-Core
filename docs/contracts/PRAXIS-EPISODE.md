# Praxis Episode Contract

## 1. Purpose

A Praxis Episode is the primary learning unit of Stella 3.0.

It captures one real-world situation across:

```text
situation
→ twin prediction
→ framework use
→ reality model
→ recommendation/action
→ actual action
→ outcome
→ retrospective evaluation
→ learning
```

It allows Stella to learn from reality instead of merely accumulating descriptions about the owner.

## 2. Lifecycle

```text
open
→ acted
→ observing
→ closed

Alternative terminal states:
abandoned / expired
```

An episode can remain open with an unknown outcome without blocking later work.

## 3. Required semantics

```ts
interface PraxisEpisode {
  schemaVersion: string;
  id: string;
  status: "open" | "acted" | "observing" | "closed" | "abandoned" | "expired";

  createdAt: string;
  updatedAt: string;

  sourceBaseline?: {
    repository: string;
    commit: string;
  };
  sourceSnapshot?: Record<string, string>;

  provenance: {
    agentId?: string;
    sessionId?: string;
    runId?: string;
    messageRefs?: string[];
  };

  situation: {
    summary: string;
    domains: string[];
    actors?: string[];
    observations: string[];
    interpretations?: string[];
    unknowns?: string[];
    goals?: string[];
    stakes?: "low" | "medium" | "high";
    reversibility?: "high" | "medium" | "low";
  };

  twin?: {
    hypothesisRefs?: string[];
    prediction?: {
      possibleActions?: Record<string, number>;
      likelyInterpretations?: string[];
      keyFactors?: string[];
    };
  };

  framework?: {
    frameworkRefs?: string[];
    operatorRefs?: string[];
  };

  reality?: {
    modes?: Array<"base_model" | "personal_praxis" | "external_research">;
    norms?: string[];
    hiddenVariables?: string[];
    likelyInterpretations?: string[];
    socialCosts?: string[];
    uncertainties?: string[];
    externalRefs?: string[];
    similarEpisodeRefs?: string[];
  };

  decision?: {
    options?: string[];
    recommendation?: string;
    rationale?: string[];
    actionGate?: "A" | "B" | "C" | "D";
  };

  actual?: {
    action?: string;
    occurredAt?: string;
    source?: "user_report" | "tool_observation" | "system_event" | "inferred";
  };

  outcome?: {
    observations?: string[];
    result?: string;
    observedAt?: string;
  };

  retrospective?: {
    endorsement?: number;
    regret?: number;
    comment?: string;
    recordedAt?: string;
  };

  learning?: {
    algorithmVersion?: "stella.praxis-learning/v1";
    predictionAssessment?: "supported" | "countered" | "unresolved";
    evidenceRefs?: string[];
    twin?: string[];
    reality?: string[];
    praxis?: string[];
    frameworkPractice?: string[];
  };
}
```

## 4. Alpha minimum

Alpha should not require every field.

A useful minimum episode is:

```text
id
status
createdAt
situation.summary
situation.domains
recommendation
Twin prediction when a meaningful choice exists
framework operator refs when used
```

Outcome and learning are appended later.

## 5. Prediction before outcome

When a meaningful user choice exists, Twin predictions must be persisted before the eventual outcome is known.

This prevents retrospective rewriting of the prediction and enables actual Twin Fidelity evaluation.

## 6. Reality source distinction

The episode records whether Reality Intelligence came from:

- base model knowledge;
- personalized historical Praxis;
- external research.

This allows later evaluation of which source improved or degraded advice.

## 7. Outcome capture

Prefer passive association from later conversation or tool events.

Explicit follow-up should be scheduled only when the episode is important enough that the value of outcome information exceeds interruption cost.

## 8. Learning

Closing an episode may produce three independent learning categories:

### Twin

What did Stella mispredict about the owner?

### Reality

What did Stella misunderstand about the external situation or other actors?

### Praxis

What strategy works better for this owner in this class of situation?

Framework practice notes are separate from changing the canonical framework source.

## 9. Recommended CangHai serialization

Human-inspectable Markdown is preferred for Alpha.

```markdown
---
schema_version: stella.praxis-episode/v1
id: praxis-...
status: open
created_at: ...
domains: [relationship]
---

# Situation
...

## Stella prediction
...

## Recommendation
...

## Actual action
<!-- managed: may be filled later -->

## Outcome
<!-- managed: may be filled later -->

## Learning
<!-- managed: may be filled later -->
```

Machine-managed sections should be deterministic enough to update without rewriting unrelated human notes.

Stella Core generated records include `sourceBaseline` and `sourceSnapshot` so derivation inputs can be checked for drift. They remain optional in schema v1 to preserve compatibility with Episode records created before managed local writes were introduced.
