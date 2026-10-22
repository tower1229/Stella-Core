# 肃清第五批：完整插件启动与首条业务归档接线

本批基线为 `3e223cb9d23304651eaa10b7ad4b3079d2cf36ba`。最终提交、源码逐文件身份、命令/退出码和隔离编译身份见 `.artifacts/suqing-batch5-20261022/delivery.json`。本批不生成可安装包、不部署，不借用已废弃 Host 覆层或旧版本通过记录。

## 本批结果

最终 a8：全量 typecheck、定向编译通过；**77/77 定向测试 + 3/3 legacy 注册检查**通过，无 skipped/cancelled。77 项包括同产物复验的既有 60 项和新增启动/真实业务接缝测试（含父子测试计数），没有把历史测试数累加为当前通过。

完整 `src/plugin.ts` 经实际安装的 OpenClaw **2026.8.2 SDK** 成功导入，再通过真实插件 entry 的 register 调用合成注册器。导入测试对异步/同步目录枚举设置拒绝陷阱，观察数为 **0**。没有执行或变相绕过被拒的 Host/node_modules 全树读取/hash。注册 API、Host 事件、服务生命周期和 provider 是合成夹具；command-auth、routing、session-store-runtime 使用真实 SDK，session entry 在隔离 SQLite 状态中由公开 upsertSessionEntry 写入，随后实际 getSessionEntry 读取。没有启动真实 Gateway 或调用模型。

第一条实际业务链为：公开 `reply_dispatch` → 真实 SDK owner/direct/session 身份核对 → 同一次 Core manifest/Praxis/catalog binding → 现有 `archiveCorrectionInput` → retain archive writer → 本地 Git B → 原 A/tokenA 精确 CAS → 独立 B 发布校验 → 实际 EpisodeEvidenceResolver 验证原文 → reload/重开状态。不是只调用新 helper 的模拟收据。

该链是**显式 opt-in 的本地输入归档**，不生成回复，不运行 Agent/语义学习，不冒充已同步、最终消费或 full_memory。SQ06 仍未整体完成。

## 公开启动机制与原强身份声明

原 `initialization-verification-binding.ts` 在静态导入时立即递归 hash Core dist 和 Host dist，并在 capture 时再次读取整树及完整配置。它服务于旧强 capability receipt 的 code/artifact/host 绑定；包版本、lockfile integrity 或当前磁盘 hash 都不能冒充已经加载的代码身份，也不能据此搬用覆层收据。

本批删除该 import 副作用及私有配置读取。现有强 capture 明确失败为 `verification_code_identity_unavailable`，没有返回 placeholder digest、伪造成功或降低 full_memory/capability 门禁。旧 stored passed receipt 仍保存，但不能通过当前 capture 再准入。**默认配置和注册表面**与显式 legacy 相同；这不代表旧强验收能力仍然可用。

独立 `public-package-provenance.ts` 只供受信本地诊断显式调用：恰读 Core/Host 的公开 package.json 和可选项目 package-lock.json，不在 import/register 运行。实际元数据与 lock 均声明 OpenClaw 2026.8.2，并记录 SRI；`loadedCodeIdentity`、`installedTreeIdentity` 都是 unverified，archiveIntegrityVerified=false、capabilityReceipt=null、functionalAcceptance=false。没有下载安装或验证整个已安装包字节。原强身份接口暂不可用是诚实能力边界，不是执行服务故障。

## 业务接线与安全边界

`requestArchive: local` 仅允许 `recoveryAuthority: core_checkpoint`、`dataMode: local_write`；默认 legacy 和无该字段时不增加归档接管。Core 状态初始化仍须显式 operator.admin 选择 revision/operationId；读取不采用 HEAD、不写 Host recoveryRevision，不迁移真实沧海。其状态目录仍要求现存、规范、仓库外路径。

目标 Agent 的普通请求须有 allow/agent dispatch、稳定 Host Timestamp、原始 Body、真实 session entry，且无附件/音频/tail/suppress。reset 等已有 Host command 保持原生命周期。owner 由当前 Host command-auth 解析，必须 direct；不把 projected messages 伪装 transcript，不虚构 SessionId。整个操作重查事件 envelope、run/session/body/time、sessionId、当前 owner、插件 enabled 和精确配置；取消与 stop 关闭原 scope。缓存上限 256，超限明确拒绝，不自动丢弃旧操作再收养新 expected。

成功与失败均显式返回 handled=true、queuedFinal=false，诊断回调异常不能放行默认模型路径。原版 hook runner 可能在 thrown error/其他生命周期中继续执行，因此目标 `before_agent_run` 阻断仍保留；本批没有宣称全局接管所有原生入口。Host 负责真正模型调用、取消和工具循环；本链没有新增 Core 自建派发或 opaque Host 绑定。

`archiveCorrectionInput` 增加明确 Core 分支，legacy synchronized 契约保持；Core 返回 `local_committed`。业务 operationId 绑定 agent/session/run，归档仅留存公开 Host ingress 快照和合成 evidence。B 必须来自共同事务认证后的 CAS 返回值，不以一次新 capture 的观测 B 替换 A；实际 evidence resolver 使用这个 B 再验原文。新 writer 限既有 retain/v1 policy，用途、来源与 required view 门禁继续执行；没有 view rebuild admission 的入口仍阻断。

## 恢复审查及修复

跨注册恢复只取 v2 journal 的原 binding/expected，业务配置不由 journal 自报。新 `checkpoint-committed-document.ts` 通过 exact regular Git blob 读取原 A 的 manifest → runtime profile → Praxis binding → catalog → policy，核 policy locator/ref/owner。清除继承 GIT_*，禁 replace objects、lazy fetch、交互 prompt，关闭可选 index 刷新；不跟随工作树 symlink 或改 expected。

归档重放从 A 的真实 catalog、认证 Host 请求重建 archive、purpose、generation、合法 view migration 和**整个业务 plan**，再 canonical 精确比较。journal 自身 planHash 仅作完整性检查，不能授权 owner、用途、根路径、额外文件或 contextArchive。共同 runtime 随后继续核真实父提交、所有 before/after 字节、原 tuple 和 CAS。当前 policy/来源在发布阶段再次复核，撤权不因恢复旧 A 而被撤销。

审查发现的两项问题（journal 自授权配置、夹带文件）和 Git replace 读取不一致均已修复；独立只读复核确认可关闭。未扩展 Host 接口或另建 authority/epoch 平台。

## 同版本证据矩阵

| 验收项 | 观察与限制 |
| --- | --- |
| 完整插件导入/注册 | 真 SDK 导入；注册器/Host 生命周期为合成；导入目录枚举 0 |
| 默认/显式 legacy | 注册项一致；3 项原注册回归同产物通过；不保证旧强 receipt 可用 |
| owner ingress 正常归档 | 真实本地 Git/CAS/catalog/payload/evidence/reload，零模型请求和 Host 配置写入 |
| 同 run 重试/跨注册 completed 重放 | 原 tuple 认证，仅一个 B、token 不增加；改 Body 拒绝 |
| CAS 后关闭 opt-in | B 与 pending 保留；恢复许可后新注册使用原 A/tokenA 精确接续，不另提交/推进 token |
| 请求 envelope 中途变化 | payload/commit 前阻断，不把变化后的请求当原事件 |
| 非 owner、group、缺时间、缺 session、预取消、stop | 明确 handled/error，无默认 Agent/生成回复、Git 不变 |
| 重新 hash 的 pre-journal 攻击 | 自选 owner 和夹带覆盖文件均拒绝；A/token、目标与 marker 原证据不变 |
| Git replace / GIT_DIR 重定向 | 实际合成 replace refs 会改变普通 git show；受限 helper 仍取真实 A |
| 旧 A/C、错 binding、脏 journal、缺失/损坏、取消、初始化用户文件、loader ABA/cache | 既有 60 项在本版同编译产物复验；不借用旧包结果 |
| 旧强 receipt / 包元数据变化 | strong capture 明确不可用；元数据不能发新或续用旧强收据 |

真实 Host 启动/服务 reload、Agent 工具循环/最终模型输入、旧 session/compaction/缓存撤权、bootstrap refresh、memory index、wiki compile 都未在本批证明。无真实 API、凭据/私人记忆读取、生产配置、Gateway、真实索引、远端 push、OpenClaw 修改或 full_memory 开启。

原始尝试完整保留：a1/a2 各 70/71，唯一失败是新 owner 通路缺 SDK 真实 session 存储夹具；a3 类型错误未跑测试；a4 73+3 全过但尚无后续恢复安全修复；a5/a6 类型错误未跑测试；a7 76+3 为中间源码；只有 **a8 77+3** 对应最终代码。未把中间通过当最终版本证据。

## 任务状态与下一批边界

- **SQ01/SQ04**：完整导入和公开注册接缝可达，移除 import 树扫描；原覆层/强身份验收不可用。实际 Gateway/Agent 消费不是本批结论。
- **SQ06**：第一条现有业务 writer + resolver 已接 checkpoint，含重启/失败接续；未迁移的业务路径继续不注册或阻断。余下类别包括 PreparedTurn/processing/source assertion 与正常 Agent 供给、语义 correction/learning、question/outcome/episode/retrieval/cleanup/synchronize，以及真实初始化注册。共享事务和 resolver 沿用当前实现，不再另造状态框架。
- **SQ07**：bootstrap/skills、memory/wiki/RAG 的文件清单和按需刷新仍待集成；普通 wiki 与 bundled memory-wiki 不混用。本批没有触发任何真实刷新。
- **SQ08**：下一明确集成目标应是一个正常 Host Agent 的纯 plugin 供给通路：Host 持有执行/取消/工具循环，Core 用同一 checkpoint resolver 管理供给的来源、权限和新鲜度；对未迁移 writer 和不可安全复用历史保留明确阻断。先合成固定版本证明，不能先开启 full_memory，也不要求迁完全部旁支才验证一个可用 Agent 路径。

没有新权限/架构决策待用户确认。强身份 attestation、真实 Host 业务消费、刷新适配和生产升级是剩余交付边界，不应以 metadata 或 archive-only 成功冒充完成。若后续需外部/生产动作，仍按既有范围另行确认。

## 交付身份及保留项

隔离编译 manifest SHA256：`2317c12b6f1899090f98ac3c8932d57c6374529d54839b0aed18d2e78b99af9a`，共 138 个生成文件/公开 schema，**不是安装包身份**。最终逐文件源码/报告 SHA256、commit 与 raw logs 在 delivery 中。

四份既有未提交文件（三份肃清规划/M1 文档、recovery-pointer-barriers 测试）均与批前 SHA256 一致，未纳入本批提交。所有新产物位于已核实非 iCloud 的项目 .artifacts/docs，临时数据库与 Git fixture 为专用 /tmp 并由测试清理；未改动云端原件。本轮没有审批拒绝、未决写入或仍在运行的测试；原 ps/Host 整树限制始终遵守。
