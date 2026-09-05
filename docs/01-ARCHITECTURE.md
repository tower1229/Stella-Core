# Stella 3.0 Architecture

Current authority and acceptance: [design baseline](10-DESIGN-BASELINE.md). Data formats and the complete memory flow are defined by [Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md) and [Portable Registries](contracts/PORTABLE-REGISTRIES.md).

## 1. System view

```text
                         ┌──────────────────────┐
                         │    Personal Twin     │
                         │  how the owner works │
                         └──────────┬───────────┘
                                    │
                                    ▼
┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ Framework Compiler  │──▶│     Praxis Loop      │◀──│ Reality / Social    │
│ how the owner judges│   │ what to do in reality│   │ how the world works │
└─────────────────────┘   └──────────┬───────────┘   └─────────────────────┘
                                    │
                                    ▼
                              Action / Outcome
                                    │
                                    ▼
                            Continuous Learning
```

## 2. Runtime architecture

Stella 3.0 uses one OpenClaw runtime plugin, `stella-core`; Cortex names its shared cognitive architecture.

```text
OpenClaw Agent Loop
        │
        ▼
┌──────────────────────────────────────────┐
│              Stella Cortex              │
│                                          │
│ Turn Router                              │
│ Situation Builder                        │
│ Twin Context Builder                     │
│ Framework Runtime                        │
│ Reality Intelligence                     │
│ Praxis Controller                        │
│ Learning Recorder / Consolidator         │
└───────────────────┬──────────────────────┘
                    │
         ┌──────────┼────────────┐
         ▼          ▼            ▼
      CangHai   OpenClaw Memory  External Reality
```

OpenClaw remains responsible for the generic agent loop, sessions, transcripts, compaction, tool execution, channels, automations, permissions, and low-level memory infrastructure.

Stella Cortex owns the personal cognitive behavior layered on top.

## 3. Consciousness portability invariant

Stella Core is a replaceable runtime implementation. CangHai is the portable carrier of Stella's durable personal consciousness.

The required recovery property is:

```text
fresh server
+ compatible OpenClaw
+ Stella Core
+ CangHai personal data and Stella configuration
→ rebuild indexes / projections / runtime caches
→ restore Stella's core consciousness
```

Recovery does **not** require old OpenClaw sessions, transcripts, SQLite runtime databases, prompt caches, or other machine-local execution state.

“Core consciousness” means the durable information that changes how a fresh Stella instance understands the owner, reasons from the owner's frameworks, predicts behavior, and applies learned praxis. It includes at least:

- identity/persona and stable interaction configuration;
- owner-authored frameworks and the exact active operational representation when needed for reproducibility;
- durable Twin hypotheses and model state;
- durable relationship/interaction models;
- Praxis episodes, outcomes, learned strategies, and open high-value episodes that should survive a restart;
- durable goals, commitments, or state that materially affects future behavior;
- Stella-specific runtime profile/configuration required to reconstruct the same cognitive behavior.

Transient working context is not part of core consciousness. Examples include:

- active chat sessions and raw conversational continuity that has not been promoted to durable personal data;
- prompt assembly state;
- temporary inferred mood/state estimates;
- FTS/vector indexes and reproducible embeddings;
- execution traces and temporary subagent results.

The architecture must be tested against destructive runtime loss: deleting the Stella/OpenClaw runtime host must not destroy any durable learning that is necessary to reconstruct Stella's identity and learned behavior.

## 4. Data planes

### Stella-Core

Public runtime, schemas, compiler logic, evaluation harness, and architecture.

It must contain no copied private personal corpus.

### CangHai

Portable Personal Data Plane and durable consciousness store.

Anything that has durable influence over how Stella understands, predicts, advises, or acts for the owner must have a portable representation in CangHai.

Examples:

- personal experiences;
- framework sources;
- Twin hypotheses;
- important relationship models;
- Praxis episodes and outcomes;
- learned personalized strategies;
- durable goals/open loops that must survive runtime loss;
- Stella instance configuration and portable runtime profile;
- evaluation history and model checkpoints when portability requires them.

### OpenClaw runtime state

Rebuildable execution state:

- SQLite runtime state;
- search indexes;
- FTS/vector indexes;
- embeddings where reproducible;
- prompt state;
- temporary inferred state;
- execution traces;
- active sessions.

These do not automatically belong in CangHai.

## 5. Four cognitive systems

### Personal Twin

Maintains context-relevant hypotheses and predictions rather than a static biography.

It eventually includes:

- stable self;
- contextual selves;
- dynamic state estimation;
- behavioral policy;
- prediction ledger.

Alpha does not require fine-tuning. Retrieval + structured hypotheses + prediction/outcome data are sufficient.

Writing support is one use of this personal context: understand what the owner wants to express,
retrieve relevant saved ideas and material, and help organize a coherent path into writing even
before a draft exists. Adapt the collaboration to feedback about actual sticking points and useful
help. Existing article work is recovered from its proposal, outline, draft, related material, and
available intent or revision-feedback notes before asking the owner to repeat saved context.
Unpublished work must be accessible for this purpose even when it is outside the legacy registered
corpora; retrieval does not publish it. File status alone does not establish the owner's reason for
stopping or acceptance of drafted text. Editing an existing draft alone does not satisfy this
requirement, and an idea-organization request does not by itself request a complete generated article.
Support also covers resuming an argument that stalls midway and finding an ending connected to
the article's intended meaning. Proposed conclusions remain candidates until the owner accepts them;
they are not evidence of the owner's existing views. Owner clarification revises the interpretation;
unresolved questions remain open rather than receiving a default positive or motivational ending.
Argument checks distinguish facts, analogies, inferences, and values without substituting the
assistant's preferred meaning. The owner has confirmed the collaboration pattern: recover saved
context, understand authorial premises, check argument connections, reason together through specific
sticking points, incorporate corrections, and organize a path the owner can continue writing.
Clarification and synthesis can alternate without requiring a fully settled argument upfront.
This uses the shared Cortex and memory responsibilities. Approval of the collaboration does not
establish article completion or acceptance of every proposed conclusion. See [the writing support requirement](09-REQUIREMENTS-ALIGNMENT.md#12-写作思路梳理已确认).

### Framework Compiler

Compiles owner-authored thinking frameworks into executable operators.

Separates:

1. canonical framework source;
2. derived Framework IR;
3. learned Praxis notes about applying the framework.

Stella may proactively challenge a framework with specific evidence, explain its applicability
limits, and propose revisions while distinguishing factual understanding from value tradeoffs.
The owner decides formal changes. Proposals stay separate from canonical source and active IR
until adopted; see [the Framework IR contract](contracts/FRAMEWORK-IR.md#8-praxis-feedback).

### Reality / Social Intelligence

Combines three sources:

1. base-model world knowledge;
2. live external grounding where current/specific facts matter;
3. personalized Praxis experience accumulated from real outcomes.

Its purpose is to supply experience the owner does not yet have, not to redefine the owner's values.

Social judgment is invoked when the owner asks for help and combines original interaction evidence
over time with relevant personal context. It retrieves saved background and current evidence for
that request; it does not proactively follow relationships or send unsolicited relationship updates.
It assesses reciprocity, initiative, substantive responses, follow-through, and changes in investment,
then relates that assessment to the owner's expectations and plans through Twin and Praxis. Age,
life stage, personality, and roles provide context; labels do not establish motives or override
contrary behavioral evidence. Courtesy and interest in a topic do not establish sustained relational
investment. Advice must make unsupported expectations and investment risks clear, with practical
options and uncertainty proportionate to the evidence. See [the confirmed social judgment requirement](09-REQUIREMENTS-ALIGNMENT.md#52-综合判断社交状态校准投入与预期已确认).

It also supports autonomous learning around the owner's actual questions and long-term goals:
identify a knowledge or experience gap, research within existing access permissions, relate findings
to personal context, and retain useful source material in CangHai with its relevance and potential
decision use. Source selection requires structured semantic judgment under the repository invariants.
Retained external material remains external evidence; it does not become a fact about the owner.

### Praxis Loop

The primary product loop:

```text
Situation
→ Twin
→ Framework
→ Reality
→ option simulation
→ action/advice
→ outcome
→ learning
```

Autonomous research feeds this loop through better advice, questions, and candidate strategies.
Owner choices, explanations, rejection reasons, and actual outcomes then help assess applicability
and update personal understanding. Durable research can therefore support later situations as well
as the immediate request. This is a product requirement; collection volume and automated scores do
not establish its real usefulness, which is judged through owner feedback in use.

The full Praxis product can also execute work under explicit owner delegation. Repeated actions
within an authorized matter or class of work proceed without renewed confirmation; out-of-scope
decisions return to the owner. OpenClaw provides execution, scheduling, and permission facilities.
Learning from acceptance improves judgment but does not expand authority. The current Alpha remains
advice/preparation only.

## 6. Why one Cortex instead of four agents

Persistent independent agents would each develop partial views of the owner and create coordination drift.

The four systems instead share one turn context and one owner model. Temporary subagents are allowed only for bounded work such as:

- external reality research;
- multi-perspective simulation;
- deep cross-session recall.

Subagents receive the minimum brief required for their task rather than the full Personal Twin.

## 7. Memory responsibilities across the two confirmed scenarios

The current requirements round uses on-request social judgment and collaborative writing to examine
the shared architecture. These are representative scenarios, not a reduction of the full product
to two features or a change to the current Alpha release scope. The implementation evidence is
recorded separately in [the requirements audit](09-REQUIREMENTS-ALIGNMENT.md#96-两个场景收敛后的实现复核).

### Storage roles

The same memory needs to preserve several kinds of information without forcing them into one schema:

| Logical role | Social judgment | Collaborative writing | Persistence responsibility |
| --- | --- | --- | --- |
| Original evidence | Messages, attachments and later owner reports | Proposals, drafts, references and discussion | Preserve originals in CangHai with source identity and time; reuse Host recording and archive facilities |
| Facts and observations | Who did what, when, and in which context | Existing text, explicit author statements and recorded revisions | Distinguish direct observation, reported information and model interpretation at content level |
| Revisable understanding | Relationship-state hypotheses and supporting or contrary evidence | Interpretation of author intent, candidate arguments and detected gaps | Preserve scope and dependencies; model suggestions are not automatically owner beliefs |
| Durable context for ongoing work | Current question, relevant history, unresolved uncertainty and prior corrections | Confirmed premises, rejected interpretations, open reasoning and current writing position | Use CangHai durable-state/open-work responsibilities; do not require a closed action Episode to retain progress |
| Retrieval views | Search indexes, summaries and situation projections | Search indexes, article-context projections and material links | Rebuild from current valid sources and reconcile source changes |

The ongoing-work row is a logical responsibility within the existing Cortex and data plane, not a
new persistent agent or a second session database. Reuse existing article context files and Host
state where their contracts fit. OngoingWork serialization, LearningChange and synchronization follow
the Memory Lifecycle contract. Full conversation retention supplies evidence; resuming work also requires finding the
relevant current state without repeating already-resolved questions.

### Inputs and coverage

All confirmed input routes must feed the same provenance and update responsibilities: daily
conversation, explicit recording, imports and attachments, direct repository edits, and authorized
external material. An ingestion path must make its actual coverage and failures visible. A file
being present, a corpus registry being valid, and content being retrievable are separate properties.

Writing makes the legacy coverage gap concrete: in-flight articles and their companion files must
be usable even though they are outside the old unified corpus. Supporting them does not require
moving originals into a new directory or changing their publication status. Social judgment
similarly needs original interaction evidence, not only a person's curated profile.

### Evidence retrieval and response

The shared cognitive process is:

```text
Owner request
→ recover relevant current context and source availability
→ plan and perform Host searches / original-source reads
→ follow material leads, check counterevidence and reconcile time / identity / provenance
→ clarify unresolved information that could change the answer
→ produce the situation-appropriate judgment or writing collaboration
→ incorporate owner feedback and preserve the resulting context
```

Stella supplies semantic planning and evidence judgment; OpenClaw supplies the applicable file,
search, session, model and execution infrastructure. Keep those responsibilities separate from
the selected Host adapters. The versioned integration seams and remaining proof obligations are in
[OpenClaw integration](04-OPENCLAW-INTEGRATION.md); API availability alone is not completion evidence.

A compact response or context projection comes after sufficient evidence work. Candidate-count
limits, prompt size and a convenient number of retrieved items do not establish sufficiency. The
retrieval contract requires an explicit stopping judgment: material claims have support or visible
uncertainty, relevant available contrary or newer evidence has been checked, and no known unresolved
lead is being dropped merely to meet a small packet budget. Missing material facts call for
clarification; unavailable sources and resource failures remain diagnosable failures, not findings
that evidence does not exist.

### Learning during an unfinished interaction

An owner clarification can change the applicable understanding before any external action or final
outcome exists. Apply it in the current context, retain its original evidence, and reconcile affected
durable understanding. A broader personal hypothesis remains subject to scope and further evidence.
Repeated summaries of the same correction must not create independent support.

Decision/action Episodes keep their prediction and outcome guarantees. Writing collaboration and
other ongoing reasoning must also preserve progress without inventing an action, prediction or
closure solely to fit that lifecycle. Approval of helpful collaboration does not imply agreement
with every suggested claim or a completed article. Social judgment remains owner-triggered; a need
for better evidence does not authorize proactive relationship follow-up.

These responsibilities extend the full-product design. They are not claims that the current
candidate selection, Episode learning or recovery tests already satisfy the two complete scenarios.
