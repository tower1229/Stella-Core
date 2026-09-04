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
- `docs/04-OPENCLAW-INTEGRATION.md` — OpenClaw integration strategy; Alpha acceptance is pinned to 2026.8.2 while 2026.8.1 remains the unproven minimum compatibility claim.
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

The public 32-case relationship/social Alpha suite lives at
`evaluation/praxis-social.synthetic.json`. Run it through a Host/evaluator adapter with
`npm run evaluate:praxis -- --suite <suite.json> --adapter <adapter.mjs> --recovery-receipt <receipt.json> --output <report.json>`.
The adapter exports `answerCase(case)` for the exact Stella Host and `judge(prompt)` for an LLM
structured semantic judge; the runner rejects lexical scoring and incomplete rubric output.
Private cases stay in CangHai or another private evaluation store; mixed reports retain explicit
public/private case counts without copying prompts into the report.

## Current cold-start state

The private CangHai repository now has an additive Stella 3.0 bootstrap layer with:

- a deterministic consciousness manifest;
- a portable Stella runtime profile;
- framework/Twin/skill/continuity registries;
- new managed-data roots for Twin, Praxis, and active Framework IR;
- the first activated relationship/social Framework IR;
- a small set of relationship/social Twin hypothesis seeds derived from legacy evidence.

Legacy Stella 1.0 data remains in place and is treated as cold-start evidence.

## Alpha recovery and candidate gates

Stella Core exposes a fail-closed Level 0–3 recovery drill, managed Git durability, a repeatable
Praxis evaluation runner, an exact-Host write-loop runner, and an Alpha candidate receipt builder.
`managed_durable_write` requires
an explicit Git remote/branch and a manifest policy with critical `sync_immediately`; normal writes
are committed locally and pushed within the configured bounded RPO. The coordinator exposes pending
age, RPO breach, synchronized revision, and stable failure categories. Every managed commit first
advances the persistent OpenClaw recovery pointer with compare-and-set, then pushes and refreshes the
in-process loader. A pointer conflict leaves the CangHai commit intact and fails explicitly.

Use the unified activation entrypoint for a non-mutating diagnosis or an explicit transactional
apply. It requires clean Core/CangHai sources, the exact branch and full CangHai SHA, validates the
Host/plugin/manifest contract, and backs up and rolls back OpenClaw configuration on apply failure:

```bash
npm run stella:activate -- --canghai-root /path/to/CangHai --agent-id main \
  --data-mode managed_durable_write --check
npm run stella:activate -- --canghai-root /path/to/CangHai --agent-id main \
  --data-mode managed_durable_write --apply
```

Create a non-published candidate only after the clean-runtime recovery and evaluation evidence exist:

```bash
npm run recover:private -- \
  --canghai-root /path/to/CangHai \
  --canghai-revision <40-character-sha> \
  --artifact /path/to/exact-artifact.tgz \
  --adapter /path/to/private-host-adapter.mjs \
  --output /path/outside/Stella-Core/private-exact-host-receipt.json
```

The private adapter must export `createRecoveryHarness(context)`. Its harness supplies one Host
rebuild function per manifest target, 1–10 private probe messages, and a behavioral continuity
verifier for the runner-observed Host results. The runner independently requires clean exact source revisions, hashes the
artifact, installs it alongside OpenClaw 2026.8.2, creates an empty isolated runtime directory,
rejects legacy runtime import, and executes every exact-Host agent turn itself. Receipt output is mode `0600` and
contains aggregate evidence only.

Before recovery/evaluation, run the private three-turn managed-write loop against the same packed
artifact. The private adapter exports `createPraxisLoopHarness(context)` and keeps all case text and
semantic judging private; the public receipt contains only revisions, hashes, booleans, and counts.

```bash
npm run praxis:private -- \
  --canghai-root /path/to/CangHai \
  --canghai-revision <initial-40-character-sha> \
  --artifact /path/to/exact-artifact.tgz \
  --adapter /path/to/private-host-adapter.mjs \
  --output /path/outside/Stella-Core/praxis-loop-receipt.json
```

```bash
npm run candidate -- \
  --canghai-root /path/to/CangHai \
  --canghai-revision <40-character-sha> \
  --artifact /path/to/exact-host-tested.tgz \
  --evaluation-report /path/to/evaluation-report.json \
  --recovery-receipt /path/to/private-exact-host-receipt.json \
  --praxis-receipt /path/to/praxis-loop-receipt.json \
  --durability-evidence /path/to/durability-diagnostics.json \
  --output-dir /path/outside/Stella-Core
```

The output directory receives `alpha-candidate-receipt.json`. Candidate receipt v2 binds
the clean Core/CangHai revisions, exact OpenClaw 2026.8.2, artifact SHA-256, Level 3 recovery,
the three-turn managed-write loop, durability/RPO evidence, evaluation counts, and an explicit
no-tag/no-Release/no-npm/no-production state. The command fails if its output directory is inside
the Core source tree. Historical candidate v1 receipts cannot satisfy this gate.
Synthetic-only recovery or evaluation cannot produce `candidate: true`; at least one private case
and a private exact-host recovery receipt bound to the same tarball are required.

The executable Cortex vertical slice is:

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
