# Praxis Episode Contract

现行写入目标：`stella.praxis-episode/v2`。[v2 Schema](../../schemas/praxis-episode-v2.schema.json)定义结构，本契约定义时序、来源和跨对象不变量。现有 runtime 的 v1 读取属于待迁移实现，不是并行的现行行为规范。

## 1. 事项与学习

Episode 记录一个现实决策事项。多轮澄清、拒绝和建议修正关联同一事项，不以消息条数决定 Episode 数量。写作共思和无行动的理解更新使用 [Memory Lifecycle](MEMORY-LIFECYCLE.md)，不强造预测或 outcome。

预测只在有意义的选择且结果尚未知时产生；重要预测在建议释放前封存。实际使用的 Twin／IR 版本以 historicalInputRefs 记录。已经知道结果的历史记录可以留存，但不能伪装为新的事前预测。

## 2. 状态机

| 起始 | 目标 | 条件 |
| --- | --- | --- |
| 无 | open | 稳定事项 ID、来源和 situation 完整；有意义的预测已封存 |
| open | recommended | 保存建议；适用的 critical 持久化已确认，投递状态独立记录 |
| recommended | recommended | 同一事项的新建议有来源，记录修订；不改事前预测 |
| recommended | acted | 有 user_report／tool_observation／system_event 的真实行动证据 |
| acted | observing | 行动已确认，结果尚未完成 |
| recommended／acted／observing | closed | 同一事务记录实际行动、结果及学习评估 |
| open／recommended | abandoned／expired | 有明确放弃或期限依据，不能由未回复推断 |
| closed／abandoned／expired | 原状态 | 只追加有来源的纠正／评估历史；不得重开以改写旧预测 |

closed 的后续纠正以 LearningChange 修正当前理解，原预测与过去报告保留原貌。新的现实决策另建 Episode 并明确关联。acted／observing 无结果时可以继续保持，不强制编造 closure。

表中未列出的转换拒绝。相同操作重复处理返回原结果；同一版本的并发更新必须 CAS 冲突。流程状态与 current-evidence eligibility 分开；历史 Episode 可以完整存在而不能作为当前建议依据。

## 3. 字段与序列化

所有顶层记录使用 UTF-8 JSON；人类注释可保存在同目录 notes.md，由定位关联，自动更新不得覆盖。

```text
<episode-root>/<episode-id>/
  episode.json
  prediction.json    # 仅有封存预测时存在；创建后不可变
  notes.md           # 可选，主人维护
```

| 字段 | 必填含义 |
| --- | --- |
| schemaVersion | stella.praxis-episode/v2 |
| id / status / createdAt / updatedAt | 稳定 ID、上述状态、带时区时间 |
| recoveryPriority | normal 或 important；关键未完成事项标 important |
| provenance | agentId、sessionId、runId 可选；这些是追踪字段，不构成恢复依赖 |
| historicalInputRefs | 确定版本的来源／Twin／IR 引用，可为空但不得伪造来源 |
| situation | summary、domains、observations 必填；interpretations、unknowns、goals、actors 等按需 |
| twin | hypothesisRefs 可选；prediction 可选，出现时须与独立 prediction.json 字节／规范化内容一致 |
| framework / reality | 精确执行版本、operator 标识和实际使用来源类别 |
| decision | recommended 及其后阶段必填 recommendation、rationale；actionGate 可选 |
| actual | acted／observing／closed 必填 action、occurredAt、recordedAt、source、evidenceRefs |
| outcome | closed 必填 observations、result、observedAt、evidenceRefs |
| learning | closed 必填 algorithmVersion、predictionAssessment、evidenceRefs、twin、praxis |
| retrospective | 可选的主人认可／后悔及证据；不要求每次反馈评分 |

Ref 采用 Memory Lifecycle 的 { id, version }，版本对确定内容计算。observations 中的文字只是表述，实际行动／结果的 evidenceRefs 必须解析到对应原始片段。

actual.source 仅允许 user_report、tool_observation、system_event。推断行动只能存入 situation.interpretations，不能用于 acted／closed。occurredAt 未知时显式 null，recordedAt 保存记录时间；outcome.observedAt 表示真实观察／报告结果的时间，不能替代行动发生时间。

learning.predictionAssessment 为 supported／countered／unresolved。没有预测时只能 unresolved。关闭需要评估记录，但自然事件可以不产生新的 Twin／Praxis 变化，此时两个数组为空并记录适用评估依据；Alpha 专用验收案例必须实际产生至少一项更新并后续使用。算法版本、模型／提示词和更新解释在关联 LearningChange 中保存。

## 4. 预测与建议

prediction 包含 possibleActions、likelyInterpretations、keyFactors；possibleActions 值在 [0,1]，至少一个候选，总和与 1 的绝对误差不得超过 1e-6。封存记录来源版本与时间；事后修改预测字段、prediction.json 或其关联 hash 均失败。

有预测的 Episode 在建议释放前须完成封存的 critical 同步。无预测的事项不为匹配存储接口补造一个分布。建议更新使用新的记录版本，保留旧建议与该次取证版本；“已投递”依据 Host receipt，不能由 recommended 状态推断。

## 5. 历史与当前引用

historicalInputRefs 按封存时的来源版本验证，不与当前 Twin 文件强制相等。源变更触发当前理解重评；不能篡改旧 pin 使校验表面通过。

原始来源被主人删除后，Episode 仍保留其历史身份和不可变预测，但其相关内容不得经正常检索、旧摘要或旧 Git 自动重新引入。存取资格与依赖处理按 Memory Lifecycle；没有删除历史／备份的自动功能。

## 6. 结果和学习

结果来源优先为主人后续报告或真实工具事件。LLM 根据相关事项、角色、时间和内容判断匹配；有歧义就保留待关联证据或澄清，不强行关联最近事项。

反馈可以先更新工作理解，之后才有结果。明确拒绝但未行动不进入 acted。认可协作不等于采纳观点，也不等于发生行动。

Outcome 更新为原子版本变化：actual、outcome、learning 同时有效；错误时不得暴露半个 closed。重试通过 operationId 去重，不能加倍更新统计。社交不主动跟进；其他已授权交流按既定时机规则。

## 7. 持久化与恢复

critical 写入需 commit、persistent pointer CAS 和远端确认。normal 写入可在显式 RPO 内待同步。回复、持久化与投递的完成状态遵循[Host 完成协调](../04-OPENCLAW-INTEGRATION.md#4-必需的完成协调)，不依赖可吞错的 end／finalize 回调作唯一门禁。

恢复所选 revision 中全部声明 Episode；空集合合法。重要开放事项是必须恢复的对象类别，不是仓库必须永远至少有一条该记录的要求。Exact Host fixture 另外验证此类对象不会丢失。

## 8. v1 迁移

v1 Schema 保留为现有资产的解码识别器，不能用于新的 v2 写入或声称满足上述不变量。迁移是显式、一次性版本转换，生成新恢复 revision，不启用双写或 v1 降级运行。

迁移保留 ID、原预测、原建议、原始证据及发生／报告时间的区别。把 sourceSnapshot 转为确定历史版本引用；资料无从核实时标记依赖不可用，不改写 hash 指向最新内容。

inferred actual 不能被自动改成 user_report。找到真实证据才能形成 v2 actual；否则将推断保留为推断，生成迁移问题供核对，禁止把该事件作为已证实行动学习。无法无损转换的状态阻断相应记录激活，不能删除旧历史来通过测试。

当前 runtime、runner 和 fixtures 尚需一起升级以支持 v2；本次契约整理不迁移私人数据，不宣称旧 candidate receipts 已覆盖 v2。
