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

## Design baseline

- `docs/00-VISION.md` — Stella 3.0 mission and product definition.
- `docs/01-ARCHITECTURE.md` — four-system Cortex architecture.
- `docs/02-PRAXIS-RUNTIME.md` — end-to-end Praxis runtime protocol.
- `docs/03-CANGHAI-DATA-PLANE.md` — portable personal-data boundary and migration direction.
- `docs/04-OPENCLAW-INTEGRATION.md` — OpenClaw 2026.8.1 integration strategy.
- `docs/05-ALPHA-VERTICAL-SLICE.md` — first implementable end-to-end milestone.
- `docs/DECISIONS.md` — current architectural decisions and superseded constraints.

## Foundational contracts

The first implementation is downstream of three contracts:

- `docs/contracts/FRAMEWORK-IR.md`
- `docs/contracts/TWIN-HYPOTHESIS.md`
- `docs/contracts/PRAXIS-EPISODE.md`

Machine-validation schemas live in `schemas/`:

- `framework-ir.schema.json`
- `twin-hypothesis.schema.json`
- `praxis-episode.schema.json`

## Status

Architecture baseline and Alpha contracts are initialized. The next implementation milestone is the first vertical slice:

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
```
