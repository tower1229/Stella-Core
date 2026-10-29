# 分段Source纠正精确回读窄修（2026-10-29，限定离线独审通过）

基线 `ebf2d35c58091f4915c32752a4480caeafbd139b`。生产只修改 `personal-views.ts`、`checkpoint-source-access.ts`、`checkpoint-agent-supply.ts`，并复用两个既有测试/夹具文件；没有新生产模块。当前结果及原始hash见[机器摘要](verification-summary.json)，唯一当前状态见[PROJECT-STATE](../../../PROJECT-STATE.yaml)。本证据快照在普通提交/推送前捕获，不是运行时部署证明。

## 改动及保留边界

普通视图原有Source分支的元数据检查提取为共用函数：读取当前Source、校验声明的父policy/coverage依赖、父policy owner及原有derive处理资格。普通视图继续使用同一规则和快照读取。回读通过既有请求绑定context核对真实加载的processing grant、model、owner、purpose、owner-direct audience及receipt revision的catalog，再调用该元数据检查。

v1仍执行原整源 `assertSourceAccess`；v2元数据准入不代表正文许可。精确内核闭包、Evidence覆盖与 `readEvidence()` 的locator、父/片段policy交集和精确descriptor检查均未改。没有用无segment的 `assertSourceMetadataAccess` 代替，也没有新增整源grant、owner放行或身份路由。writer、receipt、CAS、resolver及native包装未改。

## 红绿证据及计数

原[红例摘要](../2026-10-29-segmented-correction-readback-repro/verification-summary.json)按字节保留：原12项通过，合法A-only新增项因 `readback_failed / segmented_source_requires_evidence` 失败。这里同时保存[红测试补丁JSON](red-tests-patch.json)，提取JSON的patch字段后可对固定基线应用复现；它是历史证据，不是额外活动实现。

修后有效定向验证 **141/141**，0失败/取消/跳过/TODO：

- 同一注册工具文件分段组13项，含合法A、独立parent/fragment均允许的正例、九类拒绝以及提交后拒绝/恢复。
- 同文件原12项v1/参数/owner/旧permit/入场grant/幂等/下一请求边界12/12；使用明确的正向名称筛选，与分段组不重叠。
- 普通视图及native/evidence/correction精确回读四文件116/116。

独审在独立临时副本应用冻结补丁并重新编译，无名称筛选运行完整注册文件25/25，再运行相关四文件116/116，独立 **141/141**。作者141与独审141是两轮相同范围执行，不能相加成282个独立用例。[独审摘要](independent-review.json)保存源报告/hash、冻结11文件及补丁hash、25/116原始结果和边界；源摘要SHA-256为 `097b91da6d1d281b7ff73580fb56df1db40d87482d0f51e4f38cd7d07cae9681`。独审后仅补非敏感证据和状态，三个生产文件与两个测试文件的已审hash不变。

提交前经授权通道fresh读取远端，确认现有开发分支与本地基线均为上述ebf2d35c；基线不是将包含本证据更新的提交身份。独审自身正常结束并清理其两个新记录进程组/临时源码副本，不能据此追认作者更早未知group已清理。

一次单用例预览不重复累加。首轮原12项筛选使用负向表达式，实际包含新增分段用例，150秒运行器中断且无终态计数；该轮不计通过，原日志hash保留。改为明确正向名称后12项完整结束。没有扩大120秒用例阈值、删除/跳过断言或改变正式gate。

`WORK_GOAL_B` 是纠正后的目标文本，`synthetic-work-fragment-B` 是另一段被拒Evidence，二者不同。合法Work只依赖A段及独立获准owner输入；Source声明B的结构元数据不等于Work依赖B正文。

| 夹具边界 | 实际拒绝/成功 | 正文与提交范围 |
| --- | --- | --- |
| 同策略A-only及不同parent/fragment均允许 | 精确回读成功 | B payload0；单次writer |
| fragment允许、父policy拒绝 | `permission_denied`，纠正scope不完整 | A/B payload0，受保护Work0，提交0 |
| Work直接/derivedFrom依赖B | `permission_denied`，纠正scope不完整 | B payload0、Work0、提交0；derived路径已获准A读取单列 |
| 精确parent/fragment descriptor缺失或错绑 | `personal_context_descriptor_required` | A/B payload0、Work0、提交0 |
| v2无Evidence覆盖 | `segmented_source_requires_evidence` | A/B payload0、Work0、提交0 |
| locator跨段或Evidence错policy | `evidence_segment_policy_mismatch` | A/B payload0、Work0、提交0 |
| 合法纠正提交后，固定上下文判断拒绝回读 | `local_committed + readback_failed`，documents为空 | receipt保留；无permit仍拒绝；恢复后同receipt只读，无重复推断/提交，B payload0 |

九个无效夹具在普通视图/纠正提交前被拒，不能写成九个已经提交的坏目标都走过回读；提交后失败重试由独立的合法v2用例验证。正文指标是 `CatalogReader.readPayload` 调用与受保护Work释放，不能写成全部I/O为0，也不证明共享文件内部字节隔离。固定结构模型桩没有真实模型/语义验收。

## 验证与剩余边界

test编译、typecheck、9项schema、diff和本地链接检查通过。最终三组进程组均确认结束，专属运行树已删除。**早期中断轮次的进程组探测返回EPERM，原运行器未记录PID，其运行树保留**；后续获准的定向进程查询未找到该测试Node CLI/文件进程，但不据此冒称精确group清理已证。SDK的active-leases、close-unconfirmed和晚关闭ENOENT警告仍在，未宣称drain。

未运行真实Host、真实模型、打包分段消费者或全量CI；旧26失败、152 probes未运行及formal gate false保持原身份。未改主资料权限、配置、凭据、SDK、SQL桥、native slot或版本门槛。本阶段只普通提交/推送已审12文件，不部署、不重探或猜杀旧group；后续按精确SHA只读观察CI，再另行限定独立小包，不扩大本次验收结论。
