# Domain Docs

How the engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- `CONTEXT-MAP.md` at the repository root if it exists; read each linked context relevant to the task.
- Relevant ADRs under `docs/adr/`.

If any of these files do not exist, proceed silently. Do not create empty domain documents upfront. The domain-modeling flow creates them lazily when terms or decisions are actually resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, proposal, hypothesis, test, or implementation, use the term as defined in `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a needed concept is not in the glossary, reconsider whether the new term is necessary or record the gap for domain modeling.

## Flag ADR conflicts

If work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the prior decision.
