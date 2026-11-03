# 旧版清理 R1：保留现行 CI 覆盖

仅修复本次独审 P2。普通插件打包测试现在同时执行 candidate-work-brief、author-intent-repository、memory-transaction、memory-transaction-journal 四套既有测试，原断言与其余六套保持不变。测试通过暂存目录导入实际 npm 包产物，未恢复旧探针。

一次本地运行：133/133 通过，失败、取消、跳过均为 0，命令实际退出 0；SDK 为 2026.10.9。这不是 CI 锁定 10.8、真实 Host 或语义验收。哈希、各套执行标记和回执见 VALIDATION.json。

README 已将 8.2 固定宿主／8.1 最低版本说法标为历史，并说明当前锁定 SDK 与本地验证版本不同。

R1.patch 是相对原清理候选的三文件修正；combined.patch 是相对 HEAD 41cd0188 的全部十三文件清理差异。原 R0 报告、恢复索引与历史失败证据保留。三套旧版测试及专用审计退役，涉及十项旧失败；另外十六项历史失败仍未修复，不称整体通过。

本包等待独立复审，尚未提交或推送。PROJECT-STATE、来源文档的原有差异以及其他未跟踪材料未动；main、模型、私人资料和 CangHai 无操作。
