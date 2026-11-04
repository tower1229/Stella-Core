# MIG02 文稿到普通来源读取的运行导出

本合同衔接沧海的原件保全生产者与 Core 当前读接口，不另建迁移或记忆系统。2026-11-04 的实现是**无写盘准备函数和纯合成消费验证**；真实全仓运行导出、Host 加载与模型理解仍未验收。

## 三种产物和三个版本

- MIG02 的 `manifest.json`、`mapping.json` 和逐件 receipt 记录迁移文件、处置及原始字节；它们不是运行 catalog，也不授予资料读取许可。
- 运行导出使用现有 `stella.consciousness-manifest/v1` → `stella.runtime-profile/v1` 或 v2 → `stella.memory-catalog/v1`。Source、Evidence、policy、coverage 的版本和 locator hash 仍由现有内核解释。
- 普通插件只读 `{ root, manifestPath, revision }`，要求干净的固定 Git 工作树。`revision` 是**写入完整运行导出后的提交**；既不是迁移生成器代码提交，也不是 receipt 的原始资料 `sourceRevision`。

本包生成器固定为 CangHai `8eff06a1444e46411c439c10aa49a2a6602b562c`。真实首批候选观察为 `2c6df62075c77cf6db66b615e52f58dcebf99b28`，与生成器硬化版本分开；没有读取它的私人正文或将其连接到运行入口。现有 90f 消费快照不变。

## 最小代码接缝

[`prepareMigratedRepositorySource`](../src/canghai/repository-source.ts) 在现有 `prepareRepositorySource` 上增加 MIG02 文稿收据校验；返回待写的 Source v2、Evidence、coverage 对象及明确的迁移元数据，**不写文件、不 commit、不构造 grant、不激活运行源**。

| 输入／事实 | 责任和验证 |
| --- | --- |
| receipt 与 `sourceRevision` | 沧海生产者交付逐件 `document_package_candidate`，无未决 reasons，候选标记保持 inactive。Core 比较显式预期 baseline；这只是元数据匹配，函数不独立验证原 Git commit 或 `originBlob` 可达性。生产者仍须证明固定输入快照与原件归属。 |
| `collectionId / sourceId` | 显式传入；只接收已有 `source_id` 且不待身份审阅。这个 ID 是**来源记录编号**，不是原始消息 ID、作者或账号认证。临时路径身份、冲突或待版本审阅明确拒绝，不猜测映射。 |
| `originalPath` | 调用者明确选择 receipt 声明的保留原件；核对 `originSha256` 和 `originBytes`。不根据后缀选正文，不拿改写链接后的 `normalizedSha256` 代替原件。现有安全路径、UTF-8 与字节 selector 检查继续生效。 |
| `policyRef / reviewedSegments` | 外部显式提供现有版本化策略和已审分段；函数只做结构／完整覆盖校验。它不理解 frontmatter 限制，不自动编译策略，不替代来源审阅或处理许可。 |
| `capturedAt` | 导出捕获时间；没有有据元数据时 role/kind 保持 `unknown`，speaker/发生/创作时间保持 `null`，不从文件名、内容或 source_id 推断。 |
| `objectRoot` 与返回对象 | 由沧海唯一写者选择新命名空间，复用 canonical version/locator hash。写入前重新核原件摘要、完整引用和工作树基线，再按现有写入安排提交；此函数不提供并发写入或事务完成证明。 |

opaque／原生领域保存候选、临时身份、待版本审阅及无明确分段的文件不进入此文稿路径。附件继续保留在沧海，二进制读取需媒体能力；本包不自动跟随原文链接，也不证明附件全覆盖。Understanding、Work 和学习变更不会从 raw Evidence 自动生成；待专家收敛的理解回写语义不在此片中决定。

## 生产者交接与消费顺序

1. **沧海写者**固定生成器 SHA、原资料 SHA、候选数据 SHA 和逐件 receipt，交付稳定记录映射、原件路径／hash、明确的策略及审核分段。完整原件和附件保全仍按全仓迁移计划推进。
2. 准备 Source／Evidence／coverage；写者将返回对象与实际 policy 一并组成现有 catalog，填 generation、parentGeneration 和依赖。`identity.runtimeProfileRef` 与可选 `runtimeState.runtimeProfileRef` 一致，profile 的 `memory.catalog_ref` 指到该 catalog。
3. **准入资料单独交付**：descriptor 必须精确绑定 Source 版本、片段与策略；profile 的 `source_access_context` 配置与已有处理许可相符。迁移 review 或合成 admission 不是 grant；旧 97／362 不自动覆盖新增或改版对象。
4. **协调者**接收最终数据 commit、入口路径/hash、catalog generation、生产者 before/after 与变更处置。**Core**用当前普通入口验证固定版本列举／回读，记录 revision、manifest/profile/catalog hash 和精确 Evidence 引用。下一请求采用新版必须显式交接；不自动跟随分支。

本包测试中的 `publish` 只写自己的合成临时仓库，演示上述已有格式如何组合；它不是新增生产迁移 CLI。同步会话继续维护 14 项矩阵及其冻结验收，不重复修改其工作树。下一生产接线只需把这个准备函数接入沧海既有导出步骤，补齐所选真实对象的稳定身份、分段、策略／descriptor 证据，交付最终运行 SHA；不能把通过合成测试改称真实数据已供给。

## 本包实际证据

[`migration-source-export.test.ts`](../tests/migration-source-export.test.ts) 复用当前普通读取 fixture。两个虚构文稿由上述固定版本的真实 `warehouse_inventory.build` 与 `evidence_packages.build` 生成；没有执行真实 apply。生成器四文件 hash、原合成 Git SHA、plan digest 和生成结果摘要见 [PRODUCER-FIXTURE.json](../.task-control/reports/CORE-VAL-001/migration-runtime-export-20261104/PRODUCER-FIXTURE.json)。

新增 9 项覆盖：原件未改写和链接改写留存原件、BOM／CRLF 精确保留、manifest/profile/catalog 回读；迁移清单冒充、待审身份／版本、改写字节替换、无分段／覆盖缺失、篡改及来源准入拒绝；改版后旧 pin／cursor／Evidence 拒绝。改版用例是另行显式构造的合成更新，不是第二次 MIG02 生成器运行。真实生成器产物用于前两个正例及其拒绝对照；测试未证明真实 Host 身份、LLM 策略判断、全仓转换或自动同步。

当前 descriptor 数量／准入文档容量、媒体能力和真实模型语义限制仍在原合同中；分页不是扩容或扩权。独立审查、源码构建与解包验证的实际结果分别记在 [本包报告](../.task-control/reports/CORE-VAL-001/migration-runtime-export-20261104/REPORT.json)，不能合并为真实端到端验收。
