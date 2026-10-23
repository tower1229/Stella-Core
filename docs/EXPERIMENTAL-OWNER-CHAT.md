# experimental_owner_chat 实验模式

这是原版 OpenClaw 上显式 opt-in 的有限 owner 对话模式。Host 执行模型、工具循环、取消和历史；Core 每个新用户请求校验身份、当前 checkpoint 与来源，自动留存 owner 输入，并通过 `stella_memory_data` 供给当前记忆。同 owner、同受众连续聊天无需逐轮 reset；本轮模型工具续轮复用本轮已合法供给的内容。

历史记录说明过去说过什么，不等于当前事实或许可。旧记忆修订后，历史引文仍可存在；当前工具读取新版本。提示指导不能保证真实模型永不误用历史，fake provider 验收只证明机制。运行中撤权和撤回已发送资料不属于本模式保证。

## 支持与边界

支持 `owner/direct/text/retain-v1`、已明确选择的当前源、Core checkpoint/Git/CAS、owner 输入一次归档、受管 bootstrap/声明 skill 的初始化和文件保护。新请求重新取得资格，身份/受众、来源权限、写入或首次读取失败显式拒绝。

完整 transcript、附件、语义 learning/correction/outcome writer、未知旧会话接管、旧部署平滑迁移、更多资料模式和长历史 compaction 不在本候选内，不以此阻断已验收有限模式。共享 token/cli 只表示同一 Host principal，不证明多个真人身份；多用户或受众变化需独立身份和会话。未知已有历史不得默默认领，应首次新建会话或另行设计迁移。

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

## 首次初始化与正常聊天

公开 Gateway 方法 `stella.checkpoint` 要求 operator.admin；以下为请求 JSON，使用已认证的公开 Gateway 客户端提交：

1. 核对源的明确 40 hex revision、目录/manifest/policy/retain-v1 archive 契约及干净 Git 状态。只选已审阅目标，不自动采用任意 HEAD。
2. 提交 `{"action":"initialize","revision":"<selected-40hex>","operationId":"<unique-init-id>"}`。它建立 Core authority，**尚未写 Host 文件**；重复/冲突选择按精确原 expected 处理，不删状态重试。
3. 需要 Host bootstrap/skill 时，源 runtime-profile v2 必须声明 host_materialization_ref 和受管 recipe。提交 `{"action":"materialize"}`，只物化 recipe 声明文件。常见五文件为 AGENTS/SOUL/IDENTITY/USER/MEMORY.md，skill 是 `skills/<declared-name>/SKILL.md`，实际以 receipt 为准。已有无所有权用户文件冲突不能强覆写。
4. 首次 skill 发现可能仍见 Host 的空缓存而返回 `skill_unavailable_or_shadowed`。保留 pending、备份和原 operation；使用该目标 Gateway 的正常生命周期刷新后重试同一 `materialize`，不能私改 Host 缓存或伪造发现。此刷新只在首次设置需要时进行；生产重启须授权。
5. 核对 `status.materialized` 的 receipt、文件 hash、公开 skill 发现与实际模型输入；写盘不等于消费。首次新建无旧历史会话，正常聊天。以后同一受众继续该会话，**无需每轮 reset 或重启**。每请求自动归档一次，模型工具续轮不再归档；归档使用 Core 接收时间，缺 Host Timestamp 时不假称事件发生时间。

本候选的真实 Host 验收使用全新合成 workspace/state、loopback fake provider，先初始化物化，再连续三轮，不使用私人资料。

## 备份、故障与回退

接入前备份目标配置、workspace、明确源 revision/Git 原始留存及外置 checkpoint/初始化状态。受管初始化在 `<checkpointStateDirectory>/initialization/operations/<id>.json` 的变更记录保存原 before 字节、beforeMode 和 previousReceipt，并保存 pending/receipt/fence 等操作状态；备份和所有权依据不是独立的 backups/ownership 目录。保留整个操作状态，不根据时间自动偷锁。失败保持 fence，按原操作重试，不能把 observed 值替换成原 expected。

`{"action":"rollback","operationId":"<materialization-operation-id>"}` 仅回退该次受管文件/展示身份操作：恢复原内容和模式、删除本次新增文件、保留无关用户文件，并保持 fence。它要求原初始化操作仍 current，原 authority revision/token 完全匹配。正常自动归档推进 checkpoint 后，旧初始化 rollback **可能拒绝**，不能宣传任意时刻一键回退；不得删除 checkpoint 绕过。回退失败保留状态，需按已备份目标协调恢复。

插件版本回退、源 Git revision 回退和受管文件 rollback 是不同操作。停止该测试实例后可恢复其预接入配置/目录备份并切换已核对旧包；真实部署回退需要单独审阅，不能只恢复旧 Git 而回滚撤权/外置 authority。安装不修改真实 Host，禁用新合成实例不影响生产。不要运行 legacy `stella:activate` 或 private recovery runner 来接通本实验模式。

## 一次性接入与真实模型小验收前置

确认固定包/hash、Host/Node、独立目录、显式源及所有权、支持的 owner 受众与 retain 策略、初始化/skill 发现及回退备份；先核对状态，再新会话。包只包含显式必要说明 `docs/EXPERIMENTAL-OWNER-CHAT.md` 和 README，四份旧未提交计划/测试不入包。

真实模型小规模验收另需明确批准：Google `gemini-3.8-flash`（low）外部 API/预算与请求上限；使用哪个已有凭据引用且是否允许测试进程读取（不在日志输出）；只发哪些已审阅合成文本到该 provider；独立 Gateway/state 和 conversation hooks 的真实测试范围；如需接入私人源/生产配置、重启或迁移则分别批准。建议先仅合成文本少量同会话请求，逐项看记忆引用与历史区分，不给泛化质量保证。本批不执行任何真实调用。
