# Core Data Contracts

[设计基线](../10-DESIGN-BASELINE.md)定义现行权威与验收分层。契约包含逻辑语义、序列化、生命周期和跨对象不变量；JSON Schema 通过只代表其中的结构部分。

| 契约 | 维护职责 |
| --- | --- |
| [Memory Lifecycle](MEMORY-LIFECYCLE.md) | 来源／证据、资料接入、检索、交互学习、变更同步和 M 系列验收 |
| [Portable Registries](PORTABLE-REGISTRIES.md) | 实例发现、目录、配置、能力、使用策略与格式迁移 |
| [Consciousness Manifest](CONSCIOUSNESS-MANIFEST.md) | 可移植认知入口和恢复所需引用 |
| [Twin Hypothesis](TWIN-HYPOTHESIS.md) | 有范围、可修正的主人行为假设 |
| [Framework IR](FRAMEWORK-IR.md) | 权威原文、精确执行快照和实践反馈分离 |
| [Praxis Episode](PRAXIS-EPISODE.md) | 决策事项、封存预测、真实行动和结果；新写入目标 v2 |

原始文章、对话及媒体保留原格式；不强制塞入认知对象。Twin 保持可读 Markdown＋结构化字段，Episode 采用 JSON＋独立预测快照，Framework Source 为主人原文，active IR 为持久 JSON／YAML 快照。索引和可重建投影归 Host runtime。

非确定性 active IR 必须保存精确快照；新编译产生新版本，不能当作无损恢复。对话运行态与完整原始档案是不同职责。

所有新格式先交付结构与语义校验及显式迁移，再启用相应 profile。现有 v1 解码器和旧测试不覆盖新契约；实现缺口集中记录在设计基线，不作为另一套现行规范。
