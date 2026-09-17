# canghai

Adapters for reading/writing portable personal-data contracts in the private CangHai repository/worktree.

Stella-Core tests must use synthetic fixtures only; never copy private CangHai records into this public repository.

来源变更使用 `synchronize.ts` 的公开 `synchronize`，在显式提交间重建来源及依赖、先 critical 保存读取屏障、后重评和整批发布。`synchronization-plan.ts` 负责 Git 差异、唯一移动、来源版本及依赖闭包；语义重评由结构化模型完成。相同 operationId 重放已批准事务，新人工提交须以新 operationId、原 fromRevision 和最新 toRevision 接续。契约、适配器限制和证据边界见 Memory Lifecycle §5 及 2026-09-17 实施记录；此入口不自动启用 Host 任务。
