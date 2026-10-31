# 单请求来源适配：合成离线薄片

2026-10-31。接续[来源设计](2026-10-31-current-author-source-adapter.md)的独审条件，仅实现离线合同；原设计、原报告及第五次 Host 结果保持原字节。代码为 [offline-author-source-request.ts](../../src/openclaw/offline-author-source-request.ts)，定向用例为 [offline-author-source-request.test.ts](../../tests/offline-author-source-request.test.ts)，冻结与实测摘要见[交付证据](../../.task-control/reports/CORE-VAL-001/offline-source-adapter-20261031.json)。没有正式插件接线或真实来源适配器。

## 本轮实施合同

- **被动采集与资格判定分开。** `observe` 只复制最小请求事实、保存公开 recorder 引用/取消 signal，不调用 recorder 的任何方法，不等待提交。首次 `candidate` 同步调用只读 `hasPersisted/isBlocked/getAdmissionReceipt/getPersistedMessage`，在所有资格判断的 await 之前形成快照。dispatch 尚未提交、首次调用前已提交可以进入离线资格判断；首次调用仍未提交或 blocked 则拒绝。没有 persist/stage/mark/setAdmissionHandler 调用，也不接管 dispatch。
- **资格从可信端口来。** 复用既有 `AuthorIntentPorts.assertRequest/assertSources/currentSourceVersion/verifyAuthor`。本片另需一个最小 `resolveSource(CommittedSourceInput)` 交接回调，将当前已提交输入关联到来源；这正是生产环境尚缺的接缝，本轮只有合成夹具实现。它不能来自模型参数。测试的作者/原文/映射证明独立保存在合成夹具中，不通过回显工具参数产生。
- **四种身份分别核对。** Request 保存 runId 与客户端 idempotencyKey；native receipt 保存 entry/logicalTurn/generation/序列及自身 idempotencyKey；Source.version 单独校验。已提交 message 的原生键须与 receipt 一致。来源回调的 request 和完整 admission 必须与实际快照一致。call 的 event/context 必须一致，且 factory 的 agent/session/requester 和 execute call ID 对应此请求。客户端键、runId、文本 hash 均不代替 native admission。
- **不支持的歧义明确拒绝。** 一个对象仅持有一个请求；相同观察幂等，变更请求或换 recorder/signal 使该对象失败。引用相同只用于排除歧义，不签发作者资格。不做 session→latest 或全局身份索引。call ID 在此请求中只能使用一次，总量上限 32；同时进行首次资格判断的第二个调用拒绝。一个 run 注入新 admission 而无法证明 call 对应哪个输入时拒绝。
- **runContext 仅运输小引用。** 可选 transport 只写 runId/admissionHash；没有读取、恢复或签发许可接口，set 未接受则明确失败。关闭/取消清除对象内绑定。新实例、新用户请求均不能读取旧对象资格。
- **沿用 D-058。** 首次供给核对当前 Source 版本/用途；同一已合法入场请求的工具续轮复用该来源快照，不重新读取来源版本实施即时撤回。下一用户请求重新检查。receipt/admission 的变更属于请求身份冲突，仍拒绝。正常取消和调用活性 guard 保留。
- **发布始终关闭。** 返回值只能是 candidate / semantic_adoption_unavailable，publisherBound 恒 false；没有 publish、writer 或语义采纳入口。只使用 read_current 资格动作。发布 CAS 仍由既有 writer 独立负责，本轮没有模拟或重跑 CAS，更没有将它算作新通过。先前单资产/CAS 证据保留原身份。

## 实际验证

直接 TypeScript 编译整个测试工程到任务专属临时目录，exit 0。随后一次定向运行新增 12 组和原有候选工具 5 项，共 **17/17 pass，0 fail/cancel/skip/todo**。无全量测试、Host 第六次、真实模型或语义评测。

| 组 | 实际覆盖 |
| --- | --- |
| T1 | 精确合成 request/admission/source/call；独立四种身份；只返回候选；被动采集零读取 |
| T2 | 无观察/无可信来源回调结果时拒绝；prompt/history 形状不能补来源 |
| T3 | dispatch 未提交→首次调用前提交可用；首次仍未提交、blocked、缺 receipt/message 拒绝；提交/handler 方法零调用 |
| T4 | owner、external_user、伪当前 ID、缺映射版本、无作者证明均不产生作者资格 |
| T5 | event/context/factory 的 run/call/session/requester、客户端键/原生键错配；已消费 call 重绑、容量上限拒绝；同 session 不取最新资格 |
| T6 | 重复观察幂等；换请求/recorder、变 admission 拒绝；同文本新请求独立重新检查 |
| T7 | 模型参数携带 owner/confirmation/source/原话拒绝；第三方、assistant、internal、inter-session 拒绝作为作者来源 |
| T8 | BOM/NFC/trim/改写、附件/投影、异步资格期间输入变更拒绝；不声称真实转换无损 |
| T9 | 首次及新请求的来源版本、locator、用途拒绝；已合法供给后的同请求续轮不实施即时撤回；无发布出口（CAS 未执行） |
| T10 | 取消、资格期间取消、失活 guard、transport set=false、关闭/重建对象无资格；未知/失败不自动恢复 |
| T11 | 并发首次判断拒绝；同请求模型工具续轮可用；同 run 新输入造成的 admission 歧义拒绝 |
| T12 | 即使文本形似确认，也只返回缺语义证据的候选；固定夹具不证明理解 |

历史首轮 12 组为 10 pass/2 fail：测试 helper 在 bindCall 阶段同步抛错，与 assert.rejects 用法不匹配；修正包装器后原 12/12 通过。该红例不是已证明的产品安全缺陷。后续补充已消费 call 重绑/歧义拒绝、独立合成来源证明、locator/键/guard/容量负例，最后定向组合 17/17。原失败回执与源 hash 保留，不与最终通过累加。

## 交接边界

本轮没有提供真实 authorId/sender 映射，没有证明真实入口/recorder 生命周期、原文与 NFC/trim/附件投影的关系或真实 call→admission 关联。代码没有 import OpenClaw runtime、注册 hook、改正式工具/权限、调用真实 writer；运行时代码仅依赖现有纯结构/摘要模块，类型端口导入被编译擦除。真实接线继续阻塞，不能因为离线合成端口通过而开启 publisher。

下一步先独审这两份代码及限定合同。接着才选择一个已有私人入站入口，证明来源生产和只读 recorder 生命周期；如无公开保证，报告缺失能力并保持候选。真实输入、任何额外 Host 次数或模型调用需各自已有授权，当前追加 Host 批次仍 3/3 耗尽。第四次历史 unknown 和所有五次旧 claim/result 保留。没有提交、推送或依赖安装。

## R1：独审反例修订，待复审

前述原 17/17 保留为作者初版测试记录。随后独审仍要求修改：原 17/17 复验通过，但另 5 个纯合成检查中有 **4 个异常接受、1 个副本隔离对照正常**；不能据初版 17/17 声称该候选通过独审。独审原始摘要 SHA-256 为 `1a868d32ed816e961c8642077a617a958ccca1316d09de4be4f01817bd5f8588`。版本/红绿与精确修订 diff 见 [R1 证据](../../.task-control/reports/CORE-VAL-001/offline-source-adapter-r1-20261031.json)。

本轮只修两处：

1. 每次 `candidate` 调用在等待前固定 factory 的四项身份快照及原 `assertInvocationCurrent` 函数。调用原函数时保留方法 receiver，返回前再次调用同一个函数，并比对当前身份与快照；不从可能被替换的 guard 属性重新获取授权。等待期间改变 requester/session 导致本次供给拒绝；原 guard 已失效时，替换为空函数不能绕过它。
2. 已观察到准入后的 native input 冲突或失去可验证状态时，关闭整个单请求绑定并清除缓存，恢复旧 recorder 也不能复活。普通参数错误、首次尚未提交不会因而毒化请求；合法同请求工具续轮继续使用已合法入场的来源快照。这是 admission 身份边界，不增加来源/政策的即时撤回。

确定性屏障回归先在未修代码上复现：来源模块共 17 组中 13 pass/4 fail（原 12 组＋5 个新检查）；4 个失败分别是 requester 变更、session 变更、替换失效 guard、冲突后恢复旧 admission，副本隔离对照通过。修后定向组合 **22/22 pass（来源 17 组＋原候选工具 5 项），0 fail/cancel/skip/todo**，直接 TypeScript 编译 exit 0。新回归还检查原 guard 未失效但被替换时，调用原函数两次、替代函数零次，以及普通参数/首次未提交可恢复。修前失败、独审失败与修后通过分别记录，不累加成新验收。

T3 提交时序、T9 首次/新请求而非即时撤回、T12 缺语义证据仍候选的边界保持。真实入口、原文转换、作者映射与 recorder 生命周期仍未验；publisher off，无 Host/模型/网络/监听器/发布 CAS。此修订尚待独审，未提交推送。
