# 2026-11-04 全仓新格式分支与普通插件消费交接

用户明确要求：沧海全仓资料在独立新分支转换，本机 OpenClaw + Core 调试直接消费该新分支的本地固定工作树，仓库与私人 Agent 的同步同时改为新格式。这是独立长任务；历史“单资产投影／97 来源、362 描述符”的范围只是已有实验，不是全仓目标。下文带日期的旧 checkpoint 接口保留为历史，不是普通插件新开发的入口。

Core 当前读接口保持最小：`plugins.entries.stella-core.config.sourceRead = { root, manifestPath, revision }`。`root` 必须为规范的干净 Git 工作树，`revision` 为明确的完整提交 SHA，不能填分支名、跟随 HEAD 或自动 checkout；新分支由沧海唯一写者管理，Core 不修改该工作树。分支用于生产者开发，消费者用确定的已交接版本运行。

| 交接项 | 当前普通插件消费契约 | 沧海转换／同步责任与尚缺部分 |
| --- | --- | --- |
| 版本与入口 | manifest v1 → runtime-profile v1/v2 → memory catalog v1；路径由引用决定，不要求 `migration-v1` 目录名 | 交付新分支、固定工作树、SHA、manifest/profile/catalog 的相对路径及内容 hash；当前未收到新的全仓候选交接，不能拿 2026-10-24 的合成 warehouse 分支代替 |
| 原始资料与附件 | Source v1/v2、Evidence v1、policy、coverage；原文 selector 与字节 hash、角色／时间／来源记录保持可追溯 | 逐旧资料记录转换／保留／拒绝／未处理及附件覆盖；非文本附件仍需对应读取能力，不能伪造为文本或丢弃。全仓转换不等于给模型全仓访问许可 |
| 列举与阅读 | 列表使用获准描述符作语义选择线索，读回原始 Evidence；描述不是事实，确定性代码不做词面路由 | 交付与新 Source 版本相符的描述符、既有策略与用途。旧 grant 不自动允许新增／改版资料；缺描述／权限明确拒绝，不重建一套身份平台 |
| 同步到下一请求 | 已消费 revision/generation/cursor 不自动升级；换新版本后重新获取入场资格，旧游标、已移除 Source 拒绝 | 同步器交付 producer-before/after SHA、变化／删除和依赖重评结果；核对象／payload/策略引用闭合，再协调更新 consumer revision。普通插件目前没有新分支自动同步器，这是真实实现缺口 |
| 写回与生产保护 | 本包只有读接口；正式发布仍关闭，既有草稿库独立 | 新格式写回路径、方向、冲突处理与写者责任须由两任务共同确定；不沿用旧全会话／checkpoint writer，不动生产 dev 或现有唯一资料 |

本轮用纯合成 Git 分支证明新 manifest/profile/catalog 路径可被现有普通入口列举与读回，并验证换代后旧版本／游标／移除来源拒绝。它不证明全仓转换完成、真实授权变化、自动同步、Host 加载或模型理解。当前仍绑定的固定 90f 快照与 97／362 范围保持；只有沧海交接后才安排受控替换，不能用新目录名掩盖数据未迁移。

旧代码分阶段退役：先抽离中立类型、收紧安装包到普通插件与仍使用的数据／事务工具；随后按现行依赖移除旧专用入口、私有 Host 桥、脚本和测试。有效的来源权限、版本、取消、原文完整性、事务断言必须保留。Git 中可恢复的历史实现不再作为新运行能力，旧失败不会改记通过。下一批不得删除仍被新 catalog 引用的 initialization 数据或原始附件。

# 2026-11-03 简化旧兼容负担的边界

用户将新架构的数据层与正向理解置于旧对象兼容迁移之前。旧派生对象迁移不再是当前来源问答的前置，不新增通用迁移框架；`raw_evidence` 仍不能自动解释为进行中的 Work。未完成的历史派生语义保留为未完成，不把原文保全说成理解迁移成功。

清理按实际引用和可恢复性逐项进行。本次沧海协作核查确认，固定 `90f61d9c9ef019c5a06a419dbcb630fe598cb996` 的 97 来源范围内仍有 234 个 current 对象引用 initialization 目录，因此不能按目录名整删。原 Source、Evidence、策略、版本和仍被 checkpoint 使用的副本继续保留；Core 不在本轮修改沧海目录、生产数据或许可。具体任务与暂停状态仍只记在 `.task-control/state.json`。

# Core 与沧海的并行开发约定

2026-10-23。按用户确认的 [D-060](DECISIONS.md#d-060--coordinate-core-and-canghai-without-disrupting-legacy-production) 协调两个项目。本页记录 Core 已实现的消费边界和双方交接要求；不是沧海当前目录或领域接口已经兼容的证明，也不执行数据迁移。

## 生产边界与工作分工

沧海 `dev` 正供旧版 Stella 生产使用。开发中的新目录允许与旧目录共存：保留旧路径、内容语义、生产读取范围和消费指针，不删除、移动或重写生产资料。新目录名称、schema、导出接口及开发 ref 由沧海工作包确认，Core 不根据旧记录猜测。普通本地开发授权不等于生产切换、资料用途扩展或真实模型外发授权。

- **沧海负责**：权威原始资料、目录与领域数据格式、版本化对象及来源策略；提供明确的读接口/导出和写入所有权清单，证明旧消费者不受影响。
- **Core 负责**：契约解码、当前来源与权限准入、checkpoint/Git/CAS、声明文件的 Host Projection，以及纯插件工具供给；用合成等价资料验证消费者，保留明确拒绝。
- **OpenClaw 负责**：公开身份、Agent/工具/模型循环、正常取消和聊天历史。Core 不修改 Host，也不把安装了 Skill 当作新工具许可或个人资料授权。
- **协调者负责**：固定交接版本，合并双方接口变更与依赖顺序，确保同一文件/工作树只有指定写者。双方可并行实现独立部分，不能各自默默改共享契约。

Core 工作包只修改 Core；沧海工作包独立核对并修改获准的开发工作树，双方均不操作生产消费指针。任务是否已启动或交付，以对应会话与固定版本证据为准。

## Core 当前确切依赖

以下路径是 Core 的源码依据；右列是需由双方确认的实例选择，不是给沧海指定新目录。

| 接缝 | Core 当前行为与源码 | 必须交接的最小信息 |
| --- | --- | --- |
| 源与 authority | [checkpoint-plugin-runtime.ts](../src/openclaw/checkpoint-plugin-runtime.ts) 接收 `canghaiRoot`、`manifestPath`、`agentId`、仓库外 `checkpointStateDirectory`；binding 绑定这三项源身份，读取显式 checkpoint revision | canonical 开发源根、明确 manifest、不可变 Git SHA、独立状态目录及唯一 writer；不能自动跟随 `dev`/HEAD |
| manifest/profile | manifest 的 `identity.runtimeProfileRef` 指向 [runtime-profile.ts](../src/canghai/runtime-profile.ts) 可解析的 `stella.runtime-profile/v1` 或 `/v2`；v2 显式声明 `host_materialization_ref` | 源实际格式、各引用的路径/内容身份、必要能力与最小物化清单。`experimental_owner_chat` 是插件能力模式，不是现有 `contract_profile` 的新枚举值；不能只改标签伪装兼容 |
| catalog/binding | [runtime-binding.ts](../src/praxis/runtime-binding.ts) 从 `memory.catalog_ref` 及 capability `config_ref` 取得 catalog、archive 根、purpose、referenceBindings；按 profile 校验现有 binding 格式 | catalog/schema/generation、对象和 payload 根、用途/受众、引用及 required views 的准确集合；所有引用需闭合在所选版本 |
| 来源权限 | `source_access_context` 使用现有 `stella.personal-context-access` v1 与逐对象策略；有限工具路径仍执行语义上下文判断，缺精确描述或合法策略拒绝的对象不供给 | 受信任请求身份、processing grant、原来源/用途/受众和必要审核描述；区分可解析、待语义判断、按策略拒绝、资料缺失，不把可解析算已允许 |
| 归档写入 | [checkpoint-archive.ts](../src/canghai/checkpoint-archive.ts) 写声明的 payload/object 根、catalog、所需 view 文件及 catalog 同级 `operations/<id>.archive.json`、`<id>.checkpoint.json` | 完整可变路径闭包与旧目录排除集；仅换 manifest 不会隔离共享 catalog、payload、view 或 journal。当前 owner 输入归档是 `local_committed`，不是完整 transcript/语义学习/远端同步 |
| 写入一致性 | [checkpoint-recovery-runtime.ts](../src/canghai/checkpoint-recovery-runtime.ts) 校验整树干净、原 expected revision/token、单个直接子提交及精确计划变更；[D-059](DECISIONS.md#d-059--core-checkpoint-is-an-explicit-local-authority) 规定仓库外 authority | 独占写入窗口、准确父版本和原 journal；外部领域写入不能被当作 Core 已认证提交，不能从观测 HEAD 自动升级 expected |
| Host 文件 | [checkpoint-initialization.ts](../src/openclaw/checkpoint-initialization.ts) 只物化声明 recipe；文件写盘、发现/刷新和实际消费分开 | 受管文件/Skill 所有权、冲突备份与实际生效方式；不覆盖用户 bootstrap，不自动扩大 wiki/RAG/索引任务 |
| Agent 读／纠正入口 | [checkpoint-agent-supply.ts](../src/openclaw/checkpoint-agent-supply.ts) 的只读 `stella_memory_data` 接受 `list/read/skill/work/understanding`；可选独立 `stella_memory_correct {}` 需显式 `agentCorrection:tool` 及 Host 工具许可，默认关闭 | 领域数据先成为入口可读的版本化 Source/Evidence；Work 是已有派生对象的窄供给，Understanding 保留当前 USER/MEMORY 分区与 scope/status。纠正复用原来源用途／派生约束，不从 Skill 文字或本地归档推导语义写入许可；领域 CLI 完成不等于已进入 catalog、工具循环或资料 grant |

`full_memory` profile 的来源格式可以被有限工具路径消费，不代表完整能力已经实现或验收。有限实验模式、完整能力诊断和真实模型效果分别记录；沿用 [D-058](DECISIONS.md#d-058--experimental-simplicity-and-user-request-boundaries)，不重新引入运行中撤权、输出缓冲或 provider 代理。

## 新旧并存的两个独立问题

**目录兼容**：新布局先作为增量候选，旧生产路径和其既有语义保持不变。必须确认旧版读取是否包含 glob、索引、同步、自动发现 Skill 等范围；新目录即使没有覆盖旧文件，也可能被这些消费者意外纳入。验收比较旧消费者的有效读取集合与必要结果，不能只看 `git diff` 没有删除。

**Git/写者隔离**：Core 的锁/fence 位于仓库根 `.stella-memory-transaction.json`；整个工作树的无关未提交文件或别的 writer 推进 HEAD 都可能使本次事务明确拒绝。分目录不构成事务隔离。最小开发安排是双方确认独立开发分支/工作树或受控源副本，使用明确 SHA、独立 authority 和单写者；此页仅建议，不创建或切换它们。独立工作树也不自动解决最终合并、远端分支竞争或生产切换。

目录后续合并与运行源切换是两个操作：先证明可加性和旧消费者兼容，再单独审阅是否让实例选择新版本。任何一边不能通过放宽 clean/CAS 检查、更新 observed expected、自动采用 HEAD、删锁或回滚 authority 来消除冲突。

## 兼容读写边界

| 操作 | 开发联调边界 | 不可隐含发生 |
| --- | --- | --- |
| 读取旧资料 | 明确版本/范围，在原策略下读取；合成测试仅使用等价 fixtures | 把旧目录路径、同 OS 账号或已有 CLI 能力当资料许可；把私人正文放入公共测试/报告 |
| 新目录写入 | 沧海确认新 namespace 的 schema、所有权和全部可变路径；Core 在隔离开发源按原事务写入 | 删除/移动生产数据、改变旧 catalog/policy、修改生产 `dev` 消费指针；新目录没有确认前不自行命名落盘 |
| 两边提交 | 同一工作树只有指定写者；交接确切版本和完整变更集合，冲突显式协调 | 两个事务混入同一个提交、自动 rebase/reset 生产、把外部领域 commit 冒充 Core writer receipt |
| 领域 CLI/Skill 接入 | 先选择已有版本化资料导出，或评审最小只读工具边界；分别验证身份、策略、调用、返回与最终消费 | 通用 shell 执行桥、伪造 Telegram/CLI owner、仅靠 Skill 文字授予工具和数据访问 |
| 生效与回退 | 在开发 Host 验证声明 bootstrap/Skill/数据工具；按需使用已支持的生命周期；按具体 source/checkpoint/物化操作分别回退 | 重启生产、重建真实索引、回滚撤权、把写盘/刷新请求视为消费成功，或承诺任意时刻一键 rollback |

## 联调顺序与可并行批次

| 关口 | 双方交付与验收 | 谁可先独立推进 |
| --- | --- | --- |
| 1. 最小契约冻结 | 沧海交付下表的结构摘要/版本；Core 对照实际解析器确认支持和拒绝边界。尚未知字段保留未知，不造第二套契约框架 | 沧海整理自己的格式/生产读集；Core 完成有限模式 CI 和现有消费映射，可并行 |
| 2. 合成生产者—消费者 | 合成资料跑结构/引用闭包、原用途受众允许与拒绝、领域读接口→Core 工具的明确接线；路径/版本缺失明确失败 | 双方在独立文件实现；涉及公共接口时先交接类型/fixture，单写者集成 |
| 3. 旧版兼容 | 生产等价 fixture 证明旧路径/读集/结果未改变；新增目录不被旧 glob/索引/同步误收；不碰真实生产来试错 | 沧海确认旧版机制，Core 提供消费者负例与结果核验 |
| 4. 固定源只读 | 独立开发源和外置状态显式选择 SHA；正常读取、更新/删除后下一请求 freshness、缺描述/原策略拒绝分别观察 | 双方交接后，由指定联调者执行；不自动切真实 main/生产源 |
| 5. 受控写入 | 在同一隔离开发源验证一次归档/领域写入的职责划分，精确 Git/CAS→journal 确认→下一请求采用；并发/dirty/stale 拒绝不能伪装成功 | 唯一仓库写者执行；另一边审查证据。未支持的领域 writer 单列，不声称已迁移 |
| 6. 同包 Host 消费 | 固定 Core 源/安装包 hash、原版 Host、合成配置/资料和 loopback provider；验证 Agent→声明工具→续轮→回答及必要身份/权限负例 | Core 负责；生产者按已冻结数据契约提供合成样本。通过只代表对应实验模式 |
| 7. 真实接入 | 先确认准确可信 owner/profile、来源 grant 与工具范围，再单独批准真实资料外发、provider/费用及生产切换 | 需要的精确授权未取得前，继续其他本地独立工作，不伪造身份或猜授权 |

开发节奏以一个可复核垂直路径为批次：确认接口→双方独立实现→单写者集成→固定版本证据→再推进下一入口。新增需求先判断是否属于当前有限模式；完整 learning/correction、附件、索引和旧部署迁移不自动变成这条联调的前置条件。

## 待沧海工作包确认的交接清单

这些信息尚不能从 Core 源码推出，本页不宣称沧海已完成或已启动相应工作：

1. 旧版生产当前选定版本/分支、实际消费指针及读取/同步/索引/Skill 发现范围；哪些路径不可写。
2. 新目录准确路径、schema/version、示例的合成等价数据和旧目录保留规则；各可变根是否真正分离。
3. 开发分支/工作树及唯一写者、候选源 SHA、manifest/profile/catalog/binding 的结构摘要；不得把默认分支或最新 HEAD 当运行授权。
4. 领域只读接口的准确输入/输出、稳定身份/时间/来源版本及错误语义；选择现有 catalog 导出还是最小窄工具。当前只有 CLI/Skill 成果时，明确尚未贯通的消费点。
5. 原用途/受众/来源策略和可信请求上下文的要求；缺描述、语义判断拒绝与技术故障分别计数。身份绑定和资料 grant 不由开发者推断扩大。
6. 可变文件清单、提交与恢复责任，以及固定版本的旧版兼容/合成联调证据。源已提交、Core checkpoint 已推进、Host 已消费是三个不同状态。

交接只需要路径规则、类型、版本和合成样本；私人原文、完整配置、凭据、真实聊天及原始模型输出留在各自获准本机位置。公开 Core 文档仅保存契约与允许的聚合结论。协调文档不代替具体实现证据、现有来源许可或生产变更审批。

## 首条联调路线的 Core 回签（2026-10-24）

首条开发路线选择固定领域只读结果的确定性 Source/Evidence 投影，复用已有 `list/read`，
不引入通用 CLI 执行。manifest v1、runtime-profile v2、memory-runtime-binding v1、
memory-catalog v1、现有 Source/Evidence 和 policy v3/context-access v1 仍按各自解析器校验；
不另设跨项目协议，也不把插件模式写成新的 profile 枚举。

投影载荷保留领域原始 dataset、确切 Git 版本、文件、record、字段引用与覆盖/缺口信息，
来源对象继续使用 Core 既有 ID、内容版本及字节 hash。领域 `allowed_uses` 不能自动转成
processing grant；开发夹具仅用明确合成身份/策略，真实许可保持原状。领域数据不得被重标
为 owner 原话，固定快照不意味着任意动态查询、完整 transcript 或金融语义效果已验收。

新 namespace、可变根、准确字段映射和候选 SHA 仍须由沧海开发工作包交付、Core 对照实际
解析器验收。旧 runtime 若整目录同步 Skill，新增 Skill 不能仅因放入“新模块”就视为隔离；
首条联调无必要时不增加 Skill。消费者使用独立固定版本副本，不能与生产者并行推进同一
HEAD。双方先验证合成资料及原许可允许/拒绝，再以同包原版 Host/loopback 验证最终消费。
这次回签选定路线，不宣称未知目录和数据已经兼容。


## 固定快照联合验收与版本区别（2026-10-24）

纯合成投影已经在原版 OpenClaw 2026.8.2、实际安装 Core 包及 loopback fake provider 上完成
`list → 现有策略判断 → read → 模型续轮 → 回答`。正常路径 4 次请求、用途拒绝 3 次请求，
合成共享受众准入拒绝 0 次请求；完整 provider 输入保留 payload、Source/Evidence、字段级
Git 引用、tool/direct_observation 和金融 partial。此结论不表示真实模型金融质量、真实
Telegram/WebChat 授权、后续更新接纳或 full_memory 已验收；私人资料与 artifacts 不入库。

消费契约版本与 npm 包版本必须分开：当前 Core 兼容契约为 `3.0.0-alpha.0`，npm 包仍是
`0.1.0-alpha.0`。生产者应使用实际 loader 校验 `compatibility.stellaCore`，不能只检查 JSON
格式或拿 npm 版本代替。早期合成 fixture 声明 `<1.0.0` 导致物化拒绝；只在新副本修正兼容
声明后才通过，失败记录保留，不把元数据修正冒称策略或权限扩展。

显式 producerBase→candidate 数据投影导入已在 `47f8259b` 实现并验收；该版本的 F/G 联合
证据保留原身份，不能搬作后续包已通过。`945d7000` 的相关六个解析/导入源码 blob 与该版本
相同，这是静态契约兼容证据。导入保留消费侧配置/身份/grant，
原 catalog 与 producerBase 不一致时冲突拒绝，首批不做通用 merge。通过已有精确 journal、
直接子提交及 CAS 发布 Core 自己的消费 revision；producer candidate 与消费 revision分别记账。
新的 Source 版本仍需已有 grant 中精确 reviewed descriptor，导入不复制候选 grant或自动
放行新来源。原始 Git 对象的本地保留不等于 authority 已接受，更不自动采用生产 dev/HEAD。


## 2026-10-24 主线增量

当前 Core 同包机制、完整能力失败与两仓剩余任务见
[全局矩阵](mainline-global-status-2026-10-24.md)。沧海金融通用代码已从未跟踪生产目录
隔离到独立 `codex/finance-skill-isolation-v1` 本地提交；原目录及生产读取集合未因这次
复制改变，没有同步／安装到旧消费者。它与领域投影候选、私密录入分别交付，不能互相
冒用版本或授权。下一项只读 Understanding 供给沿用既有格式与权限，无需沧海改 schema；
本轮三轮同包机制验收通过；真实语义质量、main 及完整能力不据此通过。

<a id="data-foundation-snapshot-20261102"></a>
## 2026-11-02 数据基础与当前消费绑定核查

本次只读设计、Git 元数据、迁移清单／catalog 聚合统计与 Core 配置的指定结构字段；没有读取资料正文、金融持仓、凭据或原始会话，没有迁移、重建索引、改配置或运行 Host。当前排程的唯一需求正文见 [需求 §1.5](09-REQUIREMENTS-ALIGNMENT.md#forward-understanding-priority)。

| 层次 | 当前可证事实 | 不能据此推导 |
| --- | --- | --- |
| 设计 | CangHai `50_PersonalAgent/design/stella-redesign/02-Stella-数据架构规范.md` 标为架构基线 v0.21，2026-10-26；V1 完整方案及 DS-01～04A／RT 契约已固化，DS-04B 完整治理后置。迁移生产者独立分支 `codex/knowledge-migration-v1@2ea285d98d21c0882092582141aac92f93fa432a` 干净，含 `99_System/Scripts/knowledge-migration/` 的 plan/review/materialize 工具和具体转换文档。 | 设计已定不等于全部数据已转换，也不证明与当前普通插件已接通。CangHai 的独立访谈状态仍有自己的范围，不能覆盖 Core 唯一执行台账。 |
| 实际转换 | 独立本机源 `stella-sources/migration-v1` 当前为 `local/knowledge-migration-v1@112be540a3988af53d1076a38f8f1c155da7a745`、工作区干净；有 `30_Knowledge/migration-v1/{converted,runtime}` 与 manifest/profile。物化 manifest 的 hash 与原报告一致，记录1167原始文件保留、98 Source v2、342新 Evidence、200原历史 Source；供给投影当前复核为97 current来源／362描述符。runtime catalog 另有98 current来源／347 current Evidence。 | 这是有限迁移集，不能说从未转换或已经全迁完。审计表374描述符；供给表排除3个能力门槛来源及1个 native 快照，保留历史。`understandings/works/changes/bundles/views` 仍为空；转换器对非空派生对象明确返回待重评，不是完整理解／持续工作迁移器。本轮仅复核清单和统计，未重新读取1167份原始正文逐字节验收。 |
| 历史与现在的接入 | 父任务补充的已核历史记录表明：2026-10-27曾批准并切换上述97／362有限集，旧 checkpoint 路线曾完成真实问题读取。**当前普通插件**的配置却仅有 `agentId`、`publisher:false`、独立合成 `candidateDraftsRoot`；无 `canghaiRoot/manifestPath`。配置所指安装产物静态仍返回 `sourceAdapter:not_connected`、`currentInputAdmission:not_connected`。 | 不能把“过去旧 checkpoint 已加载”写成“本期普通插件仍在消费”，也不能反过来说从未接入。当前合成草稿演示不是已有资料召回。配置／产物静态核查不等于本轮已调用 Gateway 或验证实时索引。 |

CangHai 主工作区仍为生产 `dev@c050a046f48837f755c9b3f10bba2910d5218083`，两个已有 tracked 差异未触碰；其根目录没有 `30_Knowledge`，不能据此否认上述独立副本。既有 `stella-sources/main@644eafa63db75231fabc376129d56c02835cef8f` 是另一个旧源，不能自动替换显式源。迁移副本旧 manifest 内的 `active`、8.2版本标记和 `full_memory` profile 是文件中的历史声明，不是当前 main 已启用证明。

下一有限前置是对齐这份**已存在**的迁移集与新普通插件所需读取契约：固定源 revision、manifest/profile/catalog、语义描述符和用途边界，先用等价合成目录验证解析、来源版本／角色／时间、允许／拒绝及引用闭包，再提出精确的开发绑定方案。复用既有 CatalogReader、原件／策略校验和可用的原生搜索／文件读取；不重建迁移平台、不机械转换非空理解资产、不自动切 dev 或消费指针。真实资料读取／模型发送及实际 main 接入分别核其既有有效授权；本核查未执行这些步骤。聚合 hash、范围和版本见 [本轮审查证据](../.task-control/reports/CORE-VAL-001/direction-audit-20261102.json)。

2026-11-02 后续本地实现：[普通插件只读来源端口](ORDINARY-SOURCE-READ.md)沿用上表 manifest/profile/catalog 与 Source v2／双策略契约，37项合成定向验证通过；私人源未读取或激活，真实 Host 资格端口仍缺接线。`knowledge-migration-v1/manifest.json` 的两个 runtime profile 引用实际一致指向同目录 `runtime-profile.json`；这与根 `manifest.yaml` 的旧引用不同，所以候选读取器要求显式 manifest，缺失／不一致就失败。此增量不改变上表现场绑定状态，也不把纯读取器通过标为正向语义理解已完成。

2026-11-02 后续请求薄适配候选沿用 `source_access_context` 的原有单请求者、`google/gemini-3.8-flash`、`personal_context / personal_understanding / owner-direct` 合同，不追加授权。普通入口仅在配置来源端口时被动保存当前规范化请求表示；首次工具调用须匹配真实 Host 入场、run/call/session、请求者／受众及提交回执，列表按精确 Source／分段描述符过滤，原文仍经双策略判定。63项合成定向用例通过；上表真实未绑定状态不变，Host 字段与生命周期、真实资料供给／模型消费均未验证。固定 state95 独审包与本增量的代码／证据边界见 [读取契约](ORDINARY-SOURCE-READ.md#next-thin-binding-candidate-and-host-validation)，不把历史97／362许可扩大到整个 runtime catalog。

2026-11-02 固定 state97 的13文件离线候选已独审接受：63/63定向、28/28内核、9/9原反例及4/4默认入口／并发对照分别记录，不累加计分。当前真实来源／Host生产者仍未验，冻结代码未因结论保存而改变。默认模型可否合法复用及精确后续运行条件，见 [最小独审摘要](../.task-control/reports/CORE-VAL-001/source-admission-review-20261102.json)；Host显式model-override许可与CangHai逐来源处理许可是不同边界，不能混称缺资料授权。


<a id="data-handoff-metadata-20261102"></a>
## 2026-11-02 稳定数据交接复核（后续现场）

本次更新此前现场快照：正式 CangHai `dev` 已为 `d423d9e85ae3b2a9a120b7cdc52b3746b592b189`、干净；Core 未修改其文件或 refs。原 `stella-sources/migration-v1@112be540a3988af53d1076a38f8f1c155da7a745` 仍干净，交接的 profile、instance manifest、catalog、供给描述符四个 SHA-256 全匹配。profile 指向的真实 `source_access_context` 许可 hash 与原记录相同：单请求者、97 来源／362 描述符、`google/gemini-3.8-flash`、`personal_context / personal_understanding / owner-direct`。供给 review 明确 `activeGrant=false`、`actualApproval=false`，不能代替该既有许可。本次只核结构／引用／hash／范围，没有读取原始正文或发送模型。

正式仓库候选 `90f61d9c9ef019c5a06a419dbcb630fe598cb996` 中上述四文件及真实处理许可的字节均与112根相同。已登记的 `stella-sources/main` 确实共享正式仓库对象，但仍在旧 `644eafa63db75231fabc376129d56c02835cef8f`、干净，**尚未切换**。最短方案是由 CangHai 唯一目录写者保留旧分支／检查消费依赖，明确私密检出权限后固定该工作树到90f，再交给 Core 核对和准备精确 manifest 绑定；Core 不自行 switch、chmod 或改生产 dev。现目标目录为0755，Git不保存原0600，检出权限不能凭Git hash通过而忽略。金融内容未加入允许范围。

当前 main 来源代码已加载，但 `sourceRead` 仍未配置；真实入场身份与原请求者许可的匹配仍须验证。无模型元数据核查已经完成，不等于真实资料供给。原文读取先把当前问题、单片段描述符及用途限制送入结构化策略判断，允许后才将选中原文片段供给 Agent；两步数据流和新的付费调用必须分别清楚界定。完整非敏感检查、精确切换提案及输出／费用边界见 [交接证据](../.task-control/reports/CORE-VAL-001/data-handoff-metadata-20261102.json)。执行排程仍只维护在唯一台账。


后续当前 Host 消费依赖复核：官方只读 `plugins.list` 仍为 generation5，普通 Core／memory-core／timeline 为 active，fitness 为 unloaded；未注册 checkpoint 命名插件。配置 hash 与加载收尾时相同，没有旧 `stella-sources/main` 引用或显式 native RAG extraPaths；Core 没有来源绑定或旧 checkpoint 配置。已安装普通入口不直接导入旧 checkpoint，timeline 的 `memory` 按其路径解析器落在当前 workspace/memory，不指向旧工作树；限定目录的直接 symlink 也无旧根命中。没有读取正文、私密 bootstrap／会话、checkpoint 数据库，不能据此宣称全机或远端所有消费者均不存在。对本机当前 Host 范围已未发现旧根消费依赖，目录写者再处理其范围内外部消费者与写入依赖，无需继续把 Core 当前入口作为未核阻塞。见 [限定消费者检查](../.task-control/reports/CORE-VAL-001/old-main-consumer-check-20261102.json)。本次没有 reload、重启、模型或配置修改。


限定窗口补记：持久 `checkpoints/main/checkpoint.json` 仍绑定旧 `stella-sources/main@644eafa…`；独立 `main-knowledge-migration-v1` checkpoint 仍绑定112。这些文件保留不改，存在不等于旧消费者正在运行。父任务已接受当前 Host 依赖检查，后续不再把它列为未核阻塞。CangHai 写者切换期间，Core 写者不改 Host 配置／加载包／启用旧入口／绑定来源；当前已核依赖不要求额外停止 Gateway。配置或入口若变化则先停止依赖切换并重新协调。权限两项的明确决定与目录写者回执仍须完成；父报告 `.openclaw` 祖先目录为0700且无ACL，所以子目录0755本身不能证明他人可读。精确 checkpoint hash、保留及回滚边界见 [窗口说明](../.task-control/reports/CORE-VAL-001/old-main-checkpoint-window-20261102.json)。


2026-11-02 后续目录交接已完成：登记的 `stella-sources/main` 实核为 detached、干净的 `90f61d9c9ef019c5a06a419dbcb630fe598cb996`，五项选定元数据／许可的工作文件与提交 blob 完全一致且均0600。目录侧批准的权限收紧已由独立写者执行，金融资料未扩入362描述符范围；旧checkpoint和112副本保留。**不再有目录交接阻塞**。Core 已安装解析器通过真实 manifest/profile/grant 的无模型检查，但在配置写入前发现原 `openclaw-device` 请求者与 Host 唯一 canonical profile 不相等；现有 WebChat 适配器要求精确相等，因此未绑定、未改身份或调用模型。该问题是具体入场身份兼容缺口，不应继续写成目录未准备好。证据与不扩权的设备认证接缝候选见 [90f绑定就绪检查](../.task-control/reports/CORE-VAL-001/fixed90f-binding-readiness-20261102.json)。


## 2026-11-03：旧派生对象迁移的实际边界

再次按规则解析旧版来源为 `dev@d423d9e85ae3b2a9a120b7cdc52b3746b592b189`。只比对 Git 树和 blob 标识：`30_RAG/model-seed` 的2份、`self-reflection` 的12份及 `work` 的2份非空文件，在固定 `90f61d9c9ef019c5a06a419dbcb630fe598cb996` 同路径均为相同 blob。没有读取私人正文、复制文件名或修改沧海。这证明这16份原始文件留存，**不是16个新版理解／持续工作对象，也不证明它们全部属于当前97/362许可**。

已知 `50_PersonalAgent/stella/initialization/memory/catalog.json` 在该dev提交不存在；这里只检查这一已知路径，不能推广为全仓不存在其他旧存储。迁移分支 `2ea285d98d21c0882092582141aac92f93fa432a` 的物化器仍拒绝非空 Understanding／Work／Change／Bundle及View。Core的bootstrap也保留同类门禁。现有验证、语义重评及事务可复用，但消费的是已合法构造的结构化对象，不是旧Markdown的自动语义转换器。

最重要缺口是**固定一个实际旧资产及其范围，建立原文、前提／候选／未决、目标对象和LearningChange的语义映射**；源策略审阅不等于这些解释已被确认，不能靠复制字段或重绑hash完成迁移。完整派生迁移尚未完成；已留存原文范围的有限正向问答不必等待全量迁移。核查和最小交接见[迁移审计](../.task-control/reports/CORE-VAL-001/derived-migration-audit-20261103/REPORT.json)，执行状态仍只维护在任务索引。
