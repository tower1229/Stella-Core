# 默认关闭的Core供给观察（2026-10-29）

基线 `b759d82504ac59d095d9bb6393ce11e9556c12ac`。此片只增加实际Core工具factory、before-tool hook、execute及grant退休出口的诊断元数据，不包装或替换Host的registerTool，不增加身份、来源许可、writer或CAS。当前状态见[唯一索引](../../../PROJECT-STATE.yaml)，结果及原始hash见[机器摘要](verification-summary.json)。 O1闭合和独立原件hash见[独审摘要](independent-review.json)。旧profile、8.2门槛、152和历史receipt不变；consumer锁/复用安装绑定和Host runner尚未实施。

## 启用与失败边界

复用公开 `openclaw/plugin-sdk/diagnostic-flags`，注册时读取现有 `diagnostics.flags` 或进程级 `OPENCLAW_DIAGNOSTICS`，具体flag为 `stella.core.observe`。未启用时不分配observer/盐、不产生观察行；SDK的显式all/wildcard也可启用，`OPENCLAW_DIAGNOSTICS=0`覆盖配置关闭。输出使用现有 `api.logger.debug`，实际收集需允许debug日志。没有新配置schema、文件路径参数、文件writer、RPC或持久权限。本片不更改主实例设置。

每行前缀为 `Stella checkpoint observation: `，schema为 `stella.checkpoint-observation/v1`，附随机observerId和观察序号。配置、投影或日志同步异常只丢弃观察；错误的异步sink拒绝也被隔离，不等待日志完成。业务授权、写入、返回及退休继续原流程。未来collector必须拒绝缺行/缺字段或无法关联的证据，不能把业务成功当作日志齐备。

## 白名单及来源

| source | 仅记录的事实 |
| --- | --- |
| factory | 固定工具名、数字factoryLabel、agent/session/sessionKey/requester标签及真实owner布尔或null。没有runId、callId、signal或audience对象。 |
| before_tool_call | 同一组标签；requester仅来自hook的requester字段，不从factory补足；实际hook run/call标签、abortSignal是否存在及当时aborted值。 |
| execute | 固定工具名、当前factory闭包的factoryLabel、execute第一参数的call标签及其实际signal形状。没有捏造factory.runId、复制hook owner或输出工具参数/结果。 |
| retirement | 实际grant的run标签、变更前grant/permit数量和active/实际移除标志，以及变更后的真实scope计数。 |

没有序列化完整context、opaque memoryAudience、工具参数、原话、文档、引用对象、路径、token、grant正文或日志异常消息。缺少字段记录null/不存在，不冒充false或借owner/session推导。标签从不传入业务授权、查找grant、调用writer或CAS。

session/requester等身份标签使用观察实例私有随机盐的HMAC，只供同实例比较。Host run/tool-call标识则用公开observer nonce复算，避免原候选私有盐使控制器无法按真实Host runId查退休行的问题：

```text
SHA256(UTF8(JSON.stringify([
  "stella.host-observation/v1", observerId, "run"或"call", 实际Host标识
])))
```

`checkpointHostObservationTag`提供该纯算法。缺少标识返回null；错误observer/run或跨domain不匹配。公开nonce不是秘密或访问凭据，标签也不认证任何身份；必须先有独立的真实Host标识观察。没有跨注册实例的身份标签稳定性保证，不把这些标签当作匿名化或授权机制。

## 退休计数的精确含义

来源是当前Core `retire(grant)`已执行active=false、缓存清除、permit删除及对应grant移除后的状态；不是C5的自建表或agent.wait。只有发生实际grant/permit状态变化才写行；重复/未知run不伪造零余量事件。

`countScope=config-and-host-state-supply-scope`表示由配置与Host state目录选中的真实供给scope，可包含多个run，也可能由同配置的注册共享。`after.grants`为grant表大小，`activeGrants`仅计active标志为真的grant，`preparations`为准备表大小，`toolPermits`为待消费permit表大小。它们不是全Gateway计数，不包含保留的run重放账本，也不是SDK数据库/线程drain回执。退休行可以正确地出现2→1，不能把所有退休都当作remaining=0。

## 验证与尚未验收

纯合成Git/固定结构响应测试覆盖默认关闭、显式启用/覆盖关闭、字段来源/缺失、不可读取未知context字段、正文/参数不泄露、外部run/call复算、真实注册工具、2→1→0退休计数、重复run及旧permit拒绝、标签不能充当permit，以及同步throw/异步reject日志故障。日志故障测试分别核对只读重试的纠正推断不增加、Git HEAD不变，并允许且显式检查既有来源判断再次调用；不能把所有辅助调用数不变当作业务契约。

原断连运行已从原日志恢复终态：169项中166通过、3失败（两个新故障用例的过强总调用计数断言及父组），exit1，受控group gone/owned complete/root removed；没有盲目重跑或猜杀。原日志/hash保留为历史。关联算法和测试断言修改后须以最终候选重新验证，结果单列，不重标原失败。

本片没有启动Gateway、真实模型、token/配对或安装依赖，没有修改主配置/真实grant，也未处理旧EPERM现场。真实Host观察消费、完整capture/runner、包/consumer锁口径及原正式验收仍未完成。SDK active-leases/晚关闭告警如实记录，不能由本片推断已解决。

最终候选已重新typecheck/测试编译，并通过现有监督入口验证两个相关供给文件：169/169，0失败/取消/跳过；新增6个顶层观察用例及2个日志故障子例包含在169内，不另行累加。监督exit0/group confirmedGone/owned complete/pending0/root removed。这是原169候选的作者离线验证历史，后续独审及O1闭合见下文；原失败日志与结果不变。

## O1：aborted元数据类型修正

上段169项是原候选的历史结果。独审也通过169项，但额外7个纯观察探针中5通过、2失败，发现同一P2：畸形signal的aborted字符串/对象被带入日志，可能调用toJSON泄露合成正文。原独审摘要SHA-256为 `bb41ed0a608b954d6bf7df68efa242db0eadaf82d1cec7778b82465d7fd173c4`。这是合成运行时形状反例，不是已证明真实Host泄露或授权绕过；原缺陷和失败结果保留，不据169通过宣称边界完整。

本轮只把aborted getter读取一次到unknown变量，随后仅保留boolean或null，不转换值，不序列化对象。新增hook/execute各自的字符串、对象（含toJSON）、false、true共8个子例，检查getter恰读一次、toJSON调用0及原始标记不进入日志。修前该新组9项中4通过/5失败（4个畸形值子例＋父组）；红例日志及旧helper/test hash单列。供给入口、关联算法、授权/writer/CAS及返回没有改变。修后最终结果与冻结hash见机器摘要；真实Host/capture/consumer绑定仍未接；同一独审已复验O1闭合，保存范围仍限本离线观察切片。

O1修后最终候选重新typecheck/测试编译，并通过同监督入口178/178（原169＋新增8子例及父组），0失败/取消/跳过；含16父组、162叶子断言，不与作者/独审/额外重放相加。Getter单次读取、toJSON调用0已逐source检查。监督exit0/group gone/owned complete/pending0/root removed。此178项作者结果与独审178项分层记录，不相加。

## 独审闭合与保存范围

同一独审在固定基线独立副本重编译后通过178/178（16父组、162叶子），原7个纯观察探针逐字重放7/7；两项原失败现在通过，getter恰读一次、toJSON调用0。7个探针不另加到178，原169和红例保持原身份。独审源摘要SHA-256为 `bb60b7e3411c237e04e5ddf15f107ab2602506c526946c74a9ffef59440c2ca6`，本仓库保存的是单独计算自身hash的非敏感派生摘要，不冒充原件字节。

本次保存只归档独审并更新唯一状态索引；三个实现/测试文件保持独审冻结hash，没有重跑刚完成的验证。作者和独审均记录81条active-leases/51条晚关闭警告；受控进程结束和专属root清理不证明SDK drain，旧EPERM现场不动。Host/capture、包消费者观察与consumer锁绑定、runner/CLI、完整consumer/152/full_memory及真实模型仍未验收；完整gate不变。此文档为提交前状态快照，实际提交与远端版本以Git核对为准。
