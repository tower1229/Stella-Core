# Stella 3.0 Architecture

## 1. System view

```text
                         ┌──────────────────────┐
                         │    Personal Twin     │
                         │  how the owner works │
                         └──────────┬───────────┘
                                    │
                                    ▼
┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ Framework Compiler  │──▶│     Praxis Loop      │◀──│ Reality / Social    │
│ how the owner judges│   │ what to do in reality│   │ how the world works │
└─────────────────────┘   └──────────┬───────────┘   └─────────────────────┘
                                    │
                                    ▼
                              Action / Outcome
                                    │
                                    ▼
                            Continuous Learning
```

## 2. Runtime architecture

Stella 3.0 is implemented as one OpenClaw runtime plugin, provisionally named `stella-cortex`.

```text
OpenClaw Agent Loop
        │
        ▼
┌──────────────────────────────────────────┐
│              Stella Cortex              │
│                                          │
│ Turn Router                              │
│ Situation Builder                        │
│ Twin Context Builder                     │
│ Framework Runtime                        │
│ Reality Intelligence                     │
│ Praxis Controller                        │
│ Learning Recorder / Consolidator         │
└───────────────────┬──────────────────────┘
                    │
         ┌──────────┼────────────┐
         ▼          ▼            ▼
      CangHai   OpenClaw Memory  External Reality
```

OpenClaw remains responsible for the generic agent loop, sessions, transcripts, compaction, tool execution, channels, automations, permissions, and low-level memory infrastructure.

Stella Cortex owns the personal cognitive behavior layered on top.

## 3. Consciousness portability invariant

Stella Core is a replaceable runtime implementation. CangHai is the portable carrier of Stella's durable personal consciousness.

The required recovery property is:

```text
fresh server
+ compatible OpenClaw
+ Stella Core
+ CangHai personal data and Stella configuration
→ rebuild indexes / projections / runtime caches
→ restore Stella's core consciousness
```

Recovery does **not** require old OpenClaw sessions, transcripts, SQLite runtime databases, prompt caches, or other machine-local execution state.

“Core consciousness” means the durable information that changes how a fresh Stella instance understands the owner, reasons from the owner's frameworks, predicts behavior, and applies learned praxis. It includes at least:

- identity/persona and stable interaction configuration;
- owner-authored frameworks and the exact active operational representation when needed for reproducibility;
- durable Twin hypotheses and model state;
- durable relationship/interaction models;
- Praxis episodes, outcomes, learned strategies, and open high-value episodes that should survive a restart;
- durable goals, commitments, or state that materially affects future behavior;
- Stella-specific runtime profile/configuration required to reconstruct the same cognitive behavior.

Transient working context is not part of core consciousness. Examples include:

- active chat sessions and raw conversational continuity that has not been promoted to durable personal data;
- prompt assembly state;
- temporary inferred mood/state estimates;
- FTS/vector indexes and reproducible embeddings;
- execution traces and temporary subagent results.

The architecture must be tested against destructive runtime loss: deleting the Stella/OpenClaw runtime host must not destroy any durable learning that is necessary to reconstruct Stella's identity and learned behavior.

## 4. Data planes

### Stella-Core

Public runtime, schemas, compiler logic, evaluation harness, and architecture.

It must contain no copied private personal corpus.

### CangHai

Portable Personal Data Plane and durable consciousness store.

Anything that has durable influence over how Stella understands, predicts, advises, or acts for the owner must have a portable representation in CangHai.

Examples:

- personal experiences;
- framework sources;
- Twin hypotheses;
- important relationship models;
- Praxis episodes and outcomes;
- learned personalized strategies;
- durable goals/open loops that must survive runtime loss;
- Stella instance configuration and portable runtime profile;
- evaluation history and model checkpoints when portability requires them.

### OpenClaw runtime state

Rebuildable execution state:

- SQLite runtime state;
- search indexes;
- FTS/vector indexes;
- embeddings where reproducible;
- prompt state;
- temporary inferred state;
- execution traces;
- active sessions.

These do not automatically belong in CangHai.

## 5. Four cognitive systems

### Personal Twin

Maintains context-relevant hypotheses and predictions rather than a static biography.

It eventually includes:

- stable self;
- contextual selves;
- dynamic state estimation;
- behavioral policy;
- prediction ledger.

Alpha does not require fine-tuning. Retrieval + structured hypotheses + prediction/outcome data are sufficient.

### Framework Compiler

Compiles owner-authored thinking frameworks into executable operators.

Separates:

1. canonical framework source;
2. derived Framework IR;
3. learned Praxis notes about applying the framework.

### Reality / Social Intelligence

Combines three sources:

1. base-model world knowledge;
2. live external grounding where current/specific facts matter;
3. personalized Praxis experience accumulated from real outcomes.

Its purpose is to supply experience the owner does not yet have, not to redefine the owner's values.

### Praxis Loop

The primary product loop:

```text
Situation
→ Twin
→ Framework
→ Reality
→ option simulation
→ action/advice
→ outcome
→ learning
```

## 6. Why one Cortex instead of four agents

Persistent independent agents would each develop partial views of the owner and create coordination drift.

The four systems instead share one turn context and one owner model. Temporary subagents are allowed only for bounded work such as:

- external reality research;
- multi-perspective simulation;
- deep cross-session recall.

Subagents receive the minimum brief required for their task rather than the full Personal Twin.
