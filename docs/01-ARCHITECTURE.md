# Stella 3.0 Architecture

Current authority and acceptance: [design baseline](10-DESIGN-BASELINE.md). Data formats and the complete memory flow are defined by [Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md) and [Portable Registries](contracts/PORTABLE-REGISTRIES.md).

## 1. System view

```text
                         ┌──────────────────────┐
                         │    Personal Twin     │
                         │  how the owner works │
                         └──────────┬───────────┘
                                    │
                                    ▼
┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ Framework Compiler  │──▶│     Praxis Loop      │◀──│ Reality / Social    │
│ how the owner judges│   │ what to do in reality│   │ how the world works │
└─────────────────────┘   └──────────┬───────────┘   └─────────────────────┘
                                    │
                                    ▼
                              Action / Outcome
                                    │
                                    ▼
                            Continuous Learning
```

## 2. Runtime architecture

Stella 3.0 uses one OpenClaw runtime plugin, `stella-core`; Cortex names its shared cognitive architecture.

```text
OpenClaw Agent Loop
        │
        ▼
┌──────────────────────────────────────────┐
│              Stella Cortex              │
│                                          │
│ Turn Router                              │
│ Situation Builder                        │
│ Twin Context Builder                     │
│ Framework Runtime                        │
│ Reality Intelligence                     │
│ Praxis Controller                        │
│ Learning Recorder / Consolidator         │
└───────────────────┬──────────────────────┘
                    │
         ┌──────────┼────────────┐
         ▼          ▼            ▼
      CangHai   OpenClaw Memory  External Reality
```

OpenClaw remains responsible for the generic agent loop, sessions, transcripts, compaction, tool execution, channels, automations, permissions, and low-level memory infrastructure.

Stella Cortex owns the personal cognitive behavior layered on top.

## 3. Consciousness portability invariant

Stella Core is a replaceable runtime implementation. CangHai is the portable carrier of Stella's durable personal consciousness.

The required recovery property is:

```text
fresh server
+ compatible OpenClaw
+ Stella Core
+ CangHai personal data and Stella configuration
→ rebuild indexes / projections / runtime caches
→ restore Stella's core consciousness
```

Recovery does **not** require old OpenClaw sessions, transcripts, SQLite runtime databases, prompt caches, or other machine-local execution state.

“Core consciousness” means the durable information that changes how a fresh Stella instance understands the owner, reasons from the owner's frameworks, predicts behavior, and applies learned praxis. It includes at least:

- identity/persona and stable interaction configuration;
- owner-authored frameworks and the exact active operational representation when needed for reproducibility;
- durable Twin hypotheses and model state;
- durable relationship/interaction models;
- Praxis episodes, outcomes, learned strategies, and open high-value episodes that should survive a restart;
- durable goals, commitments, or state that materially affects future behavior;
- Stella-specific runtime profile/configuration required to reconstruct the same cognitive behavior.

Transient working context is not part of core consciousness. Examples include:

- active chat sessions and raw conversational continuity that has not been promoted to durable personal data;
- prompt assembly state;
- temporary inferred mood/state estimates;
- FTS/vector indexes and reproducible embeddings;
- execution traces and temporary subagent results.

The architecture must be tested against destructive runtime loss: deleting the Stella/OpenClaw runtime host must not destroy any durable learning that is necessary to reconstruct Stella's identity and learned behavior.

## 4. Data planes

### Stella-Core

Public runtime, schemas, compiler logic, evaluation harness, and architecture.

It must contain no copied private personal corpus.

### CangHai

Portable Personal Data Plane and durable consciousness store.

Anything that has durable influence over how Stella understands, predicts, advises, or acts for the owner must have a portable representation in CangHai.

Examples:

- personal experiences;
- framework sources;
- Twin hypotheses;
- important relationship models;
- Praxis episodes and outcomes;
- learned personalized strategies;
- durable goals/open loops that must survive runtime loss;
- Stella instance configuration and portable runtime profile;
- evaluation history and model checkpoints when portability requires them.

### OpenClaw runtime state

Rebuildable execution state:

- SQLite runtime state;
- search indexes;
- FTS/vector indexes;
- embeddings where reproducible;
- prompt state;
- temporary inferred state;
- execution traces;
- active sessions.

These do not automatically belong in CangHai.

## 5. Four cognitive systems

### Personal Twin

Maintains context-relevant hypotheses and predictions rather than a static biography.

It eventually includes:

- stable self;
- contextual selves;
- dynamic state estimation;
- behavioral policy;
- prediction ledger.

Alpha does not require fine-tuning. Retrieval + structured hypotheses + prediction/outcome data are sufficient.

Writing support is one use of this personal context: understand what the owner wants to express,
retrieve relevant saved ideas and material, and help organize a coherent path into writing even
before a draft exists. Adapt the collaboration to feedback about actual sticking points and useful
help. Existing article work is recovered from its proposal, outline, draft, related material, and
available intent or revision-feedback notes before asking the owner to repeat saved context.
Unpublished work must be accessible for this purpose even when it is outside the legacy registered
corpora; retrieval does not publish it. File status alone does not establish the owner's reason for
stopping or acceptance of drafted text. Editing an existing draft alone does not satisfy this
requirement, and an idea-organization request does not by itself request a complete generated article.
Support also covers resuming an argument that stalls midway and finding an ending connected to
the article's intended meaning. Proposed conclusions remain candidates until the owner accepts them;
they are not evidence of the owner's existing views. Owner clarification revises the interpretation;
unresolved questions remain open rather than receiving a default positive or motivational ending.
Argument checks distinguish facts, analogies, inferences, and values without substituting the
assistant's preferred meaning. The owner has confirmed the collaboration pattern: recover saved
context, understand authorial premises, check argument connections, reason together through specific
sticking points, incorporate corrections, and organize a path the owner can continue writing.
Clarification and synthesis can alternate without requiring a fully settled argument upfront.
This uses the shared Cortex and memory responsibilities. Approval of the collaboration does not
establish article completion or acceptance of every proposed conclusion. See [the writing support requirement](09-REQUIREMENTS-ALIGNMENT.md#12-写作思路梳理已确认).

### Framework Compiler

Compiles owner-authored thinking frameworks into executable operators.

Separates:

1. canonical framework source;
2. derived Framework IR;
3. learned Praxis notes about applying the framework.

Stella may proactively challenge a framework with specific evidence, explain its applicability
limits, and propose revisions while distinguishing factual understanding from value tradeoffs.
The owner decides formal changes. Proposals stay separate from canonical source and active IR
until adopted; see [the Framework IR contract](contracts/FRAMEWORK-IR.md#8-praxis-feedback).

### Reality / Social Intelligence

Combines three sources:

1. base-model world knowledge;
2. live external grounding where current/specific facts matter;
3. personalized Praxis experience accumulated from real outcomes.

Its purpose is to supply experience the owner does not yet have, not to redefine the owner's values.

Social judgment is invoked when the owner asks for help and combines original interaction evidence
over time with relevant personal context. It retrieves saved background and current evidence for
that request; it does not proactively follow relationships or send unsolicited relationship updates.
It assesses reciprocity, initiative, substantive responses, follow-through, and changes in investment,
then relates that assessment to the owner's expectations and plans through Twin and Praxis. Age,
life stage, personality, and roles provide context; labels do not establish motives or override
contrary behavioral evidence. Courtesy and interest in a topic do not establish sustained relational
investment. Advice must make unsupported expectations and investment risks clear, with practical
options and uncertainty proportionate to the evidence. See [the confirmed social judgment requirement](09-REQUIREMENTS-ALIGNMENT.md#52-综合判断社交状态校准投入与预期已确认).

It also supports autonomous learning around the owner's actual questions and long-term goals:
identify a knowledge or experience gap, research within existing access permissions, relate findings
to personal context, and retain useful source material in CangHai with its relevance and potential
decision use. Source selection requires structured semantic judgment under the repository invariants.
Retained external material remains external evidence; it does not become a fact about the owner.

### Praxis Loop

The primary product loop:

```text
Situation
→ Twin
→ Framework
→ Reality
→ option simulation
→ action/advice
→ outcome
→ learning
```

Autonomous research feeds this loop through better advice, questions, and candidate strategies.
Owner choices, explanations, rejection reasons, and actual outcomes then help assess applicability
and update personal understanding. Durable research can therefore support later situations as well
as the immediate request. This is a product requirement; collection volume and automated scores do
not establish its real usefulness, which is judged through owner feedback in use.

The full Praxis product can also execute work under explicit owner delegation. Repeated actions
within an authorized matter or class of work proceed without renewed confirmation; out-of-scope
decisions return to the owner. OpenClaw provides execution, scheduling, and permission facilities.
Learning from acceptance improves judgment but does not expand authority. The current Alpha remains
advice/preparation only.

## 6. Why one Cortex instead of four agents

Persistent independent agents would each develop partial views of the owner and create coordination drift.

The four systems instead share one turn context and one owner model. Temporary subagents are allowed only for bounded work such as:

- external reality research;
- multi-perspective simulation;
- deep cross-session recall.

Subagents receive the minimum brief required for their task rather than the full Personal Twin.

## 7. Memory responsibilities across the two confirmed scenarios

The current requirements round uses on-request social judgment and collaborative writing to examine
the shared architecture. These are representative scenarios, not a reduction of the full product
to two features or a change to the current Alpha release scope. The implementation evidence is
recorded separately in [the requirements audit](09-REQUIREMENTS-ALIGNMENT.md#96-两个场景收敛后的实现复核).

### Storage roles

The same memory needs to preserve several kinds of information without forcing them into one schema:

| Logical role | Social judgment | Collaborative writing | Persistence responsibility |
| --- | --- | --- | --- |
| Original evidence | Messages, attachments and later owner reports | Proposals, drafts, references and discussion | Preserve originals in CangHai with source identity and time; reuse Host recording and archive facilities |
| Facts and observations | Who did what, when, and in which context | Existing text, explicit author statements and recorded revisions | Distinguish direct observation, reported information and model interpretation at content level |
| Revisable understanding | Relationship-state hypotheses and supporting or contrary evidence | Interpretation of author intent, candidate arguments and detected gaps | Preserve scope and dependencies; model suggestions are not automatically owner beliefs |
| Durable context for ongoing work | Current question, relevant history, unresolved uncertainty and prior corrections | Confirmed premises, rejected interpretations, open reasoning and current writing position | Use CangHai durable-state/open-work responsibilities; do not require a closed action Episode to retain progress |
| Retrieval views | Search indexes, summaries and situation projections | Search indexes, article-context projections and material links | Rebuild from current valid sources and reconcile source changes |

The ongoing-work row is a logical responsibility within the existing Cortex and data plane, not a
new persistent agent or a second session database. Reuse existing article context files and Host
state where their contracts fit. OngoingWork serialization, LearningChange and synchronization follow
the Memory Lifecycle contract. Full conversation retention supplies evidence; resuming work also requires finding the
relevant current state without repeating already-resolved questions.

### Inputs and coverage

All confirmed input routes must feed the same provenance and update responsibilities: daily
conversation, explicit recording, imports and attachments, direct repository edits, and authorized
external material. An ingestion path must make its actual coverage and failures visible. A file
being present, a corpus registry being valid, and content being retrievable are separate properties.

Writing makes the legacy coverage gap concrete: in-flight articles and their companion files must
be usable even though they are outside the old unified corpus. Supporting them does not require
moving originals into a new directory or changing their publication status. Social judgment
similarly needs original interaction evidence, not only a person's curated profile.

### Evidence retrieval and response

The shared cognitive process is:

```text
Owner request
→ recover relevant current context and source availability
→ plan and perform Host searches / original-source reads
→ follow material leads, check counterevidence and reconcile time / identity / provenance
→ clarify unresolved information that could change the answer
→ produce the situation-appropriate judgment or writing collaboration
→ incorporate owner feedback and preserve the resulting context
```

Stella supplies semantic planning and evidence judgment; OpenClaw supplies the applicable file,
search, session, model and execution infrastructure. Keep those responsibilities separate from
the selected Host adapters. The versioned integration seams and remaining proof obligations are in
[OpenClaw integration](04-OPENCLAW-INTEGRATION.md); API availability alone is not completion evidence.

A compact response or context projection comes after sufficient evidence work. Candidate-count
limits, prompt size and a convenient number of retrieved items do not establish sufficiency. The
retrieval contract requires an explicit stopping judgment: material claims have support or visible
uncertainty, relevant available contrary or newer evidence has been checked, and no known unresolved
lead is being dropped merely to meet a small packet budget. Missing material facts call for
clarification; unavailable sources and resource failures remain diagnosable failures, not findings
that evidence does not exist.

### Learning during an unfinished interaction

An owner clarification can change the applicable understanding before any external action or final
outcome exists. Apply it in the current context, retain its original evidence, and reconcile affected
durable understanding. A broader personal hypothesis remains subject to scope and further evidence.
Repeated summaries of the same correction must not create independent support.

Decision/action Episodes keep their prediction and outcome guarantees. Writing collaboration and
other ongoing reasoning must also preserve progress without inventing an action, prediction or
closure solely to fit that lifecycle. Approval of helpful collaboration does not imply agreement
with every suggested claim or a completed article. Social judgment remains owner-triggered; a need
for better evidence does not authorize proactive relationship follow-up.

These responsibilities extend the full-product design. They are not claims that the current
candidate selection, Episode learning or recovery tests already satisfy the two complete scenarios.

## 8. 2026-10-27 Host-first memory评估基线

本节保留 [D-061](DECISIONS.md#d-061--host-first-memory-infrastructure-with-behavior-gates-before-replacement) 的2026-10-27对照及替换条件；2026-10-28由 [D-062](DECISIONS.md#d-062--one-native-provider-path-and-one-semantic-writer) 收敛为“公开 native provider + 薄 Stella 语义层 + 现有单一纠正 writer”一条研发主线。不是生产切换或 full_memory 通过声明。详细执行依赖、go/no-go、工程证据与历史 Issue 映射只维护在 [Host 集成 §9](04-OPENCLAW-INTEGRATION.md#9-2026107-分阶段实施与验收计划)，数据格式和产品退出条件仍由既有契约维护。

### 8.1 固定版本与证据层

下表及“已验证”段是2026-10-27既有部署快照；后续临时验收不覆盖或改写其配置状态。

| 对象 | 本次固定身份 | 证据范围 |
| --- | --- | --- |
| Host | 官方 npm `openclaw@2026.10.7`，运行 build `157d8c2`；[同版本 release](https://github.com/openclaw/openclaw/releases/tag/v2026.10.7) | 已安装、Gateway/RPC 可用；不把 CLI 启动或插件注册当产品验收 |
| Core | `57c84c976f52c36633ce26793c01a909b5f86c1f` 加未提交的10.7兼容 diff；已集成产物 SHA-256 `4780a19694952245d9531f01cec58e6f0932abf95cb3fd1c2ee5295265914dff` | `sourceClean:false`；后续文档修改不属于该既有产物，不能当最终冻结版本 |
| 当前显式消费源 | `112be540a3988af53d1076a38f8f1c155da7a745`，独立的 migration-v1 副本 | 保留既有 checkpoint、grant 和消费指针；不跟随生产 `dev` 或开发 HEAD |
| 沧海迁移开发 | `2ea285d98d21c0882092582141aac92f93fa432a` | 生产者代码核查基线，不等于当前消费源或旧版 Stella 1.0 |

**已验证**：当前 `core_checkpoint + fresh_tools` 的身份13例、checkpoint定向59例、类型检查/9项 schema 与真实 RPC。实际状态仍是 `experimental_owner_chat`、`full_memory:false`；bootstrap、完整语义 writers、完整 transcript 缺口仍在，`ownerCorrectionTool:false` 未改变。59例的模型端口使用合成桩，13例使用安装中真实 Host caller helper 构造合成上下文。完整范围、历史超时及37失败见[兼容记录](OPENCLAW-2026.10.7-COMPATIBILITY.md)。

**当时静态已确认**：10.7 的公开 `providerRuntime`、`providerFlushPlanResolver`、caller authority、audience 和带版本引用存在；读取、flush 和实际消费者各有独立限制。依据固定 tag 的 [memory/context SDK](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/plugins/sdk-overview/memory-and-context.md)、[注册类型](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/plugins/registry-contribution-types.ts)、[provider 类型](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/plugins/memory-provider-types.ts)。2026-10-27时尚无该轮 native provider 端到端成功证据。

**2026-10-28临时工程验收增量**：C5在同一真实10.7 Gateway/CLI会话中完成两请求，原生 audience、历史归属、新绑定、一次纠正提交和两次相同版本 native 回读成立；C6在有效 owner/audience 下实际进入 native get，并在来源 read 边界拒绝，受保护正文/释放与业务写入/CAS均为零。版本、计数、哈希和失败保留见 [集成 §9.7](04-OPENCLAW-INTEGRATION.md#97-c5c6-已验收工程事实2026-10-28)。均仅临时合成资料与固定本地协议桩，不改变上表部署或 `ownerCorrectionTool:false` / `full_memory:false`。

**待实测**：真实模型作者原意与语义效果；Chrome/profile；搜索/分页/自动注入等其他消费者、flush；Host capability 撤销；完整语义资产迁移、完整恢复及 full_memory。运行中追溯撤回按D-058不列主线门槛。Knowledge 尚未在10.7固定发布包验证，不能用 main 代码补齐这列。

### 8.2 唯一权威与三方职责

| 内容 | 权威与写者 | 其他位置的地位 |
| --- | --- | --- |
| 原始资料、附件、作者原文及原始交互证据 | 沧海按既有格式完整留存；明确接入/归档 writer | Host transcript 是执行原事件来源；导出范围与归档 coverage 可核验，不复制一套会话执行数据库 |
| Current Understanding、Ongoing Work、Learning Change、重要 Historical Trace、已激活精确 Framework IR | 沧海保存可迁移版本；每类资产只有一个声明的领域 writer，由 Stella 语义判断驱动 | Host memory 不独立创造另一份同名真相，助手推断不变成 owner 原话或信念 |
| 目录、FTS/vector、候选排序、摘要、USER/MEMORY 等 Host Projection | 优先官方基础设施；从有效源及 generation 重建 | 可以缓存、索引或丢弃重建，不是语义权威；投影丢失不能丢失必要学习 |
| admission、处理许可、来源用途/受众 | Host 可信调用事实与现有 Core 来源规则取交集 | operator/admin、owner-private audience、设备、自然人 profile 和 processing grant 不能互相替代 |
| 被选择的源 revision/并发提交 | 当前 D-059 小型 checkpoint 与单写者/CAS | 不是全量记忆库、通用事务平台或额外身份账本；未来可替换实现但必须保留等价提交行为 |

同一语义资产不能由官方 Dreaming/file flush 和 Core learning 各写一份权威再互相导入。对每个 writer 先声明资产种类、可变路径、来源/版本、operation ID、commit/readback 和恢复责任。官方文件若仅为 projection，必须可从沧海重建并阻止被重新导入为独立证据；若要升格为权威原件，必须先建立唯一写者和完整迁移方案。既有 Dreaming、频道及 cron 停用状态不因本设计改变。

### 8.3 对照路线及否决条件

以下表格保留2026-10-27选型时的比较，不能继续解释为必须平行完成两套系统。

| 路线 | 可复用部分与 Stella 增量 | 必须先证实的缺口 | 2026-10-27当时决定 |
| --- | --- | --- | --- |
| A：官方 memory + 薄 Stella | 官方存储/索引/通用读取；Stella 作有来源的个人理解、语义取证、纠正及领域写入，必要时用 supplement 或正式工具连接沧海 | supplement 只有 query/agent/session/sandbox，缺少 native caller capability；必须有公开且可验证的现有请求授权接缝，否则拒绝该私有读取。内置结果和自动注入也不能绕过来源资格；必须证明 flush/纠正写者不双写 | 优先建立对照基线，但尚未判定可满足完整契约 |
| B：定制 native provider | 通过10.7 `providerRuntime` 接入沧海记录，复用 Host memory 消费者与生命周期；Stella 保留领域语义和写入工具 | 必须验证公开注册/真实加载、caller/audience、分页与版本引用、每种已声明消费者、工具型 flush 和 readback。中性 read API 没有通用领域 mutation；不能据此宣称学习已经实现 | 与 A 用同一用例和成本口径比较，不预先占用 Stella memory slot |
| C：官方 Knowledge + Stella 语义层 | 若固定发行版提供完整能力，可评估图谱/知识组织等官方机制 | 10.7包中尚未验证其发布、SDK 与迁移/权限/写入契约；不能混用 main 和 release | 仅候选；进入比较前先固定实际发行版本和可运行证据 |

A 的 supplement 不能从 session-key 模式、全局缓存或任意 ID 推造授权；若公开接口不能保持现有信任，A 此接缝 no-go，改评正式工具或 B，不能放宽 grant。B 中 session 无合法 audience、跨 agent audience、host status 调用都不自动获得私人数据；operator 的状态查询与私人原文读取分开。

只有选中的 memory slot owner 可以提供 tools-arm `providerFlushPlanResolver`。因此 A 下的 Stella supplement 不能假定自己能替官方 slot 定义 flush。A 要分别验证：正常领域纠正工具作为唯一 writer，以及官方 file flush 被关闭或仅写可重建投影的明确方案。后者必须证明不会独立学习或回流为权威。B 可以评估所选 owner 的工具型 flush，但不能凭 SDK 字段存在直接切 slot。

当时选型顺序是：同等身份/权限、原件与引用、纠正/依赖失效、持久化/恢复全部满足，再比较语义效果、调用/字节/成本和维护面；A满足时优先较薄实现。该完整A/B选型前置由D-062收敛：现在沿已验证的公开 native get、薄语义适配和现有 writer 继续有限研发，尚未覆盖的能力仍逐项设门槛。仅因具体SDK新接缝或已测契约/维护/成本瓶颈重开局部比较；不并行建设完整A/B，不宣称A（包括公开无敏感索引加受控私有工具）全面不可行或B整体更优。

### 8.4 读取、纠正与更新闭环

1. 新用户请求从可信 Host 身份确定 caller、受众、处理目的/模型与当前选定来源 revision/generation；来源策略继续生效。工具续轮沿用这一请求边界，下一用户请求重新准入。旧历史可作为过去对话，不是当前事实或许可凭据。
2. 候选发现优先复用官方检索/索引；Stella 用结构化 LLM 判断相关性、证据角色、更新/反证和继续检索的必要性。确定性代码只做结构、权限、容量和执行校验；不以词面打分代替语义，不用小 top-K 宣称证据充分。
3. 每次首次供给读取当前合法的精确原件/片段，返回可定位的 Source Version、Evidence、内容 hash/范围和覆盖状态。provider 的 `providerId/id/revision/fragment` 需明确映射到既有引用；缺 revision 时不能自行解释为最新，引用不授予读取权。分页 cursor 绑定集合/版本；过期和部分失败不能当空结果。细粒度策略拒绝的片段不能靠同文件其他许可放行。
4. 用户纠正先保留 owner 原证据；区分修正事实、作者意图、情境假设、未采纳候选和长期偏好。只修改其适用范围；保留原预测/历史判断以及支持与反证依赖，同一纠正的重复摘要不增加支持。
5. 用现有单写者事务写入语义新版本、Learning Change、相关依赖失效和必要投影迁移；固定 expected revision/token、operation ID 和变更 bytes，提交后 CAS。同一操作重试只在原 journal/bytes/来源资格仍合法时回读或续完原结果，冲突显式失败，不把 observed HEAD 换成 expected。模型判断成功、Git commit、checkpoint CAS、projection 发布、远端同步分别观察。
6. 保存结果必须有 operation/revision/object-version 绑定的 mutation receipt，并在重新打开 reader 后 readback。仅 `NO_REPLY`、flush 标记成功或 lookup 成功不算领域持久化；延迟回调不能补造成功。`local_committed` 与 remote_pending/synchronized/RPO 分开。
7. 当前事项必要纠正已同步、依赖已有效、全部受影响旧理解已禁止新供给后，可以继续当前协作；其他事项分批重评。当前实现仍是整批重评后发布，不能写成已支持 D-056 的中间代。任何依赖 pending 部分的结论显式等待/未完成。
8. 下一请求、新会话和重启重新读取当前资格及新版本；源编辑/删除、撤权与更新必须使旧索引、摘要、投影和依赖失效，不能从历史自动复活。Host 过去对话仍保留其历史身份，不承诺追溯抹除本轮已合法供给的内容。

保留正常取消和 SDK 生命周期：Host audience 撤销不保证触发 `context.signal`，provider 在自己的 await 之后、每个副作用之前调用 `assertCurrent()`。这是 SDK capability 使用规则；不另建实时内容撤回代理或输出缓冲，也不把普通 source 更新当作取消已合法供给的同轮协作。新增读取/写入仍检查其必要资格，下一请求必须 freshness。

“遗忘/衰减”遵守既有产品边界：不新增自然语言事件遗忘入口；用户物理编辑/删除原件后做索引与依赖同步。可评估暂时假设、检索优先级和待重评状态的变化，不能按年龄自动把事实变假、删除原件/学习、失效稳定偏好或改变授权。是否适用需要语义判断；历史证据、重要修订和未采纳内容保持可区分。

### 8.5 当前实现的保留、替换与删除候选

下表固定必要行为及替换条件，不要求全面移植旧基础设施，也不授权删除旧生产路径。小型 checkpoint/CAS 和单写者保留其保证；能力清单不是十二个自建服务清单。

| 当前模块/保证 | 处理方向 | 替换或删除的必要条件 |
| --- | --- | --- |
| guarded 模型包装 | 旧严格最终消费/输出保护的实现候选退役；D-058 已取消实时撤回主线 | admission、首次来源/模型许可、正常取消、来源/推断区分和下一请求 freshness 有新路径证据；不要求复刻已取消的输出缓冲 |
| 旧 Context Engine | 不为10.7迁移而默认保留 | 使用标准 Host 上下文/公开 memory 接缝验证角色、来源、最终消费及旧历史地位。Context Engine 普通错误可 quarantine/fallback，不能独自承担必须 fail-closed 的权限边界 |
| native SQLite 桥接 | 优先以公开 provider/search/get 接缝替换 | 原件/片段、provenance、索引就绪/缺失、源修改和精确版本仍可验证；不能以旧私有表 schema 作为新设计前提 |
| 小型 checkpoint、archive custody、CAS 与单写者 | 暂保留当前有效保证，非永久底座选择 | 只有替代机制证明原 expected tuple、幂等重放、完整 bytes、失败恢复和 portable source 选择等价，才删除原实现 |
| 现有 LLM 分页全库选择 | 保留语义判断，重做发现/候选成本实验 | 官方搜索候选不丢关键反证/新证据；失败、预算耗尽和证据充分性显式表达，不能改成关键词路由或固定小包 |
| 原话归档与语义 writers | 复用契约，分别补齐覆盖 | owner-input `local_committed` 不等于完整 user/assistant/tool/media transcript；correction 模块局部可用不等于全部 writers 已迁移 |

如果比较后仍选择自定义 Context Engine，还需独立验证10.7的 admitted-turn fence、atomic-idempotent turn advancement 与 `commitTurn` 契约，不能将旧实现注册成功当作耐久回合支持；依据[固定版本 registry](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/context-engine/registry.ts)。这不是要求为有限 checkpoint 路径新增 Context Engine。

代码依据：`plugin.ts:256–260` checkpoint 提前返回且10.7拒绝 legacy；[host-memory-provider.ts](../src/openclaw/host-memory-provider.ts) 注册的是 **模型 provider** `stella-guarded`，不能由文件名误判为 memory provider；[checkpoint-agent-supply.ts](../src/openclaw/checkpoint-agent-supply.ts) 当前 list 分页后逐项调用 original，再截取 preview，已经发生授权原文读取，**不是廉价 descriptor 枚举**；[semantic-retrieval.ts](../src/canghai/semantic-retrieval.ts) 的多轮分页/容量是实现边界；[correction.ts](../src/learning/correction.ts) 保有证据、范围、依赖闭包、新版本与事务；[recovery-checkpoint-store.ts](../src/canghai/recovery-checkpoint-store.ts)、[checkpoint-archive.ts](../src/canghai/checkpoint-archive.ts) 保有小型 authority/CAS 和精确原件 custody。模块名不是运行路径或完成证据。

迁移开发基线的 `99_System/Scripts/knowledge-migration/materialize.mjs:32` 对非空 `understandings/works/changes/bundles` 返回 `derived_objects_require_explicit_reassessment`；它目前不是完整语义资产迁移器。不得通过清空集合、丢失 Learning Change/依赖、重新编译代替精确 IR、重标助手推断为 owner 事实来取得成功。完整迁移先交接引用映射、历史/当前状态、策略、附件、依赖、精确活跃 IR 和唯一 writer，再验非空恢复；当前源和生产 `dev` 保持不动。
