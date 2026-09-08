# OpenClaw Integration Contract

目标验证版本：OpenClaw 2026.8.2。2026.8.1 是尚未独立验证的最低兼容声明。能力必须同时绑定 Host 版本、runner／harness、插件权限和实例配置；版本号本身不是完整能力证明。

## 1. 复用职责

OpenClaw 提供 Agent Loop、模型执行、会话／transcript、搜索索引、工具权限、channels、调度、通用整理与备份。Stella 提供任务理解、取证规划、来源判断、Twin／Framework／Praxis 和学习协调。个人数据与认知配置归 CangHai。

新接口必须先检查 Host 和已有插件；不另建会话数据库、搜索引擎或调度服务。补充 adapter 仅完成来源格式、契约检查和一致性协调。

## 2. 目标版本已核查的能力

以下依据安装包内文档核查于 2026-09-05；实现必须用同一版本的 SDK 与 Exact Host 验证。在线文档只作阅读入口。

| 能力 | 已知语义及限制 | Stella 要求 |
| --- | --- | --- |
| transcript 持久化 | per-agent SQLite 保存事件树；旧 JSONL 是历史／归档形式 | 从可验证快照／受支持接口导出原事件及附件，不建立第二套执行会话 |
| sessions_search | 文本搜索，结果含角色／时间；只检索 active branch，排除工具结果和图片；可能 indexing=true | 用于候选发现；补读原文及缺失范围，不当完整档案 |
| memory_search / memory_get | durable 文件语义／混合检索及原文读取；部分 provider 配置允许退为 FTS | 指定并验证必要语义能力，故障不得伪装为完整检索 |
| backup | 可产生验证过的 SQLite 快照／归档；某些备份可能含凭据 | 用作导出输入，按授权范围提取消息；不能直接证明媒体已进个人仓库 |
| cron / heartbeat | Host 调度、唤醒和投递 | Core 判断价值和触发范围；不创建独立计时器 |
| session extension | 可保存小型 session 关联状态 | 仅作为工作 ID／generation 的投影；OngoingWork 本体在 CangHai |

来源：[session storage](https://docs.openclaw.ai/reference/session-management-compaction)、[session search](https://docs.openclaw.ai/concepts/session-search)、[memory search](https://docs.openclaw.ai/concepts/memory-search)、[backup](https://docs.openclaw.ai/cli/backup)。

这些能力支持接入策略，不证明四段 Memory Lifecycle 已实现。特别是导出完整性、附件物化、来源更改传播及目标 runner 的投递失败语义需要各自 receipt。

## 3. Hook 与执行接口

| 工作 | 公共接口 | 必须检查 |
| --- | --- | --- |
| 模型选择 | before_model_resolve | 可用模型及能力策略 |
| 上下文准备 | before_prompt_build | 目标 agent、源代际、结构化路由 |
| 按工具权限读取资料 | before_prompt_build + requiresToolAuthority | 当轮有效 toolAuthority；异步后复核有效性，不持久化能力句柄 |
| 阻断不合格运行 | before_agent_run | 目标 runner 实际发出该 gate；失败返回 block |
| 工具执行限制 | before_tool_call | 委托范围、来源用途、后果覆盖 |
| 结果观察 | after_tool_call | 真实工具结果及原始来源 |
| 响应修正 | before_agent_finalize | 仅一次、按 responseKind；不作为持久化硬门禁 |
| 最终投递协调 | reply_dispatch + Host dispatcher | 生成、持久化与投递分开确认，见下节 |
| 非关键观测 | agent_end / session lifecycle | 幂等清理与诊断，不承担唯一的关键写入 |
| 模型运行 | api.runtime.agent.runEmbeddedAgent | 复用 Host 的模型、harness 与工具流程，保持原会话记录关联 |

依据：[hooks](https://docs.openclaw.ai/plugins/hooks)、[runtime SDK](https://docs.openclaw.ai/plugins/sdk-runtime)。目标版本的 before_prompt_build／before_agent_finalize 失败默认 log-and-skip，agent_end 默认 log-and-continue；hook timeout 不自动取消其异步副作用。after/end 事件也不是持久队列。

## 4. 必需的完成协调

对需要关键持久化的认知回复，使用有限的 reply_dispatch 协调；内部模型与工具仍由 Host Agent Loop 执行。此决定替代早期“一律不使用 reply_dispatch”的接口选择，因为该选择不能单靠普通回调满足关键写入成功契约。

adapter 提供：

```ts
type CompletionPort = {
  generateDraft(input: {
    operationId: string;
    responseKind: string;
    abortSignal: AbortSignal;
  }): Promise<{ draftId: string; text: string; evidenceRef: string }>;
  publishFinal(input: {
    operationId: string;
    draftId: string;
    completionReceiptRef: string;
  }): Promise<{ deliveryId: string; status: "confirmed" | "failed" | "unknown" }>;
};
```

这里定义 Stella 所需接口，不把这些方法名冒充 Host SDK。adapter 用 runEmbeddedAgent 产生草稿，用 Host dispatcher 投递；必须转交 Host 的 onAgentRunStart、userTurnTranscriptRecorder 及存在时的 prepareAssistantTranscriptMessage，防止重复记录输入或改变显示归属。

completion receipt 是 `stella.completion-receipt/v1` 的运行结果，包含 operationId、draftId、draftHash、responseKind、evidenceRef、writeOperationIds、observedRevision、generationId、persistenceStatus 和 checkedAt。它根据持久操作意图、Git、pointer 及远端确认重建，不要求把自身 commit SHA 写进同一个提交。投递结果另由 Host receipt 关联 operationId；草稿存在不证明主人已经收到。

执行顺序：

1. 认知写入 profile 的目标 agent 必须通过配置声明 completion adapter。默认模型路径不得自行发送尚未完成的业务回复。
2. coordinator 为该操作创建受信任运行许可，before_agent_run 只放行对应内部 Host run；超时／接管失败后的默认执行没有许可，必须 block。许可来自插件运行状态，不从用户文本读取。
3. 内部生成禁止直接向用户流式投递未确认业务文本；独立进度可以发送明确的处理中状态。记录草稿、预测与来源，执行最终语义／授权检查。
4. 提交 required 学习和工作状态，critical 等待远端确认；normal 明示 remote_pending 及 RPO。生成 completion receipt，再将已确认结果交 dispatcher。
5. 失败时返回明确失败消息及持久阶段，不投递“已经保存／完成”的业务回复。投递 unknown 先核查 Host receipt；若 Host 不支持查询／去重，则保留 unknown 并停止自动重发，不能声称 exactly-once。
6. 取消／超时后失效运行许可和工具权限，检查尚在进行的操作并按 operationId 协调；晚到回调不得重复学习或发送旧回复。

普通不写入认知的请求可使用 Host 常规路径，但其 admission 校验与写入 profile 的许可必须严格区分。支持何种请求由结构化路由决定，不通过词面识别旁路。

启用前必须用 Exact Host 故障注入验证：接管失败不能回到无门禁的默认发送；critical push 失败不能报告完成；中止后无晚到投递；实际发送结果可辨认。无法满足就返回 capability_unavailable，禁止将不支持的 runner 标为完整写入 profile。此契约没有要求 fork OpenClaw 或复制 Agent Loop。

准备阶段的路由、候选选择与证据判断共用 Core 的 300 秒预算，并继承整轮取消信号；Host `before_prompt_build` 使用 330 秒上限，为 Core 返回 `preparation_timeout` 留出时间。整轮完成预算仍为 600 秒。启用配置和隔离验收适配器必须同步使用该上限，不能保留旧的 60／90 秒钩子配置。取消或超时后停止新的模型调用，迟到结果不得恢复 admission、触发持久化或发送回答。

## 5. 记忆与 archive adapter

完整接口及错误含义见[Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md)。每个 archive adapter 须提供 scope 清单、连续 cursor／快照、原始 payload、角色与分支信息、附件及清理前归档保证。读快照只使用被版本验证的格式；不直接依赖未经验证的 Host 内部表结构。

检索 adapter 返回原始 Ref、覆盖及 indexing／truncation 信息。Host 的候选排序可作为搜索基础，Core 使用 LLM 作最终语义选择。失效摘要、Dreaming 和 Active Memory 注入必须经过当前 generation 检查；不能校验时该路径不能作为当前个人理解来源。

## 6. 能力与 activation 状态

runtimeState.activationStatus 仍须为 active；migration_required 和 degraded 均阻断实例激活。单项非必需能力不可用单独记录 unavailable，不把实例改为 degraded 后继续启动。

required capability 缺失阻断其 profile。未要求的能力缺失不损害当前已声明 profile，但实际请求需要该能力时必须显式失败。密钥使用外部 SecretRef，不能写入仓库；“可选密钥缺失”也不能免除某个请求的必要能力。

profile、能力清单、来源用途和投递策略按 [Portable Registries](contracts/PORTABLE-REGISTRIES.md)定义。先证明完整能力契约，再允许使用对应 profile。

## 7. 后台与权限

后台研究、整理和学习复用 Host cron／heartbeat。社交状态判断不主动触发；主人未回复的无截止话题暂搁，有新证据／自然上下文才再提。有时效委托按原授权执行。

主动投递的时段、频率和渠道未配置时不启用；这不取消已确认的能力。Memory Wiki 可作已有工具中的检查视图，不另建专用理解展示功能。实际资料通过 CangHai 查看。

## 8. Stella 实例初始化与运行投影详细设计

设计日期：2026-09-07。状态：待实现的工程设计，不是运行验收或生产迁移授权。用户要求调查 Stella 1.0 并设计初始化；本轮不修改沧海、Host 配置、运行文件或定时任务。1.0 的固定版本证据和逐功能迁移清单见[冷启动映射 §13](07-CANGHAI-COLD-START.md#13-stella-10-运行实现调查与功能承接2026-09-07)。本节补齐“已恢复个人资产如何成为实际 Agent”的环节，不替代 Memory Lifecycle 或 Alpha 出口。

### 8.1 目标、范围与设计选择

初始化把指定 CangHai recovery revision、Core 版本和实例 profile，在指定 Host 上物化成可验证的 Stella Agent。输入必须显式给出 instanceId、agentId、Host 连接、来源 revision、目标 workspace 和 contract profile；可创建新 Agent，也可采用用户指定的现有 Agent，不能默认抢占 main 或另换 Agent 完成验收。

采用“权威配置 → 受管 Host Projection → 实际消费验证”。沧海中的私人身份、偏好、skills 和认知对象是来源；Core 提供公开运行规则、模板和校验器；Host 保存生成投影、执行状态及本机部署记录。第一次规划允许 LLM 结构化理解旧行为及冲突，结果形成有证据的迁移映射；应用和恢复使用已固定的映射与内容，不能每次开机让模型自由改写人格。

选择受管文件而非只追加提示，是为了让 Host 原生加载、身份展示和 skill 发现与 Core 一致；保留动态上下文是为了按当轮权限和 generation 选择个人证据。两者有明确内容归属，不重复注入 SOUL／USER／MEMORY 全文。整体复制旧 workspace 或直接把沧海根目录设为执行 workspace，均不能满足版本、权限和职责边界。

### 8.2 OpenClaw 2026.8.2 的文件与加载机制

本次读取本地 `node_modules/openclaw/package.json`（2026.8.2）、随包文档及 dist 实现，并核对官方在线文档。在线文档可能前进，适配以固定安装包、runner 和行为收据为准；不将旧 1.0 配置格式视为当前格式。

| 对象 | 当前 Host 作用／限制 | Stella 初始化处理 |
| --- | --- | --- |
| Agent 配置 | 绑定 workspace、模型、skills、工具策略及身份展示；配置与 Markdown 身份不是同一状态 | 使用受支持配置／Agent 接口，限定目标 Agent；分别验证身份文件与 `agents set-identity` 后的展示结果 |
| `AGENTS.md` | 常驻操作规则；执行目录不同时还可能叠加项目 AGENTS；子代理只保留此类 bootstrap | Core 规则模板 + 已映射主人行为 + 非敏感 Tools 约定；不放个人事实和私有路径，以免随子代理／项目上下文扩散 |
| `SOUL.md` | 身份、语气与边界；在不同 harness 中进入相应提示层 | 从明确的身份源生成，保持原意；旧通用行为冲突先映射，不能全文覆盖后仅靠新增提示纠偏 |
| `IDENTITY.md` | 名称、形象等身份信息 | 生成最小展示身份，并协调 Host 的展示配置；不复制其他 Agent 身份 |
| `USER.md` | 可选的用户理解，单独 4,000 字符上限；不是完整 Twin | 只生成允许常驻暴露的最小沟通配置／理解入口；敏感、情境性个人事实由当轮证据包提供 |
| `MEMORY.md` | 可选的长期摘要；群聊／channel／cron／子代理有过滤；Codex 在工具可用时主要通过记忆工具按需读 | 只含有来源的当前有效入口；可生成不含私人事实的检索说明。正文和索引均纳入 generation，不能成为独立证据 |
| `memory/*.md` | 普通轮次不默认全部注入；`/new`、`/reset` 可带近期日志；session-memory／Dreaming 可产生派生内容 | 作为有来源的归档或受管视图接入；不简单继承“每天写一份就算持久理解”的规则；检查启动上下文旁路 |
| `TOOLS.md` | 当前默认 bootstrap 列表不读取；工具约定迁至 `AGENTS.md` 的 `## Tools` | 旧内容经审查迁入 Tools 段；敏感设备信息按需读取，凭据保留 SecretRef；文字不授予工具权限 |
| `HEARTBEAT.md` | 当前 runtime 不读取；Doctor 可把旧任务迁至 automation／monitor scratch | 解析旧声明并映射到宿主调度，不生成同名文件冒充已恢复定时能力 |
| `BOOT.md` | 仅启用 `boot-md` hook 时在 Gateway 启动运行 | 非必需；不把初始化事务交给模型启动脚本，不用 BOOT 发送未经授权的外部消息 |
| `BOOTSTRAP.md` | 一次性身份建立；部分 runner 通过首轮 user prompt 执行；setup 状态另由 Host 管理 | Stella 已有身份，完成显式预置流程后不得再触发“重新认识你”；不靠创建空 memory 目录或修改私有 DB 伪造 setup 完成 |
| `skills/` | workspace skill 同名优先于项目、个人、managed、bundled 和 plugin／extraDirs；正文按需读取 | 安装完整依赖树，固定来源和哈希；检查有效解析路径，旧同名 skill 不能覆盖新版 |
| `openclaw.json` | Host 全局和多 Agent 配置，可能含凭据 | 白名单 patch／CAS；不复制 1.0 全文件，不修改其他 Agent、渠道或全局默认以迁就 Stella |

需要特别处理的加载事实：

- 默认 bootstrap 单文件 20,000、总量 60,000 字符，USER 单独 4,000；缺文件和超限 Host 可能仅标记后继续。Stella 必需运行指令缺失／截断必须阻断初始化成功，不能照搬该宽松行为。个人原件超过上限应转为原文检索，而非截断后视为完整恢复。
- `bootstrap-cache` 每轮调用 `loadWorkspaceBootstrapFiles`，仅内容与身份未变时复用数组；不是永久缓存旧文件。但 `contextInjection`、native Codex 的 thread／turn 注入面、skills 快照、历史摘要和当前已生成草稿仍须分别验证。
- skill 目录位置、agent allowlist 和工具授权是不同边界。agent skills 列表替代 defaults 而非合并；`skills.entries` 是共享配置，不能为单个实例关闭其他 Agent 的技能。
- 群聊对 MEMORY 的过滤不等于 USER／SOUL 不含私人内容。常驻文件保持最小公开范围，当轮私有内容按 audience、来源用途和工具权限进入；未知 audience 不注入私有上下文。
- `skipBootstrap` 有全局影响的配置入口；`contextInjection: never` 不等于“不创建文件”，也不能用于掩盖缺少受管内容。先验证目标 Agent 的预置／setup 支持；若只能改全局默认或直接写 Host DB 才能完成，返回 capability_unavailable，不能影响其他实例。

证据入口（本地 dist 哈希文件名只作本轮调查定位，不作为实现 import 接口）：`workspace-CAteGiRq.js` 的 `loadWorkspaceBootstrapFiles`／`filterBootstrapFilesForSession`；`bootstrap-files-BbOduq1F.js` 的 hook 后过滤与 setup 检查；`bootstrap-cache-*.js` 的逐轮重读；`doctor-tools-md-migration-*.js`。官方阅读入口：[workspace](https://docs.openclaw.ai/concepts/agent-workspace)、[system prompt](https://docs.openclaw.ai/concepts/system-prompt)、[skills](https://docs.openclaw.ai/tools/skills)、[bootstrapping](https://docs.openclaw.ai/start/bootstrapping)、[heartbeat](https://docs.openclaw.ai/gateway/heartbeat)、[agents CLI](https://docs.openclaw.ai/cli/agents)。

### 8.3 配置、内容与投影的唯一归属

初始化物化分三类输入：

1. **公开 Core 模板**：认知运行协议、响应与持久化门禁、通用 skill 入口。保存在 Core 包，固定模板／包版本，不含主人正文。
2. **可移植私人源**：Manifest 指向的身份、行为资产、skills registry、来源策略、当前理解、任务声明。保存在沧海所选 revision；派生理解还绑定 memory generation。旧原件可保留，冲突段落通过显式映射生成新的已审查行为资产。
3. **本机绑定**：Host 地址、实际 workspace、模型凭据、频道账号及权限。保存在 Host 部署配置／SecretRef，不能把历史服务器绝对路径和密钥写进通用模板或公开 receipt。

每项 Host Projection 清单记录 `targetKind`、`targetKey`、`owner`、`recipeVersion`、`inputRefs`、`contentHash`、`memoryGenerationId`（仅认知派生项）、`requiredForProfile`、`exposurePolicyRef`、`lastAppliedHash`。`targetKey` 在可移植配置中为逻辑目标，本机记录才解析为绝对路径／Host ID。没有个人理解依赖的稳定指令不随每次学习重建；个人摘要及其下游视图必须随依赖更新。

`SOUL` 与 `USER` 中原有的身份规则、个人事实、历史假设先分清，不能把个人语料插入高优先级指令。动态 hook 只放当轮运行约束和经校验的上下文，不再次注入已经由 Host 消费的同一身份文件。不得靠“最新提示优先”解决互相冲突的两份规则。

Host 用户直接编辑受管文件时，检测为 drift，保留字节并给出差异。支持显式 `import-edit` 意图：按 base／runtime／canonical 三方比较，将可接受的源变更保存为新权威版本后再生成投影。普通认知纠正沿 learn 授权处理；改主人原文、人格／框架或权限时遵守相应授权，模型不能自动采纳生成文件里的修改。不得继续使用旧整体 runtime 回写脚本。

### 8.4 数据格式与接口草案

以下格式是实施目标，当前解析器不支持。保持 Manifest v1 引用入口不变，建议新增 `stella.runtime-profile/v2`，继承 v1 已定义语义并增加 `host_materialization_ref`；该引用指向 `stella.host-materialization/v1`。v1 → v2 显式迁移，禁止给闭合 v1 静默加字段。每个来源／规则都固定版本，未知字段和迁移歧义失败。

`host-materialization/v1` 必填：`id`、`host_adapter`（ID、版本、Host 版本及 harness）、`behavior_mapping_ref`、`projection_recipes`、`skill_bindings`、`automation_declarations`、`required_checks`。skill binding 关联已有 skill registry 的 ID、源树 digest、实际 skill name、依赖及启用目的；automation declaration 含稳定 ID、触发、时区、任务引用、委托／投递策略引用和期望启用状态。绝对机器路径及 Host job ID 不进入该文件。

行为映射使用 `stella.behavior-mapping/v1`：每项包含旧 source Ref／片段、职责、`retained | adapted | retired | unavailable | conflict`、新规则引用、理由、被替代需求引用和依赖。LLM 只产结构化候选；产品已明确替代的旧通用规则可以按现行需求映射，无法确定的原意不擅自改写。未解决项阻断它所属的必要能力，不扩大为任意清理旧资料的权限。

规划和运行对象分离：

```ts
type InitializationIntent = "create" | "adopt" | "reconcile" | "restore" | "import-edit";
type InitializationPhase =
  | "planned" | "blocked" | "staged" | "quiesced" | "applying"
  | "verifying" | "ready" | "failed" | "rollback_required" | "rolled_back";
type InitializationPlan = {
  schemaVersion: "stella.initialization-plan/v1";
  operationId: string;
  planHash: string;
  intent: InitializationIntent;
  instanceId: string;
  agentId: string;
  sourceRevision: string;
  coreArtifactHash: string;
  hostFingerprint: string;
  profileRef: { path: string; sha256: string };
  observedDeploymentHash: string | null;
  actions: Array<{
    id: string;
    kind: "file" | "skill" | "agent_config" | "view" | "automation" | "setup";
    targetKey: string;
    beforeHash: string | null;
    afterHash: string | null;
    stagedArtifactRef: string | null;
    required: boolean;
  }>;
  blockers: Array<{ category: string; targetKey: string }>;
};
```

这是逻辑形状，JSON Schema 必须补上 SHA、ID、路径、枚举、唯一性、nullable 约束及跨对象校验；不能只生成上述 TypeScript 类型就启用。`planHash` 为剔除自身字段后的 canonical 内容摘要；包含输入、目标和每个变更前／后摘要。应用请求必须引用确切 operationId 和 planHash，不重新渲染另一份内容。

本机持久 journal 记录 phase、完成步骤、配置原值、受管文件备份、Host 对象 ID、取消状态和恢复动作；敏感内容仅本机保护存储。最终部署 receipt 记录所选源码／来源、实际文件与有效 skill 哈希、Host 配置子树摘要、memory generation、setup／索引／会话检查和逐能力状态。脱敏公开摘要不含个人正文、私有路径、账号或凭据。receipt 不能把自身提交 SHA 写入同一提交以制造循环。

### 8.5 操作流程、原子边界与恢复

逻辑 CLI 为 `stella initialize plan|apply|status|resume|rollback`，仅设计名称，当前不可执行。`reconcile`／`restore` 作为 plan 的 intent，复用同一协调器；原 `stella:activate` 应逐步改为调用该协调器的适用子集，不保留第二套成功判据。

1. **发现与只读规划**：解析显式来源 SHA、Manifest、profile、技能和旧映射；通过 Host 受支持接口发现真实 agent/workspace/bindings、有效配置、skills、hooks、自动任务和必需能力。输出逐目标差异、行为迁移、缺失依赖及影响范围；不 pull、不执行旧部署脚本、不发模型探测请求到外部服务。
2. **准备可审查结果**：在私有 staging 生成精确文件、技能树和配置 patch，做结构、语义、原意、容量及权限校验。需要模型处理私人规则时遵守具体处理授权，规划不能隐含新增第三方外发。保存计划及 digest；已有授权覆盖的操作可直接应用，范围外变更只针对具体差异请求确认。
3. **持久化来源前置条件**：如果需要新增 v2 profile／行为映射，先完成明确迁移操作并获得新 recovery revision，再生成最终 plan。应用时 source、Core artifact、Host fingerprint 和 before hashes 必须仍匹配；不能应用过程中改输入 SHA。关键源配置须满足既有远端持久化要求后才报告可恢复。
4. **关闭目标入口并排空**：持久 admission fence 覆盖目标 Agent 的消息、CLI／Gateway run、cron、heartbeat、事件唤醒及 completion 投递；排空运行中事务，撤销未投递草稿许可。创建 Agent 时确保未绑定业务入口、无默认调度先行触发。普通 non-target Agent 继续运行。无法按目标阻断时保留旧配置，报告需要可审查的维护窗口，不能直接扩大为全局停机。
5. **持久 journal 与应用**：先记录 before 值和回滚信息，再原子替换每个受管文件；技能按树摘要部署，移除上一清单中已退役且未被用户修改的受管项；配置按目标子树 CAS；任务先以 disabled 状态 upsert；创建索引／投影并校验 generation；完成 Host setup／身份展示协调。文件系统、配置和 scheduler 没有单一事务，靠 fence + journal 保证半成品不能被消费，而非声称整个 Host 原子写入。
6. **验证实际消费**：回读部署字节、有效配置、skill 解析路径／正文、任务状态、来源和投影代际；验证目标 harness 确实消费受管上下文且必要规则未截断。使用隔离合成探针做 Host 契约验收；实例私人语义探针仅在对应授权范围内执行。探针不得真的触发对外动作，投递协调用测试目标验证。
7. **发布与开放**：必要检查完成后写部署 receipt 并发布本机 active deployment 指针；再开放同一 deployment 的 admission。任务启用只依据有效委托和已验证投递策略；若启用为必要步骤且失败，实例保持 fenced。`ready` 仅说明声明 profile 就绪，不等于全部产品能力、真实效果或 Alpha 候选通过。
8. **失败与重启**：任一步骤中断都保留 journal 和 fence；resume 核对当前值后完成剩余动作，不能重复安装／建任务。rollback 只恢复本操作仍持有的文件与配置子树，CAS 不符转 rollback_required；不覆盖用户后续修改，不回退已发生的认知学习或远端提交。新来源已有效而旧投影不符合当前授权／删除状态时，不允许通过回滚重新启用旧理解；应保持阻断后前向修复。

Agent 尚未加载 Core 或插件无法启动时，Core 自身 hook 无法构成可靠 fence。适配器必须证明 Host 层的受支持入口阻断／隔离机制，覆盖服务重启和显式 run；仅在 AGENTS 写“不要运行”不算。如果 2026.8.2 某 runner 无法提供此边界，它不能支持在线 adopt／reconcile；离线维护流程必须作为单独可验证模式，不能伪装在线成功。

### 8.6 首次初始化、更新与现有会话

| 场景 | 处理 |
| --- | --- |
| 空 Host／新 Agent | 先验证安装及模型访问前置条件，再创建显式目标、物化身份和技能、完成 setup、验证后绑定已授权入口；不重走人格采访 |
| 用户指定已有 main | 盘点已有文件、hooks、skills 和任务；保存私有备份与逐项迁移结果；不新建另一个 Agent 冒充 main 已接管 |
| Core 升级 | 固定新包及模板版本，重渲染受影响运行规则；不重写主人原文，不重新编译精确 active IR；required skills 发生变化须重新验收 |
| 沧海修改／删除／纠正 | 来源事务确定完整受影响集，先持久阻断旧理解，重建有关 USER／MEMORY／搜索／Active Memory 视图；依 §5 和 D-056 分批重评 |
| Host 文件被编辑 | 记录 drift 与三方差异；不自动反向复制整个 workspace；无冲突的明确 import-edit 生成新来源，否则等待具体冲突解决 |
| 换机器恢复 | 从所选 revision 重建 profile、源／投影／skills 和任务声明；重新绑定机器路径及 SecretRef，验证新 Host，不能沿用旧 Host receipt |
| 卸载／停止接管 | 只处理受管且哈希匹配的资产和任务，保留私人源及档案；解绑、恢复旧身份或恢复旧任务需明确退役计划，不自动复活 1.0 自动化 |

每个被允许的 run 绑定 active deployment ID、关键内容 digest 和所需 memory generation。准备后、工具执行前和投递前重验适用依赖；变更后旧草稿不得直接发送。bootstrap 下一轮重读不代表旧 transcript／compaction／Active Memory 摘要已撤回；这些入口必须同时接入资格检查。

能证明安全刷新的已有会话可以继续；不能证明时，在归档并持久保存 OngoingWork 后，通过受支持会话边界开启新的执行上下文，同时保持用户可理解的事项连续性。不得删除旧对话、直接修改 Host SQLite 或只追加一句“忽略之前”就声称旧理解已清除。新旧会话、`/new`／`/reset`、压缩后、cron、子代理和不同执行目录均纳入验证。

### 8.7 Skills、通用记忆与自动任务的治理

**Skills**：按已有 `core_behavior | owner_behavior | integration` 分类。通用证据／事务／权限不变量进 Core 代码，复杂任务方法和主人行为可继续用 skills；不把所有 1.0 skills 删除或机械搬进代码。安装保留完整资源树、脚本权限及确切依赖；名称、class 与 registry 对齐。有效 skill allowlist 包括显式保留的既有通用工具技能，不因初始化无声缩减。所需技能被旧同名项遮蔽、正文未安装、模型不能读取、依赖缺失或 snapshot 未刷新，均不能 ready。

**通用记忆**：逐项盘点 memory-core、session-memory、Dreaming、active-memory、memory-wiki，以及 harness 自带记忆和额外 bootstrap hooks。具备同名插件不等于满足 Memory Lifecycle。能接入来源／generation／原文回读的复用；无法验证的个人理解注入路径须在目标范围隔离，所需能力若因此缺失则阻断对应 profile，不能称为完整记忆。禁止为 Stella 全局关闭共享插件。所有已声明必要视图成功才开放，不能降低 required 标志来制造成功。

**调度**：旧 HEARTBEAT task、周报及其他已确认自主能力转为可移植声明，再通过 Host automation API／CLI 创建运行对象；运行 job ID 和上次触发状态留在 Host。以 instanceId + declarationId 建立稳定关联，已有关联按 ID upsert，重名不自动认领；无部署账本的旧任务按完整 schedule／payload／agent／delivery 比较后迁移。重复任务未消解时不得启用。禁止直接写 cron SQLite 或 JSON，也不运行全局 Doctor 作为本实例初始化的隐含步骤。

已有有效委托可恢复；备份中出现任务不单独证明现在仍获授权。缺少渠道、频率或用途信息时保留声明为 unavailable／disabled，并报告对应能力。社交状态判断不主动触发；问候、研究、周报等分别按现行自主边界和委托判断，不能将“不主动跟进关系”扩为禁用全部主动能力。安装任务不立即执行一次；补跑与历史未投递消息不默认重放。

### 8.8 错误与状态

初始化错误至少区分：`source_revision_mismatch`、`unsupported_host`、`unsupported_profile_version`、`behavior_conflict`、`missing_skill_dependency`、`skill_shadowed`、`unmanaged_file_conflict`、`host_config_conflict`、`projection_drift`、`bootstrap_truncated`、`setup_pending`、`capability_unavailable`、`quiesce_timeout`、`stale_generation`、`required_view_failed`、`automation_conflict`、`verification_failed`、`rollback_conflict`、`operation_cancelled`。

每个失败关联 operationId、phase、targetKey、可重试性和下一步；可重试不等于盲目重复副作用。返回文件已准备、配置已应用、业务仍阻断、部分可选能力 unavailable 等实际状态，不统一返回“初始化完成”。本机部署 phase 与 Manifest activationStatus 分离；不把 Host 暂时不可用写成主人身份或事实变化。

### 8.9 模块落点与实施顺序

复用 `src/openclaw/activation.ts`、`scripts/stella-activate.mjs`、`src/openclaw/completion*.ts`、`src/canghai/manifest.ts`、`catalog-reader.ts`、`memory-transaction.ts` 与 durability 能力。新增初始化协调器、投影生成器、行为映射校验、Host 配置／skills／automation adapters；模块名称在实施时遵循现有命名。CangHai 事务继续只管仓库一致性，不能把本机 Host 配置文件塞进 Git 事务冒充跨系统原子性。

按三条完整流程交付：

1. **从来源到可用 Agent**：版本化格式与只读 plan → 新 Agent 物化 → setup／身份／skills 验证 → Exact Host 首轮。以合成身份完成，先证明 Host 层阻断和 setup 接口可用，再扩展 adopt。
2. **已有实例的迁移与纠正**：1.0 行为映射 → 精确差异 adopt → 来源纠正／删除 → Host 视图和会话更新 → 下一轮使用；加入并发、崩溃和回滚故障。
3. **完整能力恢复**：技能外部依赖、通用记忆接入、自动化声明及跨机器恢复；绑定完整 profile，分别记录必要能力与可选能力，不能以第一条成功宣称全量迁移。

仍需通过目标 Host 实验解决的工程门禁：无全局副作用的目标 Agent setup、插件缺失时仍可靠的入口关闭、各 harness 的受管指令实际消费、自动记忆写入／注入的资格控制、技能更新可观察性和受支持的会话刷新。此处给出失败处理和验证要求，不虚构已有 SDK 方法或已验证能力。

### 8.10 验收矩阵

| ID | 场景 | 必须证明 |
| --- | --- | --- |
| I-01 | 同一来源重复 plan／apply | 相同内容计划可复现；已完成操作幂等，无新重复任务、重复学习或无关配置改动 |
| I-02 | 新 Agent 首次运行 | 使用预置 Stella 身份，UI／channel 身份一致，不再进行通用出生采访；规则与必要 skills 实际可见 |
| I-03 | main 已有旧规则、另一 Agent 在线 | 完整差异与备份；仅 main 被治理，另一 Agent 配置、文件、权限、任务无变化 |
| I-04 | plan 后来源、配置或文件被修改 | before hash／source CAS 拒绝陈旧计划，不覆盖新编辑 |
| I-05 | 旧同名 skill、新依赖缺失、正文被修改 | 检查实际解析来源；必需 skill 不合格时不能进入 ready |
| I-06 | 原件超长、必要指令被截断 | 原文保留，检索可达；必要指令不完整时阻断，不能依据磁盘文件存在通过 |
| I-07 | 文件、配置、索引、任务各阶段杀进程 | 重启仍 fenced；resume 幂等，rollback 不覆盖外部新修改，无半成品运行 |
| I-08 | 应用期间旧回复晚到、cron／事件唤醒到达 | 旧许可不能投递；任务不绕过维护门禁，无额外副作用 |
| I-09 | USER／MEMORY 纠正，旧摘要及旧会话存在 | 当前轮、新轮、重启、压缩及 /new 均不重新使用旧理解；历史判断仍可按授权回溯 |
| I-10 | 群聊、子代理、独立 cron、另一执行目录 | 私人资料不通过静态 bootstrap 或父任务摘要越界；必要运行规则仍生效 |
| I-11 | HEARTBEAT 和周报迁移重复执行 | 无重复任务，时区／目的／投递策略一致；没有配置／授权时不触发补跑或对外发送 |
| I-12 | Host 内部记忆无法校验或 plugin 启动失败 | 对应完整 profile 不可运行；不靠更高优先级提示或降级继续伪装成功 |
| I-13 | 旧 runtime 编辑导入与源同时修改 | 三方冲突可定位，非冲突编辑经授权成为新来源，生成内容不被当作用户新证据 |
| I-14 | 新机器、只有沧海副本与显式本机凭据绑定 | 原件及声明的重要状态可恢复，投影可重建，任务不会因丢失旧 job ID 重复触发 |
| I-15 | 初始化完成但真实学习未验收 | receipt 只证明所声明初始化能力；Alpha／完整记忆／主人使用效果分别报告 |

实施验证依次使用 schema／跨对象测试、文件与配置故障注入、`npm run verify` 和同一产物的 Exact Host 场景；固定 Core SHA、包 hash、Host／harness 和来源 revision。当前文档调查没有运行这些验收，现有历史收据不能替代 I 系列证据。

### 8.11 初始化执行器的实施进度（2026-09-07）

工作区新增 `src/openclaw/initialization.ts`、`initialization-registration.ts`、`initialization-source.ts` 与 `initialization-templates.ts`。目前实现公开模板、已审查行为映射、完整 skill 资源树、Host 展示身份与 setup 的初始化闭环，公开状态和对应 receipt 标明 `scope: host_bootstrap`。这里的 `ready` 仅证明这些启动条件，不等于完整 Memory Lifecycle、自动化能力或私人实例已恢复。

- 插件注册本身不写文件；Gateway service 启动后自动运行初始化，执行期间目标 Agent 被门禁阻断。安装前必须已配置有效来源与本机绑定；OpenClaw 对缺少必填配置的插件会保持禁用，不能据此承诺无配置安装也会成功。
- `/stella-initialize`、`/stella-initialize status` 与管理员 Gateway 方法 `stella.initialize`（`apply`／`status`）可随时调用同一协调器。自然语言请求可由模型选择 `stella_initialize` 工具，执行 `apply` 必须有 Host 提供的主人身份；不能用模型自报或工具参数代替授权。
- 管理员可使用 `/stella-initialize rollback <operationId>` 或 Gateway `rollback` 操作恢复原始字节、权限和目标 Agent 的展示身份。外部身份修改会在文件回滚前阻断操作。回滚后保持 fenced；Host setup 内部状态及业务数据不在此回滚范围。
- v2 profile 的 `host_materialization_ref` 必须指向 JSON 格式的 `stella.host-materialization/v1`。`stella.host-files/v1` 仅为内部执行器格式，不再被公开入口接受。来源须为干净、精确提交；声明绑定 exact Host 版本、带内容摘要的行为映射、五份投影配方、技能资源树及必需检查。未知字段、旧 profile、非法路径、漂移与超限 bootstrap 均显式失败。
- `stella.host-templates/v1` 提供五份公开模板；映射区分 retained、adapted、retired、unavailable 和 conflict。必需行为未解决、投影漏用或夹带未审查规则均阻断。投影输入须由 `stella.projection-exposure/v1` 明确允许公开运行指令；不把私人事实复制进公共启动上下文。
- 技能必须与 Manifest 指向的规范 `stella.skill-registry/v1` 对齐，校验来源用途、暴露策略、完整资源树、摘要和可执行权限。不能通过空 bindings 跳过已启用技能。尚无适配器的 required_capabilities、非空 automation_declarations、额外 required_checks，以及 `full_memory` profile 均显式返回不可用，不把裁减后的结果标为成功。
- `stella.display-identity/v1` 生成原生 `IDENTITY.md`，并通过 Host `mutateConfigFile` 对指定 Agent 的 identity 做 CAS 更新；只修改该配置字段，并等待热重载实际生效。通过公开 `ensureAgentWorkspace` 验证 setup 不再 pending；必须已有显式目标 Agent 配置，尚不提供新 Agent 创建。
- 2026-09-08 增加真实 bootstrap 加载校验：初始化验收及后续准入调用公开 `resolveBootstrapContextForRun`，以目标 Agent 当前配置、direct 主会话和 full context 核对五份必要文件的原始内容及预算处理后的内容。仅接受 Host 的尾部空白处理，截断、遗漏或 Hook 改写均阻断；校验期间配置变化也阻断。每 Agent 预算及默认值由 Host 解析，不修改其他 Agent 配置。`contextInjection: never` 和尚未具备会话刷新证明的 `continuation-skip` 返回 `host_context_injection_unsupported`。这是共享加载器的完整性证明，不能替代各 native harness 的实际消费、群聊／子代理过滤和既有 transcript 刷新验收。
- 每次操作保留独立归档，使用持久化 journal、文件锁、before 内容与权限校验。进程被杀后只回收 SDK 已确认死亡的锁持有者；恢复复用原操作。重复初始化在内容未变时复用已验收操作，并重新查询 Host 技能及文件。
- OpenClaw 2026.8.2 的 `api.runtime.gateway.request` 拒绝第三方插件。当前通过显式配置 `initializationGatewayAccess: local_operator_read` 授权本机公开认证连接，仅查询文件与技能，凭据仍由 Host 管理；不制造官方插件身份。不能在启动 service 中等待尚未监听的 Gateway，因此初始化异步开始，未完成时仍阻断请求。
- Host 会重复注册执行 harness；准入必须从持久化 receipt 恢复，并将内部 run 与完成协调操作绑定到同一初始化操作。正常的业务提交和配置热重载使用当前 recovery pointer 核对内容，不能错误取消已持久化且投影未变的回复。
- 文件修改／回滚前先持久化维护门禁，并检查目标仓库是否仍有完成协调事务。存在活动轮次时返回 `active_turn_drain_required`，保留门禁且不改运行文件；等待旧事务结束后重试。迟到草稿在业务持久化前再次验证 run 绑定。该检查目前覆盖同一 Gateway 进程中的 Core 完成协调器，不宣称多 Gateway 共用一个 workspace 已获支持。
- 主生成适配器保留 Host 的 skills 上下文装配和上游工具权限，使用公开 `toolExecutionAllow` 限制私有草稿阶段只能执行 `read` 和 `stella_initialize`；读取仅允许当前 receipt 声明且校验通过的 skill 资源。初始化工具同时在 manifest `contracts.tools` 和注册工厂中声明名称；主人身份由 SDK `resolveCommandAuthorization` 根据 Host 提供的上下文解析，不能从提示词推断。需要脚本、外部工具或写入的完整技能尚不在这一执行范围内。

已用本机 OpenClaw 2026.8.2 的隔离合成环境验证启动、手动重入、真实技能来源、普通首轮、托管写入、重启和重复请求隔离；临时干净快照的 packed 主链验收也通过。后续代码改动仍须重新生成最终产物收据，不能把临时快照 SHA 当作主工作区已提交 SHA。

仍未完成：完整记忆和扩展技能能力适配器、自动化事务、Host 记忆视图与既有会话刷新、插件未加载时的独立 Host 门禁，以及真实 CangHai 迁移和本机 main 生效。身份验收覆盖原生配置和 Gateway 读取，尚非各真实 channel 展示验收。当前本机来源仍为 `runtime-profile/v1alpha`，配置 recovery revision 也落后于仓库 HEAD；不得复制旧冲突指令、生成空记忆目录或改成受限 Alpha profile 来冒充完整迁移。I 系列验收尚未全部完成。
