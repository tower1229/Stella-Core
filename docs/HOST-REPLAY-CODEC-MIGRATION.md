# Host replay codec 的两项契约替代

2026-10-28，仅迁移 R6/R8。依据 [D-062](DECISIONS.md#d-062--one-native-provider-path-and-one-semantic-writer)：Host 负责通用 provider/tool 兼容，Core 保留实际执行身份、来源权限、参数边界及单一纠正 writer；不默认移植 8.2 guarded provider、Context Engine 或私有 wire 指纹。其余七项 codec 失败及其他旧失败不在本次范围，不能整体改绿。

## 冻结的历史身份与失败

原定义引入提交：`e9b9305e6311e1f9d7b697941577f691988f55fe`。迁移前冻结快照：`761b78f47afdf07049cdc5a14118220d415eeaa3`，文件 `tests/host-context-replay.test.ts` SHA256 `cc68eb5ac9558236e6e378fd5b2ff799a44c940b63446600f78653d195bdd43e`。原案例明确选择 Host `2026.8.2`、`stella-guarded/gemini-3.8-flash` / `google-generative-ai`，不改写为 10.8 历史验收。

迁移前在 Node 24.22.1、已安装 OpenClaw 2026.10.8 上单独重放：11 tests，2 pass，9 fail，0 cancelled/skip。R6 与 R8 均失败于 `loadHostReplayProjection` 的旧私有导入：`ERR_MODULE_NOT_FOUND`，缺少 `openclaw/dist/tool-call-id-bBWjBMFi.js`；**尚未运行到目标断言**。这份失败保留，不因新公共路径通过而改成旧路径成功。长期依据是上述源码提交、精确版本和错误；本次完整重放另存临时报告中的 BEFORE.tap。

## R6：已省略 additionalProperties 必须拒绝

原位置：[冻结源码第59–68行](https://github.com/tower1229/Stella-Core/blob/761b78f47afdf07049cdc5a14118220d415eeaa3/tests/host-context-replay.test.ts#L59-L68)。原参数化上下文完整保留如下；本次仅移出 `already omitted` 成员及对应分支，其余四个成员和执行断言保持原样：

```ts
for (const mutation of ["required", "enum", "extra property", "already omitted", "description"] as const) test(`Google original schema rejects unbound ${mutation}`, async () => {
  const original = input(), tool = original.tools[0]!;
  if (mutation === "required") tool.parameters.required = ["action", "handle"];
  if (mutation === "enum") tool.parameters.properties = { action: { type: "string", enum: ["read", "delete"] } };
  if (mutation === "extra property") tool.parameters.properties = { ...(tool.parameters.properties as Record<string, unknown>), path: { type: "string" } };
  if (mutation === "already omitted") delete tool.parameters.additionalProperties;
  if (mutation === "description") tool.description += " extra";
  const project = await loadHostReplayProjection("2026.8.2", resolveHostReplayTarget(configuration(), modelRef));
  assert.throws(() => project(original), /host_context_google_tool_schema_unbound/);
});
```

**新契约：**可信注册工具经官方 normalizer 省略不支持的声明字段后仍可供 Core executor 消费。省略字段不授予额外参数、身份或来源权限，不作为观察 wire 获得资格的凭据。再次规范化已经省略的声明也明确接受，Core 的实际执行边界仍生效。

替代位置（现有组合用例，无新增顶层测试）：

- [checkpoint-agent-supply.test.ts](../tests/checkpoint-agent-supply.test.ts)，`official Gemini normalization preserves the registered memory executor and its argument boundary`：真实注册工具通过公共 `normalizeGeminiToolSchemas`/`inspectGeminiToolSchemas`，省略字段后的声明再次规范化不报错、同一 executor，合法 list/read 成功；9 类额外字段/非法 action/组合仍拒绝，窗口对象与 payload 读为零，业务树/Git/checkpoint 不变。
- [checkpoint-correction-readback.test.ts](../tests/checkpoint-correction-readback.test.ts)，`official Gemini normalization preserves empty correction arguments, one commit and exact Learning Change readback`：真实绑定 coordinator 的空 object 经官方省略及第二次规范化仍可消费；17 类非法输入零读/写/模型/lease 触达，合法 `{}` 单次提交并按 receipt 精确 native 回读。

**非等价边界：**不再保证任意观察到的 schema 必须符合旧 8.2 receipt 字节指纹，也不恢复私有 codec 导入。这里只验证既有可信工具与原 executor 的公共组合；没有验证实际 Host 的 provider 选择、最终 Gemini 请求或真实模型语义。

## R8：其他工具 schema 必须不变

原位置：[冻结源码第70–74行](https://github.com/tower1229/Stella-Core/blob/761b78f47afdf07049cdc5a14118220d415eeaa3/tests/host-context-replay.test.ts#L70-L74)，原测试完整保留：

```ts
test("Google compatibility leaves every other tool schema unchanged", async () => {
  const original = input(); original.tools[0]!.name = "other";
  const project = await loadHostReplayProjection("2026.8.2", resolveHostReplayTarget(configuration(), modelRef));
  assert.deepEqual(project(original).tools, original.tools);
});
```

**新契约：**官方 provider 兼容层逐工具规范化声明，包括非 Stella 工具；不能要求转换结果与每个原 schema 字节相同。原工具定义不被就地修改，name/execute 身份保留，运行许可由原执行体负责。Core 不复制或接管其他工具的授权逻辑。

替代位置是上面的既有 memory 组合用例。同一批次加入未向 Host 注册的 `synthetic_public_ping` 对照：两个 schema 都合法移除 additionalProperties；普通工具转换结果确实变化，原定义不变，required/enum/name/execute 保留。普通工具只执行一次固定公开 ping；read/path/senderId/authority 输入被其原执行体拒绝，不进入 Core 读/写或模型端口。Core 原 9 类负例及合法 list/read 全部保留。

**非等价边界：**普通工具是无私有资料端口的合成对照，不能据此宣称任意第三方工具都已正确实现执行权限。新契约允许其他声明变化；旧的“其他工具绝不转换”不再是 D-062 门槛，不以 skip、runner 过滤或放宽执行断言掩盖这一差异。

## 活动套件仍保留的范围

`host-context-replay.test.ts` 的两个模型/配置边界正例及另外七个 codec 案例保留：fixed projection digest、codec 选择、required、enum、extra property、description、system lineage/assistant basis。其余案例的旧失败不变。此次只从旧活动文件移出有明确替代且与新职责冲突的 R6/R8，没有改生产实现、152 case 评估、full_memory 状态或冻结历史证据。

本片在上述 Node/SDK 版本上 typecheck 与测试编译通过；由监督 CLI 以原生 concurrency4 定向运行两个组合文件和该旧文件：172 tests，165 pass，7 fail，0 cancelled/skip。两个组合文件仍为 163/163 通过；旧文件为 2 pass/7 fail，失败名称及 `ERR_MODULE_NOT_FOUND` 与迁移前排除 R6/R8 后逐项一致。整体命令仍 exit1，未转换为成功，未跑全量 CI。这是契约的显式替代，不是旧私有 codec 恢复，也不改变任何未验收标记。
