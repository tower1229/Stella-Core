# Ordinary memory-core 来源准入兼容候选

本包定位并修复一个确定的契约错误：Core 把官方可选的
`memoryAudience.kind === "owner-private"` 当成所有来源调用的必要条件，
而当前普通 memory-core 路线不会生成这个 native-provider 字段。
候选仅在离线合成验证中通过，待独审，未安装、未提交或推送。

## 五次真实失败可以说明什么

原 run `core-forward-real-3f248ed8-9347-4fb8-b172-fc7a1224b178`
有五次嵌套 `tool_call:…:stella_source_read:N`，全部为 `list`，均返回
Core 的 `status:failed / source_requester_or_audience_forbidden`。
这不是来源策略判断、读取正文或模型回答成功。原记录及费用边界见
[实际结果](../forward-real-question-20261103/RESULT.json)，不重新发送请求。

官方 pre-execution hook 拦截返回 `status:blocked / reason`；Core 的
`failed / code / publisher:false` 来自工具 execute 的 catch。观察到的
格式把此次失败定位到 Core 执行中的准入检查，而非 Tool Search 没找到工具。

10.9 固定源码链：

1. `dist/extensions/memory-core/index.js:969–988` 注册 `runtime:memoryRuntime`，
   没有 native `providerRuntime`。
2. `dist/memory-state-YBTzZa6s.mjs:256` 把此注册识别为 `legacy`（官方内部
   对普通 memory runtime 的称呼，不表示 Core 恢复旧私有桥）。
3. `dist/embedded-agent-DoEPu8ye.mjs:4494–4521` 在非 native 情况下有意不返回
   `memoryAudience`，不调用 native audience resolver。
4. `dist/builtin-openclaw-BxzDR6yL.mjs:15294` 和
   `dist/openclaw-tools-CSSYZDKR.mjs:517–575` 原样传递可选字段；后者在无
   audience 时也不给 `assertMemoryAudienceCurrent`。公开类型同样标为可选，
   且禁止 provider 自行重建。
5. `dist/tool-search-BorBxVGT.mjs:1012–1102` 调用已有工具对象，生成本次
   nested call ID，不重建 factory requester/owner/audience。
6. Core 修前 `ordinary-source-admission.ts` 将上述缺失字段纳入共享拒绝
   条件，即使其余身份、设备与原 grant 匹配，也必然失败。

这是源码及最小反例支持的确定兼容缺陷，能解释当前错误。原 run 未记录该
共享条件的逐字段快照，不能声称已逐一观察到五次 factory 的 owner、sender
与 audience 值，也不能排除修复后另有准入问题。没有证据指向 grant 损坏、
Tool Search 丢弃身份或需要打开会话内容权限。

## 修复的具体边界

- 有 native audience 时，保留原 `owner-private`、agent、快照和 guard 检查。
- 没有 audience 时，必须由公开 `memory-host-core` SDK 确认当前有效注册为
  memory-core 的普通 runtime，且保持同一 runtime、无 native provider。
- 同时继续要求真实直连 WebUI 的已认证 scope、Host 认证设备、owner、
  run/call/session incarnation、已提交 native input、原始 v2 guard 与取消检查。
- 只接受该设备精确匹配的既有 `openclaw-device:` 来源 grant；profile-only
  grant、其他设备/提供者、委托入口、冲突 audience、跨连接或请求均拒绝。
- 不合成 native audience，不授予私人会话访问，不改 grant、源根、97/362
  范围、模型用途或 publisher。原 metadata 与正文策略/版本校验保持。

两项生产文件仅增加这一分支与内部测试注入点，没有新增工具、配置字段、
身份映射服务、Host 修改或依赖。独审需核这一等价性，不能将“缺字段即略过”
当成修复。

## 验证与可重复材料

- 修前单例红：同一合成设备/原 grant、普通 memory-core、无 audience，
  预期 `listed`，实际 `failed`。保留原输出 hash，不把失败覆盖成通过。
- 候选编译成功；五个受影响测试文件 **80/80**，含新增允许/拒绝、原文读取、
  scope、生命周期及旧原生 audience 对照。策略 completion 为固定合成响应，
  外部模型调用为零。
- [官方探针](OFFICIAL-PROBE.mjs) **6/6** 单列：使用固定官方函数提取和纯
  合成依赖，另直接执行官方 ToolSearchRuntime 的 target dispatcher。该探针
  不启动 Host，不执行真实认证/会话入场，不声称完整原生链已通过。
- [版本与源码 hash](OFFICIAL-SOURCE-PINS.json)、[结果](VALIDATION.json)、
  [精确补丁](CHANGE.patch) 和 [冻结输入](FROZEN-INPUTS.json) 随包保存。
  运行官方探针可在仓库根执行 `node <本包>/OFFICIAL-PROBE.mjs .`，仅适用于
  本包锁定的 10.9 分发产物；不同产物先重新核对源码。

代码三文件基线为 `04dc946049491c8117e79ffacdde2510bdbeda3f`；两份文档只含
本包追加差异，之前的 dirty 不属于本包审查范围。state 单独记录 191→192，
不将历史台账整体包装成已审。

## 接续条件

先独审本包并核公开 registration 在实际生命周期内的语义，再依现有授权做
可回滚安装/无模型状态验证。原真实请求已经终态且额度用完；本轮没有再次
操作 main、调用模型或读取私人正文。真正来源策略判断、原文消费、带来源
回答、实际缓存释放及 CI 10.8 仍未验，不把这份离线修复算作端到端通过。
