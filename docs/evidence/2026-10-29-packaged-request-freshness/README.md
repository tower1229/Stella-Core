# 固定包消费者：下一请求与同进程重新注册（2026-10-29，限定离线独审通过）

固定生产源码：`844b1ea1a7a7f3c228e095c7ffed75dc4910d760`。本轮只修改两个验证脚本、[唯一状态索引](../../../PROJECT-STATE.yaml)和本目录摘要；不修改生产源码、package/lock、主配置/slot、真实grant/凭据或资料。完整结果、来源hash和计数见[机器摘要](verification-summary.json)。

作者正式脚本 **9/9**，独审另一次正式脚本 **9/9**，均0失败/取消/跳过/TODO：保留原7项，新增以下2项。两轮是相同9个用例，不能相加为18个独立用例。原[七项作者及独审证据](../2026-10-29-focused-packaged-correction-consumer/README.md)保持原版本及字节，不重标为本轮独审；当前9项包含保留7项，不与历史各轮计数相加。[独审摘要](independent-review.json)归档原报告/摘要hash、五文件冻结hash、独立结果和未覆盖范围；作者与独审的合成revision/目标版本分别保留。

独审原摘要SHA-256为 `f170124b1f9141c3c2a14a686333e08d890dd857f76e2f22a045a831b81ec509`。独审通过后只更新证据/状态，两个验证脚本仍与冻结版本一致。提交前经授权通道重新读取远端，确认本地与远端基线均为上述844b1ea1；这不是包含当前证据更新的提交SHA，也不是部署或Host验收。

## 实际消费范围

从固定提交临时本地clone，标准build identity为上述SHA/sourceClean=true；offline pack为510文件，tgz SHA-256 `d0b947fc30c32f21a982906598d06af311bbba9e7ca55a6fdb303d185cd0dd89`。在空consumer中安全解包，按实际包名导入main并调用 `default.register(fake API)`；没有从工作树src或.test-dist导入生产实现。5734个解析路径中133个Core生产模块来自tgz，主进程越界记录0；原ESM/CJS symlink执行前拒绝负例仍通过。

依赖仍是固定锁版本的既有副本，显式peer为现有官方OpenClaw 2026.10.8，**没有fresh npm安装**或registry原tgz真实性验收。yaml固定锁2.9.1、工作区2.9.0被拒，采用既有SDK的2.9.1；逐文件donor/copy摘要一致，来源hash见机器摘要。不读用户配置、缓存或密钥。

## 新增两项实际断言

1. 通过实际注册纠正tool把合成Work目标A改为B。仍在相同session的新run，以及停止服务/清空hook和factory后重新 `default.register` 的新run，均读到同一B对象版本；候选、反证、未决问题及其他目标外字段保持非空原值。每轮 `currentMemory.userRequest` 等于当前run，来源判断使用当前输入hash；checkpoint等于该轮当前authority，token已更新。归档可合法推进revision，测试不要求它等于旧纠正receipt。旧permit拒绝，当前只读调用不再次纠正、提交或改变HEAD。该夹具总计3次原话归档、1次纠正。
2. 结束纠正请求后，仅对该无remote合成Git的descriptor使用既有事务/CAS收窄为空；重新注册并开始新run，实际memory tool拒绝 `personal_context_descriptor_required`，旧permit也拒绝。计数窗口是**新请求准入完成后，覆盖memory调用和旧permit拒绝**：受保护来源payload读取0、正文结果返回0；另一个获独立Source Policy许可的owner-input依赖payload读取1，不能写作全部I/O为0。窗口内HEAD不变、纠正推断不增加；夹具总计2次归档、1次纠正和1次显式合成权限收窄提交，不能混算为重复纠正。

`next(true)` 的接缝来自固定提交 `tests/checkpoint-agent-correction-supply.test.ts`：只在**同一进程**停止已注册服务并重新注册，保留同一合成Git和临时状态。它不创建新Node进程，不证明跨进程恢复旧操作、真实Host重启或任意旧permit恢复。测试只证明新请求采用当前权限/checkpoint；不扩大D-058即时撤权范围。

## 复跑、清理与边界

```sh
node scripts/focused-correction-consumer.mjs \
  --revision 844b1ea1a7a7f3c228e095c7ffed75dc4910d760 \
  --sdk-root EXISTING_OFFICIAL_OPENCLAW_10_8 \
  --out NEW_EXTERNAL_EVIDENCE_DIRECTORY
```

这需要当前候选脚本；生产包仍严格由固定844b1ea1构建，夹具只适配合成帮助代码，其生产import全部来自解包包。runner要求两项freshness结构结果均passed，不能仅凭原7项报告成功。callback是固定google/gemini-3.8-flash/low协议结构响应，没有真实模型、网络API或费用。

typecheck、脚本语法及diff检查通过。子进程exit0，受控进程组再次只读核实不存在；监督root不存在，owned work complete/pending0，整个临时构建/consumer/合成Git与状态运行树已删除。SDK active-leases告警保留，不宣称SDK drain。

父线程已核实844b1ea1双CI各1465项/1439通过/26旧失败，签名与5fe9一致；152 probes未运行，正式gate仍false。focused脚本未被CI调用，本轮作者9项和独审9项是单独离线结果。正式全量consumer、真实Host/Gemini语义、profile/Chrome、迁移及full_memory仍未验。本阶段只普通提交/推送已审查的六文件，不修改生产实现或部署；随后可按精确SHA独立观察CI及分派不依赖真实Host/模型的有界离线小包，不因D063整体待审或Bili复验暂停。
