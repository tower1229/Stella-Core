# Framework IR Contract

## 1. Purpose

Framework IR converts an owner-authored thinking framework into compact executable cognitive operators usable by the Stella Cortex.

The original CangHai framework source remains canonical as the owner's authored thought. The **active compiled IR is a versioned execution snapshot** and must also have a portable representation in CangHai when it can durably influence Stella's behavior.

## 2. Separation of concerns

```text
Framework Source   = what the owner actually believes/wrote
Framework IR       = Stella's versioned compiled operational interpretation
Praxis Note        = what Stella learned while applying it in reality
```

Praxis learning must not silently rewrite the source.

## 3. Required semantics

```ts
interface FrameworkIR {
  schemaVersion: string;
  id: string;
  name: string;

  source: {
    ref: string;
    contentHash: string;
    sourceVersion?: string;
  };

  compiler: {
    version: string;
    model?: string;
    promptHash?: string;
  };

  cognitiveJobs: string[];

  detection: {
    positiveSignals: string[];
    negativeSignals?: string[];
  };

  operators: FrameworkOperator[];

  failureModes: Array<{
    name: string;
    description: string;
    mitigation?: string;
  }>;

  actionTranslation?: string[];

  domainHints?: string[];
  exampleRefs?: string[];

  compiledAt: string;
  activatedAt?: string;
}

interface FrameworkOperator {
  id: string;
  purpose: string;
  questions?: string[];
  transforms?: string[];
  outputHints?: string[];
}
```

## 4. Selection principle

Framework runtime selects by **cognitive job**, not by philosophical keyword similarity.

Normally a Praxis turn should use zero to two operators.

A framework can be relevant while still being intentionally unused if another operator is more directly sufficient.

## 5. Failure modes are first-class

Every important framework should encode known misuse patterns.

Example:

```yaml
failure_modes:
  - name: spiritual_bypass
    description: using impermanence to deny concrete harm or boundary violations
  - name: analysis_avoidance_inversion
    description: using “direct experience” as an excuse for impulsive action
```

This allows Stella to practice the framework rather than blindly quote it.

## 6. Compilation and activation

Compilation happens when the canonical source changes or when the compiler is intentionally upgraded, not on every conversation turn.

Expected pipeline:

```text
CangHai source
→ parse
→ compile with versioned compiler/model/prompt
→ validate IR
→ persist compiled snapshot in CangHai
→ activate exact IR version
→ register for runtime selection
```

Why persist the IR even though it is derived:

- an LLM compiler may not be bit-for-bit deterministic;
- a future compiler/model can interpret the same source differently;
- Stella must be able to explain which operational interpretation affected a past decision;
- moving to another runtime should not silently change the owner's effective praxis framework.

The source remains the authority for “what the owner said.” The active IR is the authority for “what Stella executed at that time.”

## 7. Suggested CangHai representation

A future framework entity may look like:

```text
frameworks/<framework-id>/
├── framework.md
├── compiled/
│   ├── <ir-version>.json
│   └── ...
└── praxis-notes/
    └── ...
```

The exact path is not frozen by this document.

## 8. Praxis feedback

Experience-derived refinements are stored as separate Praxis notes/playbook learning.

A stable repeated refinement may later be proposed back to the owner as a possible source-framework update, but that is a distinct action.
