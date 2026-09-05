# Stella Alpha 历史交接证据（2026-09-04）

本文只保留旧交接中的版本和诊断线索。原“唯一下一步”、执行顺序、固定 40-case 出口和授权段落已由[现行设计基线](10-DESIGN-BASELINE.md)及[本机运行手册](08-LOCAL-DEV-INTEGRATION.md)替代，不是当前执行指令或新任务授权。

## 当时的源码与证据

| 项目 | 历史记录 |
| --- | --- |
| 当时 Core HEAD | 2b20ca2e7ffab3ca89b2d76c79cfe045d2efef70 |
| 当时 CangHai 测试分支 | local/stella-alpha |
| 当时 CangHai HEAD | 49e7270c915775cc42c52f14e02cc360e148ab8b |
| 旧 Exact Host 证据绑定 Core | 5820972e063e441878247c20c2beb4297804472c |
| 旧 artifact SHA-256 | 2930d7d08f0906c2f7e2fa160470e8feef694507d4fe5478bd1055e2e39e4af3 |
| Host | OpenClaw 2026.8.2 |

旧 write-loop 和 recovery receipts 记录了 managed-write、同步、重启及学习复用的成功路径。
同套旧评测为 40 项中 29 项通过、11 项未通过，失败维度为 personalContextUse；随后提交修改了 judge 的适用边界。这些记录只支持当时的回归分析，不能推定当前通过。

当时完整 verify 在 package smoke 阶段被交接任务中断，最终结果未知。本机激活和故障恢复也没有由该交接证明完成。历史机器路径、临时文件及进程状态不作为当前环境事实。

## 当前使用方式

新工作读取[现行 Alpha 验收](05-ALPHA-PLAN.md)、[Episode 契约](contracts/PRAXIS-EPISODE.md)和[恢复契约](06-RESTORE-CONTRACT.md)。新的结构、状态机和失败断言需要新的证据；旧 case 数量、receipt 版本或 Issue 提案不能覆盖这些要求。

历史授权只属于其原任务；本文件不授予新的私有数据迁移、模型外传、提交推送、激活或 Issue 修改权限。历史私人学习记录的保留与修订仍按当前任务和来源契约处理。
