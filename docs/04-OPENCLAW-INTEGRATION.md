# OpenClaw Integration Strategy

## 1. Target baseline

Stella 3.0 targets the modern OpenClaw plugin/runtime architecture introduced by the 2026.8.x generation rather than reimplementing the core Agent Loop.

## 2. OpenClaw responsibilities

Retain OpenClaw for:

- agent loop and model execution;
- sessions and transcripts;
- compaction;
- messaging channels;
- generic tool execution;
- permission/approval infrastructure;
- automations, Standing Intents, Workboard, and UI surfaces;
- low-level memory search and indexes;
- runtime backups and operational lifecycle.

## 3. Stella Cortex responsibilities

Stella adds:

- turn routing;
- Situation Frames;
- context-relevant Twin recall;
- framework compilation and selection;
- Reality Intelligence orchestration;
- Praxis Context Packet construction;
- action-policy decisions specific to personalized praxis;
- Praxis Episode recording;
- Twin/Praxis consolidation and evaluation.

## 4. Hook mapping

Expected integration surface:

| Stella concern | OpenClaw hook/API |
| --- | --- |
| Model routing where needed | `before_model_resolve` |
| Context assembly / tool narrowing | `before_prompt_build` |
| Stella tools | `api.registerTool(...)` |
| Gate externally consequential tool calls | `before_tool_call` |
| Observe tool outcomes | `after_tool_call` |
| Repair structurally weak final praxis answer | `before_agent_finalize` |
| Record episode | `agent_end` |
| Session lifecycle | `session_start` / `session_end` |
| Consolidation | cron / loop |
| Follow-up | Standing Intent / automation |

The first version should not own `reply_dispatch` or replace the entire OpenClaw reply pipeline.

## 5. Active Memory

Cross-session recall is useful for a digital twin and should not be categorically disabled.

However, it should be used as one recall capability inside Stella's contextual planning rather than as an unconstrained second cognitive controller.

Use bounded deep recall when:

- the user explicitly refers to previous events;
- chronological reconstruction matters;
- multiple sessions are needed to answer;
- a Praxis episode must be matched to a reported outcome.

## 6. Dreaming

OpenClaw Dreaming and Stella learning have different objectives.

OpenClaw Dreaming may consolidate ordinary episodic memory.

Stella should own a separate `Stella Consolidator` whose promotion targets are:

- Twin hypothesis updates;
- prediction-error summaries;
- Praxis playbook items;
- framework practice notes;
- unresolved hypotheses.

Do not treat `MEMORY.md` consolidation as equivalent to Personal Twin learning.

## 7. Self-learning

Procedural self-learning is desirable, but capability changes should be validated through canary/shadow execution and regression results before broad promotion.

The system can be increasingly autonomous in low-risk operational domains while remaining conservative where error cost is high.

## 8. Memory Wiki

Memory Wiki is useful as a human-readable inspection and debugging surface for:

- claims and evidence;
- hypotheses;
- relationships;
- contradictions;
- freshness;
- provenance.

It is not itself the only owner model and should not be forced to represent latent or probabilistic internal state perfectly.
