# Core任务控制台账

state.json是任务规划/执行状态唯一权威；PROJECT-STATE.yaml保存技术事实与证据兼容入口，需求/架构仍依设计基线和ADR。当前为待独审本地管理迁移候选，未提交推送，不批准业务实施。

## 恢复
先严格读取state的repo/schemaVersion/revision和writer，再读目标/非目标、active和传递依赖。paused/blocked/canceled先看恢复条件，nextAction不是解暂停指令；completed只读验收摘要，冲突再追溯。
核实际分支/HEAD/dirty与证据版本、写者交接；本地未提交台账可能领先Git，远端未知不以缓存证明同步。再读技术索引/基线/相关ADR，候选不是决定，研究不是Host通过。
当前关键链CORE-RES-001→CORE-DEC-001→CORE-VAL-001；CORE-LEGACY-001旁线paused，不是研究前置。经理下一包是职责/writer/受保护路径收敛，本迁移不执行下一包。

## 最小数据规则
UTF-8严格JSON、2空格缩进、末尾换行；拒绝重复键、NaN/Infinity、未知schema/status或错误类型。ID不随标题/排序改变；引用存在、依赖无环，criticalPath按依赖排序。
任务有输入/交付/验收、owner/session、证据、状态和resume。未分派session为null；completed须逐项证据及acceptanceReview，ready/running硬依赖必须completed；paused/blocked须原因和可查恢复条件。依赖完成或新会话不解除暂停。
证据ref用仓库相对路径加hash/commit/版本；预定产出标planned:，不当作存在。私有原话/会话链接/日志/秘密不入台账。报告不直接提升权威状态。
同仓只有一个协调写者；跨仓仅引用repo/taskId与固定观察，不复制Bili台账。初期一个CORE workstream及4任务，不把每次小修补建长任务。

## 更新和交接
先读取原字节/revision，外部记录baseRevision和SHA-256；首次创建确认不存在，本次候选0不是旧权威，首次仓库revision为1。
确认写者与工作副本，校验最小delta；替换前重读revision+hash，变化即拒绝，交协调者语义合并。写同目录临时文件、刷新、原子替换并回读。rename只防半写，不提供多写者CAS或恶意并发FS保护。
handoff须旧写者停止，新写者核基线后显式更新session；离线旧写者不能自续写。
本地/commit/push/CI分别观察，未知不填通过；自身提交SHA由Git外部核验，避免循环。不全量暂存或因迁移提交旧候选。

来源/切换见reports/migration-20261030.md；数据校验见reports/migration-validation-20261030.json；研究交接见reports/CORE-RES-001/handoff-20261030.md。没有数据库、服务、events日志、后台调度器或新依赖。
