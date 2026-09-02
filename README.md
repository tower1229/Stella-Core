# Stella Core

Stella Core is the cognitive runtime and architecture for Stella 3.0: a personal digital twin and high-dimensional self built on OpenClaw, with CangHai as the portable personal data plane.

## Core goal

Stella exists to become a progressively better digital counterpart of its owner and to extend that person with broader memory, real-world experience, simulation, and praxis capability.

The design centers on four cooperating systems:

1. **Personal Twin** — models how the owner tends to perceive, decide, express, and act.
2. **Framework Compiler** — turns the owner's explicit thinking frameworks into executable cognitive operators.
3. **Reality / Social Intelligence** — supplies real-world and social experience that the owner may not personally possess.
4. **Praxis Loop** — combines Twin, Framework, and Reality into concrete action, observes outcomes, and learns from them.

## Repository boundary

This repository contains **runtime code, schemas, architecture, and evaluation logic only**.

Long-lived personal data belongs in the private CangHai repository. Runtime caches, indexes, embeddings, and other rebuildable OpenClaw state do not need to be committed here or to CangHai unless they become portable personal learning assets.

A Stella instance must be reconstructable after total runtime-server loss from:

```text
compatible OpenClaw
+ Stella Core
+ one coherent CangHai recovery revision
+ required external secrets
→ restored Stella core consciousness
```

Old OpenClaw sessions and machine-local databases are not part of this recovery requirement.

## Design baseline

- `docs/00-VISION.md` — Stella 3.0 mission and product definition.
- `docs/01-ARCHITECTURE.md` — four-system Cortex architecture and consciousness portability invariant.
- `docs/02-PRAXIS-RUNTIME.md` — end-to-end Praxis runtime protocol.
- `docs/03-CANGHAI-DATA-PLANE.md` — portable personal-data boundary and migration direction.
- `docs/04-OPENCLAW-INTEGRATION.md` — OpenClaw 2026.8.1 integration strategy.
- `docs/05-ALPHA-PLAN.md` / `docs/05-ALPHA-VERTICAL-SLICE.md` — first implementable end-to-end milestone.
- `docs/06-RESTORE-CONTRACT.md` — clean-server consciousness restore protocol and continuity acceptance test.
- `docs/07-CANGHAI-COLD-START.md` — additive Stella 1.0 → 3.0 consciousness mapping without destructive RAG migration.
- `docs/DECISIONS.md` — current architectural decisions and superseded constraints.

## Foundational contracts

The first implementation is downstream of four contracts:

- `docs/contracts/FRAMEWORK-IR.md`
- `docs/contracts/TWIN-HYPOTHESIS.md`
- `docs/contracts/PRAXIS-EPISODE.md`
- `docs/contracts/CONSCIOUSNESS-MANIFEST.md`

Machine-validation schemas live in `schemas/`:

- `framework-ir.schema.json`
- `twin-hypothesis.schema.json`
- `praxis-episode.schema.json`
- `consciousness-manifest.schema.json`

## Current cold-start state

The private CangHai repository now has an additive Stella 3.0 bootstrap layer with:

- a deterministic consciousness manifest;
- a portable Stella runtime profile;
- framework/Twin/skill/continuity registries;
- new managed-data roots for Twin, Praxis, and active Framework IR;
- the first activated relationship/social Framework IR;
- a small set of relationship/social Twin hypothesis seeds derived from legacy evidence.

Legacy Stella 1.0 data remains in place and is treated as cold-start evidence.

## Status

Architecture baseline, Alpha contracts, consciousness restore, and cold-start mapping are initialized. The next implementation milestone is no longer another ontology pass; it is the first executable Cortex vertical slice:

```text
real private-life problem
→ Praxis routing
→ Twin context
→ Framework operators
→ Reality intelligence
→ concrete action
→ Praxis Episode
→ later outcome
→ one measurable model update
→ synchronize durable learning to CangHai
```
