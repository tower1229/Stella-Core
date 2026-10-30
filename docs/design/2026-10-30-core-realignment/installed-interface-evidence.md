> 仓库文档候选，2026-10-30。来源为Library资料包version 1；原成员SHA-256：a4df328a734ec9a5743b058433b0f0e3a47cdffdec9f26ac37bda0c18bbdebdf。本次仅落库与任务索引更新，未实现或运行。源稿的“本轮/云端/待持久化/提交暂停”保留原阶段身份，其中提交暂停指旧业务线；现行任务状态只读[任务台账](../../../.task-control/state.json)。不是用户对整体规范的批准。
>
> 已规范化临时目录称谓及未附来源引用；原始恢复稿hash不冒充现存原件复验。证据层与适配说明见[本目录索引](README.md)。本机绝对路径、私人会话和无关项目文件未导入。

> 本页是已有安装观察记录；末尾04:38补记更新默认模型/插件字段的早期失败，实际harness仍未知。本次未重查安装、配置或回调。

结论：**现有安装已确认是 OpenClaw 2026.10.8，普通插件工具具备请求者、受众及生命周期接缝；但当前有效 harness 未查明，可信“当前作者原话”的实际供给仍有缺口。** 本轮仅做安装与源码只读核验，没有运行 Host 回调，不能据此启用确认型学习。

安装根目录下文记为 `SDK_ROOT`：

```text
SDK_ROOT（本机 OpenClaw 2026.10.8 安装根；绝对用户路径已在打包副本中省略）
```

| 项目 | 当前安装已观察 | 静态已核 | 仍未知 |
|---|---|---|---|
| 安装身份 | 包版本 `2026.10.8`；Node `v24.22.1`；CLI 指向此安装 | engines 为 `>=24.22.1 <25 \|\| >=26.12.1` | 运行中 Gateway 的实际版本，本轮未查询 |
| 公共导出 | manifest 声明且目标文件存在：`plugin-entry`、`hook-runtime`、`agent-runtime`、`plugin-runtime`、`agent-harness-runtime` | `plugin-entry` 导出普通工具工厂上下文及 hook 类型 | 未做动态导入或真实注册 |
| 有效 harness | 三条安全子字段查询均失败，见下文 | provider/model 的 `agentRuntime.id` 决定相关路由；仅启用某插件不证明已选用它 | 当前模型/provider、会话实际选中的 harness |
| 请求者 | 未观察真实回调 | factory 有 `requesterSenderId`、`senderIsOwner`；tool hook 有 Host 派生的 `requester` | 当前入口是否填齐、CLI 等入口缺失哪些字段 |
| 受众 | 未观察真实 audience | factory 可得 `memoryAudience` 及独立 freshness guard；不能从 owner/session 推导 | 当前所选 memory provider/harness 是否实际提供 |
| 活性、取消 | 未运行取消探针 | v2 factory 要求 invocation guard；execute 接收取消 signal；tool hook 有 run/toolCall 标识 | 当前真实回调的完整 guard 链及失效行为 |
| 当前作者原话 | factory 没有原话或原话 ID 字段 | `before_prompt_build` 类型支持 `currentUserMessage/currentUserMessageId`，但生产者填充不同 | 当前 harness 能否提供可信、可关联的原话与 admission ID |
| 用户确认 | 未观察、未生成 | 模型工具参数、prompt、最后一条 user-role 消息均不能单独证明作者确认 | 必须留给实际来源绑定及后续语义验证 |

安装 manifest 的 SHA256：

```text
9be09f47e73b05da1736aaeab337b4c0cfe35921bcc5b7a185a44b9fe70d2acc
```

安全配置查询只尝试了：

```text
openclaw config get agents.defaults.model.primary --json
openclaw config get models.providers.google.agentRuntime.id --json
openclaw config get plugins.entries.codex.enabled --json
```

三条均退出 `1`，错误分类为 **`openclaw-501` 缓存权限不足**。未读取整份配置或 auth 文件，未改缓存权限、TMPDIR、登录或持久设置。因此不能把项目指定的 Gemini 模型要求写成“当前运行配置已确认”。`OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`、`OPENCLAW_PROFILE` 仅检查是否存在，三者均未设置。

普通工具的静态供给链可定位如下；这些安装 bundle 路径仅用于审计，**不是建议的产品导入路径**：

- `SDK_ROOT/dist/config-contracts-DhkndZxE.d.ts:40608–40689`：factory 的公开上下文。请求者来自可信入站元数据；有 audience、invocation/audience guard，但**没有 `runId`、`toolCallId`、当前原话、原话 ID 或 `inputProvenance`**。`assertInputCommitAllowed` 是特定输入提交的同步准入检查，不等于作者原话或业务写入许可。
- `dist/settled-turn-finalization-result-C9OeLIPK.mjs:144–200` → `dist/builtin-openclaw-BX-ebv6u.mjs:15132、15275–15356`：组装工具运行上下文并传入 sender、session、audience、取消信号等。
- `dist/agent-tools-BpvnuqKV.mjs:581–598` → `dist/openclaw-tools-DAzq2YlL.mjs:516–571`：把入站 `senderId` 投影为 factory 的 `requesterSenderId`，同时传递 owner、audience 等字段。
- `dist/tools-D3QqPm1T.mjs:51–77、103–127`：创建 v2 factory 上下文，检查生命周期 authority/调用 guard，包装执行前后检查；execute 使用 `toolCallId、params、signal、onUpdate`。普通插件仍须按公开契约使用独立 audience guard，**工具活性不替代来源 read/learn 权限**。
- `dist/agent-tools.before-tool-call-BlaJnGLw.mjs:3269–3285`：tool hook 的实际构造点填充 `runId`、`toolCallId`、`abortSignal` 和 requester。它们是 **hook 事实**，不能回填并声称 factory 原生提供了这些字段。
- `dist/embedded-agent-DCu96Le_.mjs:4493–4514、4834–4845`：audience 校验 Host 签发及 session 绑定；自动解析还依赖 session admission、所选 native memory provider 等条件，可能不提供 audience。它不自动授予 CangHai 资料权限。

作者原话存在一个需要保留的生产者差异：

| 位置 | 已核行为 | 含义 |
|---|---|---|
| `config-contracts…d.ts:8860–8867` | 类型允许 `currentUserMessage/currentUserMessageId` | 类型存在不代表当前 harness 填充 |
| `attempt-system-prompt-prepare-D0xJiaBx.mjs:3817–3852` → `context-engine-maintenance-BLg4XD_W.mjs:255–287` | inspected 内置路径给 `before_prompt_build` 的是 `prompt/messages`，没有上述两个字段；prompt 可经过包装处理 | 不能把该 prompt 当不可变作者原文 |
| `agent-harness-runtime-SBuVSuSF.mjs:309–343` | 公共 helper 在调用者提供 admitted message/ID 时才填充当前输入字段 | 存在可用接缝，但须验证实际调用者 |
| `agentsapi-attempt-BcOayjUS.mjs:190–232` | 尝试从 user-turn recorder 获取 admitted message，也存在回退 `params.prompt` 的路径 | 必须区分有 admission 来源与普通 prompt 回退 |
| `config-contracts…d.ts:716–731、8800–8840` | agent hook 可带 `inputProvenance`，区分 external/inter-session/internal | 来源类别不是 owner 身份、资料许可或语义确认 |

因此，目前可支持的设计边界是：**工具执行可以提交候选解释；只有取得实际作者来源绑定且语义上明确确认后，才考虑发布为当前理解。** 原话来源缺失时保留候选，不从工具参数、owner 布尔值或模型输入补造确认。

最短后续合成验证定义如下，本轮未执行：

1. 保留 memory-core/native context，仅注册一个普通 v2 受控工具；先安全确定实际有效 harness，不换 harness 来掩盖缺字段。
2. 用一条纯合成作者输入，分别记录 factory、公开 hook、execute 的白名单元数据及字段来源；工具参数故意含不同“作者原话”，验证它不能成为确认依据。
3. 核对实际 `currentUserMessage/Id` 是否来自当前 admission，并与 hook 的 run/toolCall 关联。缺字段或仅有 prompt 回退时，结果必须保持“候选/来源未证”。
4. 生命周期、缺 requester/audience、取消等拒绝可先用离线负例验证；之后如需第二个真实请求，只验证新请求重新取得身份、权限和版本。**不要求跑旧纠正链，也不把技术关联通过称为更懂作者。**

本轮未写仓库、未修改配置、未启动 Host、未调用模型、未创建身份或权限，也未恢复暂停的十五文件工作。阻塞仅为安全配置查询的缓存权限错误及尚无真实回调证据；没有修复或绕过该限制。

## 后续精确配置查询（2026-10-30 04:38 UTC）

经正常逐命令审批，同一只读查询返回：agents.defaults.model.primary = google/gemini-3.8-flash（exit 0）；plugins.entries.codex.enabled = true（exit 0）；models.providers.google.agentRuntime.id 查询 exit 1，原因尚未进一步确认。默认模型已证实，但插件启用不证明实际会话使用该 harness。未改权限、TMPDIR、配置或凭据，未读取整份配置/auth，未启动 Host。前述缓存错误不再阻塞已成功的两项字段，实际 harness 仍未知。
