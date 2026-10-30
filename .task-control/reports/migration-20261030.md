# Core任务规划权威迁移：本地候选

观察时间 2026-10-30T02:36:34Z；执行会话 codex-thread:01a17b41-4b02-7641-974c-25e69fe0603e；协调任务 codex-thread:01a1727f-7b6a-7632-b6f0-cc130ff7d006。仅管理状态迁移，未恢复业务/测试/Host/旧runner，未提交推送。

## 基线与单写者
本地base commit 1c0411a6d883d3cbb2e33dc7dd64a3a5574f0252，分支codex/issue23-integrated-regression；没有fresh fetch/ls-remote。
原state不存在：authorityBaseRevision=null、authorityBaseSha256=null；sourceCandidateRevision=0仅作输入，首次仓库候选revision=1。
迁移前PROJECT-STATE工作树SHA-256 0a6ff94dc4ede6d654dd5c9919c5b15784a57ac5b1b578516edb1353c9471a8b；AGENTS SHA-256 2b52ea4466256c8e16a1ab0af96675f9ca7d1e27a35137c613a9fe8c180f509f。
自身hash在外部交接验证结果记录，不写回state。替换前重读HEAD/管理文件hash，变化则停止；同目录原子rename只防半写，不是多写者CAS。

## 消费者和旧入口
定向查AGENTS/scripts/tests/docs-agents，只有AGENTS引用旧状态，未发现业务程序读取task_continuity/unique_next_step。
PROJECT-STATE保留技术事实和证据；旧task_continuity、scope和non_goals显式历史化，旧下一步/包候选改名为not_executable。恢复指令改从JSON读取，不能只贴链接继续旧D2。
原未提交业务事实与失败身份保留，设计基线/ADR/业务代码不变。

## 现场与交付边界
原15文件候选和4无关untracked保留，除旧状态必要迁移外其余逐文件hash不变。旧cell21/26/EPERM仍unknown；本轮不查ps、不接管/清理旧现场。
本轮没有新Host/测试/业务进程；不声称所有历史进程已退出。26旧失败及152未跑沿用技术索引，不fresh查CI，不作为架构研究前置。
候选仅本地，commit未记录、push未执行、候选CI未运行；旧SHA结果不转用于本候选。

## 四任务
保留CORE workstream及CORE-RES-001/CORE-DEC-001/CORE-VAL-001/CORE-LEGACY-001稳定ID。
研究/职责盘点按单独handoff有限验收completed；架构收敛ready；竖向验证planned且依赖架构决定；旧runner paused。
下一动作由经理明确官方能力/薄Core职责、唯一认知writer和受保护路径，再界定验证。本迁移不执行下一包。
旧runner恢复必须有明确关联新架构的处置决定；迁移、会话恢复、研究或依赖完成均不解暂停。

## 有界防休眠
两次Library传输使用现有caffeinate -i -t 120随命令退出，均exit0；没有pmset/显示器保持/常驻服务。
原受限助手download failed且无本地文件；随后授权提权的同一正规助手取回。没有替代下载器。
