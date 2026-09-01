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

## 3. Data planes

### Stella-Core

Public runtime, schemas, compiler logic, evaluation harness, and architecture.

It must contain no copied private personal corpus.

### CangHai

Portable Personal Data Plane.

Anything that has durable influence over how Stella understands, predicts, advises, or acts for the owner must have a portable representation in CangHai.

Examples:

- personal experiences;
- framework sources;
- Twin hypotheses;
- important relationship models;
- Praxis episodes and outcomes;
- learned personalized strategies;
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

## 4. Four cognitive systems

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

## 5. Why one Cortex instead of four agents

Persistent independent agents would each develop partial views of the owner and create coordination drift.

The four systems instead share one turn context and one owner model. Temporary subagents are allowed only for bounded work such as:

- external reality research;
- multi-perspective simulation;
- deep cross-session recall.

Subagents receive the minimum brief required for their task rather than the full Personal Twin.
