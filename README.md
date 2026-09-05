# Stella Core

Stella Core is the OpenClaw plugin for Stella 3.0: a personal digital twin and high-dimensional self.
One Cortex combines Personal Twin, Framework Compiler, Reality / Social Intelligence and Praxis.

## Current design

Start with [the design baseline](docs/10-DESIGN-BASELINE.md). It defines document authority,
response completion, common correctness gates and the distinction between design and implementation.

- [Confirmed requirements](docs/09-REQUIREMENTS-ALIGNMENT.md) define the full product; Alpha is its first relationship/social validation slice.
- [Domain language](CONTEXT.md) defines stable terms.
- [Architecture](docs/01-ARCHITECTURE.md) and [runtime protocol](docs/02-PRAXIS-RUNTIME.md) assign responsibilities.
- [Memory Lifecycle](docs/contracts/MEMORY-LIFECYCLE.md) defines ingestion → evidence retrieval → interaction learning → source-change synchronization.
- [Portable Registries](docs/contracts/PORTABLE-REGISTRIES.md) defines discovery, runtime profiles, capabilities and policies.
- [OpenClaw integration](docs/04-OPENCLAW-INTEGRATION.md) defines versioned Host requirements and completion coordination.
- [Alpha acceptance](docs/05-ALPHA-PLAN.md) owns the Alpha exit criteria; [the vertical slice](docs/05-ALPHA-VERTICAL-SLICE.md) illustrates them.
- [Restore Contract](docs/06-RESTORE-CONTRACT.md), [data plane](docs/03-CANGHAI-DATA-PLANE.md) and [cold-start mapping](docs/07-CANGHAI-COLD-START.md) define portability.
- [Decision log](docs/DECISIONS.md) records explicit replacements. Closed Issues and dated handoffs are historical evidence.

Answers, clarifications, collaboration and action advice have distinct completion conditions.
Learning can happen before an action or outcome. Historical predictions retain their original inputs;
current understanding must follow valid current sources. Automated checks verify contracts and diagnose
semantic regressions; the owner judges usefulness in actual use.

## Public and personal data

This repository contains public runtime code, contracts, schemas and synthetic evaluations.
Private originals, durable learning and instance configuration belong in CangHai. The owner inspects
and edits that repository directly.

A complete current Git-based CangHai copy must contain all retained original data, including
conversation archives and media attachments. External-only references do not satisfy this boundary.
Rebuildable indexes and caches stay in the runtime; credentials use external SecretRefs.

```text
compatible OpenClaw + Stella Core + one coherent CangHai recovery revision
+ required external secrets
→ restored personal consciousness and rebuilt views
```

Restoring old Host execution sessions is unnecessary. Retaining complete conversation evidence is a
separate requirement. The Stella 1.0 backup is CangHai dev; local/stella-alpha is a Core test branch.
Both the inspected legacy commit and the distinction are recorded in the requirements document.
Runtime operations always use an explicitly selected revision.

## Contracts and schemas

The [contract directory](docs/contracts/README.md) defines the authoritative data and lifecycle rules.

Machine schemas cover Framework IR, Twin Hypothesis, Consciousness Manifest and Episode v1/v2.
[Episode v2](schemas/praxis-episode-v2.schema.json) is the new write target; v1 remains an explicit
migration input. The runtime and fixtures still require migration before v2 activation. Registry and
memory formats have logical contracts; their runtime validators remain an implementation obligation.
Schema success alone does not verify temporal, cross-record, permission or evidence invariants.

## Validation and local use

```bash
npm run check
npm run check:schemas
npm run build
npm test
npm run test:package
```

npm run verify runs that complete chain. OpenClaw 2026.8.2 is the pinned Host for integration evidence;
2026.8.1 remains an independently unverified minimum compatibility claim.

The current code contains managed Git durability, recovery-pointer CAS, recovery/evaluation runners,
activation check/apply and candidate receipt tooling. Those mechanisms do not yet establish compliance
with all revised contracts. [Known implementation differences](docs/10-DESIGN-BASELINE.md#6-设计与源码的差异)
are explicit, including Episode v2, response semantics, completion gating and the four-part memory flow.

Use [the local runbook](docs/08-LOCAL-DEV-INTEGRATION.md) for exact activation and private-runner
commands. Private write-loop, recovery, evaluation and candidate evidence must bind the same clean
Core/artifact/Host and the resulting synchronized CangHai revision. Old receipts cannot prove newly
added acceptance assertions. This documentation does not itself authorize migration, activation or publication.

The public 32-case diagnostic suite is [praxis-social.synthetic.json](evaluation/praxis-social.synthetic.json).
It uses a structured LLM judge through an explicit Host adapter. Private cases and raw model output stay
in CangHai; public receipts contain only allowed aggregate evidence.
