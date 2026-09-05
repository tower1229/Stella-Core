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

执行顺序：

1. 认知写入 profile 的目标 agent 必须通过配置声明 completion adapter。默认模型路径不得自行发送尚未完成的业务回复。
2. coordinator 为该操作创建受信任运行许可，before_agent_run 只放行对应内部 Host run；超时／接管失败后的默认执行没有许可，必须 block。许可来自插件运行状态，不从用户文本读取。
3. 内部生成禁止直接向用户流式投递未确认业务文本；独立进度可以发送明确的处理中状态。记录草稿、预测与来源，执行最终语义／授权检查。
4. 提交 required 学习和工作状态，critical 等待远端确认；normal 明示 remote_pending 及 RPO。生成 completion receipt，再将已确认结果交 dispatcher。
5. 失败时返回明确失败消息及持久阶段，不投递“已经保存／完成”的业务回复。投递 unknown 先核查 Host receipt；若 Host 不支持查询／去重，则保留 unknown 并停止自动重发，不能声称 exactly-once。
6. 取消／超时后失效运行许可和工具权限，检查尚在进行的操作并按 operationId 协调；晚到回调不得重复学习或发送旧回复。

普通不写入认知的请求可使用 Host 常规路径，但其 admission 校验与写入 profile 的许可必须严格区分。支持何种请求由结构化路由决定，不通过词面识别旁路。

启用前必须用 Exact Host 故障注入验证：接管失败不能回到无门禁的默认发送；critical push 失败不能报告完成；中止后无晚到投递；实际发送结果可辨认。无法满足就返回 capability_unavailable，禁止将不支持的 runner 标为完整写入 profile。此契约没有要求 fork OpenClaw 或复制 Agent Loop。

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
