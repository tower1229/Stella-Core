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

## 2026-11-02 来源入口实际加载

已审提交 `df5bc467621fd741bb582c07e8f22c31ce6d01b1` 的来源读取与公开请求适配代码已加载到本机 OpenClaw `2026.10.9`。官方 reload 回执选中 `.artifacts/source-read-20261102-df5bc467/package/dist/src/ordinary-plugin.js`，当前 Gateway generation 5，`restartRequired=false`；2752 个安装文件与冻结清单一致。代次仅属于这次 Gateway 生命周期，不能与旧记录中的 generation 12 直接比较。

实际无模型检查已完成：健康返回 `ok=true`；`stella_status` 返回 `sourceReadPort=not_configured`、`publisher=false`；`stella_source_read` 的 `list` 返回 `source_read_not_configured` 且工具 `isError=true`。RPC 成功只表示调用完成，不能当作来源读取成功。当前没有配置私人来源，未验证真实入场资格、模型消费或语义理解。

本次先遇到宿主 SQLite 资源 broker socket 丢失，在官方状态确认在途工作和写入计数均为零后重启现有 Gateway 一次恢复。随后官方链接安装保留了新旧两条 Core 路径，造成包归属歧义；只移除旧 Core 加载路径并执行官方等待排空 reload 后成功。配置的唯一结构差异是 `plugins.load.paths`，其余模型、资料、selfie 相关设置和插件配置均保留。旧包及 `0600` 私有配置备份仍可回滚；失败回执和断连经过没有覆盖。

非敏感结果、精确哈希和未覆盖范围见 [实际加载证据](../.task-control/reports/CORE-VAL-001/main-source-activation-20261102.json)。下一次资料接入须等待 CangHai 明确的稳定目录、完整提交 SHA、manifest 和原获准描述符范围交接，不能把分支保全等同于运行绑定，也不能自动加入金融资料。执行安排只读唯一台账。

## 长期开发约定与设备交接

2026-11-02 补记既有用户要求与工程取舍，供后续开发和交接必读；不是新的架构决定。

- **核心目标**仍是私人 Agent 对用户的长期理解、纠正与接续，不能把插件壳、存储 API 或 CI 数量作为完成目标。完整产品要求见 [需求记录 §1](09-REQUIREMENTS-ALIGNMENT.md#1-产品目标与完整功能)。
- **工程路线**沿用本文件已获准实施的官方普通插件接入，保留 OpenClaw 原生 memory-core、context 与 Agent loop；[重对齐方案](design/2026-10-30-core-realignment/proposal-reviewed-draft.md)记录经理对来源和工作说明的工程取舍，不取代已确认产品需求，也不是用户对全部草案的批准。不另造一套宿主或重复记忆权威。
- **推进方式**按用户已明确的纠正：先做能安装的最小新架构版本，在既有实际 Host 中调试，围绕真实问题修复并逐步优化。先核查和复用已有能力，避免把外围合成验证链、旧私有桥或26项历史失败的修复当作普通插件开工前置。旧失败与未完成要求仍保留，不通过删测试、放宽门禁或复活旧桥来改绿；旧模块处置仍依 [方案 §6](design/2026-10-30-core-realignment/proposal-reviewed-draft.md#6-旧模块处置与阶段边界)。
- **证据分层**：安装／技能可见、真实工具读改、模型实际消费和语义效果分别出证。候选保存与恢复不等于长期理解，工具回执不等于模型已采用；可信原文／作者来源和完整记忆的未验范围，以 [工作说明接续](CANDIDATE-WORK-BRIEF.md#explicit-continuation)及具体报告为准。当前执行进度仅见 [唯一状态索引](../.task-control/state.json)，不从本文的历史代次恢复任务。

### 当前主线与工程脚手架

当前开发优先级由 [需求 §1.5 的2026-11-02决定](09-REQUIREMENTS-ALIGNMENT.md#forward-understanding-priority)统一维护：数据结构／必要转换／开发接入先行，再做已有资料的正向理解、召回、语义路由和回答，之后推进纠正及传播。此前“先纠正”的开发排序不再调度；完整纠正目标和验收要求保留。具体执行状态和恢复条件只在唯一台账维护，不从本文历史安装记录恢复任务。当前数据源与已安装普通插件的接入区别见 [两仓数据基础核查](CORE-CANGHAI-COORDINATION.md#data-foundation-snapshot-20261102)。

2026-11-02 本地 [显式 manifest 的只读来源端口候选](ORDINARY-SOURCE-READ.md)接入公开当前请求／工具调用与既有处理配置的薄适配器，并按原获准描述符过滤；离线时点的合成63/63及独审反例证据保留。原元数据 P2 和固定旧包的两项来源读取缺陷已独审关闭。后续代码实际加载结果见上文；该离线时点尚未绑定私人资料根。2026-11-02 的固定90f绑定结果见本文件末段，原生请求下的实际来源供给及真实语义消费仍待验证；不能据安装、hash或合成回执称已读沧海。最小独审摘要与默认模型／实际入口边界见 [验收证据](../.task-control/reports/CORE-VAL-001/source-admission-review-20261102.json)。

工作说明仍可作为以后纠正闭环的单资产载体。候选 CRUD、手动 briefId 和 `stella-continue` 只是当前合成调试脚手架，不是 Stella 的完整产品形态，也不是用户被要求永久采用的交互方式。不能把合成回读、字段齐备或 hash 匹配升级为模型已经理解和采用；真实工具供给、模型消费与回答仍需各自证据，且不把检索和路由僵化成单向硬流水。

当前 `publisher off` 是尚未闭合来源与语义验收时的运行边界，不是产品永久逐次审批规则。[主动交付资料的默认整理权](09-REQUIREMENTS-ALIGNMENT.md#41-用户主动交付资料的默认整理权已确认)仍有效。真实私人来源接入、付费模型调用及共享 Host 操作各按实际授权；局部缺授权不阻塞其他已授权工程，技术夹具也不代替真实消费者和作者效果验收。

### 设备与跨项目依赖

当前分工是 **Mac 开发、15pro 最终集成测试**。Mac 上的组件或合成 Host 调试记录保留其范围，不能直接标为15pro最终集成验收。

TTS／视频的唯一详细正文位于同一工作区的 [Bili `docs/ARCHITECTURE.md` §9.2.1 制作路线与开发交接](../../openclaw-bili-plugin/docs/ARCHITECTURE.md#media-development-handoff)。Core所需的最小交接是：用户已确认15pro声音合成服务开发调试成功，Mac开发按已有服务可用的依赖准备。声音质量／成本与媒体制作路线均到Bili正文取用；Core不重复定义服务接口、供应商或视频策略，也不由此新增直接TTS功能契约。

用户确认服务现状不等于Core已取得URL／协议／声音标识、已验证Mac跨机调用或已在15pro完成联调；这些未验证项不能用本机健康检查、固定音频或工具读改代替。跨项目边界仍见 [Host 集成 §9.8](04-OPENCLAW-INTEGRATION.md#98-2026108-技术评估与当前接线门槛)。

## 2026-11-02 已审设备许可修复与真实浏览器身份诊断

已审生产修复提交 `00dab376aea6f751e673c437226d6314fecb8861` 已保存并加载，普通产物为 `.artifacts/device-source-20261102-00dab376/ordinary`，本机 OpenClaw 10.9 当前 Gateway generation 9。设备类型许可始终要求 Host 认证设备事实，不再回退普通 SenderId；原 grant、受众、资料范围和 publisher 设置未扩大。

在现有 Chrome 认证 profile 的独立官方 WebUI Debug 页，实际仅一次 `tools.invoke stella_status {}` 返回五项 true：认证 Control UI、认证 operator、当前 authority、Host 设备事实存在、与原 grant 精确相等。用户原聊天页未触碰；这不是 CLI 代测，也不宣称观察了原聊天 WebSocket 或取得原生用户请求准入。

随后官方恢复普通产物；真实状态工具确认临时字段消失，2752 文件匹配，sourceRead 仍未配置，publisher 关闭，无模型调用。临时诊断产物和私有比较种子已清理；旧产物及私有配置回滚点保留，selfie/其他用户配置语义未改。完整脱敏回执见 [浏览器诊断收尾](../.task-control/reports/CORE-VAL-001/device-source-browser-closeout-20261102.json)。

下一阶段是固定90f/原97来源362描述符的受控绑定及真实原生入场链，不能把这次身份观察当作资料供给或语义理解通过。真实 Gemini 调用及私人内容发送仍需各自明确范围。

## 2026-11-02 固定90f来源绑定与真实 WebUI 拒绝边界

现有普通 R1 产物仅新增 `sourceRead` 配置，指向正式沧海共享对象库的固定 worktree `stella-sources/main@90f61d9c9ef019c5a06a419dbcb630fe598cb996` 及原 migration-v1 manifest。官方 reload 成功，Gateway generation 11，无需重启；配置对照确认 selfie 及其余用户设置未变。原97来源／362描述符、设备和用途 grant 未扩大，金融资料未加入，publisher 仍关闭。精确 hash、回滚点与原始回执 hash 见 [本次绑定记录](../.task-control/reports/CORE-VAL-001/fixed90f-main-binding-20261102.json)。

真实 Chrome WebUI 各执行一次状态工具和来源 `list`：状态返回 `public_request_adapter_requires_admission`；来源调用明确返回 `forbidden / source_request_admission_unavailable`。直接 `tools.invoke` 没有原生 Agent 请求的 run/入场 recorder，认证设备匹配不能替代这些事实。自建 Debug 页已关闭，未触碰用户聊天页。

本次没有来源正文成功读回，也没有模型调用。原362描述符全部为分段范围，现行读取契约在首次原文读取前需要 Gemini 的结构化来源适用性判断；不能为完成无模型演示伪造 verdict 或绕过原生准入。下一步是另行明确模型和资料发送范围后的一个真实用户请求，观察原生请求关联、获准来源原文与位置版本。已配置不等于已供给，更不等于已理解。

## 2026-11-03 timeline 卸载后的无模型恢复

本次以用户卸载后的现有配置为新回滚基线，未恢复昨天的整份配置。真实 Gateway health 的 active registry 已无 timeline；同时发现 Core 也被禁用、移出插件 allowlist，来源与合成草稿配置均已移除，移除原因未确定。原 `plugins enable` 返回通用 exit 1；固定10.9实现确认 CLI 保留 allowlist，缺少 Core 会在写入前被阻断。没有保留下来的底层 Gateway 错误，不把静态分支推断写成原始错误回执。

2752文件与已审普通产物清单一致后，官方链接恢复到 generation 7；随后通过官方 `plugins.setEnabled` 管理入口仅补回 `stella-core` allowlist 项并启用，generation 8、无需重启，PID仍为31634。配置差异仅 Core 加载路径、allowlist 项及 enabled；timeline、selfie及其他现有设置保留，未接受新能力、改身份/资料 grant或调用模型。真实 `stella_status` 成功：普通插件、native memory/context/loop、publisher=false，sourceRead=not_configured、persistence=none。health正常、activeWork及queuedSystemEvents均0；启用前activeOnly会话为空。公开接口未给出独立retained归属，不能称昨日3个retained已经证明归零。

timeline的上下文注入可以触发原生prompt-projection持久化，其他注入也可以；目前没有证据将昨日模型等待归因于它，更未证明该等待已修复。原固定90f及5项来源/grant元数据hash仍匹配，但本次没有恢复sourceRead或读取正文。工程回执、配置差异、未验范围见[本次恢复记录](../.task-control/reports/CORE-VAL-001/post-timeline-20261103/REPORT.json)；当前安排只读唯一台账。

## 2026-11-03 一次真实模型对照与普通产物恢复

用户批准恢复原97来源／362描述符的固定90f绑定后，实际 WebUI 只提交一次 Google Gemini3.8Flash/low 请求，首次终态观察在约36秒内，未重发。模型通过原生 code-mode `exec` 试图调用指定 `stella_source_read`，被测试夹具的直接工具名限制拦截，最终明确回答读取失败。本次没有原文分析、来源供给或语义理解通过；历史挂起未复现也不证明 timeline 是根因。

普通已审产物已热恢复到 generation13，PID31634未变；真实Gateway健康、活动工作计数0，真实WebUI状态工具通过，临时夹具卸除，原范围绑定保留，publisher关闭、timeline缺席。配置与本次已绑定回滚基线逐字节一致，selfie及其他用户设置未变。磁盘夹具回执停在注册时，不能用旧零计数作终态证据。Host报告两轮assistant、60225 tokens、USD0.0918315，未核账单或物理重试；本次额度已用完。详见[真实对照与恢复证据](../.task-control/reports/CORE-VAL-001/post-timeline-once-20261103/REPORT.md)，当前安排只读唯一台账。
