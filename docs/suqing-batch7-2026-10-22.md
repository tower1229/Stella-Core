# 肃清第七批：SQLite worker 隔离修复与公开 Host 接缝（Agent 正例待权限）

基线 `0a1ef3b1ec4864c2247028a247d64033e1dca8a5`。最终提交、逐文件源身份、命令、退出码及产物清单见 `.artifacts/suqing-batch7-20261022/delivery.json`。本批未生成安装包、推送或部署；编译目录只供本次验证。

## 已确认结果

最终 verification-a4：typecheck、定向编译通过，**106/106 定向测试及 3/3 legacy 注册检查**通过，无 skipped/cancelled。数字为本版同产物重新运行结果，包含父/子测试计数，不累加历史通过数。

SQLite 只读 worker 启动问题已解决。真实本机 OpenClaw `2026.8.2` Gateway 与完整 Core 插件已经在保持原文件/网络隔离规则的环境中启动。最终 host-probe-a5 在所需 hook 权限缺失时，由 Core 在公开 reply_dispatch 路径返回明确拒绝：`checkpoint_agent_hook_permission_required`；实际 provider 请求 **0**，Gateway 子进程退出码 0，合成来源夹具已清理。

**正常 Agent → 数据工具 → 模型续轮 → 回答尚未通过。** 原始正例探针 `passed=false`、启动器退出码 1 均保留；不能把上述负例观察改记为正例通过。真实续轮撤权、来源/CAS 变化及取消也未完成；目前仍只有合成编排证据。`full_memory` 仍阻断，未启用。

## Worker 的直接原因与公开配置

旧错误：`SQLite read-only worker Unable to create fallback OpenClaw temp dir: /Users/zangtao/Library/Caches/openclaw-501`。这是本批先前自行添加的 sandbox-exec 文件规则拒绝私人 cache，不是 Mac 断线、平台进程创建失败、用户拒绝或自动审批拒绝。

点名文件 `node_modules/openclaw/dist/sqlite-readonly-location-CbjG1Ns9.js:201–209` 中，`resolvePrivateSqliteSnapshotStagingRoot` 优先选择绝对 `XDG_CACHE_HOME`，其次才是平台默认 cache；其 worker 创建继承环境。`TMPDIR` 控制普通临时目录，不能替代这项专用 cache 选择。

探针启动前将 `XDG_CACHE_HOME` 设为本轮合成 `OPENCLAW_STATE_DIR/cache`，验证绝对路径、canonical 归属与现存目录。该目录本来就在探针允许的合成 state 范围内；未允许读取私人 cache、扩大目录权限、移除沙箱或变更任何平台安全设置。`TMPDIR`、state、config、workspace、provider 均为隔离合成路径/回环端点，环境采用白名单，无真实凭据继承。

证据：`startup-diagnosis.json`、`public-mechanism-evidence.json`、各 `host-launch-aN.json` 和 `host-probe-aN/gateway-live.log`，均在本批 artifacts 下。只核对已点名公共文件，未递归读取/哈希 Host 安装树；已安装树整体身份仍未验证，包版本元数据不作为原版全树或最终消费证明。

## Core 的最小兼容修复

1. 实际 reply_dispatch 给出的是 abort-aware dispatcher facade，不含可选 `appendBeforeDeliver`。外层 dispatcher 仍执行公开 `reply_payload_sending`。Core 现注册该公开投递 gate，保留可用的直接 append 兼容；不依赖私有 Host 扩展或旧 opaque 信号身份。
2. 投递验证重读 checkpoint/catalog/已释放依赖。Core 自有 2 秒预算先于注册的 15 秒 Host hook 预算返回明确 cancel；失败/超时关闭该 grant，迟到结果不能重新打开。该有限主张以固定受信任 Host 和正常事件循环为边界，不声称能对抗敌意 Host。
3. 投递先识别已知 run 或目标 session。已知 run 丢失 key、event/context 的 key 冲突或 run 冲突都 cancel，不能用字段删除逃过校验。新增对应负例，其他 Agent 的可识别非目标投递不受影响。
4. 真实 webchat ingress 不提供 Timestamp。只读 supply 使用 Core 接收时间作为 evidenceCutoff，保留原 Host timestamp 为 undefined；不伪造事件时间，重查仍要求原字段一致。归档 ingress 的 Host timestamp 要求未改，来源、owner/direct、物理 session、权限和 frozen expected 均未放宽。
5. fresh_tools 现在在 ingress 及每次 live 重查显式要求 `plugins.entries.stella-core.hooks.allowConversationAccess === true`，并拒绝 `allowPromptInjection === false`。未授权、撤销或提示 hook 禁用时不建 grant/不供给新正文，已释放依赖的投递也拒绝。没有修改这些 Host 权限；测试对象中的合成权限声明不是实际 Gateway 授权。
6. `openclaw.plugin.json` 补充实际数据工具 `stella_memory_data` 的 `contracts.tools` 声明，使静态所有权与注册一致。没有修改 OpenClaw 源码/安装。

只读独立安全审查发现的权限检查与缺 key 投递问题均已修复，再运行最终 a4 全部针对检查。Core 没有调用模型 API、创建 provider 或变造 Host 身份。

## 真实探针原始序列

| 尝试 | 编译产物 | 观察及退出边界 |
| --- | --- | --- |
| a1 | batch6 compiled-a5 | 公开 XDG 配置跨过 worker 启动；测试 wrapper 换行错误导致插件导入失败，旧 ready 检测随后超时；0 provider 请求 |
| a2 | batch6 compiled-a5 | 修正 wrapper/ready 检测，Gateway+Core 加载；Core 因 facade 不含可选 append 拒绝；0 请求 |
| a3 | batch7 compiled-a1 | 公开 payload gate 已接线；Core 因旧只读 Timestamp 前置拒绝；0 请求 |
| a4 | batch7 compiled-a2 | Timestamp 前置已校准；新 session 在 reply_dispatch 前尚未建立，`checkpoint_ingress_session_unavailable`；0 请求 |
| a5 | batch7 compiled-a4 | 最终 Core 显式拒绝缺 conversation-hook 权限；0 请求、Gateway exit 0、夹具清理 |

全部 Gateway 子进程均已通过自己持有的 child handle 结束；未枚举进程、未调用 ps、未启动生产 Gateway。owner 登记已移除，各原始结果保留。a1 的合成状态内曾自动启用 bundled memory-core 维护，默认日志曾落在 `/tmp/openclaw`；后续明确设置 memory slot none、memory-core/session-memory 关闭并将日志指定到本次 out。没有迁移/删除共享旧日志，也不把关闭的记忆入口扩成产品需求。

## 真实权限阻塞与最小请求

当前 Host 日志明确拒绝非 bundled 插件注册 `before_prompt_build`、`before_agent_run`、`agent_end`，要求 `plugins.entries.stella-core.hooks.allowConversationAccess=true`。随包 `docs/gateway/configuration-reference.md:281` 明确该项允许受信任插件通过 typed hooks 读取原始对话。`api.on` 被调用不证明 Host 接受注册。

之前的任务边界禁止改变 OpenClaw 安全权限，本批未擅自开启。需要的最小新增授权仅为：**在下一次全新隔离探针的合成配置中，为 stella-core 设置上述一项 true，让它读取该临时 Gateway 的假对话并执行公开准入 hooks。** 不改生产配置、不扩大文件/网络沙箱、不开放真实资料或凭据、不改 Host 源码；进程结束即停止。该动作尚未尝试，状态为待明确授权；不是自动审批拒绝或结果不确定。

最终 a5 证明仅限本次公开 chat.send→reply_dispatch 路径在模型请求前被 Core 拒绝。由于 Host 可以跳过未获权限的 hook，不能泛化为所有 native Agent 入口都已被 Core 门禁阻断，更不能以此启用 fresh_tools 或 full_memory。

## 同一主线的下一最小出口

- 获准隔离 conversation-hook 权限后，先用受支持 new/reset/session 生命周期建立新的真实物理 session，再核对 Core ingress、before_agent_run、工具工厂与 before_tool_call 的真实 run/session 关联；不伪造 session，不修改 expected 迎合观测。a4 的 session 前置是未闭合问题，不保证授权本身足够解决。
- 先完成一个正常 Google Agent 正例：捕获全部 loopback provider 请求、list/read 参数及结果、最终回答，并核对确切来源和 full_memory=false。没有正例就不扩展其他功能。
- 同一最终编译身份再完成来源/CAS 变化、取消、工具交付后续轮前撤权。分别标明 Core 供给拒绝、Host 取消/续轮行为、provider 是否仍收到已交付内容；存在缺口就保留能力阻断，不用合成通过或旧包结果补齐。
- 本批只推进 SQ-08/09 的公开接缝与证据，SQ-06 剩余业务 writer、SQ-07 消费者刷新和全入口 full_memory 矩阵没有据此完成。保留默认 legacy/显式 opt-in，不迁移真实沧海。

四份前期未提交计划/测试逐文件 hash 保持不变，未纳入本批提交。全部新增产物位于已验证非 iCloud 的项目路径；未读私人记忆/真实凭据、真实 API、生产 Gateway/配置/索引、push 或被拒 Host 全树扫描。
