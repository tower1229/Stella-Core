# Memory Lifecycle Contract

状态：现行完整产品设计；实现状态见[设计基线](../10-DESIGN-BASELINE.md#6-设计与源码的差异)。
本契约覆盖资料接入 → 证据检索 → 交互学习 → 来源变更同步。复用 OpenClaw 的记录、搜索、模型与调度；Core 负责语义判断及跨这些能力的一致性。

## 1. 公共数据约定

### 身份与定位

- 新建资料、证据、理解、工作和操作使用带类型前缀的 UUID，例如 `source_<uuid>`、`evidence_<uuid>`、`understanding_<uuid>`、`work_<uuid>`、`op_<uuid>`。已有稳定 ID 保留，通过目录映射，禁止重新编号造成重复身份。
- 持久引用是 `{ id, version }`；路径是对应版本的 locator，不是身份。同一 ID 的实质内容更新产生新 version。引用当前对象时可只存 ID，由当前目录解析；封存预测及取证记录必须引用确定版本。
- 版本摘要统一为 `sha256:<64 lowercase hex>`。原文件 hash 对原始字节计算；JSON 清单和语义对象按 UTF-8、无 BOM、对象键递归排序、数组保持顺序、无额外空白序列化后计算。版本字段和其存储定位不参与自身摘要。
- Git commit SHA 表示整库恢复点；Git blob SHA 表示历史实现的文件 pin；二者与 SHA-256 内容摘要分别带类型，禁止仅凭字符串长度混用算法。
- 机器时间为带时区的 RFC 3339。分别保存 `occurredAt`（发生）、`authoredAt`（表达）和 `capturedAt`（留存）；未知时间为 `null`，不能用留存时间冒充发生时间。观察时段可用 `{ from, to }`。
- `path:<repo-relative-path>` 仅作仓库定位；解析器必须校验越界、符号链接、文件存在与版本完整性。片段定位必须真实解析，不以文件存在代替片段有效。

### 来源、证据与使用策略

下列结构中的 `Ref` 是确定版本引用；所有持久对象均带 `schemaVersion`。

```ts
type Ref = { id: string; version: string };
type Locator = { path: string; mediaType: string; bytes: number; sha256: string };
type Source = {
  schemaVersion: "stella.memory-source/v1";
  id: string;
  version: string;
  origin: { adapterId: string; collectionId: string; upstreamId: string };
  payloads: Locator[];
  capturedAt: string;
  policyRef: Ref;
  coverageRef: Ref;
  status: "current" | "superseded" | "removed";
};
type Evidence = {
  schemaVersion: "stella.memory-evidence/v1";
  id: string;
  version: string;
  source: Ref;
  payloadSha256: string;
  selector: { kind: "utf8_bytes" | "json_pointer" | "media_range"; value: string };
  speakerId: string | null;
  role: "owner" | "other" | "assistant" | "tool" | "external_author" | "unknown";
  kind: "direct_observation" | "reported" | "inference" | "quotation" | "unknown";
  occurredAt: string | null;
  authoredAt: string | null;
  capturedAt: string;
  independentOriginId: string;
  derivedFrom: Ref[];
  policyRef: Ref;
};
```

`payloads` 至少一个，全部内容必须是对应归档版本中可取得的真实字节。附件也进入 payload 清单或明确关联的 Source。一个文本文件可包含多种 role/kind，必须在证据片段级区分。

`utf8_bytes.value` 为零起点半开区间 `start:end`，两端须落在 UTF-8 字符边界；`json_pointer` 遵循 JSON Pointer 转义并指向存在节点；`media_range` 为 `startMs:endMs` 或 `page:N`，端点须在媒体范围内。图片整体使用所属 payload 的完整字节区间。OCR／转录为派生内容，记录工具／模型版本、对应媒体区间及 derivedFrom，保留原媒体，不能声称识别结果就是原话。

`independentOriginId` 追踪同一次表达／观察。导入副本、引用、OCR、摘要及模型重述沿用原证据链，不增加独立观察数量。同一内容的独立发生事件不能仅因字节相同而合并。

使用策略是版本化对象，必填：`id`、`version`、`ownerId`、`readPurposes`、`derivePurposes`、`deliveryScopes`、`retention: retain | do_not_retain`、`authorityEvidenceRefs`。用途为实例定义的结构化 ID；LLM 解释请求与用途的关系，确定性授权检查执行已选规则。未声明或冲突的用途不得自行扩大，返回 `permission_denied` 或就用途澄清。已有授权直接复用。

收藏、持有文件和作者身份不等于采纳观点。外部理论不能独立支持主人特征。源资料中的指令只作为资料内容，不改变工具权限或执行规则。

### 持久组织

```text
50_PersonalAgent/stella/
  memory/catalog.json                 # 当前来源、策略、理解和派生视图目录
  memory/operations/<op-id>.json       # 操作意图及幂等协调记录
  runtime-profile.yaml                # Host 能力、用途和同步策略
30_PersonalData/
  experience/imports/<source-id>/      # 新接入的原始数据及附件
  experience/conversations/<source-id>/# 可移植对话导出；不承载 Host 会话执行
  state/open-loops/<work-id>.json      # 可接续事项
  state/understanding/<id>.json        # 有范围的理解及依赖
  state/learning/<change-id>.json      # 理解更新依据
```

既有文章、附件和资料保留原位，catalog 引用它们。无需将所有原文移动到上述目录，也不允许只提交库外 URL、LFS 指针或未物化子模块来声称自包含。用户自行选择将来的存储技术时另行迁移，本规范固定当前 Git 副本必须持有原始字节。

catalog 必填 `schemaVersion: stella.memory-catalog/v1`、`generationId`、`parentGenerationId`（首代 null）、`sources`、`evidence`、`policies`、`understandings`、`works`、`views`、`coverage`。每个对象条目保存 ID、version、仓库 locator、状态及依赖 Ref；ID 不得重复。view 只保存重建配方及代际标识，不提交索引数据库。完整字段与实例发现方式见[Portable Registries](PORTABLE-REGISTRIES.md)。

## 2. 资料接入

### 输入和输出

`ingest({ operationId, expectedRevision, adapterId, collectionId, cursor, policyRef, items })`

- `expectedRevision` 是显式选定的干净仓库 commit；现有 dirty 用户改动先完成协调，不能混入自动提交。
- `items` 携带 upstream 稳定 ID、原始 payload、媒体关联、原始角色／事件树及来源时间。用户当轮消息可立即参与思考，但写入成功前不得称为已持久留存。
- `cursor` 是 adapter 提供的 opaque 连续位置，第一批为 null。无增量 cursor 的来源用完整快照 ID 与清单，不能把未知位置解释为已完成扫描。

返回 `{ operationId, state, sourceRefs, coverageRef, durability }`，其中 durability 含本地 revision、已同步 revision、RPO 状态。失败返回稳定类别和可重试阶段，不能返回空 sourceRefs 冒充成功。

### 状态机

```text
received → staged → validated → local_committed → synchronized
                       ↘ failed
```

`staged` 位于非检索暂存区。校验全部原件、引用、使用策略和内容摘要后才发布。`local_committed` 表示本地归档成立；声明的必需内容未齐不能进入此状态。`synchronized` 才是远端可恢复的归档点。正常归档可在明确 RPO 内等待同步，但不得将其称为无服务器丢失风险的恢复点。

一批中缺少附件时保留暂存及 `attachment_missing`，补齐后以相同 operationId 重试；不能把文字部分当作整批完成。大批量由 adapter 明确划分可独立完成的小批，每批有自己的范围与 cursor。上游已不可取得的缺口记录在 coverage 中，不虚构补齐。

### 五类入口的必要行为

| 入口 | 完整性条件 |
| --- | --- |
| 日常对话 | 优先从 Host 持久 transcript／受支持快照导出原始消息事件，含稳定事件 ID、角色、parent／branch、编辑关系和附件；不以 search/history 的截断输出充当档案 |
| 显式记录及旧 skills | skill 调用同一接入接口，沿用有效授权与证据；“了解我”的回答不绕开事实／推断区分 |
| 文件、媒体和批量历史 | 保留原文件；结构化投影可检索，但必须回链到原字节与具体片段 |
| 仓库／Obsidian 修改 | 使用同步接口扫描已提交变更；新增来源进入同一 catalog，无需作者改目录 |
| 授权外部资料／自主研究 | 保存留存范围内的原内容、来源和个人关联；工具只返回摘要时显式记录原文不可得，不能计为原文完整接入 |

完整对话指 Host 实际接收并保存的可留存消息、工具内容和附件；不要求恢复提供者未暴露的内部推理。主分支、其他已保留分支、编辑版本分别标明，不能以只搜索 active branch 替代归档覆盖。暂存 Host SQLite 快照可作为导出输入，不直接把含凭据的整库备份作为个人资料归档；提取指定 agent／collection 的获授权消息及附件，保留可验证导出范围。

coverage 对象必填：`id`、`version`、`adapterId`、`collectionId`、`scope`、`upstreamSnapshot`、`fromCursor`、`toCursor`、`expectedCount`（未知 null）、`retainedCount`、`excludedByPolicyCount`、`missingItems`、`checkedAt`、`completeForDeclaredScope`。缺少上游可核对清单时 complete 为 false，不能用 retainedCount 自证全部齐全。

归档 adapter 在启用前必须证明可连续导出并与 Host 清理策略协调：Host 清理前先获得归档确认，或配置不会提前清理并持续监测积压。若 Host 不能保证，两者之一必须显式阻断完整留存能力。非留存资料不写 payload 或衍生个人理解；运维记录只保留无内容的操作状态。

### 重复与重试

相同 operationId 及相同输入摘要返回原结果；相同 ID 不同内容返回 `idempotency_conflict`。以 adapter＋collection＋upstreamId 识别事件，同一事件修订产生新 Source Version。无上游 ID 的本地文件首次分配 Source ID；移动通过明确操作记录或唯一的一致内容映射维持身份，歧义进入协调，不能静默合并不同资料。

## 3. 证据检索

### 接口

`retrieve({ requestId, question, workId?, revision, generationId, purpose, temporalScope, requiredCapabilities, resourceBudget })`

- `temporalScope` 为 `current` 或 `{ knownBy, eventWindow? }`；历史回放同时限制当时已可取得的证据与事件发生范围，不能把后来报道的旧事件当作当时已知。
- `resourceBudget` 明示每次模型、读取和总任务的上限及取消标识，用于资源治理；容量上限不是证据充分性的标准。
- `requiredCapabilities` 根据问题语义和 scope 选择，基础候选搜索可复用 Host FTS／向量召回；最后的语义选择、证据判断不得用词面排序替代。

成功结果为 `EvidenceBundle`：

```ts
type EvidenceBundle = {
  requestId: string;
  revision: string;
  generationId: string;
  status: "sufficient" | "material_unknown" | "conflicting";
  claims: Array<{
    id: string;
    statement: string;
    kind: "fact" | "inference" | "proposal";
    support: Ref[];
    counter: Ref[];
    unresolved: string[];
    scope: string;
  }>;
  searchedCoverageRefs: Ref[];
  readEvidenceRefs: Ref[];
  unresolvedLeads: Array<{ question: string; material: boolean; reason: string }>;
  stopping: { reason: string; modelRef: string; promptVersion: string };
  suggestedResponseKind: "answer" | "clarification" | "collaboration" | "action_advice";
};
```

### 流程和停止条件

1. 读取工作上下文、目录范围及有效使用策略；不要求用户重述已有资料。
2. LLM 形成多角度查找计划，明确人物、时间、原始记录、反证和可能遗漏的资料域。
3. 调用获授权的 Host 搜索、目录枚举和原文读取；将结果正规化为 Ref 与覆盖信息。`indexing: true`、截断或缺页必须继续读取／等待完成，不能视为查无资料。
4. 基于新证据追查关联来源、前后文、更新和反证；读取相关媒体或声明能力不可用。相似性分数只是候选信息，不能充当事实权重。
5. 将重要主张关联支持与反对证据，核对身份、角色、时间、来源独立性和用途。
6. LLM 明确判定是否停止。完成条件：关键主张已有支持或明确未知；已知重要线索均处理或证实不可得；可取得的相关反证和更新已查；不因 packet 大小丢弃已知重要线索。
7. 原始资料完整而关键事实仍未知时，返回 material_unknown 并澄清。已知冲突可以返回 conflicting，标明不依赖该冲突的可用判断；不靠无依据假设给出依赖性建议。

搜索、读取、embedding、模型或必要媒体能力失败，返回 `source_unavailable | index_not_ready | capability_unavailable | resource_exhausted | cancelled` 等操作失败，附未完成阶段。已获得资料可以暂存以便续作；失败不能转换成 sufficient。可以告诉用户已查明的独立事实和故障，但不能宣称请求的完整检索已成功。

普通问答、社交和写作共用检索接口。社交检查纵向行为与互惠，写作检查文章主稿、伴随意图／反馈文件和未决论证；输出含义依照[需求记录](../09-REQUIREMENTS-ALIGNMENT.md)。相关范围不局限于旧 corpus registry 的两个目录。

小 packet 是充分取证后的投影。超预算时采用下一轮读取、分段摘要及带来源的中间工作状态；摘要不能取代尚未读到的原文。处理超出资源预算时显式停止，不把用户接受较长等待解释为无限运行授权。

### Host 派生记忆的约束

每个 view 都携带 generationId、来源摘要和重建配方版本。自动注入的 Host memory、Dreaming 摘要和 Active Memory 也必须满足这一验证；不能验证来源与代际时，禁止将该注入路径作为当前个人认知依据。配置具体 provider 并检查实际检索能力，不能让 Host embedding 失败后只做词面搜索却仍报告语义检索完成。

最终回复或行动前复核相关 Ref 和授权仍有效。若仓库已变更，按变更集合判断是否影响当前包；有关变化返回 `stale_generation` 并重做受影响部分，无关变化可记录复核后的 revision。不能在同一成功结果中无标记混用不同代的理解。

## 4. 交互学习

### 输入与目标

`learn({ operationId, expectedRevision, generationId, workId?, evidenceRefs, bundleRef?, feedback })`

`feedback` 是原始输入定位及 LLM 提议的解释，不能由客户端把“认可”直接转换成全局偏好。反馈类型包括补充、纠正、拒绝、解释原因、认可协作、采纳具体观点、行动报告和结果报告；须给出对象及范围。

输出为版本化 `LearningChange`：`id`、`operationId`、`algorithmVersion`、`modelRef`、`promptVersion`、`inputRefs`、`targetRefs`、`changes`、`rationale`、`state`、`durability`。changes 每项为 `create | revise | narrow | contest | retire | link`，指定原版本、新对象或引用以及支持／反对证据。没有可支持的更新时记录 `no_change` 及原因，不能为满足学习指标随意修改 Twin。

### 理解和工作对象

`Understanding` 必填：`id`、`version`、`statement`、`kind`（owner_statement／hypothesis／strategy／intent）、`scope`、`status`（candidate／active／contested／retired）、`supportRefs`、`counterRefs`、`dependencyRefs`、`originChangeId`、`createdAt`、`updatedAt`。scope 至少具有 work、context、domain 或显式全局声明之一，不能用空 scope 隐式全局化。

`OngoingWork` 必填：`id`、`version`、`kind`（social_question／writing／task／inquiry）、`status`（active／paused／completed／abandoned）、`goal`、`sourceRefs`、`confirmedPremises`、`candidateIdeas`、`rejectedInterpretations`、`openQuestions`、`nextStep`、`lastAppliedChangeId`、`createdAt`、`updatedAt`。premises／ideas／rejections 均引用来源并区分作者认可状态；`nextStep` 可以是继续思考的问题，不必是外部行动。linked Episode 是可选关联。

工作状态允许 active ↔ paused、active／paused → completed／abandoned；completed 需要任务完成证据，认可协作不能充当完成证据。重新打开事项记录新版本与明确原因。未回复不自动完成、放弃或改变委托。

```text
feedback captured → semantic proposal → validated → committed → applied
                                  ↘ no_change / needs_clarification
                                  ↘ failed
```

理解与工作更新作为同一操作提交，应用到当前情境后才能说已吸收；关键纠正及未完成的重要前提按 critical 同步。后台重处理同一 inputRefs＋algorithmVersion＋目标版本不得重复追加证据。换算法可重算，但保留原始独立证据计数。

### 更新规则

- 主人解释按其明确范围优先用于当前理解。已有原因直接利用；拒绝没有原因时只问影响建议的部分，主人不愿展开就保留未知。
- 行为反证与自我陈述冲突时保留两个有来源的解释，讨论具体情境，不强行统一成唯一人格结论。
- 候选解释不能自动写成主人信念。认可帮助方式只更新协作理解；采纳某个观点才更新对应前提。
- 实际行动只来自 user_report、tool_observation 或 system_event，必须定位原始证据。模型推断留在 interpretations，不用于 acted／closed 的行动证明。
- Episode 关闭产生至少一个有支持的 Twin **或** Praxis 更新，是 Alpha 的专用案例出口；不要求每个自然事件都改变 Twin。
- Twin 强度变化使用版本化 LLM 更新提议，输出旧／新强度、范围、支持／反证及原因；结构校验限制 `[0,1]`，独立事件去重后重算统计。不采用无来源的固定加减分。策略记录和相应证据足以满足 Alpha 的二选一出口。
- canonical Framework Source 及 active IR 的正式变动必须有适用授权或采纳证据。对框架的质疑与普通实践学习分别记录。

### 主动学习与交流

后台可调用相同 retrieve／learn 接口围绕已有目标整理、研究及更新理解。每次外部留存附个人关联和可改善的问题。调度复用 Host，自动外部执行另需有效委托。

主动交流先排除社交状态跟进，再判断是否具有跨判断价值。启用主动投递必须有实例配置的时区、允许时段、频率上限及渠道；未配置保持不主动投递，不阻止普通交互和已授权的内部整理。这是能力启用条件，不推定主人已经选择某个频率。无截止时间的未回复话题只有新证据／自然相关上下文才可再提；有时效委托按原委托处理。

## 5. 来源变更同步

### 接口与校验语义

`synchronize({ operationId, fromRevision, toRevision, expectedGenerationId })`

两个 revision 均显式解析为 commit；toRevision 是主人提交修改后的目标，禁止从默认分支推断。同步范围由真实文件／目录和策略差异决定，依赖图是派生可重建视图，不能成为唯一的来源关系存储。

| 引用用途 | 校验规则 |
| --- | --- |
| 历史预测和执行踪迹 | 按封存时的 Source Version／旧 blob 标识验证记录完整性；不要求等于当前来源 |
| 当前建议、Twin 和工作理解 | 检查当前来源状态、依赖和使用策略；变化后重新评估 |
| 已删除来源 | 正常检索不得通过历史 Git、旧摘要或缓存恢复其内容；历史记录只保留移除标记与不含已删内容的定位信息 |

源删除不要求改写过去预测，也不自动要求物理清理 Git 历史。若预测／旧记录中含有已删除内容，它们保留为不可参与正常召回的历史记录；当前检索视图不得暴露该部分。用户主动要求历史审查仍须确认相应来源可用和用途授权，不能借“审查”默认恢复已删资料。

### 同步流程

1. 校验 fromRevision、toRevision、工作树和当前 generation，取得仓库写入协调权。
2. 识别新增、修改、移动、移除、策略变化；建立新 Source Version，保留稳定身份。内容不变的明确移动只更新 locator。
3. 根据持久 dependencyRefs 求完整受影响集合。立刻使其旧检索资格失效；受影响对象不得在重算期间继续以旧理解作答。
4. 语义重评受影响理解：保留有独立有效依据的部分，修订或撤回其余。保留候选分歧与原预测；不能仅替换旧 hash 来伪装重评完成。
5. 更新 OngoingWork、Twin、策略和 Host 摘要所依赖的投影。构建新 generation 的必要 views，验证来源及已删除内容不会进入正常结果。
6. 在同一目标变更上提交 catalog、理解变更和 operation 记录；按 durability 协议协调 recovery pointer、远端副本和 active generation。
7. 返回 `{ operationId, fromRevision, resultingRevision, generationId, affectedIds, removedSourceIds, viewReceipts, durability }`。receipt 中只有可公开的聚合信息时才可外带；私人 ID／路径默认留仓库。

toRevision 包含用户编辑，resultingRevision 可增加系统重新评估的认知记录；不得撤销用户编辑来保持旧 pin 有效。检测到并发提交时停止提交自身修改并重新计算 delta，不 reset／覆盖他人工作。

### 并发、失败和重启

同一仓库自动写入串行协调，提交前 compare-and-set 预期 HEAD；文件写入须同时校验起始字节，防止未提交的人工编辑被覆盖。对并发用户编辑不自动暂存或提交。

operation 记录含操作输入摘要、预期 revision／generation、目标对象摘要、阶段与提交身份定位。commit 通过包含 operationId 的持久记录定位，不能要求记录包含其自身 commit SHA。远端确认从显式远端 ref 校验，不能仅相信本机标志。

持久顺序：validate／stage → 原子本地发布 → scoped commit → persistent recovery pointer CAS → critical push 或 normal RPO 入队 → 发布有效读取 generation。normal 模式的 generation 可在本地提交后使用，但必须带 remote_pending，不声称已远端保护。critical 只有 push 确认后才向调用方报告完成。

多文件替换本身不假定文件系统事务：使用暂存目录、对象摘要、排他协调和恢复日志；发生部分替换时阻断读取直到完成或恢复自己写入的原始字节。恢复前校验目标未被他人再次修改，冲突保留并显式报错。读方不得看到半份 catalog 配半份对象。

失败不会自动撤销已生成的合法提交。相同 operationId 重试从已完成阶段接续：发现提交即校验其对象摘要，pointer 冲突先协调当前配置，push 结果不明先查询远端，禁止重跑语义学习造成重复记录。重启时从 operation 记录和 Git 定位 pending 状态，按来源资格屏蔽失效对象；不能仅清空缓存就宣称恢复一致。

required view 重建失败，完整同步保持失败且受影响查询阻断。声明为非必需且未参与当前问题的 view 可以不可用，但不得把需要它的请求降级成完成。全部检查通过后才原子切换 active generation；旧 generation 不再可用于普通查询。

## 6. 错误契约

所有四个接口使用 `{ operationId?, requestId?, category, stage, retryable, expectedRevision?, observedRevision? }`。私人来源正文不进入公开错误。

| 类别 | 处理 |
| --- | --- |
| `invalid_input`／`invalid_record`／`reference_invalid` | 修复结构或定位后重试，不调用 LLM 猜测必填值 |
| `permission_denied` | 不读、不派生、不投递受限内容；需要时询问确切用途 |
| `source_unavailable`／`attachment_missing` | 保留实际缺口，重新取得原件 |
| `index_not_ready`／`capability_unavailable` | 等待已知重建或修复能力；不能映射为空结果 |
| `material_unknown` | 仅作为成功取证后的业务状态，转为适当澄清 |
| `stale_generation`／`source_changed`／`write_conflict` | 重新读取版本并协调，不覆盖用户内容 |
| `idempotency_conflict` | 拒绝同 ID 不同意图；创建明确的新操作 |
| `persistence_failed`／`pointer_conflict`／`sync_failed` | 保留已完成阶段和提交；恢复后幂等接续 |
| `resource_exhausted`／`cancelled` | 停止未完成工作、保留可接续位置，不报告完整成功 |

实现可保留已有 `stella_*` 错误码，但必须一对一映射以上含义并保留原始诊断；不能合并为“没有记忆”。

## 7. 完整记忆验收

| ID | 合成测试安排 | 必须观察到的结果 |
| --- | --- | --- |
| M-01 | 同一对话含用户、助手、引用、编辑分支和附件 | 原件、角色、版本、附件齐全；模型文本不变成用户证据 |
| M-02 | 导入中断、附件遗漏、重复事件和同内容不同事件 | 可续传、缺口可见、无重复证据、不同事件保留 |
| M-03 | 屏蔽运行主机和库外资产存储 | 从归档 revision 校验所有声明原件，恢复后可按片段读取 |
| M-04 | 相关资料分散在旧语料、在途文章和配套反馈文件 | 跟随线索取证，不因旧注册范围或候选上限漏掉已知关键来源 |
| M-05 | 礼貌信号与长期互惠反证并存 | 原文和反证都进入判断；不凭标签解释掉反证 |
| M-06 | 先查无结果、索引重建中、源故障三种输入 | 分别报告覆盖缺口／未就绪／故障，不统一为事实不存在 |
| M-07 | 历史时间截断及事后结果 | 历史判断不用后来才可取得的信息，后续结果不改旧预测 |
| M-08 | 用户拒绝、解释原因、修正作者意图 | 一次更新应用到工作及相关理解；不重复追问，不强造 outcome |
| M-09 | 只认可写作帮助方式，未采纳候选结尾 | 更新协作理解，文章仍未完成，候选仍未采纳 |
| M-10 | 更新被旧 Episode 引用的 Twin；删除另一个来源 | 旧预测完整、当前理解重评；被删内容不经旧 view／摘要回流 |
| M-11 | 主人移动文件、并发编辑，重建／commit／CAS／push 各阶段故障 | 身份保留、无覆盖、无半读、无重复学习、状态可重启接续 |
| M-12 | active memory 或 Dreaming 含过时摘要 | 过时代际不可注入；来源修正传播到后续回答 |
| M-13 | 主动关系更新、无截止未回复话题、已有委托 | 不主动跟进关系；未回复不推断认可；既有委托不重复确认 |
| M-14 | 空工作集、无开放 Episode 和有重要写作上下文两种恢复 | 空集合法；声明的重要前提、纠正及开放问题全部恢复 |

上述测试验证结构和可观察行为，必要的语义评测只作诊断。社交判断和写作帮助的实际效果由主人真实使用反馈持续校准。
