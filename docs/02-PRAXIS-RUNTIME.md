# Praxis Runtime Protocol

## 1. Turn lanes

Each user turn is routed into one of five modes:

```ts
type CortexMode =
  | "ordinary"
  | "twin"
  | "praxis"
  | "deep_praxis"
  | "outcome";
```

### ordinary

Generic knowledge or execution that does not benefit from personal context.

### twin

Questions whose value depends primarily on understanding the owner.

### praxis

A real-world decision or action where personal context, the owner's framework, and broader world/social experience should be combined.

### deep_praxis

Praxis that requires current or specialized external research, high-stakes grounding, or bounded deep recall.

### outcome

A follow-up that appears to report what happened after an earlier Praxis episode.

## 2. Full Praxis flow

```text
User Message
   ↓
1. Cortex Route
   ↓
2. Situation Frame
   ↓
3. Twin Recall + Prediction
   ↓
4. Framework Select
   ↓
5. Reality Need Check
   ↓
6. Praxis Context Packet
   ↓
7. Main Model Reasoning / Tools
   ↓
8. Action Gate
   ↓
9. Finalization Guard
   ↓
10. Episode / Outcome Learning
```

Not every turn executes every step. `ordinary` should bypass almost all Cortex work.

## 3. Cortex Route

Use deterministic or lightweight classification first. Call a routing model only when the lane is ambiguous.

Minimal route output:

```json
{
  "mode": "praxis",
  "domains": ["relationship"],
  "actors": ["self", "person:x"],
  "stakes": "medium",
  "reversibility": "high",
  "needsTwin": true,
  "needsFramework": true,
  "needsReality": true,
  "needsExternalResearch": false,
  "candidateFrameworks": ["dependent-origination"],
  "openEpisode": null
}
```

The router never answers the user.

## 4. Situation Frame

The Situation Builder separates observed facts from interpretation.

```ts
interface SituationFrame {
  actors: ActorRef[];
  observations: string[];
  interpretations: string[];
  unknowns: string[];
  userGoals: GoalHypothesis[];
  constraints: string[];
  socialContext?: {
    relationshipStage?: string;
    powerRelation?: string;
    reciprocity?: string;
    intimacy?: string;
    ambiguity?: string;
  };
  decision?: {
    options?: string[];
    reversibility: "high" | "medium" | "low";
    stakes: "low" | "medium" | "high";
  };
}
```

## 5. Twin Context

Twin recall returns only hypotheses relevant to the current situation.

It must not emit a full personality profile by default.

Typical result:

```yaml
relevant_patterns:
  - ref: twin.pattern.analysis-under-uncertainty
    relevance: high
    strength: 0.68
relevant_values:
  - sincerity
  - dignity
similar_episodes:
  - praxis:2026-001
state:
  action_readiness: 0.42
```

Important decisions should generate a pre-outcome prediction so the Twin can be evaluated rather than post-hoc rationalized.

## 6. Framework selection

Select the minimum sufficient set of cognitive operators, normally zero to two.

Selection is based on cognitive job, not philosophical similarity.

Framework sources are compiled offline into Framework IR; runtime should not retrieve a long philosophy document on every turn.

## 7. Reality Intelligence

Three levels:

1. Base world model — generic human/social knowledge already available to the model.
2. Personalized Praxis memory — similar previous episodes and learned playbook items.
3. External research — current law, policy, medicine, finance, institutions, local conventions, or other facts requiring grounding.

External research subagents receive a sanitized Situation Brief, not the full Personal Twin.

## 8. Praxis Context Packet

The main model receives a compact structured packet rather than raw corpora.

```json
{
  "mode": "praxis",
  "situation": {},
  "twin": {
    "relevantPatterns": [],
    "values": [],
    "similarEpisodes": [],
    "state": {}
  },
  "framework": {
    "operators": [],
    "failureModes": []
  },
  "reality": {
    "norms": [],
    "hiddenVariables": [],
    "socialCosts": [],
    "uncertainties": []
  }
}
```

The internal packet is normally invisible to the user. Stella should reply naturally unless showing the internal disagreement itself is useful.

## 9. Option simulation

The main model should internally consider:

1. what the owner is naturally likely to do;
2. what a more experienced actor might notice or do;
3. what action best expresses the owner's framework in this reality.

The best result may be a fourth option that preserves the owner's principle while improving real-world execution.

## 10. Action Gate

Action authority depends on impact, reversibility, model confidence, and historical acceptance—not on a universal “all actions require approval” rule.

Suggested starting levels:

- A: automatic low-impact/reversible preparation or internal action;
- B: prepare but do not send/commit externally;
- C: ask before externally consequential action;
- D: strong confirmation for irreversible/high-impact action.

Autonomy can later become domain-specific and learned from acceptance and regret data.

## 11. Finalization Guard

Use one bounded revision only for structural failure—for example, a Praxis turn that ends without a concrete next action when the user asked what to do.

Do not perform a second complete personality analysis during finalization.

## 12. Episode creation and outcome capture

Every meaningful `praxis` or `deep_praxis` turn creates an open Praxis Episode.

Follow-up outcomes are captured passively when possible. Only high-value open episodes should schedule explicit follow-up via Standing Intent or automation.

Outcome updates create three possible learning signals:

- Twin learning — prediction error about the owner;
- Reality learning — error about how the situation/world worked;
- Praxis learning — improved personalized strategy for combining owner + framework + reality.
