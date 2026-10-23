# 肃清第九批：逐请求、WebChat 与历史控制边界

基线 `911b2b9dafa7684b701b8eaaac01699b33472941`，分支 `codex/issue23-integrated-regression`。最终提交、Core 编译清单、命令/退出码、原始 provider 请求和时序见 `.artifacts/suqing-batch9-20261023/delivery.json`。全部仅本地合成验证，无安装包、推送或生产部署。

## 结果与范围

**已修复一项有限缺口：Core 已知 grant 失效后，可以同步阻止 assistant 消息追加到 Host 历史。** 真实工具交付后撤权场景中，答复不再出现在 chat.history；正常原生 Agent → list → read → 回答仍通过。

**当前 OpenClaw 2026.8.2 的固定 Google provider＋现有 hooks 模式仍不满足完整撤权要求。** 工具交付后撤权，后续两份 provider 请求仍含旧 preview，WebChat delta/final 仍有答复。请求已发送后再撤权，Core 尚未检测失效时，返回的答复仍进入 WebChat 和历史。full_memory 保持阻断；不把历史部分修复写成流式输出受控。

最终 verification-a2：typecheck、编译、**110/110 定向测试 + 3/3 legacy 注册检查**通过，无 skipped/cancelled。同一 Core 编译身份 `compiled-a2` 完成正常和下述 a/b/c 真实 Host 探针，a 与正常达到有限断言，b/c 严格目标保留失败。模型仅 loopback fake Google 协议端点，不是 Gemini 真实服务或语义质量验收。

## 公开能力矩阵

完整机器可读表为 `capability-matrix.json`；只读取点名公共契约和相关实现，不递归扫描安装树。

| 公开接缝 | 已证时机／返回能力 | 能否承担本问题的门禁 |
| --- | --- | --- |
| before_agent_run | 原生 Agent attempt 准入；async pass/block | 能拒绝初始运行；未证明覆盖每次工具续轮 HTTP |
| agent_turn_prepare / before_prompt_build | prompt 准备；async prepend/append/toolsAllow 等 | 没有逐请求 veto 契约；不能把准备阶段当成所有续轮 |
| model_call_started/ended | 每次模型调用的观察元数据；Promise<void>/void | 无输入替换或 veto；默认失败继续，不能靠抛错阻断 |
| llm_input | 生产者发出 Promise 后 catch/log，不等待 | 仅观察，不作授权回执或派发屏障 |
| ContextEngine.assemble | async 生成 messages；逐工具续轮 HTTP 覆盖未证 | 普通异常会 quarantine 后 fallback legacy；explicit abort 例外不等于可任意 throw 作资格门禁 |
| before_tool_call + Core execute | 每次新工具正文返回前可 async 复核与拒绝 | 可以阻止新正文；不能撤回已经返回 Host live context 的内容 |
| tool_result_persist | 同步 rewrite 工具持久化消息，无 block | 后于工具返回；不等于阻止实际模型续轮或清除 live context |
| before_message_write | 同步 `{block:true}` 阻止本次 transcript append | 能阻已知失效后的写入；Promise 被忽略、异常默认忽略，不能在此等待现有异步源复核 |
| before_agent_reply | 前置 async handled/reply 请求接管 | 不是生成后的 delta 审核；错误/超时默认继续 |
| reply_payload_sending | async 改写/取消规范化投递 payload | 不覆盖直接来自 Agent events 的 WebChat delta/final |
| Agent event subscription | sanitized 事件观察；void/Promise<void> | 无 veto；缓冲订阅副本不会阻止 Host 广播原事件 |
| 所选 provider.wrapStreamFn | 可返回 async StreamFn，在委托 ctx.streamFn 前等待检查 | 是可研究候选，非当前 Google 全局中间件；需要显式不同 provider 与可信运行绑定设计，缓冲输出也非自动保证 |

公开 provider 注册拒绝重复 id，不能注册第二个 google 偷加装饰器。ProviderWrapStreamFnContext 有 agentId/modelId/streamFn，但没有 runId/physical session/attempt authority；options.sessionId 本身不是 Core grant。新方案不能从模型载荷或后续观测自签资格，也不能恢复旧 opaque Host 覆层。

## 已证调用顺序

固定 Host 实现的关键顺序：

1. reply_dispatch 绑定 owner/direct/真实 session 与 frozen Core grant；原生 prompt 准备和 before_agent_run 后进入模型。
2. Core 工具返回 → tool_result_persist → before_message_write → transcript append。persist hook 的 rewrite/block append 不会自动修改已交付到 live Agent 的全部上下文。
3. native assistant event 直接进入 server-chat 的 emitChatDelta；终态从已有文本 buffer 构造 chat final，经 broadcast/nodeSend 发送。这条链不经过 reply_payload_sending。
4. 普通 assistant transcript append 前也有 before_message_write。原生 Agent 输出和持久化/外层 payload 投递是不同出口；不能用其中一个 cancel 推断其他出口已阻断。

证据定位：`session-tool-result-guard-wrapper-DBRM15Xs.js:474–501`、`server-chat-DZFFhPUJ.js:596–643,945–951`、`hook-helpers-B4NmqFRB.js:35–49`。模型观察契约见 `hook-runner-global-y5_IazVW.d.ts:694–719,1438–1439`；ContextEngine 异常回退见 `registry-DZVfRgG8.js:188–205`；provider wrapper 与重复 id 见 `agent-harness-runtime-DMcVlRu_.d.ts:9358–9437`、`loader-DhyKX__3.js:3419–3422`。这些点名文件的 hash 见 `named-public-evidence.json`，不是全安装树原版认证。

## 最小修复及诚实限制

Core 在 fresh_tools 下注册**同步** before_message_write，只处理目标 assistant。要求 agent/sessionKey 一致、恰有一个已准入 grant，且该 grant active/deliveryOpen、未关闭或取消；缺失、冲突、歧义及已识别目标的同步异常返回 block。非目标 Agent 和 user/tool 消息不受本次写入门禁改写。没有改 Host 源码、provider 选择、正常工具循环或默认 legacy。

该公开 hook 没有 runId/sessionId，因此门禁只使用已有 Core scope，不能补造当前运行身份。多个已准入 grant 对同一逻辑 key 造成歧义时保守拒绝，可能影响可用性。本期不承诺逻辑 key 无损重用。

此门禁不执行异步来源复核：它只落实**已经由 Core 读取/权限/版本/取消检查发现的失效**。如果尚未发现变化，它可能允许写入；c 场景明确证实该限制。若持久化前重查本来就需要异步 I/O，不能把 Promise 塞进同步 hook 假装已覆盖。

探针原来统一 async 包装 on 回调，本批改为保留 handler 的原同步或 Promise 返回形态，否则 before_message_write 会被 Host 忽略。真实正常与 b 场景已验证同步返回实际生效。新增合成单测覆盖准入前拒绝、正常允许、非目标/user 保留、缺失/冲突 scope、来源失效后拒绝。

## 同版本真实 a/b/c 证据

| 类别／尝试 | 故障位置与完整请求 | WebChat 与历史 | 结论 |
| --- | --- | --- | --- |
| 正常 a1 | 3 次请求；list/read 原文与最终答复 | 正常答复在历史，原生链路保持 | 正常闭环通过 |
| a：a2 revoke_before_list | 第一请求后、list 读取前清空合成 policy.readPurposes；0 个成功工具结果；1 次后续错误处理请求不含旧 preview/正文 | 已知失效后同步阻止 1 次 assistant 写入；无来源答复标记 | 读取前拒绝通过；不声称模型零错误续轮或所有输出静默 |
| b：a3 revoke_after_list | tool_result_persist 阶段清空 policy；事件顺序证明之后 2 份请求仍含旧 preview；后续 read 没有成功正文 | WebChat delta/final 有答复；新增 gate 阻止 1 次写入，chat.history 无该最终答复 | 旧 preview 零续发与流式输出目标失败；历史部分修复通过 |
| c：a5 revoke_after_sent | 第 2 份请求已完整到达 fake provider 后、响应返回前清空 policy；该请求此前已合法含 preview；本例变化后新请求数 0 | Core 尚未 latch 失效，写入门禁没有 block；WebChat delta/final 与 history 均有答复；外层 payload 稍后 cancel | 不承诺撤回已发送请求；返回输出的失效阻断仍失败 |

所有故障均为合成来源工作树 policy 编辑，尚未发布新许可/CAS generation；不冒称政策 B 已迁移应用。a/b/c 的完整 provider-N.json、public-events.jsonl、Gateway 日志与 result.json 均保留。`final-matrix.json` 区分 c 的“已发送请求”与变化后新请求；原字段 nextModelRequests/staleMarkerInNextRequests 在 c 包含已发送的第 2 请求，不能拿它声称变化后新发泄露。

初次 typecheck 的单测 instanceof 收窄错误已修正，verification-a1 失败原件保留。c 初次 a4 被误放进“读取前不能含 preview”的响应分支，前置断言失败，不能作正确 c 验收。只修正该场景路由，node --check 通过，以未改变的 Core compiled-a2 单独重跑 a5。`harness-scenario-correction.json` 与每个 host-launch 保存前后 harness SHA；其余已通过或已明确失败场景未重跑充数。Core/单测源码在最终 110+3 验证后未改变。

## 需要明确的产品／部署选择

当前固定 Google＋hooks 模式的严格 b 目标 NO-GO，不等于所有纯插件方案不可能。没有发现可直接安装到现有 google provider 的公开逐请求和全输出控制层，因此本批不继续堆 hook 或宣称订阅缓冲有效。

| 选项 | 保留与变化 | 待证明／代价 |
| --- | --- | --- |
| 保持现有目标 | 原生 google/gemini-3.8-flash 与逐 token WebChat；保留读取前门禁、已知失效历史 gate | b/c 目标不满足，full_memory 继续阻断；不能未经决定把安全要求降成下一 turn 生效 |
| **建议：显式受控 provider 的隔离原型** | 使用公开 provider wrapper 委托 Host transport，目标仍是 Host Agent→数据工具→续轮；显式另选 provider 标识，底层 Gemini 3.8 不降级；在 Core 边界缓存响应，复核后才向 Host 释放 | 先证明 run/session/attempt→原 frozen grant 的可信绑定、每次续轮/重试均经过包装、取消与错误流语义、API/payload 兼容；逐 token 直播变为受验证后释放，有延迟/内存代价。并未实现或验收 |
| Core 受控请求与输出入口（储备） | 可研究通过公开 Host Agent 执行保持工具循环，由 Core 缓冲/复核再发布；不能退成无工具 completion | 必须先证明原生 event/持久化确实被隔离；仅 reply handled 或复制事件无效。范围比单 provider 包装更大，当前未证可行，不并行实施 |

需要的决定是：**是否接受显式受控 provider 选择与缓冲输出的交互变化，进入仅合成资料/假凭据的有界原型？** 这不是已获批准的 conversation-access 权限之外自动加权，也不包含生产配置、真实凭据或 API。若坚持当前 Google provider 标识和原生直播目标，则应如实保留这两项未满足保证，而非修改产品安全语义凑验收。

下一批若选受控 provider，只冻结一个最小运行绑定与一个正常/一个 b/一个 c 出口，先证明可以复用 Host 工具循环和阻断旧输入/迟到输出，再扩展其他矩阵；失败就返回准确缺口。不恢复旧 Host 覆层、私有 patch、原 Gemini 凭据转换或全树 hash。

本批只推进 SQ-08/09 的能力边界及有限历史修复，未将 SQ-06/07、其他 harness/compaction、full_memory 标为完成。全部登记进程结束，owner 移除；四份旧未提交文件 hash 不变。无真实 API/凭据、生产变更、OpenClaw 修改、ps、Host 全树扫描、iCloud 写入或 push；无审批拒绝或执行服务阻塞。
