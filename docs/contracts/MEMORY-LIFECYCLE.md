# Memory Lifecycle Contract

状态：现行完整产品设计；实现状态见[设计基线](../10-DESIGN-BASELINE.md#6-设计与源码的差异)。
本契约覆盖资料接入 → 证据检索 → 交互学习 → 来源变更同步。复用 OpenClaw 的记录、搜索、模型与调度；Core 负责语义判断及跨这些能力的一致性。

## 1. 公共数据约定

### 身份与定位

- 新建资料、证据、理解、工作和操作使用带类型前缀的 UUID，例如 `source_<uuid>`、`evidence_<uuid>`、`understanding_<uuid>`、`work_<uuid>`、`op_<uuid>`。已有稳定 ID 保留，通过目录映射，禁止重新编号造成重复身份。
- 持久引用是 `{ id, version }`；现有字符串字段使用等价的 `mem:<percent-encoded-id>@sha256:<64-hex>` 编码，由同一目录解析。路径是对应版本的 locator，不是身份。同一 ID 的实质内容更新产生新 version。引用当前对象时可只存 ID，由当前目录解析；封存预测及取证记录必须引用确定版本。
- 版本摘要统一为 `sha256:<64 lowercase hex>`。原文件 hash 对原始字节计算；JSON 清单和语义对象按 UTF-8、无 BOM、对象键递归排序、数组保持顺序、无额外空白序列化后计算。版本字段和其存储定位不参与自身摘要。
- 计算 Source 版本时排除 payload.path，但包括 payload 的 sha256、bytes、mediaType；其他对象仅排除顶层 version 和定位元数据，不排除所依赖 Ref 的 version。日期不擅自改时区、字符串不做语义正规化，拒绝 NaN／Infinity 等非 JSON 值。移动只更改 locator，内容或语义元数据改变才产生新版本。
- Git commit SHA 表示整库恢复点；Git blob SHA 表示历史实现的文件 pin；二者与 SHA-256 内容摘要分别带类型，禁止仅凭字符串长度混用算法。
- 机器时间为带时区的 RFC 3339。分别保存 `occurredAt`（发生）、`authoredAt`（表达）和 `capturedAt`（留存）；未知时间为 `null`，不能用留存时间冒充发生时间。观察时段可用 `{ from, to }`。
- `path:<repo-relative-path>` 仅作仓库定位；解析器必须校验越界、符号链接、文件存在与版本完整性。片段定位必须真实解析，不以文件存在代替片段有效。

### 来源、证据与使用策略

下列结构中的 `Ref` 是确定版本引用；所有持久对象均带 `schemaVersion`。

```ts
type Ref = { id: string; version: string };
type Locator = { path: string; mediaType: string; bytes: number; sha256: string; revision?: string };
type Source = {
  schemaVersion: "stella.memory-source/v1";
  id: string;
  version: string;
  origin: { adapterId: string; collectionId: string; upstreamId: string };
  payloads: Locator[];
  capturedAt: string;
  policyRef: Ref;
  coverageRef: Ref;
};
type Evidence = {
  schemaVersion: "stella.memory-evidence/v1";
  id: string;
  version: string;
  source: Ref;
  payloadSha256: string;
  selector: { kind: "utf8_bytes" | "json_pointer" | "media_range" | "payload"; value: string };
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

`payloads` 至少一个；归档完成时，全部内容必须是该归档版本中可取得的真实字节。附件也进入 payload 清单或明确关联的 Source。Source 的语义版本不可变，路径属于可更新的定位元数据，其 current／superseded／removed 资格由 catalog 维护；主人删除后保留不含原文的描述及摘要，仅 removed 状态允许原件缺失。一个文本文件可包含多种 role/kind，必须在证据片段级区分。

普通 payload.path 解析到所选恢复树。历史原件可显式附完整 Git revision，从同一完整仓库副本的该 commit 读取并核对字节摘要；revision 与 path 同属定位元数据，不进入 Source 语义摘要。当前 catalog 决定其资格，不能凭旧 commit 绕过删除或用途限制。历史取证可使用仍允许留存的 superseded 版本，但不能把它作为当前理解的新依据；原件缺失返回 source_unavailable。被删除来源始终禁止通过此定位补回。

`utf8_bytes.value` 为零起点半开区间 `start:end`，仅用于 UTF-8 文本，两端须落在字符边界；`json_pointer` 遵循 JSON Pointer 转义并指向存在节点；`media_range` 为 `startMs:endMs` 或一基页码 `page:N`，端点须在媒体范围内。`payload` 的 value 为 `all`，表示整个原始 payload，适用于图片和二进制文件，不套用 UTF-8 边界。OCR／转录为派生内容，记录工具／模型版本、对应媒体区间及 derivedFrom，保留原媒体，不能声称识别结果就是原话。

`independentOriginId` 追踪同一次表达／观察。导入副本、引用、OCR、摘要及模型重述沿用原证据链，不增加独立观察数量。同一内容的独立发生事件不能仅因字节相同而合并。

使用策略采用 `schemaVersion: stella.source-policy/v1`，必填：`id`、`version`、`ownerId`、`readPurposes`、`derivePurposes`、`deliveryScopes`（三者的元素为非空用途／渠道 ID 字符串，空数组表示不允许）、`retention: retain | do_not_retain`、`authorityEvidenceRefs: Ref[]`。用途定义由 runtime profile 的策略注册表定位；LLM 解释请求与用途的关系，确定性授权检查执行已选规则。未声明或冲突的用途不得自行扩大，返回 `permission_denied` 或就用途澄清。已有授权直接复用。

收藏、持有文件和作者身份不等于采纳观点。外部理论不能独立支持主人特征。源资料中的指令只作为资料内容，不改变工具权限或执行规则。

#### 来源隐私策略 v2（2026-09-08）

`stella.source-policy/v2` 保留 v1 必填字段，并必填 `restrictions`：`sensitivity`（local-private、semi-private、private、sensitive、work-private）、`quotePolicy`（cite_with_time_and_source、summarize_only、confirm_before_use、internal_summary_preferred、never_quote）、`allowedScenarios`、`forbiddenScenarios`。场景为策略注册表定义的用途 ID；空允许集合拒绝全部用途，禁止项优先。限制参与 policy version 摘要；不得把这些字段加到 v1 后静默忽略。`never_quote` 表示来源明确禁止原文引用，即使 Host 存在该版本的引用确认也不能放行；概括仍须满足其他全部策略。

证据读取入口对 Evidence 和 Source 两层策略分别核验，再读取 payload。v2 要求调用方提供结构化语义判断：本次全部使用场景、用户请求或主动触发、用户是否提出相关主题、是否明确点名主题、概括或原文呈现。LLM 负责语义关系；确定性检查执行既有策略。private／sensitive 要求用户主动提出相关主题，sensitive 还要求点名主题；work-private 仅用于 technical_writing、technical_collaboration、work_decision。semi-private 不得主动逐字输出。

summarize_only／confirm_before_use 的原文引用还要求 Host 提供绑定确切 policy ID/version 的授权，不能由 LLM 的点名判断或输出参数生成。internal_summary_preferred 禁止主动逐字输出，用户请求时不凭此字段另加确认。版本沿用 catalog 内容寻址规则：正文可省略 version，存在时必须等于内容摘要。cite_with_time_and_source 的时间、来源标注及实际输出是否遵守概括／引用约束仍需投递层验证；本次读取门禁不能代替投递验收。

当前实施范围为策略解码、profile 策略资源验证和 Evidence／框架来源读取检查。profile 资源加载同时验证 v1／v2 的完整策略结构、身份及内容版本；加载成功不授予资料访问权。现有 Host 请求路径尚未提供完整语义上下文与引用授权接入；v2 在这些路径返回 `source_access_context_required`，不能宣称已可迁移激活。归档写入及初始化技能策略尚不接受 v2。

2026-09-08 增加逐来源访问 provider（`src/canghai/source-access.ts`），取代 EvidencePurpose 上整轮共用的固定上下文。每次判断绑定请求摘要、Source ID/version 和 Policy ID/version；共享同一 policy 的两个来源也必须分别判断。Host 固定触发方式、概括／引用方式及引用许可，模型只返回用途与主题关系，不能在结果中添加或改写 Host 授权。用途／渠道已被禁止、敏感资料的主动触发及缺失引用许可在描述交给模型前拒绝。

provider 的 describe 端口只能返回已获准供该模型处理的、绑定确切来源和策略版本的主题描述，不能通过先读原文来判断原文是否可读。描述的读取和模型处理权限仍由 Host 适配器负责，provider 本身不授予这种权限。模型结束后再次核对描述、目录、来源及策略；版本变化、取消、未知主题、禁止场景或异常均显式失败。失败不携带模型原始输出或 provider 私有原因；每请求最多 128 次判断，耗尽返回错误，不截断成成功。

Evidence 的源级／证据级策略以及 Framework 原文入口共享这一 provider；相同来源的两层策略相同可复用本次检查，不跨来源复用。原文返回前再次读取策略验证摘要。事务重建 reader 时保留本轮 provider，并对新目录重新校验。上述为 Core 读取路径的实施进度：真实 Host 的可信请求绑定、主题描述处理授权、复核约束迁移及最终输出校验仍未全部接通，main 的 full_memory 门禁和禁止读取的迁移策略保持不变，不能将此进度称为真实问答验收完成。

2026-09-08 请求绑定实现：`reply_dispatch` 将 Host 的原始 Body、SDK 确认的发送者身份及所有者标记、Agent／session／run 和 chatType 固定到完成协调器的运行上下文。`before_prompt_build` 在读取个人认知之前核对归属，并要求明确的主人私聊；路由及取证使用绑定的原始问题，不把 hook 拼接文本当作请求授权。绑定在取消／生成结束后失效，不流入持久化或投递端口参数。这只证明请求身份与问题的来源，不授予资料用途、引用或外部模型处理权限；逐来源策略启用、主题描述授权和私人视图生成仍未接通。

2026-09-08 来源授权接线：Alpha profile 可声明 capability `source_access_context`，adapter 为 `stella.personal-context-access`、版本 `1`。其 `config_ref` 指向严格 JSON `stella.personal-context-access/v1`，必填 `ownerId`、非空且去重的 `requesterIds`／`modelRefs`、`purpose: {readPurpose, derivePurpose, deliveryScope}` 和 `descriptors: [{sourceRef, policyRef, description}]`。每个描述绑定确切来源／策略版本，最多 512 项、每项 8000 字符、配置文件 256 KB。此配置是经主人授权写入仓库的**描述处理许可**，不可由模型即时生成，不能代替正文的来源策略或最终输出许可。只有配置进入已加载 profile 的权威路径后才用于运行时。

Host 适配器要求活跃请求中 SDK 确认的主人身份、私聊范围和明确 requester ID 全部匹配，策略 ownerId 与许可 ownerId 相同，用途相同。选择实际 Host 默认模型并传入精确 model ref，以 OpenClaw 2026.8.2 的直接 completion 路径完成来源判断，同时核对返回模型；不走隔离 Agent 的模型 fallback。运行中模型选择、描述许可文件、目录、来源或策略发生变化，或者请求失效时显式失败。没有活跃请求的恢复入口不自动继承私人授权。

问题取证会将明确的访问拒绝记录为 `excludedByAccess`，继续读取其余获准资料；其中计数单位是 evidence 条目，不包含被拒绝对象的 ID、路径或正文。这是未检索范围，不能作为事件不存在的证据。模型故障、非法判断、缺失描述、版本失效及预算耗尽仍中止整轮，不转换成排除项。计数由 Host 写入 EvidenceBundle 的可选字段并参与版本摘要，模型不能改写；历史无此字段的 v1 bundle 仍按原摘要读取。

上述接线在合成目录和插件准备路径验证；真实 main 的 full_memory 门禁仍保留。真实策略启用、获准描述迁移、私人 USER／MEMORY 视图、全部下游模型的正文处理许可和最终投递约束尚未完整验收，不能把配置可加载或一次来源判断成功当作真实个人问答完成。

2026-09-08 私人视图接线：在上述配置中显式增加非空 `viewProcessingModelRefs`（必须是 `modelRefs` 的子集），才授权对应模型在既定主人／请求／用途范围内处理获准原文及其派生视图；缺省不会启用私人视图，既有描述许可不会自动扩大。Host 选择、视图选择器、携带视图的取证模型必须匹配；启用视图的目标 Agent／默认模型存在 fallback 时返回 `personal_view_fallback_route_forbidden`，不能把私人上下文转给未经核准的备用路由。

`preparePersonalViews` 从当前目录读取 Understanding 和 active／paused OngoingWork，校验全部声明依赖、来源用途、所有者、原始证据和更新依据后，才将候选交给结构化 LLM 选择。返回的 `stella.personal-views/v1` 包含 Host 提供的 requestId／requestHash、generationId、owner_direct 受众、访问排除计数，以及 USER／MEMORY 两个集合。模型只选择每个候选的 user／memory／omit 归属，不改写正文或来源，不生成新人物结论。USER 仅接受有主人原文支持的 active owner_statement；其 work／context／domain 范围完整保留，不变成全局人格指令。候选、争议和写作事项进入 MEMORY 时保留状态、确认／提案／拒绝、未决问题、时间和原始依据。

视图只放入当前请求的取证上下文和 Host appendContext，不改写共享 workspace 文件，也不保存第二份个人模型。生成后、准备完成及交付前的 persist 阶段重新核对目录、对象、原文和处理许可；失效时拒绝使用旧视图。最多 64 个获准候选、512 个依赖快照，选择输入 160000 字符、输出上下文 96000 字符，超限显式失败，不截断成成功。无候选是有范围的空视图，不代表全库无历史。

本次实现的是已有合法理解／事项的读取与装配，不是纠正写入协调器。合成测试通过生成新目录代际及带 LearningChange 的新事项版本，验证旧视图失效、新会话读取新版本；不能据此声称自然语言纠正已自动写回、传播到全部派生资产。非空 episodeRefs 和尚无适配器的依赖显式拒绝；完整媒体检索、历史视图、输出引用约束和真实 main 的 full_memory 验收仍待实现。

2026-09-08 纠正事务增量：`src/learning/correction.ts` 的 `prepareCorrection` 接收已归档、可校验身份的主人原话，以结构化模型生成更新方案并独立复核。宿主固定对象身份、时间、版本、LearningChange 和新代际；模型不能引入未读引用或跳过依赖受影响的理解／事项。当前采用完整批次同步：有访问排除而无法证明影响范围完整时拒绝更新；不实现中间代或后台重评，也不取消后续分批同步的产品要求。修订、旧版本失效、LearningChange 和目录通过现有 MemoryTransaction 一起发布，critical 同步失败保持读取屏障。同实例重试及 `recoverCorrection` 的日志恢复均复用已确认事务，不重新生成修订或重发回答；恢复再次核查计划路径与变更范围、证据及当前处理许可。

2026-09-08 Host 接线增量：启用私人视图处理且使用 managed_durable_write 的请求，在生成回答前执行 `prepareInput`。先验证初始化门禁和活跃主人请求，将完成协调器已绑定的原始请求归档为 `openclaw-reply-dispatch-2026.8.2` 来源（Host 此时尚未可靠提交 transcript），保留准确请求体、身份和 run 绑定；capturedAt 只表示接收观察时间，不伪造 transcript 事件、admission receipt 或 authoredAt，再由 `archiveCorrectionInput` 将原文、Source／Evidence／Coverage 与目录放入一个 MemoryTransaction，完成 critical 后才调用纠正模型。`applyHostCorrection` 的新代际随后用于当轮视图和取证；完成收据包含归档及纠正操作。只读模式不执行这一写入路径。归档或纠正失败时不生成／投递成功回答，事务屏障保护未完成发布。

生成权限结束后，完成协调器只在 persist 阶段授予同 run 的来源复核权限；不得重新读取原始请求或发起新的来源判断。复核只接受本次已成功判断的确切 Source／Policy／用途，重查许可文件和当前对象，缺收据、撤销、取消或来源变化均失败。最终投递在仓库 mutation lock 内复核当轮所用视图、原文与收据 generation；允许本轮持久化新增不影响所用材料的对象，不允许使用过时理解。该锁协调 Core 写入，不阻止仓库外部进程直接改文件。初始化检查只排除当前进程持有且字节未变的确切锁文件，其他脏改仍阻断投递。

新增合成测试覆盖归档失败前零模型调用、原话完整留存、事务恢复、当轮新事项读取和投递前代际／原文复核。该入口的单请求 Coverage 不表示完整对话已归档；后续 transcript 导入仍需关联同一消息，不能重复计算独立证据。真实来源逐项用途与描述启用、生成内容是否遵守全部引用／语义约束、重启后经 Host 授权的私人纠正恢复入口、完整记忆能力接入及真实 main 行为验收仍未完成，不能将这些测试称为 C-04 已通过。

2026-09-08 能力补齐增量：完整记忆使用独立的 `stella.memory-runtime-binding/v1`，由必需 capability `memory_lifecycle`（adapter `stella.memory-lifecycle`，version `1`）的 config_ref 引用。字段为 `archive: {policyRef, objectRoot, payloadRoot}`、`purpose: {readPurpose, derivePurpose, deliveryScope}`、`referenceBindings: [{routingRef, sourceRef}]`。必须另有 `source_access_context`，显式授予私人视图处理；四个角色模型均在许可范围内，必需视图为 current_understanding／ongoing_work，语义 provider 为 stella-structured-llm。Alpha 解码仍只接受原有格式；完整记忆不接受借用 Alpha 格式。该接线复用已有目录及事务内核，不能作为完整检索、媒体留存、自动任务或各 skill 能力已经验收的凭据，初始化完整运行门禁保留。

私人视图路径新增生成后、持久化业务回答前的 `prepareSourceOutputCheck`。它携带本轮取证及视图所用原文、源级／证据级策略，以结构化 LLM 判断最终回答是否越权引用、超出用途、混淆证据或替换作者原意；当前访问适配器只授予概括，检查器不能生成引用许可。判断绑定 requestHash／draftHash／sourcesHash，原文、策略和处理许可在判断前后重新校验；错误或拒绝均阻断该回答的持久化与投递，不回退为成功。此前已同步的纠正不会因为回答拒绝而撤销。检查作用于已读入的这些证据，不证明尚未实现的来源约束迁移或全库检索已完成。

新增管理入口 `stella.recoverCorrection`：仅接受 `{operationId: learn_<sha256>}`，要求本机 operator.admin 和当前 personal-context-access 中显式 `operatorRecovery: true`，客户端标识须在 requesterIds 内。恢复校验已绑定的主人／模型、当前处理许可和来源配置权威，再重放已有日志；不调用语义模型、不接受用户指定目的地、不重新发送回答。缺少当前来源访问证明仍显式失败，不为恢复绕过 v2 策略。隔离实际 Host 验证了失败屏障、重启恢复、重复恢复不重复学习及不重发。

2026-09-09 来源限制迁移增量：`stella.source-policy/v3` 保留 v2 字段，必填 `usageRules: {access, interpretation}`。两组均为 `{id, requirement}` 数组，每组最多 32 条、单条要求最多 2000 字符、总长最多 24000 字符，组内 ID 唯一。v1／v2 不接受此字段，不能通过添加字段却沿用旧版本静默迁移。规则是限制，不授予模型、引用、投递或操作权限。

读取前的逐来源语义判断必须为每条 access 规则返回 `{id,satisfied}`；Host 将检查绑定到确切 Policy Ref，漏项、伪造项、旧版本或不满足均失败。明确的 `source_rule_forbidden` 计入访问排除，格式错误和缺失规则检查仍中止请求。interpretation 规则以确切策略引用随 OriginalEvidence 传递；问题取证的 EvidenceBundle 和纠正方案在持久化前另经结构化 LLM 逐条复核，判断绑定请求、原件、规则及候选内容，前后重验来源与许可。最终回答检查同时约束这些规则，违反返回 `source_output_rejected`。这不是其他尚未接通的框架编译、外部集成或全部学习路径的完成证明。

迁移规划器把既有结构化语义审查的 requiredChanges 映射到明确规则，并保留每份来源的原始 interpretation，不能只用通用规则替代特定上下文。未知规则显式标记不支持；分段、原件留存、框架占位排除和旧关系跟进投影迁移仍要求具体实现及证据，不能由模型返回合规替代。规划输出始终不是激活授权，逐来源规则复核、真实配置迁移及 full_memory 完整能力门禁仍须完成。

2026-09-09 特殊来源接线：`stella.memory-source/v2` 必填 `accessSegments: [{payloadSha256,start,end,policyRef}]`，按 UTF-8 字节范围表达已语义审查的权限分段。每份文本 payload 必须从零至其声明长度连续完整覆盖，不重叠、不遗漏；最多 512 段，边界必须为有效 UTF-8。v1 不能携带此字段。版本身份包含分段及各策略引用，路径和历史 revision 仍只作 locator。该格式当前只支持文本，不据此声明媒体分段完成。

Evidence 只能选取单个已审查片段之内的范围，并绑定该段的确切策略；与源级策略取交集，先验证再读取原文。跨段取文、换用宽松策略、通过原有整文件入口读取受限来源均显式失败。私人视图检查来源元数据后逐 Evidence 授权，不因一个受限片段而把同源的其他合法片段当成已授权或全部不可用。分段 Evidence 保持来源的同一个 independentOriginId，不增加独立证据计数；未经角色语义审查的导入继续标为 unknown。

`prepareRepositorySource.reviewedSegments` 和 `scripts/prepare-reviewed-source-segments.mjs` 生成不改原文的迁移候选。脚本要求精确且干净的来源 revision、绑定原件的语义审查及当前 catalog；片段只可收窄隐私／引用规则，不新增用途或投递范围。候选包含替代的 Source／Evidence refs，写入私有文件，始终 `readyToActivate: false`；尚须与整体策略、描述、理解依赖和目录代际迁移一起发布。框架装载另检查 active IR 的来源注册状态必须是 active_source，IR 正文来源必须与激活记录一致；占位或未注册来源不得进入可执行框架。

`scripts/prepare-source-catalog-migration.mjs` 合并整体 v3 策略与分段候选，生成新目录代际和迁移后的来源描述引用。它要求原件摘要、干净 revision、目录摘要及语义审查绑定一致，保留旧对象为 superseded，检查全部当前依赖闭合，不扩大已有处理权限。当前仅支持无 Understanding／OngoingWork／Change／Bundle／View 的首次导入；有派生状态时显式拒绝，不能丢弃理解后继续迁移。同版本对象可沿用已有 locator。输出及落库后的描述迁移文件仍不构成运行授权：片段专属描述、处理主体与模型授权、full_memory 行为验收必须另行完成。

2026-09-08 真实 main 预检：`scripts/inspect-main-readiness.mjs` 只读核对本机 Gateway 初始化状态、角色模型、能力配置／验收声明和目录用途，输出私有 JSON，存在阻断返回退出码 2；它永远不生成业务验收通过凭据，不据声明文件放开门禁。本机已移除 DeepSeek fallback 并重启加载纠正接线，但 `full_memory` 仍被运行门禁拦截。源 revision `37fc834f5958fcba02be9209bf8420bc65583678` 下，100 条来源的用途集合未启用，11 项能力配置为占位、12 项能力验收未完成，四个角色模型与实际 Gemini 3.1 Pro 不符；主人输入归档与私人上下文访问绑定缺失。该次预检时 `loadPraxisRuntimeBinding` 仅接受 Alpha；上述后续增量补充了完整记忆绑定解码，但真实 main 的占位配置尚未迁移，真实业务验收并未执行。必须先实现完整记忆运行绑定及依赖能力，再完成来源约束迁移、角色模型统一与真实用例验收；不得把更换 profile 或删掉 blocker 当作完成。

来源迁移工具允许复用绑定旧 revision 的语义审查，前提是旧／新提交的整个 `30_RAG` 文件树（路径、mode、blob）相同，且每条来源摘要与审查匹配。输出保留 `reviewedRevision` 和当前 `boundRevision`，不改写原审查，不因此授予用途或模型处理许可；任一来源变化须重新审查。真实目录核对已确认 100 条来源满足这一条件，实际策略与描述启用仍未执行。

迁移规划脚本 `scripts/plan-source-policy-migration.mjs <root> <full-revision> [semantic-review.json]` 始终只读，要求来源为固定且干净的 HEAD。可选审查文件使用 `stella.source-policy-semantic-review/v1`，包含 sourceRevision、reviewer（kind: llm、id）和完整 entries；每项包含 sourceId、sourceSha256、interpretation、requiredChanges。LLM 负责阅读 Usage Policy／Import Notes 并形成解释，脚本仅验证逐来源身份、摘要、完整性和格式，不替代语义复核，也不验证模型身份或授予权限。审查结果随摘要进入计划，原始元数据映射保持不变；有审查结果也始终 `readyToApply: false`。审查约束落地、权威依据、用途注册、请求及引用授权接入完成前，计划不得应用。

### 持久组织

```text
50_PersonalAgent/stella/
  memory/catalog.json                 # 当前来源、策略、理解和派生视图目录
  memory/operations/<op-id>.json       # 操作意图及幂等协调记录
  memory/objects/<id>/<version-hash>.json # 来源、证据、策略、覆盖及规范化元数据的不可变描述
  runtime-profile.yaml                # Host 能力、用途和同步策略
30_PersonalData/
  experience/imports/<source-id>/      # 新接入的原始数据及附件
  experience/conversations/<source-id>/# 可移植对话导出；不承载 Host 会话执行
  state/open-loops/<work-id>.json      # 可接续事项
  state/understanding/<id>.json        # 有范围的理解及依赖
  state/learning/<change-id>.json      # 理解更新依据
```

既有文章、附件和资料保留原位，catalog 引用它们。无需将所有原文移动到上述目录，也不允许只提交库外 URL、LFS 指针或未物化子模块来声称自包含。用户自行选择将来的存储技术时另行迁移，本规范固定当前 Git 副本必须持有原始字节。

catalog 必填 `schemaVersion: stella.memory-catalog/v1`、`generationId`、`parentGenerationId`（首代 null）、`sources`、`evidence`、`policies`、`understandings`、`works`、`changes`、`bundles`、`views`、`coverage`。每个对象条目保存 ID、version、仓库 locator、状态及依赖 Ref；同一 ID/version 不得重复，同一 ID 至多一个当前版本。view 只保存重建配方及代际标识，不提交索引数据库。完整字段与实例发现方式见[Portable Registries](PORTABLE-REGISTRIES.md)。

当现有正文文件需要原位更新时，先保留被历史引用的旧规范化版本到 objects，当前正文及元数据仍是唯一当前权威；不是两份可独立学习的记录。封存的版本副本只能按明确版本读取，并受最新来源资格约束。元数据不得包含其自身摘要或提交 SHA，避免版本计算循环。

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

coverage 使用 `schemaVersion: stella.archive-coverage/v1`，必填：`id`、`version`、`adapterId`、`collectionId`、`scope`、`upstreamSnapshot`、`fromCursor`、`toCursor`、`expectedCount`（未知 null）、`retainedCount`、`excludedByPolicyCount`、`missingItems`、`checkedAt`、`completeForDeclaredScope`。scope 为 `{ agentIds: string[], roots: string[], branchPolicy: "all_retained" | "declared_subset", declaredBranches: string[] }`；不用的集合为空，不能以空数组隐式代表全部。upstreamSnapshot 是可核对快照 ID，cursor 为字符串或 null。missingItems 为 `{ upstreamId, reason, retryable }[]`，计数均为非负整数。complete 为 true 需要无缺项及清单计数一致；缺少上游可核对清单时为 false，不能用 retainedCount 自证全部齐全。

归档 adapter 在启用前必须证明可连续导出并与 Host 清理策略协调：Host 清理前先获得归档确认，或配置不会提前清理并持续监测积压。若 Host 不能保证，两者之一必须显式阻断完整留存能力。非留存资料不写 payload 或衍生个人理解；运维记录只保留无内容的操作状态。

do_not_retain 同样约束 Host transcript、暂存和备份。输入 admission 必须先验证该范围的不留存能力；缺失时明确拒绝承诺不留存，不得先落盘再声称已遵守。已有留存资料的修改／删除仍按主人文件维护流程，不由此引入自然语言历史遗忘接口。

### 重复与重试

相同 operationId 及相同输入摘要返回原结果；相同 ID 不同内容返回 `idempotency_conflict`。以 adapter＋collection＋upstreamId 识别事件，同一事件修订产生新 Source Version。无上游 ID 的本地文件首次分配 Source ID；移动通过明确操作记录或唯一的一致内容映射维持身份，歧义进入协调，不能静默合并不同资料。

输入摘要绑定上游快照、完整声明清单及策略，不绑定已下载字节数。补传同一清单的缺失附件可复用原操作；上游内容或清单已改变须用新 operationId。不得用“重试”忽略输入变化。

## 3. 证据检索

### 接口

`retrieve({ requestId, question, workId?, revision, generationId, purpose, temporalScope, requiredCapabilities, resourceBudget })`

- `temporalScope` 为 `current` 或 `{ knownBy, eventWindow? }`；历史回放同时限制当时已可取得的证据与事件发生范围，不能把后来报道的旧事件当作当时已知。
- `resourceBudget` 明示每次模型、读取和总任务的上限及取消标识，用于资源治理；容量上限不是证据充分性的标准。
- `requiredCapabilities` 根据问题语义和 scope 选择，基础候选搜索可复用 Host FTS／向量召回；最后的语义选择、证据判断不得用词面排序替代。

成功结果为 `EvidenceBundle`：

```ts
type EvidenceBundle = {
  schemaVersion: "stella.evidence-bundle/v1";
  id: string;
  version: string;
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
  excludedByAccess?: Partial<Record<SourceAccessExclusionCategory, number>>; // Host 记录的正整数计数
  unresolvedLeads: Array<{ question: string; material: boolean; reason: string }>;
  stopping: { reason: string; modelRef: string; promptVersion: string };
  suggestedResponseKind: "answer" | "clarification" | "collaboration" | "action_advice" | "outcome_ack";
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

返回 `{ changeRef, state, durability }`；LearningChange 本体使用 `schemaVersion: stella.learning-change/v1`，含 `id`、`version`、`operationId`、`algorithmVersion`、`modelRef`、`promptVersion`、`inputRefs: Ref[]`、`targetRefs: Ref[]`、`changes`、`rationale` 和 `disposition: update | no_change | needs_clarification`。changes 为 `{ kind: create | revise | narrow | contest | retire | link, before: Ref | null, after: Ref, supportRefs: Ref[], counterRefs: Ref[] }[]`；create 的 before 为 null，其他更新指定旧版本。没有可支持的更新时 changes 为空并记录 no_change 及原因，不能为指标随意修改 Twin。运行阶段及 durability 是操作 receipt，不写入本体摘要，避免自引用提交或事后改写依据。

### 理解和工作对象

`Understanding` 必填：`id`、`version`、`statement`、`kind`（owner_statement／hypothesis／strategy／intent）、`scope`、`status`（candidate／active／contested／retired）、`supportRefs`、`counterRefs`、`dependencyRefs`、`originChangeId`、`createdAt`、`updatedAt`。scope 至少具有 work、context、domain 或显式全局声明之一，不能用空 scope 隐式全局化。

原生 Understanding 使用 `schemaVersion: stella.understanding/v1`；scope 为 `{ workIds: string[], contexts: string[], domains: string[], global: boolean }`，global=false 时至少一项非空。所有证据／依赖字段是 Ref 数组。创建为 candidate 或有明确采纳证据的 active；候选经语义评估可 active／contested／retired，active 可 contested／retired，contested 经新证据可 active／retired。retired 重新采用必须有新版本、依据和 LearningChange，不能由重建索引自动恢复。

已有 Twin／Praxis 策略直接承担对应 Understanding：原记录是唯一正文，缺少的依赖／更新元数据由 catalog 关联描述表达，适配后必须满足上述逻辑字段。不能维护另一份独立的同义人格结论。正文及元数据使用同一操作提交。

适配元数据使用 `schemaVersion: stella.understanding-metadata/v1`，含 id、version、subjectRef 及上述 kind、scope、status、dependencyRefs、originChangeId；语句、证据及时间从 subjectRef 的正文映射，不复制正文。Twin.weakened 是强度状态，不自动等于 contested；是否仍有冲突由语义更新明确填写。两处均含状态或范围时必须通过一致性校验，不能各自更新。

`OngoingWork` 必填：`id`、`version`、`kind`（social_question／writing／task／inquiry）、`status`（active／paused／completed／abandoned）、`goal`、`sourceRefs`、`confirmedPremises`、`candidateIdeas`、`rejectedInterpretations`、`openQuestions`、`nextStep`、`lastAppliedChangeId`、`createdAt`、`updatedAt`。premises／ideas／rejections 均引用来源并区分作者认可状态；`nextStep` 可以是继续思考的问题，不必是外部行动。linked Episode 是可选关联。

工作采用 `schemaVersion: stella.ongoing-work/v1`；sourceRefs 为 Ref[]。premises／ideas／rejections 每项为 `{ id, text, evidenceRefs: Ref[], acceptance: confirmed | proposed | rejected }`，三个集合分别只能使用相应状态。openQuestions 为 `{ id, question, evidenceRefs: Ref[], material: boolean }[]`；nextStep 为 `{ text, evidenceRefs: Ref[] } | null`；lastAppliedChangeId 初始可 null；可选 episodeRefs 是 Ref[]。状态转换证据保存在对应 LearningChange，不能只改 status。

工作状态允许 active ↔ paused、active／paused → completed／abandoned；completed 需要任务完成证据，认可协作不能充当完成证据。重新打开事项记录新版本与明确原因。未回复不自动完成、放弃或改变委托。

```text
feedback captured → semantic proposal → validated → committed → applied
                                  ↘ no_change / needs_clarification
                                  ↘ failed
```

理解与工作更新作为同一操作提交，应用到当前情境后才能说已吸收；关键纠正及未完成的重要前提按 critical 同步。后台重处理同一 inputRefs＋algorithmVersion＋目标版本不得重复追加证据。换算法可重算，但保留原始独立证据计数。

交互纠正与来源修改共享完整依赖失效规则：learn 确定纠正目标及范围后，不能仅更新当前工作而保留受其影响的旧理解或 Host 摘要继续可用。需要跨事项重评时，遵守下文“分批重评与中间代发布”；依赖传播不等于把当前情境的纠正泛化为其他情境的新结论。

### 重要判断的历史踪迹

依据 D-055，Historical Trace 覆盖影响后续理解的重要事实判断、情境判断、作者意图解释、预测及其实质修订。记录实际输出定位、形成时间、主张与范围、当时依据的确定版本、明确的不确定性、当时已记录的简短解释及修订关联。形成、持久化与投递分别依据实际记录，不从文本存在推断投递成功；未记录的解释保留未知，不事后生成并冒充当时依据。

踪迹关联已有 EvidenceBundle、Understanding、OngoingWork、LearningChange 和适用的 Episode 版本，不为写作解释虚构行动或 Episode，也不形成另一份可独立学习的用户证据。普通措辞变化由原始对话留存承载，不要求保存每一步内部思考。所有历史读取仍受当前来源资格和用途限制。

回溯须区分“依据当前证据理解过去实际状态”和“解释当时实际判断”。现实有效时间与获知／纠错时间分别表达，未知边界不从文件更新时间补造；不得将后来才获得的事实注入封存判断。此处规定语义与必要信息，具体时间字段和踪迹定位格式仍须在实现前补齐格式、校验及迁移设计。

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

operation 意图使用 `schemaVersion: stella.memory-operation/v1`，含 id、kind（ingest／learn／synchronize）、inputDigest、expectedRevision、expectedGenerationId（首次 null）、targetRefs、createdAt；与目标对象一起提交后不可变。commit 通过包含 operationId 的持久记录定位，不能要求记录包含其自身 commit SHA。阶段 journal 位于 Host 运行状态，含 operationId、phase、observedCommit、errorCategory，可由意图、Git、pointer 和远端重新构建；阶段推进不反复修改已提交意图而制造新认知 revision。远端确认从显式远端 ref 校验，不能仅相信本机标志。

持久顺序：validate／stage → 原子本地发布 → scoped commit → persistent recovery pointer CAS → critical push 或 normal RPO 入队 → 发布有效读取 generation。normal 模式的 generation 可在本地提交后使用，但必须带 remote_pending，不声称已远端保护。critical 只有 push 确认后才向调用方报告完成。

多文件替换本身不假定文件系统事务：使用暂存目录、对象摘要、排他协调和恢复日志；发生部分替换时阻断读取直到完成或恢复自己写入的原始字节。恢复前校验目标未被他人再次修改，冲突保留并显式报错。读方不得看到半份 catalog 配半份对象。

失败不会自动撤销已生成的合法提交。相同 operationId 重试从已完成阶段接续：发现提交即校验其对象摘要，pointer 冲突先协调当前配置，push 结果不明先查询远端，禁止重跑语义学习造成重复记录。重启时从 operation 记录和 Git 定位 pending 状态，按来源资格屏蔽失效对象；不能仅清空缓存就宣称恢复一致。

required view 重建失败，完整同步保持失败且受影响查询阻断。声明为非必需且未参与当前问题的 view 可以不可用，但不得把需要它的请求降级成完成。全部检查通过后才原子切换 active generation；旧 generation 不再可用于普通查询。

### 分批重评与中间代发布

D-056 将上述整批同步流程细化为允许分批重评，但不允许半份数据发布。当前工作已修正且其回答所需理解均有效时，可以发布一个自洽的中间 generation，继续当前工作，并在后台重评其余事项。中间代必须同时满足：

- 完整受影响集合已确定；未重评对象及依赖它们的理解和视图均被显式屏蔽，屏蔽与待重评范围持久保存且可在重启后恢复。无法证明集合完整或当前工作已脱离待重评依赖时，当前工作也不得据此继续。
- 当前工作与所需理解作为同一操作一致更新，关键纠正及屏蔽满足 critical 持久化；正常可读集合通过依赖、授权和必要视图校验。不能临时将 required view 改为 optional 来通过发布。
- 目录、对象资格与可用视图属于同一自洽代际。上述“全部检查通过”对每次发布都成立，包含对待重评对象确实不可用的检查；它不要求整批语义重评已结束。部分文件替换和事务失败继续阻断读取。
- 后续批次基于最新 revision／generation 校验并幂等发布；并发变化重新协调，不覆写后来的用户纠正，不重复增加独立证据。失败保留待重评状态，不能重新启用旧理解。
- 当前工作可继续、中间代已发布、整批重评完成分别表达。中间发布不返回整批 synchronize 已完成；涉及待重评内容的请求等待或明确报告未完成，不能把暂时不可用解释为事实不存在。

最终回复或行动前的 Ref／授权复核同样适用于交互纠正：已生成但未投递的受影响回答须重做受影响部分，无关回答复核后可以继续。Host 投递许可边界必须保证并发纠正不会绕过这项检查。

以上确定发布不变量。待重评状态的具体 schema、整批操作与分批操作的关联、重启续作及发布／投递协调协议须在实现前明确；现有数据格式和源码不能据此被视为已支持该流程。

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

2026-09-09 运行绑定补强：full_memory 的 `loadPraxisRuntimeBinding` 在装载处理授权时校验当前 Source 的父策略及每个片段策略都有精确版本的专属描述，拒绝缺失、过期或未由来源声明的描述，以及 owner 不一致。该检查不调用模型、不证明 Host 身份已收到真实请求，也不替代 full_memory 能力验收；处理授权只能绑定 Host 已配置的 owner、指定模型与用途，引用授权仍单独控制。

2026-09-09 语义检索接入：`stella.semantic-retrieval/v1` 通过 pageSize／maxRounds／maxSelected／maxOriginalChars 声明执行预算；`retrieveCatalogEvidence` 每轮遍历当前目录的所有描述页，由结构化模型选择证据，并从已授权原件中继续提出检索意图。选中原件经既有权限及分段入口回读，再进入问答 EvidenceBundle 和独立解释校验。目录超过 64 条不再直接触发全读失败；所选证据、原文字符和轮数仍有明确上限，未完成时返回容量／预算错误。未选原件和访问排除不构成否定证据，遍历全部描述也不构成全库原文覆盖。仅受控 Host 归档可在 owner 正文处理授权下使用原件作为检索描述；其他来源缺描述必须失败。该实现不代表源发现、附件归档、全量同步或框架及外部技能能力已验收。

2026-09-11 声明范围发现：`discoverDeclaredScope` 从 `stella.corpus-registry/v1` 枚举声明 include／exclude，经结构化模型选择跨目录线索，产出按 collection 对齐 adapter／collectionId 且含 `version` 的 ingest-ready Source／Archive Coverage 对象及可 `parseMemoryCatalog` 的目录预览；公开报告去掉私人路径与原文。记忆事务 pending 映射为 `index_not_ready`。该实现不写盘、不完成 ingest 状态机，也不表示全量同步或检索已验收。

2026-09-11 统一 ingest 入口：公开 `ingest`／`ingestHostMessage`／`ingestExplicitRecord` 贯通 `received → staged → validated → local_committed → synchronized`；Host 消息与显式记录共用合同。`stella.memory-operation/v1` 完整校验后以 inputDigest 幂等，残缺 journal 失败关闭；新写入核对 expectedRevision 与当前 HEAD。以 adapter＋collection＋upstreamId 识别事件，编辑产生新 Source Version，同内容不同事件分别保留。`do_not_retain` 在 Host transcript／暂存／备份保证缺失时于落盘前返回 `retention_guarantee_unavailable`；获准后只写无内容操作状态。该实现不覆盖完整 transcript／附件归档（工作项 09）、续传清单（工作项 10）或五类入口全部接通；synthetic_contract 下 implemented ≠ verified。
