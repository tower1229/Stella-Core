# 纠正 writer 的本地 checkpoint 分支

2026-10-24。按 D-058/D-059 收敛 #24 的一个前置工程项：已有 writing Ongoing Work
纠正计划复用 Core checkpoint 发布并在重启后读取。#24 仍依赖 #20/#23 的对应能力；
#20 的旧同步路径验收不证明新 authority 已接通。本页不宣称实际 Host Agent 接续完成。

## 入口与固定版本

`createCheckpointPluginRuntime(...).correctLocal(input)` 是可信 Core 调用入口，不注册新的
Gateway 写 RPC。可选 Agent 适配器仅在 agentCorrection=tool 时注册独立写工具；默认关闭。配置仍显式 `core_checkpoint`/
`local_write`。调用方传入既有认证 owner Evidence、ProcessingAuthority、准确 owner/model/
purpose、请求标识和语义准备开始前捕获的 RecoveryReadBinding；不会由模型提供身份或 expected。

若前一步通过既有 `archiveCorrectionInput` 归档输入，则使用归档返回的 B/tokenB，再准备
本次纠正，不能继续使用归档前 A。新准备读取固定 B 的 committed catalog 并核对其 hash
及 working reader；仅 store tuple 当前不够。每次结构化语义调用执行既有输入当前性回调，
额外 owner 原文和候选资料仍受来源/learn 权限及版本检查。没有关键词纠正分类器或新权限框架。

`prepareCorrection` 继续产生原 works/understandings、LearningChange、业务 receipt、catalog
及精确文件计划；本地分支只在既有 transaction v2 journal 添加原 binding/revision/token。
复用 `applyMemoryTransaction` 的 Git 父版本、精确变更、CAS、fence 和发布检查。CAS 返回的
C/tokenC 是新 authority，发布后不拿 B 的旧 closure 检查 C，也不读取 HEAD 来升级 expected。

## 持久化与恢复

本地结果明确为 `local_committed`，不调用远端 sync/push，不宣称服务器丢失后仍可恢复。
原 `learn`/managed durable 分支保留 `syncCritical` 与原同步成功要求；v2 journal 不能回退
到 legacy writer。旧 v1 操作也不能由本地入口补猜 checkpoint tuple 后接管。

同一操作重试先读取已录 journal，核对请求 hash/Evidence、业务对象和原 expected，复用原
语义批准；不再调用模型、提交或推进 token。CAS 已发布后须用新 runtime 的当前 recovery
绑定进入，重放事务仍采用原 journal tuple；不是从观测值生成新 expected。不同请求不能
借用操作 ID。发布失败保留 fence，不将已写 Git/CAS 误报成完成；重新打开 runtime 后用
原操作恢复，只有重新验证通过才解除 fence。恢复不会重发答复。

`CatalogReader.load` 允许建立元数据快照；实际 `read`/`assertCurrent`/Personal Views 消费
才执行 fence。测试不能要求纯 load 拒绝，也不能把能 load 解释为可消费未发布记忆。

## 验收层级

新增合成测试使用既有 personal-memory fixture、结构化假模型响应、本地真 Git、无 remote
和仓库外 authority。只闭合一个 writing work：保留前提、未采纳候选、拒绝解释及未决问题，
写新 work/Change 后读取历史旧 work，重启后的 Core `preparePersonalViews` 读到新状态。
另覆盖最新操作幂等/异请求拒绝、旧 expected/foreign scope/learn 权限/取消、Git D 未被
checkpoint A 选定时0模型拒绝，以及发布故障后的原 journal 恢复。既有合法空集合和缺失
声明对象的规则继续由 Personal Views 回归覆盖。

这不是实际 Host 自动触发或真实模型质量证明。后续已增加 `stella_memory_data` 的只读
work 动作，并以安装包、原版 Host 和 loopback 验证新会话实际消费已纠正 Work，见
[只读供给验收](CHECKPOINT-WORK-SUPPLY.md)。这没有接通聊天自动纠正触发。`checkpoint_semantic_writers_not_migrated` 及 full_memory 标志保持原状，
不能凭这个可信内部 API 将整体能力标绿。未改真实 main、来源 grant、沧海生产 dev 或 Host。

## 与沧海协同

Source/Evidence、OngoingWork v1、LearningChange v1、catalog 及现有策略格式不变；生产者
候选不因新增消费侧 writer 自动变更或获得许可。Core 只向已选的独占消费源写入，不直接
改沧海生产 dev。后续导入仍走显式 producerBase→candidate 与原 CAS/冲突规则，不新增
后台跟随、通用 merge 或生产迁移。新 writer 的本地结果、生产者固定源、checkpoint 与
Host 实际消费分别记录，遵守 CORE-CANGHAI-COORDINATION.md。


## 可选 Agent 接线增量（2026-10-24）

正常 Host 的公开 reply_dispatch 先走现有输入归档，内部传递这一次操作真实返回的
Evidence/Source refs、接收时间、run/hash 与 recovery B。新增独立 `stella_memory_correct {}`
默认关闭，需明确配置和 Host 工具许可；模型不能构造这份归档收据。Source 的 learn 阶段
复用原 derive/用途/受众约束，没有新增或猜造一个独立许可位。

工具重建 genuine SourceAccess 和固定模型的公开 runtime.llm.complete 适配，避免把旧
B 的 reader/authority 闭包带到 C 的发布检查。一次请求 Promise 覆盖 writer 与重绑；重复
调用只复用该结果。C 必须来自本次 CAS，原 data permit/handle/work cache 不可借用 C；
读工具仍只读。公开回执不暴露 repositoryRoot 或内部 journal 路径。

helper13项、旧供给74项以及新增注册供给5项已通过。新注册测试包含并发两次纠正及完成后
重复，实测仅一次纠正提交；第一次并发重复锁失败保留于 supply-a4，最小修复保留共享操作
内部的完整 CAS/reader 检查，外层重复等待者只检查身份和正常取消，不修改锁框架。

以上为合成 Host hooks 与真实本地 Git/CAS；安装包的真实原版 Host 三轮验证另行记录，
未取得结果前不称其通过。没有修改 main、真实 grant、沧海 dev、Host 或调用真实模型。
