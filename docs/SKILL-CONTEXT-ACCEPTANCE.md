# 当前安装包的 Skill 消费与指令预算

2026-10-24。仅收敛 [#31](https://github.com/tower1229/Stella-Core/issues/31) 的纯插件
供给机制窄项。Host 为原版 OpenClaw 2026.8.2；模型为本机 loopback fake provider，
模拟 `google/gemini-3.8-flash`/low 协议，不调用真实 API。Core 运行源码与权限门禁未改动。

## 正常消费

标准 `npm run verify:experimental` 从干净固定源码 build/pack，将 tgz 安装到全新 consumer，
直接加载安装包的 plugin 入口。新增 `skill` 报告与连续聊天、v3 和显式快照导入使用同一包；
不能以临时编译输出、公开包元数据或 observer wrapper 代替实际安装字节。

物化范围仅为 AGENTS、SOUL、IDENTITY、USER、MEMORY 五个 bootstrap 和一个合成受管 Skill。
首次 Skill 发现若拒绝，可停止并启动同一个隔离 Gateway，以原 pending 操作继续；不改源码、
配置或权限。两次消费各使用公开创建的全新会话，验证第一次合法工具供给、记忆 B 更新后
第二次合法供给。普通同 owner 聊天无需逐轮 reset 的能力仍由独立 continuous 场景验证。

每次四份完整 Google 请求依次为：用户请求；Skill 工具返回后的续轮；list 后的续轮；
read 原文后的回答。每份请求核对五文件完整正文，除 `trimEnd()` 外不缩短；比较实际 system
片段与物化文件的 hash，记录实际文件顺序，不规定所有 Host 都必须采用某一排序。
Skill 完整原字节（含 frontmatter）须在工具返回后的三份请求中出现且 hash 完全一致。
记录 Google `systemInstruction` 和 `contents` 的实际角色，functionCall 属于 model，
functionResponse 属于 user；不能只证明目录列出 Skill 或在提示词中发现一个 marker。

## 两种字符预算拒绝

公开配置的 agent 级限制覆盖默认值。正常场景默认单文件限额1、目标 agent 单文件20000、
总量150000；负例分别将目标单文件或总量设为1。预算是 bootstrap 字符限额，
不是模型输出 token、thinking 或费用上限。

- 单文件不足必须由公开 materialize 返回 `host_bootstrap_context_incomplete`。
- 总量不足必须返回 `host_bootstrap_context_missing`。
- 两例均真正发起一次合成 `chat.send`，要求该 run/session 的公开 lifecycle 拒绝及
  `agent.wait` 错误终态，provider 收到的**全部 HTTP**为0。无关错误、超时和无实际尝试不能通过。
- 物化先写六个完整文件再核验 Host 上下文；失败保留 pending/fence，不产生成功 receipt。
  请求前后重读原 pending/operation、六文件与 Git revision，必须完全一致。此结论不称文件
  从未写入、事务自动回滚或 Agent 生命周期从未开始。

聚合器要求六份实际同包报告，并拒绝缺少预算配置、关联拒绝观察、请求后状态、完整 wire、
正确正文 hash、角色、成功进程退出或必要准入负例的证据。原完整能力 workflow 不跳过失败。

## 固定身份与边界

每次验收的精确 source revision、tgz SHA256、安装锁及逐文件摘要、所有命令/退出状态，
保存在 `.artifacts/experimental-owner-chat/<attempt>/receipt.json`，完整合成请求和三个新增
报告保存在同一目录。artifact 不提交。干净固定源码及安装字节须在验收前后不变。

基于旧冻结 `945d7000`/包 `d6e5821b…` 的前置探针已观察到8份全文请求和两个0HTTP拒绝，
只用于完善新探针，不冒作本次新源码包通过。早期失败保留：旧 materialization 夹具 reset
后触发历史 owner 未知拒绝；新会话初次缺少公开幂等创建身份。修订使用已有合成探针的
临时内存设备身份，仍是实际 CLI 及原 operator.admin scopes，不伪造真实网页/Telegram。

这里只证明当前版本的文件/Skill **实际供给**与预算拒绝。假模型按固定协议发工具调用，
不能证明模型理解或遵守指令、写作共思效果、普通知识问答质量，也不覆盖其他 harness。
因此 #31 整体、真实模型验收、私人 main、full_memory 和 #23 均未据此完成；#24 的语义
writer 迁移另行评估。本批不部署真实 main，不改 source grant 或生产 dev。
