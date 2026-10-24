# 当前 Understanding 的只读供给

`stella_memory_data {"action":"understanding"}` 复用现有 Personal Views，供给本次 Host
本人请求相关且已获来源授权的当前 Understanding；不接受另传 question、owner、路径或版本。
它和只读 Work 共用真实 processing binding、固定模型、viewProcessingModelRefs、精确
committed catalog hash、SourceAccess 及语义选择，没有新增权限模型、writer 或 Host 接口。

## 返回与边界

结果包含 generation、understandings、exclusions、可选 usageConstraints 以及本轮
currentMemory。每项保留 `view:user|memory`、确切 ref 和完整 record；来源使用规则按
understanding/ref 与 view 传递。候选 originals、通用 context 和 Work 不作为此动作输出。
语义选择本身仍会向获准模型提交候选及原始依据；真实运行属于独立外发及计费范围。

USER 只能来自既有 renderer 校验的 active owner_statement，并由主人原始 Evidence
支持；候选假设不能提升为主人确认的事实。MEMORY 可以含暂定或争议解释。scope、status、
supportRefs、counterRefs、dependencyRefs、originChangeId 不改写，不将局部写作前提泛化
成永久偏好。derived record 不是独立证据、工具许可或额外引用授权。

合法空集合与策略排除正常返回，不能解释为全库不存在记忆；声明对象丢失、陈旧 catalog、
缺少真实视图许可、异常模型和正常取消仍显式失败。本功能不改 USER.md 或 MEMORY.md，
不把盘上 bootstrap 与本次动态工具视图混为一件事。

## 缓存与纠正

第一次动作在本次请求的固定 checkpoint 下准备，工具续轮可复用本轮已授权结果；新用户
请求重新准入和读取。结束／取消退休 grant 时清理该缓存。可选的现有纠正工具成功发布后，
只依据 writer 实际 CAS 返回的新 authority 重建 reader 并清除 Work、Understanding、原文、
handle 和 Skill 缓存；旧 permit 不能借新版本继续使用。没有从观测 HEAD 自动升级 expected。

纠正仍须现有来源／用途／派生权限、本轮真实归档 Evidence 和精确事务，默认关闭；读取
Understanding 不自动调用 writer。已合法供给的本轮内容不承诺运行中即时收回，Host 历史
可保留过去对话；它不等于当前 Core 事实。没有代理层、输出拦截或逐轮 reset。

## 验收出口

合成夹具包含一个 active、项目局部的主人陈述及一个 candidate hypothesis，各有独立
LearningChange 与真实合成 owner Evidence。安装包真实 Host 三轮目标为读取 A → 在纠正
轮先读 A 填充缓存，再走公开纠正工具写 B、同轮重读 B → 下一用户请求读 B。应核验实际
provider 请求／响应、分区／scope／status、原规则、一次 semantic commit、当轮新 Evidence、
缓存失效、候选假设保持不变和 USER.md 字节不变；不以模型假响应证明真实语义质量。

本次具体版本与验收结果见[主线矩阵](mainline-global-status-2026-10-24.md)。真实 main
加载、profile／grant、真实语义质量、模型费用和完整 learning/outcome/full_memory 仍分别
验收，不从本只读入口推导通过。与沧海的既有 schema、生产 dev 和消费者无变更。
