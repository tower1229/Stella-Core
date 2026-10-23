# 肃清第十二批：正常 Host Agent 的 owner 输入自动归档

基线 `ab7cbc61d4679a468b411e88410581145ececbe3`，分支 `codex/issue23-integrated-regression`。最终源码/构建身份、命令、退出与原始证据见 `.artifacts/suqing-batch12-20261023/delivery.json`。本批只在本地合成源和隔离 Gateway 验证，未部署。

## 最小接线和实际触发

复用第五批 `checkpoint-request-ingress`、`archiveCorrectionInput` 和共同事务/Git/CAS writer，不增加存储、事件总线、provider 或输出缓冲。显式 `requestArchive: local` 可与 `agentMemory: fresh_tools` 共存，仍要求 `dataMode: local_write`；默认配置、archive-only 与不归档的 fresh_tools 保留。manifest 和运行时校验一致。

组合模式只注册一个 Core reply_dispatch 入口。它先认证当前 owner/direct/session/run 与原始 Host body，执行已有输入归档，拿到确定的 checkpoint 返回值，再准备同一版本的普通 Agent 供给资格。归档失败、取消、返回版本失配或初始化 pending 均不进入正常 Agent；不能从新的观察值静默升级 expected。Host 自己继续模型、工具、回答和历史持久化。

自动保存发生在正常用户输入的公开 ingress、模型开始前。它是原话留存，不是模型判断哪些值得长期理解，也不声称 Agent 结束后进行学习。成功写盘后模型失败不会回滚已经合法保留的输入；状态须分别表达归档和 Agent 结果。Host 命令/reset 不当普通 owner 输入归档。

## 时间、重放和来源语义

实际 stock WebChat envelope 可无 Timestamp。有 Host 时间时绑定其准确值；无该字段时 capturedAt 明确是 Core 接收时钟，request 不添加 hostMessageTimestamp。occurredAt/authoredAt 仍未知，不能将接收时间冒充事件发生时间。

同 operation 的原 receive clock 从已登记 request snapshot 恢复，完整 request 必须准确匹配；原 manifest/profile/policy 仍从固定 A Git blob 验证，完整事务 plan 由共同 writer 重建并认证，原 tuple/CAS 不变。存在 Host 时间时不能使用 journal 自选时间代替。重试或跨注册接续不能生成第二次提交/token，改 Body/身份明确拒绝。

本入口仅 retain/v1、owner direct 的原话，附件/音频/其他来源/权限模式仍受现有门禁约束。来源标记继续为 openclaw-reply-dispatch-2026.8.2，不能冒充完整 transcript 或 Host 最终消费收据。助手回答留在 Host 历史，本批不把它重新标记为 owner evidence。

## 验证结果

最终 Core 候选 `compiled-a3`：typecheck、定向编译通过，**133/133 项定向测试 + 3/3 项 legacy 检查**通过，无失败、取消或跳过。编译清单含 138 文件，清单 SHA256 为 `d8f25e71b47c7c6ffefa4e811ea659e37aad96c8b251765cd69bf9b2c0b65382`。Core package 为 0.1.0-alpha.0，未生成安装包。

真实 `host-probe-a2` 使用同一 Core 构建、原版安装的 OpenClaw 2026.8.2、Google 原生 Agent/tool loop 和 loopback fake provider。已捕获 **6 份完整请求**，没有直接调用内核 writer 来补归档：

| 时间/入口 | 实际证据 |
| --- | --- |
| 第一次 chat.send | 原话 `SYNTHETIC_AUTOMATIC_OWNER_INPUT_7296: Preserve the author's concrete questions.` 经真实 reply_dispatch 自动归档；请求 #1 开始时持久 checkpoint 已是返回的 B |
| 第一次正常 Agent | #1 由当前用户 prompt 带原话；#2 接收 list，#3 接收 exact read 的 owner original，随后正常回答。工具和模型续轮没有追加提交 |
| 下一用户请求 | 官方 reset 后发不含原话 marker 的查询；#4 不含旧 marker/回答；#5 从当前 catalog list 找到第一次原话，#6 经 read 收到该 owner original，正常回答 |
| 一次写入 | 初始合成源 A → B `de00d4612a1792f90117088e19ce5bab10f84c75` → C `6284bc0cbfe0441562aa86a0ee6a1b66803a9ec4`，恰好两次提交及两次 token 推进，各绑定不同真实 run/operation。C 保存第二条原始查询；未新增 assistant owner evidence |
| 原话/事务 | retained-owner-inputs.json 保存两个实际 ingress snapshot；无 hostMessageTimestamp，capturedAt 为 Core 接收时间。两份 operation checkpoint journal 保存原 expected 与精确 after 文件；模型开始时的 checkpoint 分别与公开 B/C status 完全一致 |
| 退出 | Host launcher PID 96122 exit 0；Gateway PID 96191 exit 0；fake provider 已关闭，合成源已清理，原始请求/状态/日志保留 |

负例覆盖：非 owner/group、预取消、不允许留存、非法时间，失败均不准入 Agent、不推进 checkpoint；重复 run 不重复写入；Core 接收时间跨注册重放保持原值；有 Host 时间时 journal 自选时间被拒；归档返回值与随后 loaded expected 不匹配时拒绝，不接纳观察到的新版本。既有事务、pending/restart、初始化/回滚、来源/取消与默认 legacy 检查在同一 Core 构建复验。

验证尝试分开记账：a1 离线 131+3 通过，是两处审查修复前版本；a2 在类型检查发现可选 recovery 类型，未启动测试；只有 a3 的 133+3 对应最终 Core 代码。Host a1 已有实际自动归档及第三次请求原文，但探针错误地查找未转义的 JSON 字段，整体失败；修正为解析 functionResponse.output、精确核对 original.text/role/adapter，并补 provider-start tuple 比对后，Host a2 全通过。

上述修正仅改探针脚本，不改 Core、测试或 compiled-a3。旧/新 harness SHA 与理由单列 host-harness-adjustment.json；Host a2 launcher 记录最终 harness SHA。没有把旧脚本声称为最终脚本，也未将 Host a1 失败冒算通过。公开 Host 包元数据及具名契约沿已知范围核对，未递归验证已安装全树身份。


真实探针必须通过 chat.send 触发 Core；自动归档场景不能直接调用 archiveLocal 或别的内核 writer 完成提交。记录第一请求及下一请求的完整 provider 请求、reply_dispatch/工具事件、operation journal、确切原始输入、Git 提交数与权威元组。loopback fake Google 只验证机制，未验收真实模型的记忆质量或语义学习。

## 主线状态和剩余

- SQ-06：复用必要 owner 输入 writer，使归档和普通 Agent 供给共用 checkpoint。语义 learning/correction、outcome 等其他业务 writer 不在本批同时重构。
- SQ-07：沿用第十一批初始化/所有权/回退，不迁移其他未启用消费者，不自动建立 wiki/RAG/index。
- SQ-08：正常 Host Agent 的供给和输入留存可组合；仍有限于 fresh/reset 的公开受支持路径、当前来源权限模式。
- SQ-10：本批目标为真实 Host 输入→自动归档→Git/CAS→正常 Agent 工具/回答→下一用户请求读取，不等于生产部署或全部产品场景。

已接线的最小业务 writer 是 `checkpoint-request-ingress → archiveCorrectionInput → archiveLocal`。`applyHostCorrection` 仍显式使用 legacy durability；`src/plugin.ts` 的 recoverCorrection、recoverOutcome、recoverQuestionEvidence 仍位于 legacy 注册分支，不能算 checkpoint 模式已迁移。这些按实际必需性安排后续，不在本批一次性重构。

full_memory 保持 false。下一核心范围按真实闭环结果收敛：旧部署文件/显式升级、正常带历史使用与必需业务 writer；不恢复运行中撤权、完美流式拦截、Host patch 或新代理层。完整对话/附件留存与语义学习仍须各自验收，owner 原话留存不能代替这些能力。

## 操作边界和保留项

仅项目非 iCloud 的 docs/.artifacts、新合成 workspace/state、原版隔离 Gateway、loopback fake Google。合成 hooks.allowConversationAccess 使用既有授权，不新增 native read 或其他安全权限。不读取/修改真实凭据、生产配置/Gateway/索引，不真实 API、push、ps 或 Host 整树扫描。旧四文件保留未提交，主计划仅相关追加，其余三不动。进程退出和精确差异以 delivery 为准。
