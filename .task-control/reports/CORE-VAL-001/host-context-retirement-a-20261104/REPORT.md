本批从 fb552e134533e133d818504f84631ed7b3635129 退役旧 Host context/provider 及 adapter 链：21 份源码、11 套专用测试、1 个通过模板生成导入的旧 launcher。42 个代码／文档路径的精确状态见 CODE-MANIFEST.json，所有33份删除对象可从 REMOVALS.json 所指 Git 对象恢复。

七套混合测试保留98个具名顶层用例，其中89个测试体与父提交字节一致，9个调整或改名；另有现存动态用例。移除8个具名和2个动态的旧 Host 投影／outcome 编排用例，不把退役记为通过。原文/BOM、角色、版本/定位、分段许可、首次payload前授权、派生依赖、同步及事务断言保留。旧 outcome 专用恢复／签名上下文行为不再声称由通用事务测试等价覆盖。

七套混合测试加现行 memory-transaction / journal 共118/118通过，0失败／取消／跳过（本机SDK10.9）。首次编译发现一个已移除tool变量残留，改为真实Evidence resolver调用后全量测试编译通过，失败输出hash保留。没有启动Host、模型或网络服务。

当前普通插件126个编译源码文件与父版本构建完全相同；145成员tarball已解包核验，现行12套CI清单和监督器未改。本批不重复运行其143项：父提交fb552e13的独立CI41765893593已在锁定SDK10.8上通过143/143。该CI不代表本候选已独审或已在Host加载。

原未跟踪 recovery-pointer-barriers 测试已按原字节保存在被ignore的 .artifacts 历史目录，hash／恢复路径见 HISTORICAL-ARCHIVE.json；不上传原始文件、不静默排除或不可恢复删除。其旧内部Host路径仅保留历史身份，不保证归档文件独立可运行。

下一组是B批checkpoint及工作区测试owner硬编码，之后是C批剩余Praxis。仍保留当前CangHai数据/事务契约与全仓新分支转换、同步目标；本批未改CangHai。旧UNKNOWN加载未重发，main、selfie、真实资料、grant与付费模型均未触碰。当前候选仅作者验证，待独审，不推送。
