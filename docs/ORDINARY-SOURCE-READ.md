# Ordinary-plugin selected-source read port

2026-11-02 selected-source read implementation: the state97 offline package was
independently accepted and saved in `4e50567`; its evidence/docs are in `4498a46`.
The public WebChat/default-model compatibility increment below is a local
candidate awaiting independent review. **Neither package is installed or connected
to private CangHai.** This supplies the deterministic read seam for
the [data-first priority](09-REQUIREMENTS-ALIGNMENT.md#forward-understanding-priority).
It does not implement semantic routing or claim that a model understands data.

## Existing contracts, not a new data model

The port follows the selected migration layout that was checked on the existing
local `migration-v1` source at `112be540a3988af53d1076a38f8f1c155da7a745`:

| Selected document | Existing contract / pointer |
| --- | --- |
| `50_PersonalAgent/stella/knowledge-migration-v1/manifest.json` | `stella.consciousness-manifest/v1`, `identity.runtimeProfileRef` |
| `50_PersonalAgent/stella/knowledge-migration-v1/runtime-profile.json` | `stella.runtime-profile/v2`, `memory.catalog_ref` |
| `30_Knowledge/migration-v1/runtime/catalog.json` | `stella.memory-catalog/v1`, versioned Source/Evidence/policy/coverage entries |
| Source / original | Existing Source v2 segments, Evidence selector and payload SHA-256, Source-base AND segment policy |

The root `50_PersonalAgent/stella/manifest.yaml` is a different, historical
manifest. The port requires an explicit manifest; it never substitutes that root
file when the selected one is missing. Identity and runtimeState profile refs
must agree when both are present. `sourceBaseline.commit` records original-data
history; it does not select today's checkout. The configured full Git revision
does. A serialized `active` or `full_memory` label is not Host activation or
full-memory acceptance.

Existing `parseConsciousnessManifest`, `parseRuntimeProfile`, `CatalogReader`,
`EpisodeEvidenceResolver` and Source policy checks are reused. This narrow loader
does not traverse identity, bootstrap, framework, secret or every capability
reference to read one selected catalog. No database, migration executor, writer,
new identity service, memory-slot replacement or Host-private consumer is added.

## Operator selection and request admission are separate

The candidate plugin schema adds optional `sourceRead` containing exactly
`root`, `manifestPath` and a full lowercase 40-character `revision`. The root must
be absolute/canonical and the entire selected checkout clean at that revision.
The manifest/profile/catalog and selected object/dependency/payload blobs are
checked against that Git revision (or a payload's explicitly recorded historical
revision). Paths cannot escape the root or cross a symlink into another file.
The binding and filesystem-policy restrictions are not model tool arguments.

**This configuration grants no data access.** The ordinary entry now has a thin
public-request adapter in `ordinary-source-admission.ts`. It combines:

- One supported `reply_dispatch`'s canonical normalized `rawText`, exact run and
  session, direct-chat sender, and committed native receipt observation. Dispatch
  only captures references/text in memory; it does not persist, stage, replace an
  admission handler, wait for a commit, or claim the dispatch. The input is the
  Host's normalized request representation, not proof of original author wording.
- The actual source-tool hook call/run/session incarnation and Host requester,
  plus the v2 factory's original invocation guard, matching requester/owner,
  owner-private audience and exact active `google/gemini-3.8-flash` model. Missing
  fields, duplicate calls, conflicting admissions, cancellation and ended turns
  reject. No session-to-latest identity or qualification recovery is used.
- The selected profile's unique `source_access_context` capability using the
  existing `stella.personal-context-access/v1` adapter. Its grant is read from
  the same clean, pinned Git revision. This limited path requires one existing
  requester and `personal_context / personal_understanding / owner-direct`.
  It neither appends a requester/model nor enables operator, learning or writer
  capabilities. Exact Source/segment/base-policy descriptors bound the scope.

`createPersonalContextAccess`, `assertPersonalSourceMetadata` and existing source
policy kernels are reused. Each new user request obtains its own committed input,
reads the current selected grant/version and makes new source judgments. Native
receipt hashes are only one consistency check; they never independently grant
source access or author confirmation. Internal test injection ports cannot be
supplied through plugin JSON, tool parameters, runContext or toolBindings.

Unconfigured calls fail with `source_read_not_configured`; configured calls
without the required actual Host facts fail before source filesystem access.
`sourceReadPort` reports configuration/adapter availability; the conservative
`sourceAdapter:not_connected` label remains until actual binding is validated.
Neither is proof of successful private-source activation. The installed main remains unchanged
and unconnected. Actual producer field availability and lifecycle remain untested.

Sandboxed callers are unsupported. A workspace-only Host caller must contain the
selected root. These checks precede admission; the issuer is not called for a
denied filesystem context. No configuration, permissions or managed consent was
changed on the user's shared Host by this package.

## Tool contract

`stella_source_read` supports only:

- `{"action":"list"}` with an optional returned cursor: up to32 current eligible
  Evidence metadata rows, exact source/evidence/policy refs, authorized reviewed
  description and segment locator, recorded role/kind and timestamps. Descriptions
  are untrusted locators for semantic selection, not evidence or instructions.
  Every row requires metadata-processing admission; base AND leaf descriptor
  membership and processing purposes are checked before a description is returned.
  No payload is read and no semantic ranking is performed. The cursor binds the catalog hash;
  known-by/event-window and exact descriptor-scope exclusions are explicit. A scope
  exclusion is only the adapter's explicit `false`; arbitrary metadata errors fail
  the operation. No out-of-scope row identity or body is returned. A page is not evidence that the
  whole repository was searched or that the question has sufficient evidence.
- `{"action":"read","ref":{"id":"...","version":"sha256:..."}}`: one exact
  original Evidence slice with Source/version, payload hash/selector, original
  role/kind/time, coverage and usage constraints. `provenance` carries the recorded
  speakerId (including null) and the selected Source origin's adapterId,
  collectionId and upstreamId. `upstreamId` is a source record identifier, not
  necessarily an original message ID. These labels are not authenticated identity or
  author confirmation. Both base and segment policy remain enforced. Request lifetime is checked around semantic policy awaits and
  immediately before the first payload read. Returned Source references and
  selectors are projected to documented fields. The result is neither author
  confirmation nor publication.

Each invocation opens current data afresh. There is no session-to-latest lookup
or retained permission/reader cache. Original reads enforce the declared time
scope. Dirty state, a different revision, stale cursor, changed object/payload,
invalid/missing reference, policy denial or cancellation is a failure, not an
empty-success fallback. Original text beyond128KiB fails without truncation.
List result JSON is bounded to128KiB UTF-8 and at most32 scanned catalog entries:
when descriptions fill a page, the cursor resumes at the complete omitted row,
without dropping it or truncating its description. A single oversized row fails
explicitly. An empty page with a next cursor is not global absence. Selected
UTF-8 byte slices must encode back to exactly the pinned bytes; the inherited
decoder's BOM removal therefore produces
`source_text_representation_unverified` rather than an unreported rewrite.
The existing JSON-pointer selector retains its declared string projection.

Listing and deterministic source checks cannot decide natural-language meaning.
The native Agent / properly qualified structured LLM port must select relevant
sources, follow leads, distinguish facts/inferences and decide answer versus
clarification. No lexical routing or fallback is added. For per-source policy semantics, the
adapter calls only the public Host `llm.complete` port, requiring
`google/gemini-3.8-flash` with `low`, no sampling parameter, and no configured
fallback. The code passes only the current normalized request and one reviewed
descriptor/policy context; it does not pass original bodies to that judgment.
Actual runtime dispatch/consumption is not verified by these synthetic tests.
No provider call was made by this implementation or its tests. The state97
wrapper passed explicit agent/model parameters; its offline evidence does not
establish the Host's override authorization. The compatibility candidate below
uses the exact proven native default without adding override permissions. An
unproven/disallowed runtime fails rather than selecting another agent/model.

## Public WebChat and native-default compatibility candidate

OpenClaw2026.10.9 deliberately omits transport `SenderId` for authenticated
operator WebChat. The added mode reads only the exported
`getPluginRuntimeGatewayRequestScope` facts: Host-attested authenticated Control
UI/operator, authenticated profile, connection identity and live admission at
dispatch. Client IDs, prompt/tool parameters, `toolBindings` and `runContext`
cannot supply this identity. Synthetic/delegated clients reject even when they
copy a matching sender/profile. No `SenderId` field is fabricated or changed.

The profile must exactly equal the selected grant's existing requester; no alias,
requester addition or new audience is created. The same native run, call, session
incarnation, committed admission and original v2 guard still apply. Hook and read
require the same public profile/connection scope. Conflicting identities reject.
RPC/socket completion alone does not revoke a previously admitted run; original
native/v2 cancellation/end still applies. Each new request needs fresh live
admission and the current selected version/grant. Normal channel/CLI ingress
continues to require its Host-supplied sender and original owner checks.

The default completion path first proves `main` is the configured ambient owner
(explicit system owner or sole agent), its public resolved default is exactly
`google/gemini-3.8-flash`, and no default/agent fallback is configured. Only then
does it omit the `agentId` and `model` override parameters. The Host still checks
completion/operator/source/model capabilities; denial propagates without retry.
Returned agent, provider/model and direct-provider execution must still match.
Unknown owner, ambiguous fleet, different model or fallback fails before calling
completion. No override capability, identity grant or configuration is changed.

This checkpoint is code and synthetic callback coverage on SDK10.9, **not** evidence that
the actual browser callbacks carry the public scope, or that a real human profile
matches the existing selected grant. The approved independent CLI/local-protocol
producer test remains unused; it can prove native technical plumbing, not browser
human identity or semantic understanding. Shared main/selfie was untouched at
that offline checkpoint.

The later reviewed package was loaded through the official local Host lifecycle
on 2026-11-02. Actual main generation5 status and tool invocation now establish
that the new tool is registered and explicitly rejects an unconfigured source.
They do not establish source admission or reading: `sourceRead` remains absent,
`publisher` remains false, and no source-policy/model call was made. See the
[main installation evidence](../.task-control/reports/CORE-VAL-001/main-source-activation-20261102.json).
The next binding needs the coordinated stable data root, full Git SHA, manifest
and existing descriptor/requester scope. Preserving a CangHai branch does not
activate it or expand the permitted audience or financial-data scope.

## Historical verification before state97

TypeScript compilation passed on the observed local OpenClaw SDK2026.10.9 and
Node24.22.1; project manifest/lock still pin10.8 and were not changed. Focused
checks passed **37/37**:11new source-port groups plus5ordinary,10binding and
11draft/continuation cases. Sources, identities and semantic permission verdicts
were synthetic. The real plugin registration/factory code was exercised with an
explicit test issuer; no Gateway, live ingestion, external model or private
payload was used. The initial34pass/2fail run is retained separately. No full
suite, installation, reload, consent, commit or push was performed at that checkpoint.

The original37/37 run did not repair or approve the pre-existing metadata P2.
Its failure evidence and the read-port increment remain in
[the original receipt](../.task-control/reports/CORE-VAL-001/source-read-port-20261102.json).
Because the ordinary entry also registers that observer, the delivery candidate
now includes its minimal scalar-snapshot repair: each selected receipt field is
read once, then the same immutable snapshot is validated, bound and hashed.
Four getter-change counterexamples reproduced false observations before the
repair and are rejected after it. A valid snapshot/hash control and the affected
metadata/ordinary-entry cases passed **19/19**; the37cases were not rerun or
combined into a new total. This does not add source/author qualification.
At that checkpoint the full entry and both local modules remained pending
independent review and uninstalled; a mixed working tree was not approved by these tests.
The [R1 delivery receipt](../.task-control/reports/CORE-VAL-001/source-read-port-r1-20261102.json)
pins the combined entry patch and its dependency/test evidence.

## State97 binding review and remaining Host validation

The next package includes that request adapter, descriptor-scoped listing and
the independent review's request-lifetime/reference-projection repairs. The old
state95 nine-file version is preserved in the immutable
[frozen review manifest](../.task-control/reports/CORE-VAL-001/source-read-port-r1-frozen-20261102/MANIFEST.json);
its review found51/51 baseline checks plus7/9 extra probes, with two real
synthetic boundary failures. The metadata P2 was independently closed; those two
source-read failures are retained, not reclassified as old passes.
The [request-adapter receipt](../.task-control/reports/CORE-VAL-001/source-admission-20261102.json)
records this candidate's exact code, tests, replay and incremental boundary.
The final author run passed63/63 focused cases; the same independent probe logic
replayed7/9 before the fixes and9/9 after them. The existing Evidence kernel suite
passed28/28 after its temporary harness was supplied the unchanged schema path;
the initial24/28 missing-schema failure is retained. These separate runs are not
summed or represented as independent acceptance. Subsequently the independent
[review summary](../.task-control/reports/CORE-VAL-001/source-admission-review-20261102.json)
accepted the fixed13 package:63/63 focused,28/28 kernel,9/9 counterexample replay
and4/4 default-entry probes, separately attributed. Both source defects and the
metadata P2 closed at that boundary. This does not cover the newer compatibility
increment above or actual Host behavior. It is not installed.

After review, a nonconflicting Host window must use an exclusively synthetic
source/grant/root and preserve rollback. A direct no-model Gateway tool invocation
should demonstrate missing-ingress denial. A positive actual-ingress test must
use a supported Host producer that really supplies dispatch/run/native admission
and matching tool requester/audience facts; it cannot manufacture callback values
or substitute a session identity. No public no-model positive producer has been
established in this package. If a loopback protocol stub is needed to drive a real
Agent turn, its bounded run must be separately assigned; the old exhausted batch
is not reused. Do not call an actual model just to produce ingress receipts.

Only after those facts and the exact existing scope are reconciled should a real
private root be bound. The later forward scenario is a natural question over a
small permitted corpus: native Agent selects relevant evidence, reads exact
originals, follows leads and answers or clarifies with source/role/time
distinctions. Real semantic acceptance uses `google/gemini-3.8-flash`, `low`,
under its own valid call/material scope. Synthetic API tests supply neither that
authorization nor acceptance. No shared Host configuration, private binding,
source file, permission or publication setting changed here.


## Fixed90f readiness and existing-device identity gap (2026-11-02)

The coordinated fixed worktree and the installed package's manifest/profile/grant parsers now pass the no-model readiness checks. Configuration remains unapplied: the existing grant has one `openclaw-device` requester, while the official Host profile directory contains one canonical profile and zero exact requester matches. The current WebChat adapter compares that profile ID exactly, so this is a concrete compatibility gap before live binding, not a data-root failure. Neither the grant nor requester mapping was changed.

The public SDK exposes an optional server-attested `operatorDeviceTokenIdentity`; its actual device must match the already permitted device before it could support a narrow compatibility change. A raw client device field, an owner flag, or mere profile membership is insufficient. The seam was not implemented at this readiness checkpoint and remains unverified for the active browser; token key values must not be copied. See the [readiness matrix and precise next step](../.task-control/reports/CORE-VAL-001/fixed90f-binding-readiness-20261102.json). No post-binding tool success, original-payload consumption or semantic acceptance is claimed.

## Existing-device compatibility candidate (2026-11-02)

The later local candidate implements that narrow seam; the installed package
still has the preceding identity gap. OpenClaw10.9 creates the public internal
device identity only after matching the paired record's public key, operator
token and current scopes. Core snapshots only its lowercase64-hex `deviceId`,
requires authenticated Control UI/operator admission, and retains the original
profile, connection, native run/call, incarnation and owner-private checks. It
never reads the token-generation key or uses `connect.device` as proof.

The existing grant explicitly selects the principal kind. An `openclaw-device:`
grant requires exact equality to the Host-attested device; a matching profile
string or another device under the same profile cannot satisfy it. An explicit
profile grant keeps its prior exact-profile semantics. The permission request
snapshot uses the selected existing principal without rewriting any Host sender
field, adding a requester, issuing an alias or broadening the descriptor scope.
Identity conflicts invalidate that run, each new user request needs fresh
admission, and admitted tool continuation keeps the native request lifetime.

The initial author suite passed27/27 (22 admission cases and5 ordinary-plugin
cases), including unchanged-grant read/list, forged/profile-only/unknown-device
denials, delegation, cross-connection/cross-request reuse and cancellation.
These are synthetic tests with a local completion fixture, not a real device
observation or Gemini acceptance. Review evidence and the frozen candidate are
in [the compatibility packet](../.task-control/reports/CORE-VAL-001/device-source-compat-20261102.json).
No live binding, installed-package change or private source access occurred.

Independent review rejected that initial candidate: when the Gateway principal
was absent, a device-form grant could incorrectly match a normal transport's
SenderId. Two synthetic registered-tool counterexamples returned payloads; this
was not a deployed private-data exposure. The original frozen packet and failures
remain unchanged.

The R1 candidate now selects solely from the grant kind: every device-form grant
requires `turn.gateway?.deviceRequesterId`, so unsupported normal-channel/CLI
paths fail before model or payload access. Explicit profile grants and the
authenticated-device positive path retain their prior behavior. The exact three
independent probes changed from1pass/2fail to3pass/0fail; the expanded admission
and ordinary-plugin suite passes29/29. These counts are separate. See the
[R1 repair packet](../.task-control/reports/CORE-VAL-001/device-source-compat-r1-20261102.json).

A separate temporary status diagnostic is prepared for review only. It exposes
five booleans through the existing status tool, requires an eligible authenticated
Control UI caller for a device comparison, and creates no admission or source
permission. Its fixed expected digest is assembled privately from the original
grant after review; the candidate contains no real seed and is not loadable yet.
Use the actual WebUI Debug connection, never a CLI stand-in, and remove the debug
artifact after its single observation. Native ingress/source consumption and
Gemini semantics remain separate, unverified steps.

## 2026-11-02 fixed90f bound; native source consumption still unverified

The ordinary R1 entry now has the explicit fixed90f sourceRead binding in actual main (Gateway generation11). The original97-source/362-descriptor device/purpose grant and finance exclusion remain unchanged. See the [binding receipt](../.task-control/reports/CORE-VAL-001/fixed90f-main-binding-20261102.json) for metadata hashes and reversible config delta. Earlier unconfigured observations above retain their historical scope.

A real authenticated Chrome WebUI tools.invoke returned the configured status, then source list was rejected as source_request_admission_unavailable. Official direct tool invocation does not produce native Agent run/admission facts. All362 allowed descriptors are segmented; the accepted read path also requires real source-policy semantic completion before payload. This no-model phase therefore does not establish a successful body read, model consumption or understanding. Do not manufacture a run, recorder, policy verdict or identity fallback to bypass either boundary.

## 2026-11-02 next native single-fragment test preparation

The fixed10.9 native chat.send producer supplies the existing run/recorder/tool facts; no new metadata protocol is currently identified. A single1,002-byte writing fragment from the original grant is selected by metadata, with semi-private policy and unknown role/author. It has not been read or sent. The [scoped plan](../.task-control/reports/CORE-VAL-001/fixed90f-push-native-plan-20261102.json) separates expected three logical completions from unbounded provider retries/billing.

The model test is not execution-ready: ordinary main bootstrap context still needs a synthetic-only projection check, and the existing362-descriptor tool lacks a temporary exact-ref/one-read restriction. A prompt request alone cannot prove either boundary. Preparation must only narrow this test, preserve native identity/admission/policy checks and leave the standing grant unchanged; no model or private payload was used to prepare this plan.

### Single-request boundary candidate and context counterexample

The subsequent [preparation packet](../.task-control/reports/CORE-VAL-001/single-source-test-prep-20261102/REVIEW-REQUEST.md)
adds an **unloaded test fixture**, not another production permission or memory
system. It narrows one native request to one exact Evidence id/version and one
attempt, including failed attempts, and at most one logical source-policy
completion through the unchanged official completion method. The ordinary
device/grant, native admission and source checks remain in place. Synthetic
boundary tests pass25/25; actual Host integration of this fixture is unverified.

Context exclusion did **not** pass. Fixed10.9 source and synthetic replay show
that an empty execution worktree still receives the canonical main bootstrap
workspace. Current `contextInjection: always` can therefore inject USER/MEMORY;
`never` suppresses that bootstrap resolver but does not suppress memory-core's
independent standing-intent prompt hook. The latter can consult and update its
existing intent store even for a new empty-history WebChat request. Plugin
manifest hook lists are not a complete runtime hook inventory. We did not read
that store or any bootstrap contents, create a new session, or call a model.

Accordingly, the prior plan's excluded-context list is an unfulfilled test
requirement, not an observed guarantee. One fresh session would exclude its old
transcript only after an actual empty-history check; it does not by itself
exclude canonical USER/MEMORY, personal overlays, active skills, standing
intents or other prompt contributions. No prompt hook here is advertised as a
hard pre-provider stop. The packet remains `executionReady: false`: first review
the fixture and a narrow reversible context-injection configuration for a
coordinated idle main window, then verify that scope without model calls before
requesting the one paid/private-fragment test. No such configuration was applied.

### Normal-main validation scope (subsequent scheduling correction)

The parent accepted the frozen fixture (17 members,25/25 boundary tests and4/4
fixed-SDK assertions) but superseded the proposed configuration-isolation work:
do not change main bootstrap or other plugins for this test, and do not build
another isolation framework. The accepted packet is saved locally in
`8cdf0ebcc081c83c58d78307fbd0e06df2455a41`; it remains unloaded. The earlier
configuration proposal above is historical, not a next action.

The selected Evidence's leaf and parent policy refs were rechecked against the
fixed catalog metadata. Both id and version are identical, and the existing
resolver de-duplicates them: **one** source-policy judgment is required. The
private selection's two policy records are duplicate refs, not two distinct
judgments. The original single-completion test limit therefore remains correct
for this exact fragment; no limit or production code changed.

The [normal-main request scope](../.task-control/reports/CORE-VAL-001/main-normal-context-plan-20261102.json)
now describes a fresh session with normal main context. Five default bootstrap
files exist: AGENTS, SOUL, IDENTITY, USER and MEMORY; only file metadata was read.
Standing intents can add matching text, and the enabled timeline2.9.0 hook can
derive current activity/location/style context from the configured memory daily
logs, with a seven-day lookback. Skill catalog names/descriptions/locations and
other Host prompt contributions are conditional runtime inputs. A new session
does not exclude those sources or facts derived from old conversations.

The exact runtime prompt cannot be enumerated from metadata alone. In particular,
excluding finance from Core's source tool does not prove finance or other private
facts absent from ambient USER/MEMORY or timeline text. No unrelated body was
opened to classify it. The next approval must cover this normal-main context
plus the selected semi-private writing fragment and its policy metadata, rather
than describing an isolated1002-byte payload. No approval or model run is implied
by this plan; publisher stays off and the existing data grant is unchanged.

### Approved normal-main attempt: initial failure and subsequent recovery

The following paragraphs preserve the initial failure/recovery sequence. The
latest observation is ordinary-runtime recovery complete; it does not accept
the failed source/model test.

The later explicit approval was consumed by exactly one real WebUI request on
2026-11-02. The [actual result](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/README.md)
records context-preparation timeout, no reply, existing conversation-hook
permission blocks and unverified provider usage. The90-second abort fired, but
was not a hard end-to-end bound. No source or semantic acceptance was achieved.

The exact pre-test configuration bytes are restored and the test session is no
longer active. Runtime rollback is **not complete**: retained plugin work blocked
the official drain, so temporary generation12 remains active. Do not send another
model request, silently enable conversation access, or declare the fixture
unloaded. Resolve this recovery item first; original limits/grant/publisher remain
unchanged. Earlier unloaded/no-approval statements retain their preparation-time
identity and are superseded by this dated outcome.

Recovery follow-up: official active-only session enumeration returned zero; the
one proposed supported restart was rejected by automatic approval **before
process creation**. It has not run or been retried. See the recovery section of
the actual-result packet. Runtime restoration remains pending; blocked hook
registration and context timeout are observed together, not a proven causal chain.

Subsequent recovery completed after direct user authorization evidence and one
same-channel official restart. New process31634 loaded the ordinary artifact
(generation2), RPC is healthy, active/queued sessions are0, and full configuration
bytes—including selfie settings—match the pre-test baseline. The temporary
fixture is unloaded. Shutdown exhausted its retained-work budget, so this is
process recovery, not clean drain. See `RECOVERY-COMPLETE.json` in the result
packet; the failed model/source acceptance and unknown billing remain unchanged.

### Post-recovery diagnosis: actual wait still not identified

The existing official stability snapshot records `context_assembled` at
2026-11-02 11:20:31.026 UTC and no `model.call.started` in the current-request
time window. The aggregate `preparing_context` label therefore does not mean
initial context assembly failed. Phase events lack a run identifier; association
uses the sole logged test in that window, and billing remains unknown.

A pure synthetic reproduction using exact10.9 functions demonstrates that an
outer abort can finish while a pre-provider persistence wait and physical work
remain pending, even with an already-aborted signal. Three contrasts passed;
none identifies the actual blocked await or proves a deployable repair. Hook
permission rejection is synchronous registration skip, not a demonstrated
timeout cause. See the [diagnosis packet](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/DIAGNOSIS.json).

Next evidence must locate the specific pending owner without a provider request,
then preserve actual write settlement while fixing cancellation. Do not clear
retained custody or enable conversation access merely to make the test finish.
No additional Host/model request, configuration change or permission expansion
was performed in this diagnosis.

Further exact-function contrasts narrow the actual run to an entered Agent loop:
the timeout warning reads real `isStreaming` state. Preflight alone cannot explain
that state, while in-loop persistence/projection waits and terminal event barriers
can. The [bounded follow-up](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/WAIT-BOUNDARY-DIAGNOSIS.json)
preserves this remaining ambiguity. A one-line, uninstalled upstream candidate
checks cancellation before entering a new projection wait; it leaves in-flight
write settlement intact and is explicitly not a repair proven for this real run.
No safe public-plugin replacement for the Host-owned wait has been established.

A single bounded extraction of existing original-run queue/SQLite metadata found
no distinguishing operation record. The [default-off observation candidate](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/WAIT-OBSERVATION-CONTRACT.md)
preserves original await/cancellation/settlement semantics and is not installed.
Its10 local instrumentation checks are not a reproduction or repair of the real
hang. A proposed synthetic collection remains execution-not-ready because the
previous sandbox-application denial has not been resolved; no service/model retry
or permission change followed from this investigation.

The observation candidate's R0 fault-containment claim was subsequently rejected
by two actual Node counterexamples. [R1](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/observation-r1/README.md)
uses private delivery and a dedicated diagnostic pipe; the same two faults now
leave the business process running and mark capture incomplete. Original awaits
remain unchanged and the candidate is still uninstalled/pending review. A single
authorized same-profile `/usr/bin/true` capability probe again returned sandbox
activation EPERM/exit71. No service or model retry followed.

R1 fault containment was accepted, but its `beforeExit` completeness receipt was
not. [R2](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/observation-r2/README.md)
removes that receipt and offers partial observations only. One deterministic
late-work counterexample verifies removal of the premature assertion; exit0,
closed output, paired spans and no recorded observer fault still do not attest
complete capture. Await edits and installed runtime remain unchanged. Preparation
ends at review; no further sandbox/service/model attempt is assigned.

The R2 [independent review](../.task-control/reports/CORE-VAL-001/main-native-once-20261102/observation-closeout/R2-INDEPENDENT-REVIEW-SUMMARY.json)
accepted only the uninstalled partial-observation candidate:17 frozen members
match, and the five awaits and R1 helper are unchanged. No completeness, real
cleanup or root-cause claim follows from exit0, pipe closure, paired spans or
internal incomplete:false. Preparation is closed. OS sandbox EPERM/exit71 and
the unknown real pending owner remain blockers; ordinary main recovery is the
dated earlier observation, not a new health probe. Paid quota is exhausted. No
installation, sandbox retry, service or model request is assigned by this save.

### 2026-11-03 Fixed-program code-mode fixture repair (uninstalled candidate)

The post-timeline comparison terminated, but the model used the native code-mode
`exec` transport and the original fixture rejected it before the selected source
read. This is a test-transport incompatibility, not evidence of a source grant
failure or a model choosing a different business operation. The original failure
and the stale registration-only receipt remain historical.

The narrow candidate accepts **one exact executable program**, generated by
`singleSourceCodeModeProgram(ref)`, only when both public hook objects carry the
Host's `toolKind=code_mode_exec` and `toolInputKind=javascript`. The exact complete
program is a fixture artifact, not a JavaScript safety classifier: no regex,
partial match, AST heuristic or rewrite of model-authored code is used. Different
formatting, another program, a plain shell exec, spoofed params, store/load,
network code, replay and a second control call fail explicitly. `code`/`command`
aliases must agree; the fixture requests `awaitResults=true` and rejects `wait`.
A future test must supply this exact program in its new request; this does not
claim arbitrary model-generated JavaScript or autonomous tool selection works.

Fixed 10.9 source exposes authenticated control-kind facts and routes normal
nested tool calls back through the regular tool policy path. It also exposes
session-store and other bridge operations that do not all use ordinary tool
hooks; therefore **allowing arbitrary exec plus filtering inner tools is not an
acceptable substitute**. The fixed program only searches the named source tool
and calls it once. The inner selected-ref/read-only check, original v2 guard,
source permission, cancellation, 90-second deadline, one attempted read and one
logical policy completion remain enforced. Source policy still uses the original
completion adapter; the fake completion in tests is only a synthetic collaborator.

The entry's third callback now receives a counters-only immutable snapshot, not
a getter. The future private loader must synchronously persist each callback
snapshot; reusing the old registration-only loader is invalid. Dispatch,
admission, denial, source start/settlement, policy start and close record directly
inside the restriction logic. The native hook runner stops after a blocking
hook, so a later observer cannot provide the rejection receipt. Sink errors
close the test and prevent further effects; async sinks are unsupported and
their rejections are consumed without a global exception handler.

`collectionComplete` is always false. The bounded report joins the latest
persisted observation with separately verified official facts for the exact
run; a stale zero snapshot, exit0, paired hooks or file closure never proves
full collection. Missing/active/wrong-run Host facts do not establish terminal
state. A read that completed internally does not prove that its result was
received or semantically used by the model.

This packet changes only test fixtures, focused tests and documentation. No main
load, model request, source body read, grant change or sandbox activation occurred.
The fixed-SDK replay evaluates official functions with synthetic collaborators;
it is not a live Host, worker isolation or browser acceptance. See the
[review packet](../.task-control/reports/CORE-VAL-001/code-mode-fixture-20261103/REVIEW-REQUEST.md).


## 2026-11-03: descriptive candidates for native forward retrieval (unloaded)

The previous ordinary list supplied opaque refs plus role/time metadata; it did
not supply the existing reviewed descriptions needed to choose relevant sources.
The [descriptor-list implementation packet](../.task-control/reports/CORE-VAL-001/source-descriptor-list-20261103/REPORT.json)
closes this data-to-Agent gap using the existing processing grant, not a new index,
permission, retrieval engine or memory store. The native Agent remains responsible
for semantic selection and evidence sufficiency; no keyword routing is added.

The admission adapter returns the matching leaf descriptor only after the current
request, model, audience, original grant, base/leaf scope and metadata-processing
checks. The reader snapshots it before another await, verifies Source/version,
leaf policy/version and exact segment binding, and projects only documented fields.
Missing, invalid or mismatched descriptions fail; they are never reconstructed
from private payloads. Metadata access still does not grant original-body access:
`read` keeps its existing semantic source-policy checks, cancellation and exact
original-byte verification.

The tool description instructs the native Agent to follow cursors, select relevant
candidates semantically, and verify originals/roles/times before answering. This is
integration guidance, not proof that the model followed it. Synthetic tests cover
the actual ordinary hooks/factory through list then exact read, rejected metadata
and body access, and capacity-safe continuation. The production grant, data root,
Host and model configuration were not changed; no private payload or paid model
was used. The coordinator subsequently reported independent acceptance:
42/42 on SDK2026.10.9; [review record](../.task-control/reports/CORE-VAL-001/source-descriptor-list-20261103/INDEPENDENT-REVIEW.json).
It remains uninstalled. Real semantic behavior and10.8 compatibility are unverified;
this does not complete forward-understanding acceptance.


## 2026-11-03: recorded provenance in original reads (unloaded candidate)

The source contracts already contain a speaker label and originating collection /
record identifiers. The ordinary read previously dropped those fields, leaving
the native Agent unable to distinguish two speakers with the same role using the
recorded metadata. The [provenance increment](../.task-control/reports/CORE-VAL-001/source-provenance-read-20261103/REPORT.json)
projects these existing fields alongside the exact Source/version and payload
selector. No identity mapping, origin inference or new source lookup is added.

Provenance is returned only with a successful original read after its existing
metadata admission and both source-policy gates. List output does not gain these
attribution fields. Unknown speaker labels remain null; model, requester, owner
flags and surrounding text are not used to fill them. Only speakerId and the
three documented origin fields are projected; other origin properties are not
released. A provenance object above16KiB UTF-8 fails before source-policy
completion or payload access, without truncating identifiers. The separate128KiB
original-text limit, freshness, cancellation and publisher-off boundaries remain.

Synthetic tests exercise stored versions with two distinct speakers sharing a
role, unknown identity, field projection, capacity and the actual ordinary
factory's permitted/denied read output. These tests do not establish truthful
source labels, real-person identity, model understanding or installed behavior.
The change is not installed, and no private data, external model, permissions or
Host configuration was used or changed during development.

The coordinator subsequently reported independent acceptance of commit
`57267dc7343dacd44fbe5a90cc655260bf4b7c0f`; the
[review record](../.task-control/reports/CORE-VAL-001/source-provenance-read-20261103/INDEPENDENT-REVIEW.json)
preserves its limits. In particular, `upstreamId` is the originating adapter's
source-record key, not proof of a platform message ID or a resolvable message URL.

## Native forward-understanding guidance (unloaded candidate)

The packaged [stella-understand-sources skill](../skills/stella-understand-sources/SKILL.md)
connects the ordinary list/read seam to the existing native Agent loop: understand
the question, select relevant descriptions, read originals, follow contrary or
updated evidence, then answer with source attribution and explicit uncertainty.
It is eligible for normal model discovery and needs no briefId or special command.
There is no second retrieval loop, keyword ranker, memory store or automatic writer.
The existing plugin `skills` directory already covers the file; no tool contract,
grant, model client or Host configuration changes are part of this candidate.

The skill is guidance, not a security boundary or proof of semantic consumption.
Host skill selection may still exclude it. Enabling it, loading the two accepted
source increments, and running a model are separate actions. The current
full-tool main must not be treated as a source-only executor; prior paid-test
permission is exhausted. No test fixture or prompt can replace those boundaries.

The next product milestone is one natural question answered from relevant original
sources, with meaningful counterevidence considered and observation distinguished
from inference. Remaining dependencies cover the whole path:

- The fixed selected migration has a finite original-source supply (97 sources /
  362 descriptors). It does not establish complete migration of nonempty old
  Understandings, Ongoing Work or Learning Changes; those need selected legacy
  inputs and explicit reassessment in CangHai. They are not a prerequisite for
  answering a bounded question about the already selected originals.
- The accepted descriptor/provenance code plus this guidance must be reviewed as
  an installable combination and exposed through an approved native tool scope.
  SDK10.9 discovery is distinct from the project's pinned10.8 compatibility.
- A newly authorized real request must demonstrate native selection, successful
  source-policy judgment, original read, final model consumption and a useful
  source-grounded answer. Neither schema/tests nor a successful file read closes
  that semantic milestone. No new request is authorized by this document.

Execution ownership, current blockers and the next assigned action remain only in
the [task index](../.task-control/state.json), rather than a second schedule here.

## 2026-11-03: ordinary memory-core admission compatibility (unloaded candidate)

The real source-only main test reached the original `stella_source_read` through
Tool Search five times, but every `list` returned Core's
`source_requester_or_audience_forbidden` failure. It read no original and produced
no grounded answer. Main's normal configuration was restored; this diagnosis does
not authorize another model request.

Pinned official 2026.10.9 code identifies a contract mismatch: default memory-core
registers `runtime`, not a native `providerRuntime`. The Host intentionally omits
the optional `memoryAudience` on this ordinary-memory route. Core had required
`owner-private` unconditionally. Tool Search dispatches the existing target tool;
it does not mint an audience or replace the factory's captured identity. The
[diagnosis packet](../.task-control/reports/CORE-VAL-001/memory-core-source-compat-20261103/REPORT.md)
distinguishes this reproducible cause from the uncaptured individual fields of
the real run's shared error condition. It does not establish this as the only
remaining admission problem.

The candidate retains the native-audience check when an audience is supplied.
For an absent audience it instead requires the public selected-memory registration
to be ordinary memory-core, with the same runtime and no native provider, plus the
already checked direct authenticated WebUI request, owner, attested device, native
input admission, run/call/session incarnation and v2 lifetime guard. Only that
device's exact pre-existing `openclaw-device:` source-processing grant qualifies.
A profile-only grant, other provider, missing device, supplied conflicting
audience, delegated ingress or mismatched request still fails. Core does not
construct a native audience or change any grant, identity or conversation access.
The original source versions, descriptor scope, usage-policy checks and read
guards remain in force; list permission still does not confer body access.

Synthetic affected tests and a bounded official-source probe passed on 2026.10.9.
This is an unreviewed, uninstalled candidate, with no new model request, private
original read or main configuration change. Independent review, installed behavior,
10.8 compatibility and a successful source-grounded answer remain unverified.
