# R1 — isolate observation faults; no Host installation

R0 was rejected for OBS-P1. Actual Node diagnostics_channel schedules subscriber
exceptions outside the publisher's try/catch, and stderr can emit an asynchronous
unhandled error. The original10 VM checks did not prove these cases. The prior
candidate, failures and16-member manifest remain historical; the three navigation/
state members changed by this handoff have exact-byte copies listed in
[R0-PRESERVED-MEMBERS.json](R0-PRESERVED-MEMBERS.json).

## Minimal change

Only observer delivery/output changed. The five await edits in the three official
modules are byte-identical to R0, recorded in [PATCH-IDENTITY.json](PATCH-IDENTITY.json).
The reviewed await operands, existing error/finally logic, cancellation and custody
semantics are not modified. [OBSERVER-R0-R1.diff](OBSERVER-R0-R1.diff) is the narrow
delta; [UPSTREAM-WAIT-OBSERVATION-R1.patch](UPSTREAM-WAIT-OBSERVATION-R1.patch) is the
complete **uninstalled** disposable-copy candidate.

- The helper uses one private synchronous collector instead of diagnostics_channel.
  A thrown callback or returned asynchronous result marks the capture incomplete
  and disables observation. Only an observer-owned returned rejection is handled;
  there is no process-level exception/rejection handler.
- The collector uses a dedicated fd3 pipe, never shared stderr. Both its write
  callback and its owned stream's `error` event mark capture incomplete. It does
  not attach listeners to shared stderr or consume business errors.
- At natural process completion, a one-shot `beforeExit` callback attempts a scalar
  `capture_terminal` receipt. This gives at most128 span records plus one terminal
  record. Missing terminal, `incomplete=true`, malformed/gapped records, output
  error or unknown process termination means incomplete capture. The diagnostic
  receipt is not a business success, write commit or custody release.

Two actual Node24.22.1 fault regressions have red/green results in
[NATIVE-FAULT-RESULT.json](NATIVE-FAULT-RESULT.json): both original exact probes
return from the business call then exit1; both R1 equivalents exit0 with
`captureIncomplete=true`. The callback case also installs a real throwing legacy
channel subscriber and a throwing private sink. The output case injects the same
real Writable asynchronous failure into the dedicated diagnostic output instead
of stderr. No global exception/rejection listeners or shared stderr error handlers
were added. These are **two cases**, not added to the old10 VM tests. The same cases
were rerun for the self-contained driver and final terminal-receipt edit; interim
receipts are retained, not counted as additional coverage.

The result proves containment of these two faults only. It does not reproduce or
repair the original main request, prove all observer I/O timing, or accept a Gateway
execution. No installed SDK/Core/main configuration was changed.

## Collection contract delta

The prior [bounded collection contract](../WAIT-OBSERVATION-CONTRACT.md) retains its
single synthetic request, exact profile, loopback55787/55788, no live credentials/
data/provider, max4 HTTP and90second total limits. Replace only its public channel/
stderr delivery description with this private collector and fd3 contract.

The later launcher must explicitly supply and drain child fd3, ensure the copied
helper and preload resolve to the same ESM module, and verify fd3/preload propagation
if the official CLI respawns. Missing descriptor or propagation is capture failure;
do not patch the installed Host or bypass an official launcher constraint. These
mechanical launch details remain unexecuted and require review. No extra network,
data, identity or OS rule is proposed. Default-off and fixed scalar labels remain.

## One sandbox capability probe: still blocked

The manager-assigned sole same-channel probe at13:15:25 UTC executed:
`/usr/bin/sandbox-exec -f <unchanged restriction.sb> /usr/bin/true`.
Actual exit was71, signal null, stdout empty; stderr was exactly
`sandbox-exec: sandbox_apply: Operation not permitted\n`.
Both profile hashes remained
`6a221d95ebc5e354a00d58ff1eac0576898e2842cbad11b638f4ca09f38f7819`.
See [original receipt](SANDBOX-TRUE-RESULT.json) and retained single-use claim.

This is an OS activation rejection, not a new automatic approval rejection and
not a completed `/usr/bin/true` target. No escalation, alternate path, rule change,
second attempt, service, socket or model request followed. Further synthetic
Gateway execution remains blocked on legitimate environment capability resolution
and frozen wiring review. `executionReady=false`; the paid main quota remains used.
