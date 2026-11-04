# Retained evidence and view helpers

The old Praxis runtime, packet/router, Episode stores/state machine, outcome and question transaction orchestration have been retired. Git retains their original implementation and tests.

This directory currently retains evidence bundles, question evidence preparation, personal views, context-source reads and temporal-scope contracts used by data/retrieval/synchronization helpers. These are not a second Agent loop or a deployed runtime. Generic source reading lives in `src/canghai/evidence-reader.ts`; stable object references live in `src/canghai/ref.ts`.

The ordinary plugin has no runtime or type import from this directory. Retained helpers still require their own applicable data tests; this boundary does not prove MIG02 consumption or model semantics.
