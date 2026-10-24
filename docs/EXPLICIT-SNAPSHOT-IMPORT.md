# 显式数据快照导入

这是 `core_checkpoint` 的本地 operator 维护操作，复用现有 memory transaction、Git commit、
journal 与 authority CAS。它不自动发现、合并或采用沧海 dev/HEAD，不是 Agent 模型工具，
也不提供资料授权或后台同步。npm 包版本与 Core 消费契约版本分别记录；目前后者为
`3.0.0-alpha.0`。

## 一次明确操作

仅 `operator.admin` 可调用既有 `stella.checkpoint` RPC：

```json
{
  "action": "import",
  "expectedRevision": "<当前 authority 的完整 SHA>",
  "expectedToken": "<同一 authority token>",
  "candidateRoot": "/absolute/local/isolated-producer",
  "producerBaseRevision": "<显式生产者前置 SHA>",
  "candidateRevision": "<显式候选完整 SHA>",
  "operationId": "selected_snapshot_01"
}
```

operator 先读取 status，再保留这一原 expected tuple；冲突不能靠重读当前值后偷偷重试。
候选是独立、canonical、无 alternates 的本地 Git 仓库，干净且检出准确 candidate；不得给
远端 URL。候选先通过实际 manifest/profile/binding loader 兼容检查，所有导入字节取自
所选 Git blob。当前消费 catalog 必须与 producerBase 的原始 catalog 字节相同；已有本地
归档等差异会冲突拒绝，首批不做通用 merge。

若生产者先提交金融原始快照 F、再提交其投影 G，选 F 为 producerBase、G 为 candidate：
F 的 catalog 仍是旧版本，F→G 才是受限投影差异。F 随 G 的本地 Git 对象保留在消费库，
不覆盖消费工作树里的原始 CSV，不把 G 直接当成消费 authority。

## 这次允许导入什么

- 只更新声明的 catalog，以及 objectRoot/payloadRoot 中被引用的新不可变文件。只更新
  已有 Source/Evidence/coverage ID；旧版本与字节保留，current 可转 superseded。
- Source origin、policy、Evidence 作者/归属与逻辑范围保持；对象版本、字节 hash、引用、
  selector、payload 和依赖闭包须有效。schema、未知文件、删除、覆盖旧 payload 或扩展来源
  身份会明确拒绝。此批只处理无有损转换的 UTF-8 数据，不新增附件适配。
- manifest/profile、processing grant、policy、其他派生 catalog 分组不导入；消费侧身份
  和配置覆层保留。新 Source 版本若需要 v3 reviewed descriptor，必须已在消费侧 grant 中
  显式声明其精确版本/分段，缺失则写前拒绝。导入不复制候选 grant、不重绑定描述、不把
  数据可解析或 domain allowed_uses 当授权。

合成成功夹具在初始化之前预审了旧/新两个精确版本。此做法不是对真实资料增加授权；
真实新版本缺少审核元数据时仍须按原审批边界处理，不能以测试通过为凭据。

## 发布、失败和接续

导入校验完成且原 expected 仍成立后，受限本地 fetch 将准确 candidate pin 到
`refs/stella/imports/<candidate SHA>`。它只保留原始对象和祖先，是准备态，不移动 HEAD、
不推进 authority，也不代表模型消费。失败可留下未消费的 pin；不自动删除用户资料。

唯一 writer 随后使用原 expected、精确文件计划和 v2 journal，形成 Core 自己的直接子
提交，再 CAS 发布消费 revision/token。响应记录 producer candidate 与 Core commit，
`consumed:false`、`full_memory:false`；下一用户请求重新按现有权限/当前 authority 取工具
数据。同一正常会话的过去对话可以保留，不作为当前来源或权限证明。

冲突或无效输入在改工作树/authority前拒绝。写盘、Git提交或发布阶段的实际故障，沿用
已有 marker/fence 阻止读到部分结果；不承诺所有磁盘字节回滚。保留原候选、副本路径、
operationId、expected tuple 与 journal，使用同一请求接续；换候选或重写 expected 不能
冒充重放。不自动 reset/hard、偷锁、回退 authority 或绕过 pending。导入期间已有请求需
排空，新 Agent 请求明确暂拒；没有运行中撤权或输出拦截机制。

## 证据层级

单元/故障测试验证真实临时 Git+锁/CAS，不替代 Host 消费证明。独立实验 CI 用同一安装包、
原版 Host、合成资料和 loopback fake provider，验证导入后下一请求的实际工具输出与模型
wire、旧 expected 冲突及 cleanup；fake 答案不证明真实模型语义质量。完整能力工作流及
full_memory、真实 main/profile/grant、真实模型/费用、生产切换仍分别验收。
