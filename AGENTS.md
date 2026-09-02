## Agent skills

## Architecture invariants

- 凡是需要理解多变自然语言含义的路由、分类或候选选择，必须使用 LLM 做结构化语义判断；禁止用关键词、正则、字符串包含或词面打分代替语义理解。确定性代码只负责结构校验、权限边界、容量限制和执行已选结果。
- 除非已经证明功能语义不受损失，否则禁止 fallback、静默降级或把错误转换成表面成功。每条架构路径必须有明确预期：满足完整契约才成功，否则显式失败并保留可诊断的失败类别。

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `tower1229/Stella-Core`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using a root `CONTEXT.md` and system-wide ADRs under `docs/adr/`. See `docs/agents/domain.md`.
