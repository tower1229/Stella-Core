# 肃清第三批：真实保守互斥与独立读侧 resolver

本批基线 `ec0a17ff35eff8aacb4b11c6323d4a6036b2519f`。完成 Node 标准库保守锁、同一 mutation fence 的本地 checkpoint 适配器，以及 outcome / inventory / acceptance 的独立可选读侧端口。最终全项目类型检查、定向编译通过，**48/48 测试通过**，零失败、取消、跳过；其中 25 项为本批新增检查、23 项为受影响模块回归。固定最终提交、源码 hashes、运行命令/退出码与编译清单见 `.artifacts/suqing-batch3-20261022/delivery.json`。

**SQ-06 整体未完成，生产插件继续 legacy。** 本批未改 plugin.ts、schema、真实配置或真实沧海，没有开放 checkpoint 配置开关、运行 Agent、重启 Gateway、索引操作或 full_memory 验收，也未生成可安装发布包。本批模块可以独立审查与测试，不能据此声称生产读写迁移完成。

## 最小真实互斥与范围

`exclusive-file-lock.ts` 使用 Node `open(O_CREAT|O_EXCL|O_NOFOLLOW,0600)`，不调用 SDK 锁、PID 查询或 `ps`。已有、空白、损坏和崩溃遗留锁一律拒绝，无轮询、重试、超时偷锁、自动回收、目录创建或 chmod。新文件包含版本与随机 nonce；fd 的 dev/ino、文件类型/nlink、完整字节和 canonical 父目录在准入、重入与释放时核验。

同一异步调用链仅可重入仍 holding 的真实 lease；其他调用链和进程不能因同进程“有人持锁”而获准。work 结束时同步转为 releasing，核验结束和执行重入前再次检查状态，旧闭包不得在释放窗口进入。释放先验证自己的 inode/nonce，unlink 后立即退役；即使后续 fsync 失败也不会再次 unlink 删除下一占用者。单独业务失败原样传播；业务与清理同时失败时用 AggregateError，以原业务错误为 cause/首项并保留清理失败。成功业务遇清理失败仍失败。

保证限于合作进程及支持原子排他创建的本地文件系统。它不是针对同账号恶意删锁、目录置换竞态、整机回滚或网络文件系统的强隔离；不声称 Node unlink 的检查与删除之间具备不可攻击的原子条件删除。调用方必须 await 自己在临界区启动的工作；锁不能中止已经逃出回调运行的后台任务。

`local-checkpoint-recovery.ts` 固定 repository key 到现有 `root/.stella-memory-transaction.json.lock`，checkpoint key 到 `checkpoint.json.lock`，继续 repository → checkpoint 顺序。没有另设互不合作的 repository 锁路径。runtime.clean 只有在当前异步链持有并核实该锁的 fd/inode/nonce 时才允许精确的 lock dirt；伪造同名文件无法通过。

旧 binary 的 SDK 锁仍有 stale 回收流程；**同名不代表新旧实现已证明兼容**。采用新适配器前必须 drain 旧 writer，保持单版本合作，且真实业务 writer 必须接入同一 fence。本批未切换这些 writer。崩溃遗留锁会阻塞后续操作，需要明确的人工核对与处理；本批没有实现或执行遗留锁清理。

第二批“必须等待 SDK 的 PID 查询授权才能验证锁”的局部限制已由新的标准库适配器解决；不再把开放 `ps` 当作这条新路径的前置。既有禁止进程查询与 Host 全树读取的限制继续遵守。

## 独立读侧接线

- `recovery-read-binding.ts` 捕获一次完整 mode/binding/revision/token，嵌套复制冻结；后续 assertion 始终验证原 expected，不重新 read 并采纳 B。外部可变 alias、同 SHA 换 token 和版本值 coercion 不能改变旧预期。
- 可关闭 read scope 在入口与异步结果返回前校验生命周期，直接 resolver read/assert 也冻结快照。scope.close 阻断旧闭包后续准入，不宣称已经接入 Host 的全部 stop/reload 路径或能终止已开始工作。
- `outcome-recovery-binding.ts` 增加可选固定绑定；入口同步复制固定，Git authority 文件仍按指定 revision 验证，读前后及返回闭包均核对同一 expected，原三参数 legacy 调用保留。
- `host-memory-inventory.ts` 的同步 execution hash 可显式接收 Core snapshot。仅显式 Core 模式允许 Host 静态旧指针与 Core 动态版本不同；摘要包含完整 authority，agent/root/manifest/dataMode 与其余配置门禁保留。未传 authority 时仍是原 v1 hash 和 legacy 指针相等检查。
- `host-memory-acceptance.ts` 增加可选 resolver；每次验收只捕获一次 expected。captureDependencies 重读配置/profile/catalog 等依赖，但复用相同 expected，避免前段 A、依赖段 B。显式 legacy resolver 仍要求 live Host pointer 相等；默认无 resolver 的调用路径保留。完整 authority 纳入显式模式的依赖和 deployment 摘要。

没有通过删除来源、权限、新鲜度、模型、取消或 full_memory 门禁让结果变绿。`memory-consolidation.ts`、初始化整体及业务 writer 没有接入这些端口，默认 plugin 注册也没有传入新 resolver。

## 已执行与未执行

| 范围 | 实际证据 | 限制 |
| --- | --- | --- |
| 跨 OS 进程互斥 | 一个独立 Node 子进程持有；第二进程拒绝；SIGKILL 持有者后第三进程拒绝遗留锁 | 只测试本轮登记的子进程，无枚举、无自动回收；不是双进程业务 CAS 全矩阵 |
| 所有权/生命周期 | 同链重入、异链拒绝、过期闭包、释放中重入、nonce/替换/hardlink、symlink parent、业务/清理双失败 | 未注入所有 write/fsync 磁盘故障窗口；不宣称抗恶意同账号攻击 |
| 实际适配器 | 合成 Git A→B、真实锁下初始化/CAS、重开与精确 replay；损坏状态/pending/伪造 lock 拒绝 | 实际业务 transaction/publication 仍未接线 |
| 独立读端口 | 冻结/同 SHA 新 token、关闭/异步 scope、可变 alias、执行 hash、缺 authority 提前失败、legacy pointer 不等、outcome 错 scope | acceptance 只验证提前拒绝，无模型请求；outcome 本批未做新端口完整正向业务资料验收 |
| 回归 | 第二批 checkpoint-runtime 测试及已有 inventory 测试 | 23 项回归没有作为新增功能用例；未累加第一/二批总数 |

五个测试文件为 `exclusive-file-lock.test.ts`、`local-checkpoint-recovery.test.ts`、`recovery-read-binding.test.ts`，以及受影响回归 `checkpoint-recovery-runtime.test.ts`、`host-memory-inventory.test.ts`。测试只使用合成资料、项目 `.artifacts` 和本轮 `/tmp` 夹具，不读取私人记忆或真实凭据、不发真实 API、不 push。

独立审查发现并修复释放准入窗口、业务错误被清理错误覆盖、外部 expected alias 和显式 legacy 指针门禁问题，复核未发现这些问题的遗留必须修复项。a1 停于一个类型标注错误；a2 实际已完成 46/46，但返回通道曾断线，期间没有重复启动。恢复先读取 a2 result/log、确认退出码和 owner 文件移除，再核对源码/保护 hashes，完成直接 scope assert 冻结复核；a3 是最后修改后的 48/48，原始失败与恢复证据均保留。

## SQ-06 的下一有界出口

| 部分 | 状态 | 下一步 |
| --- | --- | --- |
| 标准库跨进程锁与 Core checkpoint 适配器 | 已有真实本地进程/文件证据 | 在受控单活条件下接真实 mutation fence；不混用旧 SDK 回收 |
| 三个独立 reader 端口与固定 scope | 已实现；边界/拒绝及回归通过 | 默认 plugin 统一创建/关闭同一 resolver 并传递；补完整源加载与验收依赖正例 |
| 业务 writer、consolidation、提交后 publication | 未接线 | v2 journal 原 expected；按单个 journal 建 writer；只由同一 confirmCommitted 的精确 CAS 返回值建立独立发布阶段，不重读最新值覆盖原 expected |
| initialization-registration / verification binding | 未迁移 | 停止从 live Host pointer 覆写共享 source；入口/异步发布后检生命周期；source/receipt 绑定同一完整快照 |
| 初始化现有 eager Host code-tree identity | 未改、未执行 | 在原版公开插件机制内收敛可获准的实际代码身份边界；不得以延迟全树读取绕过，不能把旧进程标作新磁盘代码 |
| full_memory / 最终 Agent 消费与刷新 | 未启用、未验 | 后续 SQ-07/08 同版本能力与入口矩阵 |

writer 的关键具体缺口是：A→B CAS 后，原 `assertProcessingCurrent` 闭包应继续认为 A 已失效。不能把它的 expected 改成 B 再通过 publication；必须保留原 journal linkage、精确确认结果，并独立重验来源、权限、撤权和取消。现有 `confirmCommitted` 已有可复用返回值，不需要新增通用 Host ACK/transport 平台。

默认生产路径、旧 receipt 与配置兼容没有被提前宣布迁移成功。下一批只关闭 writer/publication/fence 与初始化统一 resolver 这条主线，仍不迁移真实资料、读真实凭据、修改 OpenClaw、重启生产或运行真实模型。四份原有未提交文档/测试继续保留，hash 与基线一致。
