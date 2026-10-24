# Core／沧海主线剩余任务矩阵

核对日期：2026-10-24。本文更新[肃清收尾](suqing-closeout-2026-10-23.md)和
[主线生命周期记录](mainline-request-lifecycle-2026-10-23.md)，不改写其历史版本、计数或授权。
遵循 D-058 的实验性、简洁原则与 D-060 的生产保护；有限实验模式成功不等于完整产品完成。

## 当前交付与版本

| 对象 | 本轮已核实事实 | 证据与边界 |
| --- | --- | --- |
| Core 开发源 | `486138a936817e545a1de53302dc4b8633ed55eb`，`codex/issue23-integrated-regression` 已推送 | 本文是后续文档，不能冒称包含在该运行包中；未合主分支或发布 |
| 有限实验包 | npm `0.1.0-alpha.0`，SHA256 `37235460a9f7996d1a61fd875ff2c990e35b2d41041b6e1b0b3373c5c9e2f303` | [实验 CI 40086768187](https://github.com/tower1229/Stella-Core/actions/runs/40086768187)终态成功：1134/1134，0 跳过／取消／失败；496 个安装文件匹配 |
| 实际 Host 消费 | 原版 OpenClaw 2026.8.2，8 份必需报告、127 次 loopback 请求、10 次测试 Gateway 正常退出 | 初始化／本人连续聊天／一次输入归档／下轮 freshness、v3 策略、快照导入、Skill 正文与预算拒绝、Work 及可选纠正机制；全部合成资料／假模型 |
| 完整能力评估 | [40086768233](https://github.com/tower1229/Stella-Core/actions/runs/40086768233)已终态失败，152 项计划保留 | main-2/3/4 通过；memory-access/native-chain/main-1/final 在 `verification_code_identity_unavailable` 失败，汇总失败。没有重触发、跳过或将完整能力改绿 |
| 沧海契约候选 | `7d0538873998397c56a1e8902010a1e7d1742e61`，独立 `codex/warehouse-core-contract-v1` 工作树 | 固定合成投影已与 Core 联调；契约版本 `3.0.0-alpha.0` 与 npm 版本分开。既有导入不自动接受新源权限或生产 dev |
| 沧海金融通用代码 | `1974145f3bf23af319abe3f31c0106cb01cc033f`，`codex/finance-skill-isolation-v1`，基于上述候选，工作树干净，未推送 | 12 个通用文件：Skill、package/lock、5 个业务脚本、4 个合成测试文件；11 个与原件一致，只有 Skill 文档去除了未提交规范依赖。4/4 新合成验收通过，提交字节与已测文件一致；没有重复跑完整 37 项 |
| 生产与真实数据 | 沧海生产 dev、旧目录／消费者及原有未提交内容未变；本轮未部署真实 main | 私密录入已另行交付，不属于通用代码或公开 Core 成果。真实金融记录、账号、截图、回执、授权配置及 artifacts 不入此仓库或远端 |

8 份报告的请求分项为连续聊天 9、v3 43、快照导入 44、Skill 8、两项预算拒绝各 0、
Work 9、纠正 14。fake provider 证明协议与供给机制，不能证明真实语义质量、全部自动学习、
真实网页本人授权或 full_memory。Core 运行原件位于本机
`.artifacts/checkpoint-agent-correction-20261024/ci-486/verified-evidence.json` 与
`full-assessment-final.json`；这些 ignored 原件不提交。

## 剩余任务分类与最短依赖

| 分类／节点 | 当前状态 | 下一步及验收出口 |
| --- | --- | --- |
| 已完成：有限聊天与写入底座 | checkpoint authority／精确 CAS／保守锁、显式初始化、受管文件保护、连续聊天及原话一次归档已验收 | 保持现有语义；不重复历史测试累计“进度” |
| 已完成：#31 窄项 | 当前包 Skill 全文／角色顺序／预算拒绝与实际 Host wire 已验收 | 真实模型是否遵循指令属于独立效果验收 |
| 已完成：#24 的有限前置 | checkpoint 本地纠正 writer、只读 Work、默认关闭的正常 Host 纠正工具已接通 | 仅代表一条有本轮 Evidence 的纠正机制；不关闭 #24 或全部 learning/outcome |
| 已完成：沧海代码隔离 | 通用金融代码已在独立分支本地提交；没有携带真实数据、安装旧消费者或推送 | 后续同步／安装／真实消费另定；当前不需为维持并行重复开发 |
| 下一独立工程项：Current Understanding 消费 | 已确认现有纠正 writer 支持 understandings，但数据工具尚无对应动作；本轮接线完成，定向测试已通过、同包验收待执行 | 给既有工具增加只读 `action:understanding`，复用当前权限／模型／SourceAccess；保留 USER/MEMORY 分区、scope/status/refs 与 usageConstraints，不写 USER.md、不返回原文／context |
| 上项验收依赖 | 初次夹具创建被审批拒绝且未执行；补交原始授权后同工具／同路径唯一重试成功。夹具、供给接线及同包探针已准备；124 项相关回归及 27 项 CI 证据检查通过，同包验收待执行 | 做 Understanding A→现有纠正工具 B→同轮及下一用户请求读 B；完整 wire、旧缓存失效、暂定解释不升级为主人事实、必要拒绝例。当前不能算已验收 |
| 待身份事实／精确授权：真实网页 | 现有网页 `stella.identity {}` 尚未取得可信 profile；已有浏览器控制路径已停止 | 先读同一网页真实连接元数据，再单独确认 owner/profile 与原 source grant 的精确绑定；不以 CLI／Telegram 伪装替代，不接管未知旧历史 |
| 待精确授权：真实 main 新包／工具 | 本轮没有加载新包、打开可选纠正工具或改 grant | 固定包、回退与当前状态核对后，分别明确加载／工具许可／语义写入范围；本地原话归档不自动授权一切语义写入 |
| 待数据／费用范围：真实模型 | 没有执行真实模型或私人资料外发 | 确定真实 profile、已有凭据引用使用、端点／模型、允许输入与 bootstrap/skill/历史/schema/策略／原文范围和费用边界；计入辅助语义调用、标题请求与重试。SDK retries 和 maxTokens 不能冒称总请求／总费用硬上限 |
| 后置：Outcome／Prediction | 仍依赖 EpisodeRepository、封存预测、实际行动／结果证据和已消费上下文；旧事务／恢复尚非完整 checkpoint 接线 | 先冻结最小真实结果契约，不能只替换 persist helper、虚构 outcome 或把缺失依赖统称网页阻塞 |
| 后置：consolidation／全量学习 | consolidation 目前是另有 operator grant 的 legacy 管理入口；checkpoint learnCheckpoint 明确拒绝该模式 | 不自动激活、不另造框架；按实际产品需求独立收敛 |
| 后置：更广数据与完整验收 | 完整 transcript／附件、长期 compaction、更多 wiki/RAG/index、完整 Twin/Praxis、#35–39 全量出口 | 本期有限实验成功不算这些完成；原有完整失败和接受标志保留 |
| 已取消：极端即时收回路线 | D-058 已移出运行中撤权、流式／历史输出拦截、provider 代理／缓冲 | 不复活为新必过门槛；首次来源准入、正常取消、写入完整性和下一用户请求 freshness 继续保留 |

最短独立开发链为“Understanding 只读消费与缓存接线 → 定向测试 → 同包正常 Host
三轮验证”；不需要沧海改格式或生产迁移。最短本人真实使用链为“网页真实 profile →
精确绑定 → 固定新包／最小工具范围 → 获准数据与费用 → 小规模实际使用”。两条链可以分开，
不能因后一条未获授权而把全部工程标为完成或全部停住。

## 原 SQ 节点现况

原题见[完整 SQ 表](suqing-closeout-2026-10-23.md#sq-00sq-13-完整节点表)。这里只记录增量，
不重新定义原题中的“全部”。

| 节点 | 当前出口／尚未闭合 |
| --- | --- |
| SQ-00 | 有限源码／包／安装身份闭合；完整 Host 树认证仍未知且不绕过整树读取限制 |
| SQ-01 | 所选 checkpoint 公开插件路径闭合；未将 legacy 私有路径冒作新能力 |
| SQ-02 | D-059 authority／目标／物化／消费语义闭合；不承诺同账号状态文件形成强隔离 |
| SQ-03 | 必要文件所有权／计划闭合；非本期消费者不自动增加 |
| SQ-04 | 原版 Host 有限 Agent 工具循环闭合；真实网页主体待事实 |
| SQ-05 | 最小 store／CAS／故障接续闭合；保守锁不自动偷锁 |
| SQ-06 | 原话归档、显式快照导入及有限纠正已接线；其他 writer 仍部分，Understanding 消费待实现 |
| SQ-07 | 必要 bootstrap／Skill 物化与当前包全文消费闭合；非本期 wiki/RAG 刷新后置 |
| SQ-08 | 有限 Host 执行／Core 供给闭合；真实网页绑定与新包接入未完成 |
| SQ-09 | 本期必要故障与原始证据规范闭合；未承诺所有未来入口矩阵 |
| SQ-10 | 当前安装包 8 报告合成垂直路径闭合；不冒称真实模型效果 |
| SQ-11 | 当前必要有限矩阵闭合；完整评估失败、长期历史等后置，运行中撤权取消 |
| SQ-12 | 有限候选和 Core 开发分支推送已完成；没有 registry 发布／合主分支，沧海未推送 |
| SQ-13 | 精确真实接入准备已具备；实际身份／资料与费用授权及真实效果仍未验收 |

## 两仓接口与单写者

继续使用既有 manifest/profile/catalog、Source/Evidence、Understanding/OngoingWork、
LearningChange 和原来源策略；本轮没有新协议或沧海 schema 变更。Core writer 只推进
已选择、独占的消费副本及 checkpoint，不直接写生产 dev。沧海通用金融 Skill／CLI 是领域
数据操作入口，不因代码已经隔离就自动进入 Core catalog、资料授权或 Host 工具许可。

沧海代码隔离分支是通用代码交付，领域投影候选是固定合成联调基线，私密数据是另一个
获准本地任务；三者不能混用提交／测试身份。下一批 Understanding 由 Core 单集成写者负责，
合成夹具与独立审查可分文件并行。真实 main、生产 dev、私人源策略、身份／凭据、安全设置、
沧海 push 和发布都不由“持续推进”推导成泛化授权。
