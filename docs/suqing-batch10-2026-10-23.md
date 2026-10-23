# 肃清第十批：用户请求边界与原版 Host 工具链

基线 `6327ae8bf9880059241f05046ccae50efd7f0ccd`，分支 `codex/issue23-integrated-regression`。版本、完整命令、退出码、源码/编译清单和探针原始证据见 `.artifacts/suqing-batch10-20261023/delivery.json`。本批仅本地合成验证与本地提交，不是安装包或生产部署。

## 当前决策

用户于 2026-10-23 01:56 UTC 明确：Stella Core 为实验性项目，架构优雅优先，不追求运行中撤权等极端时序。已记录在 AGENTS.md、设计基线与 [D-058](DECISIONS.md#d-058--experimental-simplicity-and-user-request-boundaries)，并给肃清原主计划追加执行修订。

一次用户请求捕获当前权限、Core checkpoint 与真实 Host session；本请求内 list → read → 后续模型调用属于同一请求。Core 保留首次完整验证成功的证据原文，返回时复制，结束/取消/关闭清除；不复制整仓库，也不把新观察到的 B 赋给旧 expected。新用户请求创建新 grant、空证据缓存和新 loader/resolver，读取当前 checkpoint 和来源权限。

取消第九批提出但未实施的受控 provider / 输出缓冲路线。不增加代理层，不修改 OpenClaw，不对正常 Google provider 重新包装。第八、九批严格实时撤权失败报告保持原样；本批范围变化不使旧失败变成通过。

## 门禁收敛

| 处理 | 机制与原因 |
| --- | --- |
| 删除 | reply_payload_sending、appendBeforeDeliver、before_message_write 中的运行中来源复核/输出拦截；它们服务于已撤销的即时收回目标，且同 key 多轮 grant 会产生误阻断 |
| 删除 | 永久 physical sessionId 黑名单；改由新 run/未使用 grant、真实 key/id/lifecycleRevision、owner 和空历史准入判断 |
| 保留 | 入场身份/权限、配置及 hook 权限、严格工具参数、未缓存来源的 checkpoint/catalog/policy/hash 检查、取消、写入事务与精确 CAS |
| 保留 | 未接线能力的 full_memory/profile、source-access 和 bootstrap/writer 限制；它们代表实际核心缺口，不是实时撤权要求 |

首次供给失败拒绝该来源；它不再宣称 Core 控制 Host 的所有流式、最终或持久化输出。已经合法供给的证据可在本请求中续用。普通更新不会仅因其发生于工具续轮间而追回该缓存；尚未供给的新来源仍须满足原冻结版本，不能临时收养新版本。

## 历史与刷新边界

当前有限模式要求 before_agent_run 收到空历史。使用公开 `sessions.reset` 或用户的新会话机制，并在完成后再发送请求；Core 不在 reply_dispatch 中偷偷旋转 session 或改写 transcript。允许官方 reset 后复用同逻辑 key，物理 id 是否改变由 Host 决定。旧历史记录仍可能存在于磁盘归档，reset 不是删除历史。

这样上一请求已供给的内容不会通过旧 live history 被当作本轮当前记忆。B 中仍合法保留的 A 来源可由新工具正常重新读取，这与泄漏旧会话不同。当前仍有每个注册 scope 最多 64 个 run 的保守容量限制，不宣称无限期长运行；当前不承诺带旧历史的无缝长对话；此限制应作为有限模式的使用边界，而非声称 full_memory 已完成。

Core loader 每次 load 都读取当前 authority；完整 revision/token/binding 改变时不会命中 A 缓存，TTL 命中也重新 assert。此数据工具路径不需要 Gateway 重启或 RAG 重建；bootstrap、memory-core 和 wiki 消费者各自仍按文件刷新矩阵验收，不能由本探针代证。

## 验证与证据

最终 `verification-a2`：typecheck、编译、**113/113 定向测试 + 3/3 legacy 注册检查**通过，无 skipped/cancelled。首轮 a1 的 111+3 已通过；局部审查补回正文返回前的同步取消检查，并新增未缓存 A 遇 B 的负例后，以 a2 重验，最终全部实际探针都使用 `compiled-a2`，未混用旧包结果。

| 真实 Host 场景 | 本批结果与原始证据 |
| --- | --- |
| a1：A→B→C 三个用户请求 | A 的 list/read/answer 3 次请求；Core archiveLocal 实际提交 B、发布新 token 后，同 key 官方 reset，新请求经 list/read 消费 B 正文并回答（第 4–6 份）；测试夹具经真实事务/CAS 发布权限 C 后，新请求 list 返回 permission_denied，第 7–8 份均无 A/B 标记或旧答复 |
| a2：正常取消 | tool_result_persist 后公开 abort 被接受；仅 1 份模型请求，后续请求 0，无来源答复进入历史；没有借助 Core 输出拦截 |
| a3：历史隔离 | 未 reset 的下一用户请求被 checkpoint_agent_fresh_session_required 拒绝，新增模型请求 0；官方新会话后原生工具循环通过；场景总计 6 份请求 |

A/B/C 的 reset 保持同一 physical sessionId，但三个 lifecycleRevision 各不相同；公开 before_agent_run 的三次 historyCount 均为 0。B 首份输入没有 A 的旧 preview/答复；B 仍可通过新 list 合法重读 retained A，这是当前来源而非继承旧历史。C 当前 authority/token 与发布回执一致，拒绝类别为 permission_denied，不是仅因 hash 或未发布工作树脏数据而碰巧拒绝。

最终编译产物 136 文件，`compiled-manifest.json` SHA256：`7c5d14ff21db9df495c5b6580ad3e431476c276fc7ea94bbba27e0bc9ea358a1`。没有创建安装包。全量请求/事件、命令退出码、原始历史见 host-probe-a1/a2/a3；矩阵为 final-matrix.json。本批三个登记 Gateway 均 exit 0，fake provider 已关闭、合成 source fixture 已清理，owner 文件已移除。

真实探针为已安装 OpenClaw 2026.8.2 的隔离 Gateway、公开插件 API 和原生 Google Agent 工具循环；模型仅本机 fake Google 协议端点，合成资料与假凭据。完整 provider-N.json、公有 hook 事件和历史均保留。没有全树扫描/哈希 Host，因此不把包元数据当成完整代码原版认证，也不是 Gemini 真实服务或语义质量验收。

权限 C 的业务计划仅是测试夹具：针对没有 derived views 的合成 catalog，更新 policy 与依赖版本，走生产 applyMemoryTransaction/journal/精确 CAS 并验证回执。它不是新产品权限管理接口，不冒称真实沧海迁移已完成。

## SQ 状态与下一核心项

| 任务 | 本批后状态与明确剩余 |
| --- | --- |
| SQ-06 | 自有 checkpoint、初始化内核/本地归档/发布/重载基础已接线；公开初始化 RPC 目前只初始化 authority，尚未接入 workspace 物化；尚非全部业务 writer 迁移完成。不能将 requestArchive-only、fresh_tools-only 与完整业务 Agent 混称同一已完成模式 |
| SQ-07 | 文件变更计划纯函数可保留；实际 bootstrap/memory/RAG/可选 bundled-wiki 的消费者刷新与部分失败处理尚待接线，不能被数据工具成功替代 |
| SQ-08 | 原版 Host 原生 Agent 数据工具有限路径按用户请求语义收敛；不再追实时撤权/输出回收，不以其阻塞可交付功能；source-access、更多来源模式与历史能力仍有限 |
| SQ-10 | 本批验证请求 A → Core writer 发布 B → 官方 reset → 下一用户请求读取 B，以及新权限 C；不是全部初始化/归档/刷新/恢复场景已通过 |

下一最优先项：将现有 Core 初始化内核接到公开插件初始化入口，沿同一 checkpoint 路线收敛首次真实文件消费者（SQ-07 的受保护 bootstrap/必要 skill 物化与公开刷新），复用已有文件计划/initializer，明确用户文件保护、刷新完成和下一请求消费；随后以同一候选连通初始化→写入→刷新→新请求。不要转回 provider/buffer，也不先扩所有边缘矩阵。

full_memory 继续为 false：实际 bootstrap/业务 writer/源访问模式和有历史消费尚未闭合。运行中撤权不再出现在其必过清单；有限工具模式可以独立使用与验收。

## 工作树与操作边界

主计划原本未跟踪；按本轮明确要求仅追加新执行修订，完整原文副本保存在本批 preexisting，仍不提交该旧文件。其余三份旧未提交文件 hash 原样，四份旧文件都保持未提交。没有生产配置/Gateway/真实索引、真实 API、凭据、OpenClaw 修改、push、ps 或 Host 整树扫描。现有对话访问授权仅用于本批新合成 Gateway 配置；没有新增安全权限。
