# Focused 打包纠正消费者（2026-10-29，限定离线独审通过）

固定生产源码提交：`5fe9a9f5420264cd05e3f70f9f9a671d018040f5`。这是单独的 **focused consumer offline** 验证，不运行或修改全量acceptance runner，不绕过旧26失败，也不是实际Host/模型或consumer正式全量通过。当前任务仍以根 [PROJECT-STATE.yaml](../../../PROJECT-STATE.yaml) 为唯一入口；结果及原始hash见[机器摘要](verification-summary.json)。

## 真正被消费的产物

临时本地clone只checkout固定提交，使用既有依赖构建，标准build identity为该SHA/sourceClean=true；npm pack offline/ignore-scripts产出510文件。tgz SHA-256为 `345c5ae5539a6d147d4605b673bb8371ee2ccc84abb36ebaf742661ede40dbb1`，含正式 `dist/src/plugin.js` 和新增 `dist/src/canghai/authorized-exact-readback.js`。

consumer从空目录开始，安全解包到node_modules；全部510文件与pack清单来源字节hash比对。**未执行fresh npm安装**：只复制包声明的8个既有运行依赖闭包，逐文件摘要一致、版本逐项匹配固定锁，显式使用工作区外既有官方10.8 SDK peer。发现工作区yaml实际2.9.0与固定锁2.9.1不符，明确拒绝后从既有SDK选用精确2.9.1；未改锁、未下载或安装新依赖。原差异及失败保留，不能把复制依赖写成fresh cache/npm ci通过。

消费者首先按包名导入实际main，再调用default.register(fake Host api)，没有直接绕过入口注册checkpoint函数。原有合成fixture帮助代码单独转成验证脚本，所有生产import改接已安装包；它们不提供生产实现，未使用.test-dist或工作树src。模块解析审计仅允许consumer及显式公共SDK路径，证明本次主进程没有工作树/构建目录模块回退；完整相对路径清单原hash保存，未复制大日志。

## 正式脚本结果：7/7，包含原5项

1. 真实主入口、公共SDK peer 10.8和510包文件通过；读取内核实际被加载。
2. 实际包注册的空参数纠正tool在合成原话归档后，只由原writer提交一次；receipt指向的revision与重新打开reader一致，LearningChange目标版本及实际返回对象版本一致。同请求新permit重试不重复纠正推断或业务提交。operationId、合成revision及目标版本见机器摘要。
3. 缺来源descriptor与入场grant文件随后改变两例均fail closed；受保护payload读取0、正文返回0、业务提交0。callback仅为固定google/gemini-3.8-flash/low结构响应，不调用真实模型。
4. 正式新增失败链：纠正已提交但回读因 `source_topic_unresolved` 失败，保留 `local_committed` 回执。随后缺permit拒绝且payload读取0；改变入场grant后重试返回 `personal_context_access_changed`，documents为空、payload读取0、Git HEAD和纠正推断次数不变。恢复原grant后只读相同receipt，精确目标版本一致，不再次推断或提交。
5. 正式新增模块审计负例：consumer内ESM和CJS symlink指向consumer外合成模块，均被实际module-audit在执行前拒绝。各在独立子进程运行；主消费者仍是零越界解析、133个Core生产模块实际来自tgz。

初次冻结脚本的5项确实通过，但只覆盖成功回读后的重试，不能证明提交后回读失败的恢复。独审指出P2后，在其临时探针中原5项加2项为7/7；本次已将这两个探针纳入仓库正式probe并重新构建、打包、运行，作者7/7。之后独审直接重跑仓库正式脚本，另一次7/7，P2关闭；两轮是相同7个用例，不能相加为14个独立用例。初次[五项摘要原件](verification-initial-5.json)按字节保留；[当前机器摘要](verification-summary.json)和[独审归档](independent-review.json)分别记录作者/独审的原始hash、冻结六文件、产物、计数及范围。此前原失败日志不改写。

独审通过后仅更新证据及唯一状态索引，两个验证脚本仍与已审查冻结hash完全一致。提交前通过授权通道重新读取远端，确认 `codex/issue23-integrated-regression` 与本地基线均为上述5fe9a9f；该观察不是将要包含这份文档的提交，也不代表运行时部署。

监督器确认child exit0、进程组gone、owned work complete，SDK监督root与整个临时构建/consumer/合成资料/环境运行树均已删除。树外仅留包及证据。SDK active-leases告警仍存在；进程结束后清理不等于SDK drain。没有读主配置/真实资料、启动Gateway、切slot、真实grant/凭据变更或推送。

## 重建与未覆盖

```sh
node scripts/focused-correction-consumer.mjs   --revision 5fe9a9f5420264cd05e3f70f9f9a671d018040f5   --sdk-root EXISTING_OFFICIAL_OPENCLAW_10_8   --out NEW_EXTERNAL_EVIDENCE_DIRECTORY
```

依赖必须来自既有安装且匹配固定锁；缺失即失败，不自动安装或降低门槛。输出目录必须新建；原失败不会覆盖。前三处初始验证脚本错误（Git忽略symlink、npm空配置路径、系统Python tar API）和一次依赖错配分别保存原RESULT hash；均在consumer组启动前停止，不计为产品测试通过。原5项、本次正式7项和独审临时7项分别绑定自己的原始hash。

依赖口径以固定提交和实际manifest为准：固定 `5fe9a9f` 的package-lock SHA-256为 `ea0f176ae49d58925336d1bcd831d5ba41b1148d3b8610399e1bc4662c227cc3`，锁定yaml **2.9.1**；工作区实际 **2.9.0** 被拒，复制的是显式官方SDK既有 **2.9.1**，donor/copy文件树摘要 `e5bed832a42182d072da55bbe6bc0f5482ab08650e2e00c117d7ecac5bf92b09`。早期口头描述曾把版本方向说反；未用改锁或重新安装迎合该描述。这只证明既有副本与版本匹配，不证明registry原tgz authenticity或fresh npm install。

正式consumer完整验收、真实Host/model、SDK迁移/恢复、profile/Chrome、语义效果及full_memory仍未验收。全量CI旧26失败由独立任务维护，本验证不改成功逻辑。本阶段只普通提交/推送已审查验证与证据，不修改生产实现或部署。独立可继续的工作包括按实际提交SHA观察CI，以及另行限定固定包消费者下一请求/磁盘重开freshness的合成小包；这些工作不以D063整体待审或真实模型验收为全局前置，本轮不实施下一包。
