# 肃清第四批：SQ06 统一权威与本地归档闭环

本批以 `0d5abe310dcd95793e664fde88618f9e53dc458a` 为基线。最终本地提交、被测源码逐文件 SHA256、原始命令与退出码、隔离编译身份见项目 `.artifacts/suqing-batch4-20261022/delivery.json`。本报告随本批提交保存；没有生成可安装发布包，也没有部署。

## 结果与完成边界

最终 a5：完整 typecheck、定向编译通过，**60/60** 测试通过，无 skipped/cancelled。新集成文件包含 15 个顶层测试和 8 个子测试（23 项），另有 37 项受影响的 checkpoint runtime、journal、loader 回归在同一编译产物下复核。

已用真实本地文件/Git/保守锁/实际 Core loader 验证：显式选择干净 A → checkpoint 初始化 → 六份合成初始化投影（五 bootstrap 与一个 skill）→ retain 原文归档生成 v2 journal → 本地提交 B → 原 A/tokenA 精确 CAS → 固定 B/tokenB 的发布复核 → 清除 pending → 新操作加载 B → 重新打开状态后仍为 B。Host 初始化 verify/identity/fence 端口为合成依赖，未运行真实 Host 或模型。不能将本结果称为完整 plugin 启动、真实 Agent 消费或 full_memory 通过。

SQ06 **尚未整体完成**：存储、事务发布、初始化内核与受限注册工厂已形成闭环；原业务 Agent 读写方和现有 Host 初始化注册仍需迁移。下面穷举这些剩余类别，避免继续把每一个端口列为一个新批次。

## 实现

- `memory-transaction.ts`：v2 必须配显式 checkpoint adapter；v1 不得带 Core adapter。原 tuple 与 binding 在首次写入前固定且与 journal 相同。Core 使用同一 `.stella-memory-transaction.json.lock` 的保守 Node 锁，legacy SDK 分支保留，不查询/偷回进程锁。新操作同 fence 内核对 HEAD=A、干净状态及原 tuple，拒绝未选择的 Git 子提交与其他脏文件。
- 提交后先认证该单父提交和 v2 journal，再从精确 CAS 返回值构造 B/tokenB。独立 publication 校验后再次认证**同一 B/journal**并核原 token，防止回调中修改/删除 payload、对象或策略。正常、pending 重放及 completed-journal 快路径都受此门禁约束；marker 最后一次异步读取后、unlink 前同步检查取消。失败保留 checkpoint 和 pending，不能回滚 A、改 expected 或借新读值放行旧闭包。
- marker 新建、文件替换和 marker 删除增加目录 fsync。此处证明进程级故障恢复与所述持久化顺序，不宣称真实断电、NFS 或恶意同账号防篡改已验收。
- `checkpoint-archive.ts` / `archive-writer.ts`：现有 retain 归档 writer 增加明确 Core 分支。source/evidence/coverage、payload、catalog、业务归档记录与 v2 journal 一次提交；原文、policy、用途与 generation 反复验证。归档记录绑定 archive digest 和 purpose，重放不能改用途。新事件追加、精确同操作重放可用；旧事件或旧业务 journal 不自动收养。所需 view 无 rebuild admission 时仍阻断。
- 本地归档明确返回 `local_committed`，不调用 `syncCritical`、push 或定时 flush；未改变原 ingest 的 `synchronized` 成功要求。没有把本地提交当远端完成，也没有另造与现有事务并行的 authority/journal 系统。
- `checkpoint-plugin-runtime.ts`：每注册一个 resolver/read scope。load 同一次快照返回 `loaded + recovery`；每个既存操作只验证其冻结 tuple。初始化、独立归档和独立 reload 才能捕获新快照；取消/stop 关闭原 scope。Git→checkpoint 成功不更新旧 A 闭包，也不写 OpenClaw recoveryRevision。
- `initialization.ts`：Core 工厂使用保守锁，按每操作原快照新建 initializer，沿用现有投影事务。Core strict ownership 拒绝未受管的已存在目标；旧文件 mode 从 receipt 对应的原 operation 记录核实，不采纳当前观测值。Core 初始化计划保存完整原 recoveryAuthority；pending 重放必须精确相同，缺字段的 legacy pending 或旧 token 明确拒绝并保留证据。同 tuple 的 Core pending 可重启重试。legacy 默认不增加该字段、不强制该新策略。

## 显式 opt-in 与受限插件接线

新增公开配置字段 `recoveryAuthority: legacy_config | core_checkpoint`，默认 legacy；旧配置仍需 recoveryRevision，保持可用。Core 模式必须显式配置现存、规范、仓库外的 `checkpointStateDirectory`，不允许同时出现 recoveryRevision 或旧 durability/retention/history 配置，只允许 read_only/local_write。缺失、损坏和错误 binding 均失败，普通读取不采用 HEAD、不初始化、不静默降回 legacy。read_only 不初始化或写入，需先完成受控初始化再切只读。

`plugin.ts` 的 Core 分支在旧注册逻辑前返回，统一交给 `checkpoint-plugin-registration.ts`，不注册旧 completion/provider/context engine/学习/维护 writer。`before_agent_run` 对目标 Agent 明确 block；其他 Agent pass。

仅新增 `operator.admin` 的 `stella.checkpoint`：status、reload、initialize。initialize 要求显式 revision 与 operationId；发现阶段和 service start 不做迁移。模型工具 `stella_initialize` 在该模式仅能查 status。**不提供接受任意模型载荷的归档 API**：内部 archiveLocal 的 Host 输入必须已由受信任 Core caller 认证，本批尚未接原版 Host 输入适配器。内部 prepareInitialization 的 file/identity/fence/verify adapter 亦未接生产 Host。

status 分开给出 authority、loadedRevision；`materialized: null`、`consumed: false`，hostBootstrap/agentMemory/full_memory 均 false。本批不更新真实 Host 配置；测试 stub 的 config write 计数为 0。

完整 entry 仍静态导入旧 `initialization-registration.ts` → verifier，该模块会在 import 时递归 hash Host dist。此前此类扫描被拒，**本批没有导入或执行整个 plugin**，也未通过另一路径扫描。只测试不带该副作用的真实注册工厂；入口路由由全量 typecheck 与源码审阅覆盖。旧 verifier 的 provenance/导入副作用需要在启动验收前用明确公开包元数据/lockfile/integrity 的有界方案解决，不能晚读磁盘再冒充已加载代码身份。

本地锁只覆盖合作方。生产升级前必须停止旧 writer/闭包并完成受控选择；不能与会自动清理旧锁格式的历史 SDK writer 混跑。遗留锁保守拒绝，不自动回收。本批未改变真实部署或旧锁。

## 同版本验收矩阵

| 场景 | 观察结果与范围 |
| --- | --- |
| A 初始化→投影→原文归档→Git B→CAS→reload/reopen | 真 Core 路径、本地 Git、状态和文件通过；Host verify/identity 为合成端口 |
| 提交前故障 | A 保持，原 journal/pending 保留；重开后同操作仅提交一个 B |
| CAS 后 publication 失败 | B 与 pending 保留；外部 load 被现有 recovery gate 提前阻断 |
| 重启精确重放、completed replay | 继续原 A/O/B，提交数/token 不增加；已完成快路径仍执行 publication |
| 旧 A、后来 C、同 ID 改用途 | 旧 expected 拒绝，晚到旧 journal 不覆盖后代，purpose 不可替换 |
| 未选择 Git 子提交 / 脏源 | 新操作在 payload 写入前拒绝；发布中 payload 或 policy 变化拒绝且保留 fence |
| 异步 publication 中取消/stop | 不解除事务 fence，旧 resolver/scope 明确失效；取消检查以 marker 删除前的同步点线性化 |
| 缺失/损坏状态、双 authority、read_only | 不采用 HEAD/legacy seed，不写配置，明确错误 |
| 初始化用户文件与 mode | 新目标碰撞、既有内容修改、recipe 升级时权限漂移均拒绝且保护用户内容 |
| 初始化 pending | legacy 原件不变、旧 token 拒绝；同原 tuple 在重开后恢复，不把新 token 填入旧计划 |
| 原 journal / loader 行为 | 同产物复核 v1/v2 canonical、严格字段、过期/ABA/迟到 cache、原始 CAS 等 37 项 |

没有运行真实 Agent、官方 memory index、wiki compile、Gateway reload、生产迁移、真实 API 或远端 push。本批不是实际多进程崩溃/真实断电新验收；batch3 的锁进程证据只作历史依据，不计入本版 60 项通过。没有借用已废弃 9a4b9643 覆层或旧真实账本证明当前通过。

原始结果：a1 类型错误、未运行测试；a2 47/50（隔离编译目录漏 schema）；a3 53/54（错误断言落后于更早的 recovery gate 阻断）；a4 57/57 是中间源码；最终 a5 60/60。所有失败记录留存，只有 a5 对应最终源码。

## SQ06 全部剩余读写类别与归属

| 类别/源码位置 | Core opt-in 当前行为 | 后续归属 |
| --- | --- | --- |
| plugin.ts 的 PreparedTurn、processing/deployment/source assertions、hostContextExecutionHash、全局 durability callback、outcome binding | 旧分支不注册，未接受新 Core runtime；没有默认 revision 回退 | **SQ06**：一次性将实际业务操作携带同一 binding/journal 与独立 B publication；不得改写旧 A reader |
| initialization-registration.ts 的配置 sourceRevision、live config overwrite、capability capture | 旧注册不运行；新文件初始化内核仅内部显式端口可用 | **SQ06**：Host 注册选择同一 resolver；公开来源核验有界化。实际缓存/消费刷新属 SQ07/08 |
| learning/correction.ts prepare/recover、learning/host-correction.ts archive | 仍 v1/旧 durability 语义，Core 模式不可达；原 ingest synchronized 条件保留 | **SQ06**：迁移 journal、提交与发布；不能用本地路径冒充同步成功 |
| canghai/ingest.ts 正常/恢复、synchronize.ts | 旧 plan 与旧公共 ports，Core 不运行 | **SQ06**：统一事务/expected，原 retention/来源/权限检查保持 |
| praxis/question-transaction.ts、outcome-transaction.ts、outcome-recovery.ts | 旧 v1 路径，Core 不运行 | **SQ06**：共同底层 adapter 加业务 B 校验，恢复保留原身份 |
| praxis/episode-repository.ts、episode-store.ts recommendation/lifecycle/outcome | 直接/旧业务 journal 写入，Core 不运行 | **SQ06**：纳入共同 journal 或明确阻断，不能先写再补确认 |
| canghai/retrieval-progress.ts、archive-cleanup.ts、managed-durable-write.ts 非 transaction 分支 | 旧直接写/删和 path-only confirm，Core 不运行 | **SQ06**：统一受控写删/确认；合成 managed harness 不能替代真实业务接线 |
| canghai/archive-writer.ts retain 事件追加 | Core 分支本批通过；原 ingest/gateway 来源接入、required view admission、旧业务 journal 迁移未完成 | **SQ06**：接真实受信任入口；不再造归档系统 |
| host-context history/head/view、maintenance/consolidation/native paths | Core 不注册，不允许借旧包结果放行 | 指针/journal 接线属 **SQ06**；刷新与原版 Host 最终消费属 **SQ07/08** |
| 五 bootstrap / skills、memory 日记、普通 wiki、bundled memory-wiki、RAG 源与索引 | 文件计划已有纯函数；本批只显式测试合成初始化文件，未跑任何真实刷新 | **SQ07**：文件清单、消费者适配与部分失败；普通 wiki 不能当 bundled wiki 已启用 |
| 原版 Host 调用/取消/工具循环与历史/compaction/缓存撤权 | 由 Host 负责，新模式尚无 Agent 可用声明 | **SQ08**：一个真实可用纯 plugin 通路的合成端到端证明；无法证明的入口按能力标签阻断，不要求恢复旧 opaque 补丁形式 |

下一批建议仍收敛 SQ06：把实际业务注册和读写点作为一个集成工作包迁移到本批共同 adapter，并先解决入口 import 的 provenance 副作用；优先接受信任 Host 输入→现有归档/业务流程的闭环，再在同一包核对其余未迁移 writer 的拒绝行为。不得仅反复增加 helper 测试称 SQ06 完成。文件消费者刷新和原版 Host 消费证明保持 SQ07/08 的各自出口，不把 Core 状态本身当成消费证明。

## 身份、保留项与授权状态

隔离编译 manifest SHA256：`3ceab3a1847d0c43df956d93f7d023306b24d0ea812041a9cbbb0b72d215506f`（55 个生成/公开 schema 文件，明确不是安装包）。最终源码与其哈希由 a5 result 和 delivery 对照；没有生产包或 Host 新身份。

本批只提交明确自有的 9 份源码/配置/测试与本文。以下四份既有未提交文件哈希均与批前一致，不纳入提交：三份 suqing 规划/M1 文档与 `tests/recovery-pointer-barriers.test.ts`，清单在 artifacts/preserved-preexisting-files.json。

本批写入均在已验证非 iCloud 的项目位置，临时仓库/工作区为隔离 /tmp；未修改/迁移/删除 iCloud 原件、真实沧海、生产配置、凭据、Host 安装或安全设置。本批没有审批拒绝或未决写入；有明确未验证的完整入口，不是执行服务故障。full_memory 门禁保持，旧 Host 覆层不可交付。
