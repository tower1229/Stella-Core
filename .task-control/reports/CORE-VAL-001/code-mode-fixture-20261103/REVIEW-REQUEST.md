# 单来源 code-mode 与回执窄修审查

基线 f76025c；本包只改6个 fixture／测试／合同文件，另有唯一状态增量与脱敏证据。未改生产代码、实际 Host、权限、grant 或源数据。旧真实失败和旧夹具字节保留。

## 需要审查的边界

1. 官方10.9公开hook的toolKind/code_mode_exec及toolInputKind/javascript来自Host内部WeakSet标识；params自填标识不算证据。外层仅放行生成器输出的完整固定程序，字节不等即拒绝。它不是安全JavaScript分类器，不放行任意exec；不把旧模型程序自动改写成受测操作。新真实请求须带这个固定程序，不能宣称自然工具选择已通过。
2. 普通内层tool仍经原生工具策略和v2guard。原精确ref/read、一次attempt、一次策略和取消/90秒检查保留。固定10.9的session store等桥并不全走工具hook，因此仅放行所有exec再检查内层是不安全替代。
3. before_tool_call阻断后Host会短路后续handler，旧后置观察器无法记录本次拒绝；新记录在限制器中直接同步发布。入口第三参数由getter交接改为snapshot sink；未来loader不得照抄旧临时entry。回执不含正文/ref/session/作者资料。同步sink失败停止本次测试，异步sink拒绝且收敛rejection，不吞全局异常。
4. collectionComplete始终false；终态来自独立核对同一run的官方事实。pending、未知或错误run不能变终态。计数是观测，不是模型消费、账单或全采集证明。不能从本地source replay推定实际Host最终载荷未变；未来promotion仍须实际确认固定入口/最终行为。

## 验证

定向45/45（原25 + 新20），同一个合成外层及拒绝场景保留旧红／新绿。新测试直接回放固定官方control factory、control kind/alias处理、readCode和nested bridge函数；所有I/O均为合成collaborator，没有导入Host runtime或启动Guest worker。这里验证调用连接，不证明真实worker隔离、模型输出或官方Host整体行为。

复验命令：

```sh
node --test scripts/lib/single-source-test-boundary.test.mjs scripts/lib/single-source-code-mode.test.mjs
node .task-control/reports/CORE-VAL-001/code-mode-fixture-20261103/REPLAY.mjs
```

`OFFICIAL-SOURCE-PINS.json`固定8份本机10.9源码。`changes.patch`只含本包6文件；`frozen/`保存这6文件精确字节，`MANIFEST.json`绑定本包及状态快照。生产main仍为上轮普通gen13，原一次费用授权耗尽。候选未加载、未提交、未push；独审通过后按白名单本地保存，再由主管另行决定下一实际请求。
