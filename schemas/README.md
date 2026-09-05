# Schemas

现有机器格式包括 Consciousness Manifest v1、Framework IR v1、Twin Hypothesis v1 和 Praxis Episode v1；Episode v1 仅描述现有存量解码范围。

[Praxis Episode v2](praxis-episode-v2.schema.json)是现行新写入目标，收紧实际行动来源、证据引用及状态条件，并允许未知行动发生时间。当前 runtime 仍需显式迁移和升级，不能因为 schema 文件存在就启用 v2。

npm run check:schemas 编译全部已登记 Schema。v2 契约测试验证真实／推断行动、缺证据、未知时间、无预测评估及关闭状态；时序、分布归一、跨记录引用和持久化原子性还须由运行协议及对应测试检查。

[Memory Lifecycle](../docs/contracts/MEMORY-LIFECYCLE.md)和 [Portable Registries](../docs/contracts/PORTABLE-REGISTRIES.md)中的新增格式具有规范性字段定义，其机器 Schema／adapter 校验仍待实现；不得将旧四个 Schema 的成功当作这些契约通过。

所有示例和测试使用合成数据，禁止复制私人资料。
