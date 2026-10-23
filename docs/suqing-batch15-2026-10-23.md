# 肃清第十五批：v3 安装包与原版 Host 合成验收

本批以 `1fdeb3966a582fcca6eeea34cdfe80d6f6879e31` 为基线，仅做 Core 本地候选、合成 Host 验收和真实 catalog 元数据方案。main、真实源及候选分支不变；没有真实 provider 调用、私人 payload 读取、凭据、push 或 OpenClaw 修改。最终本地提交见 `.artifacts/suqing-batch15-20261023/delivery.json`。

## 固定包、安装与加载

- 最终 tgz：`.artifacts/suqing-batch15-20261023/rebuilt-a3/packages/tower1229-stella-core-0.1.0-alpha.0.tgz`。
- SHA256：`495667d560d4a88ded0e2bb28875932c140e7756ae9863d0f53412a9bbd65ed5`。
- npm integrity：`sha512-FZWaWZ4hWOr99034uoZNS/d1jBTqhmQdlNHAIItUBtfqhkSi/SisKPIZxYvOK7rEAigyrb7DDa745TOKyLqDjQ==`。
- 标准 npm build/pack；全新 consumer 离线安装；484 个文件逐个核对，结束后均未变化。只复用 8 个已核验本地依赖 tgz 和现有 Host 的具名公开入口，没有下载 registry、复制或递归读取/hash Host 安装树。
- build identity 如实为 `1fdeb396… / sourceClean:false`，包含本批小型适配修复。最终提交的运行文件与被测快照逐文件 hash 绑定，不冒称旧 baseline 本身就是全部最终源码。包版本仍 0.1.0-alpha.0，以 hash 区分；没有重发或发布 registry。
- 原版已安装 OpenClaw 2026.8.2，Node 24.22.1。Host 直接通过 plugins.load.paths 加载 rebuilt-a3/consumer 的实际安装入口；成功运行没有 observer wrapper。不能据此认证完整 Host 树来源。

## 实际阻塞和最小修复

首轮真实 Host 已加载包，但 list 返回 source_access_model_failed，只有两份 Agent wire，辅助判断 0 份。去掉不必要的显式模型覆盖后，目标 Agent 覆盖仍被 Host 拒绝；独立、明确标注的合成 observer 记录公开错误：`LLM_COMPLETION_NOT_AUTHORIZED: Plugin LLM completion cannot override the target agent.` 这些失败没有算通过，旧包/旧请求保留。

修复只使用公开 Host 默认：仅当配置恰有一个、匹配请求的 Agent，且 systemAgent 没有另指时省去 agentId；始终使用该 Agent 配置模型，不请求模型覆盖。调用前后固定模型和这项选择，返回的 actual Agent/provider/model/direct-provider 仍须准确匹配。多 Agent/另指的 systemAgent 保留显式目标，继续由 Host 权限决定；没有自动增加 llm 权限或退到另一 Agent/模型。没有新权限框架、代理层或 Host patch。

## 分层结果

| 证据层级 | 结果 | 可证明范围 |
|---|---|---|
| 标准 build、测试夹具编译 | exit 0 | 最终全部运行源码与被选测试可编译 |
| 实际安装包最小回归 | 13/13，0 fail/skip/cancel | API stub、v3/精确绑定/取消/分页/默认 full-memory 严检及单/多 Agent 选择；不是 Host E2E |
| 原版 Host + 安装包 + loopback fake provider | 3/3 场景 | 正常供给、禁止用途、共享受众拒绝；实际公开 LLM 和 Agent 接缝 |
| 原始 provider 请求 | 43 = 7 Agent + 36 策略判断 | 全部记录完整 wire；两种请求 thinkingLevel=LOW，无真实模型质量或成本结论 |
| 测试脚本写前路径保护 | 3/3 | 合法配置通过、越界和 symlink 配置在任何新产物/源/Gateway之前拒绝 |

正常请求遍历 18 条合成 v3 retain 资料，第一页16条、第二页2条，随后 read E18，再由 Host 续轮回答。实际最终请求包含该原文及 keep_scope/quotePolicy=summarize_only。辅助判断的请求包含问题、审核描述和策略，不含原文。

禁止用途场景使用独立新会话，18 次合成语义 verdict 选择原策略禁止的 relationship_judgment，两个 list 页分别排除16/2条，没有供给正文；返回拒绝回答。它验证结构化策略执行，不证明假模型理解自然语言。共享 group 地址在 Core prepare 拒绝，额外 provider 请求为0；未声称验证其 WebChat 投递/历史展示。正常 Host 历史仍由 Host 管理，本批没有运行中撤权或输出拦截测试。

成功探针 runner PID70323、Gateway PID70478 均正常退出（Gateway exit0）；全部本批登记的打包/测试/探针进程已结束，fake provider关闭，自己的合成源已清理，原始请求/状态保留。main 服务未停止或重启。

独立审查后仅给脚本增加写配置前的 canonical state/config 父目录及 regular-file/symlink/hardlink 检查。成功 Host 所用原始脚本 `tested-host-probe.mjs` 和其 hash 保留；最终脚本只增加该前置保护并跑三项 preflight，无重复 Host/model 回环。该脚本不在 npm 包内，包运行字节不受此改动影响。

## 保留全部114条真实记忆的兼容源方案（未实施）

当前源 `396d7ca422e735fb636faf57764a478f335ff5eb` 干净；`local/stella-owner-chat-candidate-20261023` 仍为 `6cd154ce1d7129e6be3a234c4e29edff83dfa096`。后者空旧记忆的方案不是接入目标，本批没有改任何一个。

只读解析仍为：114/114 可解析，98 需要具体可信请求与语义策略判断，16 另缺精确分段描述，0 技术损坏；未运行真实判断，所以实际允许/按策略拒绝数量未知。保留原 catalog、所有对象/源/策略/用途/受众和原 processing grant；16条继续明确不可用，不能整文件授权代替片段审核。full_memory 依旧未验收。

未来兼容 manifest 候选路径为 `50_PersonalAgent/stella/experimental-owner-chat-v3/manifest.json`，只复制原 manifest 并按所选源树修正已有 modelPolicy blob pin；继续引用原 runtime-profile、catalog 和 processing grant，明确运行能力只是有限工具模式。当前 pin 是 f24ca0df…，所选源树 blob 是 6769cec8b44412255cf3188df797b0bee4abfc59。不得只改 profile 标签或生成空 catalog 掩盖缺口。新源 commit 本批禁止创建，故其40位 revision 尚无，必须形成/审核后才可供 initialize 显式选择，不能拿旧 HEAD 自动初始化。

额外已证实：现有 processing grant **不允许 cli**。这不等于不能用 UI，也不证明 UI 已具备 owner/direct；后者实际映射尚未知。需先确认 UI 对应的可信主体已在原 grant 中；若确需新增 cli 或其他 requesterId，那是单独的精确授权变更，本批没有添加或伪造。

## main 未来授权清单（本批停在此之前）

1. 固定上述保留114条的兼容源新revision和manifest路径；目前只有原396d7ca，未来revision待生成，6cd154ce不可冒用。
2. plugins.load.paths 对齐本批固定包，先核验备份及当前本机兼容性；consumer只是测试目录，不自动把它当main长期安装位置。
3. `plugins.entries.stella-core.config`：recoveryAuthority=core_checkpoint，checkpointStateDirectory=/Users/zangtao/.openclaw/stella-core/checkpoints/main，agentMemory=fresh_tools，requestArchive=local，manifestPath设已审阅兼容manifest；agentId=main、原canghaiRoot和dataMode=local_write保留。去除 recoveryRevision 和 legacy initializationGatewayAccess；若存在其他互斥 legacy 字段先单独核对。
4. 创建仓库外状态目录并通过公开 initialize 显式选择该新revision；会持久改变恢复权威，不能将观测 HEAD 当授权。
5. `agents.entries.main.tools.alsoAllow` 保留 timeline_resolve，只追加 stella_memory_data；它使本人请求能按原策略使用旧记忆。已有 hooks.allowConversationAccess 不扩展，memory-core/真实bootstrap不动，Telegram和四自动任务暂停保持。
6. 核实实际 UI senderId/owner/direct 与 processing grant；新增 requesterId 必须明确单列，不能泛化为全部本机浏览器/CLI自动有权限。多 Agent如需LLM目标覆盖仍按Host既有权限，不自行扩张。
7. 真正 Agent及辅助判断向外部 provider 发送资料和计费仍另行授权；其可能范围包括问题、审核描述、策略、被准入原文、bootstrap/skill及聊天历史。43份本机fake请求不是旧9次真实请求预算的依据；不得沿用旧预算或把 maxTokens 当费用硬封顶。

真实副作用仍为0：main config/checkpoint/许可写入、真实源策略写入、真实模型API、凭据读改、push。此前main迁移审批拒绝不重试。普通本地可逆候选交付不授予上述切换或外发权限。

原始证据位于 `.artifacts/suqing-batch15-20261023`：最终 rebuilt-a3/package-result.json、host-launch-a1.json、host-v3-a1/result.json 和43份 provider-N.json、preflight-result.json、real-metadata-summary.json、compatible-source-plan.json。早轮包及拒绝诊断均保留。真实catalog聚合没有复制私人正文进代码/fixtures/报告。
