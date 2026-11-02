# 一次真实 main 请求：失败、恢复及等待点诊断

当前结论：一次请求失败，普通产物已恢复；下文保留最初回滚未完成及审批拒绝的时间顺序。后续只读诊断与纯合成复现见文末，不代表真实问题已修复。

用户已批准正常 main 上下文到 Google Gemini 3.8 Flash 的一次测试。实际通过认证 WebUI 提交一次，未重发。新会话历史为空，原 grant、固定90f数据根和 publisher off 不变。

请求停在 preparing_context，无回答、无已观察工具结果。90秒 embedded timeout 触发后仍未结束，随后出现120.2秒 owner deadline 和150.2秒 main lane/abort grace 错误。不能声称90秒硬终止；物理模型调用、token和费用未知，不能记零。没有完成资料回读、来源定位或语义分析验收。

运行日志证明临时产物已加载到 generation12，同时 before_prompt_build/agent_end 被现有 allowConversationAccess 策略阻止；未扩大该权限。此前合成测试不足以证明真实限制钩子有效，运行前检查漏掉了这些诊断。该钩子拒绝与超时根因尚无因果证据。

官方 chat.abort 已无可取消 run；进一步使用同一 key/run 的 sessions.abort 后，实际会话无 active run、无 pending input。磁盘配置精确恢复测试前字节，其他 main/selfie 配置保持。**运行时回滚尚未完成**：3项 retained plugin work 未排空，官方 reload committed=false，generation12仍 active。未重启 Gateway、未绕过排空检查。

下一步先处理本次残留工作、完成普通产物恢复，再谈下一次验收；当前一次请求额度已用完。权限缺口必须单独说明，不能静默打开会话读取。技术时间线与最小回执 hash 见 REPORT.json / TECHNICAL-TIMELINE.json；未复制正文、种子、配置、身份或完整日志。

## 后续恢复检查与审批阻塞

2026-11-02 11:37 UTC，官方 `sessions.list(activeOnly)` 返回0且无后续页；generation12日志只观察到本次测试run。Host保留的是不含run标识的opaque tokens，不能伪称已逐token认证归属。

拟执行一次官方 `gateway restart --preserve-definition --wait 0 --json`，不force、不跳过活跃工作等待。自动审批在进程创建前拒绝，理由是共享服务中断风险及未认可直接用户授权。重启claim/result均不存在，未执行或换通道重试。磁盘配置已恢复，runtime12尚未卸除的原状态不变。需要补充审批器可核验的用户原文或本次明确确认后，才能经同一正规通道重试一次。

只读源码确认：钩子权限拒绝是注册时同步跳过，不会在该分支等待；尚不能把它认定为超时原因。`preparing_context`汇总多个阶段，不能定位具体挂起await。详见RECOVERY-REPORT.json，未改任何权限或Host源码。

## 恢复完成（后续事实，不改写上述失败）

补充直接用户AGENTS原文后，同一官方重启仅重试一次并成功执行。命令无force/skip-deferral，保留服务定义。旧进程确有残留reply/run/admission，官方shutdown预算耗尽后结束，**不是干净排空**。未另发信号或重复付费请求。

新Gateway PID31634、RPC健康、Core generation2 active；实际startup日志的source为普通`device-source-20261102-00dab376/ordinary/dist/src/ordinary-plugin.js`，临时夹具已卸除。官方活跃/排队总数0，没有观察到测试自动续跑。完整openclaw.json仍与测试前字节相同，selfie配置未变；未运行selfie业务或模型验收。恢复详见RECOVERY-COMPLETE.json。

本次一次真实请求仍判失败，物理调用数/费用未知。原普通插件agent_end权限警告仍在，未自动开启权限。启动另出现自定义model catalog的cost字段schema警告，尚无证据与超时因果相关。下一工程包应定位具体挂起阶段并修正真实夹具钩子兼容，不能把恢复成功记成资料理解通过。

## 取消机制与实际等待范围

现存官方稳定性快照将最后内部阶段定位到 **2026-11-02 11:20:31.026 UTC 的 `context_assembled`**。此前 workspace、模型解析、认证和 context engine 已经过；当前请求时间窗内没有 `model.call.started` 事件。阶段记录不含 run 身份，只能与同时间窗唯一已记录测试请求关联。它不证明物理调用或费用为零。最小白名单投影见 [PHASE-EVIDENCE.json](PHASE-EVIDENCE.json)，未复制整包快照或私人正文。

实际等待发生于该阶段之后、首次记录模型调用之前；候选包括 session prompt/pre-turn、recorder 持久化、prompt projection 写入及最终工具提示刷新。没有逐 await 的进入/退出证据，不能把其中一项宣布为实际根因。更早的 recorder 等待已通过，也不能直接认定“初始持久化卡住”。

[纯合成探针](CANCELLATION-PROBE.mjs)直接提取固定10.9的投影等待、abortable、settle tracker 和 retained-work release 函数，不导入 Host 模块。三项对照均完成：普通取消及预先取消时，外层 AbortError 可先返回，底层等待与 custody 继续保留；解开人工 gate 后才结束。第三项仅演示可取消等待的差异，不证明真实存储工作已取消，也不是可直接部署的修复。结果见 [CANCELLATION-PROBE-RESULT.json](CANCELLATION-PROBE-RESULT.json)。

最小修复方向是先定位真实 pending owner，再让底层等待正确响应取消，同时保留写入完成和资源所有权证据；不能通过清空 retained tokens、延长超时或扩大会话权限来掩盖失败。Core 夹具还需显式处理必要 hook 注册未生效的问题，但该问题与本次挂起尚无因果证明。具体源码 hash、未排除项及下一无模型诊断边界见 [DIAGNOSIS.json](DIAGNOSIS.json)。本轮没有修改运行代码、Host、配置或权限，没有新模型请求。
