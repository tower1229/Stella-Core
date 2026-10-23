# 肃清第十三批：同受众连续聊天与每请求当前记忆

基线 `f299b557a9f195526d65292d23abdf26c032140c`，分支 `codex/issue23-integrated-regression`。版本/编译/命令及原始请求见项目本地 `.artifacts/suqing-batch13-20261023/delivery.json`。本批仅合成隔离验证，不部署。

## 当前语义与最小机制

[D-058](DECISIONS.md#d-058--experimental-simplicity-and-user-request-boundaries) 连续会话补充：Host 正常聊天历史保留为过去对话，同 owner 同受众不要求每轮 reset。历史里曾合法出现的旧原文、旧模型回答或旧工具结果，不因此成为当前 Core 事实或当前权限。当前记忆每个新用户请求重新绑定 checkpoint/目的/来源；本轮工具续轮保留已授权供给，正常取消仍生效。不会清洗历史、拦截原生输出或恢复运行中撤权逻辑。

原配置名 `agentMemory: fresh_tools` 为兼容保留，fresh 现在指每用户请求重新准入，而非必须空会话。公开 before_prompt_build 提示模型区分历史与当前记忆；每份工具响应新增 currentMemory.userRequest/checkpointRevision/checkpointToken，防止旧工具结果在证据中被冒算新轮供给。提示词是解释指导，不是隔离保证；fake 模型只能证明请求/工具机制，不证明模型一定不会误引历史。

使用现有公开 session-store-runtime 的 patchSessionEntry/getSessionEntry/readTranscriptStatsSync，在 `SessionEntry.pluginExtensions["stella-core"]["owner-history/v1"]` 保存小型受众绑定，不另建会话数据库。绑定 canonical config/Host store 的摘要、sessionId/lifecycleRevision、授权返回的 providerId、实际 Surface/OriginatingChannel/Provider/account 与 sender。绑定在自动归档之前核对，before_agent_run 再核；同绑定的非空历史可继续。每轮 grant 与原文缓存独立，旧工具资格不会因为历史保留而复活。

首次没有绑定时，仅接受无过去对话的公开 transcript：可以为空，也可只含匹配 session 的 header 与精确当前 owner 输入（正文、runId:user 和 Host owner 标记准确匹配）；意外注入的首次非空 messages 仍拒绝。未知旧历史需一次明确新会话或后续显式迁移，不能默默认领。已有绑定在公开 session store 持久化，注册重开可延续；真实 Gateway 重启不属于本批场景。形状损坏的绑定、不同身份/命名空间/账号、模糊或变化的受众均在归档前拒绝，不先写入错误 owner policy。真正新代次可在无过去对话的会话重新建立绑定。

“同 owner”准确指 Host 认证出的同一 principal，不能把共享 token/共享 cli 别名当成区分多个真人的证明；多用户场景需独立 Host 身份与会话。其他受信插件或 Host 自己维护的历史不在 Core 强隔离证明内。当前入口仍 owner/direct/text/retain-v1，不增加 native read 或其他安全权限。

## 验证

最终 `verification-a4`：typecheck、定向编译、**150/150 项定向测试 + 3/3 项 legacy 检查全部通过**，无失败/取消/跳过。`compiled-a4` 共 138 文件，compiled-manifest.json SHA256 `6d2fc039e03b4bb6d8f5a52f4cbcce57162910d41f64de01110b8cae5d30c08d`。Core package 仍为 0.1.0-alpha.0，未生成安装包。

最终 `host-probe-a4` 使用相同 Core/harness 身份：原版安装 OpenClaw 2026.8.2、原生 Google Agent/tool loop、loopback fake provider。三轮均正常回答，**9 份完整 provider 请求**，没有 reset 或 Gateway 重启：

| 观察点 | 实测 |
| --- | --- |
| 同会话连续 | sessionId `7b44f7f4-9d68-4f79-b95f-d0e2376d51cd` 三轮相同；before_agent_run 历史消息数 **0、6、12**。公开 SDK 读出的 lifecycleRevision 均为 null，未伪造不存在的 revision |
| 第一轮 | 当前 list/read 提供原始 A；随后原回答与工具结果由 Host 正常保留 |
| 源修订后第二/三轮 | 完整 provider 输入仍含历史 A/旧回答，但最新本轮 list/read 仅提供 B `SYNTHETIC_REVISED_PREFERENCE_B_5281`，携带本轮 run/checkpoint；不能把整包出现 A 判成当前工具回送 A |
| 当前 authority | 各轮模型开始的持久 checkpoint 与该轮公开 status 精确一致：`071e2c75d53b416954a82469cb2a12e29ab16b72`, `dc8bccd6c6dd39d93a8ea94c7d7f57c4f227ca60`, `0a5a921ffd5492e55babe597bf964771bdc1b4bd`；token 各轮不同 |
| 写入次数 | 恰好 **3 次真实用户输入自动归档 + 1 次明确源修订夹具 = 4 次提交**。普通输入归档由 chat.send 触发，harness 没有调用 archiveLocal 补写；工具续轮未新增提交 |
| 收尾 | launcher PID 39060 exit 0，Gateway PID 39685 exit 0；fake provider 关闭，合成源清理，workspace/Host 状态及证据保留 |

覆盖包括：同 owner 历史续聊、当前工具版本及 request metadata、注册重开保留受众绑定、owner/account/provider/Surface/OriginatingChannel 更换在归档前拒绝、损坏绑定拒绝、初始 header/当前输入允许而旧 run/旧正文/非 owner/助手/未知 system/额外历史拒绝，以及原事务/CAS、取消、来源、初始化/回退和 legacy 回归。局部独立只读复核未发现新增阻断。

真实创建会话遇到的事实和尝试如实保留：a1 直接给尚无 Host entry 的新 key 发 chat.send，session_unavailable，模型 0；a2 使用幂等 sessions.create，但 token-only 客户端缺 durable principal/device，被 Host 拒绝，公开 SDK 已核对目标未创建；a3 用公开 GatewayClient 的内存合成 Ed25519 device identity 满足身份要求，原 scopes/认证设置不变，客户端不读写设备 token，创建成功，但旧 eventCount==0 规则把 header+当前输入误判旧历史，模型仍 0。a4 根据真实 trace 只认可匹配 session header 和精确当前已接受 owner 输入，历史门禁保持，并完成三轮。没有删除幂等字段、关闭认证或绕过拒绝。

设备私钥只在测试进程内存；新 Gateway 的测试配对状态仅在其项目专用合成 state，不读取/修改系统真实身份。公开创建字段来自本机文档链接的 [gateway-protocol 2026.8.1 schema](https://unpkg.com/@openclaw/gateway-protocol@2026.8.1/protocol.schema.json)，当前 2026.8.2 Host 已实际接受，不用旧协议元数据冒充代码身份。

离线尝试分别记录：a1 只有夹具类型失败、未测试；a2 140/141，唯一失败是重启后夹具错误调用旧工具；a3 143+3 通过，但尚未修正真实初始记录识别。仅 a4 的 150+3 及同构建 Host a4 是最终候选证据，不累加历史通过数。a3 之前的 harness 身份调整有单独记录；最终 a4 的全部具名源码与 harness 哈希均未在验证后改变。


真实探针仅通过 public sessions.create 创建一次正常新会话，不附初始消息/fork/parent，随后三次 chat.send 使用同一返回 key；不调用 sessions.reset，不重启 Gateway。源文件修订是标明的合成夹具，复用生产 transaction/Git/CAS，当前 catalog 从 A 切换到不可变 B 版本，保留旧原始留存及 Git 历史；它不是自动语义 correction writer。每轮输入自动归档仍由真实 Host 触发，不能由 harness 调 archiveLocal 补完成。

每轮三次模型请求：新用户请求 → list → read → 回答。第二/三轮完整 provider 请求应保留过去 A 和旧回答，同时当前本轮 list/read 只提供 B；核对本轮 run/authority 与原 Host historyCount/sessionId/lifecycle。实际旧历史存在必须如实记录，不能通过整包“不含 A”假断言来验收。

## 可用实验模式与完整产品门槛

配置显式 opt-in 的 `core_checkpoint + agentMemory: fresh_tools` 是 `experimental_owner_chat`；需要自动原话留存时加 `requestArchive: local + dataMode: local_write`。authority 仍显式初始化所选 revision，不采用 HEAD。受管 bootstrap/skill 的初始化、用户文件所有权与回退沿第十一批；本批不自动接管旧部署。

status 的模式描述/配置能力不冒充对任意数据和运行的验收收据。实际资格继续由每请求校验、供给状态及错误类别表达。实验模式不再被尚未迁移的全部语义 writer 笼统阻断；fullMemoryBlockers 单列完整契约未完成项，full_memory 仍 false。

| 层级 | 本批边界与出口 | 是否阻断有限实验模式 |
| --- | --- | --- |
| 最小可用闭环 | 同一受众连续聊天、每轮当前 Core 工具、自动 owner 原话归档、Git/CAS、正常取消、用户文件保护 | 必须在固定构建有证据；身份/来源/版本/写入失败仍拒绝 |
| 使用边界 | owner direct、retain-v1、已绑定会话；未知旧历史显式新会话，更多来源/受众模式不静默降级 | 仅限制不支持的目标，不让全部已验证 owner 对话停止 |
| 可延期完善 | 旧部署平滑迁移、更多工具与 source-access 模式、完整 transcript/附件、语义 correction/learning/outcome、长历史 compaction/长期质量 | 不作为本批有限模式的必过前置；未验收部分不算 full_memory 完成 |
| 生产/外部使用 | 真实源与所有权审阅、明确部署/真实 API 授权及目标版本实际验证 | 本轮未授权部署；没有因为实验模式可用而开启生产 |


SQ-06 owner 原话 writer 维持统一 authority；SQ-08 从 fresh/reset 限制推进到已绑定同受众连续会话；SQ-10 按同构建实际工具/输入证据验收。SQ-07 初始化继续复用。后续不再为运行中撤权或历史曾出现的信息即时消失扩展旁线，不在本批重构全部 correction/outcome writer。

## 保留与操作

四份旧未提交文件仍保留；主计划只相关追加，其余三不动。仅项目非 iCloud docs/.artifacts 与合成临时目录，原版 Host/假 provider/合成 hooks 权限沿既有授权；不真实 API、凭据、生产、Host 修改、push、ps 或整树 Host 读取/hash。固定版本、失败尝试、最终进程退出及剩余限制以 delivery 为准。
