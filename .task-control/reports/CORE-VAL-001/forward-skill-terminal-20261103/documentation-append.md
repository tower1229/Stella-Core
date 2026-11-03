

## 2026-11-03 正向指引白名单修正与终态候选

在上述 generation15 加载之后，按已授常规开发范围仅向 `agents.entries.main.skills` 追加已独审的 `stella-understand-sources`（69→70）。官方配置热更新成功，不重启；真实技能状态 eligible=true、blockedByAgentFilter=false。selfie、其他配置、原97来源/362描述符及资料/身份许可均未改。没有模型或正文读取；技能可选用仍不等于模型已经消费。

正常终态清理另有未加载候选：将受会话内容权限限制的 `agent_end` 换成 `api.agent.events.registerAgentEventSubscription`，只消费生命周期事件的选定元数据，释放同run/session缓存及待执行关联。定向89/89通过，待独审和实际Host验证；不打开conversation-access。已加载main仍是原产物，其旧hook警告没有被本地代码修改自动消除。完整边界、官方源码身份与回滚证据见[本包报告](../.task-control/reports/CORE-VAL-001/forward-skill-terminal-20261103/REPORT.md)。
