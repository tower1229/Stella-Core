# Unconfirmed work briefs

The candidate ordinary plugin has an explicit `stella_work_brief` tool. It saves and
restores the same **unconfirmed candidate**, including proposed premises,
unresolved questions and opaque, unverified references. It does not confirm the
author, publish an author position or write Core's authoritative long-term
memory. The existing `stella_author_intent_candidate` remains unsaved.

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
