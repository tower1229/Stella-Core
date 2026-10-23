# 肃清第八批：真实原生 Agent 闭环与撤权边界

基线 `f7b0cf9d4d69bca88732515ff1ae3df2b4dc3e62`，分支 `codex/issue23-integrated-regression`。本批本地提交、逐文件身份、编译目录清单与原始证据见 `.artifacts/suqing-batch8-20261023/delivery.json`。没有安装包、推送或生产部署。

## 核心结论

真实本机 OpenClaw `2026.8.2` Gateway 的原生 Google Agent 已完成 **Agent → stella_memory_data list → 模型续轮 → read → 模型续轮 → 回答**。模型侧是 loopback fake Google provider，3 个原始请求包含实际工具回传；这是 Host/传输/工具消费验证，不是 Gemini 真实服务或语义质量验收。

**动态撤权仍有明确失败，full_memory 保持阻断。** 在 Core 已返回列表、Host 的公开同步 `tool_result_persist` 阶段将合成 policy 的 readPurposes 清空后，后续 2 次真实 provider 请求仍携带已释放的预览。Core 拒绝新的原文返回，公开 `reply_payload_sending` 返回 cancel；但 WebChat 的 delta/final 已含生成答复，Host history 也保存了答复。公开投递 hook 取消不等于所有用户可见输出被取消。

最终 Core 编译候选 `compiled-a6`：typecheck、编译、**109/109 定向测试 + 3/3 legacy 注册检查**通过，无 skipped/cancelled。6 项最终真实隔离探针中，5 项满足下表的有限断言，撤权项保持失败。不能把这些结果宣称为 full_memory 或所有 Host 入口通过。

## 实现与已授权权限

用户于 2026-10-23 00:57:56 UTC 明确允许仅在新合成 Gateway 配置设置 `plugins.entries.stella-core.hooks.allowConversationAccess=true`。本批仅如此设置，全部 workspace/state/session/cache/provider 均隔离且合成；未改生产配置、真实会话或其他安全权限。沿用公开 `XDG_CACHE_HOME`，原文件/网络沙箱与 ps 禁止规则保持不变。

通过已认证的合成 Gateway 客户端执行公开 `sessions.reset {key, reason: new}`，首次建立 row 后返回真实 sessionId/lifecycleRevision。Core 仍只读 Host session，不捏造身份、不在 hook 内偷偷 reset，也不把 reset 命令发出视为恢复完成。

真实 a3 证明同一进程两次注册插件：reply_dispatch 与 before_agent_run 分别来自不同 registrationId。所有可见 run/session/owner/空历史字段一致，但局部 Map 中的 grant 在后一实例不存在；未放宽空历史或身份检查。

最小 Core 修复使用公开 `openclaw/plugin-sdk/runtime-store`：

- SDK 的命名进程内 slot 仅按精确解析配置与 Host state directory 共享 Core 已签发的 grants、nonce/call permits 和运行/物理会话占位；不会从后续观测重签资格或更新 expected。
- grant 保留原 ingress、原 runtime、原 recovery expected、原 resolver 和取消源。不同配置/状态路径不混用；不同 run/session 仍严格拒绝。
- 任一共享注册关闭会 abort 整个旧 scope，并关闭供给与投递。删除时比较 scope 身份，迟到旧 close 不删除替代 scope。此行为保守拒绝，可能牺牲重载时的可用性；不宣称无损热重载。
- 未启用 fresh_tools 的维护路径不新增 runtime.state 依赖，默认 legacy 与 restricted maintenance 行为保持原边界。

实际来源修改反例还发现：首次工具读取失败、尚无 released 依赖时，原投递校验可能允许一个普通错误答复。现 assertGrant/original 的来源、权限、版本、取消失败会关闭该 grant 的供给与投递；严格参数错误仍在原参数校验拒绝。新增首次来源失败和双注册/跨配置/关闭反例，独立只读复核未发现本次剩余实质缺陷。

## 同一编译身份的真实结果

| 最终尝试 | 场景与观察 | provider 请求 | 有限结论 |
| --- | --- | --- | --- |
| a11 | 正常 list/read/回答；实际工具参数与结果、3 份模型输入均保留 | 3 | 原生 Host Agent 工具闭环通过 |
| a12 | list 已返回 Host，在公开同步持久化观察点调用公开 SDK abortAgentHarnessRun，返回 true | 1，取消后 0 | 本场景实际 Host 取消后无模型续轮；不泛化全部取消源 |
| a13 | 首个模型请求后、list 读取前修改合成 payload；工具开始但没有成功正文结果 | 2 | 无旧来源标记进入续轮，公开投递 hook 取消；Host 仍用 1 次模型调用处理工具错误 |
| a14 | 首个请求后由 Core archiveLocal 真实提交 Git A→B，并通过原 checkpoint CAS | 2 | 旧 A grant 不采用 B，工具未执行/无正文，公开投递 hook 取消；不声称模型零错误续轮 |
| a15 | 已用物理 session 的第二个 run 被拒绝，新增模型请求 0；另一 session key 建立不同物理 session 并完成新的闭环 | 6（两个正常运行） | 新物理会话首个请求无旧预览/旧答复，旧物理会话不能复用；不是任意旧 history/compaction 清洗证明 |
| a17 | list 返回后、下次 provider 请求前同步清空 policy.readPurposes | 3，撤权后 2 | 旧 preview 仍在两份续轮输入；新的 read 开始后失败且未返回原文；公开 hook cancel，WebChat 与 history 仍有答复。严格撤权断言失败 |

撤权 a17 的事件顺序已从同一 public-events.jsonl 核对：tool_result → tool_result_persist/fault_boundary_complete → provider_request 2 → provider_request 3。两次续轮记录均为 faultAlreadyApplied=true、sourceMarker=true。第三次请求包含 list preview 和 `locator_digest_mismatch` 的 read 错误，没有第二个成功正文结果。最终失败消息明确为 `post-release zero-continuation guarantee not met`，探针 passed=false、启动日志 exitCode=1 均保留。

这里的撤权是**真实发生在合成来源工作树的 policy 编辑**，未发布为新的 policy/CAS generation。Core 的旧 frozen authority 因依赖字节变化而拒绝。不能把本场景冒称“新许可 B 已完成迁移/应用”；真实 Git/CAS 前进另由 a14 验证。

## 原始失败、oracle 与证据身份

本批没有绕过拒绝。a1 建立 session 后因双注册 grant 不共享拒绝；a2 诊断代码出现 optional logger 类型错误，probe 在 Gateway 创建前因缺 compiled 目录退出，已确认自有 PID 退出后清理其 owner；a3 的布尔与 registrationId 证据定位根因。a4 首次正常 Host 闭环通过，但并行单测暴露未启用模式新增了不必要 state 依赖，最终已修复。

a6/a10 原使用 after_tool_call 注入取消/撤权，回调到达时第 2 个模型请求已开始，时间窗前置断言失败，实际故障未施加；不能拿它们证明取消或撤权成败。改用公开同步 tool_result_persist，仅观察消息并施加合成故障，返回 undefined，不改写/伪造 Host 消息、工具结果或 Core grant。

a7 最初把“工具 execute 开始”误当作“成功正文释放”，同时发现首次来源失败未关闭投递；门禁与 oracle 均已修正。a16 已抓到旧预览续发，但先被同类 execute 数量断言拦下。最终仅将该断言改为成功 tool_result 数量，a17 重验受影响的撤权项；未放宽零旧预览续发断言，结果仍失败。

最终 109+3 验证对应 verification-a6。之后 Core 源码、测试、编译目录均未改变；只有探针的一项计数 oracle 修正，node --check 通过，并仅重跑该撤权场景。`harness-oracle-correction.json` 保存前后 SHA；每次 host-launch 都保存实际 harness SHA。正常/取消/来源/CAS/history 使用先前 harness SHA，a17 使用修正版；实际 Core 编译身份相同，不复用旧 Core 包的通过结果。

最终矩阵为 `final-matrix.json`，它读取真实 host-launch.exitCode，修正早期 driver 将 Python launcher 自身退出码误命名为 launchExitCode 的歧义，原始摘要未覆盖。每个原始 result、provider-N.json、public-events、Gateway log、命令和时间均保留在本批 artifacts；完整安装 Host 树身份仍未验证，公共元数据版本不冒充源码全树证明。

## 本批出口及下一最小目标

SQ-08 的真实原生 Host 只读工具通路已可达；SQ-09 增加同编译身份真实输入、取消、source/CAS、history 和失败撤权证据。SQ-06 其他业务 writer、SQ-07 refresh/index/wiki、其他 harness/compaction/长期会话入口未据此完成。没有开启关闭中的记忆入口或 full_memory。

下一批只聚焦已复现的两个边界：**工具交付后的每次模型输入/派发控制，以及 WebChat 流式/最终事件与历史持久化控制**。先核对一个原版 Host 公开控制点能否真正覆盖这些路径；若只能观察或存在窗口，明确限制该模式，不靠 polling/事后 abort 声称零泄露，也不扩大为整个插件不可用。任何更改安全目标或新增权限须明确决策；本批不自行降低撤权要求、不改 Host。

正常闭环可以作为隔离候选证据，不能据此建议生产开启。所有本轮登记的 Gateway/测试子进程已经结束，owner 记录移除；四份前期未提交文件哈希保持不变。全部新增产物在非 iCloud 项目目录。无真实凭据、真实 API、生产 Gateway/config/index、OpenClaw 修改、ps/Host 全树扫描或 push。
