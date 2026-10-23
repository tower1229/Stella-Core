# 肃清第十四批：有限实验安装候选

本阶段交付可安装的 `experimental_owner_chat` 实验候选，不是完整 full_memory、Alpha 正式发布或生产部署。运行代码保持第十三批基线 `71e7cc2d516bbc817d0f7771dfafd12431c964e8`；本批只改包文档白名单、README、现有探针和说明，没有新增运行模块。最终本地提交与全部文件身份见 `.artifacts/suqing-batch14-20261023/delivery.json`。

## 包和身份

- 包：`.artifacts/suqing-batch14-20261023/packages-final/tower1229-stella-core-0.1.0-alpha.0.tgz`。
- SHA256：`03f79079e9ea13600b93865b054315aa158b7f364c4f94ad5cf143051c32368f`。
- npm integrity：`sha512-eAiUjnp7JyJWTjHBdpeAZkY3NLbeGsID1C6mNS8dL3Q6BPaik7SgUctf7Tn9aQfDml5WmCC/e0l/77z+xe4Hpg==`。
- 版本仍 `0.1.0-alpha.0`，以具体 hash 区分候选，未发布 registry。
- 标准 `npm run build`、`npm pack --ignore-scripts`；从 tracked Core 源码和明确自有 guide 构建隔离快照。四份旧 untracked 文件不进入快照、包或提交，主计划仅相关追加。
- 包共 **481 文件**，文档仅 README 和显式 `docs/EXPERIMENTAL-OWNER-CHAT.md`，没有 tests、dist/tests、.artifacts、私人源或凭据。
- build-identity 如实保存基线和 `sourceClean:false`；不冒称整棵工作树干净。候选 sourceSha256、安装文件 digest 与最终提交逐文件绑定，比同名版本或旧 baseline 更精确。新报告本身不在包内。
- 在第二个全新 `consumer-a2` 中标准 npm 离线安装最终 tgz，校验 lock integrity 与全部 481 个安装文件。8 个具名依赖来自本机已安装包的本地 tgz，未访问 registry，不声称全新网络依赖安装通过。
- Host 为本机已安装 OpenClaw **2026.8.2**，Node **24.22.1**。consumer 只链接该现有 Host；只核对具名公开元数据/lockfile，不复制、递归读取或哈希 Host，不能声称完整 Host 代码来源认证。

## 同最终安装包验证

最终 `candidate-result.json` 全部命令 exit 0。**25/25 项最小回归**：未知旧历史/身份、conversation hook 权限、受众变化在归档前拒绝、物化/用户文件保护、pending 重启接续、受管 rollback、归档 Git/CAS、提交后发布失败和旧 expected/缺失损坏 authority。测试仅夹具被编译，所有 src 导入指向 consumer-a2 的实际安装 `dist/src`；结束后安装文件未变化。

首轮包额外跑过 typecheck、标准 build 和 **104/104** 定向测试。独立审查后修一行包内备份说明并重打包；最终包其余 **480 个文件（全部运行代码/schema/metadata）逐字节相同**。104 是补充运行字节证据，不累加成最终新 tarball 测试数。

真实 Host 通过 `plugins.load.paths` **直接加载安装包**，没有临时 Core wrapper 或替代入口。全新合成源/workspace/state，loopback fake Google `gemini-3.8-flash`、low，已批准的合成 conversation hooks，memory-core/session-memory 不参与。

1. operator 显式 initialize 所选源 revision，随后 materialize。
2. 实际写入 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md`、`skills/stella-initialization-probe/SKILL.md`。逐文件 bytes/hash 与 receipt 一致。
3. 首次 public skill 发现返回 `skill_unavailable_or_shadowed`，保留 `init_2fd91d28-ec4a-45d8-9a51-736926be1f4c` pending；**设置阶段**正常停止/启动同一隔离 Gateway 一次后，重试并完成原 operation，没有私改缓存或权限。两个 Gateway 都 exit 0。
4. 新建会话 `a09b11a3-8217-450f-82a6-61c8db2b4e8c`，同 owner 同 session 连续三次 chat.send，**聊天期间无 reset 或 Gateway 重启**。public chat.history 结束消息数 6/12/18；直载入口没有 before_agent_run instrumentation，不冒称读取了 callback historyCount/lifecycleRevision。
5. **9 份完整 provider 请求**证明正常 Agent→list→read→续轮→回答。bootstrap 标记和已发现 skill 目录进入真实请求；本场景不调用 action skill，因此不声称该包 skill 正文已在真实 Host 请求消费，正文工具路径只属于离线回归。
6. 第一轮提供 A，明确合成源文件修订夹具通过生产 transaction/Git/CAS 更新 B；第二/三轮保留历史 A/旧回答，但本轮最新工具仅提供 B，带各自 checkpoint/run。**3 次真实 Host 触发自动输入归档 + 1 次标明的源修订夹具 = 4 次 Git 提交**，不是四次自动归档。三份自动 journal 和源修订 journal 均单独保留。

三轮当前 authority revisions：`d87ca8d52eb2dfda3dd77f9a542a35da494b39c0`、`8259856c4705c4d9883734cc31f2faff0b8b733f`、`f54bf47b4b69ece8c191f8332fe55baf6a419ea3`。完整 token、时序、配置、公开 session/原始 provider 请求见本地证据。fake 回答只证明接线，不证明真实模型记忆质量。

## 交付边界和接入

包内 [实验模式说明](EXPERIMENTAL-OWNER-CHAT.md) 给出显式配置、initialize/materialize/rollback JSON、文件所有权和接入前置。正常同受众连续聊天无需逐轮 reset；未知旧历史、不同受众仍不能自动接管。历史引文不是当前事实，提示词不是强隔离保证。

当前数据工具是有界 retain-v1 list/read，最多 64 项合格 current evidence；自动输入留存也会增加 catalog，长期规模与语义检索未验收，不能直接承诺大型私人库或无限续聊。要验证真实模型，先用小型合成 catalog，不接入真实资料或迁移旧部署。

配置状态明确为 `mode=experimental_owner_chat`、`continuousOwnerChat=true`、`hostBootstrap=true`。旧通用 `agentMemory=false` 与 `full_memory=false` 不改成完整通过；fullMemoryBlockers 仅剩未迁移语义 writer、完整 transcript 等完整契约项，不让有限实验模式整体不可用。完整 transcript/附件、语义 learning/correction/outcome、旧会话/旧部署迁移、更多来源工具、长历史 compaction 都不混入本候选出口。

回退有边界：受管操作中的 before 字节/mode/previousReceipt 是备份；rollback 只恢复该次受管文件和展示 identity。checkpoint 在普通输入归档后已推进，原初始化 rollback 可能拒绝；不得删 authority 或只回退 Git 绕过。接入前备份目标配置/workspace/外置状态和明确源版本，真实部署的协调回退另行审阅。

本阶段无运行/审批阻塞；仅交付实验候选，尚未自动接入任何真实目标。

## 真实模型小规模验收需要的确切授权（本批未执行）

建议最小授权为：在独立合成 Gateway 沿用已批准的 Core conversation hooks，使用 `google/gemini-3.8-flash`（low），只发送已审阅的合成文本；最多 3 条用户输入/9 次 API 请求，达到上限即停。用户需确认费用上限和指定已有凭据引用是否允许由 Host 测试进程使用；不输出、复制或持久修改凭据。单请求 token 上限与预算在执行前固定；不预先承诺达到 API 次数上限后仍能完成全部语义任务。

这不需要私人源、生产 Gateway 或生产配置权限。若之后接入私人数据、真实历史、修改生产配置或重启生产，需要各自明确范围与授权。本轮没有真实 API、凭据读改、生产或 Host 修改、发布或 push。

## 审查和历史证据

独立只读审查确认 tar/安装/加载指向实际包、旧文件未入包、无权限扩张。首轮旧 noResetOrGatewayRestart 字段硬编码 true 的报告口径错误已保留原始记录；最终探针按真实 Gateway 次数写 **false**，独立 DuringConversation 字段为 true，并记录 setupGatewayRefreshes=1。未改写旧原始 evidence，不将设置刷新冒称不存在。

唯一第一轮脚本准备失败是编辑脚本的本地替换次数断言；仅 package/README 和 artifacts 前置已写，probe 当时未写，之后精确完成，没有审批拒绝或权限绕过。最终批次、定向测试和两次 Gateway 均已退出；无登记 owner 记录。保留源快照、两个独立 consumer、包、配置、日志和完整请求以便复核。

复现命令与 PID/exit/原始时序在 `run-package.py`、`finalize-package.py`、`package-result.json`、`candidate-result.json`。最终接受的是 packages-final + consumer-a2 + host-probe-a2，首轮包只作历史与相同运行字节补充。
