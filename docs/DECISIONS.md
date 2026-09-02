# Stella 3.0 Decision Log

This file records architecture decisions that should not silently drift during later design work. Decisions may be superseded, but a replacement should explicitly say what it replaces and why.

## D-001 — Single goal

**Decision:** Stella's only top-level objective is to become the owner's increasingly effective digital counterpart and high-dimensional self.

Governance, auditability, confirmation, and knowledge authority are secondary design mechanisms, not independent product goals.

## D-002 — CangHai remains the personal data home

**Decision:** Long-lived personal learning must have a portable representation in CangHai.

Stella 3.0 is an upgrade of the existing Stella/CangHai lineage, not a clean-slate system that abandons accumulated personal assets.

## D-003 — High-dimensional self means experience expansion

**Decision:** The high-dimensional self preserves the owner's underlying frameworks while extending memory, real-world experience, simulation, perspectives, and praxis ability.

It is not an independent value authority.

## D-004 — Four cognitive systems, one Cortex

**Decision:** Personal Twin, Framework Compiler, Reality/Social Intelligence, and Praxis Loop are cooperating systems inside one Stella Cortex.

They are not four persistent independent agents.

## D-005 — Praxis is the primary product loop

**Decision:** The first implementation target is a closed real-world loop:

```text
situation → twin → framework → reality → action → outcome → learning
```

Do not block Alpha on a comprehensive ontology, full social graph, fine-tuning, latent adapters, or exhaustive migration.

## D-006 — Personal Twin is predictive

**Decision:** Twin quality is measured by pre-outcome prediction and later error, not by the completeness of a static user profile.

## D-007 — Contextual selves

**Decision:** Avoid assuming one globally stable personality policy. The Twin can learn different behavior under different contexts/roles while preserving shared history and values.

## D-008 — Framework source, IR, and praxis learning are separate

**Decision:** Owner-authored framework source remains canonical personal data. Runtime operators are compiled derivatives. Experience learned while applying a framework is stored separately and must not silently rewrite the owner's original framework.

## D-009 — Reality Intelligence is distinct from personal data

**Decision:** Generic world/social knowledge and live external facts are not Personal Twin data. Personalized knowledge learned from the owner's actual outcomes is personal data and belongs in CangHai.

## D-010 — OpenClaw remains the generic runtime

**Decision:** Stella 3.0 uses modern OpenClaw plugin hooks and tools rather than replacing the Agent Loop.

## D-011 — Learning can be automatic

**Decision:** User confirmation is a high-value supervision signal, not the only legal mechanism for learning. Stella may maintain probabilistic hypotheses and update them automatically from outcomes.

## D-012 — No premature personal fine-tuning

**Decision:** Alpha uses retrieval, hypotheses, framework IR, and Praxis episodes. Fine-tuning, user vectors, soft prompts, adapters, and other latent personalization are evaluated only after sufficient prediction/outcome data exists.

## D-013 — Public/private repository boundary

**Decision:** Stella-Core is safe to remain public. Private personal data stays in CangHai and must not be copied into public fixtures, examples, logs, or documentation.

## D-014 — Active Framework IR is portable

**Decision:** When Framework IR is compiled by a model or another non-bit-deterministic compiler and is activated for real Stella behavior, the exact active IR snapshot must have a portable CangHai representation.

The source remains authoritative for what the owner authored; the active IR records what Stella actually executed.

## D-015 — Pre-outcome prediction is immutable

**Decision:** Once an important Praxis Episode seals a Twin prediction before the outcome is known, later outcome processing may score it but may not rewrite the original prediction.

This is required for meaningful Twin Fidelity evaluation.

## D-016 — Stable IDs are independent of paths

**Decision:** Durable Twin, Framework IR, and Praxis identities must survive file moves. Alpha uses typed stable IDs/references; filesystem paths are storage locations, not identity.

## D-017 — Alpha starts with one vertical domain

**Decision:** The first full Praxis vertical slice is relationship/social praxis because it exercises all four systems and has strong existing cold-start assets. Other domains are added after the loop works.

## D-018 — Stella-Core is disposable runtime; CangHai carries durable consciousness

**Decision:** Stella-Core implements cognition, but does not own the instance's durable personal consciousness. CangHai must contain the portable owner-specific data and configuration required to reconstruct the same learned Stella on another compatible runtime host.

The system-level recovery equation is:

```text
compatible OpenClaw
+ Stella-Core
+ CangHai data/config
+ required external secrets
→ restored Stella core consciousness
```

A total loss of the old OpenClaw/Stella runtime server must not destroy durable owner-specific learning.

## D-019 — Session recovery is not required for consciousness recovery

**Decision:** Old sessions, raw session continuity, compaction state, prompt caches, and machine-local OpenClaw databases are not required for Stella recovery.

If a fact, hypothesis, relationship model, open Praxis episode, learned strategy, goal, commitment, or other state is important enough that Stella should still know or act on it after a clean redeploy, it must be persisted independently of the session layer.

## D-020 — Durable cognitive state includes configuration

**Decision:** CangHai persists not only personal content but also the owner-specific Stella configuration that determines cognitive behavior: identity/persona, active framework selection/representation, portable runtime profile, and other non-secret configuration needed for reconstruction.

Secrets should be referenced through external secret mechanisms rather than embedded in ordinary CangHai configuration when possible.

## D-021 — Recovery is an acceptance property

**Decision:** Portability is not considered complete merely because data is nominally stored in CangHai. Stella must eventually pass a destructive restore test from a fresh server using Stella-Core + compatible OpenClaw + CangHai, without importing old sessions.

Continuity should be evaluated by whether the restored instance retains the same durable identity, frameworks, Twin understanding, learned Praxis, and important open state within defined tolerances.
