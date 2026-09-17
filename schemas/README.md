# Schemas

现有机器格式包括 Consciousness Manifest v1、Framework IR v1、Twin Hypothesis v1 和 Praxis Episode v1；Episode v1 仅描述现有存量解码范围。

[Praxis Episode v2](praxis-episode-v2.schema.json)是现行新写入目标，收紧实际行动来源、证据引用及状态条件，并允许未知行动发生时间。当前 runtime 仍需显式迁移和升级，不能因为 schema 文件存在就启用 v2。

npm run check:schemas 编译全部已登记 Schema。v2 契约测试验证真实／推断行动、缺证据、未知时间、无预测评估及关闭状态；时序、分布归一、跨记录引用和持久化原子性还须由运行协议及对应测试检查。

[Memory Lifecycle](../docs/contracts/MEMORY-LIFECYCLE.md)和 [Portable Registries](../docs/contracts/PORTABLE-REGISTRIES.md)中的新增格式具有规范性字段定义，其机器 Schema／adapter 校验仍待实现；不得将旧四个 Schema 的成功当作这些契约通过。

所有示例和测试使用合成数据，禁止复制私人资料。

Issue #16 增加 [Archive Manifest v1](archive-manifest.schema.json) 与 [Ingest Checkpoint v1](ingest-checkpoint.schema.json)。运行时还校验事件唯一性、正文／附件摘要、游标衔接、事务恢复、同步及清理资格。旧 Coverage 缺声明清单时不能用于新清理确认；升级流程见 Memory Lifecycle 的工作项 10 增量。

`source-synchronization.schema.json` 校验来源同步的 pending／completed 持久读取屏障。无该文件的既有仓库无需迁移；首次 synchronize 在当前目录代际上创建，未知或损坏版本阻断读取，不自动降级。
