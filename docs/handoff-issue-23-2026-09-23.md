# Stella-Core #23 交接 — 2026-09-23

## 接手结论

**#23 未完成。不要关闭 Issue、解除 full_memory 阻断或宣称生产就绪。** 用户最新要求是使用 `$handoff` 将交接保存到 docs；本文件即交付，不在本次交接中继续实现或提交代码。

工作区 `/Users/zangtao/Workspace/tower1229/Stella-Core`，分支 `master`，交接时 HEAD 为 `5c570c410d41234369db530c8b268b41e48d6999`。大量相关 tracked WIP 和 untracked 源码、测试、probe 尚未提交。必须同时查看 `git diff` 和 `git status --short`，只看 diff 会漏掉主要新增模块。不要 reset、clean 或覆盖这些文件。

目标“这次完整做完#23”在交接时由 `get_goal` 返回 **paused**；本次未调用 update_goal 改变状态。等待用户恢复后继续原目标，不能自行把交接视为实现完成。

## 合同、授权与建议技能

以 [Issue #23](https://github.com/tower1229/Stella-Core/issues/23)、[父 SPEC #6](https://github.com/tower1229/Stella-Core/issues/6)、[需求](09-REQUIREMENTS-ALIGNMENT.md)、[设计基线](10-DESIGN-BASELINE.md)、[Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md)、[Host 集成](04-OPENCLAW-INTEGRATION.md)、[领域语言](../CONTEXT.md)及仓库 AGENTS.md 为准。不要复制旧交接中的完成度或把已关闭前置票当作本票验收。最近一次实时读取 #23 时三个验收框均未勾选；#10、#22 已关闭，#23 仍是父 SPEC 最早的未完成实现子票，#24–#39 尚未完成。

本对话用户另行批准了“在原版 OpenClaw 2026.8.2 上治理旧记忆回流”完整实现方案；接手时应读取该用户消息，不以 Issue 简短正文缩减其范围。特别保留：

- **必须兼容未经修改的 OpenClaw 2026.8.2**，用户明确拒绝给 Host 打补丁。
- 新理解必须可消费，旧理解不能从历史、摘要、缓存等入口回流。全拒绝、清空历史、关闭必要能力都不算完成；保留合法历史查询、原始档案及其他 Agent 行为。
- 按用户授权可使用 CangHai 副本做私人资料本机验证；Core 验收后再同步相关配置，未完成整体记忆验收时保持配置未激活，保留回滚。
- 最终须独立 Standards／Spec review、**本地 commit**、从干净提交重打包、原版 Host 验证并绑定最终 SHA／包摘要。**不自动 push、关闭 Issue、发布或重启生产。** 本地 commit 授权来自用户明确方案及 implement 技能，不是一般 AGENTS 默认行为。
- 不新增付费／外部真实模型调用授权；此前当前工作使用注入式语义结果与本机 loopback 模型。私人原文、详细证据、配置密钥不得进入公共仓库。

建议下一会话使用 `/Users/zangtao/.agents/skills/implement/SKILL.md`，完成后使用 `/Users/zangtao/.agents/skills/code-review/SKILL.md`。后者明确要求独立双轴审查，可复用现有 review agents；不要把审查代理当作编码代理。语义选择必须结构化 LLM，不能改成关键词过滤。**任何构建、测试、probe 运行期间不要编辑源码。**

## 中断的准确位置：先处理这批未验证代码

最后一轮新增了 [host-context-view.ts](../src/openclaw/host-context-view.ts)，并修改 [host-context-authority.ts](../src/openclaw/host-context-authority.ts) 与 [host-context-graph.ts](../src/openclaw/host-context-graph.ts)。

- graph：提取 `readNodes`，新增通用 `readContextTrace`，导出 `parseContextSources`，复用现有拓扑／内容摘要／依赖继承校验。
- authority：准备的 HistoryViewSnapshot 增加 agentId、signerId，sources 规范化；新增 `assertHistoryViewSnapshot`，供签名重建结果发布／恢复时重验原 archive、资格诊断、retainedNodeIds、来源与当前授权。**它不签发消费 fragment。**
- view：草拟 `publishPreparedHistoryView`、`recoverHistoryView`、`loadPublishedHistoryView`、`readPublishedHistoryView`。计划把签名重建记录、签名文件、版本化 recipe、catalog selection 放入同一个 `applyMemoryTransaction`；读取时检查当前配方、签名和确切 journal；未结束事务不能返回已发布 handle。恢复重放计划，不重跑模型。

**这只是刚落盘的实现草稿，不是已经验证的能力。** 中断的 `npm run check` 会话 `83342` 已在交接时轮询，确认 exit 0。它之后没有任何构建、测试或 probe 仍由本任务运行。`git diff --check` 交接时通过。最后一轮尚未运行测试、build、独立 review；下节的 92/92 是这批修改之前的结果。

立即需要审查／修正的风险（是接续调查点，不是已通过结论）：

1. 新出版路径尚未显式复用 `persistContextHistory` 的 retention 检查；新来源 policy 不允许 retain 时，不能把其派生内容写入仓库。
2. `assertHistoryViewSnapshot` 当前检查 retained nodes 存在于 trace，但还应证明它们实际属于输出 summary 的祖先闭包，不能只在图中作为孤立节点存在；输出 root 必须携带完整来源闭包。不要把结构正确等同于消费授权。
3. 还没有 `restoreHistoryView` 的真实消费接缝。接通时需从真实已发布 opaque handle 读取，再重验当前 catalog recipe／代际／签名和来源；后续 provider 校验必须继续绑定视图文件、签名及配方，不能只在首次恢复检查一次。
4. 新 `planFor` 在当前 generation 注册／替换 view，尚未接入下述所有 generation writer。**不要现在就在 main 注册首个 required 非空 view**，否则正常下一轮会因其他 writer 没有迁移 views 而失败。
5. 明确区分可留存的签名历史重建记录与运行时索引缓存；[Portable Registries](contracts/PORTABLE-REGISTRIES.md)规定实际索引／缓存不提交 Git。当前新文件注释表达前者，仍须独立 Spec review 核对设计。
6. 验证成功后重试、部分写入、新进程恢复、错误签名／配方、来源撤权及中途同步；真实业务完成证明不能由新 view 伪造。新模块尚未加入 package-smoke 必需文件清单。

## 已经实现并有局部验证的接缝

以下为代码导航，具体逻辑以文件为准，不替代全票验收：

- [host-context-authority.ts](../src/openclaw/host-context-authority.ts)：Core 进程内 opaque fragments／consumption；最终 system/messages/tools、工具续轮、来源与配置绑定；独立原始证据读取和当前处理授权。
- [host-context-graph.ts](../src/openclaw/host-context-graph.ts)：签名 archive v2 的完整来源图；producer、正文摘要、parents、原始来源／payload／配置／ancestor archive。assistant 继承实际完整输入，summary 继承全部输入，模型不能签发或删减 provenance。
- [host-context-history.ts](../src/openclaw/host-context-history.ts)、[host-context-head.ts](../src/openclaw/host-context-head.ts)：签名 archive、事务恢复、明确 revision 的历史头。main 的 v2 历史头需真实 business commit/journal 证明；先保留实际上下文，业务成功后才发布历史头。失败不能伪装为空历史或已投递。v1 仅保留低层测试兼容。
- [host-context-engine.ts](../src/openclaw/host-context-engine.ts)、[host-memory-provider.ts](../src/openclaw/host-memory-provider.ts)、[plugin.ts](../src/plugin.ts)：原版公开 Context Engine／prompt hook／provider 接缝，目标 Agent 选择及其他 Agent 委托；Host 捕获引擎错误后回退的消息仍须过最终 provider gate。
- [view-recipe.ts](../src/canghai/view-recipe.ts)、[catalog-reader.ts](../src/canghai/catalog-reader.ts)、[synchronization-plan.ts](../src/canghai/synchronization-plan.ts)：真实版本化 recipe locator、严格 view 声明、确切 inputRefs、显式 revision 从 Git blob 读取配方。不是 adapter-ready 证明。

此前两个连续回合完成并测试的重点：

1. `assessHistoryForRebuild`：先验证签名／scope／完整来源图，再逐节点校验当前资格。显式来源失效沿 parents 传播，独立输入和公共规则可保留；返回无原文诊断，不能作消费凭据。未知引用、损坏、未同步 payload 变化和并发代际变化均失败。
2. 混合依赖修复：A 失效不能掩盖仍 current 的 B 的损坏。`EpisodeEvidenceResolver.assertCurrentEvidencePayloadIntegrity` 对 current Evidence 的仍合格来源做授权片段完整性检查，**不返回文本、不恢复旧理解资格**。覆盖普通和分段来源。
3. `prepareHistoryRebuild`／`historyViewSnapshot`：仅将合格历史节点和真实 fresh fragments 交给结构化模型；失效节点只有 ID／原因，不含旧正文。结果绑定 generation、scope、编译／配置、source archive、实际 promptDigest、来源图；未发布 handle 不能进 provider；模型中途或准备后来源变化会拒绝。未归档 current_input 及其派生 summary 不得进入持久 view。
4. 独立审查发现并修复“依赖继承≠文本完整保留”：现在 `eligibleContextInputs` 保留**全部合格语义节点**，不能因为后一次助手只说“好的”便删除前面的详细正文。格式包装可以不作为独立正文，但不能用图后代关系作语义去重。
5. 实际 provider／tool receipt 测试扩展到签名 archive → 重建输入，验证独立 assistant 正文、两个工具结果、原始证据和当前输入都进入 prompt。

对应 [host-context-authority.test.ts](../tests/host-context-authority.test.ts)、[routing-context.test.ts](../tests/routing-context.test.ts)、[view-recipe.test.ts](../tests/view-recipe.test.ts)、[episode-evidence.test.ts](../tests/episode-evidence.test.ts)。

## 主线仍缺：所有 generation 事务中的视图迁移

独立 review_host_completion 已确认以下真实接缝。不要用“旧 view 改个 generation 字段”替代重新验证：

- [archive-writer.ts](../src/canghai/archive-writer.ts) 使用独立 intent／expectedPaths／重放流程，不直接走 applyMemoryTransaction。
- [ingest.ts](../src/canghai/ingest.ts) 的普通与 do_not_retain 分支都会推进 generation。
- [question-transaction.ts](../src/praxis/question-transaction.ts)、[outcome-transaction.ts](../src/praxis/outcome-transaction.ts)、[correction.ts](../src/learning/correction.ts)、[synchronize.ts](../src/canghai/synchronize.ts) 都必须迁移 required views；Outcome 实际改写 episode.json，不能只比较 catalog entries。
- CatalogReader.validatePreview 目前要求 views 不变，而 parseMemoryViews 要求 view generation 等于 catalog generation。需接收并验证具体迁移计划，不能新增无条件 allowViewChanges。
- synchronize 当前仍在约 227 行以 `required_view_adapter_unavailable` 阻断非空 views。finalPlan 恢复分支当前缺少 view 语义校验，receipt 只报告 catalog。

建议顺序：共享“before/after catalog＋实际 file changes→经验证的 view migration plan”；先接 ingress／Question 无相关来源变化的重新认证；再接 correction／Outcome／synchronize 的结构化重建；把配方、签名记录、catalog 和 fence 放入对应真实事务；覆盖每条恢复分支且不重跑模型；最后才在 main 注册第一个非空 view。

重新认证也必须逐项复验对象、payload、策略、配置、Episode 与 recipe 输入语义，并签发新 generation 资格。包含候选全集／覆盖范围／“未发现证据”的视图，新增材料也可能要求重建，不能按操作名称默认无影响。

此外仍需完成：一般 main ingress（当前主要依赖 correction grant 路径）；Question checkpoint／direct 语义阶段 provenance；Core 主动召回和后台整理替代；配置绑定的治理清单；Advice 多事务及 main 公共恢复入口；完整生命周期／受众／故障矩阵、公开 correction/delete＋synchronize 正向链；私人资料本机验收、CangHai 非激活迁移／回滚；全量测试／最终 review／commit／干净源码打包／Exact Host 最终 SHA 与包摘要。

## 验证证据与局限

### 最新源码验证层次

- 上一轮（**新增 host-context-view.ts 和签名快照验证器之前**）运行 `npm run check`，随后编译测试并跑 authority、routing-context、view-recipe、episode-evidence 四组：**92/92 通过**（会话 26758 已结束）。
- 上轮新增重建接口及图选择修复，Spec／Standards 两个独立审查代理确认 P2 关闭、未发现新增可证实问题。仅覆盖那批改动；**不是整票 review，也不覆盖本轮未测持久化模块**。
- 本轮最新修改仅 `npm run check` exit 0（83342）及交接时 `git diff --check` 通过。
- 尚未跑最终全量测试、干净 package smoke；没有最终 commit／package receipt。现有 dist 可能落后于源代码，下一次 probe 前先 build。

### 原版 Host 的已有合成证据

安装依赖与隔离源版本均为 OpenClaw 2026.8.2；此前隔离源目录 `/tmp/stella-issue23-openclaw-source`，tag SHA `0965053fe6b9341776df147a6934b7485c60b5ca`（接手重验）。源目录真实路径是 `src/agents/embedded-agent-runner`。

以下临时证据目录在交接时确认仍存在，均在 `/var/folders/3g/sbd2x9l51tb9gkn_k1y2j_7w0000gn/T/`。它们基于更早 WIP，不绑定当前最终源码，不得当作最终包／生产验收：

| 目录后缀 | 已取得证据 |
| --- | --- |
| `stella-native-active-memory-EzTQNu` | 原生 Active Memory 实际工具读取、两次 recall＋一次最终 loopback 模型；真实注入产物。`native-active-memory.json`、`native-final-input.json`。原件 SHA256 `19eb6931aa1659b1c44b7c55b4bd1af79b6953cd5ec4f128bd05c8e3445663bb`。 |
| `stella-native-dreaming-FOjT2x` | 原生 memory-core cron 实际执行、narrative subagent、一次 loopback 模型、真实 DREAMS.md 发布。`native-dreaming.json`、`native-dreams.md`。原件 SHA256 `c8666d521ec22490b8f1f32d957a4b5f293c874304362c0c6208403738dcf092`。 |
| `stella-main-completion-mv9pof` | 校验 Active 原件后取其实际 prependContext prefix，经公开 hook 回放进实际 Stella main；assemble 失败→Host fallback→最终 provider 拒绝，模型调用 0、最终回答 0。prefix SHA256 `01865320034b1656e83aa2b7e85b02be1cf6e80ef36c7ab46bfc5f4af5fe4086`。 |
| `stella-main-completion-m20FMb` | 实际 Dreaming 日记经 appendSystemContext 回放进实际 main，provider 拒绝，模型调用 0、回答 0；无引擎 fallback 主张。 |
| `stella-main-completion-mvycfD` | 原版 Host 实际 managed main 正向：新理解进入最终输入、推理前归档 ingress、模型 1、回答 1、v2 business binding 验证。 |
| `stella-main-completion-Hh8dfK` | 实际 main 业务写入失败：已调用模型但最终回答 0，原始签名上下文保留、事务 pending、旧历史头不变。早于后续 graph 修复，最终包需重跑。 |

生成与回放是**两段独立原版 Host 运行**，不声称 native plugins 与 Stella 同运行集成。注入语义判断／loopback 模型属于合成测试，不等同真实私人模型或自然反馈。相关脚本为 `probe-native-active-memory.mjs`、`probe-native-dreaming.mjs`、`probe-main-plugin.mjs --native-artifact <report>`；package-smoke 已编排这两段及 managed-context／managed-business-failure，但还未在最终干净包执行。

早期失败 probe（例如错误类别断言不符）保留在临时目录，不可计为通过。若本机 loopback 因沙箱 EPERM 失败，使用工具正式提升权限；不改测试假装成功。

## CangHai 与生产

用户数据源 `/Users/zangtao/Workspace/tower1229/CangHai` 已授权用于隔离副本本机验证。历史记录中的 dev SHA 为 `78f5466b0ad53595f020f315969e639e8bd9d83d`，Core 测试候选 SHA 为 `1eec6169cbb735721dbb667bf78ff5ca35638318`，**本次未重新核验，不能作当前事实或 Stella 1.0 基线证明**。按 AGENTS 核查 1.0 时读取真正 dev 并记录解析后的 SHA；运行时使用显式配置引用。

目前未完成此次最终私人资料验收或迁移验收；未因 #23 修改／重启生产。`src/openclaw/host-memory.ts` 仍对 full_memory 返回 `host_memory_consumption_unverifiable`，这是必须保留的实际状态。

## 恢复工作时的第一批操作

1. 用户恢复目标后，重读 AGENTS／适用合同，核对 git status 和以上未测源文件。不要重做已有合成证据来替代未实现事务。
2. 先完成新 view 发布／恢复路径及来源保留策略、图输出闭包检查；补真实事务部分写入／重启／篡改／撤权测试，然后独立 review。
3. 接通消费时让已发布 handle 经当前 authority 生成 fragment，并把实际视图／签名／配方继续纳入每次 provider 校验；未完成目录发布不能放行。
4. 推进所有 generation writer 的共享视图迁移，接 main 正向纠正／删除链，最后完成原定整体验收与交付。

交接文件本身不改变实现状态，不代表提交、发布或验收通过。
