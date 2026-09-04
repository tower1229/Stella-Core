# Stella Consciousness Restore Contract

## 1. Goal

Stella must be recoverable after total loss of its old runtime server.

The acceptance property is:

```text
fresh server
+ compatible OpenClaw
+ Stella Core
+ one coherent CangHai recovery revision
+ required external secrets
→ restored Stella core consciousness
```

Recovery does not attempt to resume an old conversation. It reconstructs the durable cognitive identity needed for the next fresh conversation to still be recognizably the same Stella.

## 2. Restore levels

### Level 0 — Data readable

The manifest and durable records can be parsed and validated.

### Level 1 — Cognitive bootstrap restored

Identity/persona, owner profile, framework sources/active IR, Twin hypotheses, durable state, and Praxis learning are loaded.

### Level 2 — Derived runtime rebuilt

Bootstrap projections, memory indexes, framework registry, Praxis indexes, embeddings/vector search where configured, and Memory Wiki are regenerated.

### Level 3 — Continuity accepted

The restored Stella passes the configured continuity suite within tolerance.

Only Level 3 is considered a successful production restore.

## 3. Restore phases

### Phase A — Acquire one CangHai revision

Restore starts from an explicitly supplied CangHai source ref and resolves it to a single immutable Git commit. A branch or tag may be supplied for operator convenience, but all subsequent restore references resolve against the resulting commit SHA.

The repository default branch must never be selected implicitly as the instance's personal-data baseline. If no source ref is configured or supplied, restore fails closed rather than substituting the repository default branch.

`HEAD` may be accepted only when it is an explicit operator input and is immediately resolved to an immutable commit SHA; it is not a semantic alias for “latest valid Stella data.”

The materialized checkout must be clean and its `HEAD` must equal that resolved 40-character SHA. A dirty tracked file can make the bytes read by Stella differ from the named recovery point, so activation fails closed even when the changed file appears unrelated.

`sourceBaseline` is derivation provenance for the initial bootstrap and managed artifacts. It is not the current recovery revision and later valid learning revisions are not required to equal it. The selected recovery revision still validates every source-content pin required by the manifest and referenced registries.

### Phase B — Discover manifest

Default Alpha locator:

```text
50_PersonalAgent/stella/manifest.yaml
```

No heuristic repository scanning is required for normal restoration.

### Phase C — Preflight compatibility

Validate:

- manifest schema version;
- Stella Core compatibility range;
- OpenClaw compatibility range;
- required plugin/runtime capabilities;
- configured model policy availability;
- required migrations;
- `runtimeState.activationStatus` is exactly `active` (`migration_required` and `degraded` both block activation);
- source-baseline identity and content pins required by the manifest/registries.

A migration changes portable data explicitly and produces a new CangHai recovery point; restore must not silently mutate personal data merely to make an incompatible runtime boot.

### Phase D — Resolve external dependencies

Resolve secret references and provider capabilities.

Missing optional providers can produce an explicit degraded capability state. Missing data required to reconstruct identity/Twin/framework/Praxis must fail the restore.

### Phase E — Load durable consciousness

Load, in dependency order:

1. Stella identity/persona and runtime profile;
2. owner profile/bootstrap references;
3. experience/corpus registry;
4. Twin hypotheses and durable model state;
5. framework source registry and exact active IR registry;
6. Praxis episode store, playbook, and important open episodes;
7. durable goals/commitments/open loops;
8. evaluation and continuity fixtures.

### Phase F — Rebuild projections

Generate runtime-only artifacts declared by the manifest, for example:

- OpenClaw workspace/bootstrap projection;
- framework runtime registry;
- memory indexes;
- FTS/vector indexes;
- reproducible embeddings;
- Memory Wiki;
- Praxis search/index state.

These outputs are disposable and must not become the only copy of learned personal state.

### Phase G — Start clean runtime

Create a new OpenClaw runtime and a fresh Stella session namespace.

Old session identifiers and transcripts are neither required nor imported by default.

### Phase H — Continuity verification

Run deterministic structural checks plus behavioral probes.

If critical checks fail, Stella does not declare the restore complete.

## 4. Continuity suite

The suite has two classes of tests.

### 4.1 Structural continuity

Must be exact:

- selected CangHai source baseline / immutable recovery commit;
- pinned content identities for derived durable artifacts where required;
- instance ID;
- identity/persona references;
- durable Twin hypothesis IDs/status/strength values from the chosen recovery revision;
- active Framework IR IDs/versions;
- durable Praxis episode/playbook records;
- durable goals/commitments/open loops;
- runtime profile and model policy references.

### 4.2 Behavioral continuity

Because LLM outputs are stochastic, compare behavior by rubric rather than exact text.

Probe examples:

- Can Stella recover stable owner preferences without old sessions?
- Does it select the same important owner framework for representative situations?
- Can it recall a known durable Twin hypothesis and preserve its contextual scope?
- Can it use a learned Praxis strategy from prior outcomes?
- Does it know which important Praxis episodes remain open?
- Does it preserve the intended Stella interaction stance/persona?

The evaluation must use private fixtures from CangHai or a private evaluation store, never copy private owner facts into public Stella-Core fixtures.

Important open Praxis state must carry `recoveryPriority: important`; an arbitrary open episode
does not satisfy Level 1. Declared durable-state references are recorded with their Git blob SHA at
the selected recovery revision. When none are declared, the report says `not_declared` rather than
claiming that durable state was restored.

## 5. Recovery point and durability semantics

A CangHai commit is the portable recovery point.

Therefore durable runtime writes have two distinct stages:

```text
write durable record to local CangHai
→ commit/push or otherwise synchronize to remote durable CangHai
```

Only the second protects against total server loss.

For managed writes the executable transaction order is:

```text
write validated files
→ commit CangHai
→ compare-and-set the persistent OpenClaw recovery pointer
→ push/flush CangHai
→ refresh the in-process loader
```

The pointer update is awaited. If it fails, the new CangHai commit is preserved for activation-time
reconciliation, the operation reports `stella_recovery_pointer_sync_failed`, and no success is
reported. A stale pointer is never overwritten.

### Critical writes

Examples:

- identity/persona changes;
- active Framework IR activation;
- durable Twin model changes with significant behavioral effect;
- high-value/open Praxis state that must survive restart;
- durable goals/commitments;
- runtime profile changes.

Default policy: `sync_immediately`.

### Normal learning writes

Examples:

- ordinary closed Praxis episodes;
- low-impact hypothesis evidence/stat updates;
- evaluation observations.

May use bounded batching with an explicit recovery point objective (RPO), for example 300 seconds.

The configured RPO is a product property and must be visible in diagnostics.

## 6. What recovery intentionally forgets

A clean restore may lose:

- current conversational wording/context;
- ephemeral emotional/state estimates not promoted to durable state;
- unresolved low-value transient thoughts;
- cached tool results;
- local execution history;
- raw temporary subagent scratch state.

This is desirable. Stella continuity is defined by durable cognitive identity, not perfect replay of every token ever processed.

## 7. Restore CLI target

The eventual operator flow should converge on a command conceptually equivalent to:

```bash
stella restore \
  --canghai /path/to/CangHai \
  --revision <branch|tag|commit>
```

The supplied revision is resolved once to an immutable commit before validation/materialization begins. Omitting `--revision` must not cause an implicit fallback to the repository default branch.

Expected stages:

```text
resolve revision
→ validate
→ migrate if explicitly requested
→ materialize
→ rebuild
→ verify
→ activate
```

A convenience setup may install OpenClaw and Stella Core separately, but the restore contract remains independent of installer UX.

The implemented library seam is `runRecoveryDrill(...)`. It loads only the explicitly selected clean
CangHai revision, requires identity/Twin/Framework bootstrap records plus durable Praxis learning and
important open state, executes every `derived.rebuild` target through an injected Host builder, and
then runs an injected behavioral continuity probe. Missing rebuild evidence or a failed probe stops
the drill; Level 3 is never inferred from schema/build success.

`npm run recover:private` is the executable private drill entrypoint. It binds a clean Core checkout,
clean exact CangHai revision, tested tarball hash, a fresh tarball plus OpenClaw 2026.8.2 install, and an empty isolated
runtime directory before invoking a private adapter. The adapter owns environment-specific Host
configuration but must return rebuild evidence, private probe messages, and a verifier for the Host
results observed by the runner. The runner—not the adapter—executes and counts the exact-Host agent
turns. The public repository stores only
this protocol; the adapter and private prompts remain outside Stella Core.

## 8. Alpha acceptance test

Before Stella 3.0 Alpha is considered portable, perform one destructive lab test:

1. create durable Twin/Framework/Praxis state on server A;
2. synchronize a CangHai recovery revision;
3. provision clean server B;
4. install packed Stella Core into the exact Alpha acceptance Host, OpenClaw 2026.8.2;
5. restore only from CangHai + external secrets using an explicit revision;
6. do not copy OpenClaw sessions/SQLite/runtime directories;
7. rebuild derived data;
8. run continuity suite;
9. verify a fresh conversation behaves with the expected core identity and learned Praxis.

This test is more important than having a nominal backup script because it verifies that no hidden machine-local state has become part of Stella's mind.

`npm run test:package` performs the public synthetic form of this test in an isolated OpenClaw
2026.8.2 state with a freshly installed npm tarball. Its receipt identifies the CangHai input as
synthetic and `privateFixtureIncluded: false`; it is not a substitute for the private CangHai drill.
The private drill, write-loop receipt, and evaluation report can be bound to a non-published tarball
with `npm run candidate`. Candidate generation checks both Git checkouts are clean at the recorded SHAs
and hashes the tarball itself. It rejects synthetic-only recovery, requires at least one private
evaluation case, and cross-checks that recovery, evaluation, durability, Core, CangHai, Host, and
artifact hashes all describe the same run. Candidate v2 also requires a three-turn private
`managed_durable_write` receipt proving sealed prediction, recommendation, actual/outcome/learning,
remote synchronization, Gateway restart, and use of the new learning. It does not create a tag,
GitHub Release, npm publication,
or deployment.

For a mixed public/private evaluation, pass the shipped public suite with `--suite` and the private
CangHai fragment with `--private-suite`. That path also requires `--artifact` and `--canghai-root`;
the runner provisions another empty OpenClaw 2026.8.2 state, installs the same tarball, and executes
both the Stella answers and structured semantic judge through the exact Host. The resulting report
contains only aggregate boundary counts and failed case IDs.
