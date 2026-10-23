# 肃清第十一批：公开初始化、受管文件与下一请求消费

基线 `fb10f50e09eb266848b0ebd804a9f0fde4612fd5`，分支 `codex/issue23-integrated-regression`。最终版本、编译清单与原始命令/请求证据位于 `.artifacts/suqing-batch11-20261023/delivery.json`。全部仅本地合成验证与本地提交，不是生产部署。

## 入口与文件范围

在现有 `operator.admin` 方法 `stella.checkpoint` 上增加 `materialize` 和 `rollback`，没有另建命令协议。`initialize` 仍只按显式 revision 初始化 Core authority。`materialize` 只接受 action；`rollback` 另接受准确 operationId。不接受 workspace、任意源/目标路径、force 或 adopt。workspace 从 Host 当前 agent 配置和公开解析器确定；源 recipe 来自当前 checkpoint 对应 manifest/profile，skill registry 来自 manifest.extensions。

| 类型 | 准确路径／规则 | 所有权与行为 |
| --- | --- | --- |
| recipe | runtime profile 的 host_materialization_ref；本批合成为 `50_PersonalAgent/stella/host-materialization.json` | 编译已审阅、固定摘要的源文件，不由模型生成行为 |
| bootstrap | 目标 workspace 的 AGENTS.md、SOUL.md、IDENTITY.md、USER.md、MEMORY.md | 当前编译契约要求的五文件；首次仅写不存在目标，后续只更新 receipt 证明受管且未被用户修改的文件 |
| skill | recipe 声明的 `skills/<name>/...` 固定文件树；本批为 `skills/stella-initialization-probe/SKILL.md` | 不迁移所有 skills；核对公开 Host discovery 的准确路径、可见性与固定文件摘要 |
| Core 状态与备份 | `<checkpointStateDirectory>/initialization/{receipt.json,admission-epoch.json,pending.json,rollback-pending.json,fenced,last-plan.json,operations/<operationId>.json}` | 仓库外 Core 状态；operations 保留 before/after 字节、原权限、旧 receipt、identity 与原 checkpoint tuple |
| 显示 identity | 必要时通过已有公开 config SDK 精确修改目标 agent.identity | 不改工具、binding、provider 或安全权限；本批真实 Host 使用已匹配的合成 identity，该分支的修改/回读在离线 SDK 夹具测试 |

不调用 ensureAgentWorkspace 提前生成模板，不自动创建 BOOTSTRAP.md、TOOLS.md、HEARTBEAT.md 或 workspace Git。Host 后续自己的生命周期若产生其他文件，应与这六个 Core 受管目标分开记录。没有 wiki/RAG/index 迁移或生产 Gateway 操作。

## 事务、冲突与恢复

复用原 StellaInitializer、Core 固定 authority wrapper 和保守标准库锁。初始化无 startup 副作用，仅显式管理操作执行。已准备或已准入的目标请求算忙；不强制中断请求，不修改 Host tools/bindings 做隔离。维护写入期间的 durable fence/pending 会阻止新的 Core 准入，失败或重启后仍有效。

无 receipt 的既有目标，即使字节相同也不自动接管；用户内容或模式漂移明确拒绝。备份不能被当成覆盖权限。失败重试读取原 pending，保留 operationId、planHash 与原 checkpoint，不能把旧 expected 自动换成新观察到的 B。正常 in-process 管理操作取消及 registration shutdown 传给 initializer；普通 Gateway transport 没有 signal 时不声称连接断开等于撤销写入。

公开 rollback 复用原内核，恢复原字节/模式或原不存在状态，保留归档并继续 fenced；需要重新初始化后才放行。strict Core rollback 还要求原 authority tuple 与当前操作匹配，不能把 A 的备份自动套到 B。遇用户后续编辑仍拒绝回滚覆盖。

当前入口适用于新 workspace 或已有可验证的 Core 所有权。真实旧部署的已有文件接管仍需单独审阅迁移，未在本批自动执行。

## Host 生效与 skill 正文供给

公开 bootstrap loader 每个下一 run 会读取文件，缓存仅复用未变化内容；不导入私有 clearBootstrapSnapshot。Skill 使用公开 discovery 校验，但库存/receipt 不等于实际模型消费；真实探针必须看到下一请求输入。

保留测试 Gateway 原有 `tools.allow = [stella_memory_data]`。没有自行扩大 Host read 权限。Core 数据工具新增 `action: skill`，handle 只能是精确声明的 skill 名称；Core 经原 initializer.assertSkillRead、receipt 与实读正文摘要核对后供给。没有任意路径、附加资源或模型提供的 authority。首次读取仍绑定原 grant/checkpoint；已合法读取的 skill 正文仅缓存于本请求，取消/结束清理。

实测中，原版 Host 在仅开放数据工具时没有输出 available-skills 元数据。Core 使用既有 before_prompt_build 公共 hook 追加受管 skill 的名称/描述目录，来源为公开 discovery 的准确已安装条目；正文仍经已有 Core 工具读取，目录不提前包含正文。这是当前工具受限模式的明确机制，不冒称开放了任意原生 read 或已验收全部 skill 类型。

首次创建 skill 时还发现进程内 discovery 空目录缓存：初次物化已写六个文件，但校验返回 skill_unavailable_or_shadowed，留下原 pending/fence。隔离 Gateway 停止/启动后，使用同一配置、source、state 重试原 operation 即完成。没有调用私有 bump/clear cache、篡改配置 fingerprint 或放宽 discovery 检查；产品入口也不自动重启生产 Gateway。若发生该情形，操作方须按正常 Gateway 生命周期刷新后重试。bootstrap 自身下一 run 重读并不足以证明 skill cache 已刷新。

初始化完成后按公开 reset／新会话再发用户请求。它清除本轮 live history 的混淆，不删除历史归档。当前 fresh_tools 仍拒绝未 reset 的旧历史，尚不是最终无缝长对话体验。没有为热更新加入代理、provider 或输出缓冲，也没有恢复运行中撤权门禁。

## 同构建验证

最终候选使用 `compiled-a5`：typecheck 通过，123/123 项定向测试与 3/3 项旧模式注册检查通过，无失败、取消或跳过。138 个编译文件的逐文件清单位于 `compiled-manifest.json`，该清单 SHA256 为 `25341bcb78f09a9e0be4ad45970dcd6a460b9b74add50aca88284fc40b8b17c3`。Core package 仍为 `0.1.0-alpha.0`；本批没有生成 npm 安装包，不能把编译目录称为正式发布包。

`host-probe-a3` 使用同一构建，通过本机安装的 OpenClaw 2026.8.2 原生 Gateway/Google Agent/工具循环，模型仅为 loopback fake Google。公开包元数据 SHA256 为 `cac42bb9c8ff7d0909bf8b373c695cd656029d20e2549e1b39d242bfbf493b53`；只核对具名公共文件，没有全树身份验证，也没有真实 Gemini 效果评测。

| 证据 | 实际结果与范围 |
| --- | --- |
| 首次公开物化 | workspace 原为空；实际仅生成五份 bootstrap 与一个 SKILL.md。原 operation `init_3329f087-2fd3-4741-9fd0-8afd250ad6b8` 因 skill 空缓存留下 pending，经同一隔离 Gateway 生命周期后原样接续 |
| 请求 A 的四次 provider 请求 | #1 包含五份 bootstrap 和 Core 公共 hook 目录；#2 包含工具供给的 skill 正文；#3 含 memory list；#4 含精确 read 的原文，并正常完成回答 |
| 发布 B 后的下一用户请求 | 既有 Core archive/transaction/CAS 在合成仓库实际提交 B；公开 reset 后 #5–8 重新走相同工具循环，#8 实际包含 B 原文并正常回答。新请求首包没有上一请求的工具历史 |
| 来源版本 | 物化 A 为 `f545e8b9e90aa909e09c242212c5b747ce16fcec`；新记忆 B 为 `1204fef129c5b9848ce8de87425c8a4795302610`，token `0083aec9-7623-4bb9-84fe-25b8d480617e`。这些是合成源 Git 身份，不是 Core 代码版本 |
| 离线负例 | 路径/动作校验、read_only 写入拒绝、用户文件冲突、用户修改保护、失败 fence 与原 pending 重试、registration 重启恢复、prepared/admitted 请求维护互斥、in-process 取消、固定 authority 回滚、受管 skill 摘要与本请求缓存、原事务/CAS/journal 与 legacy 检查 |
| 结束状态 | 最终探针 Node launcher exit 0；两次登记 Gateway PID 99992、397 均 exit 0；fake server 关闭、合成源 fixture 删除，workspace/state/原始证据保留。没有待执行审批或已登记未结束进程 |

完整 provider 请求、公开事件/历史、原 pending、完成 receipt、文件内容/摘要及退出信息保留在 `host-probe-a3/`；执行命令与步骤退出码在 `verification-a5/result.json` 和 `host-launch-a3.json`。最终矩阵只引用 a5/a3，不拼接其他候选通过。

本次 B 仅新增记忆，不改变 bootstrap/skill recipe；B 后物化幂等保留 A receipt。它不是 bootstrap 正文或 skill 描述热更新的验收。skill 描述来自公开 discovery 缓存，描述变更后的一致性未在此批验证；普通变更可按正常生命周期刷新，不为无缝热更新新增机制。真实 Host 预置匹配 identity，修改 identity 分支仅在离线 SDK 夹具验证。

当前 `requestArchive: local` 与 `agentMemory: fresh_tools` 仍互斥；探针通过受信任内核 `archiveLocal` 提交 B，没有证明正常 Agent 已自动归档。回滚负例证明恢复原不存在状态及保护用户改动，不能据此宣称所有旧部署或既有受管文件更新迁移均通过。

开发期 evidence 保留失败原样：verification-a2 有一项 shutdown 类别回归，恢复 recovery_scope_closed 后关闭；Host a1 在 skill discovery 校验处失败、模型请求 0；a2 经隔离生命周期恢复原 pending 后，五个 bootstrap 已在第一份实际请求中，但缺 skill 目录，整体仍失败。最终候选增加公共 prompt hook 的受管目录接线，已用自身 a5 构建完成 a3 场景；旧 partial 结果仍按失败保留。

## SQ 状态与剩余主线

| 任务 | 本批推进与核心剩余 |
| --- | --- |
| SQ-06 | 新增公开 materialize/rollback 到既有 Core 初始化内核；必要业务 writer 仍需按实际目标迁移，legacy/真实旧 workspace 未迁移 |
| SQ-07 | 必要 bootstrap/声明 skill 的实际文件与维护事务已接线；仅实际启用且必需的其他消费者才进入后续清单，不新增关闭的 wiki/RAG 需求 |
| SQ-08 | 同一 Core 数据工具补齐受管 skill 正文，仍由原版 Host 执行正常模型/工具循环；source-access/更多来源权限模式和带历史长期使用仍有限 |
| SQ-10 | 以本批真实探针结果确认公开初始化→文件→实际用户请求→写入 B→下一请求消费；不把有限闭环称全部场景或 full_memory 完成 |

下一优先项是必要业务写入方与同一权威 resolver 的集成，以及明确旧部署文件的审阅迁移入口。保留架构简洁，不继续扩 provider、实时撤权、所有后端或未启用的索引消费者。

full_memory 不笼统打开。物化成功的 status 仍标记 consumed:false；hostBootstrap 只表示该固定文件安装/公开 loader 验证状态，实际消费由固定构建探针单独证明。完整业务能力及其他实际入口尚未闭合。

## 工作树与操作边界

四份旧未提交文件先记录 SHA；本轮对主计划仅追加有关本批的执行修订，其余三份原样，四份均不纳入本批提交。全部新产物位于已验证非 iCloud 的项目路径。没有真实 API/凭据、生产配置/Gateway/索引、OpenClaw 修改、push、ps 或 Host 整树扫描。最终登记进程退出和剩余阻塞见 delivery。
