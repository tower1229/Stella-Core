# Stella Core

Stella Core is the OpenClaw plugin for Stella 3.0: a personal digital twin and high-dimensional self.
One Cortex combines Personal Twin, Framework Compiler, Reality / Social Intelligence and Praxis.

The development build uses an **ordinary plugin** beside OpenClaw's native
memory, context and Agent loop. Its default entry provides candidate work tools,
status and a controlled selected-source read port. Confirmed publication remains
disabled. See the
[main debug installation and rollback guide](docs/MAIN-DEBUG-INSTALL.md).
The older runtime and its acceptance records remain historical. The default build
now starts from the ordinary entry plus the selected-source preparation and Git
durability utilities; its installable package excludes the old plugin, private
Host bridges, context replacement, SQL reader and activation guides. Retired
activation/acceptance npm aliases have been removed. Historical source and tests
are being removed by dependency group; Git retains their recovery point.

The second retirement group removes the old plugin entry, direct native-SQL and
query-embedding bridges, their acceptance/initialization registration, and four
standalone launchers. The former startup and source-locator assertions now run
against the ordinary entry and the retained repository-data parser. Mixed
source-access, initialization-file and recovery tests keep their applicable
assertions. The old full/experimental package runners, their 152-case shard
aggregation and dedicated probes/tests have also been removed. Version checks,
standalone command-capture regressions and process supervision remain; their
applicable assertions are retained. The custom Host context/provider chain and its
completion/fragment adapters have now been removed. Mixed tests exercise source
bytes, roles, versions, permissions and transactions directly, without recreating
that Host projection. Checkpoint and the remaining Praxis runtime are later
dependency groups. Retiring an obsolete test does not turn its historical
failure into a passing result or prove semantic recall.

The current priority is **understanding existing data**: select relevant sources,
check originals, and answer with evidence and uncertainty. The
[source-read integration](docs/ORDINARY-SOURCE-READ.md#native-forward-understanding-guidance-unloaded-candidate)
includes an unloaded native-Agent guidance candidate that needs no work brief.
Its instructions and offline checks do not prove real semantic behavior. Runtime
observations are dated evidence; current execution status is in the
[single task index](.task-control/state.json).

The historical [unconfirmed work-brief increment](docs/CANDIDATE-WORK-BRIEF.md) adds explicit
save/read and versioned modification in a separate synthetic-debug Git store.
The existing main Gateway has loaded this reviewed build (generation 11), and
four no-model calls saved, restored and revised one fictional brief across
requests. Author confirmation and formal publication remain disabled. The
Host's acceptance of the added declared tool persists until revoked; this does
not enable private sources or authorize paid model calls.

The [explicit continuation entry](docs/CANDIDATE-WORK-BRIEF.md#explicit-continuation)
uses `/stella_continue <briefId> <request>` to guide the native Agent through
current read, open questions and candidate revision. The reviewed skill package
was loaded at main generation 12. On 2026-11-02, the official config interface
added exactly this skill to main's existing selection. Authoritative inventory
now reports its command visible. Four no-model Gateway calls saved, restored,
revised and restored a separate fictional brief without changing the old data.
Actual model-driven use and semantic acceptance remain untested.

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

The current data target is **full-repository conversion on a new CangHai branch**,
with this plugin consuming a fixed local revision and synchronization updated for
the new format. The existing 97-source trial is not that completed migration.
[Core–CangHai coordination](docs/CORE-CANGHAI-COORDINATION.md) defines the current
consumer interface, producer handoff and synchronization gaps. CangHai `dev` currently serves legacy production; additive development must preserve its paths and source pointer, with separate writer/version coordination.

## Contracts and schemas

The [contract directory](docs/contracts/README.md) defines the authoritative data and lifecycle rules.

Machine schemas cover Framework IR, Twin Hypothesis, Consciousness Manifest and Episode v1/v2.
[Episode v2](schemas/praxis-episode-v2.schema.json) is the new write target; v1 remains an explicit
migration input. The runtime and fixtures still require migration before v2 activation. Registry and
memory formats have logical contracts; their runtime validators remain an implementation obligation.
Schema success alone does not verify temporal, cross-record, permission or evidence invariants.

## Experimental owner chat

The [experimental owner chat guide](docs/EXPERIMENTAL-OWNER-CHAT.md) is historical. Its custom checkpoint runtime, initialization and source-supply adapters have been retired; it is not an alternative install path. Current development uses the ordinary plugin and native OpenClaw memory/context/Agent loop.

The [Suqing closeout](docs/suqing-closeout-2026-10-23.md) records each scoped exit and remaining boundary; [current request-lifecycle work](docs/mainline-request-lifecycle-2026-10-23.md) tracks the follow-up fixes, CI evidence, and real WebChat prerequisites.

[实验模式 CI 范围](docs/EXPERIMENTAL-CI.md) preserves the historical owner-chat and
152-case complete-capability assessments. Their automatic workflows were retired
on 2026-11-03 under the decision to prioritize the new architecture. The exact
files are recoverable from Git; their failed results remain historical failures.

`Ordinary plugin package contract` independently checks the current ordinary entry:
existing source-read, request-admission, skill-discovery, candidate-work-brief,
author-intent-repository, memory-transaction and journal tests run against the
extracted npm package, with synthetic sources and workspace dependencies. It does
not start a Gateway, install fresh dependencies, call a model or accept semantic
understanding. Three self-contained 8.2-specific suites and their sole-use audit were
retired with the old automatic workflows. Ten of the historical 26 failures
belong to those suites and were **not fixed or passed**. Mixed authority, SQL and
completion tests remain, along with shared validators and current source-access
tests. `npm run verify` still fails on retained test failures. The preparation
receipt records the actual SDK and synthetic fixture
version separately; `PREPARED.json` alone is not a passing test result.

## Validation and local use

```bash
npm run check
npm run check:schemas
npm run build
npm test
npm run verify
```

`npm run verify` runs type/schema checks and the complete remaining workspace
test suite, including compilation. OpenClaw 2026.8.2 was the fixed Host for the
historical integration evidence; the former 2026.8.1 minimum was not independently
verified. These are historical claims, not the ordinary plugin's current test
baseline. The repository lock pins SDK 2026.10.8; local 2026.10.9 evidence is
reported separately and does not establish 10.8 compatibility.

The current code contains managed Git durability, recovery-pointer CAS, recovery/evaluation runners,
activation check/apply and candidate receipt tooling. Those mechanisms do not yet establish compliance
with all revised contracts. [Known implementation differences](docs/10-DESIGN-BASELINE.md#6-设计与源码的差异)
are explicit, including Episode v2, response semantics, completion gating and the four-part memory flow.

The [old local runbook](docs/08-LOCAL-DEV-INTEGRATION.md) and its activation/private-runner
commands are historical and are not part of the current installable plugin. Use
[Main debug installation](docs/MAIN-DEBUG-INSTALL.md) for the ordinary entry. Private write-loop, recovery, evaluation and candidate evidence must bind the same clean
Core/artifact/Host and the resulting synchronized CangHai revision. Old receipts cannot prove newly
added acceptance assertions. This documentation does not itself authorize migration, activation or publication.

The public 32-case diagnostic suite is [praxis-social.synthetic.json](evaluation/praxis-social.synthetic.json).
It uses a structured LLM judge through an explicit Host adapter. Private cases and raw model output stay
in CangHai; public receipts contain only allowed aggregate evidence.
