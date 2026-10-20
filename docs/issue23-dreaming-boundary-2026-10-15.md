# Issue #23：原生 Dreaming 边界诊断

本页记录固定 OpenClaw `2026.8.2` 的原生行为反例。D-057 已选择 Core 受管整理作为生成路径；实现与验收边界见 [Core 受管整理](issue23-core-consolidation-2026-10-15.md)，正式接口分析见 [Dreaming 正式接口可行性核查](issue23-dreaming-public-seams-2026-10-15.md)。

## 三条验收与诊断范围

| 验收 | 已有可复用机制与诊断 | 保留的限制 |
| --- | --- | --- |
| 声明入口及实际代际／来源校验 | 索引、会话、压缩、bootstrap、guarded provider，以及内置 Dreaming、配置独有插件、内部 hook 和状态冲突清单 | 清单不等于来源消费收据；未知入口保持阻断 |
| 当前轮、新轮、new、重启、旧会话、Active Memory、整理不回流 | 原生生成期间修改／删除、发布后删除、真实产物拒绝及共运行反例；D-057 增加 Core 合法生成至消费闭环 | 原生诊断不能冒充合格整理；每次证明须绑定同一源码、包和 Host |
| 无法校验时完整 profile 显式失败及受众消费 | 独立 full_memory blocker、最终 payload 和受众检查 | 合成结果不授予真实目标或完整产品准入 |

## 已确认的原生边界

1. 原版 Host 在 narrative 已收到合成原件后，即使原文件被改写或删除，仍可发布旧日记。内部 sourceEntryKeys 不等于 Core Source Version 或 Memory Generation。
2. 原生 Dreaming 与合成 Core 共运行时，未授权子运行被拒绝，但 native phase／promotion／fallback 仍可修改派生文件。下一轮因 projection drift 被拒绝；cron 成功、文件写入或 fallback 不能算合格学习。
3. 原生路径缺少把完整来源闭包、当前处理权威及全部输出写入交给 Core 事务的公开接缝。事后补 generationId、把助手产物当作用户来源或仅包装模型，都不能补齐发布协议。

D-057 通过 Core 持有输入和发布权的整理操作承接生成能力。它不修改 Host、不调用私有 native runner，不放宽 required 能力，也不清除未知入口的 blocker。

## 可重复的合成诊断

```sh
node scripts/verify-dreaming-boundary.mjs
```

脚本执行类型、schema 和测试检查，打包并逐文件核对候选，验证来源变化与原生共运行。每个 Gateway 使用独立状态、合成资料和 loopback endpoint，结束后停止。收据记录源码／fixture／包／Host 清单及场景版本；本地生成证据不随源码提交。

这些原生反例是独立诊断，不拼入 Dreaming-disabled 安装包验收，也不证明原生生成已合格。当前候选的完整测试及安装包结果以其独立 receipt 为准；失败记录不得改写或计入通过数量。测试并发限制为 4，未缩减测试集合、断言或超时。

`issue23Complete` 和完整 profile blocker 保持独立。#35 完整能力整合、#36 冻结准入、#37 真实 main、#38 完整故障矩阵分别处理。
