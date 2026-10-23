# 肃清：v3 来源策略兼容批次（2026-10-23）

本批只修复 Core `fresh_tools` 对既有 v3 策略消费的接线，不修改 OpenClaw，不迁移 main、不扩大来源权限、不调用真实模型。基线为 `8e390d8ed6a16c525bc0e97c5ded74e57b3ac636`。已加载 main 仍是该旧源码对应安装包 SHA256 `03f79079e9ea13600b93865b054315aa158b7f364c4f94ad5cf143051c32368f`；本批尚未安装或产出新 npm 包。

## 缺口与最小实现

此前工具同时拒绝 full_memory profile、processing grant 和所有非 v1 策略，并且 catalog 超过 64 条直接失败。这些是工具接线缺口，不能通过清空真实 catalog 或将 v3 改写为 v1 解决。

新增小型 `checkpoint-source-access` 适配器，将已准入的 Host owner/direct 请求接到已有 `createPersonalContextAccess` 和 source policy evaluator。Host 提供真实身份和执行；Core 绑定确切 request/purpose/processing grant/model/catalog/checkpoint。自然语言场景、主题和 access rule 仍由结构化语义判断生成，不从 owner 身份推导、不由模型工具参数授权。公开 Host LLM 接口负责执行；不恢复 opaque signal、私有 provider 或凭据转换。

同一工具调用的取消信号传到辅助判断；首次原文读取在其通过后才发生。异步 freshness 检查全部 await。相同目标在同一 provider 生命周期可复用已校验判断；跨工具的已授权原文沿用现有请求内缓存，新用户请求重新准入。没有新增跨请求权限缓存。

list 分页 16 条，句柄对应固定 catalog 序号。合法拒绝按已有稳定类别计数；明确缺少精确描述/上下文单列 contextRequired，不返回该项目。异常判断、身份/owner 不匹配、损坏、版本变化不降格为普通拒绝。list/read 保留解释规则，并新增可选 quotePolicy 元数据；summary 不新增引用授权。Core 不能承诺真实模型严格遵从这些提示或撤回已发送数据。

有限供给作用域只跳过全 catalog 描述覆盖检查；全量 Praxis/view 绑定默认仍严格检查。每个实际读取目标仍要求自身精确 source/policy/segment 描述和全部策略。full_memory 能力标志未放开。

## 真实源的只读分类

固定源 revision `396d7ca422e735fb636faf57764a478f335ff5eb`，不读 payload、不运行 Host/语义模型、不修改源策略。

| 分类 | 数量 | 含义 |
|---|---:|---|
| current evidence / 可解析 | 114 / 114 | 结构与策略可解析 |
| 无附加上下文即可供给 | 0 | 不代表 114 条均不可用 |
| 明确静态用途/受众拒绝 | 0 | 尚未给具体真实问题，不能推定实际问题都会获准 |
| 需要请求相关语义判断 | 98 | 已审核描述存在，仍需当前可信请求及逐策略判断 |
| 另需精确分段审核描述 | 16 | 不以整文件描述替代 segment/父策略覆盖 |
| 技术损坏 | 0 | 本次元数据检查未发现此类失败 |

64 条含 access rules，114 条含 interpretation rules；现有 processing grant 结构有效、允许当前 main 模型且 purpose 匹配，但全覆盖校验缺精确分段描述。116 个 descriptor 不是 114 条全可读的证明。实际允许/按策略拒绝的数量只有在具体问题与合规语义判断后才能确定，本批未执行该动作。

可公开聚合证据：`.artifacts/v3-source-access-20261023/real-metadata-summary.json`。逐对象引用仅留任务私有证据，不进源码、fixtures 或本文；真实 payload 读取、真实模型请求和源写入均为 0。

## 验证与身份

针对测试只用合成仓库、策略和 Host API stub；不是原版 Host 端到端或真实模型质量验收。独立编译目录只链接已知公开 Core schemas；测试 sandbox 阻止 `.openclaw` 读取、真实用户目录写入、出站网络和 ps。定向 TypeScript 编译覆盖 src/tests，退出 0。

最终 `verification-a4` **158/158 通过，0 fail/skip/cancel，exit 0**；唯一该轮进程 PID 33268 于 06:32:09 UTC 退出，时长约 84 秒。原始命令、被测源码 hash、时间、PID、结果在 `verification-a4/result.json` 与 `tests.tap`。早轮 schema 资源缺失、127/128 及随后 156/157（持久化 receipt 错误优先级需修复）的结果保留，不算通过。修复后保持旧 persistence receipt 语义，并加覆盖读取后的取消负例。

合成覆盖包括：v1 既有路径、v3 allow/合法 refuse、summary 与解释/引用约束、精确描述缺失、owner/身份/purpose/model/fallback 拒绝、异常返回、工具独立取消零原文读取、grant/catalog/policy freshness、67 对象完整分页、默认全覆盖绑定仍严格、checkpoint/原文/片段与视图回归。未运行 main、chat.send、索引或真实 provider。

## main 后续切换前的精确清单（仅准备）

1. 先形成保留全部原 catalog/策略及原 processing grant 的有限兼容源；不能使用 catalog 为空的 `6cd154ce1d7129e6be3a234c4e29edff83dfa096` 候选冒充旧记忆接入。显式固定目标 revision，并核对 manifest 的 modelPolicy Git blob pin；现有 16 条精确分段描述缺口需审核补齐或如实继续不供给，不能自动生成授权。
2. 从本批固定 Core commit 生成并核验新包后，才准备 main 加载路径切换；旧包不能算新代码已加载。先离线兼容检查并保留原配置/源/状态备份。
3. 非秘密字段候选：`plugins.entries.stella-core.config.recoveryAuthority=core_checkpoint`、独立仓库外 `checkpointStateDirectory=/Users/zangtao/.openclaw/stella-core/checkpoints/main`、`agentMemory=fresh_tools`、`requestArchive=local`，明确兼容 `manifestPath`；保留 `agentId=main`、原 canghaiRoot、`dataMode=local_write`。移除双权威 `recoveryRevision` 和 legacy `initializationGatewayAccess`（以及若实际存在的 legacy durability）。外置状态只用已审阅 revision 显式 initialize，不自动相信 HEAD。
4. `agents.entries.main.tools.alsoAllow` 仅增加 `stella_memory_data`，不替换已有 `timeline_resolve`；已有 conversation access 不扩展。工具接通会允许本人请求按原策略访问旧记忆，是实际影响，不是单纯改展示标签。
5. memory-core、真实 bootstrap、Telegram/四自动任务暂停均保留；本批未写 main config/checkpoint/tool permission。旧拒绝动作没有重试。仅在后续准确批准的范围内做本地切换和同 Gateway 健康验证。
6. 实际辅助语义调用和 Agent 续轮会向 provider 发送本次输入、审核描述、策略元数据、获准原文及既有 Host 上下文；仍须单独确定可外发资料、凭据使用和费用/请求范围。每页最多 16 个候选、各自最多涉及 evidence/source 两项策略判断，辅助调用也计入费用与请求范围；旧“总共 9 次请求”的合成 v1 测试准备不能直接沿用为 v3 真实调用上限，Host 实际重试亦未证明硬封顶。离线 114 条可解析不授权这些真实调用。Chrome owner/direct 入口映射也仍需单独验证。

## Chrome prepare 报错的只读结论

当前已加载旧包的 completion-adapter 从公开 resolveCommandAuthorization 取得 senderId/senderIsOwner，并直接采用 event.ctx.ChatType；plugin.prepareInput 在加载意识/启动 Agent 前调用 resolveTurnAudience/assertPrivateContextAudience。只有 owner=true、非空 senderId、direct 且非 group/channel/cron/subagent 的会话通过；未知字段不会自动授予私人上下文。`private_context_audience_forbidden` 与截图阶段 prepare 精确吻合。

因此这次 UI 错误确实由 Stella 接入的入口门禁产生，发生在模型生成前；不是问候内容的语义拒绝，也不是本批未加载的 v3 修复导致。已检查的有限日志没有记录本次三个身份/会话原始值，不能确定究竟是 WebChat→owner 映射缺失还是 chatType 未匹配。没有重放请求、读取正文、改权限或调用模型。

本批收尾只读核对：真实源仍为 396d7ca 且干净、6cd154ce 候选分支保留、main checkpoint 目录不存在、Stella entry/加载路径/main 工具许可均与迁移前快照一致，四份旧未提交文件 hash 未变。证据见同目录 `main-readonly-check.json`。没有新 Gateway/provider 进程；本批登记测试和只读命令均已退出，原 main 服务保持运行。
