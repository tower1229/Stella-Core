## Agent skills

## Architecture invariants

- 凡是需要理解多变自然语言含义的路由、分类或候选选择，必须使用 LLM 做结构化语义判断；禁止用关键词、正则、字符串包含或词面打分代替语义理解。确定性代码只负责结构校验、权限边界、容量限制和执行已选结果。
- 除非已经证明功能语义不受损失，否则禁止 fallback、静默降级或把错误转换成表面成功。每条架构路径必须有明确预期：满足完整契约才成功，否则显式失败并保留可诊断的失败类别。
- 核查 Stella 1.0 必须读取沧海 `dev` 并记录解析后的提交 SHA；当前基于 Core 改造的测试分支及其新增资产不能当作 1.0，运行时仍使用显式配置的源引用。
- 数据源集中于个人数字仓库是产品要求，Git 是当前承载方式；当前完整 Git 副本必须包含全部留存原始资料及附件，不能仅保存库外引用，也不能将 Git 推定为永久技术选型。
- 不设计自然语言“忘记某件事”功能；用户直接修改或删除存储文件后同步记忆，系统负责索引及依赖理解与新仓库状态一致。
- 社交状态判断按用户求助触发，利用已有历史和最新证据回答；不扩展为主动跟进关系或主动提醒关系变化，其他已确认的主动能力保留。
- 写作协作先核对作者原意与未决问题，不默认添加积极意义或励志结尾；作者纠正后更新理解，不能用助手偏好的结论替换原意。

### Product requirements

Read `docs/09-REQUIREMENTS-ALIGNMENT.md` for the confirmed top-level requirements, verified source baselines, and remaining design questions. Keep product requirements distinct from Alpha implementation limits and automated diagnostic scores.

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `tower1229/Stella-Core`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using a root `CONTEXT.md` and system-wide ADRs under `docs/adr/`. See `docs/agents/domain.md`.
