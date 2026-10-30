> 仓库文档候选，2026-10-30。来源为Library资料包version 1；原成员SHA-256：8faedd997a1e1de45f012aacc1df9b99c7ab9ef54219745f067e00ce344da25e。本次仅落库与任务索引更新，未实现或运行。源稿的“本轮/云端/待持久化/提交暂停”保留原阶段身份，其中提交暂停指旧业务线；现行任务状态只读[任务台账](../../../.task-control/state.json)。不是用户对整体规范的批准。
>
> 已规范化临时目录称谓及未附来源引用；原始恢复稿hash不冒充现存原件复验。证据层与适配说明见[本目录索引](README.md)。本机绝对路径、私人会话和无关项目文件未导入。

# ARCH-03：一份工具结果之后的流向与控制证据

2026-10-30；只读静态研究。基线为官方 OpenClaw commit `dc2523e5a5c7a309517fd7fa834add938231d526`。已读本目录 extension-options、proposal-reviewed-draft、review；本轮直接读取下列官方固定源码/文档。未核当前安装版本、配置、harness；未启动 Host、测试或模型，未读私人资料，未改配置或仓库。

## 结论先行

1. **未证实普通持久会话支持“这一份结果当轮可读，但其原文和所有衍生解释不可自动学习”的端到端逐结果硬边界。** 官方确有消息持久化 hooks、整会话 admission、整 agent 搜索设置和整会话 Incognito，但不能互相替代，也不能由工具入口权限推导保留/学习许可。
2. **必须纠正过宽的流向说法：原生 memory-core 的 transcript 索引/ingestion 共用投影仅收 user/assistant 文本，不直接收 `toolResult` 正文。** 工具原文仍可留在完整 transcript/当前上下文；后续 assistant 引用或释义可成为索引和 ingestion 输入。压缩摘要记录也不是此投影直接采集的 message；摘要影响后续回答后，回答又可进入投影。[S1][S2][S3]
3. 对“旧说明已取代但仍在旧 transcript”，原生 pruning/compaction 不删除原历史，admission 不撤销现有产物，forget 是整 session 的追踪产物清理而非 claim 取代事务。**Core 受控读取可保证返回当前资产；不能据此声称 Host 全历史/回答不复活旧解释。**[D1][D2][D3]
4. 首片可继续纯合成资料契约验证；真实资料若仅获本轮读取而未允许宿主留存/衍生处理，暂不进入普通持久会话。Incognito 是值得验证的局部候选，不是已经满足全部“不学习”要求，更不是本轮已切换的环境。

## 研究对象与四份不同许可

设唯一资产 `work-note/A`，工具本次返回版本 v1 的合成正文；随后作者纠正产生 v2、v1 标为已取代。分别记录：①请求者/受众资格；②来源读取许可；③本轮模型处理及向该受众投递许可；④宿主 transcript 保留、衍生摘要、索引、记忆晋升的许可。工具参数中的 `noLearn:true`、正文里的“只读”、来源标签均不是已核官方强制能力；不可用普通标签自建授权。

## 有限流向表

| 阶段/实际输入 | 官方控制及粒度 | 硬控制与限制 | 本片判断 |
|---|---|---|---|
| 工具返回 → 完整 transcript | `tool_result_persist` 同步返回替换 message；`before_message_write` 同步替换或 block。事件含 toolName/toolCallId，ctx 有 agentId/sessionKey；guard 在 append 前调用。[S4–S6] | 是代码执行的单消息持久化接缝，不只是 prompt；但默认 hook 异常 fail-open，异步返回被忽略，后续 hook 可再改写。阻断 toolResult 会保留 pending call 以供 synthetic repair。未证实所有 harness、日志、工具观察者、模型在内存看到的副本均受同一接缝控制。 | 可作为脱敏/占位符持久化实验；**不可宣称原文当轮可读而所有后续副本自动禁学**。须验调用顺序、失败分支和 live/replay 差异。 |
| 完整历史 → 后续模型上下文 | cache-TTL pruning 可按工具名 allow/deny；有时限/大小阈值，保留最近 turn，原结果不改写。compaction 用历史生成摘要并保留近期消息。[D1][D2] | 控制上下文体积，不是逐版本撤回/用途 ACL。摘要和原历史继续保留。`compaction.enabled:false` 仅停 proactive/optional，overflow/manual 仍在。 | “旧 v1 已被裁剪/压缩”不能作失效或擦除证明。 |
| transcript → memory-core session index | `buildSessionEntry` 只接受 user/assistant text，跳过 toolResult；`projectSessionEntryRecord` 也将其他角色 content 置 null。[S1][S2] 搜索 sources 默认 memory，但跨会话 recall 可自动加 sessions。[D4] | `sources:["memory"]` 单独不足，须结合 `rememberAcrossConversations:false`；可 per-agent override。关闭此索引不关闭原 transcript、session 工具或 hook 文件写。 | 工具原文不直接入该索引；assistant 转述仍可能入。无逐工具/逐资产版本 exclusion 证据。 |
| transcript → session-memory hook → daily artifact → memory index | hook 在 new/reset/auto-reset 保存近期 user/assistant 文本，明确排除 tool messages；可禁用该 hook；Incognito 不生成 artifact。[D5] | 是独立写路径，admission 不管它；关闭 sessions source 不管它。artifact 被 memory source 索引。 | 同样主要是 assistant 转述传播，不是 toolResult 直接复制；不能漏掉此支路。 |
| 会话 → pre-compaction flush → daily note | 默认开；`agents.defaults.compaction.memoryFlush.enabled:false` 可停。file flush 在 workspace 只读/无访问时跳过；provider tools-flush 另有规则。[D6] `memory-flush-prepare` 建 detached transcript，delegation 绑定 source revocation。[S7] | 隐藏 housekeeping 会话不等于不写；原生 file flush append-only/dedup 防重复不是 no-learning。没有已核单工具结果排除键。 | 若只许可本轮读取，flush 也是须明确允许或证明不可达的处理；不可只关 dreaming。 |
| session projection / daily notes → dreaming/backfill → MEMORY | admission 以 hook source、channel/plugin ID、chatType 的精确匹配，OR 合并，整会话排除，缺 metadata 不匹配。自动 ingest/backfill 在读 transcript 前检查。[D3][D4] ingest 读共用 `buildSessionEntry` 的文本与 provenance。[S3] | 硬 admission，不只是提示；但不覆盖 raw indexing、直接写、session hooks，且不清既有 corpus/候选/晋升。`dreaming.enabled:false` 是插件配置层总开关。 | 无逐结果 `noLearn` 或 Core asset v1→v2 取代传播保证。 |
| 派生内容 → taint/promotion gate | 网络来源工具声明使本 turn 后续 assistant 为 untrusted；下一 user turn 清除。untrusted/system 不进入 consolidation/promotion。[D7][D6] | 代码分类门禁，但“来源不可信”不是“用途不允许”。local file/custom tool 声明覆盖有缺口；不能伪造 network-source 来当业务许可。它也不禁止 transcript、索引、直接写。 | 不能将 taint 当跨 turn 数据用途标签或版本撤销。 |
| 留存历史/记忆 → 后续消费 | session tools 独立 visibility；Active Memory 有单独有限跨会话授权；shared workspace memory 不是被这些设置自动逐事实分域。[D4][D8] | caller visibility 与 claim currentness 是不同约束。memory_search hit 不会自动执行 Core 当前版本资格检查。 | 只有重新经 Core 受控入口取当前资产的路径可承诺当前性；历史命中应被标为历史证据，模型是否遵从另验。 |

## 两个必需负例

### A. 当轮可读，但不许自动学习

**普通持久会话：尚无已证端到端隔离。** 不允许把“只读工具 + 禁 dreaming”判成功：原 transcript、assistant 转述、session-memory、flush、允许的文件/shell/其他插件写仍可能存在。只对 one toolResult 做持久化替换也不阻止 assistant 在回答中复述后持久化；反过来全面阻断 assistant 又改变正常会话行为，且依旧缺实际 harness 证据。

**官方可复用候选：新 Incognito 会话。** 文档规定从 Control UI New thread 启用，session entry/transcript/compaction 在进程内存，24 小时或 Gateway 重启到期，不延寿；不运行自动 flush，不保 reset/delete archive，Codex harness ephemeral；session-memory hook 不产 artifact。[D8][D5] 这是真实会话级存储控制，不是仅 prompt。但正常工具依然可写文件，provider 仍处理消息；`incognito-system-prompt.ts` 的“不要存长期笔记”本身只是 prompt。[S8] 因此还需验证目标 harness、其他插件观察/写路径及可写工具隔离；本研究未证明全部自动学习入口在此配置都不可达。不能擅自改用户正常配置，也不把该候选升级成当前真实资料流程已可开放。

若用户允许 transcript 长期保留但仅禁止记忆晋升，仍需明确“学习”是否包含索引、摘要、日记及回答复用；这不是技术可以代替用户决定的同义词。首片无需等待该澄清：用允许这些处理的纯合成域即可继续。

### B. v1 已取代，但旧 transcript 仍在

- Core 当前资产读返回 v2，旧 v1 有历史身份，是可在首片确定性验证的本地不变量。
- 旧 toolResult 仍可出现在完整历史/显式检索中；旧 assistant 解释则可继续存在于 memory-core session index、session-memory 文件及已晋升记忆。pruning/compaction 不赋予 v1 失效语义。
- `memory forget` 可按明确 session IDs 清理可追踪产物并在该 agent 库记录 forgotten，阻止这些 session 再 ingestion/backfill/index（包括 force）。它不删除原 transcript、所有自由文本/释义/外部副本；混合来源 entry 整项删除，其他 agent 另算。[D3] **这是整会话清理，不是只撤销 work-note/A:v1；首片不应执行它来冒充纠正事务。**
- 历史文本“v1 已取代、请重读当前资产”、prompt 的 currentness 说明，以及 USER 的 active/superseded 写作规范，不能强制所有未来模型不复述旧解释。可将旧输出压成非权威带版本引用，但实际采用 v2 仍须跨压缩/新会话语义验收。

## 首片合成技术验收的可行边界（定义，不是已运行）

1. 仅一份虚构工作说明、一个合成工具结果；可明确允许测试 transcript/摘要/索引/整理，不带私人文本或敏感路径。保留原生 memory/context/Agent Loop，不写 USER，不复制第二权威到 MEMORY。
2. 技术断言分开：Core v1→v2 原子发布/重试/旧候选拒绝；新请求重新查资格与版本；Host 是否保留工具原文；assistant 衍生文本是否进入索引/hook/flush；声明“未知/滞后”而非静默报同步。
3. 在后续获准且实际环境可用时，用固定结构响应分别测试：正常保存、同步替换、block→repair、hook throw/Promise、重启 replay；不调用真实付费模型。本轮不实现这些测试，不默认当前 harness 支持这些 hooks。
4. 任何真实资料只有本轮许可时，依赖其隔离的流程保持不可用；不阻塞纯合成读取/提案/发布。若不能证明本片某路径局部隔离，不能以“以后关掉”作为放行理由。
5. 不承诺任意 Host 回答已持续忠实 v2。自然下一请求、压缩、恢复后的语义效果必须单列模型与作者判断；JSON、hash、工具回读和合成固定响应不能代替它。

## 固定证据

所有链接固定同一 commit；私有 host SDK 文件只用作静态实现证据，**不是建议 Core 调用该私有面**。

- [S1 session-files.ts：共享投影、角色过滤与 provenance](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/packages/memory-host-sdk/src/host/session-files.ts#L535-L840)
- [S2 session-entry-projection.ts：仅 user/assistant 文本](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/packages/memory-host-sdk/src/host/session-entry-projection.ts)
- [S3 session-ingestion.ts](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/extensions/memory-core/src/session-ingestion.ts)；[index 调用同一 buildSessionEntry](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/extensions/memory-core/src/memory/manager-session-sync-ops.ts)
- [S4 hook 类型](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/plugins/hook-types.ts#L579-L605)
- [S5 wrapper](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/agents/session-tool-result-guard-wrapper.ts)；[guard](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/agents/session-tool-result-guard.ts)
- [S6 同步 hook 执行与默认 fail-open](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/plugins/hooks.ts)
- [S7 flush prepare](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/auto-reply/reply/memory-flush-prepare.ts)
- [S8 incognito prompt](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/agents/incognito-system-prompt.ts)
- [D1 pruning](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/concepts/session-pruning.md)
- [D2 compaction](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/concepts/compaction.md)
- [D3 provenance/admission/forget](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/concepts/memory-provenance.md)
- [D4 memory config](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/reference/memory-config.md)
- [D5 bundled hooks](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/automation/hooks/bundled-hooks.md)
- [D6 memory/flush/dreaming](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/concepts/memory.md)
- [D7 memory architecture/taint](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/concepts/memory-architecture.md)
- [D8 session/Incognito](https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/docs/concepts/session.md)

## 已证／未观察／阻塞

- **已静态确认：**上述固定版本的具体投影过滤、消息保存 hooks、配置粒度、保留/删除边界。
- **当前环境未观察：**安装字节/版本、harness 回调、有效配置、插件清单、实际存储/模型上下文、隔离效果；均不是通过或失败。
- **实质未知：**逐结果用途约束传播、assistant 派生解释全面阻断、所有 harness 的 live/replay 等价性、Core claim 取代对全部 Host 副本的持续语义效果。
- **工具情况：**一次 recursive tree 读取报 Transport closed，改读有限目录和指定文件完成必要证据；尝试独立 `docs/concepts/incognito.md` 无正文，改读实际 session 文档。没有权限拒绝或等待批准的动作；未知不冒充工具权限阻塞。到本片静态问题边界停止，不展开全 SDK。
