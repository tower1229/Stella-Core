# 固定8aef发布物的分段纠正消费者（2026-10-29，独审通过）

只消费完整提交 `8aef5f96563f917a616b4c046746b91f81318647` 构建的真实tgz，不使用分支或隐式HEAD。driver已校验detached checkout及build identity的同一SHA/sourceClean=true。本轮仅两验证脚本、[唯一状态索引](../../../PROJECT-STATE.yaml)和本目录摘要；生产、fixture、package/lock、主配置/权限/身份均未改。此处记录保存前基线；实际保存提交由Git历史核实。[机器摘要](verification-summary.json)保存计数、模块及原始hash。

作者与独审分别执行正式离线脚本，均 **10/10**，0失败/取消/跳过/TODO；两次是同一组10项，不相加为20项：原9项正文保留，新增一个顶层分段用例；原[844包九项证据](../2026-10-29-packaged-request-freshness/README.md)仍是历史，不覆盖这次修复发布物。本轮没有运行CI、真实Host/Gateway或真实模型。

## 新增用例的实际链路

使用固定提交已有fixture `segmented:true, segmentCase:'separate-allowed'`，通过真实包main的 `default.register(fake API)` 注册工具。测试核对同一个Source v2的父策略与A片段策略确实是不同对象，均沿用既有许可；B片段由其策略拒绝。没有修改fixture或新增授权语义。

fixture完成后、`begin`之前即安装精确payload SHA计数，覆盖准入/原话归档、纠正提交、精确回读和同请求新permit重试：

- 返回 `local_committed + readback_verified`，documents恰一。
- Work的sourceRefs指向该Source，confirmed/candidate/rejected/open四类非空行都只引用A Evidence；`WORK_GOAL_B`是纠正目标文本，不是被拒的fragment-B。正文不含B payload标记。
- 返回对象的objectVersion、LearningChange target/operationId和receipt revision均与重新打开reader的磁盘对象/HEAD精确一致。
- 新permit重试返回同一receipt及结果，不重新推断或写入；该夹具总计1次归档＋1次纠正，HEAD不变。
- **B payload调用0，获准A调用36，owner-input调用28**。其他payload全部对照该LearningChange的input Evidence及owner Source Policy分类，不能随意归为获准依赖。指标是应用层 `CatalogReader.readPayload` 调用，不是全部Git/文件系统I/O，也不证明共享文件内部字节隔离。

driver必须观察 `segmentedCorrection.status === 'passed'`；缺少新用例结构结果时不能仅凭原9项报告成功。

## 产物与来源

tgz SHA-256：`aa7f7b4b4fa4a2743fb8604471b0fa804aa0df1624a2d5802b0fb2c69b18435a`，510文件逐项匹配固定构建字节。三个修补模块 `personal-views.js`、`checkpoint-source-access.js`、`checkpoint-agent-supply.js` 均在实际consumer包路径加载，逐文件hash在摘要中。主进程5734个解析路径包含133个包内Core生产模块，无工作树src或.test-dist生产回退，越界记录0；原ESM/CJS symlink拒绝、freshness/撤权及清理用例保留通过。

空consumer＋安全tgz解包＋复制固定锁匹配的既有运行依赖，显式使用现有官方OpenClaw10.8 peer；**不是fresh npm安装**。yaml仍为锁定2.9.1，工作区2.9.0被拒后采用既有SDK2.9.1，未安装/下载或改锁。合成帮助代码从固定提交转换，生产import全部改接包产物，没有复制生产实现进入测试。

```sh
node scripts/focused-correction-consumer.mjs \
  --revision 8aef5f96563f917a616b4c046746b91f81318647 \
  --sdk-root EXISTING_OFFICIAL_OPENCLAW_10_8 \
  --out NEW_EXTERNAL_EVIDENCE_DIRECTORY
```

typecheck、脚本语法及diff检查通过；consumer exit0，受控group gone/owned complete/pending0，监督root及本轮临时运行树删除。本轮没有探测、清理或修改更早EPERM未决现场，不能宣称所有历史资源已清理；SDK drain仍未证明。

[独审摘要](independent-review.json)已通过，原始摘要SHA-256为 `901661daa3e30bdebf9ffcebb8a98c9c15e2cfa6c0d6f9c4af1ad8e06c18f83c`。归档是非敏感精选摘要，原件hash与归档自身hash分开；独审合成receipt和对象版本与作者运行各自记录。五文件冻结及三模块包内字节均独立复核，独审也为B0/A36/owner28、一归档一纠正、只读重试且本轮受控进程/运行树清理完成。

这是单个合法分段场景的focused consumer offline结果；不是打包分段否定矩阵、真实Host/模型语义、正式完整consumer/probes、正式gate或full_memory验收。源码修复141项的旧证据保持各自身份，不能合并计数或冒充包内否定路径。下一步仅保存六文件白名单并核对发布SHA/CI；不扩功能或部署。
