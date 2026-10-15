# Issue #23 — Core 受管整理

D-057 以 Core 受管整理承接原生 Dreaming 的生成职责。原生 Dreaming 保持显式禁用；原生行为诊断不能算合格生成证明。来源、代际、权限和最终消费约束同样适用于替代能力。

## 入口与行为

`stella.consolidateMemory({operationId,request,evidenceRefs})` 是显式本机管理员操作。它要求 managed_durable_write、独立持久 `operatorMemoryConsolidation: true`、确切模型的仓库处理授权和 Host completion 许可，以及原生 Dreaming 显式禁用。未知字段、重复 Ref、超预算批次、远端调用或缺授权明确失败。

调用方提供明确 Evidence 批次，先核验 Source／Evidence 策略所有者及学习用途，再经既有 resolver 读取原件、核验片段权限、来源角色和解释约束；结构化 LLM 生成提案并独立复核。只新增 scoped candidate hypothesis，不修改主人原文／工作／框架，不把助手或第三方文本升级成主人事实。

模型传输经过私有维护 lifetime 和单次 exact-payload 消费许可。SDK 返回内容须匹配受控 provider 的 opaque 输出收据；维护许可不能运行普通 agent 或投递。新理解携带全部模型可见原件和已有候选的版本依赖。

发布复用 LearningChange、MemoryTransaction、catalog generation、view migration、critical Git 同步和 journal 恢复。同步等待结束后再次核验来源与许可，才释放事务屏障。同 operationId 的请求／Evidence 绑定不可更换；恢复只执行原计划，不重新生成。后续 MEMORY 与最终输入消费继续使用既有权限、来源和受众门禁。

## 验证范围

`tests/memory-consolidation.test.ts` 覆盖生成／发布前修改、删除、代际变化、撤权、取消、并发发布、崩溃恢复、同步后再次失效、来源角色与受众拒绝。相关 correction／provider／plugin／delivery contract 测试须一起执行。

| 安装包探针 | 断言 |
| --- | --- |
| `--core-consolidation` | guarded 提案与复核、原子发布、幂等、重启最终消费、删除后零最终模型请求 |
| `--core-consolidation-source-stale` | 提案收到原文后删除来源，后续模型与发布阻断 |
| `--core-consolidation-revoked` | 提案期间撤销整理授权，后续模型与发布阻断 |
| `--core-consolidation-recovery` | 本地远端同步失败保留 fence；重启恢复同一计划，零重新生成，并验证消费及删除阻断 |

这些探针和既有 77 个探针使用同一候选／包。资料、语义结果和模型 endpoint 为合成／注入／loopback；没有外部模型调用。每次收据须绑定源码 SHA、source manifest、包摘要、固定 Host、harness 和场景版本，不能拼接不同候选的成绩。

## 历史失败与证据限制

公开基线的 [Linux CI 运行](https://github.com/tower1229/Stella-Core/actions/runs/38661857276) 曾在授权独立压缩后的重启消费等待处超时。保留日志位于 queue／gateway_draining 重试阶段，缺少完整最终事件及排空原因，不能据本机通过判为 flaky 或宣称已修复。

另一次合成候选的 advice-revision-recovery 返回 question_recovery_failed。HEAD／远端／pointer 一致但事务屏障保留；底层异常未捕获，三次日志诊断未重现。该失败独立保留，不能并入当前通过数量，也不能推断其根因。

固定 Host 的基线已有精确 recoveryRevision 的 `reload.hotPrefixes`，且没有 reload-plugins 动作。最终实现保留该规则，没有将缺乏因果证据的 noop 实验当作修复；未延长超时、放宽断言或禁用整体 reload。当前候选必须独立执行完整回归，Linux 结果另行报告。

## 保留的准入边界

实际目标的声明入口、安装代码、来源代际和最终消费须各自取证。未知入口继续 fail-closed。合成验证不授予生产配置、资料处理、持久任务或发布权限，也不证明真实模型质量或私人使用效果。

`issue23Complete`、`fullMemoryAccepted`、`privateMainAccepted`、`realModelAccepted` 均不能凭本次合成结果改为 true。#35／#36／#37／#38 仍分别负责完整能力整合、冻结准入、真实 main 和完整故障矩阵。
