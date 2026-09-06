# OpenClaw 2026.8.2 私有草稿错误重试

状态：已定位；Core 已增加失败保护。2026-09-06 主人已确认将补丁纳入版本化测试环境；正式安装不变，干净恢复验收单独记录。

## 可复现边界

入口为 `chat.send`，模型为 `google/gemini-3.1-pro-preview`，Core 通过
`reply_dispatch` 接管生成、持久化和最终发布。草稿生成期间必须阻止提前发布。

原版 Host 在 `silentExpected: true` 时清空 `assistantTexts`。实际生成已经有
`stopReason: stop` 和非空 `text`，终结阶段也恢复了一个非空 payload，但 Gemini
返回的未签名 `thinking` 块仍被不完整回合检查识别为需要续写。该检查没有把
已恢复的最终答案作为终止条件，导致原问题被内部续写指令替换，共执行三次生成。

结构化诊断观察到：`payloadCount: 1`、`assistantTexts: []`、没有超时或中止、
没有工具调用或潜在副作用。`allowEmptyAssistantReplyAsSilent: true` 和
`terminalReplyExpectation: optional` 已传入，但前者要求零 payload，因此不能解决。
私人原文不包含在此文档及测试中。

## 已实施的 Core 保护

同一个运行许可只接受一份生成结果。第二次 `llm_output` 不覆盖第一份；读取时
明确抛出 `host_generation_retried`，不进入持久化或业务回复发布。既不静默选择
第一次，也不把最后一次的内部续写冒充原问题答案。

`tests/host-silent-draft.test.ts` 使用原版 Host 的实际重试策略和合成内容复现该条件；
`tests/completion.test.ts` 验证重复生成不能触达持久化或发布。

本轮 `npm test`：230 项，227 通过，3 项 Windows 符号链接测试跳过，0 失败。
编译通过。这些结果不等于干净恢复、真实学习或混合语义评测通过。

## 隔离修补实验

在 Host 的 `resolveEmbeddedRunTerminal` 中，已有非空
`finalAssistantVisibleText` 时不再进入 reasoning-only continuation。此修改不关闭
Gemini 思考、不删除原始输出、不解除提前投递保护、不改变模型或提示词。

实验使用临时恢复环境，不改变正式安装；修改后的 Host 不属于原版 2026.8.2。
原生隔离实验已返回一次 `model.completed` 和非空最终回答；回答重新针对身份和
资料权威边界，不再要求补交内部续写上下文。该观察不是独立语义 judge 验收。
实验结束后已还原隔离 Host 文件，未保留隐式补丁。
只有明确确定修补版或其他已验证宿主的交付方式之后，才能重新建立干净安装、
构件哈希及原生恢复证据，不能沿用原版 receipt。

## 已授权的可复现安装

补丁标识为 `stella-openclaw-2026.8.2-private-draft-v1`。转换器验证整个目标模块的
原始 SHA-256 和修补后 SHA-256；未知内容拒绝修改，重复应用保持相同字节。
安装器仅用于恢复／评估脚本创建的独立 consumer，并回读验证。

恢复 receipt 的 `hostCompatibility` 保存补丁身份；混合评估按恢复 receipt 安装
相同补丁。候选门禁拒绝将原版和修补版的恢复、Praxis 与评估证据混用。
补丁不把包版本号改成一个不存在的上游版本，也不把修补版描述为原版验收。

## 干净恢复验证结果

授权后的隔离安装已通过三回合原生 `chat.send` 恢复及连续性验收：

- Core 源码快照：`f54f462e1b1bc148027a24b8096758dba5ab6342`。
- 构件 SHA-256：`e89c81f51dce4441ba9053537cae47511d9518d3c9c1a26cc99b4438bad4b8c4`。
- Host：OpenClaw `2026.8.2`，使用上文版本化兼容补丁。
- 模型：`google/gemini-3.1-pro-preview`；全新运行状态，不导入旧运行缓存。
- `sourceCloneVerified`、`nativeFinalsBound`、`continuityAccepted` 均为 `true`。

期间保留了两个失败结果，没有降低 rubric：第一轮 judge 返回完整 JSON 代码围栏，
解析器现仅接受该完整封装；第二轮答案未明确所选恢复 revision，现由运行时在系统
上下文中提供已核验的恢复范围，要求解释恢复边界时明确标识。第三轮通过同一套
语义检查。相应回归测试分别覆盖严格封装解析和运行时恢复范围注入。

此验收针对隔离、未激活的迁移诊断资料集。合法空学习／开放事项集合的恢复成功，
不证明真实行动、真实学习或其后续使用已完成；也不代表完整记忆能力或最终候选
已经通过。原始沧海及正式 Host 安装均未修改。私有原文和完整验收证据只保留本机，
不随此诊断文档公开。

后续的 `run-private-praxis-loop.mjs` 可通过 `--recovery-receipt` 绑定相同 Core、
资料 revision、构件哈希和补丁身份；缺省仍代表原版 Host，不能与修补版证据混用。
安装器回归验证恢复、评估及 Praxis 三类隔离 consumer，并拒绝其他 consumer。
这项脚本改动晚于上述源码快照，尚无对应新版真实 Praxis receipt；旧脚本的 v1
Episode 和命令行回合路径也仍待替换，不能以补丁安装支持代替 v2 原生链路验收。
