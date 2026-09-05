# Praxis Runtime Protocol

现行规范入口：[设计基线](10-DESIGN-BASELINE.md)。本协议定义目标行为；当前源码差异在基线中单列。

## 1. 路由与响应语义

五条 Cortex lane 保持不变：

| mode | 语义 |
| --- | --- |
| ordinary | 不需要个人资料的知识或通用工作 |
| twin | 主要依赖主人理解、个人记忆、文章意图或共同思考 |
| praxis | 结合主人、框架与现实证据判断一个决策事项 |
| deep_praxis | 上述事项还需要外部取证或深入跨来源检索 |
| outcome | 存在可关联的行动／结果证据，更新已有 Episode |

LLM 根据当前请求、已恢复工作上下文和可用来源做结构化路由；确定性逻辑只校验字段、权限和资源。普通回忆、写作共思及拒绝／纠正不需要新增持久 Agent：使用 twin 或原事项 lane，并按需调用记忆契约。

路由输出是执行计划，不能将材料不足误判为 ordinary 以避开所需检索。以下为逻辑接口，不是声称当前 router 已有这些字段：

```ts
type TurnPlan = {
  mode: "ordinary" | "twin" | "praxis" | "deep_praxis" | "outcome";
  responseKind: "answer" | "clarification" | "collaboration" | "action_advice" | "outcome_ack";
  domains: string[];
  workId?: string;
  episodeId?: string;
  retrievalRequired: boolean;
  needsTwin: boolean;
  needsFramework: boolean;
  needsReality: boolean;
  needsExternalResearch: boolean;
  materialUnknowns: string[];
};
```

responseKind 随取证结果修订，不由初次路由锁死。已有授权与解释直接使用；不能为了字段完整重问主人。

## 2. 当轮流程

```text
Host 接收并记录输入
→ 核对实例、源 revision 和必要能力
→ 恢复当前工作与来源覆盖
→ LLM 路由并规划取证
→ Memory retrieve / 原文核对 / 反证和时序检查
→ 主人理解 + 必要的 Framework operators + Reality
→ 判定适当响应类型
→ 有意义的选择预测封存（如适用）
→ 生成回答、澄清、共同推演或行动建议
→ 语义与权限校验
→ 学习 / 工作上下文 / Episode 更新及持久化确认
→ Host 投递并记录结果
```

ordinary 可跳过不必要的个人检索和预测，仍执行实例与权限门禁。资料的接入、证据充分性、交互学习与变更同步依照 [Memory Lifecycle](contracts/MEMORY-LIFECYCLE.md)。

## 3. Situation 与证据

Situation 保存 actors、observations、interpretations、unknowns、userGoals、constraints，以及适用的 stakes、reversibility 和 socialContext。每个重要断言通过 EvidenceBundle 中的 claim 关联到证据，不能仅靠一组无来源字符串证明事实正确。

社交问题按主人的求助恢复纵向行为、互惠、主动性、回复实质及变化；人物角色、年龄或性格只是相关背景。未知动机不阻止有证据的投入风险判断。历史回放限制当时已可取得的证据。社交新资料不触发主动关系交流。

写作先恢复主稿、配套意图／反馈和 OngoingWork；共同检查前提及论证。候选结论不成为主人信念；认可协作不表示文章完成。具体内容遵循需求记录，不将一种固定结尾或积极态度写成运行规则。

## 4. Twin、Framework、Reality

Twin 只提供情境相关且当前有效的理解，不默认灌入全人格画像。有意义的选择预测记录采用的假设版本、可能行动与依据；已经知道结果的事项不再补造事前预测。

Framework 以认知工作选择，Alpha 每轮最多两个 operators；完整产品以最小充分集合为准。读取精确 active IR，不在每轮重新编译。原框架与实践经验分别保存；未经采纳的提案不能激活。

Reality 区分基础世界知识、个人实践经验和外部来源。当前、专业或具体事实需要相应外部取证；不能因外部能力故障直接改称基础模型知识足够。临时研究代理仅获授权且足够的任务简报。

## 5. Context packet

Packet 是取证后的有界投影，必含 mode 和 responseKind；个人取证路径还须带 EvidenceBundle 定位及来源 revision／generation。工作／事件 ID、Twin 版本、精确 IR/operator 引用和现实不确定性按实际参与情况携带，不强造未使用对象。

它保持主张与依据、事实与推断的关联。小候选集合或字符上限不能充当充分性标准；超出容量时继续分段取证或显式报告资源失败，不能静默丢弃重要来源。自然语言回答无需暴露内部 packet。

## 6. 回答与 finalization

| responseKind | 完成条件 |
| --- | --- |
| answer | 回答实际问题，区分依据和不确定性 |
| clarification | 已先查证；指出关键未知并提出可回答的问题，不给出依赖未知的确定建议 |
| collaboration | 推进一个具体卡点，保留已确认前提、候选和未决问题 |
| action_advice | 证据足以支持的具体下一步及适用条件；可建议放缓、退出或暂不行动 |
| outcome_ack | 说明已关联的事项及有依据的更新；写入状态与实际情况一致 |

finalization 最多一次结构修正，按 responseKind 检查，不能重复整套人格分析。修正后仍不符合契约则显式失败。它不是可以吞掉持久化故障的成功门禁；Host 接口保证见[集成契约](04-OPENCLAW-INTEGRATION.md)。

## 7. Action Gate

授权来自当前明确指令或仍有效的委托。语义判断请求是否在范围内，确定性检查执行权限、目标和后果范围：

- A：已授权的可逆内部整理、检索和准备。
- B：准备外部动作，不执行外部副作用。
- C：执行有覆盖授权的普通外部操作。
- D：高影响或不可逆后果也须被明确授权覆盖。

有效旧授权不重复询问；模型信心和历史满意度不扩张权限。当前 Alpha 只建议／准备。完整产品代办使用 Host 工具与调度，执行前复查委托状态；结果不明先查执行 receipt，不能盲目重发。

## 8. Episode 与交互学习

Episode 以现实事项为单位，同一事项的澄清与拒绝不重复创建事件。是否关联由 LLM 根据工作和来源判断，含糊时不强关联。

有意义的选择预测必须在建议释放前封存并记录所见版本。保存建议进入 recommended，实际投递独立确认；真实行动证据才能进入 acted。仅有推断不能转换为 acted。实际行动、结果和学习可在一次有证据的更新中从 recommended 原子进入 closed。完整状态机以 [Episode 契约](contracts/PRAXIS-EPISODE.md) 为准。

主人纠正、拒绝原因及写作进展走 learn／OngoingWork，可先于 Episode 关闭更新理解。没有实际行动时不得制造 outcome。关闭事件不必都改变 Twin；Alpha 的专用验证案例需要产生并再次使用至少一个 Twin **或** Praxis 更新。

结果优先从后续主人消息／工具证据被动关联。禁止主动跟进关系；其他主动交流只有满足已确认的价值、时机和委托规则才可投递。

## 9. 完成与故障

状态分别表达取证、响应、持久化和投递。critical 更新须提交并确认远端同步，normal 更新允许明确 RPO 内 remote_pending；失败不声称学习已全部保存。

不能把 before_prompt_build、before_agent_finalize 或 agent_end 抛错等同于 Host 必然阻断。正确路径必须提供显式完成记录、持久操作 ID、超时后的协调和重启恢复；不能靠回调名推断成功。

来源修改后，当前取证及理解按 generation 重新核对；历史预测仍按封存版本验证。取消、能力缺失、写冲突和资源耗尽都保留具体类别，不能返回普通成功掩盖未完成工作。
