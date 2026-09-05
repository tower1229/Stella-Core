# Stella 3.0 Alpha Scope and Acceptance

本文件是 Alpha 范围和出口的唯一维护位置。完整产品要求见[需求记录](09-REQUIREMENTS-ALIGNMENT.md)，通用不变量见[设计基线](10-DESIGN-BASELINE.md)。

## 1. 范围

Alpha 验证一个按需关系／社交决策学习闭环：

```text
主人求助 → 有来源的理解与判断 → 有依据的行动建议
→ 封存预测与记录建议 → 主人后来报告实际行动／结果
→ 一个 Twin 或 Praxis 学习项 → 下次相似问题使用该学习
→ 远端同步 → 干净 Host 恢复
```

预测的实际持久顺序以 Episode 契约为准：建议释放前已经封存。上述示意不是 hook 调用顺序。

OpenClaw 保留模型执行、会话、搜索、工具、权限和调度。Cortex 包含路由、Situation、Twin context、Framework selection、Reality、packet、Episode 和学习协调。

不要求个人 fine-tuning、全量语料迁移、完整 social graph、全自治外部执行或新增持久 Agent。完整记忆和写作契约的设计不自动扩大 Alpha 发布范围。明确禁止的行为适用于所有版本。

## 2. 实现约束

- Exact Alpha Host 为 OpenClaw 2026.8.2；最低兼容声明 2026.8.1 尚需独立验证。
- 语义路由与选择使用结构化 LLM；无词面 fallback。
- 每轮最多两个有来源的 Framework operators，使用精确 active IR。
- read_only 和 local_write 用于隔离验证；Alpha 交付使用 managed_durable_write、明确远端／分支和 RPO。
- Episode 以事项关联，不强制每轮新建，不把建议当实际行动。
- 关键未知可先澄清；仅在取证和请求支持行动时要求行动建议。
- 社交状态按主人求助触发，不安排主动关系跟进。
- 公开代码、fixtures 和 receipts 不含私人原文、事实或私人路径。

## 3. Alpha 工程出口

| ID | 通过条件 |
| --- | --- |
| A-01 | packed plugin 在确切 Host／runner 中加载；目标 agent 增强，非目标 agent 不注入个人资料 |
| A-02 | 来源 revision、兼容性、activationStatus 和必要能力校验失败会明确阻断目标操作 |
| A-03 | 普通请求跳过不必要的认知组装；社交求助正确进入对应 lane |
| A-04 | Situation 区分观察、转述和推断；相关个人上下文及 IR 有可解析来源 |
| A-05 | 情境需要时 Reality 补充实质变量；无需补充时不为凑项编造变量 |
| A-06 | 证据充分案例提供可行下一步；关键未知案例提供有效澄清，二者都不被格式强改 |
| A-07 | 选择预测在建议释放前封存；建议进入 recommended；推断不能成为实际行动 |
| A-08 | 真实后续证据关联正确 Episode；重复输入不重复学习；原预测保持不变 |
| A-09 | 专用学习案例更新至少一个 Twin **或** Praxis 项，后续相似请求检索并使用它 |
| A-10 | critical 已同步、normal RPO 可观察且达标；commit／CAS／push 故障可恢复且不假成功 |
| A-11 | 无旧会话运行态的恢复保留所选 revision 的身份、Twin、精确 IR、学习及声明的重要状态 |
| A-12 | 有重要开放事项的 fixture 验证其恢复；合法空集合 fixture 同样通过，不制造开放事项 |
| A-13 | 回调失败／超时、取消和重启不会把未持久化状态报告为完成 |
| A-14 | Core／CangHai SHA、artifact SHA-256、Host 和 runner、私有用例范围与证据彼此一致 |

以上出口结合设计基线中适用的 G 项判定。仅记录一条学习文字，尚不能证明后续使用；仅存在恢复脚本，尚不能证明可恢复。

## 4. 语义诊断

保留 30–50 个可重复运行的关系／社交案例，当前公共套件为 32 例，覆盖关系沟通、感谢互惠、求助、拒绝、私人事务、礼仪、工作关系与冲突。私有案例留在个人仓库或私有评测位置。

七个诊断维度保留：situationUnderstanding、personalContextUse、frameworkApplication、hiddenVariablesSurfaced、concreteNextAction、ownerFit、retrospectiveEndorsement。rubric 按 responseKind 定义适用语义：必要澄清无需确定行动，无 outcome 不编造认可，无需框架或额外变量时不强凑内容。报告明确每维结果及理由。

公共案例只使用其合成个人背景；私有案例限定在获授权资料内。评测记录固定模型、prompt／rubric 版本和证据截止时间，不能使用后续结果污染过去判断。

工程候选要求配置的诊断门禁通过；它证明该套回归满足约定，不证明实际建议有效。真实效果依赖主人自然反馈，不增加问卷或主观 A/B 分数门禁。

## 5. 候选证据与完成声明

候选仍要求同一干净 Core SHA、确切 tarball、最终同步的 CangHai SHA、OpenClaw 2026.8.2，以及私有 write-loop、clean recovery、durability 和混合评测证据。公开合成结果不能代替私有 Exact Host 验证。

旧 candidate v2 receipt 只证明其记录的旧测试范围；在 A-01–A-14 收敛后，适配器／报告必须明确包含新的完成与空状态断言。不得仅因 receipt 的 candidate=true 宣称新增契约已验收。

候选、commit、push、CI、激活和发布分别报告。生成候选不自动创建 tag、Release、npm 发布或生产部署。实际运行方式见[本地集成](08-LOCAL-DEV-INTEGRATION.md)。

## 6. 完整产品的进一步验收

完整记忆以 [Memory Lifecycle 的 M 项](contracts/MEMORY-LIFECYCLE.md#7-完整记忆验收)为准，包括全量原件覆盖、跨来源检索、交互纠正、写作接续及变更传播。Alpha 出口不代替这些检查，也不把尚未通过的功能写成已完成。
