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
| Agent 读入口 | [checkpoint-agent-supply.ts](../src/openclaw/checkpoint-agent-supply.ts) 的 `stella_memory_data` 只接受 `list/read/skill`，该路径 `toolsAllow` 限定此工具 | 领域数据如何成为这个入口可读的版本化 Source/Evidence，或另一个经过明确设计/许可的窄工具。领域 CLI/Skill 完成不等于已进入当前 Core catalog、工具循环或来源许可 |

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

下一条接缝是显式 producerBase→candidate 数据投影导入：保留消费侧配置/身份/grant，
原 catalog 与 producerBase 不一致时冲突拒绝，首批不做通用 merge。通过已有精确 journal、
直接子提交及 CAS 发布 Core 自己的消费 revision；producer candidate 与消费 revision分别记账。
新的 Source 版本仍需已有 grant 中精确 reviewed descriptor，导入不复制候选 grant或自动
放行新来源。原始 Git 对象的本地保留不等于 authority 已接受，更不自动采用生产 dev/HEAD。
