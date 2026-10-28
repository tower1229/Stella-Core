## Agent skills

## Development model

- 后续开发、真实模型测试及语义评测统一使用 `google/gemini-3.8-flash`，不得回退到旧模型。隔离评测使用 `low` 思考等级，不传 Gemini 3.8 不支持的采样参数。历史验收记录保留原模型标记，不能作为新模型已通过的证据。

## Task continuity and recovery

- 恢复或接手任务时，先读根 `PROJECT-STATE.yaml` 与 `docs/10-DESIGN-BASELINE.md`，再按索引核对决策、证据和跨项目约定。`PROJECT-STATE.yaml` 是唯一当前任务状态入口，不新增平行的根任务状态文件；历史 handoff 和临时报告不能覆盖现行规范或补充授权。
- 每个里程碑及交接前更新该索引的基线 HEAD/远端核对、已实现/已验证/未验证、唯一下一步、阻塞和待批准事项。记录时基线不等于包含状态更新自身的提交；恢复时用 Git 核实实际 HEAD、工作区、远端和证据绑定版本，差异未解释前不继续依赖步骤。
- 同一仓库同时只有一个明确指定的写入者负责工作树、暂存与提交；并行会话可只读调查。接手先核对写入归属，不覆盖他人未提交改动，不因不同目录或分支名称推定隔离。
- 重要临时结论按最小必要原则归档到项目证据目录，保留来源版本、原始 hash、实际结果及未覆盖范围；不得仅以临时路径作为证据入口，不复制秘密、个人资料、凭据或整包原始日志。
- 旧 Host/模型/失败证据保留原身份并标为 historical；文档审查、公共接口可导入、合成探针或账本通过，不等于真实消费者/模型/full_memory 验收，更不产生部署、权限或付费调用授权。

## Project principles

- Stella Core 是实验性项目，优先追求架构优雅、职责清楚和简单可维护，不为运行中撤权等边缘时序引入代理层、复杂缓冲或额外事务平台。类似普通工程取舍可按此原则自主收敛；新增权限、真实 API 和生产部署仍须遵守各自授权。
- 一次用户请求启动时确定有效权限与记忆版本；同一请求内的模型工具续轮不是新的用户请求。本轮已合法供给的资料不承诺即时收回，下一用户请求必须重新读取当前权限/版本，不能沿用旧资格。Host 历史可保留为过去对话，不作为当前 Core 事实或许可凭据；同受众会话不要求逐轮 reset。
- 保留入场身份/权限、首次来源校验、正常取消、写入事务完整性和跨用户轮次 freshness。运行中 policy 变化及流式/历史输出拦截不再作为主线或 full_memory 必过门槛；保留低复杂度检查时，不应使普通更新阻断已合法供给的本轮任务。
- 以 [D-058](docs/DECISIONS.md#d-058--experimental-simplicity-and-user-request-boundaries) 解释新范围。历史严格语义的失败证据保留，不改写为通过；full_memory 仍按尚未完成的核心能力判断，不能整体改绿。
- Stella Core 与沧海仓库协同并行开发，不能孤立设计。沧海 `dev` 正供旧版 Stella 生产使用：新旧目录可并存，不破坏旧路径、移动/删除生产数据或切换生产消费指针。先确认契约与完整可变路径，按明确版本和单写者协调；分目录不等于 Git/事务隔离，不放宽 clean/CAS。遵循 [D-060](docs/DECISIONS.md#d-060--coordinate-core-and-canghai-without-disrupting-legacy-production) 与 [协调约定](docs/CORE-CANGHAI-COORDINATION.md)。

## Architecture invariants

- 凡是需要理解多变自然语言含义的路由、分类或候选选择，必须使用 LLM 做结构化语义判断；禁止用关键词、正则、字符串包含或词面打分代替语义理解。确定性代码只负责结构校验、权限边界、容量限制和执行已选结果。
- 除非已经证明功能语义不受损失，否则禁止 fallback、静默降级或把错误转换成表面成功。每条架构路径必须有明确预期：满足完整契约才成功，否则显式失败并保留可诊断的失败类别。
- Stella 是 OpenClaw 插件，应优先兼容宿主可验证的生命周期与载荷变换；对宿主行为的兼容须绑定实际输入、来源和最终模型消费，不得把未知改写或未授权历史视为已验证内容。
- 核查 Stella 1.0 必须读取沧海 `dev` 并记录解析后的提交 SHA；当前基于 Core 改造的测试分支及其新增资产不能当作 1.0，运行时仍使用显式配置的源引用。
- 数据源集中于个人数字仓库是产品要求，Git 是当前承载方式；当前完整 Git 副本必须包含全部留存原始资料及附件，不能仅保存库外引用，也不能将 Git 推定为永久技术选型。
- 不设计自然语言“忘记某件事”功能；用户直接修改或删除存储文件后同步记忆，系统负责索引及依赖理解与新仓库状态一致。
- 社交状态判断按用户求助触发，利用已有历史和最新证据回答；不扩展为主动跟进关系或主动提醒关系变化，其他已确认的主动能力保留。
- 写作协作先核对作者原意与未决问题，不默认添加积极意义或励志结尾；作者纠正后更新理解，不能用助手偏好的结论替换原意。

### Product requirements

Read `docs/09-REQUIREMENTS-ALIGNMENT.md` for confirmed product requirements and `docs/10-DESIGN-BASELINE.md` for current contracts, state machines, acceptance and known implementation gaps. Use the domain terms in `CONTEXT.md`. Keep product requirements distinct from Alpha implementation limits and automated diagnostic scores. Closed Issues and historical handoffs cannot override the current baseline or supply authorization for a new task.

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `tower1229/Stella-Core`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and the existing decision log `docs/DECISIONS.md`. See `docs/agents/domain.md`.
