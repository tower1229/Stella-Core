# Tests

单元／集成测试覆盖当前 CangHai、Host、durability、recovery、evaluation 和 candidate 接口。测试断言必须符合[设计基线](../docs/10-DESIGN-BASELINE.md)、[Alpha 出口](../docs/05-ALPHA-PLAN.md)及适用的 Memory Lifecycle M 项。

重点是：语义路由、适当澄清、原始证据、预测不变、真实行动、学习复用、故障与幂等协调、合法空集合恢复和来源修改传播。

Framework IR 测试验证来源 pin、编译元数据及精确激活快照；不要求 LLM 重新编译产生相同字节。公开 fixtures 和日志不得包含私人资料。

praxis-episode-v2-contract.test.ts 检查新目标格式；已有 v1 runtime 测试不表示 v2 写入、迁移和 Exact Host 已实现。新增行为必须同时补充真实接口层的成功与故障测试。
