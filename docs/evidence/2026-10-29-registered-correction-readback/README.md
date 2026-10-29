# 注册纠正工具精确回读：R1 权限边界修复（独审P1已关闭）

基线 `ce2343c17c7dba5c1d60fa2b1daf87a288bdcd52`，此处为本次保存前观察；实际保存提交用Git历史定位，不将基线当作包含本页的提交。根 [PROJECT-STATE.yaml](../../../PROJECT-STATE.yaml) 为唯一任务状态入口；[当前证据](verification-summary.json)含来源源码hash、精确结果与未覆盖范围。本次保存前已只读核实远端同为ce2343c1；推送后的实际SHA以Git/远端为准。

## P1 与最小修复

独审确认初版115项虽通过，但普通memory工具的 `sourceAccessFor` 和独立视图上下文会重新读取grant：空descriptor入场的同一run，后来将**合成**grant扩大，新tool permit即可释放1 Work并读取5次受保护payload。这是未闭合的既有工具权限边界，不是已观察到的精确读取内核回归。[初版115原样摘要](verification-initial-115.json)保留原文件hash与范围，不能将其标为P1已通过。独审原件hash和本次修前失败日志hash见当前证据。

R1仅修改两个实现/测试源码文件，精确读取内核、native包装和C3协调器保持初版hash：

- `checkpoint-agent-supply` 的来源context在创建前、异步使用及创建后，检查入场已捕获grant绑定；未缓存的work/understanding独立处理context也检查同一绑定。新permit不产生新权限，不沿session寻找最新scope。
- resolver延迟到未缓存的原文/视图实际需要时创建。已合法供给的work、list及原文缓存仍只检查请求身份/取消/旧permit边界，不因grant文件变化重新打开权限。这保留D-058请求内缓存语义，并非即时撤回平台。

## 完整接线与验收

实际注册的 `stella_memory_correct` 保留run/toolCall permit、owner匹配和空参数；经原有单一writer提交，再由C3重新打开CatalogReader，核对receipt精确revision/代际和LearningChange目标版本。正式工具直接传入Core scope，不用private-local façade或authority对象映射。native包装仍共用运输无关授权精确读取内核，来源/Evidence闭包、窄策略、邻段隔离、版本、取消与lease检查保留。

作者本次定向共 **253/253，0失败/取消/跳过**；独审结果单列，不标为独验253：

- 注册纠正工具12项＝原10＋精确扩权反例和合法缓存/下一请求两例。扩权反例先复现修前失败；修后同run work/understanding/list均拒绝，受保护payload I/O=0、正文返回=0、拒绝窗口业务提交=0。合法缓存继续返回且无新payload/模型端口调用；下一独立请求可加载已发布的新合成grant。
- 原native/Evidence/C2/C3回归105项保留；原115没有删改为skip。提交后读失败保留local_committed；同实例同请求新permit重试只读，不重复纠正推断或提交；来源语义检查仍可重复。
- 普通agent-supply单文件136项通过，覆盖缓存旧checkpoint、来源拒绝/规则、身份与hook许可、工具取消、真实实现的正常供给。监督器确认child exit0、group gone、owned work complete且root removed；未修改监督器或阈值。
- typecheck、测试编译、build、9 schema和diff检查退出0。普通回归第一次误用standalone监督入口，在测试前owned_test_root_required失败，未计验收；该日志保留hash，后使用既有suite入口。

下一请求撤权的旧用例仍明确区分memory tool窗口内受保护来源I/O=0/正文返回0与独立合法owner输入依赖I/O=1；不声称所有依赖正文读取为零。候选、反证及未决字段仍保留；no_change/needs_clarification保持空目标/变更行。

## 复核命令和边界

```sh
npm run check --silent
npm run check:schemas --silent
node scripts/compile.mjs test
node scripts/compile.mjs build
node --test .test-dist/tests/checkpoint-agent-correction-supply.test.js
node --test --test-concurrency=2 .test-dist/tests/checkpoint-native-readback.test.js .test-dist/tests/checkpoint-native-evidence-get.test.js .test-dist/tests/checkpoint-correction-readback.test.js
node scripts/run-sdk-owner-test.mjs --suite --owner-file .test-dist/tests/checkpoint-agent-supply.test.js .test-dist/tests/checkpoint-agent-supply.test.js
```

只用无remote合成Git和google/gemini-3.8-flash/low标签的固定本地结构响应；不是真实Host身份签发/派发或真实模型语义验收。测试期间没有生产grant/config/slot、真实资料、凭据、付费调用或部署；后续仅按明确授权保存本包，不构成运行时激活。当前整体native授权交接/full_memory仍未验。

同实例重试不等于跨进程恢复旧操作；正式Source预检对只有分段窄许可的来源仍fail closed，不扩全源授权。SDK late-close/ENOENT/active-leases告警仍存在，不称drain解决；成功suite只证明进程结束后的清理契约。完整仓库套件未重跑，26项历史CI失败保留。本次R1独审已完成；下一包候选为离线打包消费者验证现有注册纠正路径，由父线程分派。D063待审、真实Host/模型未验分别约束对应动作，不阻断不依赖它们的已授权离线工作。

## R1独立复审与保存范围

独立执行注册工具12项＋原P1重放1项，共 **13/13通过，0失败/取消/跳过，exit 0**。同run空descriptor入场后扩大合成grant，后续新permit明确personal_context_access_changed；受保护payload读取、正文返回、新模型端口调用及业务提交均0。合法缓存保留且无新增I/O；下一独立请求经显式合成Git/CAS发布后重新授权。receipt精确版本、提交后readback_failed保留local_committed及只读重试亦通过。

断连恢复后确认临时编译曾实际落盘；未虚构原CLI终态。当前内存TypeScript检查0诊断，311份现有JS与冻结源码产物逐字一致。共享读取内核/native包装/C3源码hash未变；本轮未重跑105共享或136普通工具，沿用明确身份的作者证据和此前有限独审。日志/独审报告及结果原hash、源码hash、反例计数和范围已存入[项目内摘要](verification-summary.json)，恢复不依赖临时目录。初版115及原P1失败身份保留。

保存只包含本轮9文件实现/测试/状态/证据，不包含四个无关未跟踪文件，不强推、合并或部署。根状态仍保留D063待审、26旧CI失败、consumer/probes/真实Host/真实模型/full_memory未验；这些是各自对应动作的边界，不能充当全局停工开关。
