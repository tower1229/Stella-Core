# CangHai as the Portable Personal Data Plane

## 1. Boundary

CangHai is the durable personal-data home for Stella.

The governing rule is:

> If data has durable influence over how Stella understands, predicts, advises, or acts for the owner, it must have a portable representation in CangHai.

This is broader than “only confirmed facts belong in CangHai” and narrower than “all runtime state belongs in Git.”

## 2. What belongs in CangHai

Examples:

- raw and normalized personal experiences;
- important conversation/life event archives;
- owner-authored thinking frameworks;
- durable Twin hypotheses;
- relationship-specific interaction models that affect future guidance;
- Praxis episodes, actions, outcomes, and retrospective ratings;
- learned personalized strategies/playbooks;
- model/evaluation reports needed to reconstruct Stella's learned understanding.

## 3. What does not need to be committed

Rebuildable runtime artifacts can remain in OpenClaw/runtime storage:

- FTS indexes;
- vector indexes;
- embeddings when reproducible;
- prompt caches;
- temporary state estimates;
- transient traces;
- active session state;
- temporary subagent output.

A runtime representation becoming important to long-term personalization is the trigger for creating a portable CangHai form.

## 4. Relationship to Stella-Core

`Stella-Core` is public and contains code, protocols, schemas, compiler logic, and evaluation harnesses.

It must not copy private CangHai content, personal facts, relationship details, raw private conversations, or model artifacts containing private data.

## 5. Proposed logical organization

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
└── evaluation/
    ├── predictions/
    ├── twin/
    ├── praxis/
    └── regressions/
```

This is a logical target, not a command to immediately relocate every existing `30_RAG` file.

## 6. Migration principle

Existing Stella 1.0 assets are valuable cold-start data and must retain provenance.

Initial mapping:

- `USER.md` → Twin bootstrap projection;
- `MEMORY.md` → Twin/experience bootstrap;
- `model-seed/` → Twin hypotheses and supporting evidence;
- `self-reflection/` → Twin training evidence;
- `life-log/` → episodic experience;
- `relationship/` → social episodes / relationship interaction models;
- `health/` → state-model evidence;
- `writing/` → writing contextual self/style evidence;
- `work/` → work contextual self evidence;
- `frameworks/` → Framework Compiler canonical source.

Migration should re-role assets before rewriting them. Do not destroy original provenance merely to satisfy a new directory taxonomy.

## 7. Persistence cadence

Durable personal learning should be written promptly to the local CangHai working tree, but Git commits may be batched.

Suggested distinction:

```text
filesystem write = durability
Git commit       = version history / synchronization
```

For example, daily or N-event commits can avoid producing a noisy Git history while preserving immediate local durability.
