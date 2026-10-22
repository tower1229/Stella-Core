# 肃清首批：Core checkpoint、文件计划与离线故障验证

日期：2026-10-22。状态：**本批离线出口通过，运行接线未开始。**
实现基线：e9b9305e6311e1f9d7b697941577f691988f55fe。后续本地提交身份见本批 delivery.json。
范围沿用 [纯插件边界复核](suqing-m1-plugin-boundary-review-2026-10-22.md)，不再把最终消费证明作为全部纯 Core 工作的共同门槛。

## 本批交付

| 工作 | 实现与边界 | 状态 |
| --- | --- | --- |
| SQ-05 纯 Core | recovery-checkpoint-contract.ts / recovery-checkpoint-store.ts；显式初始化、严格读取、精确 revision+token CAS、最近操作的精确重试、原子落盘 | 本批完成；未替代运行中的 OpenClaw recoveryRevision |
| SQ-07 纯函数 | file-change-plan-contract.ts / file-change-plan.ts；新增、修改、删除、显式非重叠重命名；受管清单、明确观察与用户改动冲突 | 本批完成；只输出 planned，不写文件或刷新消费者 |
| SQ-09 对应离线夹具 | recovery-checkpoint-store.test.ts / file-change-plan.test.ts；确定性互斥与三个写入故障窗口、一次真实 SIGKILL | 本批完成；不是 Exact Host/Agent、生产或全入口矩阵 |
| SQ-06 / SQ-08 / SQ-10–11 | runtime resolver、迁移、真实锁/生命周期、完整 Agent 消费 | 尚未接线或验收 |

公共接口由主写者冻结，三个子代理分别实现存储、checkpoint 测试、文件计划与其测试。主写者审阅集成、统一验证；文件计划另经独立只读审阅，checkpoint 另做独立代码审阅。没有并发编辑同一文件。

## 最小状态与文件计划契约

RecoveryCheckpoint 仅记录 schemaVersion、agent/规范仓库/相对 manifest 绑定、revision、一个局部 token、lastOperationId、lastOperationDigest。revision 是已接受的来源权威版本；操作目标仍属调用方原 journal，消费者物化进度和模型消费证据不塞进 checkpoint。没有多套 epoch、永久许可账本或新密钥。

stateDirectory 必须显式提供、已存在、规范化、无符号链接，并处于来源仓库之外。模块不发现默认路径、不创建生产目录、不 chmod 既有路径、不读取 Git HEAD。缺失/损坏/错绑定失败，只有显式 initialize 可以作初始选择。初始化不会证明该 SHA 的 Git 对象存在或来源合格，调用方后续仍须履行现有恢复校验。

每次读写要求调用方注入同一规范 checkpoint key 的互斥端口。读文件有 16 KiB 上限及常规文件、单硬链接、inode、变更检查；写入使用唯一 wx 临时文件和 0600 新文件模式，执行 file fsync → rename → directory fsync。rename 前失败保持旧记录；rename 后确认丢失保留新记录，同一输入/原 expected 重试补目录同步，不再签发 token。部分操作/读取屏障仍须未来接入现有 MemoryTransaction，不能凭 checkpoint 存在宣告整体事务完成。

CAS 始终比较原 expected revision+token，不能从当前观测值改 expected。最近同 operationId 的输入摘要不一致拒绝；更早操作的旧 expected 也不能穿过新 token。全历史 operationId 唯一性仍由原 journal 管理，本模块没有复制账本，也不声称防同账号或整机回滚。 部署前提是状态目录及父目录可信、全部协作者共用注入锁；当前不强制既有目录/文件 owner/mode，也不提供 dirfd/openat 级防恶意目录置换，不能声称防任意本机篡改。真实部署需先核实这一前提，权限不足不自行 chmod 或扩权。进程 SIGKILL 证明不等于物理断电试验；崩溃遗留、未发布的临时文件不成为权威状态，未新增自动垃圾清理。

FileChangePlan 明确 binding、from/target、计划摘要和 status=planned；每个受影响路径需要当前版本或明确不存在的观察，缺省不能当作不存在。之前受管的内容/权限/存在性变化都报冲突；非受管已有目标即使同内容也不暗中收养；未声明用户文件不删除。重命名必须显式给出，复杂链/交换、大小写/规范化或文件/父目录碰撞明确拒绝，不猜测同摘要就是改名。返回独立深冻结快照。

计划器没有 IO，输入观察不构成真实权限/所有权证书；后续 writer 必须核对实际字节、mode、受管证明、路径和目标 token。文件落盘、索引刷新、Host 装载和模型消费仍是不同事实。本批未生成 materialized/consumed 成功收据。

## 有界验证与证据

仅运行一次登记的验证实例 a1：全仓 tsc --noEmit、六个新文件及其依赖的定向编译、两个新增测试文件。实际 Node 为 v24.22.1；旧 v24.22.0 路径已不存在，没有下载安装。没有运行 npm test、旧 CAS 测试或已有完整矩阵，没有覆盖原 dist/.test-dist。

| 项目 | 结果 |
| --- | --- |
| 全仓类型检查 | exit 0 |
| 定向编译 | exit 0 |
| 两文件离线测试 | 38/38（含子用例）；fail/cancelled/skipped 均为 0 |
| 崩溃/重放 | file_synced、replaced、directory_synced 故障；replaced 后一个已登记子进程 SIGKILL，等待退出后重开并精确重试 |
| 其他关键反例 | 两实例同 token 竞争、ABA/旧操作、等待锁时输入突变、schema 损坏、错绑定、symlink/hardlink、用户改动、未知观察、占用 rename 目标及路径碰撞 |

原始命令、时间、进程 ID、退出码及源码 SHA256：[verification-a1/result.json](../.artifacts/suqing-batch1-20261022/verification-a1/result.json)。测试日志：[tests.log](../.artifacts/suqing-batch1-20261022/verification-a1/tests.log)。契约与保护文件：[contract-freeze.json](../.artifacts/suqing-batch1-20261022/contract-freeze.json)。定向编译产物身份：[compiled-identity.json](../.artifacts/suqing-batch1-20261022/compiled-identity.json)。这些是离线产物，不是新可部署插件包。

重要验收边界：只读预检发现安装的公开 Host file-lock 在 Darwin 上会调用此前已被禁止重试的 /bin/ps。本批未调用该适配器，未改 Host 或拦截绕过；测试注入 fixture-only 串行互斥。两 store 实例竞争和独占子进程崩溃恢复已验，真实跨进程锁适配器尚未验。没有把这个限制转换成无锁运行默认值。

## 下批集成顺序

1. 优先收敛真实 stateRoot/互斥适配器的可用范围，保持 repo mutation fence → checkpoint lock 顺序；不自行修改 OpenClaw、安全权限或重试 ps。此步须给出可执行的既有机制或具体阻塞，不能无限找替代接口。
2. SQ-06 统一 resolver 接线与显式初始化/迁移，复用现有 pending/journal；确定受控升级兼容方案，先停旧/单活，再改变运行权威位置。此时才替代 D-028，不能一半 reader 仍取 Host 动态字段。
3. 接一个文件消费者的真实 before-bytes 校验和物化进度，保留用户修改冲突；memory/wiki/index/Gateway 命令不自动执行。
4. SQ-08 按已采纳方向记录正式信任边界：原版 Host 负责模型调用/取消/Agent Loop，Core 控制供给。原版来源及目标入口隔离明确后，才验证完整 Google Agent→工具→模型续轮；不改成 direct completion 主交付，不搬用旧覆层通过结果。

原版 Host 来源证明、真实启用清单、运行迁移和最终消费缺口仍开放；full_memory 门禁未动。本批不需要新重大架构决定，也没有替后续生产、真实模型或权限操作取得新授权。

## 保留与提交归属

本批只提交六个新增自有代码/测试文件及本说明。先前未提交 recovery-pointer-barriers.test.ts 属于前期 CAS 诊断，本批保留原 SHA256 8eeeea1cfd69ed5bd8b05701a9c9f09fe39ecf6c4bf609f4ab5d488b025161ce，未运行、未纳入提交；三份前期规划文档也原样保留。

plugin.ts、原 recovery-pointer.ts、host-memory.ts、正式 DECISIONS/契约、OpenClaw 与生产配置保持原样。未读真实凭据/私人记忆、未发真实 API、未下载、未 push；新增工程证据在已验证非 iCloud 的项目路径。测试子进程已退出，唯一验证登记已关闭。
