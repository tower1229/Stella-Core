# Ordinary-plugin selected-source read port

2026-11-02 local implementation candidate; **not installed, independently accepted,
or connected to private CangHai**. This supplies the deterministic read seam for
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
  Evidence metadata rows, exact source/evidence refs, recorded role/kind and
  timestamps. Every row requires metadata-processing admission. No payload is
  read and no semantic ranking is performed. The cursor binds the catalog hash;
  known-by/event-window and exact descriptor-scope exclusions are explicit. A scope
  exclusion is only the adapter's explicit `false`; arbitrary metadata errors fail
  the operation. No out-of-scope row identity or body is returned. A page is not evidence that the
  whole repository was searched or that the question has sufficient evidence.
- `{"action":"read","ref":{"id":"...","version":"sha256:..."}}`: one exact
  original Evidence slice with Source/version, payload hash/selector, original
  role/kind/time, coverage and usage constraints. Both base and segment policy
  remain enforced. Request lifetime is checked around semantic policy awaits and
  immediately before the first payload read. Returned Source references and
  selectors are projected to documented fields. The result is neither author
  confirmation nor publication.

Each invocation opens current data afresh. There is no session-to-latest lookup
or retained permission/reader cache. Original reads enforce the declared time
scope. Dirty state, a different revision, stale cursor, changed object/payload,
invalid/missing reference, policy denial or cancellation is a failure, not an
empty-success fallback. Output beyond128KiB fails without truncation. Selected
UTF-8 byte slices must encode back to exactly the pinned bytes; the inherited
decoder's BOM removal therefore produces
`source_text_representation_unverified` rather than an unreported rewrite.
The existing JSON-pointer selector retains its declared string projection.

Listing and deterministic source checks cannot decide natural-language meaning.
The native Agent / properly qualified structured LLM port must select relevant
sources, follow leads, distinguish facts/inferences and decide answer versus
clarification. No lexical routing or fallback is added. For per-source policy semantics, the
adapter calls only the public Host `llm.complete` port, explicitly selecting
`google/gemini-3.8-flash` with `low`, no sampling parameter, and no configured
fallback. The code passes only the current normalized request and one reviewed
descriptor/policy context; it does not pass original bodies to that judgment.
Actual runtime dispatch/consumption is not verified by these synthetic tests.
No provider call was made by this implementation or its tests. The explicit
agent/model parameters also remain subject to the Host's existing LLM capability
policy. No override permission was added here; an unbound/disallowed Host runtime
must reject rather than select another agent/model. The real public capability
scope must be checked before a later model-backed run.

## Actual verification and remaining integration

TypeScript compilation passed on the observed local OpenClaw SDK2026.10.9 and
Node24.22.1; project manifest/lock still pin10.8 and were not changed. Focused
checks passed **37/37**:11new source-port groups plus5ordinary,10binding and
11draft/continuation cases. Sources, identities and semantic permission verdicts
were synthetic. The real plugin registration/factory code was exercised with an
explicit test issuer; no Gateway, live ingestion, external model or private
payload was used. The initial34pass/2fail run is retained separately. No full
suite, installation, reload, consent, commit or push was performed.

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
The full entry and both local modules remain pending independent review and
uninstalled; no mixed working tree is approved merely by these test results.
The [R1 delivery receipt](../.task-control/reports/CORE-VAL-001/source-read-port-r1-20261102.json)
pins the combined entry patch and its dependency/test evidence.

## Next thin binding candidate and Host validation

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
summed or represented as independent acceptance. It is not installed.

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
