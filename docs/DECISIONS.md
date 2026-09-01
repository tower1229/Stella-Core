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
