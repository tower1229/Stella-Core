# Scoped lifecycle fixes after same-package CI

The `a1ba24d3` push and PR builds each recorded all 81 cases, with 80 passing.
The push run failed `standalone-compact` during post-restart consumption
observation; the PR merge run failed `core-consolidation-recovery` with
`memory_consolidation_configuration_changed`. Their tracked source manifests
were identical. Their different failure points do not establish a merge-content
cause or a shared root cause.

## Initialization and consolidation recovery

A failed startup publishes a blocked initialization status before its Host
isolation effects finish. A maintenance RPC can arrive during that interval.
Controlled synthetic timing reproduced the same consolidation rejection: the
model reference stayed unchanged while initialization changed target tools and
the Host runtime configuration shape. The full configuration hash correctly
rejected that change. The original Linux receipt did not capture the exact
changed field; this reproduction establishes the startup race without claiming
to reconstruct every detail of that earlier run.

Consolidation now joins in-flight initialization before reserving the repository
and capturing its processing authority. It also joins an initialization retry
already in flight. A later automatic initialization attempt observes the existing
repository reservation and waits through its memory-idle gate. Joining startup
while holding that reservation would deadlock, so the join precedes reservation.

The join permits a settled blocked startup to attempt explicitly granted recovery;
it does not grant bootstrap readiness or business admission. It respects request
cancellation and service shutdown, rejects a service that never started, and does
not depend on another gateway-start event for late service registration. The
existing model-reference and complete execution-configuration drift checks remain
unchanged, including their checks during and after publication.

## Repeated source reads in historical assessment

The isolated compaction follow-up reached final history persistence while its
Host run still lacked a terminal snapshot. In the pinned Host, an active request
without that snapshot can be reported as `gateway_draining`; that label alone is
not evidence of an actual restart. CPU observations and the existing authority
trace locate repeated source validation within the historical-view path.

Each graph node carries its inherited source closure. The old assessment reread
identical original evidence, objects and payloads for each node, then performed
the fresh final batch. A regression fixture with two independent originals made
seven original reads in one assessment. The new sweep uses per-reference read
promises scoped to that single assessment and read mode. Every node still checks
its own digest, dependency closure and eligibility. The final fresh batch remains
separate and rereads the sources, grants, payloads, configuration and archives.
No result is reused by a later assessment or model-consumption gate.

Tests bound duplicate reads to one sweep plus the final fresh batch and reject
an edit after an earlier node read, as well as an edit seen by a later assessment.
Existing archive integrity, source invalidation, recipe, audience and grant tests
continue to apply. This removes demonstrated redundant validation work; it is not
a larger observation budget or permission to accept an unconfirmed final reply.

## Verification scope

The product changes are limited to these lifecycle paths. The 81-case plan,
probe scripts, individual assertions and timeouts, recovery-pointer reload rule,
Dreaming-disabled profile and unknown-entrance rejection gates are unchanged.
Formal results must bind the new clean source SHA, one packed artifact, compiled
harness, pinned Host and per-case receipts; exploratory instrumented copies are
diagnostic evidence only. Local and Linux outcomes are reported separately in
PR #51 and its saved receipts.

Actual-target and full-product acceptance remain incomplete. `issue23Complete`,
`fullMemoryAccepted`, `privateMainAccepted` and `realModelAccepted` remain false.
