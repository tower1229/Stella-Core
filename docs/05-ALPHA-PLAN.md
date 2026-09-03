# Stella 3.0 Alpha Plan

## 1. Alpha objective

Prove one closed Praxis learning loop on top of OpenClaw without requiring a trained personal model or a complete CangHai migration.

A successful Alpha can:

```text
real private-life question
→ route as Praxis
→ recall relevant owner context
→ select framework operators
→ add reality/social intelligence
→ produce one concrete action
→ persist a Praxis Episode
→ associate a later outcome
→ update one Twin Hypothesis or Praxis strategy
```

If this loop works reliably, Stella 3.0 exists as a product architecture.

## 2. Minimal runtime components

Implement only:

1. Turn Router
2. Situation Builder
3. Twin Context Builder
4. Framework Registry/Selector
5. Reality Need Check
6. Praxis Packet Builder
7. Episode Recorder / Outcome Matcher
8. lightweight Learning Updater

OpenClaw continues to provide the Agent Loop, model call, tools, sessions, memory, approvals, and scheduling.

## 3. Contract hardening before code

Before generating JSON Schema, settle four points.

### 3.1 Stable identity

Recommended Alpha format:

```text
praxis_<ULID>
twin_<ULID>
fw_<stable-slug>
fw_ir_<ULID>
```

Cross-record references are opaque typed strings. Filesystem paths are never identity.

### 3.2 Time

All machine timestamps use RFC 3339 with an explicit offset or `Z`.

Human-facing Markdown may additionally display local time, but machine semantics do not depend on locale formatting.

### 3.3 Praxis prediction immutability

Once a Praxis Episode stores a pre-outcome Twin prediction, that prediction snapshot is immutable.

Later outcome processing may append evaluation and learning, but must not rewrite what Stella predicted earlier.

Implementation can use either:

- immutable nested snapshot plus later mutable outcome fields; or
- append-only episode events and a derived Markdown view.

Alpha should start with the simpler first option, with runtime validation preventing prediction replacement after it is sealed.

### 3.4 Framework activation

Framework source and active Framework IR are versioned independently.

A runtime turn records the exact IR id/version it used.

Recompiling the same source under a new compiler/model creates a new IR artifact rather than silently replacing the old operational interpretation.

## 4. First vertical slice

Start with one initial domain: **relationship/social praxis**.

Reason:

- it exercises Twin context;
- it exercises owner frameworks;
- it benefits strongly from external/social experience;
- outcomes can often be observed in later conversation;
- existing Stella 1.0 assets already provide useful cold-start material.

The vertical slice should use synthetic/public test fixtures in Stella-Core and private real cases only in CangHai/private evaluation data.

## 5. Alpha behavior

For a Praxis turn:

1. Router identifies `praxis`.
2. Situation Builder extracts facts, interpretations, goals, actors, stakes, reversibility.
3. Twin Builder retrieves at most a small bounded set of relevant hypotheses/episodes.
4. Framework Selector chooses zero to two operators.
5. Reality Need Check chooses base-model, personalized Praxis recall, or external research.
6. Packet Builder injects a compact Praxis Context Packet through OpenClaw.
7. Main model answers naturally and concretely.
8. `agent_end` writes an open Praxis Episode to CangHai.
9. Later user/tool evidence can associate an outcome.
10. Closing the episode updates evaluation signals and may adjust one or more Twin hypotheses.

## 6. OpenClaw hook plan

Initial hook surface:

- `before_prompt_build`: run routing/context assembly and inject Praxis packet;
- `before_tool_call`: apply action gate where Stella-specific policy is needed;
- `after_tool_call`: collect outcome/tool observations;
- `before_agent_finalize`: at most one structural rewrite if Praxis answer lacks a concrete action;
- `agent_end`: persist episode metadata and final recommendation;
- `session_start` / `session_end`: optional lifecycle indexing and cleanup.

Avoid replacing `reply_dispatch` in Alpha.

## 7. Data storage

### Stella-Core

Contains schemas, runtime code, synthetic fixtures, and evaluation code only.

### CangHai

Alpha adds portable representations for:

- Twin Hypotheses;
- Framework sources and active IR snapshots;
- Praxis Episodes;
- later personalized Praxis playbook items.

Do not migrate all existing `30_RAG` data before this vertical slice works. Read legacy data through compatibility adapters first.

## 8. Initial evaluation suite

Create 30–50 Praxis cases covering:

- relationship communication;
- gratitude and reciprocity;
- asking for help;
- refusing requests;
- family/private affairs;
- social etiquette;
- informal workplace relationships;
- uncertainty and conflict.

Judge at least:

1. situation understanding;
2. relevant personal-context use;
3. correct framework application;
4. hidden real-world/social variables surfaced;
5. concrete next action;
6. fit with the owner rather than generic advice;
7. retrospective endorsement when outcome data exists.

The repository ships 32 public synthetic cases across all eight categories. The evaluation runner
accepts a behavioral adapter rather than implementing semantic grading with keywords or regexes.
Each observation must provide evidence for all seven dimensions. Public and private inputs may be
combined for one 30–50 case run, but every case retains its boundary and the report contains only
aggregate public/private counts plus failed case IDs—not prompts or private evidence text.

## 9. Exit criteria

Alpha is successful when all are true:

- ordinary turns can bypass Cortex cheaply;
- Praxis turns produce compact traceable packets;
- every meaningful Praxis turn can create a valid episode;
- predictions are stored before outcome and cannot be rewritten later;
- later conversation can close at least a useful fraction of episodes automatically;
- repeated outcomes can strengthen/weaken Twin hypotheses;
- framework operators improve action quality without turning answers into framework exposition;
- private data never leaks into Stella-Core fixtures/logs;
- users perceive recommendations as both personally congruent and more experienced than their unaided default.
