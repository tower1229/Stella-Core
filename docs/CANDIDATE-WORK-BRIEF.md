# Unconfirmed work briefs

The candidate ordinary plugin has an explicit `stella_work_brief` tool. It saves and
restores the same **unconfirmed candidate**, including proposed premises,
unresolved questions and opaque, unverified references. It does not confirm the
author, publish an author position or write Core's authoritative long-term
memory. The existing `stella_author_intent_candidate` remains unsaved.

This is engineering scaffolding, not a replacement product goal. The owner's
2026-11-02 priority is the necessary data structure, legacy conversion and actual
development-source integration first, then correct understanding of existing data
through semantic recall, source interpretation, routing and grounded answers,
before expanding correction/propagation or continuation features; see the single current decision
in [requirements §1.5](09-REQUIREMENTS-ALIGNMENT.md#forward-understanding-priority).
`stella-continue` is the implementation's name for this explicit synthetic-debug
entry, not a user-chosen name for Stella or a requirement to issue a command and
manage brief IDs in everyday use. Its narrowness is intentional for the fixture;
it cannot define the full product or justify postponing correction semantics.

This increment is restricted to a **synthetic debug** store.
It uses the existing author-intent v1 asset and Git transaction repository, not
another memory database. The asset's confirmation is always `candidate`;
`originalIntent`, `established` and authoritative `interpretation` are empty.
The structured proposal is enclosed as one explicitly unverified assistant
source. References never trigger file, URL, transcript or credential access.
Host history and native memory remain Host-owned; this feature makes no claim
about how the Host might retain or later summarize tool results.

The operator configures `candidateDraftsRoot`, an absolute, canonical path to a
dedicated local Git repository with its own real `.git` directory. The repository
must already contain the exact canonical marker exported as `DRAFT_MARKER_BYTES`
by `src/openclaw/candidate-work-brief.ts`. The tool never initializes a repository,
changes Git identity or adds a remote. The current marker scope is
`synthetic_debug`; pointing it at a private source or legacy production repository
is outside this milestone. No old source pointer, archive or data is migrated.

Only the configured agent and the Host's existing owner context can use the draft
store. This restricts access to the debug domain; the owner bit is **not** author
confirmation or permission to read other sources. The original v2 invocation
guard is captured and rechecked through repository operations. Sandboxed callers
are unsupported. A workspace-only caller must contain the configured store in
its Host-supplied root; read-only roots cannot authorize writes. Each invocation
constructs fresh ports and reads current disk state. No session-to-latest lookup,
persisted grant or cross-request permission cache exists.

Use the same `briefId` in later requests:

```json
{
  "action": "save",
  "briefId": "harbor",
  "operationId": "create_A",
  "expectedVersion": null,
  "proposal": {
    "topic": "Synthetic harbor walk",
    "interpretation": "Keep two endings open",
    "proposedPremises": ["The walk may connect the scenes"],
    "openQuestions": ["Which ending fits?"],
    "evidenceReferences": ["synthetic:unverified"]
  }
}
```

A later request reads `{"action":"read","briefId":"harbor"}`. To modify it,
save the full revised proposal with a new operation ID and the exact returned
`version` as `expectedVersion`. There is no implicit latest-version overwrite,
automatic rebase or semantic merge. Semantic choices remain the model's job.
The first creation alone uses `null`. Input cannot supply confirmation, author
identity, a filesystem path or an authorization override.

A save returns `publishedVersion` (the existing repository's field name for the
saved candidate version), `currentVersion`, `commitRevision`, `replayed` and
`isCurrent`. This is a local candidate Git commit, **not formal publication**.
Exact operation retries preserve their original result. Retrying an old operation
after another update does not roll it back; `isCurrent` will be false. Reusing an
operation ID for different content fails. A read returns the current proposal,
version and commit. The tool exposes no list, search, external source reader,
confirmation, deletion, automatic background job, remote sync or new model client.

Version conflicts, dirty repository state, missing history, malformed data,
cancellation and transaction uncertainty are explicit failures, never an empty
brief or an unsaved-success fallback. Existing transaction fences protect
incomplete writes. An update interrupted while fenced may require deliberate
repository-level recovery: the thin tool does not bypass the fence to derive its
historical base. No crash-recovery UI is claimed here. The enclosed proposal JSON
must fit the existing source excerpt limit of 16,384 characters; oversized input
is rejected without truncation.

The concentrated independent review passed all 53 focused tests. The main
Gateway then loaded the reviewed package and fixed synthetic root at generation
11, without a Gateway restart. Four separate public SDK calls saved A, read A,
saved B using A's exact version, and read B. Each restored proposal matched
exactly; questions remained unresolved. Two local commits were verified against
the actual canonical document hashes. The synthetic store is clean, has eight
tracked marker/asset/history/operation/journal files, and has no remotes. This is
actual explicit tool-consumer persistence across requests, not model discovery,
semantic adoption, real author/source admission or `full_memory`. No paid model
request was used.

The first ordinary `gateway call tools.invoke` failed without writing. In fixed
OpenClaw 2026.10.8, that CLI method requests only `operator.write`; the server
sets the trusted owner bit only for an authenticated `operator.admin` scope.
The successful demonstration uses the **public Gateway SDK**, the same existing
CLI identity and explicitly requested existing `operator.admin` scope. The
server validates the request normally. No owner field is supplied as a tool
argument, and no identity, scope grant or filesystem policy was changed. The
ordinary CLI failure is preserved separately from the four successful calls.

From this repository, the installed fictional draft can be read without a model:

```sh
node --input-type=module - <<'JS'
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
const result = await callGatewayFromCli("tools.invoke", { json: true }, {
  name: "stella_work_brief", agentId: "main",
  args: { action: "read", briefId: "harbor_main_demo" },
}, { scopes: ["operator.admin"], progress: false });
console.log(JSON.stringify(result, null, 2));
JS
```

The Host's managed consent was accepted only after review of the added
`stella_work_brief` tool and corresponding tools contract. **That acceptance is
persistent, not a four-call quota.** Qualifying owner calls for the configured
agent can continue to use the configured draft store until disabled. The marker
is an input/setup convention, not a classifier that prevents a caller from
entering sensitive text. This activation fixes the root to
`.artifacts/candidate-work-brief-data-20261031`; it does not authorize selecting a
real/legacy repository or adding other declared capabilities. No OS, credential,
identity, external source or publication permission was added.

Initial invalid-config and consent refusals retain their original evidence. The
schema-first official reload succeeded with persistence initially disabled; the
single synthetic-root option was then enabled and Core reloaded. The exact
internal cause of the initial management/schema discrepancy is still unknown.
The initial main8 restoration and all interrupted transport attempts remain
historical. Publisher stays off.

Rollback retains the complete pre-change main8 plugin artifact and an opaque
mode-0600 main configuration backup. Reverting this feature restores only the
Core package/configuration after checking for intervening changes, followed by
the official Core-only reload. Keep the synthetic Git store; no data deletion is
needed. Do not overwrite another plugin's configuration or restart the Gateway.

## Explicit continuation

The package ships the `stella-continue` skill through the plugin manifest;
no storage API or Core-owned conversation loop is added. OpenClaw 2026.10.8
normalizes its command name to `/stella_continue`. When the selected agent's
skill filter includes it, use an existing fictional brief explicitly:

```text
/stella_continue harbor_main_demo 继续比较两个结尾，先保留还没有回答的问题。
```

The composable form is `$stella-continue briefId=harbor_main_demo …`.
The skill is explicit-only. It asks the native Agent to read the current brief
before using its explanation, carry its unresolved questions into the present
discussion, save substantive revisions as candidates with the exact read
version, and read again on the next user request. It adds no keyword routing,
automatic topic selection, file-reading fallback, author qualification or
USER/MEMORY write. Missing or ambiguous IDs require clarification; tool errors
remain errors. It does not create missing briefs. An uncertain save is reported
as uncertain; a stale version cannot silently overwrite a newer revision.

The command runs a **normal model-driven Agent request** when invoked in chat;
it is not a no-model status command. No such request was run in this increment.
Its current technical evidence is public SDK command discovery (including
disabled-plugin and allowlist rejection), plus a scripted fictional continuation
through the real plugin tool factories: current read, candidate CAS revision,
fresh-request read, and rejection of the historical version. Sixteen focused
tests passed. This proves discovery and tool behavior, not model instruction
adherence, semantic adoption, actual main skill visibility, or true author
confirmation.

Concentrated independent review accepted the same 16 tests and all 2,742 package
files. The official Core-only reload then loaded generation 12 without a Gateway
restart. The accepted declared-surface delta is exactly `skills:["./skills"]`;
that acknowledgement persists until revoked and does not grant source, tool,
identity or OS permissions. Runtime code, dependencies, the main configuration
and fixed synthetic store remain unchanged. The complete main11 artifact is
retained for rollback.

The 2026-10-31 authoritative `skills info stella-continue --agent main --json` result was
`eligible:true`, `userInvocable:true`, `modelVisible:false`, but also
`blockedByAgentFilter:true`, `commandVisible:false`. Main's then-existing
`agents.entries.main.skills` array had 110 entries and excluded this new skill.
The loaded package and its materialized skill bytes matched the reviewed candidate;
the command was **not available on main at that checkpoint**. That activation did not change
that filter or route around it. Making the explicit entry visible required the
normal agent skill selection to include this one reviewed skill. No model
request or command invocation was made. This concrete configuration gap is
separate from the still-unverified model instruction adherence and semantics.

On 2026-11-02, recovery verified the same Host 2026.10.8, Git commit and all
2,742 installed package files. The official `config set` interface appended only
`stella-continue` at `agents.entries.main.skills[110]`, retaining all 110 prior
entries and every other setting. A private mode-0600 rollback copy preserves the
previous config. No plugin reinstall, Gateway restart, credential/identity grant
or source access was needed. The authoritative main result is now
`eligible:true`, `userInvocable:true`, `blockedByAgentFilter:false`,
`commandVisible:true`, `modelVisible:false` (explicit use only).

Four separate real Gateway `tools.invoke` requests then saved candidate A,
read A, saved B using A's exact version, and read B for the new fictional brief
`recovery_walk_20261102`. Canonical document hashes, both Git commits, exact
proposals and the previous-version link matched. All eight existing store files
were unchanged; the store remained clean with no remote. These are actual
no-model tool consumers. No skill/Agent model request was submitted: instruction
adherence, semantic understanding and automatic fresh-read behavior still need
their separate acceptance. The earlier filter failure remains historical.

For a later semantic acceptance, use the existing fictional brief and two new
Agent requests in distinct sessions: the first reads and revises one explicit
premise while retaining a separate open question; the second receives only the
briefId and a continuation request and must read the new version and use it.
Use `google/gemini-3.8-flash`, `low`, no fallback or unsupported sampling fields,
at most two Agent submissions, 90 seconds each, and no automatic retry. Observe
tool results, versions, final answers, assistant turns, tokens and available Host
cost reports. Tool continuations can produce multiple billable model calls;
there is no verified dollar hard cap. A missing cost is unknown, not zero.
These are proposed limits, not new execution authorization. Neither prior paid
approval nor old exhausted isolated-Host batches are reused. No real personal
material or new source permission is required for this bounded synthetic case.

## Passive current-input metadata (local candidate, 2026-11-02)

The ordinary-plugin candidate now connects the public `reply_dispatch` callback
to the exact `before_tool_call` / candidate execution using the Host run ID and
factory session identity. Dispatch only retains the recorder reference and its
original three read methods; it neither claims dispatch nor waits for or triggers
persistence. At candidate execution it reads `hasPersisted`, `isBlocked` and
`getAdmissionReceipt` synchronously. It never reads message text, prompt, history,
sender/provenance, configuration, transcript files or credentials, and calls no
recorder mutation/handler methods.

The candidate's additive `currentInputObservation` field distinguishes missing
dispatch/run/commit information, invalid or conflicting native metadata, and
`observed / native_input_metadata_only`. An observation exposes only a receipt
hash and explicit `authorQualification:false`, `sourceRepresentation:unverified`
and `modelConsumption:unverified` labels. The hash identifies a selected native
receipt snapshot; it is **not** a Source version, client idempotency key, author
proof or evidence that the model received/understood the input. The existing
`author_source_unavailable`, unverified proposal references, unsaved candidate
and publisher-off contract are unchanged. A failed observation cannot authorize
anything; an ordinary unconfirmed proposal may still be returned as such.

The observer accepts only the configured agent's ordinary agent dispatch with
matching explicit session keys, run ID, recorder and cancellation signal. It
retains at most 32 live run references. Cancellation and an exactly matched
`agent_end` release them. Repeated identical dispatch is passive; changing the
recorder, lifetime, session or an already-observed native admission makes that
run ambiguous. Restoring old metadata cannot revive it. Same-session concurrent
runs are addressed by exact run ID, never by a latest-session lookup. Missing
fields are reported unavailable; the code does not invent them from text or
owner status. `agent exec` and direct tool RPC without this ingress still cannot
provide current-input observation. No registry is persisted across requests or
processes, and no new identity/permission service is introduced.

This local implementation has **24/24 synthetic focused cases** (9 new metadata
cases, 5 ordinary-plugin cases and 10 request-binding cases), plus successful
TypeScript compilation. The callbacks were driven by fixtures through the real
plugin registration/factory code, not by a live Host or model. During recovery,
the local `node_modules/openclaw` symlink was found to resolve to global SDK
**2026.10.9**, while the project manifest/lock retain **2026.10.8**. Those files
and the global installation were preserved. The new compilation/test results
belong to 10.9; they do not revalidate the historical 10.8 artifact or establish
the running Gateway's version. Details, source hashes and the exact local delta
are recorded in [the implementation receipt](../.task-control/reports/CORE-VAL-001/current-input-metadata-20261102.json).

The candidate has **not been loaded into main**. The user's shared selfie debug
instance, its configuration, processes and ports were untouched. Review this
local package first. The next integration check must prove actual dispatch
lifetime/receipt timing in a separately permitted synthetic run; no old exhausted
Host or paid-model quota is reused. Trusted sender-to-author mapping, original
text/normalization evidence, Source/version/purpose qualification and semantic
adoption remain separate missing capabilities. Do not wire the offline author
qualifier or enable publication merely because native metadata was observed.

### Historical independent review: original metadata candidate not accepted

The earlier 24/24 is the author's focused synthetic test result, not independent
acceptance. The coordinator subsequently reported a P2 defect: receipt fields
are read through getters repeatedly, allowing validation and the eventual hash
to describe different scalar values; four independent counterexamples were
unexpectedly accepted. Their result was relayed by the parent review and was not
rerun in this documentation audit. Source/author qualification and publisher
still remain off; this is not evidence of an accepted source binding.

The candidate is paused and must not be loaded or pushed as accepted. The narrow
required fix is to read each selected scalar once into a stable plain snapshot,
then validate and hash only that snapshot, adding the independent counterexamples
to the regression set. That is a prerequisite repair only where this observer is
needed; it is not the next product milestone or a reason to block independent
correction-loop engineering. The existing code and both passing/failing evidence
retain their identities. No runtime fix was performed in this direction audit.

2026-11-02 follow-up: the scalar-snapshot repair was independently closed in the
fixed state97 source-read package. The failure above retains its original identity;
it no longer schedules a paused metadata repair. The reviewed ordinary hooks and
factory keep native observation separate from source/author permission. See the
[accepted offline package evidence](../.task-control/reports/CORE-VAL-001/source-admission-review-20261102.json).
Actual Host lifecycle and semantic consumption remain unverified.
