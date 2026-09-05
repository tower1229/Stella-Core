# Stella Consciousness Restore Contract

现行规范入口：[设计基线](10-DESIGN-BASELINE.md)。恢复验证所选状态的完整性，测试覆盖另行设置 fixture。

## 1. 恢复对象

```text
兼容 OpenClaw / runner + Stella Core + 明确 CangHai revision + 必需外部凭据
→ 加载持久认知及配置 → 重建必要 views → 连续性验证 → 激活
```

核心意识包括身份、情境 Twin、精确 active IR、实践学习、主人特定行为资产和声明的重要未完成工作。不要求复制旧 Host 会话执行态、索引或 prompt cache。

完整产品还必须从 Git 副本取得全部声明留存的原始资料和附件；不依赖旧主机或库外附件存储。这个原始数据完整性出口与认知连续性分别报告，Alpha 认知恢复不能代替它。

## 2. 等级与空集合

| 等级 | 条件 |
| --- | --- |
| Level 0 | manifest、registries、持久记录及引用结构有效 |
| Level 1 | 所选 revision 声明的身份、Twin、IR、学习和状态完整加载，逐项核对身份与内容 |
| Level 2 | required 派生 views 重建成功并绑定同一 generation；未声明的可选 view 明示 unavailable／not_declared |
| Level 3 | 固定版本连续性 suite 的 required 结构断言和配置的行为容差通过 |

生产认知恢复以 Level 3 为成功。full_memory profile 还必须通过原始资料完整性、来源失效和 OngoingWork 接续检查。

开放 Episode、学习项或工作集可以合法为空：expected=0、actual=0 是成功；声明应存在却缺失才失败。不能为了通过通用恢复保留虚假的开放事项。专用验收 fixture 分别提供非空重要状态和合法空状态，保证覆盖两种情况。

## 3. 显式恢复流程

1. 从实例／操作者提供的 ref 解析一次完整 Git commit；缺少 ref 失败，不默认选分支。显式 HEAD 也立即解析。
2. 物化该 revision，要求干净 checkout，读取默认 manifest locator：50_PersonalAgent/stella/manifest.yaml。
3. 校验 Core／Host／runner、数据 schema、profile、模型策略、必要 capabilities 及外部 SecretRef。activationStatus 必须 active；migration_required／degraded 均阻断。
4. 按声明读取身份、profile、来源目录、Twin、精确 IR、Episode／playbook、工作／承诺及行为资产。对象缺失、版本错误、策略无效分别失败。
5. 验证历史记录对其历史版本的完整性，当前理解对当前有效来源的资格。来源被删除时不得通过旧 Git／摘要补回供正常召回。
6. 重建 required views；绑定 catalog generation、来源摘要及配方版本。任何 required view 缺失都阻断完成。
7. 在新 Host 运行连续性 suite，保存版本绑定的结构及行为证据。
8. 输出认知恢复、archive coverage、能力可用性及同步状态，再激活相应 profile。

sourceBaseline 记录派生历史，允许早于恢复 revision；不得要求后来学习的 HEAD 永远等于初始 bootstrap commit。迁移单独生成新 revision，restore 不静默改写旧数据来启动。

当前目录、认知对象和配置始终取自所选恢复树。目录中的历史 payload locator 可显式引用同一完整 Git 副本的旧 commit；它是有版本的历史证据，不是另一份当前状态。历史读取仍受当前删除／用途资格约束，不能由旧内容覆盖当前理解。

## 4. 能力可用性

必需 provider／secret／adapter 缺失：相应 profile 恢复失败。非必需能力可记录 unavailable，但不将实例标 degraded 后继续运行。

一个请求后来需要未启用能力时显式返回 capability_unavailable，不静默使用弱化答案。Memory Wiki 等检查视图不是普遍必需能力；只有 manifest／profile 声明 required 时才纳入 Level 2。配置和验证规则见 [Portable Registries](contracts/PORTABLE-REGISTRIES.md)。

## 5. 连续性证据

结构必须精确匹配所选 revision 的实例 ID、对象 ID／版本、active IR、声明工作状态、profile 和模型策略。重要 OngoingWork 的前提、纠正及开放问题独立于旧会话恢复。

行为 probe 使用版本化 rubric，不要求逐字相同。固定可用资料和时间边界，检查相关理解、框架选择、已学策略及交互立场。容差和必需项在运行前由 suite 指定；失败后不能改 rubric 以宣布成功。

私有 probes 及事实留在 CangHai／私有评测环境，公开 receipt 只含适当聚合数据。语义通过不等于主人实际使用满意。

## 6. 持久化与恢复点

本地 Git commit 可定位恢复版本，只有同步到明确远端才保护服务器丢失。managed 写入顺序：

```text
校验并发布对象 → scoped commit → persistent recovery pointer CAS
→ critical push / normal bounded-RPO queue → 发布一致的读取 generation
```

critical 成功必须确认远端；normal 可本地使用但带 remote_pending，RPO 超时显式 breached。RPO 数值必须配置并可观察，不能在代码里悄悄扩大。

pointer CAS 失败保留合法新提交并返回明确错误，不覆盖并发配置；push unknown 先核查远端。按 operationId 和提交记录接续，不重复生成学习。多文件部分发布、人工编辑冲突及 view 失效规则见 [Memory Lifecycle 同步契约](contracts/MEMORY-LIFECYCLE.md#5-来源变更同步)。

恢复过程不能把远端尚未同步的机器本地 commit 称为已经具备抗服务器丢失能力；也不能因旧 pointer 而静默回退到旧认知。

## 7. Runtime 状态与原始档案

可重建缓存、会话执行状态、未保留的临时模型状态可以不恢复。已经留存的原始对话及附件仍属于个人数据，其丢失不是“有意忘记运行态”。重要写作思考必须保存在 OngoingWork，不能因未结束对话而视为临时可丢弃。

删除、文件修改和历史物理管理由主人维护；Stella 没有事件级自然语言遗忘功能。

## 8. 现有执行入口与证明范围

现有 runRecoveryDrill、recover:private、praxis:private、test:package 和 candidate 是可用工程入口；命令参数见 [README](../README.md)及[本地集成](08-LOCAL-DEV-INTEGRATION.md)。

源码基线 22a9b91187e9966b2d5c0fba7a624a3a47eb5a52 的 drill 强制非空重要 Episode，并未满足本契约的合法空状态或完整 archive 检查。v1 Episode 读取也未实现 v2 来源语义。须改造相应 runtime／adapter／receipt 后重新验证，不能用旧输出宣称本契约已经实现。

Alpha 私有验收从同一 packed artifact、Core SHA、最终同步 CangHai SHA 和 OpenClaw 2026.8.2 运行 write-loop、干净恢复和评测。candidate 是不发布的证据集合；不自动授权生产配置变更、tag、Release 或 npm 发布。
