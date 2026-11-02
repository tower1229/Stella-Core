# Ordinary-plugin main debug build

The initial ordinary build uses `dist/src/ordinary-plugin.js`. It contributes two
ordinary tools and the authenticated `/stella-status` command. OpenClaw owns its
memory, context and Agent loop. No Core provider, context replacement, background
consolidation, private source reader or writer is registered by this entry.

Use `{ "agentId": "main", "publisher": false }` as the plugin configuration.
Legacy checkpoint configuration is rejected explicitly. Historical implementation
and its manifest remain in `src/plugin.ts` and `legacy/openclaw.plugin.json`;
the package entry does not import them. Existing source repositories, checkpoints
and user files are not migrated or removed.

`stella_author_intent_candidate` accepts a structured proposal from the Host's
model: topic, interpretation, proposed premises, open questions and evidence
references. It validates structure only, preserves unresolved questions and
returns an **unconfirmed, unsaved candidate**. References supplied in arguments
are unverified. The tool cannot confirm the author, publish an asset or save
memory. Natural-language interpretation remains the model's responsibility.

Candidate results also report the current public tool lifecycle binding.
`requestBinding.scope=run_and_tool_call` means the Host supplied matching run and
call metadata; `scope=tool_call` with `host_run_not_provided` means only the actual
call was supplied. Direct Gateway tool invocation currently follows the latter
path. Neither scope establishes a user-input admission, author identity or source
permission. A missing hook is explicitly `unavailable`; conflicting observed
identities reject the call. Model arguments cannot supply or override this field.
The hook reads no proposal, prompt, transcript, recorder or requester data. Only
pending calls are retained in memory, consumed once or discarded on cancellation;
capacity exhaustion is explicit. No conversation-access grant is configured.

`stella_status` and `/stella-status` show the active contract without a model
call. The existing main Gateway can invoke the tool directly:

```sh
openclaw gateway call tools.invoke \
  --params '{"name":"stella_status","agentId":"main","args":{}}' --json
```

This checks real tool execution, not model understanding or personal-source
admission. Normal conversations can discover the tools through the `coding`
profile and OpenClaw's existing Tool Search. No Tool Search configuration change
is required for this install.

For local debug installation, build and pack the repository, unpack into a new
artifact directory and retain the previous artifact. Runtime dependencies must
be inside the package boundary; a `node_modules` symlink to the workspace is
rejected by OpenClaw's install scan. Use the existing Host's public SDK rather
than bundling another Host. No dependency download is needed when reusing the
already installed runtime dependencies; record their actual versions separately
from the lockfile.

Before changing the current main configuration, save its exact bytes privately
with mode `0600`. Replace only the old Core load path and Core entry with the new
artifact/configuration, then validate it with `openclaw config validate --json`.
The official local link install records package ownership and applies the running
generation:

```sh
openclaw plugins install --link /absolute/path/to/unpacked/package --force --no-enable
openclaw plugins inspect stella-core --runtime --json
```

Here `--force` confirms this reviewed local build. `--no-enable` preserves the
existing activation/allowlist/slot policy. Do not add capability-consent or safety
override flags to make an install succeed. Preserve failures before fixing the
actual package defect.

Rollback retains both artifacts and the private config backup. If the current
config changed since installation, restore only the two Core fields after
comparing the changes; never overwrite intervening user edits. If removing the
new link's official install record, use `plugins uninstall stella-core
--keep-files --force` before restoring the old entry/path. Verify the restored
runtime separately; a restored file is not proof of a loaded generation.

This debug milestone does not enable confirmed publication, connect private
sources, migrate old state, call paid models or establish `full_memory`.
The previously exhausted isolated Host batch remains historical and is not
reused by the main-instance installation.

The later optional [unconfirmed work-brief increment](CANDIDATE-WORK-BRIEF.md)
adds `stella_work_brief` and `candidateDraftsRoot` for an explicitly initialized,
separate synthetic-debug Git store. It preserves the candidate-only authority
boundary while allowing explicit save and versioned restore across requests.
Without this configuration, persistence remains disabled. The initial installation
facts above retain their historical identity; the new increment has separate
tool, transaction, installation and rollback evidence.

The reviewed draft increment was loaded on main at generation 11. The official
reload first accepted only the added declared tool, then enabled the fixed
synthetic root. That declared-surface acceptance persists until revoked; it is
not a four-call grant or OS/source permission. Four public SDK owner-context
calls verified save/read/CAS update/read without a model. Ordinary CLI
`tools.invoke` selects only `operator.write`, so use the existing authorized
owner SDK entry described in the draft guide. Initial failures and main8 rollback
remain historical. That checkpoint retained native memory/context/Agent loop;
the later continuation increment and its evidence are recorded in the draft guide.

## 长期开发约定与设备交接

2026-11-02 补记既有用户要求与工程取舍，供后续开发和交接必读；不是新的架构决定。

- **核心目标**仍是私人 Agent 对用户的长期理解、纠正与接续，不能把插件壳、存储 API 或 CI 数量作为完成目标。完整产品要求见 [需求记录 §1](09-REQUIREMENTS-ALIGNMENT.md#1-产品目标与完整功能)。
- **工程路线**沿用本文件已获准实施的官方普通插件接入，保留 OpenClaw 原生 memory-core、context 与 Agent loop；[重对齐方案](design/2026-10-30-core-realignment/proposal-reviewed-draft.md)记录经理对来源和工作说明的工程取舍，不取代已确认产品需求，也不是用户对全部草案的批准。不另造一套宿主或重复记忆权威。
- **推进方式**按用户已明确的纠正：先做能安装的最小新架构版本，在既有实际 Host 中调试，围绕真实问题修复并逐步优化。先核查和复用已有能力，避免把外围合成验证链、旧私有桥或26项历史失败的修复当作普通插件开工前置。旧失败与未完成要求仍保留，不通过删测试、放宽门禁或复活旧桥来改绿；旧模块处置仍依 [方案 §6](design/2026-10-30-core-realignment/proposal-reviewed-draft.md#6-旧模块处置与阶段边界)。
- **证据分层**：安装／技能可见、真实工具读改、模型实际消费和语义效果分别出证。候选保存与恢复不等于长期理解，工具回执不等于模型已采用；可信原文／作者来源和完整记忆的未验范围，以 [工作说明接续](CANDIDATE-WORK-BRIEF.md#explicit-continuation)及具体报告为准。当前执行进度仅见 [唯一状态索引](../.task-control/state.json)，不从本文的历史代次恢复任务。

### 当前主线与工程脚手架

当前开发优先级由 [需求 §1.5 的2026-11-02决定](09-REQUIREMENTS-ALIGNMENT.md#forward-understanding-priority)统一维护：数据结构／必要转换／开发接入先行，再做已有资料的正向理解、召回、语义路由和回答，之后推进纠正及传播。此前“先纠正”的开发排序不再调度；完整纠正目标和验收要求保留。具体执行状态和恢复条件只在唯一台账维护，不从本文历史安装记录恢复任务。当前数据源与已安装普通插件的接入区别见 [两仓数据基础核查](CORE-CANGHAI-COORDINATION.md#data-foundation-snapshot-20261102)。

2026-11-02 本地 [显式 manifest 的只读来源端口候选](ORDINARY-SOURCE-READ.md)已继续接入公开当前请求／工具调用与既有处理配置的薄适配器，并按原获准描述符过滤；仅合成验证63/63及独审反例修后重放通过，离线候选已独审通过、尚未安装。原元数据 P2 已独审关闭；固定旧包的两项来源读取缺陷保留并在本增量修复。当前 main／私人根仍未绑定，公开生产者字段及真实语义消费仍待实际验证；不能据配置、hash或合成回执称已读沧海。 最小独审摘要与默认模型／实际入口的后续边界见 [验收证据](../.task-control/reports/CORE-VAL-001/source-admission-review-20261102.json)，不由离线通过推导新的执行授权。

工作说明仍可作为以后纠正闭环的单资产载体。候选 CRUD、手动 briefId 和 `stella-continue` 只是当前合成调试脚手架，不是 Stella 的完整产品形态，也不是用户被要求永久采用的交互方式。不能把合成回读、字段齐备或 hash 匹配升级为模型已经理解和采用；真实工具供给、模型消费与回答仍需各自证据，且不把检索和路由僵化成单向硬流水。

当前 `publisher off` 是尚未闭合来源与语义验收时的运行边界，不是产品永久逐次审批规则。[主动交付资料的默认整理权](09-REQUIREMENTS-ALIGNMENT.md#41-用户主动交付资料的默认整理权已确认)仍有效。真实私人来源接入、付费模型调用及共享 Host 操作各按实际授权；局部缺授权不阻塞其他已授权工程，技术夹具也不代替真实消费者和作者效果验收。

### 设备与跨项目依赖

当前分工是 **Mac 开发、15pro 最终集成测试**。Mac 上的组件或合成 Host 调试记录保留其范围，不能直接标为15pro最终集成验收。

TTS／视频的唯一详细正文位于同一工作区的 [Bili `docs/ARCHITECTURE.md` §9.2.1 制作路线与开发交接](../../openclaw-bili-plugin/docs/ARCHITECTURE.md#media-development-handoff)。Core所需的最小交接是：用户已确认15pro声音合成服务开发调试成功，Mac开发按已有服务可用的依赖准备。声音质量／成本与媒体制作路线均到Bili正文取用；Core不重复定义服务接口、供应商或视频策略，也不由此新增直接TTS功能契约。

用户确认服务现状不等于Core已取得URL／协议／声音标识、已验证Mac跨机调用或已在15pro完成联调；这些未验证项不能用本机健康检查、固定音频或工具读改代替。跨项目边界仍见 [Host 集成 §9.8](04-OPENCLAW-INTEGRATION.md#98-2026108-技术评估与当前接线门槛)。
