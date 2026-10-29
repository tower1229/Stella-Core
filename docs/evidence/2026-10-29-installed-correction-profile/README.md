# 10.8安装包注册纠正：离线报告契约

源码基线 `3b17fea1943485a1a7303bb6b6e8083c89953a8f`。本片新增独立profile `stella.installed-checkpoint-correction/openclaw-2026.10.8/v1`、纯报告检查器及合成正反测试；当前状态见[唯一索引](../../../PROJECT-STATE.yaml)，实际结果与hash见[机器摘要](verification-summary.json)。没有修改生产插件、旧探针/验证器、8.2门槛、152项或26旧失败；没有安装、Host启动、配置/权限操作、模型调用或网络发布。

## 当前能证明什么

`scripts/lib/installed-correction-profile.mjs` 只验证**离线归一化报告与另行绑定的预期事实是否一致**。期望的源码/产物/安装锁/SDK位置及版本不能从报告自身充当权威；未来应由实际安装检查、CLI观察及固定产物提供。精确对象的 `canonicalJson/objectVersion` 必须由该实际Core包提供，不复制一套对象版本算法。

当前只接受 `evidenceKind=offline_contract_fixture`，输出新schema的 `evidenceConsistency=validated`，没有 `status=passed`。`profileAccepted/hostExecutionAccepted` 和原Experimental、正式consumer、full_memory、真实模型等验收标记均固定false；自称Host捕获或通过的报告明确拒绝。这个纯检查器不认证日志来源、不创建permit，也不从senderIsOwner推导来源权限。即使合成正例齐备，仍没有真实Host证据，不能提升为profile执行通过。未来真实捕获接线需要单独审查，不能只改这个标签。

限定对象是一次 `update` 纠正及可选同请求重试，不迁移无变更/澄清、其他业务、完整Experimental九组或152项。检查：

- consumer必须已观察到安装，metadata/锁/实际SDK/CLI/构建版本与固定10.8一致，旧prepared/receipt不能借新profile身份通过。CLI复用既有严格解析器，缺失事实或consumer=null拒绝。
- 固定源码/build identity、tgz/consumer lock摘要、实际包入口/SDK位置独立绑定；不接受工作树入口回退或observer wrapper。
- run、session、原话requestHash与owner归档一致；工具hook的runId、toolCallId、requester、取消信号及执行器的实际call-id参数/会话/请求者匹配。工具factory本身没有必需runId，不能捏造；通过同一call-id关联已捕获hook。sourceGrant摘要属于明确合成fixture的Core许可观察，不是Host赋予的资料权限。
- 空工具参数；`local_committed` receipt、operation/change/target及当前checkpoint绑定；`readback_verified`须一份Work、精确对象版本及同receipt revision重新读取的磁盘内容一致。
- `readback_failed`保留已提交receipt，要求明确失败类别、空documents及无成功磁盘读回；不能包装为成功。同请求新call-id重试不得改变receipt、增加归档/纠正提交或重新推断。
- 取消、signal或非零退出均拒绝；退出0不能覆盖取消。报告一致也不能满足两套旧gate。

## 公开10.8入口的静态边界

已安装 `openclaw@2026.10.8` 的package exports提供 `plugin-entry`、`gateway-runtime`、`command-auth-native`、`session-store-runtime`、`session-transcript-runtime` 与 `provider-tools`。其公开类型从 `plugin-entry/core`导出的 `PluginHookReplyDispatchEvent` 有可选runId；`PluginHookToolContext` 有可选runId/toolCallId/requester/abortSignal；requester含Host解析的senderId/senderIsOwner。`OpenClawPluginToolContextBase`有sessionId/sessionKey及requesterSenderId/senderIsOwner。固定安装类型审计位置为 `dist/config-contracts-DhkndZxE.d.ts:9364,9824,9836,40608`；这些内部bundle位置只作版本证据，不是新产品依赖。

因此公开契约能**表达**归一化报告所需关联，但不保证每次Host运行提供这些可选字段。缺失时必须拒绝，不能由owner/admin、session或最新grant补齐。当前Core既有 `reply_dispatch → before_tool_call → registerTool.execute` 路径按run/call绑定许可；本片没有重新证明其实际Host行为，也没有建立native caller桥。

## 尚未接线及下一条件

旧 `isolated-probe-host.mjs` 与旧报告验证器仍锁8.2；原纠正探针只接受旧 `correction/currentMemory` 输出，本片没有修改或运行它们。当前没有新runner、原始artifact捕获器、CLI入口、CI job或prepared/shard迁移，也没有新的安装或Host报告。

未来真实Host小片必须独立绑定安装/解析/CLI事实、保存并核实原始hook与工具消费载荷；验证实际owner授权、v3/v4原话/历史归属、空参数schema、run/call与当前Core grant、正常取消/退休、单writer/CAS及receipt精确回读。下一请求freshness另须新入场和独立许可，不能由本片的同请求重试证明。Host执行和模型辅助调用仅可指向明确隔离的合成协议桩；真实模型语义、Chrome/profile、完整consumer/probes和full_memory仍未验收。

这一路径不依赖native slot或D063整体批准；沿用[D-063](../../DECISIONS.md#d-063--request-bound-core-memory-with-optional-native-integration)的受控tool方向，不放开旧gate。旧26测试在consumer安装前失败与8.2探针门槛是两个独立阻塞；新profile即使未来实际通过，也不能替原gate变绿。

## 独审类型修正（离线复验通过）

初版作者103项及独审103项分别通过，但独审额外29个JSON反例中有3个被错误接收，初版不能提交。原独审摘要SHA-256为 `642ac574d174d000b19d2d6d1ef182d252d35c1e1b814b560cbb3e0fcac823b0`，原候选补丁hash及红例结果保留在机器摘要的历史部分，不重标为通过。

正式回归现保留三个JSON roundtrip反例：documents为含索引0、length=1及额外未校验正文的对象；归档Evidence的version为单元素数组；同步receipt/changeRef的version为单元素数组。修前旧helper使这三条拒绝断言失败：单文件80项中76通过、4失败（3反例＋父组）。修正仅增加 `Array.isArray(documents)` 和 `typeof ref.version === "string"` 两处门禁，不转换或清洗输入。

修后106/106通过（新profile80＋原版本真实性26，后者不是CI旧26失败），0失败/取消/跳过；typecheck及脚本语法通过。编译产物来自此次新增三回归后的测试源码，红/绿运行之间未改测试源码，只替换了被动态导入的两行helper门禁。合法verified/failed结果和只读重试、所有验收false及旧gate断言均保留。[独审复验摘要](independent-review.json)确认两处缺陷关闭，独立106/106通过（含6父组、100叶子断言）；原29个JSON反例全部拒绝，重放不与正式106项累加，作者与独审两次106也不相加。原复验摘要SHA-256为 `3d2f43b002359a3fe69de9efd3efb7cdfd97669b83bcbc35b06d1544023f4e39`。归档是非敏感精选摘要，原件hash与归档hash分开。结论仅为离线契约可保存；真实capture/runner未接线，所有Host/profile及原gate验收仍false。
