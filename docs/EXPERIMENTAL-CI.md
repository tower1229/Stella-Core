# Experimental owner chat 的 CI 边界

实验模式和完整能力评估是两个独立 workflow，均在 push / pull request 运行。
本次没有更改分支保护、仓库权限或发布规则。

| 检查 | 必须证明 | 通过不代表 |
| --- | --- | --- |
| **Experimental owner chat / Installed experimental owner chat (synthetic)** | 全量类型/schema/单元检查；一个构建打成 tgz 后实际安装；原版 OpenClaw 2026.8.2 直接加载该安装入口；首次 checkpoint/六文件物化；同 owner 同 session 三次用户请求、九份完整 loopback 请求、每次自动归档一次、当前 B 供给；v3 分页/策略判断/read/回答及用途/受众拒绝 | 真实模型语义质量、真实网页 profile、私人 main、完整 transcript/learning/correction/outcome、full_memory、#23 全完成 |
| **Full capability assessment / verify** | 保留原152项完整能力探针、同包汇总及原失败标准 | 实验模式的发布前置要求；通过实验检查不会转换本评估的失败 |

完整能力评估不是 `continue-on-error`，没有删除或跳过四个失败 shard。
旧 `verification_code_identity_unavailable` 仍会使相应完整能力探针失败；原聚合器仍要求全部
152项通过才返回 passed。当前纯插件路线没有旧覆层的强代码身份接口，未被实验结果补证。
两个 workflow 的名称和 GitHub Summary 都注明范围；不能把一个绿色检查写成整个项目全通过。

实验命令为 `npm run verify:experimental`，需干净且固定的源码 checkout。脚本不纳入开发目录的
既有未提交文件，使用项目 `.artifacts/experimental-owner-chat/<attempt>/` 保存 tgz、安装锁、
源码/包摘要、进程退出状态、场景报告和全部合成 wire。包字节/安装文件在验收前后比较，
探针报告缺失、失败、未退出、不同包/Host、wrapper 或不完整轮次均拒绝。

实际 Host 来自本次 consumer 的安装目录；GatewayClient 使用其公开 SDK export。Host 身份
证据限于公开 package/launcher、版本、安装锁 integrity，**不宣称完整 Host 树认证**。
不依赖旧 opaque binding 或 Host 补丁，不递归 hash Host/node_modules。单元测试中的依赖注入
仍明确为合成测试，不充当安装包最终消费证据。

所有 Host/provider 环境使用白名单和独立 HOME/state/cache/TMP，丢弃代理与真实 provider 凭据。
只配置 loopback fake provider，fallbacks 为空；合成 grant 绑定实际公开 CLI 身份，而非冒充
Telegram 或真实网页用户。Mac 保留本地 sandbox；无 Mac sandbox 的执行仅允许隔离 Linux
GitHub Actions runner。fake policy verdict 只验证既有策略机制，不证明真实语义判断质量。
没有修改 main、私人来源、真实 profile/grant、生产消费指针，也不修改 OpenClaw。

依 D-058，运行中撤权、输出拦截不重回必过门槛；下一用户请求新版本、必要身份/首次授权、
正常取消、文件所有权和 CAS 仍由完整本地测试与针对 Host 场景覆盖。当前未取消的完整能力
缺口见 [肃清收尾](suqing-closeout-2026-10-23.md)；沧海联调遵守
[双项目协调约定](CORE-CANGHAI-COORDINATION.md)。


显式快照导入现已纳入同包必需检查：保持正常 v3 允许/拒绝探针，另在同 owner 同 session
下一用户请求前，经 operator-admin 导入一个已选定的合成 producerBase→candidate。初始
合成 grant 明确预审两个精确 Source 版本；导入本身不增加或重绑定许可。新增探针保留
44 份完整请求，检查工具读取采用新内容、消费 commit 与 producer SHA 分离、旧 expected
冲突拒绝且 authority 不变。候选 Git 对象本地 pin 是准备态；journal/CAS 与实际模型消费
分别验收。历史 full capability 工作流及 full_memory 标志不因此转绿。

操作字段、失败原子性与准备态边界见 [显式数据快照导入](EXPLICIT-SNAPSHOT-IMPORT.md)。
