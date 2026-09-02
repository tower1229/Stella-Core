# CangHai as the Portable Personal Data Plane

## 1. Boundary

CangHai is the durable personal-data home and consciousness store for Stella.

The governing rule is:

> If data has durable influence over how Stella understands, predicts, advises, or acts for the owner, it must have a portable representation in CangHai.

This is broader than “only confirmed facts belong in CangHai” and narrower than “all runtime state belongs in Git.”

A fresh Stella deployment must be reconstructable from CangHai without restoring the old OpenClaw runtime host.

## 2. Recovery invariant

The recovery target is **core consciousness**, not process state.

Required recovery path:

```text
CangHai
+ Stella-Core
+ compatible OpenClaw
+ new server
→ validate personal-data/config snapshot
→ rebuild projections/indexes/embeddings
→ start Stella
→ recover durable identity, Twin, frameworks, Praxis learning, and durable open state
```

Old sessions and transcripts are optional historical evidence, not a required dependency for recovery.

If a runtime-only record becomes necessary to reproduce Stella's learned behavior after a total server loss, that record has been misclassified and must gain a portable CangHai representation.

## 3. What belongs in CangHai

Examples:

- raw and normalized personal experiences;
- important conversation/life event archives where intentionally retained as personal evidence;
- owner-authored thinking frameworks;
- active Framework IR snapshots when required to reproduce actual cognitive behavior;
- durable Twin hypotheses;
- relationship-specific interaction models that affect future guidance;
- Praxis episodes, actions, outcomes, and retrospective ratings;
- learned personalized strategies/playbooks;
- open/high-value Praxis episodes that should survive restart;
- durable goals, commitments, constraints, and other state that should survive runtime replacement;
- Stella identity/persona configuration;
- Stella-specific runtime profile and portable plugin configuration;
- model/evaluation reports needed to reconstruct Stella's learned understanding;
- non-reproducible personalized model artifacts/checkpoints if they ever become part of Stella's durable cognition.

Secrets should not be embedded in ordinary portable configuration. Configuration should reference secrets through restorable external secret mechanisms where possible.

## 4. What does not need to be committed

Rebuildable runtime artifacts can remain in OpenClaw/runtime storage:

- FTS indexes;
- vector indexes;
- embeddings when reproducible;
- prompt caches;
- temporary state estimates;
- transient traces;
- active session state;
- compaction state;
- temporary subagent output;
- OpenClaw SQLite databases whose contents are reconstructable from CangHai plus fresh runtime activity.

A runtime representation becoming important to long-term personalization is the trigger for creating a portable CangHai form.

## 5. Relationship to Stella-Core

`Stella-Core` is public and contains code, protocols, schemas, compiler logic, recovery logic, and evaluation harnesses.

It must not copy private CangHai content, personal facts, relationship details, raw private conversations, or model artifacts containing private data.

Stella-Core defines **how** cognition runs. CangHai contains the owner-specific data/config that determines **which Stella** is reconstructed.

## 6. Proposed logical organization

The exact physical migration is not frozen yet. The target logical roles are:

```text
30_PersonalData/
├── experience/
│   ├── life/
│   ├── conversations/
│   ├── relationships/
│   ├── health/
│   ├── work/
│   ├── writing/
│   └── decisions/
├── twin/
│   ├── stable/
│   ├── contextual-selves/
│   ├── behavioral-models/
│   ├── relationship-models/
│   └── hypotheses/
├── frameworks/
│   ├── worldview/
│   ├── epistemic/
│   ├── decision/
│   └── practice/
├── praxis/
│   ├── episodes/
│   ├── experiments/
│   ├── outcomes/
│   └── playbook/
├── state/
│   ├── goals/
│   ├── commitments/
│   └── open-loops/
├── stella/
│   ├── identity/
│   ├── runtime-profile/
│   └── active-manifest/
└── evaluation/
    ├── predictions/
    ├── twin/
    ├── praxis/
    └── regressions/
```

This is a logical target, not a command to immediately relocate every existing `30_RAG` file.

## 7. Migration principle

Existing Stella 1.0 assets are valuable cold-start data and must retain provenance.

Initial mapping:

- `USER.md` → Twin bootstrap projection;
- `MEMORY.md` → Twin/experience bootstrap;
- `SOUL.md` / identity configuration → Stella identity/persona seed;
- `openclaw.json` and Stella-specific configuration → portable runtime-profile seed after removing machine-local/secret material;
- `model-seed/` → Twin hypotheses and supporting evidence;
- `self-reflection/` → Twin training evidence;
- `life-log/` → episodic experience;
- `relationship/` → social episodes / relationship interaction models;
- `health/` → state-model evidence;
- `writing/` → writing contextual self/style evidence;
- `work/` → work contextual self evidence;
- `frameworks/` → Framework Compiler canonical source.

Migration should re-role assets before rewriting them. Do not destroy original provenance merely to satisfy a new directory taxonomy.

## 8. Persistence cadence

Durable personal learning should be written promptly to the local CangHai working tree, but Git commits may be batched.

Suggested distinction:

```text
filesystem write = local durability
Git commit/push   = versioned off-host recoverability
```

For example, daily or N-event commits can avoid producing a noisy Git history while preserving immediate local durability.

For the recovery invariant to hold against full server loss, durable changes must eventually reach an off-host CangHai remote; local unpushed files are not sufficient.

## 9. Recovery acceptance test

A release must eventually pass a destructive recovery test:

1. start from an empty server without old Stella/OpenClaw runtime state;
2. install a compatible OpenClaw and Stella-Core;
3. obtain CangHai and required external secrets;
4. run Stella restore/bootstrap;
5. rebuild all rebuildable runtime artifacts;
6. verify identity/persona, active frameworks, Twin hypotheses, Praxis learning, and durable open state;
7. run a fixed continuity evaluation against the previous deployment.

The test does not require old sessions to be restored.
