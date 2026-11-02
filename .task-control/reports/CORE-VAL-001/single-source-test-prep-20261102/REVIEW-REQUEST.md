# Single-request source test preparation — not execution-ready

This packet prepares the existing fixed90f/97-source/362-descriptor ordinary
plugin for one native request. It does not run it. Parent-requested no-model
preparation is the only scope; no new grant, source body, account, listener,
session, Host load, config change, model call or push occurred.

## Reviewable change

- `scripts/lib/single-source-test-boundary.mjs`: exact session incarnation and
  native run/call/request-hash restriction; exact Evidence id/version; one
  source-tool execution attempt including failures; one logical source-policy
  completion with requested maxTokens at most8192. Synchronous consumption
  closes concurrent/repeated-call gaps. Original factory guard is captured;
  cancellation and return-boundary identity checks remain. The ninety-second
  check rejects further test actions; it is **not** a provider hard-kill or cost
  ceiling.
- `scripts/fixtures/single-source-native-entry.mjs`: unloaded thin entry over
  the unchanged ordinary module. It passes through the original factory and
  official `createSourcePolicyCompletion`; it supplies no admission, identity
  or policy verdict. No private seed or automatic file loader is included.
- `scripts/lib/single-source-test-boundary.test.mjs`:25/25 synthetic cases.
  Original Core and actual Host checks remain separately accepted/unverified
  according to their existing evidence; mocks do not prove real grant access.
- `official-context-replay.mjs`: fixed local10.9 source replay, with synthetic
  functions replacing workspace and intent storage. Three runtime assertions
  plus one static callsite assertion pass4/4, separately from25/25. Its first run
  had an incorrect relative repository path (ENOENT, before replay); preserved
  as `official-context-replay-r0-path-error.*`, then corrected. No permissions
  denial or source failure is attributed to that script error.

## Context result and exact unresolved action

**Blocked action:** submit the proposed native `chat.send` with the claim that
only selected test data reaches Gemini. **Reason:** that claim is false for the
current config; no model approval has been requested or granted for extra data.
No action was denied by a tool in this packet. The paid action is not attempted.

Official `embedded-agent-DoEPu8ye.mjs:8923/9032` passes the canonical main
workspace separately from the empty execution worktree.
`attempt-system-prompt-prepare-ChKsbjSh.mjs:171/1710/1742` uses it for bootstrap.
The actual effective context setting observed read-only is `always`. The
synthetic replay proves the resolver runs; `never` skips it. It does not prove
which real files exist or their contents; those were not read.

Separately `extensions/memory-core/index.js:1000` registers a user-turn
`before_prompt_build` standing-intent hook. A fresh empty-history turn invokes
it in replay. The official worker at
`standing-intents.worker-DmGG7G9f.mjs:55` can query and update existing intent
records. Context injection and empty history do not turn this hook off.
Public plugin inspect declared/component hook arrays were empty for memory-core
and timeline, yet the memory-core source registers this hook; those arrays
cannot certify absence of runtime injections. Other prompt contributors are
not proven absent. No actual intent database or private bootstrap was inspected.

If run unchanged, potential additional input categories are canonical
USER/MEMORY/other bootstrap files, a personal USER overlay when applicable,
active skill instructions, standing-intent text and other registered prompt
contributions. An existing session could also contribute history. This is a
source-based possible input inventory, **not an actual captured prompt**.

The minimal next configuration candidate is main-specific
`contextInjection: never` plus explicitly suppressing applicable prompt
injections for the short test window using the official plugin
`hooks.allowPromptInjection` policy. That policy affects a plugin's registered
prompt hooks across sessions, so it must be reviewed against the current plugin
inventory and applied only in a coordinated idle window with exact rollback.
Fresh incognito/empty-worktree session and explicit disabled skill overrides
then require an actual no-model empty-history/context check. This packet does
not apply these changes or assume suppressing memory-core alone is sufficient.
Do not use a prompt instruction, thrown hook error, late llm_input observation,
modelRun flag or fabricated run/recorder as a substitute.

## Next native test, once these prerequisites and approval are real

`PLAN.json` records the official RPC fields and bindings. One fresh main session,
no parent/fork/task/message/attachments/project, low thinking, no model override;
exact returned session incarnation goes into a private seed with the previously
selected Evidence ref and exact request hash. The factory stays unloaded until
review. The existing real browser/operator/device must still satisfy the
original grant. Only then one `chat.send`, no retry on failure/unknown,90-second
request timeout, publisher off; preserve actual result and restore the normal
artifact/config. Do not read private source bytes to prepare that seed.

Expected flow is first Agent completion, one source applicability completion,
then an answer completion. Only the local source-policy port has a one-logical-
call limit. Agent turns, provider physical retries, total tokens/reasoning and
dollars have no established hard cap. The source-policy request asks maxTokens
8192; requested answer length300 Chinese characters is not a token hard cap.
The proposed material is one1002-byte **semi-private** writing fragment, unknown
author/role. No body sensitivity review has happened. It is not finance or a
public/synthetic fragment. Additional context must be excluded before presenting
this as the narrow approval request.

## Evidence and unchanged state

Use `REPORT.json`, `PLAN.json`, `MANIFEST.json` and `changes.patch`. The manifest
binds all review members; the state file is a separate revision130 coordination
update, not a source input or a self-hashing acceptance record. Current normal
main binding and prior generation11 observation are retained; this packet does
not perform another health probe or claim a new generation. Private selected
ref/seed and rollback configurations are excluded.

Parent's independent remote6bc CI result is preserved accurately: both runs
41425072886/41425072861 fail,1842/1816/26, normalized old26 unchanged, eight new
device/grant cases pass. Check/schema pass. CI SDK10.8 does not verify installed
Mac10.9; prepare blocked installed/fresh-install and probes; verify lacks
prepared.json. No full-memory or overall-green claim.
