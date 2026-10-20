# Issue #23：Dreaming 正式接口可行性核查

## 结论与边界

在固定 OpenClaw `2026.8.2` 的正式 SDK、42 个 typed hooks 及实际原生发布调用链中，未找到能把**原生 Dreaming 的完整输入资格和全部发布写入**交给 Core 强制校验的完整接缝。现有接口足以观察、做模型消费门禁、读取部分元数据，或接管整次任务；这些不能单独接通原生 Dreaming 的合法生成—校验—发布—消费闭环。缺口是输入清单和发布协议，真实模型额度不能补上它。

本轮只读检查正式导出及对应实现，不调用未导出的 native runner、不直接操作 Host 私有数据库、不冒充 memory-core、不修改 Host。另以一次性合成 Host 实际观察公开 hook 和元数据 API。生产配置不变，外部模型调用为零。

## 已查正式接口与具体限制

| 接口 | 可复用的正式能力 | 本版本缺少的部分 |
| --- | --- | --- |
| `runtime.subagent.run / waitForRun / getSessionMessages` | 启动调用插件自己的子运行；返回 run/session/runtime，取得文本结果 | 参数是 message/model/tools 等，没有 Dreaming 原件范围、Core Ref/版本、generation 或发布回调。Core 不能接管 memory-core 的 runtime 身份或以 session 名称给原生任务签发权限 |
| `before_agent_reply` | 高优先级 handler 返回 handled 可接管整个任务；本次真实 cron 上下文有 `jobId` | event 只有 cleanedBody；尚未产生原生候选及来源闭包。jobId 可用于核对已授权任务，但不能授予资料访问权。接管后自己实现整理属于替代生产者，不能算原生 Dreaming 已运行 |
| `before_agent_run`、context engine、provider `wrapStreamFn` | 可以阻止模型调用；Core 现有实现已经绑定确切输入和最终消费 | 原生传来 prompt/history/system 等文本，没有独立的来源清单或可验证的派生收据。不能从未知 prompt 的差异反推许可；模型拒绝也不能阻止另一路直接文件写入 |
| `llm_input / llm_output / model_call_* / agent_end` | 观察模型输入、输出、运行和错误 | typed handler 返回 void，不是文件发布的批准、CAS 或事务回调 |
| `before_agent_finalize` | continue/revise/finalize 控制模型运行的收尾 | 没有目标文件、expected-before hash、来源闭包或发布事务；revise 会增加模型轮次，也不治理 phase、promotion、fallback 的独立写入 |
| `before_message_write`、tool hooks | 前者同步控制会话 transcript message；后者控制真实工具执行 | before_message_write 不是任意文件写入 hook。原生 Dreaming 直接走文件函数；本次日记成功发布而写工具回调为 0 |
| `MemoryPluginCapability.publicArtifacts` / `listMemoryHostPublicArtifacts` | 列出 kind、workspace/path、agentIds、contentType | 没有原件 Ref/版本、文件 payload hash、generation、输出依赖或发布批准。此次枚举包含 daily note、phase reports、event log，不构成日记来源收据 |
| `read/listMemoryArtifactProvenance` | 正式读取支持路径的 fileHash、originClass、observedAt、可选 sessionId/sessionKey | 路径契约排除 DREAMS.md 与 memory/dreaming 报告。即使返回普通文件的 provenance，也没有 Core 来源闭包、处理权威或 generation；本次 DREAMS/MEMORY/daily 三项均返回 null |
| `MemoryCorpusSupplement.search/get`、memory prompt preparation | 扩展检索或上下文内容 | 没有原生 Dreaming 的生成或发布委托 |
| `memory-host-events`、runtime lifecycle、cron hooks | 事件日志、资源清理、任务身份与调度观察 | 日志不是不可伪造的授权收据；cleanup/cron event 不接收、批准或提交待发布正文 |

核查可重跑：`node scripts/audit-dreaming-public-seams.mjs`。脚本从正式 plugin-entry 类型引用解析 SDK，记录全部 hook 名、接口字段、18 个 Host 文件摘要、关键函数位置及函数摘要。内部实现文件仅作为只读证据解析，没有导入或执行。产物为 `.artifacts/issue23-dreaming-seams/interfaces.json`。

### 实际调用链

`memory-core` managed cron → `before_agent_reply` → `runShortTermDreamingPromotionIfTriggered` → light/REM/deep。

- Light/REM 从 daily notes、可用会话及内部 recall state 取得候选和近期 diary context；调用原生 narrative 子运行。`startNarrativeRunOrFallback` 传入文本并禁用工具，没有向 Core 传递完整原件清单的 port。
- `appendNarrativeEntry` 在 workspace lock 内检查 native store key 和近期 diary 片段，然后 `updateDreamsFile → writeDreamsFileAtomic → replaceFileAtomic`。当前来源改写／删除后旧 key 仍可存在，先前两项实验因此仍发布旧日记。
- Deep 自身**有**原件重读、候选 fingerprint、MEMORY.md hash/CAS 和原生来源过滤，不能把 Light 的问题扩展成 Deep 完全没有保护。但这些不核对 Core 来源政策／代际；最终 `writeMemoryContent`、append-only fallback 和报告写入仍无外部必经发布 port。
- 原生子运行失败后的 diary fallback、deterministic promotion/report 写入也绕过模型回调。只包装模型，或在文件已落地后监听变动，不能构成完整协议。

关键函数及位置以 `interfaces.json.nativeSites` 为准，避免仅依靠打包文件名或不稳定行号。

## 与既有 Core 协调器的可组合性

Core 已有可复用构件：CatalogReader / EpisodeEvidenceResolver / source_access_context 复核原件与权限，processing authority 及 `withHostModelConsumption` 绑定确切模型输入与输出，`applyMemoryTransaction` 提供 fence、CAS、持久化、恢复与 publishView，`synchronize` 传播来源代际变化，签名 context views 和 provider 门禁治理后续消费。

这些构件能服务一个**Core 持有输入和发布权的整理操作**。当前 native Dreaming 不调用其事务端口；`applyMemoryTransaction.publishView` 是 Core 的本地 port，不能拦截另一插件已经执行的 native fs 写入。`stella.compactHistory` 的许可仅授权签名历史压缩；受限 `memory_access` 验证许可明确要求 Dreaming disabled，也不授予新业务写入、后台整理或发布权。不能复用这些许可扩大权限。

## 最小上游变更提案

以下是提案能力名，**当前 Host 不提供**；不通过本地 monkeypatch 模拟已经支持：

1. **每 workspace 的必经 derivation adapter 注册。** Host 给目标范围启用严格适配，并提供真实 producer、job/run、phase、agent/model、取消及请求上下文。Core 再验证对应已声明任务和资料处理授权；注册本身不授予权限。其他共享 Agent 继续各自策略。
2. **生成前的封闭输入快照。** Host 通过正式 API 提交每个候选／既有 MEMORY／recent diary／会话片段的独立 locator、内容摘要、范围、来源性质和版本；由 Core 对照已留存的权威资料映射到 Ref、政策和当前 generation。结构化 LLM 完成资格相关语义选择，原生权重不能替代它。Host 必须只消费适配器批准的确切输入。用 Host 持有的不可序列化句柄绑定本次调用；不能靠公开 JSON、session 名或补填 generationId 授权。
3. **原生生成只形成草案；统一发布委托。** 正常 narrative、Light/REM report、Deep rewrite、append promotion、fallback 等所有产物都携带确切 bytes/hash、expected-before、完整依赖和操作 ID，经过同一强制 port。Core 在生成前后及提交前重验来源／代际／权限，以现有事务、durability 和受管投影机制持久化及发布。Host 仅在收到匹配提交收据后更新自己拥有的派生机器状态，失败需可恢复且不能另走 native fallback 直接发布。
4. **最终消费保留派生关系。** 不把模型产物重新归为用户来源；后续模型消费验证签名闭包。来源删除／修改使日记、推广记忆和相关缓存不再作为当前理解使用。后台成功、文件存在及 cron ok 均不能替代这一检查。

仅增加一个 after-write 通知、导出私有 native runner、允许 Core 填写原生 store key，或给日记加 generation 字符串，都不足以满足以上协议。上述 API 必须有“适配器报错／取消／缺失时不发布”的 Host 强制语义，不能用 fail-open hook 拼装。

### D-057 的替代生产者

D-057 已选择 Core 自管整理：按明确请求从现有 reader 取得留存证据，经正式 `runtime.llm.complete` 与 guarded provider 生成结构化候选，独立验证后通过 Core 事务和受管视图发布。它替换原生生成与发布所有权，不把原生 Dreaming 声称为合格，也不删除或 optional 化必要能力。具体接口和四项安装包探针见 [Core 受管整理](issue23-core-consolidation-2026-10-15.md)。

该路径沿用公开 SDK 与既有 Core 协议，不依赖修改 Host 或调用私有 native runner。真实模型质量、实际目标配置、资料处理授权及完整产品准入仍须独立验收。

## 可重复的原生行为诊断

以下 producer／consumer 为隔离的合成 Host；仅共运行场景将 Core 与原生生成放在同一 Host。每次重跑的源码、包、Host 和场景版本以其 receipt 为准，本地原始产物不随源码提交。

| 探针名称 | 具体证明 |
| --- | --- |
| `native-changed-during-narrative` | 原生模型确实读入原件后改写该合成原件；仍发布旧日记，1 次 loopback 请求 |
| `reject-changed-during-narrative` | 上项真实日记通过公开 prompt hook 进入同包 Core；最终模型请求 0、业务回答 0 |
| `native-deleted-during-narrative` | 原生模型确实读入原件后物理删除；仍发布旧日记，1 次 loopback 请求 |
| `reject-deleted-during-narrative` | 上项真实产物的同包最终消费拒绝，模型请求 0、业务回答 0 |
| `native-deleted-after-publication` | 正常生成真实日记后删除原件，保留旧产物供后续拒绝验证 |
| `reject-deleted-after-publication` | 上项产物经公开 hook 注入 Core，被绑定输入门禁拒绝，模型请求 0、业务回答 0 |
| `guarded-dreaming` | read_only 合成 Core 普通轮次与原生 cron 共运行；原生子运行没有获得消费许可，但派生投影被写入，下一轮 projection_drift，Dreaming 后新增模型请求 0。不是合法生成成功或 full_memory 业务准入 |

本次另增 `probe-native-dreaming.mjs --inspect-public-seams`：对仍有效的合成来源实际生成并发布日记，观察正式 hook／产物／provenance API，1 次 loopback 请求；它是接口事实证据，也没有 Core 代际绑定，不纳入原先 7 项重算成功数。

这些诊断验证固定 Host 的公开接缝和具体反例，不替代当前候选的 Dreaming-disabled fresh-consumer 全量安装包验收。原生来源仍有效时可生成日记，也不代表已经取得 Core 来源／代际与发布资格。`issue23Complete=false` 和完整 profile blocker 保持独立；不签发 #35／#36／#37／#38 的完成结论。
