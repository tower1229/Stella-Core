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
