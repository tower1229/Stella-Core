# Core经理设计取舍与有限研究交接

记录时间：2026-10-30T04:49:38Z；本地基线：c86109b42d0407cd2f27f1bc7dbf22cdac555a0b。只交接文档/有限研究，不实施、测试、Host或模型，不批准生产/权限。本记录根据协调者明确交接保存研究状态；不是本执行者独立复验所有官方接口。

## 接受的工程研究取舍
保留原生memory-core/context/Agent Loop，以普通插件补来源与认知差异；不替换全部slot。USER、MEMORY、Core工作说明按性质分权，沧海保有可迁移资产；首片只修订一份作者意图工作说明，不同时改USER/MEMORY。不把旧runner/15文件/26失败/152 gate列为前置。
依据：docs/design/2026-10-30-core-realignment/proposal-reviewed-draft.md和review.md。状态是经理工程取舍明确，不是用户整体批准或运行通过；D063历史待审不改写。

## 有限研究验收
- CORE-DEC-001：职责/各资产writer、受保护路径及合成薄片/效果验证边界已有可审查定义，满足其设计取舍交付；不宣称这些路径已经运行。
- CORE-ARCH02-RESEARCH：既有安装事实/公开字段/可信作者生产者差异记录齐备，实际harness和回调未证；后续查询默认模型/插件成功不外推harness。
- CORE-ARCH03-RESEARCH：一份工具结果的有限流向表、当轮可读不可学习/旧transcript两个负例及控制粒度已交付；逐结果硬隔离、所有harness效果未证。
- CORE-ARCH04-RESEARCH：单资产逻辑信息、两种权威交界、纠正/重试/旧候选/恢复预期已交付；不等于schema实现、CAS代码或ARCH-05通过。
- 各有限任务的completed仅指上述交接范围，不是原工作包全部运行门槛。CORE-VAL-001只作为新合成薄片待分派，当前包不执行它。

## 证据
资料包version1的75592字节及外SHA、13个校验成员已核，只导入6份Core文件。source-manifest.json保留原成员与仓库适配副本hash。
当前导入基线是c86109b，不将源稿1c观察或安装报告日期当成本次部署事实。未抄入本机路径/私人原话/无关Bili文件；旧15文件、业务YAML与历史unknown不处理。
本地候选、Git提交、远端push及CI仍分别观察；本次未提交推送，文档格式/链接核对不算业务测试。

## 已有基线CI观察（协调者交接，非本包运行）
基线c86109b42d0407cd2f27f1bc7dbf22cdac555a0b的[Full run41004091225](https://github.com/tower1229/Stella-Core/actions/runs/41004091225)及[Experimental run41004091220](https://github.com/tower1229/Stella-Core/actions/runs/41004091220)均终态failure；各1709 tests / 1683 pass / 26旧fail / 0取消 / 0跳过。协调者已核26个身份及完整规范化失败块与1c0411a6全同，SDK计数81/34/70（其中SDK66）持平，无新增失败。这不是绿CI、SDK drain、正式152 gates或当前文档候选通过；本执行者未重新下载日志或运行测试。
