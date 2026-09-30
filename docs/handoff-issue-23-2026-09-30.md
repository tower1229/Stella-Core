# Stella-Core #23 交接 — 2026-09-30

## 接手结论

**下一步是补齐 Active Memory / Dreaming 的原生共运行验证；契约版本对齐已完成，全量测试 653/653 通过。#23 的完整 Host 记忆消费验收仍不能据此判定完成。**

交接前代码提交：`acd2afaa212f9383dff8c749fb006c9cfa3fb078`，分支 `master`，仓库 `tower1229/Stella-Core`。文档创建前工作区干净。用户本次明确授权将交接保存到 `docs` 并提交、推送；该授权不包含发布、部署、生产重启或关闭 Issue。文档提交 SHA 通过 `git log -1 -- docs/handoff-issue-23-2026-09-30.md` 查询。

## 先读这些

- [Issue #23](https://github.com/tower1229/Stella-Core/issues/23)、[需求](09-REQUIREMENTS-ALIGNMENT.md)、[设计基线](10-DESIGN-BASELINE.md)、[Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md)、[领域语言](../CONTEXT.md)、根 `AGENTS.md`。
- [DECISIONS.md](DECISIONS.md) 的 D-053：必需持久化先于最终业务投递；不能只靠软 finalize/end hook。
- 代码变更直接看 `git show acd2afaa` 及此前提交，不在本文件复制实现或完整计划。
- [2026-09-23 旧交接](handoff-issue-23-2026-09-23.md) 仅用于历史导航。其“未提交草稿、92 项测试、视图迁移未接线、旧暂停状态、不得 push”等描述不能覆盖本次状态或本次用户授权；更早的证据仍保留原范围。

用户原则：先验证核心技术，再围绕已经验证的方案开发；尊重插件宿主特性，使用现有公开接缝，不能要求 OpenClaw 增加 API 或修改本体。兼容可核验的载荷变换，但不能放行未知改写、未授权历史或失效来源。合法路径必须能回答，不能通过清空历史、关闭必要能力或移除 blocker 制造通过。限制在 #23，复用现有事务、视图和 Host 接缝，不增加并行状态层。

## 本轮关键进展与导航

1. **完成协调的会话收尾已修复。** 原版 OpenClaw 2026.8.2 在 `deferTerminalLifecycle: true` 下发出 `finishing`，本轮原先已投递答复但会话仍为 `running`。保留延迟生命周期和硬完成协调，在实际持久化／投递结果后通过公开 `patchSessionEntry` 更新状态；绑定 sessionId、lifecycleRevision、startedAt，不改 Host 私有 writer/recovery 字段。发送前复验会话绑定，清理失败仍执行 markIdle。导航：[completion-adapter.ts](../src/openclaw/completion-adapter.ts)、[测试](../tests/completion-adapter.test.ts)、[Host 探针](../scripts/probe-main-plugin.mjs)。
2. **删除闭环已获最终包合成 Host 证据。** 物理删除合成来源→公开 synchronize→受影响视图重建→重启→同一旧会话两轮正常回答；原始历史保留，最终模型输入有当前视图、无失效内容，每轮一个实际模型请求，会话均为 done/no active run。恢复重放不重新调用语义模型。具体迁移／来源／历史代码以提交 diff 为准。
3. **失败路径有实际 Host 证据。** 业务持久化失败不发布草稿；实际 `chat.abort` 后为 killed、零 final，取消后仓库不继续变化；准备阶段已经同步的纠正不撤销。会话 startedAt 被改写时阻断发送且不覆盖新状态。取消验收基准是实际模型请求到达时的 HEAD/status，而非准备之前的 HEAD。
4. **6 项旧契约失败已修复。** `ca8ea78e` 更新了视图重建契约，验收目录仍绑定旧摘要。M-01～M-14 的条目、行号未变，仅更新固定摘要；49 个验收定位逐项核对。三个契约文件的篡改和旧 cases 版本证据仍被拒绝。导航：[delivery-catalog.ts](../src/acceptance/delivery-catalog.ts)、[delivery-ledger.test.ts](../tests/delivery-ledger.test.ts)。未修改运行门禁或验收判定算法。

## 验证证据：必须区分版本与层次

### 最新测试

最后执行 `npm run check`、`npm run check:schemas`、`node scripts/compile.mjs test && node --test .test-dist/tests/delivery-ledger.test.js`、`npm test`、`git diff --check`。

- 类型检查、9 个 schema、diff 检查通过。
- 对应测试 10/10；全量 **653/653，fail 0，cancelled 0，skipped 0**。
- 测试执行时尚为提交前工作树，其代码随后包含在 `acd2afaa`；不能把旧构建的 `sourceClean: false` 改写成干净提交验收。
- 本机日志：`/private/tmp/stella-delivery-contract-{before,focused,check,schemas,full}.log`。before 原样保留 6 项失败。

### 实际 Host / 最终包

原版安装的 OpenClaw `2026.8.2`，实际本机 Gateway 的 `chat.send` / `chat.abort` / `agent.wait` / `sessions.list`。来源为隔离合成 Git 仓库，模型为回环服务，结构化语义结果注入；没有私人资料或付费模型验收。Host 本体未修改；本轮没有重新逐字节对比 npm 原始 Host 分发包。

候选包：`/private/tmp/stella-issue23-lifecycle-package-8ZlVm3/tower1229-stella-core-0.1.0-alpha.0.tgz`，SHA-256：

`4d155574f7e33c1c0424f03be3d88f1d6c1800a7ef124f5683fbdc9cf027d177`

该包的 deletion、business-failure、status-changed、cancellation-final 四项探针 exit 0。它复用了本机 pinned 依赖符号链接，不能称为全新消费者安装。它产生于契约摘要修复前的 dirty 源码（基础 HEAD `ca8ea78e`），**不是从 `acd2afaa` 干净提交重打的包**；最新的全量测试不能替换该包的版本绑定。

本机详细记录：

- `/private/tmp/stella-issue23-lifecycle-evidence-receipt.json`：旧源码差异、文件摘要、包摘要、原始结果和边界。
- `/private/tmp/stella-issue23-lifecycle-package-results.json`、`/private/tmp/stella-issue23-lifecycle-package-binding.json`。
- `/private/tmp/stella-issue23-lifecycle-package-{deletion,business-failure,status-changed,cancellation-final}.log`。
- raw evidence 目录以各日志／receipt 中的实际路径为准；不手改证据，也不复制私人材料到公开仓库。

上述临时文件不随 Git 推送，跨机器或清理临时目录后可能缺失。下一会话若需要最终版本证明，按下节从固定干净代码重新生成证据，而不能只引用这里的通过数字。

原型诊断还保留了两次取消前准备阶段失败，准确根因未定位；第三次实际取消成功但旧“初始 HEAD 不变”断言失败；修正断言后的最终取消验证成功。不能删除这些失败或宣称全部尝试成功。最初关闭 defer 的隔离 Core 诊断产生提前空 final，不是合法修复；不得沿用。

### 独立评审

收尾生产源码和当时最终包经 Standards / Spec 两个独立代理审查，修复清理保证与诊断范围问题后未发现新增可证实的实质问题；包与编译输出核对一致。后续取消探针断言增量也经两轴审查。最新契约摘要修改有对应测试／全量验证，未据此宣称整票最终源码和新包已完成独立评审。

## 下一步顺序与停损

1. **先做剩余的原生共运行验证。** 确认 Active Memory / Dreaming 实际创建、读取、注入的路径，在当前 Stella 主消费链中测试合法内容正常回答、失效内容在模型请求前被阻断。既有原生产物重注入证明不等于原生插件与 Stella 共运行证明。只处理实际发现的入口，公开接缝有硬限制时给出路径、类别和证据，不修改 Host 或削弱来源绑定。
2. **验证成立后做最小私人资料本机验收。** 选择一个真实纠正或删除场景，检查同步、旧会话和重启后的回答。真实模型调用前明确资料范围、目的地、模型及费用授权；不能把合成结果替换为私人 main 成功，也不能把一次效果认可推广为全局通过。自然反馈单独报告，不做强制评分门禁。
3. **最终收敛时重新冻结版本。** 从明确的干净代码提交重新构建／打包，跑与最终修改匹配的 Host 探针，独立评审最终源码与包，将证据绑定完整提交 SHA 和包摘要；提交／推送按新任务授权执行。只有声明的消费路径有充分证据后才评估 `host_memory_consumption_unverifiable`，其他能力 blocker 独立保留。

早期准备阶段的偶发失败暂保留记录；若再次复现或影响上述主路径，再集中定位。不要为低价值的重复探针长期搁置任务，也不要因为稍后的成功抹去已观察失败。653 项全绿只说明本次自动化测试通过，不证明 #23 完整能力、真实 main 或生产已验收。

建议技能：遇到可复现运行失败使用 `diagnosing-bugs`；最终独立双轴评审使用 `code-review`（按其说明启动审查代理）；再次交接使用 `handoff`。当前没有本任务遗留的构建、全量测试或 Host 探针在运行；文档提交／推送由本次任务完成，下一会话先核对 Git 状态。
