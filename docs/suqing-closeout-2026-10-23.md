# 肃清收尾：有限实验模式与剩余边界

更新：2026-10-23。本文补充原始中期计划，不改写旧批次或原四份未提交文件。
用户已委托完成肃清；D-058 收敛为实验性、简洁的纯插件架构。下面按原 SQ 编号核对，
不把批次号当计划号，也不把完整产品愿景重新加入本期。

## 当前可交付结论

`experimental_owner_chat` 的安装包、Core checkpoint、受管初始化、本人连续聊天、
输入一次归档、当前来源工具及跨请求 freshness 已有同包合成证据。原版 Host 负责模型、
工具循环、取消和历史；Core 负责入场身份、来源/权限、首次供给和写入完整性。
没有 OpenClaw 源码修改、provider 代理、输出缓冲或逐轮 reset。

开发 main 已按明确授权加载批17包并重启，健康检查和本地状态验证通过。
**真实网页入口尚未闭合**：当前连接 profile 未取得，尚未绑定 Core owner/来源 grant，
没有进行真实模型/API 或私人记忆外发。不能称为“本人网页记忆聊天已恢复”，
不能关闭完整 full_memory、真实产品效果或发布验收。

## 固定身份与证据层级

| 项目 | 本次事实 |
| --- | --- |
| 运行源码 | `b07d91bbff51f258e77624aad822ae9604a3d6a1`；branch `codex/issue23-integrated-regression` |
| 候选包 | `0.1.0-alpha.0`，SHA256 `7d7b660bdb5a3e894b790390e56130e67308b24b8555384f3f64d320b3a0b17e` |
| 安装 | `.artifacts/suqing-batch17-20261023/consumer/node_modules/@tower1229/stella-core`，487文件逐项匹配包 |
| 标准来源 | 固定跟踪源码快照→npm build/pack→8个已核验本地依赖离线安装，无registry/push |
| 原版 Host | OpenClaw `2026.8.2`，Node `v24.22.1`；公开包元数据/精确接缝核对，不声称完整Host树来源认证 |
| build identity | 保留真实 `b07d91bb/sourceClean:false`；四份旧未提交文件未入包，不改写clean标记 |
| 当前main来源 | `c59504621f4f85060a4aa6a71895e0ae8dfce663`，114条及原策略保留；16缺描述不可用，98待请求语义判断 |
| main状态 | 新包路径、checkpoint RPC、healthz/readyz/startupz验证；源、checkpoint/grant、29文件及暂停环境未变 |
| 本轮代码变化 | 无运行代码变化。另行本地提交正式契约/收尾说明；该文档提交不改变上述运行包身份 |

同名版本号不等于同一包。文档提交后的仓库 HEAD 与运行源码分开记录；本收尾说明是外置
补充，不冒称已经写进旧 tarball。完整命令、时序和文件摘要在本机 artifacts，含私人路径的
聚合/备份不提交公开仓库。这里不输出真实记忆正文或凭据。

## SQ-00～SQ-13 完整节点表

“本期闭合”仅指选定有限模式的交付出口；“部分”保留原题中超出本期的工作。
原始计划的更广标题原样列出，按后续 D-058/用户决定解释，没有偷改全量通过。

| 节点及原题 | 真实状态与本期出口 | 尚未闭合/处置 |
| --- | --- | --- |
| **SQ-00** 冻结事实、原版 Host 来源/完整包或树 hash、Core/dist/harness 差异、旧证据分类、issue 快照 | **部分；有限基线闭合**。固定源码/包/integrity/487安装文件与Host公开版本；旧覆层证据单列 | 未做完整官方Host树认证；禁止整树读取/hash不再重试。issue映射只依据仓库记录，未声称在线状态已核实 |
| **SQ-01** 清算新增接口、私有导入、ambient 声明、Host root override；逐项替换/阻断清单 | **本期闭合**。checkpoint插件分支使用公开SDK，插件入口与实际直接加载均可达 | legacy私有codec/Active Memory等代码仍可能存在，但不属于所选运行路径；全局删除/全量替代后置，不能作为当前能力 |
| **SQ-02** 冻结来源权威/目标/物化/消费语义；最小 store、CAS、eligibility、seed 和迁移契约；替代 D-028 | **本期闭合**。D-059、恢复契约及生命周期明确外置authority、原expected、显式初始化和非双权威 | 同账号外置文件不是强信任隔离；不存在自动seed/防整机回滚承诺；authority≠target≠materialized≠consumed |
| **SQ-03** 文件所有者/消费者清单与实际启用证据格式、变更清单/required 策略 | **本期闭合**。纯文件计划含新增/修改/删除/显式重命名和用户修改冲突；实际receipt列文件 | 未声明/未启用wiki、RAG消费者不扩为本期需求。main现存bootstrap只是保留，未伪造本次受管receipt |
| **SQ-04** 原版最终消费可行性与一个部署目标；取消、重试、历史、额外参数的可观察边界 | **有限目标闭合；真实网页待证**。原版Agent→数据工具→续轮→回答、完整wire、历史和当前来源分开 | synthetic CLI owner正例不证明真实网页profile；不声称逐请求opaque transport身份或完美历史隔离 |
| **SQ-05** 最小 authority store 与跨实例 CAS/原子持久化；复用公开锁/原 journal | **本期闭合**。精确revision/token CAS、幂等重试、原子替换、两OS进程锁与SIGKILL恢复 | 合作进程保守锁；崩溃遗留锁需受控人工处理，不偷锁、不查询PID，不声称任意断电恢复 |
| **SQ-06** 全部 pointer 读写方迁移、初始化/receipt 重新绑定、崩溃接续与旧 binary 行为 | **部分；本期读写闭环闭合**。统一resolver，初始化→owner原话归档Git/CAS→重新读取；CAS后pending可接续 | 未迁移完整learning/correction/outcome/transcript writers；旧binary不混跑。默认legacy保留，选择新模式须显式停止旧writer并初始化 |
| **SQ-07** bootstrap / memory / 可选 bundled-wiki 的显式按需刷新与部分失败处理 | **部分；必要物化闭合**。五bootstrap+声明skill实际写入，备份/所有权/冲突保护，首次发现需一次公开生命周期刷新 | 连续三轮期间无restart/reset；实际wire证明bootstrap和skill目录，未额外声称skill全文消费。普通wiki≠bundled memory-wiki；非本期索引/compile自动化后置 |
| **SQ-08** 按 SQ-04 结论适配纯插件最终消费路径与能力 gate，清除覆层可交付依赖 | **有限模式闭合；真实网页待证/授权**。Host执行/Core供给，无覆层依赖，保留首次来源与权限检查 | 真实profile/grant未绑定，未知旧历史不接管；full_memory=false，不将有限能力标签充当完整验收 |
| **SQ-09** 确定性故障夹具/运行器和原始证据规范，迁移/崩溃/晚完成/旧输入反例 | **本期闭合**。当前包定向故障矩阵，原始命令/退出码/wire/journal、安装字节及包SHA关联 | 已取消的运行中撤权/输出拦截失败原件封存，不改绿；更广所有入口矩阵后置 |
| **SQ-10** 一个原版 Host 上的完整本地合成垂直闭环：初始化→写入→新 turn/session→恢复 | **本期同包闭合**。原版Host证明批17包直接加载、初始化/6文件、3次同会话用户输入、3次归档、B修订和下轮读取；状态恢复/故障接续由E-02同包检查证明 | 该闭环是合成CLI owner和假模型；真实main只验证加载/本地状态，真实网页/模型质量不计通过 |
| **SQ-11** 同一新包矩阵：正常、取消、故障、崩溃、并发、撤权、旧历史/compaction/cache | **部分；本期必要矩阵闭合**。同包49项定向检查，3轮真实Host合成、v3三场景；正常取消单列证据层级 | 运行中撤权/输出拦截取消；长历史compaction/完整入口后置。当前来源拒绝/跨请求资格与正常取消仍必需，不取消 |
| **SQ-12** 冻结能力声明/安装与恢复手册/新包/账本 supersedes 关系及受限候选 | **本地有限候选闭合；未发布**。包/integrity/安装/手册/回退/本表绑定同一运行身份 | 未push/registry发布，不关闭#39；未授予的真实入口不标技术完成。真实用户文件与四旧未提交保持原样 |
| **SQ-13** 整理 #36/#37/#39 后续前置及真实 main 六类场景验证计划 | **规划交付闭合**。当前网页profile诊断受浏览器操作阻塞；身份绑定/真实API待精确授权。下面给准备表 | 文档原有六类是能力而非六个已确认用例；代表场景仍仅按需社交判断/写作共思。真实效果不能由fake模型替代 |

## 同一安装包的本期验收矩阵

以下不是把历史测试总数相加。批16的114项是该源码的开发回归；批17的11项是原有
同安装包profile/RPC定向检查。此次补齐49项针对检查和原版Host路径，分别报告：

| ID | 层级与结果 | 本机原件 |
| --- | --- | --- |
| E-00 | 标准构建/离线安装，487文件匹配；build identity原样保留 | `package-result.json`、`PACKAGING.md` |
| E-01 | 同包11项profile/RPC定向检查通过；正例API stub明确为stub | `installed-tests.log` |
| E-02 | 同包49项定向检查通过，0失败/skip/cancel；缺/坏状态、旧expected、ABA/幂等、write/fsync/rename故障、SIGKILL、双OS进程互斥、用户文件保护、错误身份、首次权限、普通取消、归档与下轮freshness | `closeout-installed-tests.log`、`closeout-result.json` |
| E-03 | 原版Host直接加载安装包，无observer：初始化→6文件→一次首次skill发现刷新→同owner同session三轮，9份完整provider wire，3次归档+1次显式合成修订，B为当前工具事实，A仍可作为历史对话存在 | `host-probe-closeout1/result.json`、`provider-*.json` |
| E-04 | 原版Host直接加载同包：v3正常分页/read/回答、用途拒绝、受众拒绝，3场景；43份wire=7Agent+36策略判断，受众拒绝0请求 | `host-v3-a1/result.json`、`provider-*.json` |
| E-05 | 正常取消通过：公开observer/fault wrapper加载同安装runtime，1次请求/list后Host接受取消，0续轮、0最终答案/历史答案，Gateway exit0；不是direct installed registration，也不依赖Core输出拦截 | `closeout-host-cancel.json`、`host-probe-cancel1/result.json` |
| E-06 | 原版Host直接加载安装包，仅stella.identity RPC，无profile时拒绝；provider请求0 | `host-identity-a1/result.json` |
| E-07 | 目标main已加载同包、同Gateway重启与三个健康端点200；状态RPC，487字节匹配、29文件及源/许可/checkpoint/暂停开关不变 | `../main-webchat-profile-load-20261023/verification.json`、`ALIGNMENT.md` |

除E-07外均为隔离合成工作区/状态和loopback假模型；原件根目录为
`.artifacts/suqing-batch17-20261023/`。fake provider检验协议/供给与真实消费内容，
不检验真实模型理解、引用纪律或产品效果。E-03首次设置中发生一次Gateway刷新，
**三轮对话期间零reset/重启**；不能将前者藏掉，也不要求每轮reset。

## 四类收尾：必需、延期/取消、缺证据、需授权

1. **既定有限模式必需**：原版公开插件可安装、入场本人/受众、首次来源权限/版本、
   文件所有权、原expected CAS/journal、正常取消、每次用户输入只归档一次、下轮读取
   当前版本和保留正常历史。对应上述同包证据，不靠修改Host或全局改绿。
2. **明确延期/取消**：完整学习/correction/outcome、完整transcript/附件、长期compaction、
   更多来源模式、可选wiki/RAG/index、多能力#35/36/38全量矩阵后置；运行中撤权、
   已发送内容撤回、provider代理/输出缓冲取消。后置不代表产品需求被删除。
3. **缺证据**：真实网页profile/正向owner链、本人真实记忆供给效果、真实模型质量、
   全新Host/registry安装、完整Host树认证。无证据即未知，不以包加载/模型模拟替代。
4. **需精确授权**：取得真实profile之后的owner与processing grant绑定、真实模型/记忆
   外发和费用、其他新增安全权限、新凭据、push/发布。已有main加载/restart授权已执行，
   不再重复作为阻塞；没有泛化到上述动作。

## 依赖收敛与里程碑

- M1（SQ00～04）事实/契约/原版机制：有限目标已收敛；完整Host认证与更多消费者未知项仍如表保留。
- M2（SQ05～09）Core状态/必要文件/纯插件接线：有限路径已实现并复核，完整writer迁移后置。
- M3（SQ10）同包合成垂直闭环：本轮以批17安装包重新闭合，不借旧包冒算。
- M4（SQ11～13）有限矩阵/候选/真实准备：本地收尾完成；真实网页身份与实际使用执行仍在精确权限边界。

独立的本地路径为 `SQ02/03/04 → SQ05/06/07/08/09 → SQ10 → SQ11 → SQ12 → SQ13准备`。
当前最短用户可用路径是 `取得现有网页profile → 精确owner/grant绑定 → 获准真实数据/费用范围
→ 新空会话首次接入 → 同owner连续聊天及下一请求当前记忆验证`。只有后半段依赖外部授权；
不再为等待身份把文档、同包矩阵和本地候选停住，也不把后置full_memory功能插回这条路径。

## 真实网页入口：最短剩余路径

当前Chrome在运行，但已有工具无法操作网页连接：无现有CDP端点，AppleEvent超时
`-1712`。这不是已证实profile为空或TCC被拒绝。未开启新调试权限，未重放真实聊天，
也没用CLI身份冒充网页。一次诊断路径已停止；其他收尾独立完成。

1. 用户在**现有本机网页连接** Settings→System→Debug/manual RPC调用
   `stella.identity`，参数 `{}`。不走chat.send，避免Host独立标题辅助请求。
   返回只读当前连接profile元数据；若缺profile就先报告公开Host身份配置事实。
2. 取得可信ID后形成一次性精确变更：`webchatOwnerProfileId=<真实ID>`，既有v3
   processing grant的`requesterIds`追加`openclaw-profile:<同ID>`，保留Telegram、用途、
   受众、模型与全部对象原策略；作用域仅main本人。该步骤**尚未授权/执行**。
   来源需明确新commit及精确checkpoint CAS，不能把当前HEAD自动升为expected。
3. 首次使用新的空会话，避免接管未知旧历史；绑定后同本人正常连续聊天无需逐轮reset。
   旧会话不删除、不改写。真实模型调用前另按下节确定可外发内容和费用。

真实源的16条缺描述对象继续不可用，不能通过扩大grant或读正文补描述来绕开；其余98条
仍按具体请求语义判定，业务拒绝不算技术失败。本轮不改真实源策略或新增记忆许可。

## SQ-13：真实模型与六类产品能力的准备清单

[需求§1](09-REQUIREMENTS-ALIGNMENT.md#1-产品目标与完整功能) 的六类是产品能力；
[§1.3](09-REQUIREMENTS-ALIGNMENT.md#13-本轮以两个场景检验架构已确认) 只确认按需
社交判断和写作共思两个代表场景。以下是**准备建议而非新增必过用例**：

| 原能力名称 | 最小材料/问题 | 后续权限与证据边界 |
| --- | --- | --- |
| 回忆与查证 | 用户选定小范围来源/版本、精确描述、可核对定位与问题 | 允许该范围外发；检查当前工具来源/时间变化，非全库检索完成 |
| 现实决策与行动 | 一个目标、约束、个人情境/框架 | 先仅建议；真实行动API另列服务/对象/动作，实际结果由用户提供 |
| 个人事务管理 | 一个事项的目标、承诺、期限、进展和开放问题 | 先接续讨论；调度/提醒/外部写入另授权，不恢复暂停任务 |
| 思考、学习与创作 | 指定稿件/想法、作者意图、卡点及材料 | 写作共思优先，不默认代写/发布；作者反馈才证明帮助有效 |
| 数字分身 | 特定情境、既有选择证据及后续实际反馈 | 预测与实际分开；当前原话归档不冒充Twin语义学习writer |
| 自我理解与成长 | 有范围的情境、解释、反证及框架版本 | 正式采纳和提案分开；当前有限模式不冒称自动框架修订 |

真实小规模检查建议先一条回忆/查证和一次写作或按需社交讨论；不为凑六类扩大本期。
具体问题/允许资料由用户选定，不能替用户指定整库可外发。

精确授权单须包含：当前可信网页profile/requester；google/gemini-3.8-flash、low；
已有非秘密凭据引用及是否允许运行进程使用（不显示/复制密钥）；本次用户输入、实际
bootstrap/skill、正常历史、工具schema、审核描述/策略元数据及准入原文的最大范围；
Agent、辅助策略判断、Host标题请求及重试均计入请求/token/费用上限。旧9次预算不复用，
maxTokens不等于金额硬封顶；若没有可验证硬封顶，应明确软限制和停机条件，无法确定则
停止真实调用。当前没有成本/真实请求授权，未探测真实API可用性。

#36冻结准入、#37真实main效果、#39最终发布/总账是后续独立出口，不能由本表关闭。
没有在线更新issue或发布任何内容。阶段交付是有限候选与精确剩余路径，不是完整产品完成。

| 原主线/issue | 本期关系及出口 |
| --- | --- |
| #23 | 保留来源/权限/新用户请求freshness的核心目标；D-058允许历史对话存在，取消运行中追溯收回。90bd4a46、旧8d真实验收及9a4b9643覆层结果均不转作当前包通过 |
| #35 | 原十二能力整合仍属更广能力，当前有限owner聊天不关闭它 |
| #36（work36/37） | 最终版本冻结和十二能力完整准入；本期只冻结有限包，未伪造十二收据 |
| #37（work38） | 真实main六类能力/两个代表场景的实际效果，准备已交付、执行未验收 |
| #38（work39） | 更广同版本故障矩阵后置；D-058已取消的运行中撤权不重新加入 |
| #39（work40） | 最终安装/版本/总账及必需项核对，不因本地有限候选而自动关闭总任务 |

映射依据仓库 `src/acceptance/delivery-catalog.ts` 和原计划§10；没有联网推断issue现况。

## 可复核操作与证据留存

所有命令使用显式项目cwd `/Users/zangtao/Workspace/tower1229/Stella-Core`，新产物在非iCloud
`.artifacts/`；没有向Documents/Desktop/iCloud写入。运行记录含原命令/最小环境和退出码。
原执行器不再运行，复核先读JSON和日志，不盲目重启测试；确需复现应选择新的唯一attempt/
合成state路径，保留旧原件。`run-closeout.py`是本机一次性运行器，已有输出时拒绝覆盖。

- 安装与11项检查：`package-result.json`记录标准npm build/pack/install和测试命令。
- 新同包矩阵/连续对话/v3：`closeout-result.json`及`run-closeout.py`记录具体命令、隔离环境、PID和exit。
- main加载：`../main-webchat-profile-load-20261023/state.json`、`verification.json`、`ALIGNMENT.md`。
  回退仅恢复本次load.paths且核对无并行变化，不回退源/checkpoint或后来有效输入。
- 原始四份未提交文件保留原hash、不加入本提交或包；包内只含声明必要说明。
- 历史9a4b9643 Host覆层及其证据仅归档，不再部署/续测；批8/9旧撤权失败仍按当时语义保留。
  旧包03f79079/495667d5和当前7d7b660b逐包区分，不累计为当前包通过。

主计划原题中超出有限模式的“全部”仍有后置项。若用户希望关闭完整full_memory/Alpha/发布，
必须按相应契约重新明确范围，不能从“完成肃清”推导真实外发、身份授权或发布权限。
