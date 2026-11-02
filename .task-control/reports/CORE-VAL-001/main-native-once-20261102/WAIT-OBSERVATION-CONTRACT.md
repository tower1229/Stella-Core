# Bounded wait observation candidate — not installed or executable yet

The single old-evidence pass examined the known daily structured log prefix and
the original PID 14106 stability snapshot, from 11:20:29.893 through 11:25:23 UTC.
It found 21 log records and two trace identities associated with the original run,
but no lifecycle queue-wait/holder or SQLite operation record in that window.
The snapshot likewise had no matching operation records. See
[the exact projection](EXISTING-WAIT-METADATA.json). This is not evidence that no
queue or write existed: emission depends on diagnostic enablement, slow thresholds,
sampling and completion. No further old-log search is assigned here.

## What this patch observes

[UPSTREAM-WAIT-OBSERVATION.patch](UPSTREAM-WAIT-OBSERVATION.patch) is a textual
candidate against the recorded OpenClaw 2026.10.9 bundled hashes. It is not the
earlier pre-abort repair, and intentionally does not include that repair. It adds
synchronous enter/exit notes around existing awaits at five fixed points:

| Point | Meaning |
| --- | --- |
| `agent.listener` | One original awaited Agent event listener; no event body or role is inspected. |
| `recorder.runtime` | The recorder's existing runtime-persistence promise. |
| `recorder.admission` | The existing admission-write promise, including its original undefined case. |
| `projection.recorder` | The projection's existing recorder wait call. |
| `projection.write` | The existing transcript-owned projection write. |

There is no new await, Promise race, timer, AbortSignal listener, storage call,
admission handler, permission check or custody release. Existing await operands,
error handlers, cancellation checks and finally mutations remain. `exit` means
the observed block returned or threw; it does **not** mean a write committed,
the session became idle, a response was delivered, or cleanup succeeded.

The helper is disabled unless the child process is explicitly started with
`OPENCLAW_TRACE_PREMODEL_WAIT=1`. Without that exact flag it emits nothing.
The proposed preload subscribes to one Node diagnostics channel, projects only
fixed labels/numeric span IDs/sequence/monotonic times, and writes at most128
small records to the existing stderr capture. No paths, SQL, operation input,
run/session/device IDs, error messages, prompts, tool results or credentials are
accepted. Subscriber errors cannot escape into the original operation. Observer
CPU/I/O overhead is real, so identical timing is not promised.

Only a single synthetic request in a dedicated process may use this candidate.
The integer span ID is process-local and is not an identity/admission assertion.
PID and request association come from the outer launch receipt, not from content.
Concurrent or shared-main use is out of scope. A limit marker, sequence gap,
missing stream close, lost observer output or unknown process terminal makes the
capture incomplete. An unmatched enter with complete capture identifies an
outstanding observed boundary, not automatically a SQLite lock, its holder or
the original production request's root cause. Nested runtime/admission/write
spans can narrow that boundary without observing private objects.

## Local checks and exact limits

[Ten instrumentation checks](WAIT-OBSERVATION-CHECK-RESULT.json) passed, separate
from the earlier6 wait-path and6 repair contrasts. They cover default-off,
fixed scalar output, the128-record cap, observer failure, original recorder order
and error identity, pending cancellation, unchanged projection/single write,
listener pending ownership/finally mutation, and collector rejection of unknown
labels/extra fields. The first check attempt omitted synthetic queue dependencies;
its failure remains in [OBSERVATION-CHECK-SETUP-FAILURE.json](OBSERVATION-CHECK-SETUP-FAILURE.json).
All three proposed changed modules parse; installed source hashes remain unchanged.
No Host module was imported or real storage exercised by those checks.

## Proposed zero-fee collection, pending review and sandbox capability

The existing execution channel currently runs read-only commands and pure code.
However, the last exact sandbox attempt returned exit71,
`sandbox-exec: sandbox_apply: Operation not permitted`. It failed before a Host,
listener or chat request started. This task has **not** retried it. The same
profile still hashes to
`6a221d95ebc5e354a00d58ff1eac0576898e2842cbad11b638f4ca09f38f7819`;
see [capability receipt](OBSERVATION-CAPABILITY-CHECK.json). Executable existence
or successful Node syntax checking does not establish sandbox application ability.

If a later review and legitimate capability resolution release execution, use:

- Existing Node24.22.1/OpenClaw10.9, copied to a fresh owned child below the already
  allowed `/private/tmp/core-v2-tool-host-20261030-1v9l42z5/runtime-6ApFah` root.
  Apply the observation patch only to that disposable SDK copy. Preserve and hash
  the original modules; never edit the installed package or main configuration.
- Separate synthetic HOME/state/config/workspace, no copied USER/MEMORY, history,
  source grant, source data or live credentials. Use an explicitly invalid test key,
  no fallback, only a local fixed-response provider endpoint. No source tool or
  real-data admission is necessary to validate observation capture.
- Existing loopback stub `127.0.0.1:55787` and independent loopback Gateway
  `127.0.0.1:55788`. The previously approved additional outbound55788 rule remains
  the only profile delta. Do not add rules, change system settings, bind externally,
  route a client outside the sandbox, or treat this plan as lifting the prior denial.
  Port availability has not been probed.
- One native `chat.send`, at most4 protocol HTTP requests,90seconds total including
  teardown under the existing reviewed owned-group supervisor. The message is a
  fixed synthetic instruction such as “Reply with synthetic-ok.” No paid provider
  endpoint is reachable under the unchanged profile. This is a fixed protocol
  observation check, not a Gemini semantic evaluation or replay of the failed run.
- Preload [the collector](WAIT-OBSERVATION-COLLECTOR.mjs) with Node's explicit
  `--import` flag before the copied official entry. The added non-secret diagnostic
  environment key must be declared in the child launch/environment contract; do
  not silently bypass the existing seven-key parent environment checks. No
  `NODE_OPTIONS` inheritance. Final argv/environment/config/hash must be frozen
  and reviewed before execution; this packet does not yet contain a launch claim.
- Retain the existing single-use claim, deadline and descendant-group cleanup
  semantics; no detached inner processes. Record actual exit/close/stdio, listener
  terminal and whole-group result. Unknown/EPERM stops further control and prevents
  deletion. Only after verified termination may this attempt's own synthetic copy
  be cleaned, preserving sanitized spans, receipts and hashes. Never touch an old
  failed group or original failure directory.

The old producer driver is a historical, unexecuted candidate, not automatically
an accepted launcher for this patch. Final mechanical wiring still needs review.
This round creates no service, socket, new launch directory, claim or model call.
`executionReady=false` remains mandatory while sandbox capability is unresolved.
No new main paid request is authorized. An observation-only successful synthetic
run would still not establish the cause or repair of the original real hang.
