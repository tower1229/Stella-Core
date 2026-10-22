# 肃清第六批：原生 Agent 的 Core 只读供给接线（真实 Host 验收受阻）

本批基线 `ab5864c8889da1db021f5f2d96e09dc05aeb2ac7`。最终本地提交、逐文件源码和原始命令/退出码见 `.artifacts/suqing-batch6-20261022/delivery.json`。本批只有 Core 源码、合成夹具、隔离探针及文档；未生成安装包、推送或部署。

## 结论及范围

最终 a5：typecheck、定向编译通过，**99/99 定向测试 + 3/3 legacy 注册检查**通过，无 skipped/cancelled。99 项包含本版同产物复核的 batch5 77 项和新的供给路径测试（含父/子测试计数），不是历史通过数累加。

已经实现显式 `agentMemory: fresh_tools` 的原生 Host Agent 供给接线：公开 reply_dispatch 认证 owner/direct 与真实物理 session → Core 冻结 checkpoint/resolver → return undefined 交还原生 Host dispatch → before_agent_run 准入无历史的新物理 session → Host 调用 stella_memory_data → Core 校验并释放资料 → Host 自行续轮与回答。没有启动嵌套 Agent、另造 completion/provider、恢复旧 opaque 信号或强身份 capture。

**上述完整时序目前仅通过合成注册/编排夹具验证。** 夹具使用真实 SDK 的 command-auth/routing/session-store；Host gate/tool loop 与模型继续部分是合成驱动。测试中的 modelRequests 数组只表达编排场景，绝不作为实际模型消费证据。Core `runtime.llm.complete` 与配置写入计数为 0。

真实隔离 Host 探针没有进入 Gateway：CLI 的 SQLite 只读 worker 被本批额外文件沙箱阻止，provider 请求合计 **0**。因此本批没有证明“真实 Agent→工具→模型续轮→回答”，也没有证明实际续轮撤权。本结果不等于公开插件机制不可行，更不等于 Mac 执行服务断线；是本次真实验收的明确前置阻塞。

## 实现与原版边界

新增 `checkpoint-host-request.ts`：只接受公开 Host ingress 的稳定 run/body/timestamp、owner/direct 和真实 SDK session entry。创建及重查都使用现成 resolveTurnAudience/assertPrivateContextAudience，结构化 group/channel/cron/subagent key 不能借 direct envelope 获准；配置 enabled/精确 opt-in、sender、sessionId/存储位置、取消在每次供给中重查。模型参数不能提交这些身份或权限。

`checkpoint-agent-supply.ts` 使用公开 registerTool/on：

- 原生 reply_dispatch 只准备调用资格与异步 before-delivery 校验，然后 return undefined；认证失败显式 handled，不放行默认模型路径。archive-only 接管与该新模式互斥。
- before_agent_run 要求与 ingress 相同的 run/sessionKey/sessionId、可信 owner、空历史和未使用的新物理 session。run 和 session 的占位在异步检查前完成；旧会话、重复调用、未准备 ingress 都阻断。其他 Agent 不受影响。新物理会话由 Host 的既有 new/reset 生命周期创建；Core 不伪造会话身份，不执行 reset，也不把 reset soft 当作清除历史。
- before_prompt_build 将工具范围收窄到 stella_memory_data；before_tool_call 验证 Host run/物理 session/toolCallId/取消信号。execute 自身也要求这一调用许可，因此 hook 未运行、超时或错误不能单独授予正文。非该数据工具仍阻断。
- 工具只接受 list 或已列出的当轮 handle。身份、用途、模型、权限、路径都不能从工具参数取得；额外字段、无许可 read、跨 run 调用、未知 handle 明确拒绝。
- 列表/原文复用 CatalogReader 和 EpisodeEvidenceResolver，核来源、evidence 双重 policy、当前资格/依赖/segment/payload hash。没有用关键词或词面评分做语义检索；Host 模型通过工具资料自行选择。列表 preview 本身也按资料释放处理，不能因它不是全文而绕过授权。
- 首批仅支持允许 Host 留存的 retain/v1 policy；do_not_retain、有 restrictions/usageRules 或另有 personalContextAccessPath 的 profile 拒绝。后者现有 requester/model/descriptors 许可不会被静默忽略，也没有偷偷接回旧语义模型派发。full_memory profile 明确拒绝。
- 每个运行只捕获一次原 expected；所有异步读取、已释放依赖及返回前再次验证 checkpoint、catalog、来源、权限、活动和取消。最后 await 之后还有同步活动/取消检查。后续 Git B 不更新旧 A 资格。agent_end 禁止后续工具正文，但正常结束后的投递可独立核当前依赖；投递失败永久关闭该次 deliveryOpen。

新模式是有限实验接缝，尚不是可部署的正常 Agent 候选。status 的 agentMemory/full_memory 仍 false，freshSessionTools 仅表示该配置选择；materialized/consumed 不冒充已证明。默认 legacy、archive-only、旧 writer 阻断保持。调用资格容量上限 64、工具许可上限 256、单次资料上限 64，超限明确失败，不静默回收旧资格。没有增加持久暴露账本或新的 epoch/许可平台。

## 同版本已验证矩阵

| 场景 | 已观察结果 |
| --- | --- |
| 合成原生 Host 编排：准备→gate→list→read→模型继续→正常结束→投递 | 真实 Core 资料链成功；编排/模型为合成，不能称实际 transport 通过 |
| 未准备 ingress、旧 history、错误物理 session、复用 session | gate block，工具正文拒绝 |
| group envelope、结构化 group/channel/cron/subagent key + direct envelope | 不能产生有效调用资格 |
| 缺 before-tool hook、额外 path 参数、未列 handle、跨 run 许可 | execute 或公开 tool gate 拒绝，无正文 |
| list 后撤销插件许可、删除 payload、父取消、registration close | 新 read 拒绝，晚到答复校验返回 null；此前已交付内容不声称可撤回 |
| 读取期间 agent_end | 异步校验后活动资格失效，正文不返回 |
| 已配置 personal-context access / do_not_retain | 明确拒绝不支持的授权组合或来源，不降级绕过 |
| 独立真实本地 writer 将 A 精确 CAS 至 B | 旧 Host grant 拒绝，投递拒绝；不以观测 B 升级 A，当前 B 不被回滚 |
| batch5 实际 archive/Git/CAS、journal 攻击、Git replace、loader/cache/初始化等 | 本版同编译产物重新通过其 77 项；无旧覆层账本复用 |

只读独立评审发现并复核关闭了三项问题：结构化受众未校验、异步失活后返回正文、已配置 personal-context access 被遗漏。收尾增加最后 await 之后的同步活动检查。没有删除安全门禁凑通过。

## 真实 Host 尝试：准确阻碍与执行状态

探针 `scripts/probe-checkpoint-agent-supply.mjs` 使用安装的声明版本 OpenClaw 2026.8.2 公开 GatewayClient/插件接口、专用回环端口、Google 协议 fake provider、假 API key 和合成仓库。模型目标固定 google/gemini-3.8-flash、LOW，无不支持的采样参数。wrapper 只记录公开回调，不改 Host 事件身份或替换 Agent/transport。

子进程使用允许列表环境，OPENCLAW_HOME/STATE_DIR/CONFIG_PATH 为项目专用位置；未改 HOME/CODEX_HOME。额外 sandbox-exec 拒绝私人目录内容、外网、安装目录写入和 ps；只允许已知源码/Node 路径与本批状态。没有读取真实凭据或生产配置。

| Host 尝试 | 原始结果 | 是否执行 Gateway/模型 |
| --- | --- | --- |
| host-probe-a1 | sandbox-exec exit 65：`host must be * or localhost in network address`，规则语法问题 | Gateway 未执行，0 provider 请求 |
| host-probe-a2 | exit 1：Node realpath 的 `lstat '/Users/zangtao'` 被附加沙箱拒绝 | Gateway 未执行，0 请求 |
| host-probe-a3 | 仅放行已知祖先元数据后，CLI 报 SQLite read-only worker 无法创建 `/Users/zangtao/Library/Caches/openclaw-501` | Gateway 未启动，0 请求 |
| host-probe-a4 | 依据公开 temp-path/fs-safe 使用 os.tmpdir 的实现，设置专用 TMPDIR，仍报同一用户缓存目录错误 | Gateway 未启动，0 请求；该假设未解决问题 |

最后原始错误：`[openclaw] Reason: SQLite read-only worker Unable to create fallback OpenClaw temp dir: /Users/zangtao/Library/Caches/openclaw-501`。

没有放行该用户缓存目录、改写已有 /tmp/openclaw、私有 worker 注入、改 Host 源码/安全设置或改走无保护路径。没有执行 doctor 或循环重启。SDK 调用链的有界只读检查未找到已经验证有效的 CLI worker 专用临时目录设置；本轮停止该真实验收。四轮子进程均已确定退出，source fixture 均清理，owner 登记均移除，无待决或不确定外部动作。本轮未发生自动审批拒绝；上述阻止来自本批主动添加的子进程文件沙箱，不能误报为自动审批或全机服务故障。

真实探针使用 a3 编译输入，但 CLI 早于插件加载失败；它不能为最终 a5 提供任何 Core/消费通过结论。失败日志只证明同一 Host 启动前置阻碍。

## 续轮撤权与明确未完成项

公开 llm_input/model_call_* 是 best-effort 观察点，不是可 await 的逐模型派发门禁。Core 当前保证供给最终检查点及投递资格，不能把已交给 Host 的 preview/原文从后续 transcript/模型缓存中追溯撤回。真实“交付后撤权，Host 是否继续用已有结果”实验尚未进入执行，绝不称零续轮通过。

新 session gate 只控制该公开路径的旧物理历史复用；不能证明 bootstrap、其他 memory provider、compaction、跨会话 recall 和旧缓存全都清洁。跨重启是否始终由原生 history 反映旧工具曝光，也待真实 Host 核实。没有据此宣称 full_memory 或用户当前 main 配置可用；带 full_memory/额外 access binding 的目标仍拒绝。

任务状态：SQ06 新增有限只读业务供给接线，但正常业务 writer/学习/outcome 等尚未全迁移；SQ08 只有 Core fixture 部分通过，真实 Host 垂直出口未闭合；SQ07 文件刷新/index/wiki/Gateway 生命周期本批未实施。

下一明确目标是**先有界核实 CLI SQLite 只读 worker 的公开临时目录/缓存选择及隔离运行条件，再原样运行本探针**，取得实际 run/session/tool 关联、工具后 Google wire input 和回答。保持用户缓存保护、Host 零修改、无生产/真实 API；若没有公开机制，就报告这一具体运行条件缺口，而不是转成无工具 completion 或整项目不可行。真实正常闭环通过后再做同包读取中/交付后撤权及取消实验，不先扩大所有旁支或启用 full_memory。

## 身份和保留

隔离编译 manifest SHA256：`1942d1be1c7d4ccfbf7be31011601cdf118d40614cf5f5f734aed83d50d4dad1`，共 142 份生成文件/公开 schema，**不是可安装包或完整 Host 身份**。公开包 metadata/lockfile 只能给声明版本，不认证已加载代码或整个安装树；旧强 capture 保持不可用。

四份既有未提交规划/M1/旧测试与批前哈希一致，不纳入本批提交。所有新源码、报告和证据位于非 iCloud 项目路径，临时夹具均合成并清理；没有 iCloud 原件迁移/删除、真实沧海/config 迁移、生产 Gateway/索引、真实 API、凭据读改、OpenClaw 修改或 push。

原始 Core 尝试：初次草稿类型检查报列表类型推断问题，未跑测试；a1/a2 90+3，a3 98+3，a4 99+3 为中间源码，最终 **a5 99+3**。完整记录在各 verification result/log 中，最终报告只将 a5 算通过，不以重复运行充数。
