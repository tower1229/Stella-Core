# Stella Core

Stella Core is the OpenClaw plugin for Stella 3.0: a personal digital twin and high-dimensional self.
One Cortex combines Personal Twin, Framework Compiler, Reality / Social Intelligence and Praxis.

The current debug build uses an **ordinary plugin** beside OpenClaw's native
memory, context and Agent loop. Its default entry provides an unconfirmed,
unsaved author-intent candidate tool and a no-model status command. Private-source
admission and confirmed publication remain disconnected. See the
[main debug installation and rollback guide](docs/MAIN-DEBUG-INSTALL.md).
The older runtime and its acceptance records remain historical; the old
activation scripts do not configure this new entry.

The [unconfirmed work-brief increment](docs/CANDIDATE-WORK-BRIEF.md) adds explicit
save/read and versioned modification in a separate synthetic-debug Git store.
The existing main Gateway has loaded this reviewed build (generation 11), and
four no-model calls saved, restored and revised one fictional brief across
requests. Author confirmation and formal publication remain disabled. The
Host's acceptance of the added declared tool persists until revoked; this does
not enable private sources or authorize paid model calls.

The [explicit continuation entry](docs/CANDIDATE-WORK-BRIEF.md#explicit-continuation)
uses `/stella_continue <briefId> <request>` to guide the native Agent through
current read, open questions and candidate revision. The reviewed skill package
is loaded at main generation 12. Authoritative inventory finds it eligible, but
main's existing agent skill filter currently excludes its command. That filter
has not been widened. Scripted tool behavior is verified; actual model-driven
use and semantic acceptance remain untested.

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

[Core–CangHai coordination](docs/CORE-CANGHAI-COORDINATION.md) defines the parallel-development handoff and compatibility gates. CangHai `dev` currently serves legacy production; additive development must preserve its paths and source pointer, with separate writer/version coordination.

## Contracts and schemas

The [contract directory](docs/contracts/README.md) defines the authoritative data and lifecycle rules.

Machine schemas cover Framework IR, Twin Hypothesis, Consciousness Manifest and Episode v1/v2.
[Episode v2](schemas/praxis-episode-v2.schema.json) is the new write target; v1 remains an explicit
migration input. The runtime and fixtures still require migration before v2 activation. Registry and
memory formats have logical contracts; their runtime validators remain an implementation obligation.
Schema success alone does not verify temporal, cross-record, permission or evidence invariants.

## Experimental owner chat

The opt-in [experimental owner chat guide](docs/EXPERIMENTAL-OWNER-CHAT.md) describes the bounded pure-plugin mode, initialization, continuous conversation, and rollback. It is separate from full memory and Alpha acceptance.

The [Suqing closeout](docs/suqing-closeout-2026-10-23.md) records each scoped exit and remaining boundary; [current request-lifecycle work](docs/mainline-request-lifecycle-2026-10-23.md) tracks the follow-up fixes, CI evidence, and real WebChat prerequisites.

[实验模式 CI 范围](docs/EXPERIMENTAL-CI.md) separates the installed synthetic owner-chat check from the independent 152-case complete-capability assessment. A green experimental check does not accept full_memory.

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
