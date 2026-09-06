# Stella Alpha 工程收敛交接

交接日期：2026-09-07。本次仅整理交接，不启动新修复或外部评估。

## 接手结论

上轮任务为“继续完成工程修复”。已解除证据输出、共思答案绑定及评审解析造成的工程中断；同构建恢复通过，40-case 混合评估完整执行，36 通过、4 失败，私有部分 8/8 通过。**Alpha 未通过，不生成通过候选。**

下一优先项是公开案例人物与额外合成 Twin 背景的上下文归属边界，不是重新修复已经验证过的绑定遗漏。完整修复历史、失败案例、测试数字和验收 SHA 直接参见 [Alpha 收敛记录](alpha-convergence-2026-09-06.md)，不要重新抄写或用新结论覆盖历史失败。

## 首先阅读与当前仓库状态

按以下顺序恢复上下文：

1. 根 `AGENTS.md`、`CONTEXT.md`。
2. [已确认需求](09-REQUIREMENTS-ALIGNMENT.md)、[当前设计基线](10-DESIGN-BASELINE.md)、[Alpha 出口](05-ALPHA-PLAN.md)。历史交接和关闭的 Issue 不覆盖当前要求。
3. [Alpha 收敛记录](alpha-convergence-2026-09-06.md)、根 `PROJECT-STATE.yaml`；按需读 `docs/contracts/` 与 `docs/DECISIONS.md`，不要把完整产品缺口全部扩入 Alpha。

交接时只读核查：主仓库 HEAD 为 `af298d13b83dc39541fd0da54f59fa2ced20d8a0`，标题为 `feat: enhance testing and evidence management with improved schema validation and response handling`；写本文前 `git status --short` 无改动。上一轮结束时 HEAD 还是 `1c49cf5…` 且修复未提交，因此旧收敛记录中的“主工作树仍未提交”是历史状态，不能作为当前状态使用。本次没有创建 Git 提交。

验收用隔离源码仍是 `.artifacts/alpha-convergence-source-20260906`，确切版本见收敛记录和本地索引。**不能把隔离构建收据直接改写成主仓库新 SHA 的验收证据。** 修改前重新检查当前差异，保留已有用户变更。

## 下一步：构造上下文边界的可回放失败

建议使用 `diagnosing-bugs` 技能：先建立能重现具体失败的短反馈环，再判断修复落点。上轮借此用失败回归及原生响应重放验证工程修复，不能仅靠调整提示后偶然通过来关问题。

已知事实：

- 四条公开失败都仅为 `personalContextUse=false`，不是评估中途停止。
- `help-01` 原生回答明确引用公开测试仓库的 Twin 假设 `Prefers reversible experiments`；来源已对照 `tests/consciousness-fixture.ts` 确认，不是用户私有资料。
- 其他三条失败的评审也指出案例外个人背景归属。最终失败列表与维度保存在收敛记录及报告。
- 公开运行已经使用独立仓库与 Host 状态；仍需区分“测试源携带不适用的人物背景”“运行器未表达案例人物边界”和“运行时错误应用个人解释”。目前尚未完成该问题的最小复现和修复落点验证，不预先宣布只是提示词问题。

建议检查入口：

- `scripts/run-praxis-evaluation.mjs`：逐案例公共／私有源选择、`createCaseRuntime`、目标回答与评审隔离。
- `src/acceptance/model-praxis-evaluator.ts`：Case 输入与 public_synthetic rubric；不放宽该门槛。
- `tests/consciousness-fixture.ts`、`.artifacts/prepare-public-evaluation-source.mjs`：公开合成源的 Twin 假设来源。后者是诊断准备脚本，不是生产入口。
- `src/plugin.ts`、`src/praxis/question-evidence.ts`：路由、认知上下文、证据评估及最终回答准备。

先用保存的公开失败响应、Case 和运行上下文复现，再验证修复。不得通过将背景追加成案例事实、删除失败案例、修改评分或词面过滤个人表述来制造通过。语义判断仍由 LLM 完成。确需新的原生验收时，使用新隔离快照和明确产物；不同构建／数据源的部分结果不能拼成最终 40-case 通过结果。

## 本地证据定位（不将私有路径或正文复制进公开文档）

入口为忽略目录中的 `.artifacts/three-task-progress-2026-09-06.json`，读取：

- `checks.alphaConvergence20260906.latestSourceRevision`、`latestArtifactSha256`、`latestRecoveryOutput`、`latestRecoveryEvidence`：最终 v8 源码、包及恢复证据。
- 同节 `currentMixedEvaluation.output`、`.evidence`：最终完整混合报告和逐案例证据目录。
- 同节 `mixedEvaluationV4Failure`、`mixedEvaluationV6Failure`：旧评审格式与共思绑定失败的原生证据。
- `checks.publicSyntheticEvaluationBaseline`：独立公开源位置及 revision；私有源和 adapter 的确切位置沿索引、现有收据及旧运行参数定位，不猜测路径。

注意该 JSON 顶部及同节早期 `sourceRevision`、`recoverySessionId` 等字段是历史尝试，不是最新结果。使用 `latest*` 和 `currentMixedEvaluation`。最后恢复及评估进程均已退出，无需继续轮询旧 session ID；评估退出码 1 是四条语义门禁失败，报告已完整生成。

逐案例目录内 `evaluation-evidence.json` 保存诊断及绑定摘要；原生 SQLite 位于各案例的 `openclaw-state/agents/<agent>/agent/openclaw-agent.sqlite`。只读查询 `trajectory_runtime_events`，通过记录的 run ID 定位 `context.compiled` 和 `model.completed`。仅输出必要的安全摘要或公开回答文本，避免打印完整 messagesSnapshot（可能含模型思考、签名等无关字段），不要输出私有正文。

现有 `.artifacts/replay-judge.mjs`、`.artifacts/replay-evaluation-binding.mjs` 是历史只读重放入口，使用前核对其绑定的案例与参数，不能直接套到新案例。临时响应捕获代码及两份捕获正文已在上一轮清理，历史日志和回放证据保留。

## 已授权边界与不可误报项

- 用户此前允许使用当前 OpenClaw 配置的 `google/gemini-3.1-pro-preview`，向外发送指定 8 个私有关系／社交案例，以及恢复验收所需身份、框架、Twin、Praxis learning、重要开放状态与必要上下文；用途是隔离评估及失败诊断重跑，不是任意外发。
- OpenClaw 2026.8.2 的 `stella-openclaw-2026.8.2-private-draft-v1` 兼容补丁仅限已授权隔离测试；确切模块与原／新摘要在收据中，不改生产 Host。
- 用户明确跳过个人原始行动／结果确认，保持 `skipped_by_user / unverified`，不要再次索要，也不能把未知来源或模型生成资料变成主人真实学习证据。恢复对合法空学习／开放状态的成功不证明非空状态或真实学习。
- 不改原始个人仓库，不激活、发布、push 或擅自提交主工作树。历史无远端隔离快照提交不代表其他 Git 操作授权。本任务不需要子代理。
- 历史首例瞬时绑定失败的根因仍未证实；run ID 不一致猜测已排除。已确认并原生验证的是第四例 collaboration 分支遗漏，二者不要合并成同一个根因。
- 共思 EvidenceBundle／事务补齐不代表完整 OngoingWork 或写作学习已实现；其余 Alpha 出口缺口沿现有状态文档推进。

## 运行注意

Windows PowerShell；本地修改用 `apply_patch`。隔离目录先前由提升权限进程生成，必要时按既有范围请求提升权限，不修改全局 Git 信任配置。可用进程级 `safe.directory` 与 `core.longpaths=true`；不要并行执行针对同一 `dist` 的编译和安装器测试。

本地测试入口已会先构建：`npm test`。后续仅跑与新改动相称的回归；无新改动／失败时不必重复全套。原生恢复约数分钟，逐案例混合评估可超过一小时；保留一次运行，等待结束，不因慢或语义失败反复重发。运行器入口为 `npm run recover:private -- ...` 与 `npm run evaluate:praxis -- ...`，确切参数从本地索引及脚本校验读取。

只有实际推进到模块接口重构或新增测试方式时，才按任务触发相应技能；本交接不预先要求架构重构，也不授权扩展产品范围。
