# Framework IR Contract

## 1. Purpose

Framework IR converts an owner-authored thinking framework into compact executable cognitive operators usable by the Stella Cortex.

It is a derived artifact. The original CangHai framework source remains canonical.

## 2. Separation of concerns

```text
Framework Source   = what the owner actually believes/wrote
Framework IR       = Stella's compiled operational interpretation
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

## 6. Compilation

Compilation happens when the canonical source changes, not on every conversation turn.

Expected pipeline:

```text
CangHai source
→ parse
→ compile with versioned compiler
→ validate IR
→ register
→ runtime selection
```

The IR is rebuildable and therefore does not have to be a personal-data authority by itself, but CangHai must retain the canonical source required to recreate it.

## 7. Praxis feedback

Experience-derived refinements are stored as separate Praxis notes/playbook learning.

A stable repeated refinement may later be proposed back to the owner as a possible source-framework update, but that is a distinct action.
