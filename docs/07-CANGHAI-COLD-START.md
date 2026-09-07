# CangHai 1.0 → Stella 3.0 Cold-Start Mapping

## 1. Goal

Build the first recoverable Stella 3.0 consciousness set from the existing CangHai/Stella 1.0 assets without destructive migration.

Current mapping follows [Portable Registries](contracts/PORTABLE-REGISTRIES.md) and [Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md). Existing files can remain canonical sources; obsolete managed formats require explicit migration before activation.

Alpha uses an additive source mapping:

```text
existing CangHai assets
        ↓ referenced in place
Consciousness Manifest + registries
        ↓
Stella Core versioned source adapters
        ↓
Twin / Framework / Praxis runtime
```

Do not relocate or rewrite the existing corpus merely to satisfy the new architecture.

### Verified legacy baseline

The Stella 1.0 backup is CangHai `dev`, verified on 2026-09-05 at
`a1c2f4ec444b7d3245a7a0afea74460470a5dfc2`. The current `local/stella-alpha` branch is a
Stella Core integration test branch. Read legacy evidence from the resolved `dev` commit;
do not infer 1.0 capabilities from the current working tree.

The manifest and `30_PersonalData/` structure described below are 3.0 additions and do not exist
in that legacy commit. Migration and runtime operations still require an explicitly configured
source revision; the legacy backup branch is not automatically a runnable 3.0 recovery target.
See [the requirements alignment record](09-REQUIREMENTS-ALIGNMENT.md) for the complete distinction.

## 2. Migration rule: reference first, re-role second, move last

For each legacy asset:

1. preserve original path and provenance;
2. assign its Stella 3.0 cognitive role;
3. reference it through a registry;
4. validate its declared format through a versioned adapter; migrate obsolete managed formats explicitly;
5. only later decide whether physical relocation improves maintainability.

A path move is not an architectural milestone.

## 3. Existing asset mapping

| Existing CangHai asset | 3.0 role | Alpha handling |
| --- | --- | --- |
| `50_PersonalAgent/openclaw/workspace/SOUL.md` | identity/persona | reference directly from manifest |
| `.../IDENTITY.md` | instance identity projection | reference directly |
| `.../USER.md` | owner bootstrap projection | reference directly; not treated as full Twin |
| `.../MEMORY.md` | curated bootstrap/experience pointer | reference during compatibility period |
| `50_PersonalAgent/openclaw/openclaw.json` | legacy runtime/model configuration source | read only as migration input; derive and validate the portable runtime profile before activation |
| `50_PersonalAgent/corpus-registry.yaml` | experience/corpus discovery | reference directly |
| `30_RAG/model-seed/` | Twin cold-start hypotheses + supporting evidence | derive bounded Twin Hypothesis seeds; keep source files unchanged |
| `30_RAG/self-reflection/` | Twin evidence | retrieve as supporting/counter evidence |
| `30_RAG/life-log/` | episodic personal experience | index in place |
| `30_RAG/relationship/` | social/relationship experience | index in place for relationship Praxis |
| `30_RAG/health/` | state/health experience | keep as evidence, not Alpha core domain |
| `30_RAG/work/` | work contextual-self evidence | keep for later domains |
| `30_RAG/writing/` | writing contextual-self/style evidence | keep for later domains |
| `30_RAG/frameworks/` | canonical Framework Source | register existing framework files as sources |
| `50_PersonalAgent/skills/` | legacy owner-specific behavior assets | classify and map to the current skill contract before enabling; retain private behavior in CangHai |
| existing Stella evals | continuity/regression seed | reuse privately where owner facts are involved |

上表的直接引用用于保留来源，不表示允许将旧文件全文当作新版运行指令注入。2026-09-07 初始化设计要求先完成下文 §13 的行为映射，再依据 [Host 初始化设计](04-OPENCLAW-INTEGRATION.md#8-stella-实例初始化与运行投影详细设计)生成运行投影；原件仍留存。

## 4. New additive CangHai bootstrap structure

Alpha adds a small 3.0 control surface without moving legacy content:

```text
50_PersonalAgent/
└── stella/
    ├── manifest.yaml
    ├── runtime-profile.yaml
    ├── skills-registry.yaml
    ├── frameworks/
    │   ├── source-registry.yaml
    │   └── active-ir-registry.yaml
    ├── twin/
    │   └── hypotheses-registry.yaml
    └── continuity/
        └── suite.yaml

30_PersonalData/
├── twin/
│   └── hypotheses/
├── praxis/
│   ├── episodes/
│   └── playbook/
└── framework-runtime/
    └── active-ir/
```

The `50_PersonalAgent/stella/` tree is configuration/discovery metadata.

The `30_PersonalData/` tree contains new durable owner-specific learning produced by Stella 3.0.

Existing `30_RAG/` remains valid and is not duplicated.

## 5. Consciousness Manifest initial references

The initial manifest should point to:

```yaml
identity:
  soulRef: path:50_PersonalAgent/openclaw/workspace/SOUL.md
  identityRef: path:50_PersonalAgent/openclaw/workspace/IDENTITY.md
  userProfileRef: path:50_PersonalAgent/openclaw/workspace/USER.md
  runtimeProfileRef: path:50_PersonalAgent/stella/runtime-profile.yaml

experience:
  corpusRegistryRef: path:50_PersonalAgent/corpus-registry.yaml

frameworks:
  sourceRegistryRef: path:50_PersonalAgent/stella/frameworks/source-registry.yaml
  activeIrRegistryRef: path:50_PersonalAgent/stella/frameworks/active-ir-registry.yaml

twin:
  hypothesisRegistryRef: path:50_PersonalAgent/stella/twin/hypotheses-registry.yaml

praxis:
  episodeRootRef: path:30_PersonalData/praxis/episodes
  playbookRegistryRef: path:30_PersonalData/praxis/playbook/registry.yaml

extensions:
  skillRegistryRef: path:50_PersonalAgent/stella/skills-registry.yaml
```

## 6. Runtime profile separation

The only authoritative profile is identity.runtimeProfileRef, using the complete field contract in
[Portable Registries](contracts/PORTABLE-REGISTRIES.md#3-runtime-profile). Required fields include
language, timezone, contract profile, model roles, capability adapters, source policies and autonomy.
Use actual instance values and external SecretRefs; placeholder models and undeclared capabilities
cannot pass activation.

The legacy openclaw.json is migration evidence and a deployment backup, not a second active Stella
profile. Derive the portable non-secret profile explicitly, then generate Host configuration from it.
Machine paths, ports, credentials and old runtime state do not become personal cognition. Optional
unavailable capabilities and a blocked activation state are distinct.

## 7. Framework cold start

Do not compile every framework for Alpha.

Start with a small operator set extracted from the existing canonical framework corpus. The first relationship/social Praxis build should prioritize cognitive jobs such as:

- observation vs interpretation separation;
- condition/dependent-origination analysis;
- direct-experience / smallest-real-world-test check;
- anti-certainty / competing-explanation check;
- proportionality and boundary translation where supported by owner-authored sources.

For each activated operator:

```text
existing source
→ versioned compiler
→ Framework IR
→ validate
→ persist exact active IR in CangHai
→ register active IR
```

The exact active IR is portable because model compilation is not assumed deterministic.

## 8. Twin cold start

Do not transform the full personal-model seed into one large Twin record.

Extract only hypotheses that can make useful contextual predictions.

Alpha target: roughly 5–10 relationship/social hypotheses, each with:

- contextual scope;
- prediction target;
- initial strength;
- source references;
- explicit counterevidence when already available.

Examples of acceptable hypothesis forms are structural, not owner-specific content:

> Under high interpersonal uncertainty, the owner may prefer additional analysis before acting.

> When an action feels socially performative rather than sincere, acceptance probability may drop.

These are seeds. Future Praxis outcomes determine whether they strengthen, narrow, split, or retire.

## 9. Legacy skill mapping

Existing Stella skills fall into three migration classes:

### Class A — Generic Stella Core behavior

Logic that is broadly part of the Stella 3.0 product architecture should eventually move into Stella Core runtime modules.

Examples may include generic Praxis routing, Twin handling, framework selection, and outcome recording.

### Class B — Owner-specific behavior asset

A skill that encodes owner-specific preferences, workflows, data sources, or private operating conventions remains portable in CangHai and is referenced by the skill registry.

### Class C — External/integration capability

Skills primarily wrapping external services or one-off operational tooling remain separate capabilities and are restored only when dependencies are available.

The canonical class values are core_behavior, owner_behavior and integration. Inactive legacy assets may remain unmapped evidence, but every enabled skill must have a valid class, source, policy and capability declaration. Old save-confirmation rules and current owner authorization must be reconciled before execution; unknown or conflicting instructions cannot be activated unchanged.

## 10. New personal learning writes

Stella 3.0 must not write new Twin/Praxis learning back into legacy `model-seed/` or unrelated `30_RAG` files.

New learning goes to new managed 3.0 locations:

```text
30_PersonalData/twin/hypotheses/
30_PersonalData/praxis/episodes/
30_PersonalData/praxis/playbook/
30_PersonalData/framework-runtime/active-ir/
```

This creates a clean boundary:

```text
legacy 1.0 corpus = cold-start evidence
3.0 managed data  = continuously learned consciousness
```

## 11. Restore behavior during transition

A fresh restore during Alpha should:

1. load the manifest;
2. load identity/bootstrap files from their existing locations;
3. load the existing corpus registry;
4. load 3.0 Twin seed registry and records;
5. load canonical framework sources from existing `30_RAG/frameworks/` paths;
6. load exact active IR from new 3.0 managed storage;
7. load Praxis episodes/playbook from new storage;
8. validate the current owner-specific skills registry, policy and dependencies;
9. rebuild OpenClaw runtime projections/indexes;
10. start with a fresh session.

No old session database is required. Empty registries are legal; declared dependencies are mandatory.
Episode v1, unversioned registries and old profiles require the explicit migrations in their contracts.
Raw legacy source files need not change merely because their discovery metadata is upgraded.

## 12. Completion of source mapping

Source mapping is complete when every declared durable dependency has a validated current representation or an intentionally retained canonical legacy source readable through the declared adapter. There is one current managed format per contract; obsolete format fallback and parallel writes do not satisfy migration.

Physical migration of old archives is optional. Continuity and reconstructability are the requirement.

## 13. Stella 1.0 运行实现调查与功能承接（2026-09-07）

本节是对备份实现的静态调查，不是旧服务器运行验收。再次从本地沧海 `dev` 解析并读取的 SHA 为 `a1c2f4ec444b7d3245a7a0afea74460470a5dfc2`；没有切换、修改该仓库，也没有执行其中的同步脚本。备份配置 `meta.lastTouchedVersion` 为 `2026.7.1`，它是配置最后修改版本，不能证明旧服务器当前或历史每次运行的版本。本次新版源码基线为 Core `a42db5d0d55e6b474ca0f3e2647a2bd022c24547`、本地依赖 OpenClaw `2026.8.2`。

### 13.1 1.0 的实际组成

1. `50_PersonalAgent/openclaw/workspace/AGENTS.md` 定义会话启动、检索门禁、十个用户入口、内部 skills 分派、写入与回写流程。它是功能编排的一部分，不只是通用安全说明。
2. 同目录 `SOUL.md` 定义身份、语气、挑战方式及写作、关系等行为边界；`IDENTITY.md` 是展示身份；`USER.md` 是主人基本背景和偏好；`MEMORY.md` 主要保存存在性锚点、检索指针及待观察假设。原件涉及私人信息，本节只记录职责，不复制正文。
3. `HEARTBEAT.md` 有主动问候与 bootstrap 健康检查的 `tasks:` 声明；另有独立的灵感漫游周报 cron 安装脚本。文件声明不能证明定时任务实际按预期运行。
4. `50_PersonalAgent/skills/` 有 14 个 `SKILL.md`，为检索、保存、写作、自我观察、关系、健康、阅读和运维提供模型执行流程。规则主要依赖模型遵守；Shell 脚本负责文件、索引、Git 和部署操作。
5. `50_PersonalAgent/openclaw/openclaw.json` 保存宿主配置。备份启用 `memory-core` 的 Dreaming、`active-memory`、`memory-wiki`，以及 `session-memory` 内部 hook。这里只证明配置声明；插件代码、实际可用性、索引覆盖与故障语义需另验。该 commit 的 `50_PersonalAgent/plugins/` 未发现受跟踪文件。
6. `50_PersonalAgent/corpus-registry.yaml` 与同步脚本把公开作者语料及私人记忆语料接到搜索和 Wiki；不能据此宣称已覆盖所有在途文章、日常对话和附件。

运行链为：workspace 常驻指令 → 语义识别请求 → skill 指导检索／分析 → 按旧规则确认写入 → 操作 skill 调脚本 → Git 回写或部署 → 索引／Wiki 同步。新版需要承接这条功能链，而不只是恢复几个身份引用。

### 13.2 Skills 与入口承接清单

以下是迁移设计；不是启用清单。每个启用项还需源码／依赖 pin、策略核对和目标 Host 验收。保留用户熟悉的表达，通用自然语言入口由结构化 LLM 判断；显式 CLI 或 slash 命令可确定性分派。

| 1.0 skill／入口 | 现有职责 | 新版承接与变化 |
| --- | --- | --- |
| `memory-routing`／写入记忆 | 判断存储层、锚点与篇章，保存前确认 | 通用语义判断进入 ingest／learn；按已确认整理权执行，不继续逐次确认；原话与理解分开保存 |
| `canghai-operations`／从沧海同步、同步到沧海 | 文件写入、导入、部署、回写、索引协调 | 薄运维 skill 调 Core 受控操作；同步方向明确，不能再整体 rsync 配置或自动回写生成投影 |
| `memory-handling` | 来源用途、引用、敏感性及事实边界 | 源策略校验由 Core 强制执行，语义证据判断由 LLM；不是可忘记调用的可选提示 |
| `personal-model` | 按需检索长期模式，避免固化画像 | Twin 的情境选择与反证检查；移除按工作目录一刀切排除的通用规则，保留每份资料的实际用途限制 |
| `relationship-boundary` | 关系意图、尺度和边界分析 | 按需社交判断；旧版禁止结合历史和当前资料判断状态的通用条款与现行需求冲突，须显式迁移；不取消来源级用途限制 |
| `health-recovery` | 识别过载，给出恢复建议，核对健康原件 | 主人行为资产；保留证据门槛，不能把旧固定时点或信号示例直接编译成硬编码语义路由 |
| `writing-editor` | 保留原声、诊断、轻改或重写 | 写作协作与编辑资产；补齐现行作者原意、共同推演、纠正和 OngoingWork，不限于已成稿编辑 |
| `know-me`／了解我 | 主动开启背景故事访谈和时间线整理 | 保留自愿访谈流程，学习走共享 ingest／learn；不强迫保存所有推断，不机械沿用旧确认链 |
| `insight-me`／洞察我 | 一次性、可追溯自我观察 | 保留请求触发及临时候选性质；认知推断不是已确认 Twin，不因执行而自动激活假设 |
| `synthesis-review`／关联检索、关联治理 | 多角度语义搜索与关联候选审查 | 共享 retrieve／consolidation；旧固定轮数和候选上限不作为完整产品充分性标准 |
| `book-framework`／书籍解读 | 提取书籍概念系统及实践含义 | 保留阅读工作流；作者观点不自动成为主人的 Framework Source 或 active IR |
| `weread-skills`／调用微信读书 | 阅读服务接口 | integration，另验服务、依赖与凭据；备份代码存在不证明连接可用 |
| `roaming-report`／定时周报 | 定时取材、语义关联、私聊报告 | owner_behavior + 宿主调度；迁移声明、时区与投递授权，状态缺失时不擅自重启任务 |
| `public-ask-learning-batch`／批处理网站问答 | 私有筛选、短名单确认后物化公开问答 | 独立 integration，保留具体发布内容的授权边界；不作为 Core 基础初始化的必需能力 |

`AGENTS.md` 还引用 `web-tools-guide` 及多项通用技能；该备份的上述 skill 目录没有 `web-tools-guide/SKILL.md`。这表示依赖在该备份范围内未闭合，不能断言原服务器未安装。初始化须把所有正文引用、脚本、模板、外部工具及服务纳入依赖清单；缺失的必需项阻断对应能力，不能只复制 14 个入口文件就报告功能恢复。

### 13.3 旧部署与备份脚本的价值和边界

核对了 `99_System/Scripts/sync-openclaw-runtime.sh`、`backup-openclaw-runtime.sh`、`sync-openclaw-memory.sh`、`install-roaming-report-cron.sh`：

- 已有双向同步、部署前 lint、旧 runtime 覆盖新沧海修改的检查，以及周报声明与回读验证，值得承接其“来源和实际部署必须一致”的目标。
- runtime deploy 整体复制 `openclaw.json`、workspace 与 skills，并可能同步其他 `workspace-*`；新版只能管理明确目标 Agent 及声明字段，不移植这种跨 Agent 副作用。
- 备份脚本复制六个 bootstrap 文件和已登记的 skills；主 workspace 的完整对话、附件留存不能由此证明。主 workspace 与其他 `workspace-*` 的目录备份范围也不相同。
- workspace／skills deploy 使用不带 `--delete` 的 rsync，来源移除不保证运行时旧 skill 消失；新设计按上一部署清单删除失效的受管项，并保护非受管内容。
- cron 安装器按名称找旧任务并删除重建，缺投递目标可被上层当 warning；新版使用稳定任务身份、幂等更新及逐能力状态，不能以名称或“脚本结束”证明完整恢复。
- 脚本会 pull、commit、push 或重启，不能当只读规划器调用。新初始化先输出精确来源版本和可审查变更，再执行获授权的计划，应用期间不能悄悄 pull 到另一 revision。

新版初始化的迁移结果须逐项记录 `retained | adapted | retired | unavailable | conflict`、原始定位／blob、目标职责、被替代条款、依赖和验收。`retired` 只指旧运行实现退出，不表示删除原件或取消未被修改的产品能力。
