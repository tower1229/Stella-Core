# experimental_owner_chat 实验模式

这是原版 OpenClaw 上显式 opt-in 的有限 owner 对话模式。Host 执行模型、工具循环、取消和历史；Core 每个新用户请求校验身份、当前 checkpoint 与来源，自动留存 owner 输入，并通过 `stella_memory_data` 供给当前记忆。同 owner、同受众连续聊天无需逐轮 reset；本轮模型工具续轮复用本轮已合法供给的内容。

历史记录说明过去说过什么，不等于当前事实或许可。旧记忆修订后，历史引文仍可存在；当前工具读取新版本。提示指导不能保证真实模型永不误用历史，fake provider 验收只证明机制。运行中撤权和撤回已发送资料不属于本模式保证。

## 支持与边界

支持 `owner/direct/text/retain-v1`、已明确选择的当前源、Core checkpoint/Git/CAS、owner 输入一次归档、受管 bootstrap/声明 skill 的初始化和文件保护。新请求重新取得资格，身份/受众、来源权限、写入或首次读取失败显式拒绝。

### v3 来源策略兼容（2026-10-23 已打包并接入开发 main）

`fresh_tools` 可复用既有 `source_access_context` processing grant 和逐来源策略 evaluator，读取 retain v2/v3 的有限摘要上下文；不将策略改成 v1，也不扩展用途、受众或引用许可。公开 Host owner/direct 身份只证明请求者，不能替代请求主题、使用场景和 access rule 的结构化语义判断。判断通过公开 Host `runtime.llm.complete` 执行，绑定当前 Agent、固定模型及本次请求，输入仅为本次问题、已审核描述及相关策略元数据，不能先读原文补描述。真实 provider 的这类辅助调用也是外发及计费，须纳入单独的真实调用授权。

`stella_memory_data list` 每页最多 16 个候选，按 `nextCursor` 继续。`exclusions` 是明确的策略拒绝；`contextRequired` 是缺少语义上下文或精确审核描述，均不供给该对象。损坏、陈旧版本、异常模型结果仍显式失败。合法项目的 list/read 同传 interpretation rules 和 quotePolicy；summary 处理不产生额外 quote grant。提示和元数据供给不保证真实模型永不违反解释或引用约束。

缺少某个分段描述不会授权整文件或伪造片段审核；有限工具逐项验证，完整 Praxis/full_memory 的全覆盖检查保持原样。未决对象可以不供给，但不能把剩余对象的正常结果冒称完整记忆成功。此增量的实现及真实源元数据统计见 [v3 兼容报告](suqing-v3-source-access-2026-10-23.md)，标准安装包与原版 Host 的 v3 机制验收见 [第十五批](suqing-batch15-2026-10-23.md)。开发 main 已经用户批准采用兼容源和 checkpoint；当前包、逐项新证据及网页身份/真实推理的未完成边界以 [收尾表](suqing-closeout-2026-10-23.md) 为准。真实源 114 条保留原策略：16 条缺精确审核描述仍不可用，98 条待具体请求语义判定，不代表已全部允许；旧包结果不冒算新包通过。

完整 transcript、附件、完整 learning/outcome writer 及未显式启用的自动纠正、未知旧会话接管、旧部署平滑迁移、更多资料模式和长历史 compaction 不在本候选内，不以此阻断已验收有限模式。共享 token/cli 只表示同一 Host principal，不证明多个真人身份；多用户或受众变化需独立身份和会话。未知已有历史不得默默认领，应首次新建会话或另行设计迁移。

`stella.checkpoint status` 的 `mode=experimental_owner_chat`、`continuousOwnerChat=true` 表达有限能力。旧 `agentMemory=false` 和 `full_memory=false` 不是已验收完整能力；`fullMemoryBlockers` 仍列完整契约缺口。状态描述不是任意真实数据的验收收据。

## 安装和显式选择

使用包内 `package.json` 的 Node/OpenClaw 版本约束；本候选验证目标为 Node 24.22.1、OpenClaw 2026.8.2。只用正常 npm tarball 安装和公开 `plugins.load.paths`；不修改 Host。下面是配置说明，不授权修改现有生产部署。

```sh
npm run build
npm pack --ignore-scripts --pack-destination <candidate-directory>
npm install --prefix <isolated-consumer> --ignore-scripts --no-audit --no-fund <candidate.tgz>
```

部署者需提供兼容 Host 和依赖；本轮离线测试从本机已安装的 8 个具名依赖打包后一起安装，复用已有 Host，未证明全新 registry 下载/Host 安装。每次接入应核对 tarball SHA256、npm integrity、安装文件清单和明确源码身份；同名版本号不是包身份。

配置片段中的路径必须替换为独立、canonical、非符号链接的位置。state 目录提前创建并限制为当前账号可读写；`checkpointStateDirectory` 必须在 CangHai 仓库外，workspace 也不能在源仓库内。所有权/权限不合要求时拒绝，不自动扩权。

```json
{
  "plugins": {
    "load": { "paths": ["<isolated-consumer>/node_modules/@tower1229/stella-core"] },
    "entries": {
      "stella-core": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "recoveryAuthority": "core_checkpoint",
          "checkpointStateDirectory": "<independent-state>",
          "canghaiRoot": "<explicit-reviewed-source>",
          "agentId": "<explicit-owner-agent>",
          "dataMode": "local_write",
          "agentMemory": "fresh_tools",
          "requestArchive": "local"
        }
      }
    }
  },
  "tools": { "allow": ["stella_memory_data"] }
}
```

同时按公开 Host 机制显式声明该 Agent/workspace、owner 身份和唯一的所需 provider；本示例没有模型凭据。`allowConversationAccess` 是单独的安全权限，本轮仅已获准的新合成 Gateway，生产/真实会话必须另行授权。不启用 session-memory、Dreaming 或其他记忆插件来冒充本模式能力。

`core_checkpoint` 不配置 `recoveryRevision` 或 legacy `durability`/`initializationGatewayAccess`；不要同时保留两个权威指针。原 `fresh_tools` 名字为兼容保留，现指每用户请求重新准入。

## 当前事项读取

当前源码的 `stella_memory_data {"action":"work"}` 是可选、只读的 Ongoing Work 入口；
不接受模型另传 question、owner、路径或版本。它以本次 Host 用户输入调用既有语义选择，
仅返回选中的当前 work/ref、排除项和必要来源规则，保留 confirmed/proposed/rejected/open
的区别。工具结果仍是派生理解，不是新的 owner 原话或操作许可。

它要求源已声明并加载真实 `source_access_context` binding，且原 grant 的
`viewProcessingModelRefs` 包含当前精确模型。缺失授权则拒绝该动作，不为已有 raw
list/read/skill 额外增加视图许可要求；原 profile 已有的必需约束保持不变。
合法空结果不是“全库没有事项”，策略排除与声明对象缺失分别处理。下一用户请求读取
新 checkpoint；本请求内可复用已授权 work，仍执行身份与正常取消检查。

原文候选与其他个人视图不会直接作为该动作输出；被选 work 的 policyRef、规则和
quotePolicy 以 `usageConstraints` 元数据保留，summary 用途不产生引用许可。辅助视图
选择会将经授权的候选及原始依据交给当前固定模型，属于真实外发/计费范围，真实调用
仍需独立授权。本地 fake 选择和协议验收不证明真实模型的自然选择或写作质量。

内部可信 `correctLocal` writer 见 [本地纠正分支](CHECKPOINT-CORRECTION-WRITER.md)；
读取工具不会触发持久纠正；下节独立可选写工具需显式启用，不据此开启 full_memory。

## 当前理解读取

`stella_memory_data {"action":"understanding"}` 只读供给经既有语义选择的当前理解，保留
USER／MEMORY 分区、scope、status、来源引用与 usageConstraints；候选假设保持暂定。
视图许可、固定本轮问题和来源规则与 Work 相同，不返回原始候选／通用 context，不写
USER.md。own correction 成功后清理本轮旧视图缓存，下一请求重新读取。见
[具体供给契约](CHECKPOINT-UNDERSTANDING-SUPPLY.md)与[当前验收状态](mainline-global-status-2026-10-24.md)。

## 可选的本人纠正写工具

默认不注册 `stella_memory_correct`，现有 `stella_memory_data` 仍只读。要在隔离开发环境
测试此增量，Core 配置需显式增加 `agentCorrection: "tool"`，并已有 `dataMode: "local_write"`、
`requestArchive: "local"` 和 `agentMemory: "fresh_tools"`；Host 的工具许可还须单独允许
`stella_memory_correct`。这不是给当前 main 自动开权限的指令。

Agent 依据用户原意选择是否调用，参数只能为 `{}`。Core 只处理本轮已经由 Host 认证并
归档的用户原话，拒绝另传文本、Evidence、路径、owner 或 expected；继续检查真实 processing
binding、精确模型/view许可及各来源原有 derive/learn 阶段限制，不新增独立“learn开关”。
不会给普通问候无条件运行完整纠正，不能把模型自行生成的文字当主人证据。

成功回执只表示 `local_committed`，包含 disposition、clarification、changeRef 和本轮
currentMemory。Core 仅依据这次 writer 的实际 CAS 返回 C 重绑后续工具供给、清旧缓存，
并发/重复同轮调用复用同一操作；不从观测 HEAD 升级，不 push。旧对话和最初的系统上下文
可留作历史，最新成功回执及后续工具结果表示本轮当前版本。clarification 仍是未决问题。

这些机制的合成测试不证明真实模型能正确识别纠正、理解作者或作出学习判断。真实 main
启用工具、来源许可、真实资料外发及费用仍须独立确认；完整学习/outcome/transcript 与
full_memory 不因这一可选入口自动通过。具体边界见 [纠正分支契约](CHECKPOINT-CORRECTION-WRITER.md)。

## 首次初始化与正常聊天

公开 Gateway 方法 `stella.checkpoint` 要求 operator.admin；以下为请求 JSON，使用已认证的公开 Gateway 客户端提交：

1. 核对源的明确 40 hex revision、目录/manifest/policy/retain-v1 archive 契约及干净 Git 状态。只选已审阅目标，不自动采用任意 HEAD。
2. 提交 `{"action":"initialize","revision":"<selected-40hex>","operationId":"<unique-init-id>"}`。它建立 Core authority，**尚未写 Host 文件**；重复/冲突选择按精确原 expected 处理，不删状态重试。
3. 需要 Host bootstrap/skill 时，源 runtime-profile v2 必须声明 host_materialization_ref 和受管 recipe。提交 `{"action":"materialize"}`，只物化 recipe 声明文件。常见五文件为 AGENTS/SOUL/IDENTITY/USER/MEMORY.md，skill 是 `skills/<declared-name>/SKILL.md`，实际以 receipt 为准。已有无所有权用户文件冲突不能强覆写。
4. 首次物化可能因公开配置尚未完成运行时应用而返回 `host_identity_reload_pending`，或因 skill 空缓存返回 `skill_unavailable_or_shadowed`。保留已写文件、配置、pending、备份和原 operation；使用该目标 Gateway 的正常生命周期刷新后重试同一 `materialize`，仍须通过原身份／发现校验。不能私改缓存、伪造应用或把 pending 算完成。此刷新只在首次设置需要时进行；生产重启须授权。
5. 核对 `status.materialized` 的 receipt、文件 hash、公开 skill 发现与实际模型输入；写盘不等于消费。首次新建无旧历史会话，正常聊天。以后同一受众继续该会话，**无需每轮 reset 或重启**。每请求自动归档一次，模型工具续轮不再归档；归档使用 Core 接收时间，缺 Host Timestamp 时不假称事件发生时间。

本候选的真实 Host 验收使用全新合成 workspace/state、loopback fake provider，先初始化物化，再连续三轮，不使用私人资料。

## 持续归档与容量

输入归档的 256 个 frame 限制只约束同时进行的不同请求，不是插件生命周期的总请求额度。成功、失败或取消结束后释放 frame；同一请求的并发调用在全部结束前共享准备结果。原话、接收时间和原 expected 保存在既有 Git／transaction journal，释放内存不会删除归档，也不靠无限缓存维持历史。

已留有 journal 的最近一次请求可幂等重放，重启后仍使用原版本元组；同请求 ID 的不同内容拒绝。没有留下 journal 的失败尝试不再永久占用内存键，重试按新准备处理。已经有后续提交时，旧请求的重放仍可能因陈旧版本被拒绝，不自动回滚或采用当前观测值。该容量修复不扩大完整 transcript 或历史 compaction 的验收范围。

## 备份、故障与回退

接入前备份目标配置、workspace、明确源 revision/Git 原始留存及外置 checkpoint/初始化状态。受管初始化在 `<checkpointStateDirectory>/initialization/operations/<id>.json` 的变更记录保存原 before 字节、beforeMode 和 previousReceipt，并保存 pending/receipt/fence 等操作状态；备份和所有权依据不是独立的 backups/ownership 目录。保留整个操作状态，不根据时间自动偷锁。失败保持 fence，按原操作重试，不能把 observed 值替换成原 expected。

`{"action":"rollback","operationId":"<materialization-operation-id>"}` 仅回退该次受管文件/展示身份操作：恢复原内容和模式、删除本次新增文件、保留无关用户文件，并保持 fence。它要求原初始化操作仍 current，原 authority revision/token 完全匹配。正常自动归档推进 checkpoint 后，旧初始化 rollback **可能拒绝**，不能宣传任意时刻一键回退；不得删除 checkpoint 绕过。回退失败保留状态，需按已备份目标协调恢复。

插件版本回退、源 Git revision 回退和受管文件 rollback 是不同操作。停止该测试实例后可恢复其预接入配置/目录备份并切换已核对旧包；真实部署回退需要单独审阅，不能只恢复旧 Git 而回滚撤权/外置 authority。安装不修改真实 Host，禁用新合成实例不影响生产。不要运行 legacy `stella:activate` 或 private recovery runner 来接通本实验模式。

## 一次性接入与真实模型小验收前置

确认固定包/hash、Host/Node、独立目录、显式源及所有权、支持的 owner 受众与 retain 策略、初始化/skill 发现及回退备份；先核对状态，再新会话。包只包含显式必要说明 `docs/EXPERIMENTAL-OWNER-CHAT.md` 和 README，四份旧未提交计划/测试不入包。

真实模型小规模验收另需明确批准：Google `gemini-3.8-flash`（low）外部 API/预算与请求上限；使用哪个已有凭据引用且是否允许测试进程读取（不在日志输出）；只发哪些已审阅合成文本到该 provider；独立 Gateway/state 和 conversation hooks 的真实测试范围；如需接入私人源/生产配置、重启或迁移则分别批准。建议先仅合成文本少量同会话请求，逐项看记忆引用与历史区分，不给泛化质量保证。本批不执行任何真实调用。


## WebChat 的可信 profile 入口（2026-10-23，第十六批）

在 `core_checkpoint` 模式下，Core 可兼容原版 Host 当前请求的可信 `SessionCreation.actor`。只有 `via=operator`、`actor.type=human`、`actor.source=profile`、WebChat/direct、管理员 owner 以及明确选中的 profile 同时成立时，缺少 transport sender 的网页请求才可使用这条路径。客户端名、设备 ID、显示名、提示词和旧会话 owner 都不补足这个身份。

- 插件配置 `webchatOwnerProfileId` 必须等于当前已认证的原始 profile ID；不自动选择第一个管理员，不创建或更改 Host profile。
- Core requester 使用独立命名空间 `openclaw-profile:<profileId>`。不会伪装为 Telegram requester，也不会修改 Host 的 `SenderId`。
- 记忆供给和本地输入归档使用同一个解析器；工具依旧绑定精确的 run/session/一次性 callId 和捕获时的 Host sender。网页 Host sender 缺失不代表取消 run/session 检查。
- 来源仍遵守自己的 manifest 与策略。若声明 `source_access_context`，尤其当前真实 main 的 v3 来源，则 processing grant 的 `requesterIds` 还须明确包含对应 namespaced requester。这个配置不替代资料用途/受众限制；合法旧 retain 来源也不会被追加强制 LLM 许可框架。
- 未知旧历史仍不能接管。首次接入可使用新空会话，绑定成功后同 owner 连续聊天无需逐轮 reset。

只读 RPC `stella.identity` 接受空参数 `{}`，要求现有 `operator.admin` scope 和当前已认证 profile。它只返回调用连接自己的 `profileId`、`requesterId`、客户端类型及未检查来源/会话授权的标记；不加载 checkpoint、来源、聊天、bootstrap 或 LLM，也不创建身份或 grant。缺 profile 时显式返回 `checkpoint_webchat_profile_required`。可通过 Control UI 自带 Debug 的 manual RPC 功能使用当前网页连接；另一个 CLI 连接的身份不能冒充这个网页连接。

本批仅完成本地实现和合成验证，没有部署到真实 main，没有修改真实 profile/owner 绑定、grant 或已有会话。仅凭此接口也不承诺当前共享 token 登录已经具备个人 profile；缺失时必须先确认 Host 实际支持的可信身份登录方式，不能以 client/device 标签补造人。

不要用真实 `chat.send` 诊断身份：实测原版 Host 在 Core 拒绝后仍可独立生成 dashboard 标题，因此 `reply_dispatch` 拒绝不保证阻止所有 Host 辅助模型请求。直接只读身份 RPC 避开该聊天路径。本批仅允许 loopback 假模型，未调用真实模型。证据与边界见 [第十六批](suqing-batch16-2026-10-23.md)。

显式的新来源快照更新使用 operator-admin 的 [数据快照导入](EXPLICIT-SNAPSHOT-IMPORT.md)；不会自动采用 HEAD、合并本地归档冲突或新增资料许可。
