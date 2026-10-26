# WebChat device owner: local synthetic verification

Date: 2026-10-26 UTC. Contract: [explicit device owner](WEBCHAT-DEVICE-OWNER.md).

## Candidate and package

- Runtime source commit: `7cbd54118868de6a0a47eb9eddfea637218f540e`.
- Package: `tower1229-stella-core-0.1.0-alpha.0.tgz`.
- SHA256: `7beed14afb005ab96fadc29a81c2963f9a322ae2719dfc217c2144967b46e05d`.
- Offline `npm pack`, followed by validated tar unpack into a fresh project-local
  consumer. All 498 package files matched the source/build output and were
  rehashed after Host verification. Existing project dependencies were used;
  this is not a fresh npm dependency-resolution acceptance.
- Build identity records the source commit above and `sourceClean: false` because
  four pre-existing untracked planning/test files remain. They were neither added
  to the commit nor included in the package. There were no tracked source changes
  at package build or after verification.
- Host: existing original OpenClaw `2026.8.2`, Node `v24.22.1`. Public package and
  selected SDK/runtime fields were checked; the complete Host tree was not hashed
  or authenticated, and no Host source was changed.

## Results

| Layer | Result and evidence scope |
| --- | --- |
| Static checks | TypeScript no-emit, 9 JSON schemas and probe syntax passed. |
| Isolated targeted regression | 115/115, exit 0; identity diagnostics, default profile compatibility, device/profile exclusion, device/scopes/provenance negatives, tool argument forgery, run/session reuse, unknown history, source grants, archive/CAS and cancellation. |
| Source-grant negatives | Missing or other-principal grant blocks Agent/model and old-memory consumption. Tests cover local input archiving on/off; with archiving enabled the owner's current input can already have advanced CAS. No zero-write claim. |
| Original Host installed-package path | One synthetic WebChat device scenario, three same-owner same-session user requests; real Host Agent calls list/read and continues to the loopback model, with automatic input archive and fresh checkpoint B consumption. All three persisted archive journals contain the exact independent device principal and matching run IDs. |
| Request capture | 9 main Agent HTTP requests, 0 auxiliary title requests, 9 total; complete fake-provider inputs captured. Diagnostic RPC precedes all model requests and returns missing profile plus the exact signed device ID. No identity was injected into hooks. |
| Lifecycle | One setup refresh for initial skill discovery: two sequential isolated Gateway processes, both exit 0 without signals. No reset/restart during the three conversation turns. Probe exits 0; provider closed, owner registration removed and synthetic source fixture deleted. |

The first draft run had 110/113 passing checks: the two grant subcases and their
parent failed because the test read status after a later rejection had overwritten
the original category. The assertion timing was corrected. SDK import warnings
also showed ambient configuration discovery, so the accepted rerun used a
whitelisted environment and isolated HOME, state, config path, tmp and cache.
The draft is not counted as an isolated pass. After a connection interruption,
the existing completion receipt/log was recovered; the successful rerun was not
started again.

## Reproduction and local evidence

The targeted command is `node --test --test-concurrency=2` over the compiled
`webchat-identity-diagnostic`, `checkpoint-agent-supply`,
`checkpoint-request-ingress` and `checkpoint-plugin-runtime` test files, after
type/schema checks and `node scripts/compile.mjs test`.

For the bounded installed-package Host scenario, run
`node scripts/probe-checkpoint-agent-supply.mjs device a1 continuous_chat` with
`STELLA_AGENT_SUPPLY_DEVICE_OWNER=1`, an isolated whitelisted HOME/state/config/
tmp/cache, `STELLA_AGENT_SUPPLY_ARTIFACTS`, `STELLA_AGENT_SUPPLY_COMPILED`,
`STELLA_AGENT_SUPPLY_PACKAGE_ROOT` and the verified existing
`STELLA_PROBE_HOST_ROOT`. The existing Mac sandbox rules restrict the Gateway to
synthetic writes and loopback; they were not expanded.

Local receipts live under `.artifacts/webchat-device-owner-20261026/`:
`verification.json`, `targeted-tests.log`, `package-receipt.json`,
`host-run.json`, `host-probe-device/result.json` and its provider request files.
These generated artifacts are not committed.

## Remaining acceptance boundary

This proves an actual original Host protocol/tool path with a synthetic signed
WebChat client and fake provider. It does not prove a human login, the current
Chrome connection, real model reasoning quality, or all `full_memory` capabilities.
The negative identity matrix uses labeled public-API fixtures; it is not a claim
that every negative was replayed through the real Gateway. No real main deployment,
identity/source grant, private source, CangHai repository or external model was
changed or used. No push was performed.

Next enablement requires separate concrete approval: load the candidate into the
same main Gateway and restart it for read-only browser `stella.identity {}`;
then select that returned device ID and authorize its exact independent requester
in the existing source processing grant, retaining purpose/audience/model limits.
Unknown prior history is not adopted; begin a fresh conversation once if needed.
Any real model/private-context transmission still needs its own data/cost scope.
