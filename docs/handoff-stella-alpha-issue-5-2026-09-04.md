# Stella 3.0 Alpha / Issue #5 交接（2026-09-04）

## 结论

实现代码已经推进并推送到 Core `master`，CangHai 的 managed-write 数据也已同步到 `origin/local/stella-alpha`；但当前 Core SHA 的最终闭环验收尚未完成，不能生成候选结论、执行本机激活、或关闭 Issue #5。

唯一正确的下一步是继续收口现有 Praxis 闭环：在当前 Core SHA 上重跑完整验证、重新打包、重新生成全部 Exact Host 证据，并在 40 个 evaluation case 全部通过后才进入激活、CI 与 Issue closure。不要转做 `deep_praxis`、其他领域、完整 Framework Compiler、fine-tuning 或多 Agent。

## 任务与权威来源

- Issue 合同：[tower1229/Stella-Core#5](https://github.com/tower1229/Stella-Core/issues/5)
- Alpha 计划：[`docs/05-ALPHA-PLAN.md`](./05-ALPHA-PLAN.md)
- Alpha 垂直切片：[`docs/05-ALPHA-VERTICAL-SLICE.md`](./05-ALPHA-VERTICAL-SLICE.md)
- Praxis Episode 合同：[`docs/contracts/PRAXIS-EPISODE.md`](./contracts/PRAXIS-EPISODE.md)
- CangHai 数据面：[`docs/03-CANGHAI-DATA-PLANE.md`](./03-CANGHAI-DATA-PLANE.md)
- OpenClaw 集成与激活：[`docs/04-OPENCLAW-INTEGRATION.md`](./04-OPENCLAW-INTEGRATION.md)、[`docs/08-LOCAL-DEV-INTEGRATION.md`](./08-LOCAL-DEV-INTEGRATION.md)
- 恢复合同：[`docs/06-RESTORE-CONTRACT.md`](./06-RESTORE-CONTRACT.md)
- 实际实现以当前提交、diff、测试和 `scripts/` 下验收 Runner 为准；不要在本交接中重新解释上述文档已经定义的合同。

## 用户授权与边界

- 已授权使用 CangHai 中一个最小真实关系/社交案例进行本机私有 Exact Host 验收，并允许其经过当前 OpenClaw 配置的外部 Gemini provider。
- 已授权为本计划提交并推送 Core/CangHai，以及仅在全部门禁通过后更新并关闭 Issue #5。
- 不创建 tag、GitHub Release，不发布 npm，不部署生产环境。
- 私有案例正文只能留在本机 OpenClaw/CangHai；禁止写入 Core、公开 fixture、日志、CI 输出或 receipt。公开 Runner 只使用 opaque case ID 和 adapter 返回值。
- 多次真实 write-loop 已在 CangHai 形成合法 Episode/learning 历史；不要为“清理测试数据”删除或重写这些用户学习数据。失败的半成品已按显式失败语义处理。

## 当前仓库事实

### Stella-Core

- 路径：`/Users/zangtao/Workspace/tower1229/Stella-Core`
- 分支：`master`
- HEAD：`2b20ca2e7ffab3ca89b2d76c79cfe045d2efef70`
- `origin/master`：同一 SHA
- 交接文档创建前工作区干净；当前仅本交接文档为未跟踪文件，未提交
- 最新提交：`2b20ca2e fix: define personal context evaluation boundary (#5)`

本轮相关修复已经按多个小提交落地；从 `960d0b35` 至 `2b20ca2e` 的提交记录覆盖 Exact Host finalization、Hook 关联、Episode 持久化、语义路由修复、失败诊断、`main` Agent 对齐、evaluation fail-closed、跨域个性化约束，以及 personal-context judge 边界。直接查看提交与 diff，不要从本交接复制实现描述。

### CangHai

- 路径：`/Users/zangtao/Workspace/tower1229/CangHai`
- 分支：`local/stella-alpha`
- HEAD：`49e7270c915775cc42c52f14e02cc360e148ab8b`
- `origin/local/stella-alpha`：同一 SHA
- 工作区：干净（Git fsmonitor 曾输出非阻断警告）
- 私有 adapter：`50_PersonalAgent/stella/acceptance/alpha-adapter.mjs`
- 私有 evaluation fragment：`50_PersonalAgent/stella/acceptance/praxis-private.json`

## 已实现能力

以下能力已有代码、测试和历史 Exact Host 运行证据，但仍须绑定当前 Core SHA 重新验收：

- Episode 生命周期已收紧为 `open -> recommended -> acted/observing -> closed`，实际行动通过独立入口记录；Schema 对 `acted` 和 `closed` 的必需字段作条件约束，并包含旧 Episode 迁移。
- Prediction 在 recommendation 前密封；后续状态迁移不能改写 snapshot。
- managed durability 已按 commit、持久 recovery pointer CAS、push/flush、进程内 loader 的事务顺序实现，错误保持显式分类。
- `stella:activate` 支持 `--check` / `--apply`，包含版本、manifest、分支、远端、配置、权限、备份和回滚检查。
- 新增 Praxis write-loop receipt、clean-runtime recovery、durability diagnostics、private evaluation 与 Alpha candidate v2 组合门禁。
- Hook finalization、跨 run ID 关联、`main` Agent、Episode outcome 选择及语义结构化路由修复已落地。
- 路由仍遵守 LLM-only 语义判断；确定性代码只做结构/权限/失败边界。有限重试只修复无效结构，不以关键词或 prompt `includes()` 冒充语义路由。
- evaluation 对失败维度和进程退出状态已 fail-closed；当前提交进一步明确 `public_synthetic` 与 `private_canghai` 的 `personalContextUse` 评分边界。

## 最近一次有效但已过期的证据

目录：`/private/tmp/stella-alpha-final-582/`

- `praxis-loop-receipt.json`：绑定 Core `5820972e063e441878247c20c2beb4297804472c`、artifact SHA-256 `2930d7d08f0906c2f7e2fa160470e8feef694507d4fe5478bd1055e2e39e4af3`、OpenClaw `2026.8.2`；三轮真实 managed-write 闭环、prediction 密封、recommendation/actual/outcome/learning、重启后 learning 使用、最终远端同步均为真。最终 CangHai SHA 为当前 `49e7270c...`。
- `private-recovery.json`：clean runtime recovery 的全部恢复项为真，绑定同一旧 Core/artifact 与当前 CangHai SHA。
- `durability-diagnostics.json`：critical 同步、normal RPO 0 秒、local/synchronized revision 均为 `49e7270c...`。
- `praxis-evaluation.json`：40 case 中 29 通过、11 失败；所有失败维度都只有 `personalContextUse`。这正是当前提交 `2b20ca2e` 修正的 judge 边界。

这些文件仅是回归定位证据。它们不绑定当前 Core SHA，不能用于 candidate v2、激活或关闭 Issue。

## 当前阻塞与原始 OpenClaw 故障

- 当前 Core `2b20ca2e` 的 `npm run verify` 曾运行到 package smoke 前：TypeScript check、4 个 Schema、build、98 tests 已通过；随后会话在 package smoke 阶段被用户切换为交接任务，最终状态未知。不要拼接这次部分结果，必须从头重跑完整 `npm run verify`。
- 进程列表在沙箱中无法读取，因此不能确认是否仍有遗留 package-smoke/OpenClaw Gateway 子进程；下一会话开始时先只读检查。
- 用户截图中的本机 OpenClaw “Stella Core 无法加载或验证 CangHai 核心意识数据”与 recovery pointer/activation fail-closed 路径一致。相关事务和激活代码已经实现，但真实本机 `--apply` 尚未在当前最终证据门禁后执行，因此不能声称故障已修复。先完成候选证据，再执行 apply 并实测普通消息与 Praxis 消息。
- GitHub API 本次因网络不可达，未重新读取 Issue #5 的线上状态。不得凭记忆假定其已关闭；下一会话须在线核验。

## 下一会话执行顺序

1. 读取仓库 `AGENTS.md` 和上述合同；检查 Core/CangHai 状态、远端同步、OpenClaw/Gateway 遗留进程。不要修改或删除历史 Episode。
2. 在 Core `2b20ca2e...` 上从头运行 `npm run verify`；package smoke 必须自然结束并成功。
3. 将当前干净 Core commit 打成新的唯一 tarball，计算 SHA-256；不要复用 `stella-alpha-final-582` artifact 或 receipt。
4. 以 CangHai 当前完整 SHA `49e7270c...` 为 initial revision，调用 `npm run praxis:private`，使用私有 `alpha-adapter.mjs`，输出到新的 `/private/tmp/...` 目录。该步骤会合法推进并推送 CangHai；记录新的最终完整 SHA。
5. 显式确认 outcome learning flush，CangHai clean，HEAD 等于 `origin/local/stella-alpha`。
6. 对步骤 4 的最终 CangHai SHA 和同一 artifact 运行 `npm run recover:private`，必须是全新隔离 OpenClaw `2026.8.2` runtime。
7. 使用公开 `evaluation/praxis-social.synthetic.json`、私有 `praxis-private.json`、同一 adapter/artifact/recovery receipt 运行 `npm run evaluate:praxis`。要求 40/40、`failedDimensions: {}`、进程退出 0。
8. 若 evaluation 仍失败，只按真实失败维度诊断；禁止放宽门禁、伪造个性化证据、加入关键词路由或静默 fallback。修改 Core 后，所有 artifact/receipt 再次失效，回到步骤 2。
9. 用同一套 write-loop、recovery、evaluation、durability 证据运行 `npm run candidate`，生成 `stella.alpha-candidate-receipt/v2`；输出目录必须在 Core 仓库外。
10. 先运行 `npm run stella:activate -- --canghai-root /Users/zangtao/Workspace/tower1229/CangHai --agent-id main --data-mode managed_durable_write --check`。仅在 candidate v2 成立后执行相同参数的 `--apply`，随后检查配置、插件 runtime、Gateway，并实际发送普通消息与 Praxis 消息验证截图故障消失。
11. 确认当前 Core SHA 已推送并等待该 SHA 的 CI 全绿；在线读取 Issue #5，再逐项附证据并关闭。任何一步失败均不得生成候选结论或关闭 Issue。

各验收脚本的精确参数合同直接见：

- `scripts/run-private-praxis-loop.mjs`
- `scripts/run-private-recovery.mjs`
- `scripts/run-praxis-evaluation.mjs`
- `scripts/create-alpha-candidate.mjs`
- `scripts/stella-activate.mjs`

## 建议下一会话使用的 skills

- `deliver`：适合继续执行完整验证、打包、真实 Host 验收、简化检查和最终交付门禁。
- `diagnosing-bugs`：仅当 40-case evaluation、package smoke、Gateway 或激活再次失败时使用；先复现并保留结构化证据，再修改。
- `code-review`：在准备最终 candidate/Issue closure 前，对当前 Issue 合同和仓库标准做一次只读复核。
- `code-simplifier`：仅在最终功能稳定且所有回归通过后，对本轮新增代码做等价简化；任何改动都会使 receipt 失效，必须随后重跑全部证据。

## 完成定义

只有同一套当前 Core SHA、tarball hash、OpenClaw `2026.8.2`、最终 CangHai SHA 同时满足 write-loop receipt、clean-runtime recovery、40/40 private evaluation、durability diagnostics、candidate v2、Core/CangHai clean 且远端同步、当前 SHA CI 全绿、本机 activation/apply 后真实消息恢复，Issue #5 才可关闭。
