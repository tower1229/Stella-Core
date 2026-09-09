# Stella Core Local Development Integration

本文件是操作入口。[设计基线](10-DESIGN-BASELINE.md)定义现行规则，[Alpha 验收](05-ALPHA-PLAN.md)定义通过条件。命令存在不表示当前版本已满足新增契约。

## 1. 环境

使用隔离 OpenClaw 状态、干净 Core checkout、显式 CangHai checkout／branch／完整 commit SHA。Exact Alpha Host 为 2026.8.2。

Stella 1.0 历史核查只读取 dev@a1c2f4ec444b7d3245a7a0afea74460470a5dfc2。Core 改造后的测试分支是不同用途；运行／恢复基线由实际实例明确选择，禁止据此默认使用 dev 或仓库默认分支。

本地配置 OPENCLAW_STATE_DIR 指向隔离目录，并配置可工作的模型与目标 agent。源码中的 agentId 默认值和某台机器使用 main 的事实都不替代实例选择。

## 2. 数据模式

| 模式 | 允许行为 | 可声明的完成程度 |
| --- | --- | --- |
| read_only | 读取与诊断，无认知写入 | 不能声称已长期记住纠正 |
| local_write | 写入隔离仓库，禁止 push | 仅本地验证，不能声称抗服务器丢失 |
| managed_durable_write | 显式远端／分支，commit、pointer CAS、push／RPO | 按实际同步状态声明 |

启用 managed 模式须已有对该远端写入的授权。不得把用户未提交文件混入自动提交，或通过 reset 保持机器所期待的旧状态。

## 3. 本地构建与链接

```bash
npm ci
npm run check
npm run check:schemas
npm run build
npm test
npm run test:package
openclaw plugins install --link /path/to/Stella-Core
```

完整工程检查入口为 npm run verify。先确认当前源码和所选 profile 符合规范；未实现的 Memory Lifecycle 或完成协调不能通过现有 package smoke 自动获得证明。

## 4. 激活

使用仓库入口诊断配置；下面 agent-id 必须替换为实际实例值：

```bash
npm run stella:activate -- --canghai-root /path/to/CangHai --agent-id main --data-mode managed_durable_write --check
```

确认来源、分支、SHA、远端、Host／runner、插件权限及能力契约后，才在对应任务授权范围内执行：

```bash
npm run stella:activate -- --canghai-root /path/to/CangHai --agent-id main --data-mode managed_durable_write --apply
openclaw plugins inspect stella-core --runtime --json
openclaw gateway status --deep --require-rpc
```

当前 activation 命令尚未证明新增 completion／full_memory profile 的全部能力检查；检查成功不能替代对应 G/A/M 条件。apply 变更 Host 配置，需备份、验证和失败回滚。正式候选／本机验收以对应任务的证据要求为准。

## 5. 私有端到端证据

混合评估的公开部分先运行 `npm run prepare:evaluation-source`，使用输出的 `root` 作为
`--public-canghai-root`，保留其 `revision`。该命令只新建合成仓库，不接收个人仓库输入。
独立案例没有预设的主人画像或历史学习；一般框架仍可使用，认知原件带有 v2 版本绑定。
通用测试 fixture 的 Twin 假设不能作为公开案例人物的背景。运行器在模型调用前核对公开源声明及
文件摘要；旧源或声明后变化的源会显式拒绝，需要重新生成，不通过修改案例或评分消除失败。
声明只记录生成来源与内容完整性，不证明模型语义通过。macOS、Windows 均使用上述 Node/npm 入口，
生成仓库内的 `.gitattributes` 保持原件字节不被 `core.autocrlf` 改写，以保留版本及摘要绑定。
不要并行执行会清理同一个 `dist` 或 `.test-dist` 的构建命令。

对一个干净 Core revision 打包成唯一 tarball。以该 artifact 顺序生成：

1. praxis:private：从明确 initial CangHai SHA 跑实际 write loop，记录最终同步 SHA。
2. recover:private：从该最终 SHA 在空 runtime 恢复。
3. evaluate:praxis：同一 artifact／最终 CangHai SHA，公共 suite 加私有 fragment。
4. candidate：核对 write-loop、recovery、evaluation、durability 及版本关联。

精确参数见 [README](../README.md)。私有 adapter、原文和输出留在 CangHai／私有输出位置。源码或 artifact 变化使对应证据失效，不能拼接不同版本的成功记录。

## 6. 验证与故障处理

除正常闭环外，运行 Alpha 的澄清、错误行动来源、重复 outcome、合法空恢复及 Host 回调／同步故障用例。存在未满足的 A 项就报告未通过；旧 receipt 不自动覆盖新增断言。

Source Baseline 只记录派生历史，Recovery Revision 是当前选定恢复点。来源变化后按 Memory Lifecycle 重评当前依赖，历史预测保持原貌。pointer CAS 失败保留已生成的提交，协调当前配置后重试；push 状态不明先查远端，不能再生成一条同样学习。

本文件不授权自动提交、push、迁移私有数据、修改正式配置、关闭 Issue 或发布。具体执行遵循当前任务已经给出的授权，不重复索取已有授权。

### SPEC #6 完整验收账本（Issue #7）

使用现有只读入口生成真实预检和可公开的完整账本：

```sh
npm run build
node scripts/inspect-main-readiness.mjs --config <本机配置> --output <新的私人预检.json> --ledger-output <新的账本.json>
```

此入口只查询初始化协调器的 `status`，并读取现有 profile、能力配置及目录；不初始化、不调用模型、不修改个人仓库、不投递消息。退出码 2 表示存在预检阻塞。原始预检含实例定位，必须留在私人环境；`--ledger-output` 仅输出白名单状态、内容摘要、规范相对路径和固定 case ID。零条理解或工作记录标记 `valid_empty`，不据此判断重要上下文已恢复。配置非占位和声明 `passed` 都不是行为验收。

账本展开原 01～40 和全部 49 个 G／I／C／M ID，负责票来自 2026-09-09 读取的 #7～#39；19～30 是能力关闭行，不重复计入交付工作量。规范定位绑定 #6 的本地 `43d8b19aae4b3c7c3c487d1898ce8c4608fac941` 与文件内容 SHA-256，可用 `git show <revision>:<path>` 读取。生成时核对当前文件内容，变化即显式拒绝，更新规格时须审查并更新 `src/acceptance/delivery-catalog.ts`。不假设该提交已推送到 GitHub。

每行按 `synthetic_contract`、`exact_host`、`real_main` 分层记录固定 `spec6-<ID>-<environment>` case；该 case 代表该行完整退出条件的验收套件，不能用局部子用例代替。`natural_feedback` 单列，不用技术通过代替主人反馈。状态使用 `pending / in_progress / implemented / verified / blocked`；部分层通过最多为 implemented。依赖未通过、配置缺失、失败用例及任何必需项缺证据均不能使总账通过。当前预检不会生成行为通过凭据；初始化状态查询也不证明实际 Gateway 版本或真实模型执行。

后续执行器可通过 `--evidence-directory <私人证据目录>` 提供 `manifest.json` 数组及 `<artifactSha256>.evidence` 原件。记录字段由 `DeliveryEvidence` 定义：摘要 ID、目标编号、固定 case ID、环境、完整版本绑定、记录时间、失效时间、结果、原件 SHA-256、显式 `supersedes` 列表。摘要地址可在该私人目录定位并核验原件，公开账本不包含目录、正文或账号。版本绑定包含 Core、构建产物、Host、harness、来源、profile、策略、配置、模型和 case 集合；私人来源及模型仅存摘要。历史记录保留原日期、版本、结果及替代链；过期、未来、脏源码、不同版本及被替代的结果不计入当前通过，缺失或被改写的原件直接报错。

这是执行器证据索引和差距报告，不是能力签发器：摘要校验只证明索引对应原件，不证明用例语义或执行身份可信。适配器收据生成、真实 Host 身份绑定和运行准入属于 #8。当前脚本的 Host 摘要来自检查端 SDK，公开报告明确标记 `host_runtime_version_unverified`，因此不会据此宣布真实 main 总交付完成。不得把自行填写的结果或该账本传入运行准入门禁。

### SPEC #6 受限能力验收（Issue #8）

通过现有初始化协调器入口执行一个受控 Host 适配器，并签发能力收据：

```sh
npm run build
# 先完成 bootstrap 初始化，再在 operator.admin 会话中：
# stella.initialize { "action": "accept-capability", "runId": "<host-run-id>" }
```

`accept-capability` 只要求 bootstrap 就绪，不要求业务准入；调用时会把 `runId` 绑定到当前初始化收据，再由适配器回读校验。适配器仅允许 `observe`／`verify`，不能扩大资料读取或投递副作用。签发的 `stella.capability-receipt/v1` 固定 `businessAdmission: false`，默认 24h 内有效，并绑定 Core／产物／Host／harness／来源／profile／策略／配置／模型／用例摘要。业务准入只接受已落盘且校验通过的收据；伪造 `passed`、过期、依赖漂移、取消／失效均不能清除运行阻断。可用 `invalidate-capability` 显式失效。公开响应只返回 id、结果、locator 与时间，不含私人路径、账号或模型正文。

声明在 `acceptance_ref` 中的 `passed`、交付账本行以及 `stella.initialize verify` 的初始化验证收据都不能代替能力收据。`full_memory` 在 profile 声明了必需能力时，编译期按项写入 `capability_acceptance_missing:<id>`；未声明必需能力时仍保留 `full_memory_acceptance_unavailable`。单项收据只清除对应 `capability_acceptance_missing` 阻断，不清除 `skill_capability_unverified`，也不能自证整组 12 项能力已验收。
