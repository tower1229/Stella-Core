# Stella 3.0 Decision Log

This file records architectural decisions and explicit replacements. [The design baseline](10-DESIGN-BASELINE.md) is the current navigation and acceptance authority. Historical decisions remain context only where a later decision names a replacement.

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

**Decision:** Pre-outcome prediction and later error diagnose the Twin's predictive ability. D-034 clarifies that they do not objectively certify the whole model or lived usefulness; owner feedback remains the product criterion.

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

## D-022 — Consciousness manifest has a deterministic bootstrap location

**Decision:** Alpha discovers one Stella instance through:

```text
50_PersonalAgent/stella/manifest.yaml
```

Restore must not depend on heuristic repository search. The manifest path is only a bootstrap locator; durable record identities remain path-independent.

## D-023 — One CangHai Git revision is the recovery coherence boundary

**Decision:** A restore resolves the manifest and all durable references from one explicit CangHai Git commit. It must not silently combine owner state from multiple revisions.

This makes a CangHai commit the portable Stella recovery point.

## D-024 — Remote synchronization defines crash durability

**Decision:** Writing durable cognition to the server-local CangHai working tree is not sufficient protection against total server loss. Durable consciousness changes must reach a remote durable CangHai copy according to an explicit synchronization policy.

Critical behavioral state defaults to immediate synchronization. Ordinary learning may use bounded batching with an explicit RPO. The current RPO must be observable and testable.

## D-025 — Cold-start migration is additive and non-destructive

**Decision:** Stella 1.0 assets are referenced in place first. The 3.0 bootstrap layer adds a manifest, registries, compatibility adapters, and new managed-data roots without requiring wholesale relocation or rewriting of the existing `30_RAG` corpus, Bootstrap files, or skills.

Physical reorganization is optional and happens only when it improves maintainability without losing provenance.

## D-026 — Legacy corpus is evidence; new 3.0 learning gets managed storage

**Decision:** Existing Stella 1.0 corpus remains cold-start evidence. New 3.0 Twin hypotheses, Praxis episodes/playbooks, and active non-deterministic Framework IR artifacts are written to dedicated managed personal-data locations rather than silently modifying legacy model-seed/RAG sources.

This separates historical evidence from continuously learned Stella 3.0 consciousness.

## D-027 — Recommendation and actual action are distinct durable states

**Decision (state semantics refined by D-051):** Saving advice moves a Praxis Episode from `open` to `recommended`; actual delivery is recorded independently. Only evidence
that the owner, a tool, or the system actually acted may produce `acted`. Outcome association may
atomically close either a recommended or acted Episode, but closure always requires actual action,
outcome, and learning while preserving the original prediction snapshot.

## D-028 — Managed commits advance the persistent recovery pointer before synchronization

**Decision:** A managed CangHai write is not successful merely because the process-local loader saw
the new revision. After the CangHai commit, Stella compare-and-sets the persistent OpenClaw recovery
pointer, then pushes/flushes and refreshes the loader. Pointer failure preserves the commit for
explicit reconciliation and fails with a stable category; it never rolls back user learning or
silently overwrites a concurrent configuration change.

## D-029 — Full product requirements extend beyond the Alpha slice

**Decision:** [The 2026-09-05 requirements alignment](09-REQUIREMENTS-ALIGNMENT.md) records the
confirmed full product scope and experience priorities. Relationship/social praxis remains the
first validation domain under D-017; it does not limit the eventual product to that domain.
Alpha capacity limits and implementation status are not full-product requirements.

## D-030 — Reuse Host capabilities before adding Core infrastructure

**Decision:** Check OpenClaw and existing plugins for sessions, retention/backup, basic retrieval,
context management, ordinary memory consolidation, scheduling, and delivery before adding a Core
counterpart. Core owns personalized semantic reasoning and learning requirements. Separate logical
responsibilities do not require duplicate storage or a separate consolidation service. Reuse must
satisfy the complete contract and must not introduce silent semantic degradation.

## D-031 — Complete conversation retention is distinct from session recovery

**Decision:** Daily conversations are retained as complete original evidence by default, subject to
owner-directed non-retention and direct file corrections/removals under D-042. Storage and backup reuse OpenClaw capabilities; physical
archive integration now follows D-050 and Memory Lifecycle. This extends the retained-data scope without
replacing D-019: durable cognition remains independently recoverable without importing old runtime
sessions. Preserve original evidence separately from derived understanding and rebuildable views.

## D-032 — Learn from rejection, context, and continuing interaction

**Decision:** An explicit rejection should prompt understanding of the owner's reasons and correction
of the advice, rather than ending the learning loop. Apply new understanding in its supported context;
broader generalizations remain revisable hypotheses. Owner explanations carry high weight, and
conflicting behavioral evidence should be discussed concretely. Cross-domain understanding is allowed
within authorization and source-specific usage limits. Background learning and valuable proactive
invitations complement ordinary interaction; Host facilities perform wakeup and delivery.

## D-033 — Recall quality takes priority over latency

**Decision:** The owner accepts longer response time for stronger recall and answers. Stella should
plan retrieval semantically, follow evidence across sources, seek counterevidence and updates, and
verify original material before relying on it. Fixed Alpha candidate or packet limits cannot define
the final recall standard. Missing evidence and operational failures must remain explicit.

## D-034 — Automated correctness checks do not certify lived usefulness

**Decision:** Automate observable implementation contracts and use semantic evaluations as diagnostic
evidence. Actual usefulness is judged and improved through the owner's feedback in real use, without
a mandatory scoring workflow. This clarifies D-006 and existing Alpha rubrics: pre-outcome prediction
and later error support calibration, but their scores do not constitute an objective verdict on the
whole Twin or the owner's experience.

## D-035 — Stella 1.0 evidence comes from the CangHai dev backup

**Decision:** Read Stella 1.0 assets from CangHai `dev`, resolved to an immutable commit. The current
Core-based test branch includes 3.0 additions and cannot be treated wholesale as a 1.0 backup.
[The alignment record](09-REQUIREMENTS-ALIGNMENT.md) pins the inspected revisions. Runtime activation,
managed writes, and recovery continue to use their explicitly configured source revision under D-023.

## D-036 — Owner-delivered material may be organized automatically

**Decision:** Material the owner intentionally gives Stella may be archived, distilled, linked,
and used to update revisable understanding automatically, preserving original content and provenance.
This supersedes legacy per-write confirmation in that scope. Ask when intended use is unclear;
rewriting owner-authored originals, modifying owner frameworks, or changing a material's permitted
use requires corresponding explicit authorization. Existing authorization is sufficient and must
not be requested again. This does not authorize access to additional external sources or promote
inferences into facts. See [the confirmed input boundary](09-REQUIREMENTS-ALIGNMENT.md#41-用户主动交付资料的默认整理权已确认).

## D-037 — Stella governs long-term personal interpretation over shared memory

**Decision:** Reuse OpenClaw recording and consolidation while Stella governs which interpretations
enter the long-term personal model, their scope, and their updates. Summaries retain original-source
references and do not count as additional independent evidence. One owner correction propagates to
affected summaries, hypotheses, and subsequent answers. Competing interpretations may coexist with
their evidence and uncertainty. This settles the logical responsibility boundary in D-030; the
concrete synchronization protocol is defined by D-050, but remains unverified as a complete runtime capability.

## D-038 — Personal data sources are centralized in the personal digital repository

**Decision:** The owner's stated reason is to centralize data sources in the personal digital
repository. Git is its current implementation, not a permanent product objective. A future change
of storage technology needs separate alignment and must preserve that centralization and completeness.

For the current Git-based architecture, a complete CangHai Git repository copy must contain all
retained original personal data, including images, audio, video, conversation archives, and
attachments. The original content must be recoverable from that copy without a separate external
asset store. Keeping only external attachment references does not satisfy the current boundary.

Original media retain their formats within this self-contained boundary. D-050 defines the managed descriptors, coverage and synchronization protocol. Owner-directed
retention/deletion, synchronization policy, rebuildable runtime state, and external-secret contracts
continue to apply. Complete raw-data coverage and integrity are additional acceptance requirements;
the current Alpha consciousness-recovery drill does not establish them.

## D-039 — Autonomous learning serves the owner's questions and long-term goals

**Decision:** Stella may autonomously identify knowledge and experience gaps, research within
existing access permissions, relate findings to personal context, retain useful source material,
and learn through subsequent advice, questions, feedback, and outcomes. This is a foundational
product capability, extending beyond the immediate query. Each retained source has clear personal
relevance and potential decision use and belongs in the personal digital repository under D-038.

External knowledge expands the high-dimensional self's available experience. Personal Twin updates
remain grounded in the owner's choices, explanations, rejection reasons, and actual outcomes;
external theories alone are not evidence of owner traits. This preserves D-009's distinction between
world knowledge and personal understanding. Collection volume is not a measure of growth, and actual
usefulness is judged through owner feedback under D-034. Host capabilities are reused under D-030;
this decision does not itself deploy background jobs or grant new account access.

## D-040 — Stella may challenge frameworks; the owner decides formal revisions

**Decision:** When specific evidence suggests a limitation in the owner's thinking framework,
Stella may proactively question it, explain the evidence and scope, and propose a revision.
The discussion distinguishes factual understanding from value tradeoffs. Formal framework changes
remain the owner's decision; existing explicit authorization is sufficient. Unaccepted proposals
must not rewrite canonical source or be activated through IR. This extends the learning role in
D-039 while preserving the source, execution snapshot, and Praxis-learning separation in D-008.

## D-041 — Retrieve first and clarify unknowns that could change the advice

**Decision:** Stella retrieves existing evidence before asking the owner. If unresolved information
could change the recommendation's direction, Stella asks before giving definite advice dependent on
it. Details that do not materially affect the judgment may remain explicitly stated assumptions.
Unreadable sources, lack of retrieved evidence, and conflicting evidence remain visible and distinct;
they do not establish that a fact does not exist or turn failed retrieval into success. Semantic
judgment determines materiality. A necessary clarification is a valid interaction result and must
not be forced into definite advice solely to satisfy an answer-format requirement.

## D-042 — File edits and memory sync handle corrections; no event-forgetting feature

**Decision:** The owner will directly modify or remove stored files when needed, then resynchronize
memory indexes. Stella Core does not implement a natural-language instruction to forget an event.
The owner's existing repository-maintenance workflow meets that need; an event-level forgetting
interface and physical history/backup erasure are outside Stella's product scope.

Sync uses the updated repository revision and reconciles affected indexes, source-dependent
summaries, hypotheses, and strategies. Removed sources stop contributing; independent valid sources
may still support a conclusion. Normal sync and learning must not restore removed content from stale
indexes, summaries, or historical versions. This clarifies D-031's removal path and preserves D-037's
correction-propagation requirement without adding cross-corpus semantic erasure.

## D-043 — Explicit delegation permits continuing work within scope

**Decision:** Stella supports one explicit authorization for continuing work on a matter or class
of tasks. Research, organization, and preparation follow their established autonomy boundaries;
external operations require covering owner authorization. Repeated work within that scope proceeds
without asking again. New decisions outside it require owner input. Historical satisfaction,
acceptance of advice, and model confidence cannot silently expand authority.

Use OpenClaw tools, scheduling, and permission infrastructure. This defines full-product behavior;
current Alpha packets remain advice/preparation only. No particular external task or recurring job
has been commissioned by accepting this product capability.

## D-044 — Defer unanswered proactive conversations without inferring feedback

**Decision:** When the owner does not reply to a proactive conversation without a deadline, defer
it until new information or a naturally relevant context appears. Silence means feedback is not yet
available; it does not establish acceptance, rejection, or broader authorization. Time-sensitive
matters follow the existing delegation, without automatic cancellation or scope expansion caused
by a missing reply. Stella judges relevance and context while OpenClaw supplies wakeup and delivery.

## D-045 — Social judgment calibrates relationship expectations and investment

**Decision:** Stella assesses social state from original interaction content, reply patterns,
initiative, reciprocal investment, follow-through, and changes over time. Age, life stage, personality,
and roles supply relevant context, not deterministic explanations or excuses for contrary evidence.
Courtesy, topic engagement, and accepting help do not establish sustained relational investment.
Incomplete archives must not be treated as proof of absent interaction.

Advice explains the supported state, counterevidence, material unknowns, and changes that would
revise the assessment. It compares the owner's expectations and plans with demonstrated reciprocity
and offers practical actions appropriate to the evidence and the owner's goals. Uncertainty about
another person's inner motives must not prevent a supported warning about investment risk; positive
reassurance and advancing the relationship are not default success criteria. Necessary clarification
under D-041 remains valid for advice dependent on unresolved facts.

Later outcomes and owner feedback correct state estimates, reasoning, and advice without rewriting
original predictions or asserting that an eventual outcome proves all earlier motives. D-034's
evaluation boundary applies: automated checks establish source and temporal integrity, semantic
diagnostics expose possible errors, and actual usefulness is judged by the owner in use. Private
case details remain outside this public requirements record. See [the confirmed social judgment requirement](09-REQUIREMENTS-ALIGNMENT.md#52-综合判断社交状态校准投入与预期已确认).

## D-046 — Social judgment is requested by the owner, without proactive relationship follow-up

**Decision:** When the owner asks for social judgment or conversation advice, Stella retrieves
relevant history and current evidence to deliver the calibrated assessment and practical answer
required by D-045. Saved context should not have to be supplied again for every request.

Stella does not proactively follow relationships or initiate reminders because new relationship
material or state changes are found. This is a settled scope boundary, not an unresolved follow-up
feature. It does not cancel established data organization, understanding updates, or other accepted
proactive capabilities; those capabilities must respect this specific relationship boundary.

## D-047 — Writing support helps the owner organize ideas into a path they can write

**Decision:** Stella helps organize article ideas so the owner can start writing and continue with
a coherent train of thought. The capability must work before a complete draft exists; post-draft
editing alone does not meet the need. It can draw on relevant saved ideas and material under the
established memory and provenance rules. A request to organize ideas does not itself request a
fully generated article; drafting and rewriting follow the actual request.

When work already exists in the personal repository, retrieve the relevant proposal, outline,
draft, related sources, and available intent or revision-feedback notes before asking the owner to
restate saved context. Unpublished work is part of the required writing retrieval scope, including
material outside the legacy corpus registry, without changing its publication status or permissions.
File status and visible structural gaps do not establish why the owner stopped or whether existing
prose reflects an accepted expression; material uncertainty is clarified with the owner.

The owner identified a concrete difficulty continuing the latter part of an article and bringing
it to a close. Support therefore includes resuming an interrupted argument and connecting existing
reasoning to an ending that fits the intended meaning. Candidate conclusions are proposals, not
established owner beliefs. The cause and useful intervention for one article must not be generalized
to all unfinished writing without further evidence.

When the owner clarifies an intent different from a proposed ending, revise the interpretation
instead of defaulting to positive meaning or motivational closure. Uncertainty about the ending
may concern an unresolved substantive question rather than phrasing. Keep that uncertainty visible;
distinguish facts, analogies, inferences, and value judgments while checking the argument. Respecting
authorial intent does not establish every claim as true, and questioning a claim does not authorize
replacing the owner's meaning with the assistant's preferred conclusion.

Personalization learns from specific writing difficulties and feedback about helpful collaboration,
without inferring a fixed workflow from a single label. Under D-034, usefulness is judged through
the owner's experience of clearer thinking and easier writing, not output volume or automatic
outline scores.

The owner has now confirmed the collaboration through an actual article discussion: recover saved
context, understand the author's premises, check argument connections, reason together through
specific sticking points, incorporate corrections, and organize a path the owner can continue
writing. Clarification and synthesis may alternate; the owner need not settle every idea alone
before receiving help. Confirmed premises are used directly instead of repeatedly requested.
This settles the collaboration pattern. It does not declare article completion, accept every
candidate conclusion, or establish that Core already implements the capability. See [the writing support requirement](09-REQUIREMENTS-ALIGNMENT.md#12-写作思路梳理已确认).

## D-048 — Use social judgment and collaborative writing for this requirements round

**Decision:** The owner has no additional core scenario to add for now. Continue the current
architecture examination with on-request social judgment and collaborative writing; finding a
third scenario is not a prerequisite. This settles the representative scenarios for this round,
without cancelling the full-product goals or declaring a new Alpha delivery scope.

Both scenarios require retrieving original personal evidence, recovering current context, applying
owner corrections, and preserving unfinished understanding. Their response semantics remain
distinct: calibrated social assessment versus collaborative reasoning that helps the owner write.
The source format, retrieval and synchronization contracts are technical design work to ground in
the repository and target Host capabilities, not reasons to reopen confirmed product constraints.

## D-049 — One current baseline separates requirements, contracts and evidence

**Decision:** docs/10-DESIGN-BASELINE.md owns current document authority and common correctness gates.
docs/09 owns product requirements; contracts own data/state invariants; docs/05-ALPHA-PLAN.md owns
Alpha scope and acceptance. Closed Issues, old handoffs and implementation limits do not override
new settled requirements or provide authorization for a new task. This replaces duplicated and
conflicting exit criteria without discarding historical receipts as regression evidence.

## D-050 — Four shared memory contracts connect originals to current understanding

**Decision:** Memory Lifecycle defines ingest, retrieve, learn and synchronize; Portable Registries
defines discovery and instance configuration. OpenClaw remains the recording, model, search,
execution and scheduling infrastructure. Core supplies semantic judgment and consistency adapters.

Original bytes, role-level evidence, scoped understanding and derived views have distinct contracts.
OngoingWork preserves unfinished reasoning independently of an action Episode. LearningChange
records why an interpretation changes, including refusal reasons and author corrections before an
outcome exists. These contracts settle the previously open technical design in D-031/D-037/D-038;
they do not claim archive adapters or source-change propagation are already implemented.

## D-051 — Episode v2 and response semantics replace action-only completion

**Decision:** answer, clarification, collaboration, action_advice and outcome_ack have distinct
completion conditions. A necessary clarification is valid; collaboration need not invent an
action or outcome. Episode v2 requires actual-action evidence and permits unknown action time as null.
Recommended records saved advice, not proof of delivery. Closed requires actual, outcome and an
evidence-based learning assessment; a natural event can produce no_change.

This refines D-027 and supersedes the v1 inferred-action allowance, mandatory predictions and
action-only completion assumptions. v1 is an explicit migration input; new runtime activation must
use the completed v2 contract without dual writes or fallback. Immutable historical predictions
remain protected under D-015.

## D-052 — Historical input versions and current eligibility are separate

**Decision:** A recovery revision locates coherent current state. Historical traces pin the versions
actually used, retained at independently resolvable locations. Updating a Twin or moving a source
does not corrupt a past prediction. Source changes instead invalidate and semantically reassess
current dependent understanding and views.

Deletion prevents normal recall through stale summaries, caches or Git history; it does not rewrite
sealed predictions or require automatic physical history erasure. This clarifies D-014/D-015/D-023
and the source-drift rule; matching a current file hash is not historical integrity validation.
Generation switching, CAS and idempotent recovery follow the shared synchronization contract.

## D-053 — Required persistence must precede final business delivery

**Decision:** Use limited reply_dispatch completion coordination over the Host's normal Agent Loop,
with a trusted run permit, explicit durable receipts and Host dispatcher. This supersedes the former
blanket exclusion of reply_dispatch in the integration design, because soft finalize/end callbacks
cannot alone enforce persistence-before-completion. It does not replace OpenClaw's Agent Loop.

Exact Host fault injection must prove takeover failure is blocked, cancellation prevents late
delivery, critical write failure cannot report success and unknown delivery remains observable.
An unproven adapter cannot activate the corresponding write profile. Normal writes preserve their
declared bounded RPO; a local receipt is not a remote durability claim.

## D-054 — Alpha learning is disjunctive; empty restore state is valid

**Decision:** The Alpha learning fixture demonstrates a supported Twin OR Praxis update and its later
use. It does not require every real outcome to change a Twin. A production restore validates exactly
the selected revision's declared set, which may be empty; separate nonempty fixtures prove important
open-state recovery. Optional unavailable capabilities do not justify a runnable degraded instance.

These rules replace conflicting mandatory-Twin, always-nonempty and degraded-activation language.
Automated assertions, semantic diagnostics and owner feedback remain separate under D-034. Historical
candidate receipts do not certify the newly defined assertions.
