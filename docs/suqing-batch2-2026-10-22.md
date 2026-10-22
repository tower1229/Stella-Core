# 肃清第二批：SQ-06 隔离 checkpoint 运行接线

本批在 `4233e2acdb98b0b5cc8661d1d045ce46289c7183` 上完成一条可审计的纯 Core 隔离闭环：显式初始化 A → 固定原 expected 的 v2 journal → 实际本地 Git 提交 B → checkpoint 精确 CAS → 重开 resolver/loader 读取 B。最终类型检查通过，针对测试 **36/36** 通过，零失败、取消、跳过。最终提交、逐文件 SHA256 和命令/退出码见 `.artifacts/suqing-batch2-20261022/delivery.json` 与 `verification-a4/`。

**SQ-06 整体仍未完成。** 生产插件默认继续 legacy 模式；本批没有新增面向用户的 checkpoint 配置开关、切换全部 reader、迁移真实沧海、启用 full_memory 或构建可安装发布包。不能把隔离读取 B 说成 OpenClaw/Agent 最终消费 B。

## 本批代码与状态语义

- `recovery-authority-contract.ts` 提供单一 `RecoveryAuthorityResolver` 与完整 `mode/binding/revision/token` 快照。checkpoint 表示 Core 权威源版本，不表示目标已物化或已消费；目标由原 transaction journal 记录，文件消费者进度仍属后续任务。
- `checkpoint-recovery-runtime.ts` 接通既有 checkpoint store 与 Git/journal 认证。必须显式注入 repository、checkpoint 两个共享锁端口，按 repository → checkpoint 顺序获取；缺任一端口，在读路径/打开 store 前拒绝。没有生产默认锁或 pass-through fallback。
- `memory-transaction-plan.ts` 抽取既有计划类型；`memory-transaction-journal.ts` 是原日志的唯一 codec。v1 没有 checkpoint 预期，继续作为旧模式日志；v2 额外携带固定 binding 和原 `{revision,token}`，摘要覆盖这些字段。没有第二套 journal、epoch 或许可平台。
- `memory-transaction.ts` 复用 codec，原 mutation lock、pending marker 和发布流程保留。现有业务 writer 本批尚不自动创建 v2 原 expected；隔离调用方在操作开始时显式冻结它。
- `GitCangHaiDurability.checkpointRecovery` 接收绑定单个不可变 journalPath 的回调，和 legacy `onRevision` 互斥，非法回调构造时拒绝。checkpoint 模式每次确认都重新认证，不能因 SHA 相同跳过 token/journal 检查。
- `RecoveryBoundLoader` 每次读取 authority；cache/inflight 按完整快照和本地 invalidation 代次隔离。晚完成的 A 不能覆盖 B 或删除 B 的 inflight，失败不升级 expected、不回退到旧 cache。
- `ConsciousnessLoader` 从 plugin.ts 抽出并共享上述 loader。默认仍显式使用 legacy 配置；checkpoint setter 禁止修改旧配置指针。所有来源、权限、新鲜度与 full_memory 门禁保留。

日志版本只允许严格字符串，数组/嵌套数组即使有正确摘要也拒绝。codec 保留旧格式声明支持的显式 `encoding:"utf8"` 字段，避免抽取后写入被无必要拒绝；这还修复了原 decoder 规范化时丢弃该字段导致精确重放拒绝的问题。无 encoding 的旧 canonical golden 与 base64 golden 保持原字节。

## 初始化、提交与崩溃接续

初始化由调用方显式提供完整 SHA 和 operationId。要求 canonical Git root、HEAD 等于选定 SHA、manifest 是普通 Git blob 且工作文件字节相同、工作树干净、没有 pending；缺少 checkpoint 的普通 read 只报 missing，不自动采纳 HEAD、旧配置或 seed。状态目录必须预先存在且位于 Git 仓库之外；继承首批可信目录/共享锁前提，不更改已有权限。

提交确认要求 B 是原 expected A 的唯一直接子提交；当前 HEAD 必须为 B；journal 在 A 不存在，在 B 的字节有效且工作文件一致。实际 Git 变更集合必须恰为计划文件+journal，各 A/before、B/after 与工作字节均一致。严格 base64、路径冲突、普通文件/非符号链接、隐藏 index 标记和脏工作树检查均保留。只允许字节等于该 journal 的精确 pending marker；不允许其他 lock、ignored 或 untracked 项冒充干净状态。

只有以上认证完成后才用 journal 原 expected/token/operationId 做 CAS。提交后 CAS 前失败，重试同一 O 不产生第二个 Git commit；CAS 已写盘但确认丢失，重开后按原 O 重放，token 保持不变。不同输入复用 operationId、同 SHA 已换 token、错误 binding、旧日志或无关 HEAD 均拒绝；不从最新观测值修补原预期。

确认成功不清 pending、不发布视图、不执行同步，也不发放消费回执。checkpoint 模式 durability 的初始化/diagnostics 不因发现旧 pending Git history 就自动确认、排定恢复 push 或推送；本次隔离测试的 normal batching 显式使用不执行的 scheduler，且 synchronize stage 立即拒绝。后续真实 writer 必须在原 mutation fence 中正确重入这两个共享锁端口，不能拿测试 serializer 替代。

## 已执行验收与证据

| 层面 | 本批实际验证 | 证据边界 |
| --- | --- | --- |
| 编译 | 全项目 `tsc -p tsconfig.json --noEmit`；三份测试及依赖定向编译 | 不执行 plugin.ts 顶层初始化 |
| 迁移主路径 | 真实本地 Git A→B、durability callback、checkpoint CAS、重开 resolver 与 loader | 合成 manifest/记忆；loader 通过 fixture Git blob 读取，不是 Agent 消费 |
| 故障接续 | commit 后 CAS 前失败；接受后确认丢失；同 O 重放且不多提交/换 token | 确定性异常注入；本批不是 SIGKILL 崩溃矩阵 |
| 拒绝 | 缺锁、missing、脏初始化、缺 manifest、v1、binding、journal 改写、无关 HEAD、operation 复用、stale token、pending 初始化 | 未穷尽全部 Git/文件系统/消费者故障 |
| 缓存 | 晚 A、同 SHA 换 token、invalidate/ABA、cache 每次校验、TTL、共享 inflight、错误传递、legacy setter | 进程内 deterministic barriers，无模型请求 |
| Codec | v1/v2 canonical golden、未知字段、摘要、原 expected、版本数组、显式 utf8 | 不把 codec 通过当作完整 transaction/权限验收 |
| durability 观察 | unsynced critical history diagnostics 不调用确认或同步；非法/mixed callback 构造拒绝 | 会读取夹具本地 bare remote；无 `git push`，也没有远端 API |

测试文件：`checkpoint-recovery-runtime.test.ts`、`recovery-bound-loader.test.ts`、`memory-transaction-journal.test.ts`。36 包含负例分组的 4 个子测试。首批的 38 个测试没有在本批重复运行，也没有累加为本版本通过数。

过程日志如实保留：a1 类型缩窄错误，已修复；a2 全项目类型通过，但独立编译漏带仓库已有的 `file-lock-sdk.d.ts`，已修正编译输入；a3 使用相同源码的 a2 类型检查，35/35 通过；显式 utf8 兼容修复后 a4 全部重验，36/36 通过。失败批次没有算通过。

独立只读审查发现并修复版本 coercion 与 callback 校验两项缺陷；runtime 的原 expected、单父/路径/字节认证未发现必须修复项。尚未实际覆盖 merge commit、额外 committed 路径、错误 before、runtime base64 和精确 pending 正反例，不声称这些分支已测。首批原子写/崩溃证据仍独立归档，不能代替新迁移全矩阵。

唯一运行登记、PID、命令、源码 hashes、退出码见 `verification-a4/result.json`。编译文件清单见 `compiled-identity.json`；不是 Host 发布包身份。编译输出只写项目 `.artifacts`，夹具只写本轮 `/tmp/stella-checkpoint-*` 并由自身 cleanup 清理，没有新写 Documents、Desktop 或 iCloud。

## 真实锁与尚未接线项

已按明确公开入口有界核查，没有找到可确认满足当前限制的实际共享锁适配器：

1. 原版公开 `plugin-sdk/file-lock` 的 Darwin 路径会通过 pid-alive 查询进程启动时间并调用此前被拒的 `ps`，本轮未执行或绕过。
2. 公开 async-lock-runtime 只串行单实例 Promise，不具备外置 checkpoint 的跨进程互斥。
3. session-transcript 锁作用于 session/SQLite 和进程内范围，不能伪装成任意外置 checkpoint 的跨进程锁。

这不是宣称原版 Host 不可能提供替代机制；只是本次三条明确接缝没有形成符合限制的已验证适配器。没有继续广搜、改 Host、放宽权限、monkeypatch `ps` 或新建复杂锁框架。合成 repository/checkpoint serializer 只验证调用顺序和独立逻辑，不是双进程/旧 binary 协作证明。

| 实际接缝 | 当前状态 | 后续条件 |
| --- | --- | --- |
| Core checkpoint store/runtime、durability callback、通用 loader | 已接线并隔离验收 | 真实部署前接已验证共享锁 |
| plugin.ts 默认 `ConsciousnessLoader` | 已共享缓存保护；仍 legacy authority | 全部 reader/writer 同批迁移后再暴露配置选择 |
| `recovery-pointer.ts`、plugin 的 `onRevision` | 旧 Host recoveryRevision writer 保留 | 受控单活升级时替换；本批没写真实 Host 配置 |
| `host-memory-acceptance.ts`、`host-memory-inventory.ts` | 仍校验 live Host 配置指针 | 改为相同 resolver，保留独立来源/权限检查 |
| `initialization-registration.ts`、`initialization-verification-binding.ts` | source/receipt 仍耦合旧配置 | 同 resolver 重新绑定；不凭磁盘 ACK 声称消费 |
| `memory-consolidation.ts` 与实际 mutation publication | 保留既有流程，尚未自动冻结 v2 expected | 在一个 fence/一个 journal 中接线和验证 |
| 实际锁/多进程、旧 binary、生产 upgrade、全部崩溃窗口 | 未验 | 不得启用 checkpoint mode 默认入口 |
| bootstrap/index/wiki/Gateway/Agent/full_memory | 本批未运行、未启用 | 后续 SQ-07/08 与同版本入口矩阵 |

初始化/verification 模块现有 eager installed-code identity 会递归读取 Host 安装树；此前全树读取已被拒，本批没有 import/run plugin.ts 或该模块，没有重试或变相读取安装树。全项目类型检查仅编译，不执行这些顶层动作。

## 下一批最小范围与退出标准

SQ-05 store 仍是首批已验资产；本批完成 SQ-06 隔离 runtime/resolver/journal/durability 和相应 SQ-09 夹具，SQ-06 全读写方迁移、真实升级及旧 binary 仍未闭合。SQ-07/08 与 full_memory 状态不前移。

下一批先解决真实共享锁的最小可执行边界：若仍使用现有公开 SDK，需明确允许其对本轮自建且登记的 PID 查询启动时间；该操作包含现被禁止的进程查询，本批不执行、不自动要求用户放宽，也不假定已经获准。若边界不变且无现有公开替代，则继续保留受阻默认入口，不以合成互斥放行。

随后仅做一次受控单活的 SQ-06 集成：一个 stateRoot/显式初始化选择，一个 resolver 覆盖上述全部读写方，原 journal 保存 expected，重入既有 mutation fence，ready/receipt/config-source 重新绑定，旧模式与 unresolved v1 pending 有显式出口。必须证明运行写入不再修改 Host recoveryRevision、失败不自动采纳新值、同 O 崩溃重跑幂等，并补本批未覆盖的必要认证分支。仍先用合成仓库和隔离配置，不运行真实 main 或迁移用户资料。

到该批退出前，不把 Core 权威写盘、物化完成、刷新请求/完成和最终消费混为同一状态；不删除来源/撤权门禁，也不借用旧 Host 覆层或 8d 的真实验收。当前 D028 的实际 plugin 路径尚未被整体替代，本记录不提前宣告架构迁移完成。
