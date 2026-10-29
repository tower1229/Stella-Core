# Source v2 合法A-only纠正回读反例（2026-10-29）

基线 `ebf2d35c58091f4915c32752a4480caeafbd139b`。本轮只新增现有测试夹具的分段变体和一个注册tool反例，没有修改生产实现、真实grant/身份、SDK、Host配置或版本门槛，没有真实模型/Host请求，也未提交推送。[项目状态](../../../PROJECT-STATE.yaml)为唯一任务入口；实际计数及原始hash见[机器摘要](verification-summary.json)。

## 确认的缺陷

最终单文件回归 **13项：原12通过，新增1失败**，0取消/跳过/TODO。新增测试仍要求合法精确回读返回 `readback_verified`，没有将失败改写为成功。

同一Source v2含两个独立payload：A沿用获准父策略；B的策略明确 `readPurposes: []`、`derivePurposes: []`。两段均使用既有精确locator/descriptor契约；B descriptor只提供描述上下文，不能覆盖策略拒绝。Work的confirmed/candidate/rejected/open证据全部只引用A，不含B。分开payload用于准确区分B的正文读取，不能据此推断共享同一文件时的底层读取行为。

实际既有注册纠正tool使用空参数提交后：

- 原writer只提交一次，回执保留 `local_committed`，磁盘Work目标已从A改为B并匹配receipt目标版本。
- 普通memory工具在纠正前能读Work A、纠正后能读相同目标版本的Work B；分段授权检查成功。这排除了writer失败或A原本无权的解释。
- 精确回读及同请求只读重试均在当前receipt revision的整源预检拒绝：`readback_failed / segmented_source_requires_evidence`，documents为空；重试没有重复推断、提交或改HEAD。
- 普通list确实将B排除为 `permission_denied`；各窗口的B payload调用均为0，返回结果不含B正文标记。纠正过程仍会合法读取A和独立owner-input等依赖，不能写成总I/O为0。回读在整源预检即拒绝，回读窗口A/B原文payload调用均为0。

I/O指标是实际 `CatalogReader.readPayload` 的调用尝试，按精确payload SHA区分A/B/其他；没有声称统计所有Git底层散列或文件系统读取。观察器调用原resolver方法并重新抛错，不替换其授权判断。

## 定位与下一最小修补范围（尚未实施）

`src/openclaw/checkpoint-agent-supply.ts` 的纠正 `openReadScope.authorizeSources` 对每个Source调用 `resolver.assertSourceAccess`；`src/praxis/episode-evidence.ts` 的该接口明确拒绝任何分段Source。普通 `src/praxis/personal-views.ts` 已区分Source v2元数据准入和精确Evidence父/片段策略交集；`src/canghai/authorized-exact-readback.ts` 也已有Source闭包结构检查、分段Evidence覆盖及 `resolver.readEvidence` 的完整依赖授权。

建议后继小包只复用上述元数据准入与精确Evidence授权，不另写缩水策略：保留v1整源校验；v2仍检查当前Source/owner/用途/处理资格，并由真实Evidence闭包证明精确segment、父/段策略及派生依赖均获准，再释放目标。**不能只删预检，也不能简单把无segment的 `assertSourceAccess` 替换成 `assertSourceMetadataAccess`**：现有SourceAccessProvider对v2要求精确segment，只有A段grant不能伪造成整源授权。必要时让已有闭包携带选中Evidence的定位上下文，避免扩grant或发明新身份路由。

具体接线点是注册scope与已有精确读取内核的预检边界；单一writer、receipt/CAS精确版本、入场grant绑定及旧permit/重试行为应保持。生产修复和新增安全反例由父线程另行限定，本轮不实施。

## 复跑和边界

```sh
node scripts/compile.mjs test
node --test --test-reporter=tap \
  --test-name-pattern='^segmented A-only registered correction' \
  .test-dist/tests/checkpoint-agent-correction-supply.test.js
```

请在隔离的合成测试状态路径运行；本轮实际整文件使用专属临时config/state与固定结构响应，未读主配置或秘密。首轮测试桩缺少必需segment回显、次轮观察器误记message而非category，均保留原日志hash，未计为产品复现；修正后整文件唯一失败落在预期回读契约处。

test编译、typecheck与diff检查通过。各自产生的测试进程组已确认结束，临时运行树在进程结束后删除。SDK仍有active-leases、close-unconfirmed和晚关闭ENOENT告警，不能宣称drain；最终没有清理断言失败。历史12项v1/参数/权限/旧permit/幂等/下一请求用例全部通过。真实Host、打包消费者、真实语义、跨进程恢复和full_memory未验；现有正式gate和旧CI失败没有改写。
