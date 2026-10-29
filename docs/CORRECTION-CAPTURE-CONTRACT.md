# 纠正双请求捕获：离线关联契约

基线 `4fa4cb0e00d19fb00376868ec14f68a7347d0396`。本片只新增
`scripts/lib/correction-capture-contract.mjs`、合成测试及本文；当前状态仍由
[PROJECT-STATE.yaml](../PROJECT-STATE.yaml)维护，不启动Host或创建身份。
这是未来真实捕获器可实现的输入契约，不是捕获器或新Host通过入口。

## 安装身份只有一个来源

调用 `validateCorrectionCaptureFixture(captureJson, identityJson, artifactFunctions)`。
`identityJson`必须由捕获报告之外独立运行的
[`verifyReusedConsumerIdentity`](../scripts/lib/reused-consumer-identity.mjs)输出序列化得到。
验证器复核其格式、安装manifest摘要、consumerLock=null及固定false标记，再将捕获绑定到
同一个`installationManifestSha256`。没有新增第二份版本字段或consumer安装锁；
源码lock不能替代安装manifest。第一包的独立预期来源及有限快照边界继续适用，
本函数不认证手造JSON声称的安装来源。

`artifactFunctions`是`checkpointHostObservationTag/canonicalJson/objectVersion`三个纯导出。
未来须从同一已绑定实际包加载，并另行审计解析来源；本离线测试使用现行Core编译源码的导出，
不冒充从假安装模块加载。这不是新的授权桥、对象引用身份机制或可传给工具的permit。
两个JSON输入各限制1MiB，避免getter/toJSON混入捕获投影；不执行安装/CLI、文件写入或模型。

## 各事实的来源分开

| 输入部分 | 来源及不能推导的事实 |
| --- | --- |
| `requests[].ack` | Gateway对应调用的实际runId；controller关联同一连接，不能从session猜run。 |
| `beforeTool` | 公开before_tool_call的event/ctx投影：run/call、agent/session、requester、参数及signal布尔快照。requester缺失即拒绝，不借factory补齐。 |
| `afterTool` | 公开after_tool_call实际result，按同一run/call关联；核对当前Core的content/details一致性。不是模型已消费的证明。 |
| `coreObservations` | 现有Core默认关闭观察接口的原始JSON行；同observer、完整连续sequence及严格字段白名单。 |
| factory/execute | factory只有身份标签、owner布尔和factoryLabel；execute只有实际call标签、signal和factoryLabel。execute的session/owner来源必须标为factory闭包，run来源为hook/call关联，不填factory.runId。 |
| `input/grant/archive/checkpoint/disk` | 明确控制器合成输入及本地文件观察；grant摘要只是文件快照，不是Host授予资料权限。 |
| `sourceAccess` | 固定响应stub实际收到的来源判断载荷中的requestHash；不能从controller当前输入回填来伪造freshness。 |
| `agentEnd/lifecycle` | 公开agent_end的run/success与控制器真实提交、观察到Core退休、开始停服的顺序。不是全Gateway/SDK drain。 |

未来collector必须记录上述实际出口及文件/载荷，不得包装registerTool、重写result或复制旧C5假grant表。
每个来源标签在本片都是待核实的合成声明，JSON检查不能认证回调真的发生；真实来源链需要下一包。
HMAC身份标签只在同observer内比较；公开nonce/run/call标签用实际包导出复算，绝不作为身份或资料授权。

## 限定的两个请求

只支持同一控制器Gateway连接、同一Host session/owner的顺序两请求：

1. 第一请求的空参数纠正tool得到local_committed/update及readback_verified。
   receipt的LearningChange目标、精确对象版本、返回正文和按receipt revision读取的磁盘对象一致；
   一次归档、一次纠正，operationId与变更目标保持绑定。
2. 正常agent_end后，控制器必须先观察同run/observer的Core真实退休行：其scope为
   config-and-host-state-supply-scope，真实grant已移除，grants/activeGrants/preparations/permits为零，
   然后才提交第二请求。agent.wait或常量remaining=0不能替代。取消、非零退出、signal、缺行、
   歧义、跨observer、清理早于退休、换Gateway或提前提交均拒绝；最后才可开始shutdown。
3. 第二请求只用memory action=work；新run、新输入/归档、当前checkpoint及新的来源判断载荷，
   读取与纠正receipt相同对象版本，不新增纠正提交或推断。新归档合法推进revision/token，
   不能要求新checkpoint等于旧receipt；同一许可文件的摘要可以不变。

Core退休行本身没有agent_end/close原因字段。故正常退休的判定还依赖实际collector的agent_end和
停服顺序观察；不能仅靠一条Core行证明没有隐藏的close。当前契约检查此来源/顺序的自洽性，
不将合成声明认证为实际运行。此片也未验证旧permit的真实执行拒绝或动态撤权。

## 输出及尚未接线

只接受新schema与`evidenceKind=offline_capture_contract_fixture`，返回
`evidenceConsistency=validated_capture_contract`及少量关联标签，不返回正文或原始owner/session。
CLI/Host/profile/formal consumer/full_memory/real-model标记始终false。
旧offline v1、consumerLock验证器、8.2门槛、152和历史receipt完全不变；
旧报告换标签为host_capture、新报告自称Host已通过均拒绝。

尚缺真实包/完整SDK与ESM导出来源、真实回调/磁盘/模型消费载荷捕获、CLI/runner、
取消与清理的实际执行证据。未来runner仍须父任务核对同范围授权后才运行：既有10.8安装、
本地固定响应、合成资料、同Gateway/会话至多两主请求；不访问真实资料或主grant，不调用付费模型。
本片不改变架构目标或正式gate，不证明SDK drain或旧EPERM清理。

## 作者验证

原候选作者定向235/235（新73＋既有162，17父组/218叶子）是历史结果；同候选独审235也通过，但额外探针发现下述C1，不能据此提交。原结果与修后结果分开保留，均只涉及合成声明。

正例将第一包实际验证函数在临时合成Git/文件上生成的安装摘要传入新模块；用现有Core观察器生成行，用源码编译的三个纯导出核对标签/对象版本。假安装产品和SDK入口均为会抛错的文件，未被导入；这不认证实际tgz/Host。

首轮234/234日志保持原样。随后仅在模块/测试加入同observer跨请求标签一致性及一个负例，最终235单列；逆向差异记录了变化，但首轮运行前未独立冻结代码hash，不把重建副本当作当时原件。断连时最终测试未创建进程；恢复核对日志不存在和编译用例后才启动一次最终测试。先前已exit0的最终编译/typecheck未重跑，没有Host或已知在途长命令。

| 原件 | SHA-256 |
| --- | --- |
| targeted.tap | `3e8b3211d627d0c466f13e90c69eed6661c6d852332e0e4274a51ac0250a3cd6` |
| final-typecheck.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| final-compile.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| final-targeted.tap | `9bd3c31a668ae2b3310086847c6c6026f38f8163499855cbb381b3522587bc1e` |
| RECOVERY.json | `b4b40b46492f8891f5bae8056b447df092885fd32bceb4ba33a7c7e8e4a430e3` |
| IDENTITY-CONTINUITY-DELTA.diff | `3e50aec7ec201fcf44705983b7db6d82208449b4be14609072d308331c9ba858` |
| CONTINUITY-HISTORY.json | `c45c63887db01bc91108a57c616aa5304e03c45b12cc037ee32c0de71cd6efcc` |

以上为原候选冻结阶段的必要摘要，不复制正文日志。后续C1复验结论见下文；不迁移CLI/152、不启动Host。

## C1：跨请求Core序列与提交屏障的一致性

原独审结论为changes_requested，摘要SHA-256 `049696a58ff3fdf32da9c6e820ec58d7ecfde8d145ea225c872d9218fdfaf909`。原11探针中8个结果符合预期、3个异常接受，均为同一C1/P2；不把探针wrapper执行成功当作3反例通过，也不加到原235。源边界记录SHA-256 `f002589351c6fbd0e64b45212c64ad2db9c07e58dcb61d4b920ffa009131319d`；来源类别仍全部是未经认证的合成声明。

三个反例均保留合法连续序号并更新lifecycle的退休引用：(hook2,execute2,retire1)分别为(5,6,7)、(2,3,8)、(4,7,5)。原检查只保证每个run内部hook→execute→retirement，不能排除第二请求先发生、控制器却声明先等第一请求退休。

修复只增加一行：第二请求hook.sequence必须大于上一请求retirement.sequence。不约束factory相对上一退休的位置；合法对照的memory factory在第一退休前创建仍通过。三个负例与一个正例组成新增5个Node结果（含父组）。修前5项1pass/4fail（3负例及父组），修后5/5；测试源码与编译产物hash红绿一致。

最终作者定向240/240（原235＋新增5，新契约78＋既有162），0失败/取消/跳过，含18父组、222叶子；typecheck、编译及语法exit0。编译发生在加入最终测试后，修复只动运行时mjs的一行，红绿未再改TS。此处为作者阶段结果；同一独审已完成下述C1复验，仍不等于真实Host来源验收。

| 原件 | SHA-256 |
| --- | --- |
| 原235冻结补丁 | `35ae0704d55f5f8e1845ce5a81823f259b428bdf0ecc71a282d1ef43572a7bd6` |
| 独审REVIEW.md | `bdbd02c687fc00999c617a6c9318648c35e062fc81d3b14d132362b9d96a6b44` |
| 独审independent-probes.json | `6159b17591e89ef47cc5b505337f12789a93e70af81db56015a0844a11b96a1a` |
| 修前RED.json | `a0842316da9181c7b517309a247230bed272bccdc3298fbbcc2752bd75003421` |
| 修前red.tap | `1d3b81789155d5e54a96be73f05ed68784e7979c60b608eec4c390813e89edeb` |
| 修后green-c1.tap | `1046ad4a3d96d4a33c87d167cb0d08964f9821b60780bf3fb1f984b37bc409e4` |
| 修后final-targeted.tap | `084b1bc080f60d7735f5f67401c63ff14785e83946f15451113b13d9dead56d2` |
| typecheck.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| red-compile.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 一行HELPER-DELTA.diff | `e86c5fbf071ed26759784a5e1f486ca47e4ac05c986da36005342d1f5a149a46` |

正常退休原因、实际controller/Host时序和最终provider消费仍须真实捕获证明；修复只排除声明之间的C1矛盾，不能认证这些来源。旧offline v1/第一包安装身份/版本与锁验证器/生产不变，不启动Host、模型或身份，不提交。

## C1独审闭合与保存范围

[独审摘要](evidence/2026-10-29-correction-capture-contract/independent-review.json)确认C1闭合、四文件离线契约可保存。独立240/240（18父组、222叶子），与作者240分层记录；原11探针逐字重放均符合预期，三个原矛盾现在拒绝，提前创建factory仍合法。11不另加到240，原235/11中3异常接受及红例历史不改写。独审源摘要SHA-256为 `52bc563f0ca5fe12d80c8af08e7714eddbcbd93f510d0599c6bf7bc64292c6b6`；仓库归档为另有自身hash的非敏感派生摘要。

独审13:15旧只读pwd/Git/冻结文件探测的结果无法恢复，executionOutcome保持unknown；它不含测试或写入，不能标为未执行。后续普通shell已实际恢复，当前复验命令均有终态；没有借旧句柄重跑不确定测试或处理旧PID。

本次仅归档与最小更新状态，模块和测试维持已审hash，不重跑验证。八类来源字段仍是合成声明；安装JSON摘要、controller标签、Core行、文件/计数及注入函数均不能认证实际collector。Host/profile/正式gate继续false，真实artifact/SDK/ESM、回调/退休原因及最终provider消费仍未验。仅按授权普通保存当前开发分支，不合并、发布或部署；实际提交/远端SHA以Git核实为准。
