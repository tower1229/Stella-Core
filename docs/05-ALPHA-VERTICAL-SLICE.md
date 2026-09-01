# Stella 3.0 Alpha Vertical Slice

## 1. Goal

The Alpha is successful when Stella can learn from one real private-life decision loop end to end.

It is not a complete personal-model platform.

The first vertical slice is:

```text
real user problem
→ route as praxis
→ build situation frame
→ retrieve relevant Twin context
→ select 0-2 Framework operators
→ add Reality/Social intelligence
→ compose Praxis Context Packet
→ main OpenClaw model answers / acts
→ persist Praxis Episode
→ later detect outcome
→ update episode
→ update one Twin hypothesis or Praxis learning item
```

## 2. Non-goals

Alpha explicitly does not require:

- personal fine-tuning;
- soft prompts or KV-cache personalization;
- a global user vector;
- a complete social graph;
- a complete probabilistic state model;
- a knowledge graph rewrite of CangHai;
- multi-agent Swarm or A2A;
- full autonomous action;
- migration of all legacy RAG before runtime validation.

## 3. Runtime components

A single OpenClaw plugin, working name `stella-cortex`, contains:

```text
stella-cortex/
├── routing/       Turn classification
├── situation/     Situation Frame construction
├── twin/          Context retrieval + hypothesis prediction
├── framework/     Compiled Framework Registry + selection
├── reality/       Base / personal / external reality intelligence
├── praxis/        Packet, decision, episode, outcome
├── learning/      Prediction error and consolidation
├── canghai/       Portable personal-data persistence
└── openclaw/      Hook and tool adapters
```

These are modules, not independent long-lived agents.

Temporary subagents are allowed only for bounded tasks such as deep external research, multi-session recall, or perspective simulation.

## 4. OpenClaw integration

Alpha uses public OpenClaw plugin seams only.

| Need | OpenClaw seam |
| --- | --- |
| Route and assemble context | `before_prompt_build` |
| Optional model override | `before_model_resolve` |
| Register Twin/Framework/Praxis tools | `api.registerTool(...)` |
| Gate external action | `before_tool_call` |
| One bounded final-answer correction | `before_agent_finalize` |
| Persist run outcome / episode seed | `agent_end` |
| Observe tool outcomes | `after_tool_call` |
| Follow-up scheduling | Standing Intent / cron |

Stella Core must not fork or patch OpenClaw core unless a required capability cannot be expressed through a stable public SDK seam.

## 5. Turn modes

```ts
type CortexMode =
  | "ordinary"
  | "twin"
  | "praxis"
  | "deep_praxis"
  | "outcome";
```

### ordinary

No personal cognitive machinery is required.

### twin

The question primarily asks how the owner tends to think, choose, write, or behave.

### praxis

A real-world/private situation requires synthesis of personal context + framework + reality experience into action.

### deep_praxis

The Praxis problem additionally requires fresh external facts, high-stakes research, or bounded deep recall.

### outcome

A later observation can update an existing open Praxis Episode.

## 6. Router contract

The router does not answer the user. It produces only a compact execution plan.

```ts
interface CortexRoute {
  mode: CortexMode;
  domains: string[];
  actors?: string[];
  stakes?: "low" | "medium" | "high";
  reversibility?: "high" | "medium" | "low";
  needsTwin: boolean;
  needsFramework: boolean;
  needsReality: boolean;
  needsExternalResearch: boolean;
  candidateFrameworks?: string[];
  openEpisodeRef?: string;
}
```

Routing should use deterministic/lightweight checks first. A model router is fallback for ambiguous turns, not a mandatory extra LLM call on every message.

## 7. Situation Frame

```ts
interface SituationFrame {
  actors: string[];
  observations: string[];
  interpretations: string[];
  unknowns: string[];
  userGoals: string[];
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
    stakes: "low" | "medium" | "high";
    reversibility: "high" | "medium" | "low";
  };
}
```

Observation and interpretation must remain distinguishable so Stella can model uncertainty without treating a hypothesis as an observed fact.

## 8. Praxis Context Packet

The main model receives a compact packet, not raw personal archives.

```ts
interface PraxisContextPacket {
  mode: "praxis" | "deep_praxis";
  situation: SituationFrame;
  twin?: {
    hypothesisRefs: string[];
    relevantPatterns: string[];
    values?: string[];
    similarEpisodeRefs?: string[];
    prediction?: Record<string, number>;
  };
  framework?: {
    frameworkRefs: string[];
    operatorRefs: string[];
    failureModes?: string[];
  };
  reality?: {
    modes: Array<"base_model" | "personal_praxis" | "external_research">;
    norms?: string[];
    hiddenVariables?: string[];
    socialCosts?: string[];
    uncertainties?: string[];
    externalRefs?: string[];
  };
  openEpisodeRef?: string;
}
```

The internal packet is not the user-facing response format.

## 9. Action gates

Alpha uses four execution levels:

- **A — Auto:** reversible internal work, retrieval, organization, private records.
- **B — Prepare:** draft or stage an external action without committing it.
- **C — Confirm:** ordinary external side effects such as sending a private message or submitting a form.
- **D — Strong confirm:** high-impact, expensive, public, legally meaningful, destructive, or hard-to-reverse actions.

Action gate selection considers impact, reversibility, Stella confidence, and prior acceptance. Alpha may use conservative defaults; learned domain autonomy is future work.

## 10. Episode persistence

Every meaningful `praxis` or `deep_praxis` turn creates or updates a `PraxisEpisode`.

A meaningful choice prediction must be written before the eventual real outcome is known.

Long-term episodes are personal data and must have a portable CangHai representation. Runtime SQLite/index rows are caches and operational state only.

## 11. Outcome association

Prefer passive capture from later user messages or observed tool events.

Active follow-up is scheduled only when:

```text
importance × expected learning value > interruption cost
```

Outcome association can use episode search or bounded cross-session recall.

## 12. First learning rule

Alpha does not need a sophisticated Bayesian or neural updater.

On episode close:

1. compare persisted prediction with actual action;
2. compare reality assumptions with observed result;
3. record retrospective endorsement/regret when available;
4. append evidence to relevant Twin hypotheses;
5. create a candidate hypothesis when repeated unexplained prediction error appears;
6. record Praxis learning separately from canonical Framework source.

The update algorithm must be versioned so later versions can recompute hypothesis strength from raw episode history.

## 13. Alpha acceptance test

A single end-to-end case passes when:

1. the system correctly routes a real private-life problem to Praxis;
2. relevant legacy CangHai personal context is retrieved;
3. no more than two useful Framework operators are selected;
4. Reality adds at least one material variable the raw Twin context does not provide;
5. the final answer gives a concrete next action;
6. a valid Praxis Episode is persisted before the outcome;
7. a later outcome is associated with the episode;
8. one Twin or Praxis learning record changes because of the outcome;
9. the next comparable case can retrieve that learning.

This is the first true Stella 3.0 milestone.
