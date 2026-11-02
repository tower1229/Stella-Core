# R2 — partial observations, no completeness assertion

R1's private-callback and dedicated-output fault containment was independently
accepted for its two actual Node fault cases. That does not accept its newly added
`beforeExit` terminal receipt: a later legal `beforeExit` listener can schedule
more asynchronous work after that receipt. The original review and counterexample
are retained here; R1 itself is not rewritten as successful capture.

The sole behavior change is removal of the collector's `beforeExit` callback,
`output.end` and `capture_terminal` publication. The private helper, output-error
handling and all five official await edits remain byte-identical to R1. See
[the narrow diff](COLLECTOR-R1-R2.diff) and
[complete uninstalled candidate](UPSTREAM-WAIT-OBSERVATION-R2.patch).

**Every R2 capture is partial.** Observed enter/exit records can locate an observed
boundary, but absent records cannot prove no work occurred. Neither exit0, closed
fd3, paired spans nor internal `incomplete:false` establishes complete capture.
That internal flag means only that no observer fault has been recorded. There is
no terminal assertion or whole-capture acceptance API in this candidate. Do not
invent one in the later launcher or treat the removal as full tracing success.

One deterministic counterexample was replayed with only the two import paths
rebound to the preserved R1 and new R2 modules. [Result](TERMINAL-REENTRY-RESULT.json):
R1 exits0 after emitting `capture_terminal/incomplete:false/emitted:0`, then ends
with internal `incomplete:true/emitted:2`. R2 exits0 with the late enter/exit pair
and emits no terminal/completeness claim. This closes the premature assertion in
that counterexample; it is not a reproduction or fix of the original Host hang.
The old two Node fault cases and10 VM cases remain separately attributed and were
not rerun or added to this one-case count.

The candidate remains default-off/uninstalled, at most128 partial span records,
with no main/SDK/configuration change. The earlier fixed-profile `true` probe's
exit71/sandbox_apply EPERM remains the last sandbox observation; **this task made
no sandbox or service attempt**. The execution transport briefly disconnected
before any R2 write, then recovered; that does not resolve OS sandbox activation.

This finite preparation package is now closed for independent review. There is no
further tracing expansion or probe assignment. Any service execution still needs
legitimate environment capability restoration and a separately released, reviewed
launch plan. Main paid quota is exhausted. Existing loopback/source/credential/
grant boundaries and all failure history remain unchanged.
