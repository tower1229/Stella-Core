# Portable Registries and Runtime Profile

状态：现行开发契约。现有源码只读取其中部分字段；格式存在或引用可读不构成能力验收。规范入口见[设计基线](../10-DESIGN-BASELINE.md)。

## 1. 发现和版本

从 Consciousness Manifest 的显式引用发现资料，禁止依赖目录猜测。registry 是对象定位和能力声明，不是检索结果或证据本身。

每个 registry 必须具有 `schema_version`、稳定 `id` 和下表的集合键；集合可为空，条目 ID 唯一。现有 snake_case registry 键在此固定；语义对象及 memory catalog 使用其契约的 camelCase，不允许解析器自行猜字段别名。未知 schema 版本必须显式迁移。

| Manifest 引用 | Registry schema_version | 集合键与每项必填字段 |
| --- | --- | --- |
| `frameworks.sourceRegistryRef` | `stella.framework-source-registry/v1` | `sources`: `id`, `source_ref`, `source_blob_sha` |
| `frameworks.activeIrRegistryRef` | `stella.framework-active-ir-registry/v1` | `active`: `ir_id`, `ir_ref`, `source_ref`, `source_blob_sha` |
| `twin.hypothesisRegistryRef` | `stella.twin-hypotheses-registry/v1` | `hypotheses`: `id`, `ref` |
| `praxis.playbookRegistryRef` | `stella.praxis-playbook-registry/v1` | `items`: `id`, `ref`, `summary` |
| `praxis.openEpisodeRegistryRef` | `stella.praxis-open-registry/v1` | `episodes`: `id`, `ref`, `recovery_priority` |
| `experience.corpusRegistryRef` | `stella.corpus-registry/v1` | `corpora`: `id`, `root_ref`, `include`, `exclude`, `policy_ref`, `adapter_id` |
| `extensions.skillRegistryRef` | `stella.skill-registry/v1` | `skills`: `id`, `ref`, `class`, `enabled`, `required_capabilities`, `policy_ref` |
| `durableState.goalsRef` / `commitmentsRef` / `openLoopsRef` | `stella.durable-state-registry/v1` | `records`: `id`, `ref`, `kind`, `required_for_restore` |
| `evaluation.continuitySuiteRef` | `stella.continuity-suite/v1` | `cases`: `id`, `required`, `probe_ref`, `rubric_ref` |

`path:` 引用只能落在仓库中，blob 为实际文件的 Git blob SHA。Twin／Episode／IR ID 必须与目标对象一致；active IR 的 source_ref／blob 必须与 IR.source 的内容 pin 一致；同一 source 的 active 选择不得歧义。实例显式允许多个 IR 时以各自独立 source identity 区分，不以数组先后顺序决定权威。

仅路径移动时，source registry 可保存 `prior_source_refs: string[]`，将旧定位显式映射到同一稳定 source ID。校验身份及内容 pin 一致，不要求历史 IR.source.ref 的路径文字与当前 locator 相同，也不改写旧 IR。别名冲突或内容不一致显式失败；新记忆引用优先使用稳定 Ref。

`include`／`exclude` 是仓库相对文件 glob，用于结构覆盖，不作语义分类。显式列入在途文章、对话和附件；不允许沿用旧 corpus 范围就声称覆盖整个仓库。删除、策略更改及重命名使用 Memory Lifecycle 同步。

skill.class 为 `core_behavior | owner_behavior | integration`，enabled 为布尔值；required_capabilities 为能力 ID 数组。加载前校验正文及依赖是否可执行。旧版逐次保存确认、人格限制或用途规则按[现行需求](../09-REQUIREMENTS-ALIGNMENT.md)做显式映射，不能原样激活冲突指令。启用 skill 不扩大任何来源或执行权限。

其余可选 Manifest 引用也使用显式格式；声明后必需可读，未声明不要求制造记录：

| 引用 | 格式与必填内容 |
| --- | --- |
| twin.contextualSelfRegistryRef | `stella.contextual-self-registry/v1`，`id`、`selves: [{ id, ref, context, evidence_refs }]`；ref 指向有来源的情境理解 |
| twin.durableStateRef | 指向 `stella.twin-state-registry/v1`：`id`、`models: [{ id, ref }]`；每项 ref 指向 `stella.durable-model/v1` 描述对象：`id`、`version`、`format`、`payload_refs`、`input_refs`、`required_capabilities`；payload 含仓库定位和内容摘要，不存库外唯一副本 |
| extensions.customToolRegistryRef | `stella.custom-tool-registry/v1`，`id`、`tools: [{ id, adapter_id, config_ref, required_capabilities, policy_ref, enabled }]` |
| extensions.capabilityPolicyRef | `stella.capability-policy/v1`，`id`、`rules: [{ capability_id, allowed_purposes, delegation_required }]`；与 Host 权限取交集，不扩权 |
| evaluation.twinEvaluationRef / praxisEvaluationRef | 指向 `stella.evaluation-registry/v1`：`id`、`reports: [{ id, ref }]`；ref 指向声明 schemaVersion 的版本化评测报告，记录 suite、rubric、模型、证据截止时间、来源 revision 和结果，按所用 evaluator 验证 |

表中 registry/policy 使用 `schema_version`，模型描述使用 `schemaVersion`；`evidence_refs`／`input_refs` 为确定版本 Ref 数组。context 是明确的情境文字，不能以空字符串代表全部情境。工具／模型实际格式必须由声明的 adapter 验证；未知格式失败，不能只检查文件存在。

openEpisode registry 为完整开放集合的投影；未声明时从 episodeRoot 枚举。二者同时存在必须一致；零条为合法状态。recovery_priority 为 normal／important，不能以要求非空来保证覆盖率。

## 2. Memory catalog 发现与结构

完整记忆启用时，corpus registry 额外必填 `memory_catalog_ref`，指向 `stella.memory-catalog/v1` 的 JSON 文件。保持 Manifest 入口唯一；无需给当前闭合的 Manifest v1 添加未定义字段。

catalog 形状如下；Ref、Source、Evidence 及对象版本见[Memory Lifecycle](MEMORY-LIFECYCLE.md#1-公共数据约定)。

```ts
type CatalogEntry = {
  id: string;
  version: string;
  locator: { path: string; sha256: string };
  status: "current" | "superseded" | "removed";
  dependencies: Array<{ id: string; version: string }>;
  metadataRef?: { id: string; version: string };
};
type MemoryCatalog = {
  schemaVersion: "stella.memory-catalog/v1";
  generationId: string;
  parentGenerationId: string | null;
  sources: CatalogEntry[];
  evidence: CatalogEntry[];
  policies: CatalogEntry[];
  understandings: CatalogEntry[];
  works: CatalogEntry[];
  changes: CatalogEntry[];
  bundles: CatalogEntry[];
  coverage: CatalogEntry[];
  views: Array<{
    id: string;
    generationId: string;
    recipeRef: { id: string; version: string };
    required: boolean;
    sourceRefs: Array<{ id: string; version: string }>;
  }>;
};
```

CatalogEntry 指向持久描述对象，定位在当前恢复树中；需要保留的旧对象版本使用独立版本文件，不依赖覆盖后的同名文件。Source 的移除状态在 catalog 记录，其不含原文的原始描述及 payload 摘要仍可存在，但原件不再要求存在，也不得自动从 Git 历史补回。受删除影响的其他历史对象可以封存含原文内容，但必须失去正常取证资格。`current` 条目及其可用依赖必须可解析并符合最新策略；`superseded` 可在明确历史取证范围和最新用途授权下读取，`removed` 仅供不暴露原文的历史完整性校验。

同一集合 `(id, version)` 唯一，同一 ID 至多一个 current。新版本替代旧版本时保留旧条目；所有下游资格按依赖图计算，不能只检查自身 status。locator.sha256 校验定位文件的原始字节，version 校验语义内容，二者不可混用。metadataRef 只用于现有 Twin／策略缺少的规范化元数据，指向 Memory Lifecycle 定义的版本化描述，正文仍唯一。

catalog 中 works 必须与 durableState 中声明的 OngoingWork 一致。历史 snapshot／预测的依赖可保持旧版本定位；它们的完整性与当前召回资格分开校验。

view 的实际索引路径、缓存状态和重建结果在运行时。每次加载核对 generationId 和 sourceRefs，不能凭目录更新时间判定其有效。

recipeRef 指向 `schemaVersion: stella.view-recipe/v1`，必含 id、version、adapterId、adapterVersion、hostTarget、inputRefs、parameters；模型参与时另含 modelRef 和 promptVersion。hostTarget 对应 Manifest 声明的重建目标，parameters 由确切 adapter 验证。重建返回 viewId、generationId、recipeRef、inputRefs、status 及错误类别；输入集合或代际不一致不能视为 ready。

profile.memory.catalog_ref 必须与 corpus registry 的 memory_catalog_ref 解析为相同目录。profile.memory.required_views 对应的 view 必须标 required；Manifest 的每个 derived.rebuild 目标均须有声明的配方，不能因另一处配置未列出就跳过。冲突配置返回 validation_failed。

## 3. Runtime profile

`identity.runtimeProfileRef` 是唯一 profile 权威。若同时存在 `runtimeState.runtimeProfileRef`，必须解析为同一文件和内容；`compatibility.modelPolicyRef` 引用其中明确模型策略或独立的同版本模型策略对象，禁止两套模型配置互相覆盖。

profile 必填：

| 字段 | 类型与含义 |
| --- | --- |
| `schema_version` | `stella.runtime-profile/v1` |
| `agent_id` / `language` / `timezone` | 非空字符串；timezone 使用 IANA 标识 |
| `contract_profile` | `alpha_praxis` 或 `full_memory`；不能通过名字宣称已验证 |
| `models` | `main`, `router`, `learning`, `framework_compiler` 各为 `{ provider, model, required_capabilities }`；不存密钥 |
| `capabilities` | `{ id, required, adapter_id, adapter_version, config_ref, acceptance_ref, required_secret_refs }[]`；最后一项为外部 SecretRef 数组 |
| `source_policies_ref` | 版本化策略注册表路径 |
| `memory` | `{ catalog_ref, semantic_provider, required_views, archive_max_rpo_seconds }`；full_memory 必填 |
| `autonomy` | `{ research_enabled, proactive_delivery_enabled, delivery_policy_ref, delegation_registry_ref }` |

能力 ID 至少区分：`structured_model`、`source_read`、`semantic_search`、`transcript_archive`、`media_read`、`durable_commit`、`required_delivery_receipt`、`memory_view_rebuild`。每个 adapter 绑定确切 Host 版本与 runner／harness，而非只检查 npm 版本范围。

`acceptance_ref` 记录契约、适用范围、Host／adapter 版本与验证结果的私有证据位置。必要 capability 缺失阻断对应 profile；未声明为必需的 capability 可为 unavailable，但任何实际需要它的请求必须显式失败，不能静默改走较弱路径。

模型的 provider/model 配置、Host 工具权限及来源用途必须同时满足。Host FTS/向量索引用作候选生成，不替代 Core 的 LLM 语义选择。semantic_provider 指定实际 provider，不将自动 FTS 降级当作语义搜索能力。

源策略 registry 为 `{ schema_version: stella.source-policy-registry/v1, id, policies: [{ id, ref }] }`，目标对象按 Memory Lifecycle 的策略字段读取。

delivery policy 为 `{ schema_version: stella.delivery-policy/v1, timezone, allowed_windows, max_initiations_per_day, channel_ref }`。allowed_windows 每项为 `{ weekdays: number[], start: "HH:mm", end: "HH:mm" }`，weekday 1–7，跨午夜拆为两项。缺少配置不能启用 proactive_delivery。关系跟进始终被排除，未回复策略见需求；本规范不设置主人尚未选择的频率。

delegation registry 为 `{ schema_version: stella.delegation-registry/v1, id, delegations: [{ id, purpose, permitted_actions, targets, consequence_scope, evidence_refs, expires_at, status }] }`。status 为 active／revoked／expired；expires_at 可为 null（无固定期限）。执行前读取最新委托状态。`evidence_refs` 指向主人明确授权，不接受满意度或模型置信度替代；借 Host 权限执行，未配置委托记录不推定有外部权限。

## 4. Continuity suite

suite 必填 schema_version、id、version、cases、required_capabilities、judge_policy_ref。每个 case 指向私有 probe 和明确 rubric。

rubric 定义每项结构断言、预期允许的响应类型、语义诊断维度、每项通过条件及 required 标志。所有 required 结构断言必须通过。语义 judge 的模型、提示词版本、固定采样设置和次数记录在 judge policy；允许变化的行为边界须由 rubric 预先说明，不能失败后改容差。缺失配置返回 validation_failed。

Alpha 的私有连续性测试覆盖已有学习和有重要开放事项的 fixture；另有合法空集合 fixture。生产恢复按所选仓库实际集合核对，不要求为了通过测试制造未完成事项。语义 probe 通过不证明实际使用效果。

## 5. 迁移

无 schema_version 的现有 registry、`v1alpha` playbook、旧 profile 和多份配置是迁移输入。迁移先识别已知格式并生成明确变换结果，验证 ID、引用、来源 pin、角色及用途，再提交为新恢复点。未知字段含义不得猜测；缺少证据的个人判断保持未知，不补造事实来通过校验。

迁移必须输出旧／新格式版本、对象身份映射、保留／移除／未能映射项及新 revision。未通过完整 profile 的旧格式不得作为该 profile 的另一条降级成功路径。迁移不改变旧原始资料目录、发布状态或授权范围。
