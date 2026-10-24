# Checkpoint Ongoing Work 的只读供给

2026-10-24。对应 #24 的正常 Host 消费接缝，不代表该 issue、自动学习或 full_memory 全部完成。

## 运行契约

原版 Host 继续负责用户请求、模型执行、工具循环、取消和聊天历史。正常 Agent 可调用现有
`stella_memory_data` 的 `{"action":"work"}`，没有新增写工具。Core 以捕获的本次用户原问题、
当前权限和 checkpoint 调用既有 Personal Views 语义选择；不按关键词推断任务，也不接受
模型另传 owner、question、路径、source revision 或选择结果。

该动作需要已有 source_access_context binding 和精确当前模型的 viewProcessingModelRefs。
未获视图处理许可时明确拒绝 work；不为已可用的 raw list/read/skill 偷增或强制新的许可。
当前选定 commit 的 catalog 必须与实际 reader 匹配，不能把观测 HEAD 升格为 expected。
原 Source policy 仍逐项判断，合法拒绝与缺少审核描述/对象损坏分别表达。

仅输出选中的 work/ref、当前代次、排除信息和来源规则；保留 confirmed/proposed/rejected/open
字段及原始版本。原文候选和其他视图不直接出现在 work 工具结果，所选 work 的 policyRef、
解释规则和 quotePolicy 保留为 usageConstraints。派生理解不是新的 owner 原话或执行许可，
summary 用途不产生引用授权。语义选择本身仍会向获准的当前模型提供候选及其原始依据；
真实使用的资料外发和辅助模型费用需按实际范围授权。

首次供给验证当前版本；本次用户请求内可以复用已经合法供给的 Work，保留身份与正常取消
检查。下一用户请求重新加载权限、catalog 与 checkpoint。同一请求内的工具续轮不是新
用户请求；依 D-058 不承诺运行中撤回内容，不接管未知旧历史。

## 已取得的证据

源码 `3cb3ed48b4495332ae0403d3302127e198cc2fc3` 的隔离预检包 SHA256：
`810c687f6dcc7c1511739f7332c59a5d3bc1a187b214642083c37940473cbbfb`。
491 个安装文件逐一与 tgz 相同；原版 OpenClaw 2026.8.2 直接加载该包，没有 observer wrapper
或 Host 补丁。Host 身份证据限公开版本、launcher 和安装锁，不宣称整树来源认证。

- 新 Work 针对测试13/13，既有 source-access13/13、hook供给回归74/74，类型和编译通过。
- 两个公开新会话实际 chat.send → Agent 调用 work → 来源判断 → 视图选择 → Agent续轮 → 回答。
  共9份完整 loopback wire：4次 Agent、3次 Source policy、2次 selector。工具输入/输出与
  后续 provider 请求均核对完整 work/ref、当前 checkpoint、来源规则；候选原文没有直接
  进入 Agent 请求。confirmed/proposed/rejected/open 的原含义保持。
- A→B 之间通过**安装包内可信 Core correctLocal**执行一次 Git/CAS；策略、proposal、
  verifier 回调明确为本地合成 stub。下一新会话实际 Host 读取B，而非旧A。它证明已落盘
  纠正能被消费，不证明聊天已自动触发 writer，也不证明真实模型纠正质量。
- 唯一登记 Gateway 正常 exit0；provider 全部 HTTP 捕获并在关闭后检查数量、合法类别及
  场景闭合窗口。合成源已清理，owner运行标记已移除，无取消或未决进程。

原始收据在项目 `.artifacts/checkpoint-work-20261024/`：verification-a1/a2、
hook-regression-a1，以及 source-a1/.artifacts/work-installed-a1/host-work-a1/result.json 和
provider-1..9.json。产物不提交；最终 CI 使用最终提交另建同包，不把此预检包身份搬过去。

标准命令 `npm run verify:experimental` 在干净、固定 checkout 执行。Work 报告作为第七份
必需报告与 continuous/v3/snapshotImport/skill/budgetFile/budgetTotal 共用一个实际安装包。
收据核验真实 wire、精确版本、来源规则、最终消费、已关闭的请求窗口与正常退出；报告缺失、
不匹配、后到请求或取消均不能通过。完整152项能力评估保持独立原失败门槛。

## 仍未覆盖

当前可用的是已保存 Ongoing Work 的只读接续。正常聊天自动识别纠正、自动调用 writer、
其他 learning/outcome 的 checkpoint 迁移、完整 transcript 和 compaction 不在本项通过范围。
#24 仍有这些前置与真实行为证据缺口，不能仅凭工具可调用就关闭。旧 main 包未更新；真实
网页 profile/grant、真实记忆外发和模型费用均需各自完成边界确认。fake模型只验证机制。
