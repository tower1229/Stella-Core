# 正向技能启用与请求终态清理候选

实际 main 已只追加 `stella-understand-sources`，白名单69→70；官方 patch exit0，无重启，PID31634。技能 eligible=true、blockedByAgentFilter=false，selfie状态未变。前后配置结构差异仅这一项，固定90f、原97来源/362描述符、工具策略、其他插件和所有访问许可保持。health=true、activeWork全0、队列0；没有独立retained计数证明。备份及单项回滚patch留在私有目录，未演练回滚；没有将原配置/私密值复制进Git。

## 正常终态清理

当前已加载产物仍有 `agent_end` 会话访问警告。官方10.9的该hook确实受conversation-access控制；取消信号在正常 `complete/clearState` 不会自动abort，不能仅依赖取消清理。

已实现但**未加载、待独审**的最小替代：`api.agent.events.registerAgentEventSubscription`，仅订阅 `lifecycle`。只读取phase、明确错误结算标记及agent/run/session标量，复用现有精确匹配的metadata/source退场，并补齐未执行candidate工具关联释放。不订阅assistant/tool正文，不读取事件error消息，不增加会话访问。正常end和明确executionSettled/fallbackExhaustedFailure错误释放；未知/可重试error不当终态；工具续轮不结束用户请求。既有取消监听和首次来源/v2 guard保持。

官方依据（仓内SDK与实际全局10.9八文件字节一致，hash见REPORT.json）：

- `docs/plugins/sdk-overview/host-hooks.md:265`：正式grouped agent事件接口。
- `dist/config-contracts-DzLaG7FV.d.ts:10282,43085`：事件订阅契约。
- `dist/registry-CTP8XMYJ.mjs:1473`：生命周期订阅注册不要求conversation-access；`:2597`附近列出了agent_end的访问门禁。`:187`限制普通插件伪造Host保留事件流。
- `dist/runtime-U4i1bMh7.mjs:260,718`：Host活动registry统一桥接/按streams筛选/clone事件；没有绕过注册走全局私有事件总线。
- `dist/agent-events-jWdQ_ESE.mjs:293`：Host发布agent/session/run事实。
- `dist/agent-run-terminal-outcome-CrMEEYuY.mjs:110`：end与可重试error的区别；本候选仅选明确结算/耗尽error，不复制完整状态机。
- `dist/reply-run-registry.registry-ICalZVvY.mjs:758,786`：normal complete不abort；`dispatch-from-config-D0ByBFxM.mjs:434,1530`：reply_dispatch的signal及释放路径。

定向编译及7套测试89/89通过（含新4用例）；新入口旧版红3/3保留。首次绿尝试88/89是新增测试错把公开hook的block对象当字符串，已修断言，运行代码未为此放宽。连续40请求验证正常终态后能重新接纳，分别越过32请求/128pending容量；取消、身份不匹配、重试和原设备/来源边界回归保留。仅合成数据，模型policy测试是本地假响应，真实API调用0。

## 交接边界

九个源码/测试路径见REPORT.json；精确变更见CANDIDATE.patch。当前main仍使用原已审generation15产物，**清理修复不在该产物中**。本轮不安装修复、不提交/推送未审代码、不调用模型或私人正文。下一步是独审该小包后再决定常规无模型加载验证；真实终态生产链和10.8兼容尚未验，不能由这89项当作真实模型消费/正向理解通过。真实问答仍需明确受限官方工具面及新增付费/上下文范围授权，不复用已耗尽额度。
