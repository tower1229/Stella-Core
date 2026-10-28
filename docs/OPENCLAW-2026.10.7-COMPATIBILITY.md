# OpenClaw 2026.10.7 的最小兼容范围

2026-10-27。本次只承接现有 `core_checkpoint + fresh_tools` 有限实验路径，不启动完整记忆新架构，不增加 requester、资料授权或模型许可。

## 公共接口与身份

构建 SDK、peer 和宿主最低版本更新到 2026.10.7。`resolveCommandAuthorization` 从公开 `command-auth-native` 导入，并调用返回的 `assertOwnerCurrent`。新版原生配置使用 `agents.entries`。

10.7 浏览器调用的 `ctx.SenderId` 可以为空，而宿主绑定的当前 profile capability 使授权解析返回 profile sender。Core 必须进入 profile 绑定分支，要求当前 capability、operator/direct 来源 stamp 与显式 profile 配置一致，仍生成 `openclaw-profile:<id>`；缺失或撤销 capability 不能由 admin scope 和旧 stamp 补足。工具 requester 继续使用实际 `ctx.SenderId`，不制造 transport sender。

现有显式设备模式保留原 device、operator/admin、direct、来源和无 profile 冲突检查。它表示设备持有人，不替代自然人 profile。真实资料处理 grant、checkpoint CAS、首次来源资格、请求内合法缓存及下一请求 freshness 不变。

## 未迁移路径

旧 `legacy_config` coordinator、guarded 模型消费及 native SQLite 桥接绑定 8.2 的 Host 行为或内部载荷。10.7 对 legacy 注册明确返回 `legacy_host_version_unsupported`，不以默认路径 fallback。旧 helper 的 persisted `running` 类型保留为历史契约；不据此宣称新版 Host 仍持久化该状态。

历史测试与 receipts 保留原 Host 身份。一次旧测试集在10.7上运行的结果为1152通过、37失败，包含原先8.2内部文件/codec依赖和未提交的旧私有探针；这不是最终补丁的全绿证明。临时测试目录的 extensionless CommonJS 脚本问题已单独复核通过，不改写原失败记录。

## 本轮可观察证据

- 真实安装为 OpenClaw `2026.10.7 (157d8c2)`；未降级或恢复旧数据库。
- 新 SDK 类型检查、9项 schema 检查，以及执行安装中 Host caller helper 的13项身份正负例通过。私有 helper 仅用于固定版本合成 fixture，生产代码不导入该内部文件。
- 最终 checkpoint 定向合成测试59项通过，覆盖权限/取消拒绝、归档 custody、一次纠正提交、receipt/readback、重启重放与 CAS。模型端口使用合成桩，不代表真实模型效果。
- 兼容包集成到既有 `plugins.load.paths` 选定目录，旧包单独保留。构建基于 Core `57c84c9` 加本轮未提交 diff，`sourceClean:false`，不宣称正式发布或 clean-source 验收。
- Gateway 的45秒启动等待曾超时，随后状态核查确认运行、监听和10.7 RPC连通；不能将最初超时记录改成成功。
- 官方只读 lint：37项执行、31项跳过、无 finding。真实 `stella.identity` 与 `stella.checkpoint status` 可调用；调用方提供 profile 参数被 `INVALID_REQUEST` 拒绝。
- status 仍为 `experimental_owner_chat`、`full_memory:false`，bootstrap、完整语义 writers 与完整 transcript 缺口未取消。现有 `ownerCorrectionTool:false` 保持不变。

未运行真实付费模型和 Chrome 主人问答闭环。真实服务注册、合成读写/撤销、模型语义效果和 full_memory 是不同证据层，不能相互替代。完整运行记录与本轮合成结果保存在 `/tmp/stella-arch-core`。

37项旧全套失败具体分为16项8.2内部契约/载荷测试、12项未迁移 native reader、8项缺失旧 `io.runtime` 导致断言未执行，以及1项临时 ESM shim 问题。最后一项修正测试目录模块类型后单项重跑通过；其余失败保留，不伪装为新版验收通过。

## 2026-10-28 提交前复测增量

最终源码类型检查、9项schema、build及标准测试编译通过；8个相关测试文件共211项通过，包含10.7原生profile夹具、v3/v4会话头、C2精确版本/独立Evidence授权、C3提交后回读失败不重写、C4下一请求与磁盘重建。均为合成模块测试，不新增真实Host或模型验收。3个活跃profile场景原先只造stamp而缺原生capability，现复用固定Host的测试helper；伪造stamp和有效但未选中的profile仍分别拒绝，没有放宽生产授权。

较广初轮执行124个已跟踪/本次候选测试文件，共1254项，1210通过、44失败；未纳入不属本次提交的未跟踪 `recovery-pointer-barriers` 旧测试。44项中3个profile夹具失败由上述最终复测关闭，7个query用例因沙箱禁止loopback监听而失败，解除该运行限制后通过；另有16项旧Host契约、12项旧native reader及6项 `delivery_contract_version_mismatch` 仍未解决。后6项暴露当前10.7包声明与旧完整交付契约不匹配，是完整交付迁移缺口，不归入原37项或冒称有限路径已回归。不能将分类与定向重跑折算成“最终全套全绿”。

当前项目使用链接到既有10.7安装的依赖，未做fresh `npm ci`、最终包安装消费或152项完整Host矩阵；相应CI仍需独立判断。既有C5/C6限定工程证据见[集成§9.7](04-OPENCLAW-INTEGRATION.md#97-c5c6-已验收工程事实2026-10-28)，真实模型、Chrome/profile与full_memory未由本次复测验收。

## 备份与后续设计边界

私有备份保留在本机 `$HOME/.openclaw-upgrade-backups/20261027-v2026.10.7`，包含旧8.2安装包、经官方 backup verify 的状态归档及配置/服务记录；目录0700、敏感文件0600。当前 Host state schema 为20、main agent schema为25，备份中旧数据库为15/19；未恢复旧数据库，不能据备份存在声称已验证降级。已集成插件的前一包也单独保留在本地兼容集成产物目录中。用户最新要求保留10.7，不执行回滚。

后续方向见 [D-061](DECISIONS.md#d-061--host-first-memory-infrastructure-with-behavior-gates-before-replacement)、[架构对照](01-ARCHITECTURE.md#8-2026-10-27-host-first-memory评估基线)及[分阶段计划](04-OPENCLAW-INTEGRATION.md#9-2026107-分阶段实施与验收计划)。这些计划不扩大本页已验证范围；当前SDK的实验性/版本敏感接缝应继续固定release并逐消费者验证。
