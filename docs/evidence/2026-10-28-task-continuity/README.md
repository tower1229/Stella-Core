# Core任务连续性：2026-10-28证据快照

本目录是不可作为当前任务授权的历史证据快照；唯一当前状态入口是[根PROJECT-STATE.yaml](../../../PROJECT-STATE.yaml)。需求和决策仍由[设计基线](../../10-DESIGN-BASELINE.md)、[DECISIONS](../../DECISIONS.md)及[Core/沧海协调约定](../../CORE-CANGHAI-COORDINATION.md)决定。后续里程碑另列版本，不修改本批原始身份。

- [技术评估摘要](technical-assessment.json)：固定10.8公共注册/slot/caller限制；authority对象引用桥只是未采用的探索提案。D063仍待用户审阅，不是功能实施或切slot授权。
- [验证摘要](verification-summary.json)：最终监督接线、官方normalizer/executor组合、R6/R8显式契约替代、D063独审，以及精确提交`deb8dc359a5cb5942c969684a60d0182b816aa5c`的两个CI结果。
- [来源与原始hash](provenance.json)：原临时结论的原始SHA256、固定版本及CI artifact摘要。摘要是经白名单整理的新文件，不冒充原日志字节。必要事实已在项目内，不依赖临时目录存活。
- [旧状态原样快照](historical-project-state-2026-10-20.yaml)：保留原8.2策略、旧模型/验收及原提交身份；不作为10.8或新模型通过证据。
- [归档文件hash清单](MANIFEST.json)：验证以上文件字节，清单不包含自身以避免自引用。

最新两CI各为1458项、1432通过、26旧失败、0取消/跳过，结论仍为failed。consumer均为null，prepare的probes为空；真实模型、私人主实例、完整评估与full_memory标志未通过。R6/R8旧断言在私有导入前失败的事实保留；其余7codec和12SQL桥等旧失败没有被隐藏或视为已迁移。

公开run与artifact链接、原zip/receipt/test-output的SHA256均在验证/来源摘要中；不复制整包日志。历史C5/C6的永久版本/计数/hash见[集成§9.7](../../04-OPENCLAW-INTEGRATION.md#97-c5c6-已验收工程事实2026-10-28)。Bili候选仍未联合确认；其工作区冻结hash不等于已提交依赖，详见来源摘要。

本批不运行Host/模型，不改实现、主配置、slot、grant、凭据、沧海数据或生产消费指针，不据此报告SDK drain、正式入口或产品验收通过。
