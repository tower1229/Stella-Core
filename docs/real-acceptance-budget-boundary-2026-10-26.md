# Real-model acceptance: physical-request budget boundary (2026-10-26)

This is a blocked acceptance preflight, not a budget-limiter implementation or a real-model pass. Core source inspected: `f37d9935d35098c270d2f0a9c54d08e6712c37ee`; installed stock OpenClaw: `2026.8.2`. No Host files or runtime code changed.

The acceptance batch requires a shared US$10 ceiling across the main Agent, required source-policy/personal-view calls, and every physical retry. A pre-send reservation must precede each billable attempt. Post-response usage, a planned call count, timeouts, repetition detection, and logical-call counters cannot establish that ceiling.

## Public interfaces checked

| Interface | Verified contract | Remaining gap |
| --- | --- | --- |
| `before_agent_run` | Fail-closed run admission after prompt construction | No published admission contract for every tool continuation, direct auxiliary call and internal HTTP retry |
| `llm_input`, `model_call_started` | Observe; void return; observation errors do not become run gates | Cannot reject each physical attempt |
| `api.runtime.llm.complete` | Plugin-owned logical call, optional `maxTokens` (documented advisory), usage returned afterward | No fetch, physical-retry admission or shared-budget argument |
| Provider `wrapStreamFn` / `wrapSimpleCompletionStreamFn` | Provider-owned stream wrappers | Not a global Stella plugin middleware contract for stock Google's internal retry fetches |
| Provider acceptance observer | Internal observer of HTTP response or accepted stream | Observation occurs after dispatch; not a pre-send gate |
| `configureAiTransportHost` in the underlying AI package | Installs Host implementations for transport policy ports, including managed fetch | Host integration port, not an advertised public plugin budget capability; replacing it is outside this batch's no-Host-modification boundary |

The relevant local public docs are `docs/plugins/hooks.md` (execution/error contract, input gate and telemetry), `docs/plugins/sdk-provider-plugins.md` (provider ownership and stream wrappers), and the installed public declaration files. Exact file hashes are retained only in the local acceptance receipt. No recursive Host scan or full-tree hash was performed.

## Disposition

Nine static contract checks passed. No limiter or synthetic/runtime cap test was implemented: writing a counter without a supported complete interception point would not meet the requested guarantee. No live source grant was activated. The explicitly approved local patch is prepared only. The local ledger remains admission-disabled with zero generation requests, zero spend and zero reservation.

The Google endpoint and configured model were rechecked without reading credential values. The health probe was denied by the execution sandbox (`PermissionError`, errno 1), so this preflight makes no fresh claim about Gateway availability. No retry via another network path was attempted.

The existing data/model/budget authorization is sufficient and does not need to be repeated. The remaining dependency is technical: a supported fail-closed physical-send admission mechanism for all exercised paths, or verified upstream enforcement that provides the equivalent hard batch bound. Until that evidence exists, keep the grant and real-model test disabled. Do not substitute a CLI identity for the original Chrome device, change the Host, create a proxy, or silently weaken the US$10 ceiling. FIN-04 and full_memory are unchanged.
