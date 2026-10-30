# Core架构重对齐：经理评审后的研究交接

日期：2026-10-30。经理工程研究取舍已明确，仓库落库候选待独审；不是用户整体批准、已实现、Host/模型或full_memory通过。当前执行状态只在[任务台账](../../../.task-control/state.json)，本文和工作包表不调度、不解除暂停。

## 文档与层次
- [架构草案](proposal-reviewed-draft.md)：保留memory-core、原生context和Agent Loop，Core作为普通插件；按原件、USER、MEMORY、带来源工作说明分权。首片只发布一份工作说明，不同时写USER/MEMORY。
- [工作包定义](work-packages-reviewed-draft.md)：ARCH-01～06的完整目标/门槛，不是每包已执行。ARCH-02/03/04本次仅有限研究交接完成，实际运行门槛仍待证。
- [单资产契约](author-intent-contract-draft.md)：作者原意、证据、已定/候选/未决、当前解释、修订及幂等发布；逻辑信息而非已实现schema/API。
- [独立文档评审](review.md)：归属冲突、工具结果之后的流向、实际安装小契约三项窄修订。原始临时稿丢失的溯源限制保留，不改写为原件复验。
- [安装接缝观察](installed-interface-evidence.md)：已有10.8安装及公开字段/生产者差异的观察；默认Gemini/插件字段的后续查询成功不证明实际harness。没有真实回调。
- [工具结果流向](tool-result-flow-evidence.md)：固定官方源码静态研究。原生session index投影只直接采user/assistant文本，不直接采toolResult；工具原文仍可能留完整历史，assistant转述可继续传播。逐结果禁学及全历史取代效果未证。

## 本期研究取舍
增量接入与语义权威分开：原生USER承载其获准偏好/指令，原生MEMORY承载普通事实/决定；Core只发布确需来源/范围/反证/取代关系的理解工作说明，沧海保有可迁移资产。各类不能形成第二份同题当前权威，交界冲突显式呈现；这不是用另一份Core画像替代USER。
普通supplement仅用于固定公开/已证明全体消费者可用的域，不能直接供给动态受保护沧海内容。受控工具入口仍须来源/处理/留存/学习等资格，不把owner/session或工具活性当资料许可。
下一工作包是普通插件的纯合成薄片定义与实现安排；先核有效harness/可信作者来源和必要流向，缺源只能候选，缺运行证据不能发布为已确认作者理解。旧15文件/runner保持paused；26旧失败和152探针不作本期前置，也不改绿。

## 三层边界
静态契约/文档评审、既有安装观察、后续实际技术运行、真实模型/作者效果分别记录。普通插件可注册、文件回读或JSON合规均不等于持续理解。未证明局部隔离时限纯合成或明确允许处理域，不更改主配置、资料权限或真实会话来凑通过。

## 来源与历史
资料包Library libfile_7f44ae04a1748191b56ffc4842de41c2，version 1，75592字节；外包SHA-256 8697c9e05581602c48740358460e177023b0f1d9ba5e79992415d2eef15b8d1b，13个SHA256SUMS成员匹配。本仓仅导入6份Core文件，原/适配hash见[source-manifest.json](source-manifest.json)。
前期私有目标原文、缺失线程恢复稿及extension-options原稿未在此复制，必要前期限制见[原研究交接](../../../.task-control/reports/CORE-RES-001/handoff-20261030.md)。本机路径和无关Bili文档未导入。
D063保留原待审身份；此处是新的经理研究取舍和后续工作包候选，不以旧受控纠正链或native slot作为架构前置。
