# Same-package CI verification

CI builds and packs once, then runs the existing 81 Dreaming-disabled synthetic
Host cases in seven independent jobs. The native Active Memory and session/Wiki
producers stay with their artifact consumers. Four main-plugin shards retain two
workers each; no individual probe assertion or timeout changes.

`prepare` runs `check`, `check:schemas` and the complete unit suite. It freezes the
tarball, compiled runtime, compiled fixtures, tracked-source manifest and actual
checkout SHA. Each shard checks out that exact SHA, restores those compiled bytes
without recompiling, verifies their manifests, and installs the same tarball in a
fresh consumer with OpenClaw 2026.8.2. All original source, installed package,
Host, dependency and consumer-lock immutability checks still apply.

The `verify` job always runs and requires successful preparation and matrix jobs,
all seven receipts, all 81 unique assigned cases, matching source/package/harness
identities and every integrity check. It then runs the original Host memory
evidence alignment. A failed, cancelled, skipped, missing or duplicate result
cannot pass. Push builds use the actual branch checkout; pull-request builds use
the actual merge checkout, so their package identities are expected to differ.

Every case records its running state before launch and its final status, elapsed
time and script hash on completion. Receipts are atomically replaced; child logs
stream to the artifact directory while running. SIGINT/SIGTERM records cancellation
and not-run cases. A forced kill may leave a running receipt, which the aggregate
rejects. `always()` upload steps preserve partial receipts and diagnostics when the
runner can execute cleanup. Runner loss can still prevent an upload; the missing
artifact is a hard aggregate failure.

Artifacts:

- `stella-prepared`: immutable tarball, descriptor and compiled harness/runtime.
- `stella-prepare-receipt`: check/test logs and preparation integrity manifests.
- `stella-shard-*`: incremental case receipts, per-case stdout/stderr and manifests.
- `stella-aggregate`: final mandatory coverage and Host-alignment verdict.

Local full verification remains `npm run verify`. To exercise CI entry points in
fresh checkouts of the same clean revision:

```sh
npm run test:package -- --prepare .artifacts/ci/prepared
npm run test:package -- --shard memory-access --prepared .artifacts/ci/prepared
```

Transfer the prepared directory to each fresh shard checkout before the second
command. Compiled output must not already exist. Set
`STELLA_ACCEPTANCE_RECEIPT_PATH` to retain receipts outside temporary consumers.
The aggregate CLI requires downloaded artifact directories and explicit CI job
conclusions through `STELLA_CI_JOB_RESULTS`; it never assumes missing jobs passed.

These changes affect verification orchestration only. Dreaming remains explicitly
disabled, actual target entrance qualification remains blocked, and
`issue23Complete`, `fullMemoryAccepted`, `privateMainAccepted` and
`realModelAccepted` stay false.
